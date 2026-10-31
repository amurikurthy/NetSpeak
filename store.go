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
// Principal is "everyone", "group:<id>" or "user:<id>".
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
	Role         string    `json:"role"` // "admin" | "user"
	Groups       []string  `json:"groups"`
	Guest        bool      `json:"guest,omitempty"`
	InviteID     string    `json:"inviteId,omitempty"`
	Disabled     bool      `json:"disabled,omitempty"`
	ExpiresAt    time.Time `json:"expiresAt,omitempty"`
	TokenVersion int       `json:"tokenVersion"`
	CreatedAt    time.Time `json:"createdAt"`
}

type Group struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
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

type Invite struct {
	ID        string    `json:"id"`
	Token     string    `json:"token"`
	Name      string    `json:"name"`
	Groups    []string  `json:"groups"`
	ExpiresAt time.Time `json:"expiresAt,omitempty"`
	MaxUses   int       `json:"maxUses"` // 0 = unlimited
	Uses      int       `json:"uses"`
	CreatedAt time.Time `json:"createdAt"`
}

func (i *Invite) Valid() bool {
	if !i.ExpiresAt.IsZero() && time.Now().After(i.ExpiresAt) {
		return false
	}
	return i.MaxUses == 0 || i.Uses < i.MaxUses
}

type Data struct {
	Version int       `json:"version"`
	Secret  string    `json:"secret"`
	Users   []*User   `json:"users"`
	Groups  []*Group  `json:"groups"`
	Rooms   []*Room   `json:"rooms"`
	Feeds   []*Feed   `json:"feeds"`
	Invites []*Invite `json:"invites"`
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
	if s.d.Secret == "" {
		s.d.Secret = newSecret(32)
	}
	return s, false, nil
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

func (d *Data) GroupByID(id string) *Group {
	for _, g := range d.Groups {
		if g.ID == id {
			return g
		}
	}
	return nil
}

func (d *Data) InviteByToken(t string) *Invite {
	for _, i := range d.Invites {
		if i.Token == t {
			return i
		}
	}
	return nil
}

func (d *Data) SortedRooms() []*Room {
	out := append([]*Room(nil), d.Rooms...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func (d *Data) SortedFeeds() []*Feed {
	out := append([]*Feed(nil), d.Feeds...)
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
	case strings.HasPrefix(g.Principal, "group:"):
		gid := g.Principal[6:]
		for _, x := range u.Groups {
			if x == gid {
				return true
			}
		}
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

// Seed creates a sensible starting configuration on first boot.
func (d *Data) Seed(adminHash string) {
	now := time.Now()
	crew := &Group{ID: newID(), Name: "Crew", Color: "#3b82f6"}
	prod := &Group{ID: newID(), Name: "Production", Color: "#f59e0b"}
	d.Groups = []*Group{prod, crew}
	d.Users = []*User{{
		ID: newID(), Username: "admin", DisplayName: "Admin", PasswordHash: adminHash,
		Role: "admin", Groups: []string{prod.ID}, CreatedAt: now,
	}}
	d.Rooms = []*Room{
		{ID: newID(), Name: "Production", Color: "#ef4444", Order: 1, Access: []Grant{
			{Principal: "group:" + prod.ID, Listen: true, Talk: true},
			{Principal: "group:" + crew.ID, Listen: true, Talk: true},
		}},
		{ID: newID(), Name: "Camera", Color: "#22c55e", Order: 2, Access: []Grant{
			{Principal: "group:" + prod.ID, Listen: true, Talk: true},
			{Principal: "group:" + crew.ID, Listen: true, Talk: true},
		}},
		{ID: newID(), Name: "Director", Color: "#a855f7", Order: 3, Access: []Grant{
			{Principal: "group:" + prod.ID, Listen: true, Talk: true},
			{Principal: "group:" + crew.ID, Listen: true},
		}},
	}
	d.Feeds = []*Feed{{
		ID: newID(), Name: "Program", Description: "Main program audio", Order: 1, IngestKey: newSecret(16),
		Access: []Grant{{Principal: "everyone", Listen: true}},
	}}
}
