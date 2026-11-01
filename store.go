package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Grant gives a principal access to a room or feed.
// Principal is "everyone" or "user:<id>".
type Grant struct {
	Principal string `json:"principal"`
	Listen    bool   `json:"listen"`
	Talk      bool   `json:"talk,omitempty"`   // rooms only
	Source    bool   `json:"source,omitempty"` // feeds only: may publish into the feed from a browser
}

type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	DisplayName  string    `json:"displayName"`
	PasswordHash string    `json:"passwordHash,omitempty"`
	Role         string    `json:"role"`            // "admin" | "user"
	Guest        bool      `json:"guest,omitempty"` // legacy: guest accounts from the removed invite feature are dropped on load
	Disabled     bool      `json:"disabled,omitempty"`
	TokenVersion int       `json:"tokenVersion"`
	CreatedAt    time.Time `json:"createdAt"`
}

type Room struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Color   string  `json:"color"`
	Order   int     `json:"order"`
	PTTOnly bool    `json:"pttOnly"` // disallow latching talk
	Access  []Grant `json:"access"`
}

type Feed struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Order       int     `json:"order"`
	IngestKey   string  `json:"ingestKey"`
	Access      []Grant `json:"access"`
}

type Data struct {
	Version int     `json:"version"`
	Secret  string  `json:"secret"`
	Users   []*User `json:"users"`
	Rooms   []*Room `json:"rooms"`
	Feeds   []*Feed `json:"feeds"`
}

// Store is an in-memory model persisted atomically to a single JSON file.
type Store struct {
	mu       sync.RWMutex
	path     string
	d        Data
	onChange func()
}

var errNotFound = errors.New("not found")

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func newSecret(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func OpenStore(dir string) (*Store, bool, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, false, err
	}
	s := &Store{path: filepath.Join(dir, "netspeak.json")}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		s.d = Data{Version: 1, Secret: newSecret(32)}
		return s, true, nil
	}
	if err != nil {
		return nil, false, err
	}
	if err := json.Unmarshal(b, &s.d); err != nil {
		return nil, false, err
	}
	kept := s.d.Users[:0]
	for _, u := range s.d.Users {
		if !u.Guest {
			kept = append(kept, u)
		}
	}
	s.d.Users = kept
	if s.d.Secret == "" {
		s.d.Secret = newSecret(32)
	}
	s.d.normalize()
	// Older versions had groups: fold group access into per-user access.
	var legacy struct {
		Users []struct {
			ID     string   `json:"id"`
			Groups []string `json:"groups"`
		} `json:"users"`
	}
	if json.Unmarshal(b, &legacy) == nil {
		members := map[string][]string{}
		for _, u := range legacy.Users {
			for _, g := range u.Groups {
				members[g] = append(members[g], u.ID)
			}
		}
		if s.d.migrateGroups(members) || strings.Contains(string(b), `"groups"`) {
			s.d.normalize()
			_ = s.save()
		}
	}
	return s, false, nil
}

// normalize makes sure no list is nil, so an empty list is always `[]` in JSON, never `null`.
func (d *Data) normalize() {
	if d.Users == nil {
		d.Users = []*User{}
	}
	if d.Rooms == nil {
		d.Rooms = []*Room{}
	}
	if d.Feeds == nil {
		d.Feeds = []*Feed{}
	}
	for _, r := range d.Rooms {
		if r.Access == nil {
			r.Access = []Grant{}
		}
	}
	for _, f := range d.Feeds {
		if f.Access == nil {
			f.Access = []Grant{}
		}
	}
}

// save must be called with mu held (write).
func (s *Store) save() error {
	b, err := json.MarshalIndent(&s.d, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	f.Close()
	return os.Rename(tmp, s.path)
}

// Update applies fn under the write lock, persists, and notifies listeners.
func (s *Store) Update(fn func(d *Data) error) error {
	s.mu.Lock()
	if err := fn(&s.d); err != nil {
		s.mu.Unlock()
		return err
	}
	s.d.normalize()
	err := s.save()
	cb := s.onChange
	s.mu.Unlock()
	if err == nil && cb != nil {
		go cb()
	}
	return err
}

// View runs fn under the read lock.
func (s *Store) View(fn func(d *Data)) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	fn(&s.d)
}

func (s *Store) Secret() []byte {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return []byte(s.d.Secret)
}

// --- lookups (call with lock held) ---

func (d *Data) UserByID(id string) *User {
	for _, u := range d.Users {
		if u.ID == id {
			return u
		}
	}
	return nil
}

func (d *Data) UserByName(name string) *User {
	for _, u := range d.Users {
		if !u.Guest && strings.EqualFold(u.Username, name) {
			return u
		}
	}
	return nil
}

func (d *Data) RoomByID(id string) *Room {
	for _, r := range d.Rooms {
		if r.ID == id {
			return r
		}
	}
	return nil
}

func (d *Data) FeedByID(id string) *Feed {
	for _, f := range d.Feeds {
		if f.ID == id {
			return f
		}
	}
	return nil
}

func (d *Data) SortedRooms() []*Room {
	out := append([]*Room{}, d.Rooms...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func (d *Data) SortedFeeds() []*Feed {
	out := append([]*Feed{}, d.Feeds...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// --- permissions ---

type Perm struct {
	Listen bool `json:"listen"`
	Talk   bool `json:"talk"`
	Source bool `json:"source"`
}

func grantMatches(g Grant, u *User) bool {
	switch {
	case g.Principal == "everyone":
		return true
	case strings.HasPrefix(g.Principal, "user:"):
		return g.Principal[5:] == u.ID
	}
	return false
}

func effective(grants []Grant, u *User) Perm {
	if u.Role == "admin" {
		return Perm{Listen: true, Talk: true, Source: true}
	}
	var p Perm
	for _, g := range grants {
		if grantMatches(g, u) {
			p.Listen = p.Listen || g.Listen
			p.Talk = p.Talk || g.Talk
			p.Source = p.Source || g.Source
		}
	}
	return p
}

func (r *Room) PermFor(u *User) Perm { return effective(r.Access, u) }
func (f *Feed) PermFor(u *User) Perm { return effective(f.Access, u) }

// Seed creates a sensible starting configuration on first boot. The starter rooms are open to
// every user; restrict them per user under Admin.
func (d *Data) Seed(adminHash string) {
	all := []Grant{{Principal: "everyone", Listen: true, Talk: true}}
	d.Users = []*User{{
		ID: newID(), Username: "admin", DisplayName: "Admin", PasswordHash: adminHash,
		Role: "admin", CreatedAt: time.Now(),
	}}
	d.Rooms = []*Room{
		{ID: newID(), Name: "Production", Color: "#ef4444", Order: 1, Access: append([]Grant{}, all...)},
		{ID: newID(), Name: "Camera", Color: "#22c55e", Order: 2, Access: append([]Grant{}, all...)},
		{ID: newID(), Name: "Director", Color: "#a855f7", Order: 3, Access: append([]Grant{}, all...)},
	}
	d.Feeds = []*Feed{{
		ID: newID(), Name: "Program", Order: 1, IngestKey: newSecret(16),
		Access: []Grant{{Principal: "everyone", Listen: true}},
	}}
}

// migrateGroups converts access granted to groups (older versions) into per-user access.
// members maps group id -> user ids. Reports whether anything changed.
func (d *Data) migrateGroups(members map[string][]string) bool {
	changed := false
	fix := func(in []Grant) []Grant {
		idx := map[string]int{}
		out := []Grant{}
		add := func(g Grant) {
			if i, ok := idx[g.Principal]; ok {
				out[i].Listen = out[i].Listen || g.Listen
				out[i].Talk = out[i].Talk || g.Talk
				out[i].Source = out[i].Source || g.Source
				return
			}
			idx[g.Principal] = len(out)
			out = append(out, g)
		}
		for _, g := range in {
			if strings.HasPrefix(g.Principal, "group:") {
				changed = true
				for _, uid := range members[g.Principal[6:]] {
					n := g
					n.Principal = "user:" + uid
					add(n)
				}
				continue
			}
			add(g)
		}
		return out
	}
	for _, r := range d.Rooms {
		r.Access = fix(r.Access)
	}
	for _, f := range d.Feeds {
		f.Access = fix(f.Access)
	}
	return changed
}
