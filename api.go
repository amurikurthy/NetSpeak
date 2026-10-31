package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type API struct {
	st   *Store
	auth *Auth
	hub  *Hub
}

func (a *API) routes(mux *http.ServeMux) {
	adm := a.auth.requireAdmin
	mux.HandleFunc("GET /api/admin/state", adm(a.state))
	mux.HandleFunc("POST /api/admin/users", adm(a.saveUser))
	mux.HandleFunc("PUT /api/admin/users/{id}", adm(a.saveUser))
	mux.HandleFunc("DELETE /api/admin/users/{id}", adm(a.delUser))
	mux.HandleFunc("POST /api/admin/users/{id}/kick", adm(func(w http.ResponseWriter, r *http.Request, _ *User) {
		a.hub.kickUser(r.PathValue("id"))
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/admin/rooms", adm(a.saveRoom))
	mux.HandleFunc("PUT /api/admin/rooms/{id}", adm(a.saveRoom))
	mux.HandleFunc("DELETE /api/admin/rooms/{id}", adm(a.delRoom))
	mux.HandleFunc("POST /api/admin/feeds", adm(a.saveFeed))
	mux.HandleFunc("PUT /api/admin/feeds/{id}", adm(a.saveFeed))
	mux.HandleFunc("DELETE /api/admin/feeds/{id}", adm(a.delFeed))
	mux.HandleFunc("POST /api/admin/feeds/{id}/rotate", adm(a.rotateFeed))
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(v); err != nil {
		writeErr(w, 400, "bad request")
		return false
	}
	return true
}

func clean(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) > max {
		s = s[:max]
	}
	return s
}

func validColor(c string) string {
	if len(c) == 7 && c[0] == '#' {
		return c
	}
	return "#3b82f6"
}

func (a *API) state(w http.ResponseWriter, r *http.Request, _ *User) {
	online := a.hub.onlineUsers()
	a.st.View(func(d *Data) {
		users := make([]map[string]any, 0, len(d.Users))
		for _, u := range d.Users {
			m := publicUser(u)
			m["disabled"], m["online"] = u.Disabled, online[u.ID]
			users = append(users, m)
		}
		writeJSON(w, 200, map[string]any{
			"users": users, "rooms": d.SortedRooms(), "feeds": d.SortedFeeds(),
		})
	})
}

func (a *API) saveUser(w http.ResponseWriter, r *http.Request, me *User) {
	var in struct {
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
		Password    string `json:"password"`
		Role        string `json:"role"`
		// Optional: this user's access per room / feed, keyed by id.
		Rooms map[string]struct {
			Listen bool `json:"listen"`
			Talk   bool `json:"talk"`
		} `json:"rooms"`
		Feeds map[string]struct {
			Listen bool `json:"listen"`
			Source bool `json:"source"`
		} `json:"feeds"`
		HasAccess bool `json:"hasAccess"`
		Disabled  bool `json:"disabled"`
	}
	if !decode(w, r, &in) {
		return
	}
	id := r.PathValue("id")
	if in.Role != "admin" {
		in.Role = "user"
	}
	var hash string
	if in.Password != "" {
		var err error
		if hash, err = hashPassword(in.Password); err != nil {
			writeErr(w, 500, "hash failed")
			return
		}
	}
	err := a.st.Update(func(d *Data) error {
		var u *User
		if id == "" {
			name := clean(in.Username, 40)
			if name == "" || in.Password == "" {
				return errMsg("username and password are required")
			}
			if d.UserByName(name) != nil {
				return errMsg("that username is taken")
			}
			u = &User{ID: newID(), Username: name, CreatedAt: time.Now()}
			d.Users = append(d.Users, u)
		} else if u = d.UserByID(id); u == nil {
			return errNotFound
		}
		if id != "" && u.ID == me.ID && (in.Role != "admin" || in.Disabled) {
			return errMsg("you cannot demote or disable yourself")
		}
		u.DisplayName = clean(in.DisplayName, 40)
		if u.DisplayName == "" {
			u.DisplayName = u.Username
		}
		u.Role, u.Disabled = in.Role, in.Disabled
		if in.HasAccess {
			who := "user:" + u.ID
			set := func(gr []Grant, g Grant) []Grant {
				out := []Grant{}
				for _, x := range gr {
					if x.Principal != who {
						out = append(out, x)
					}
				}
				if g.Listen || g.Talk || g.Source {
					out = append(out, g)
				}
				return out
			}
			for _, r := range d.Rooms {
				a := in.Rooms[r.ID]
				r.Access = set(r.Access, Grant{Principal: who, Listen: a.Listen || a.Talk, Talk: a.Talk})
			}
			for _, f := range d.Feeds {
				a := in.Feeds[f.ID]
				f.Access = set(f.Access, Grant{Principal: who, Listen: a.Listen || a.Source, Source: a.Source})
			}
		}
		if hash != "" {
			u.PasswordHash = hash
			u.TokenVersion++
		}
		return nil
	})
	a.reply(w, err)
}

type errMsg string

func (e errMsg) Error() string { return string(e) }

func (a *API) reply(w http.ResponseWriter, err error) {
	switch e := err.(type) {
	case nil:
		writeJSON(w, 200, map[string]bool{"ok": true})
	case errMsg:
		writeErr(w, 400, string(e))
	default:
		if err == errNotFound {
			writeErr(w, 404, "not found")
		} else {
			writeErr(w, 500, "could not save")
		}
	}
}

func (a *API) delUser(w http.ResponseWriter, r *http.Request, me *User) {
	id := r.PathValue("id")
	if id == me.ID {
		writeErr(w, 400, "you cannot delete yourself")
		return
	}
	err := a.st.Update(func(d *Data) error {
		for i, u := range d.Users {
			if u.ID == id {
				d.Users = append(d.Users[:i], d.Users[i+1:]...)
				strip := func(gr []Grant) []Grant {
					out := []Grant{}
					for _, g := range gr {
						if g.Principal != "user:"+id {
							out = append(out, g)
						}
					}
					return out
				}
				for _, x := range d.Rooms {
					x.Access = strip(x.Access)
				}
				for _, x := range d.Feeds {
					x.Access = strip(x.Access)
				}
				return nil
			}
		}
		return errNotFound
	})
	a.reply(w, err)
}

func cleanGrants(d *Data, in []Grant, feed bool) []Grant {
	out := []Grant{}
	for _, g := range in {
		ok := g.Principal == "everyone" ||
			(strings.HasPrefix(g.Principal, "user:") && d.UserByID(g.Principal[5:]) != nil)
		if !ok {
			continue
		}
		if feed {
			g.Talk = false
		} else {
			g.Source = false
			if g.Talk {
				g.Listen = true // talking implies listening
			}
		}
		if g.Listen || g.Talk || g.Source {
			out = append(out, g)
		}
	}
	return out
}

func (a *API) saveRoom(w http.ResponseWriter, r *http.Request, _ *User) {
	var in Room
	if !decode(w, r, &in) {
		return
	}
	id := r.PathValue("id")
	err := a.st.Update(func(d *Data) error {
		name := clean(in.Name, 40)
		if name == "" {
			return errMsg("name required")
		}
		var x *Room
		if id == "" {
			x = &Room{ID: newID()}
			d.Rooms = append(d.Rooms, x)
		} else if x = d.RoomByID(id); x == nil {
			return errNotFound
		}
		x.Name, x.Color, x.Order, x.PTTOnly = name, validColor(in.Color), in.Order, in.PTTOnly
		x.Access = cleanGrants(d, in.Access, false)
		return nil
	})
	a.reply(w, err)
}

func (a *API) delRoom(w http.ResponseWriter, r *http.Request, _ *User) {
	id := r.PathValue("id")
	a.reply(w, a.st.Update(func(d *Data) error {
		for i, x := range d.Rooms {
			if x.ID == id {
				d.Rooms = append(d.Rooms[:i], d.Rooms[i+1:]...)
				return nil
			}
		}
		return errNotFound
	}))
}

func (a *API) saveFeed(w http.ResponseWriter, r *http.Request, _ *User) {
	var in Feed
	if !decode(w, r, &in) {
		return
	}
	id := r.PathValue("id")
	err := a.st.Update(func(d *Data) error {
		name := clean(in.Name, 40)
		if name == "" {
			return errMsg("name required")
		}
		var x *Feed
		if id == "" {
			x = &Feed{ID: newID(), IngestKey: newSecret(16)}
			d.Feeds = append(d.Feeds, x)
		} else if x = d.FeedByID(id); x == nil {
			return errNotFound
		}
		x.Name, x.Description, x.Order = name, clean(in.Description, 120), in.Order
		x.Access = cleanGrants(d, in.Access, true)
		return nil
	})
	a.reply(w, err)
}

func (a *API) delFeed(w http.ResponseWriter, r *http.Request, _ *User) {
	id := r.PathValue("id")
	a.reply(w, a.st.Update(func(d *Data) error {
		for i, x := range d.Feeds {
			if x.ID == id {
				d.Feeds = append(d.Feeds[:i], d.Feeds[i+1:]...)
				return nil
			}
		}
		return errNotFound
	}))
}

func (a *API) rotateFeed(w http.ResponseWriter, r *http.Request, _ *User) {
	id := r.PathValue("id")
	a.reply(w, a.st.Update(func(d *Data) error {
		x := d.FeedByID(id)
		if x == nil {
			return errNotFound
		}
		x.IngestKey = newSecret(16)
		return nil
	}))
}
