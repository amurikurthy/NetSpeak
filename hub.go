package main

import (
	"encoding/binary"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Wire format (binary, all big-endian):
//
//	client -> server: [0x01][chan u16][seq u32][opus packet]
//	server -> client: [0x01][chan u16][sender u16][seq u32][opus packet]
//
// Control traffic is JSON text frames.
const (
	frameAudio     = 1 // room voice: [1][chan u16][sender u16][seq u32][opus]
	frameFeedAudio = 2 // program feed: [2][chan u16][sender u16][seq u32][server stamp us u64][opus]
)

type chanRef struct {
	feed bool
	id   string
}

type feedState struct {
	source string
	last   time.Time
	seq    uint32
	clock  feedClock
}

type outMsg struct {
	typ  int
	data []byte
}

type Client struct {
	h      *Hub
	conn   *websocket.Conn
	id     uint16
	userID string
	send   chan outMsg
	done   chan struct{}
	once   sync.Once

	mu       sync.RWMutex
	user     User
	perms    map[string]Perm // "r:<id>" / "f:<id>"
	joined   map[string]bool // room ids
	talking  map[string]bool // room ids
	speaking map[string]bool // rooms where the mic currently hears speech (client voice detection)
	listen   map[string]bool // feed ids
	publish  string          // feed id being published from this browser
}

type Hub struct {
	st   *Store
	auth *Auth

	mu      sync.RWMutex
	clients map[*Client]struct{}
	nextID  uint16
	handles map[string]uint16
	refs    map[uint16]chanRef
	nextH   uint16
	feeds   map[string]*feedState

	feedDelayMs int // every listener plays program audio this long after its server stamp
	dirty       atomic.Bool
}

func NewHub(st *Store, auth *Auth) *Hub {
	h := &Hub{
		st: st, auth: auth, clients: map[*Client]struct{}{},
		handles: map[string]uint16{}, refs: map[uint16]chanRef{}, feeds: map[string]*feedState{},
	}
	st.onChange = h.refreshAll
	go h.presenceLoop()
	return h
}

func (h *Hub) handle(feed bool, id string) uint16 {
	key := "r:" + id
	if feed {
		key = "f:" + id
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if v, ok := h.handles[key]; ok {
		return v
	}
	h.nextH++
	h.handles[key] = h.nextH
	h.refs[h.nextH] = chanRef{feed, id}
	return h.nextH
}

func (c *Client) enqueue(m outMsg) {
	select {
	case c.send <- m:
	default:
		// Slow consumer: drop audio rather than stall everybody else.
		if m.typ == websocket.TextMessage {
			c.close()
		}
	}
}

func (c *Client) close() {
	c.once.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

func (c *Client) json(v any) {
	b, _ := json.Marshal(v)
	c.enqueue(outMsg{websocket.TextMessage, b})
}

var upgrader = websocket.Upgrader{
	ReadBufferSize: 4096, WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		o := r.Header.Get("Origin")
		if o == "" {
			return true
		}
		u, err := url.Parse(o)
		return err == nil && strings.EqualFold(u.Host, r.Host)
	},
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	u := h.auth.UserFrom(r)
	if u == nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(64 * 1024)
	c := &Client{
		h: h, conn: conn, userID: u.ID, user: *u, send: make(chan outMsg, 512), done: make(chan struct{}),
		perms: map[string]Perm{}, joined: map[string]bool{}, talking: map[string]bool{}, speaking: map[string]bool{}, listen: map[string]bool{},
	}
	h.mu.Lock()
	for {
		h.nextID++
		if h.nextID == 0 {
			continue
		}
		used := false
		for o := range h.clients {
			if o.id == h.nextID {
				used = true
				break
			}
		}
		if !used {
			c.id = h.nextID
			break
		}
	}
	h.clients[c] = struct{}{}
	h.mu.Unlock()

	go c.writeLoop()
	c.refresh()
	h.dirty.Store(true)
	c.readLoop()

	c.close()
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
	c.mu.RLock()
	pub := c.publish
	c.mu.RUnlock()
	if pub != "" {
		h.releaseFeed(pub, "ws:"+itoa(c.id))
	}
	h.dirty.Store(true)
}

func itoa(n uint16) string {
	b := [5]byte{}
	i := len(b)
	for {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
		if n == 0 {
			break
		}
	}
	return string(b[i:])
}

func (c *Client) writeLoop() {
	tick := time.NewTicker(20 * time.Second)
	defer tick.Stop()
	for {
		select {
		case m := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if c.conn.WriteMessage(m.typ, m.data) != nil {
				c.close()
				return
			}
		case <-tick.C:
			_ = c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
		case <-c.done:
			return
		}
	}
}

func (c *Client) readLoop() {
	const idle = 70 * time.Second
	_ = c.conn.SetReadDeadline(time.Now().Add(idle))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(idle))
	})
	for {
		typ, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(idle))
		if typ == websocket.BinaryMessage {
			c.h.route(c, data)
			continue
		}
		var m struct {
			T    string  `json:"t"`
			Room string  `json:"room"`
			Feed string  `json:"feed"`
			On   bool    `json:"on"`
			C    float64 `json:"c"`
		}
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		if m.T == "sync" { // clock sync: echo the client's timestamp with the server's own
			c.json(map[string]any{"t": "sync", "c": m.C, "s": float64(time.Now().UnixMicro()) / 1000})
			continue
		}
		c.control(m.T, m.Room, m.Feed, m.On)
	}
}

func (c *Client) control(t, room, feed string, on bool) {
	switch t {
	case "ping":
		c.json(map[string]string{"t": "pong"})
		return
	case "join":
		c.mu.Lock()
		if c.perms["r:"+room].Listen {
			c.joined[room] = true
		}
		c.mu.Unlock()
	case "leave":
		c.mu.Lock()
		delete(c.joined, room)
		delete(c.talking, room)
		delete(c.speaking, room)
		c.mu.Unlock()
	case "talk":
		c.mu.Lock()
		if on && c.joined[room] && c.perms["r:"+room].Talk {
			c.talking[room] = true
		} else {
			delete(c.talking, room)
			delete(c.speaking, room)
		}
		c.mu.Unlock()
	case "speak": // voice detection result from the client: only meaningful while talking
		c.mu.Lock()
		if on && c.talking[room] {
			c.speaking[room] = true
		} else {
			delete(c.speaking, room)
		}
		c.mu.Unlock()
	case "listen":
		c.mu.Lock()
		if on && c.perms["f:"+feed].Listen {
			c.listen[feed] = true
		} else {
			delete(c.listen, feed)
		}
		c.mu.Unlock()
	case "publish":
		c.mu.Lock()
		cur := c.publish
		c.mu.Unlock()
		src := "ws:" + itoa(c.id)
		if on {
			if cur == feed {
				return
			}
			if !c.perms["f:"+feed].Source {
				c.json(map[string]string{"t": "error", "msg": "You may not publish to this feed"})
				return
			}
			if !c.h.claimFeed(feed, src) {
				c.json(map[string]string{"t": "error", "msg": "Feed already has a live source"})
				c.json(map[string]any{"t": "publish", "feed": feed, "on": false})
				return
			}
			c.mu.Lock()
			c.publish = feed
			c.mu.Unlock()
		} else if cur == feed {
			c.mu.Lock()
			c.publish = ""
			c.mu.Unlock()
			c.h.releaseFeed(feed, src)
		}
	default:
		return
	}
	c.h.dirty.Store(true)
}

// ---- feed source tracking ----

func (h *Hub) claimFeed(id, src string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	fs := h.feeds[id]
	if fs == nil {
		fs = &feedState{}
		h.feeds[id] = fs
	}
	if fs.source != "" && fs.source != src && time.Since(fs.last) < 4*time.Second {
		return false
	}
	fs.source, fs.last = src, time.Now()
	h.dirty.Store(true)
	return true
}

func (h *Hub) releaseFeed(id, src string) {
	h.mu.Lock()
	if fs := h.feeds[id]; fs != nil && fs.source == src {
		fs.source = ""
	}
	h.mu.Unlock()
	h.dirty.Store(true)
}

func (h *Hub) feedLive(id string) bool {
	fs := h.feeds[id]
	return fs != nil && fs.source != "" && time.Since(fs.last) < 4*time.Second
}

// feedPacket injects one Opus packet from the HTTP ingest path.
func (h *Hub) feedPacket(feedID string, pkt []byte) {
	h.mu.Lock()
	fs := h.feeds[feedID]
	if fs == nil {
		h.mu.Unlock()
		return
	}
	fs.seq++
	seq := fs.seq
	now := time.Now()
	fs.last = now
	stamp := fs.clock.stamp(now.UnixMicro(), opusDuration(pkt).Microseconds())
	h.mu.Unlock()
	h.fanoutFeed(feedID, 0, seq, stamp, pkt, nil)
}

func (h *Hub) fanoutFeed(feedID string, sender uint16, seq uint32, stampUs int64, pkt []byte, except *Client) {
	ch := h.handle(true, feedID)
	out := make([]byte, 17+len(pkt))
	out[0] = frameFeedAudio
	binary.BigEndian.PutUint16(out[1:], ch)
	binary.BigEndian.PutUint16(out[3:], sender)
	binary.BigEndian.PutUint32(out[5:], seq)
	binary.BigEndian.PutUint64(out[9:], uint64(stampUs))
	copy(out[17:], pkt)
	m := outMsg{websocket.BinaryMessage, out}
	h.mu.RLock()
	for c := range h.clients {
		if c == except {
			continue
		}
		c.mu.RLock()
		ok := c.listen[feedID] && c.perms["f:"+feedID].Listen
		c.mu.RUnlock()
		if ok {
			c.enqueue(m)
		}
	}
	h.mu.RUnlock()
}

// route handles one binary audio frame from a client.
func (h *Hub) route(c *Client, data []byte) {
	if len(data) < 8 || data[0] != frameAudio {
		return
	}
	ch := binary.BigEndian.Uint16(data[1:3])
	h.mu.RLock()
	ref, ok := h.refs[ch]
	h.mu.RUnlock()
	if !ok {
		return
	}
	if ref.feed {
		c.mu.RLock()
		ok := c.publish == ref.id
		c.mu.RUnlock()
		if !ok {
			return
		}
		var stamp int64
		h.mu.Lock()
		if fs := h.feeds[ref.id]; fs != nil && fs.source == "ws:"+itoa(c.id) {
			now := time.Now()
			fs.last = now
			stamp = fs.clock.stamp(now.UnixMicro(), opusDuration(data[7:]).Microseconds())
		}
		h.mu.Unlock()
		if stamp == 0 {
			return
		}
		h.fanoutFeed(ref.id, c.id, binary.BigEndian.Uint32(data[3:7]), stamp, data[7:], c)
		return
	}
	c.mu.RLock()
	ok = c.joined[ref.id] && c.perms["r:"+ref.id].Talk
	c.mu.RUnlock()
	if !ok {
		return
	}
	out := make([]byte, 0, len(data)+2)
	out = append(out, frameAudio, data[1], data[2], byte(c.id>>8), byte(c.id))
	out = append(out, data[3:]...)
	m := outMsg{websocket.BinaryMessage, out}
	h.mu.RLock()
	for o := range h.clients {
		// Never send someone their own voice, even to another device signed in as them (feedback loop).
		if o == c || o.userID == c.userID {
			continue
		}
		o.mu.RLock()
		ok := o.joined[ref.id] && o.perms["r:"+ref.id].Listen
		o.mu.RUnlock()
		if ok {
			o.enqueue(m)
		}
	}
	h.mu.RUnlock()
}

// ---- state + presence ----

func (h *Hub) refreshAll() {
	h.mu.RLock()
	cs := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		cs = append(cs, c)
	}
	h.mu.RUnlock()
	for _, c := range cs {
		c.refresh()
	}
	h.dirty.Store(true)
}

// refresh recomputes permissions from the store, prunes anything no longer
// allowed, and sends the client its visible rooms/feeds.
func (c *Client) refresh() {
	var u *User
	rooms := []map[string]any{}
	feeds := []map[string]any{}
	perms := map[string]Perm{}
	c.h.st.View(func(d *Data) {
		if x := d.UserByID(c.userID); x != nil && !x.Disabled {
			cp := *x
			u = &cp
		}
		if u == nil {
			return
		}
		for _, r := range d.SortedRooms() {
			p := r.PermFor(u)
			if !p.Listen {
				continue
			}
			perms["r:"+r.ID] = p
			rooms = append(rooms, map[string]any{
				"id": r.ID, "name": r.Name, "color": r.Color, "talk": p.Talk, "pttOnly": r.PTTOnly,
			})
		}
		for _, f := range d.SortedFeeds() {
			p := f.PermFor(u)
			if !p.Listen && !p.Source {
				continue
			}
			perms["f:"+f.ID] = p
			feeds = append(feeds, map[string]any{
				"id": f.ID, "name": f.Name, "description": f.Description, "source": p.Source, "listen": p.Listen,
			})
		}
	})
	if u == nil {
		c.json(map[string]string{"t": "kicked"})
		c.close()
		return
	}
	for _, r := range rooms {
		r["ch"] = c.h.handle(false, r["id"].(string))
	}
	for _, f := range feeds {
		f["ch"] = c.h.handle(true, f["id"].(string))
	}
	var dropPub string
	c.mu.Lock()
	c.user, c.perms = *u, perms
	for id := range c.joined {
		if !perms["r:"+id].Listen {
			delete(c.joined, id)
			delete(c.talking, id)
			delete(c.speaking, id)
		} else if !perms["r:"+id].Talk {
			delete(c.talking, id)
			delete(c.speaking, id)
		}
	}
	for id := range c.listen {
		if !perms["f:"+id].Listen {
			delete(c.listen, id)
		}
	}
	if c.publish != "" && !perms["f:"+c.publish].Source {
		dropPub, c.publish = c.publish, ""
	}
	c.mu.Unlock()
	if dropPub != "" {
		c.h.releaseFeed(dropPub, "ws:"+itoa(c.id))
		c.json(map[string]any{"t": "publish", "feed": dropPub, "on": false})
	}
	c.json(map[string]any{
		"t": "state", "feedDelayMs": c.h.feedDelayMs, "you": map[string]any{"c": c.id, "id": u.ID, "name": u.DisplayName, "role": u.Role},
		"rooms": rooms, "feeds": feeds,
	})
}

func (h *Hub) presenceLoop() {
	t := time.NewTicker(150 * time.Millisecond)
	last := time.Now()
	for range t.C {
		// Feeds going stale (no frames) change presence too.
		if time.Since(last) > time.Second {
			last = time.Now()
			h.dirty.Store(true)
		}
		if h.dirty.Swap(false) {
			h.broadcastPresence()
		}
	}
}

type presenceMember struct {
	C uint16 `json:"c"`
	N string `json:"n"`
	T bool   `json:"t,omitempty"`
}

// sortMembers gives a room's member list one fixed order: speakers first, then by name, then connection. Without it the order
// follows Go's deliberately random map iteration, and the names reshuffle on every update.
func sortMembers(ms []presenceMember) {
	sort.Slice(ms, func(i, j int) bool {
		if ms[i].T != ms[j].T { // whoever is speaking comes first
			return ms[i].T
		}
		a, b := strings.ToLower(ms[i].N), strings.ToLower(ms[j].N)
		if a != b {
			return a < b
		}
		return ms[i].C < ms[j].C
	})
}

func (h *Hub) broadcastPresence() {
	type member = presenceMember
	h.mu.RLock()
	defer h.mu.RUnlock()
	rooms := map[string][]member{}
	listeners := map[string]int{}
	live := map[string]bool{}
	for id := range h.feeds {
		live[id] = h.feedLive(id)
	}
	for c := range h.clients {
		c.mu.RLock()
		for r := range c.joined {
			rooms[r] = append(rooms[r], member{c.id, c.user.DisplayName, c.talking[r] && c.speaking[r]})
		}
		for f := range c.listen {
			listeners[f]++
		}
		c.mu.RUnlock()
	}
	for _, ms := range rooms {
		sortMembers(ms)
	}
	for c := range h.clients {
		c.mu.RLock()
		pr := map[string][]member{}
		pf := map[string]map[string]any{}
		for k, p := range c.perms {
			id := k[2:]
			if k[0] == 'r' && p.Listen {
				pr[id] = rooms[id]
				if pr[id] == nil {
					pr[id] = []member{}
				}
			} else if k[0] == 'f' {
				pf[id] = map[string]any{"live": live[id], "n": listeners[id]}
			}
		}
		c.mu.RUnlock()
		c.json(map[string]any{"t": "presence", "rooms": pr, "feeds": pf})
	}
}

func (h *Hub) kickUser(userID string) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if c.userID == userID {
			c.close()
		}
	}
}

func (h *Hub) onlineCount() (users int) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	seen := map[string]bool{}
	for c := range h.clients {
		seen[c.userID] = true
	}
	return len(seen)
}

func (h *Hub) onlineUsers() map[string]int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	m := map[string]int{}
	for c := range h.clients {
		m[c.userID]++
	}
	return m
}

var _ = log.Printf
