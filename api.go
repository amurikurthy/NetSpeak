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
	mux.HandleFunc("POST /api/admin/groups", adm(a.saveGroup))
	mux.HandleFunc("PUT /api/admin/groups/{id}", adm(a.saveGroup))
	mux.HandleFunc("DELETE /api/admin/groups/{id}", adm(a.delGroup))
	mux.HandleFunc("POST /api/admin/rooms", adm(a.saveRoom))
	mux.HandleFunc("PUT /api/admin/rooms/{id}", adm(a.saveRoom))
	mux.HandleFunc("DELETE /api/admin/rooms/{id}", adm(a.delRoom))
	mux.HandleFunc("POST /api/admin/feeds", adm(a.saveFeed))
	mux.HandleFunc("PUT /api/admin/feeds/{id}", adm(a.saveFeed))
	mux.HandleFunc("DELETE /api/admin/feeds/{id}", adm(a.delFeed))
	mux.HandleFunc("POST /api/admin/feeds/{id}/rotate", adm(a.rotateFeed))
	mux.HandleFunc("POST /api/admin/invites", adm(a.saveInvite))
	mux.HandleFunc("DELETE /api/admin/invites/{id}", adm(a.delInvite))
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
			m["groups"], m["disabled"], m["online"] = u.Groups, u.Disabled, online[u.ID]
			m["expiresAt"] = u.ExpiresAt
			users = append(users, m)
		}
		writeJSON(w, 200, map[string]any{
			"users": users, "groups": d.Groups, "rooms": d.SortedRooms(), "feeds": d.SortedFeeds(), "invites": d.Invites,
		})
	})
}

func (a *API) saveUser(w http.ResponseWriter, r *http.Request, me *User) {
	var in struct {
		Username    string   `json:"username"`
		DisplayName string   `json:"displayName"`
		Password    string   `json:"password"`
		Role        string   `json:"role"`
		Groups      []string `json:"groups"`
		Disabled    bool     `json:"disabled"`
	}
	if !decode(w, r, &in) {
		return
	}
	id := r.PathValue("id")
	if in.Role != "admin" {
		in.Role = "user"
	}
	if in.Password != "" && len(in.Password) < 8 {
		writeErr(w, 400, "password must be at least 8 characters")
		return
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
		u.Role, u.Groups, u.Disabled = in.Role, filterGroups(d, in.Groups), in.Disabled
		if hash != "" {
			u.PasswordHash = hash
			u.TokenVersion++
		}
		return nil
	})
	a.reply(w, err)
}

func filterGroups(d *Data, ids []string) []string {
	out := []string{}
	for _, g := range ids {
		if d.GroupByID(g) != nil {
			out = append(out, g)
		}
	}
	return out
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
				return nil
			}
		}
		return errNotFound
	})
	a.reply(w, err)
}

func (a *API) saveGroup(w http.ResponseWriter, r *http.Request, _ *User) {
	var in Group
	if !decode(w, r, &in) {
		return
	}
	id := r.PathValue("id")
	err := a.st.Update(func(d *Data) error {
		name := clean(in.Name, 40)
		if name == "" {
			return errMsg("name required")
		}
		var g *Group
		if id == "" {
			g = &Group{ID: newID()}
			d.Groups = append(d.Groups, g)
		} else if g = d.GroupByID(id); g == nil {
			return errNotFound
		}
		g.Name, g.Color = name, validColor(in.Color)
		return nil
	})
	a.reply(w, err)
}

func (a *API) delGroup(w http.ResponseWriter, r *http.Request, _ *User) {
	id := r.PathValue("id")
	err := a.st.Update(func(d *Data) error {
		idx := -1
		for i, g := range d.Groups {
			if g.ID == id {
				idx = i
			}
		}
		if idx < 0 {
			return errNotFound
		}
		d.Groups = append(d.Groups[:idx], d.Groups[idx+1:]...)
		strip := func(gr []Grant) []Grant {
			out := gr[:0]
			for _, g := range gr {
				if g.Principal != "group:"+id {
					out = append(out, g)
				}
			}
			return out
		}
		for _, u := range d.Users {
			u.Groups = filterGroups(d, u.Groups)
		}
		for _, x := range d.Rooms {
			x.Access = strip(x.Access)
		}
		for _, x := range d.Feeds {
			x.Access = strip(x.Access)
		}
		for _, x := range d.Invites {
			x.Groups = filterGroups(d, x.Groups)
		}
		return nil
	})
	a.reply(w, err)
}

func cleanGrants(d *Data, in []Grant, feed bool) []Grant {
	out := []Grant{}
	for _, g := range in {
		ok := g.Principal == "everyone" ||
			(strings.HasPrefix(g.Principal, "group:") && d.GroupByID(g.Principal[6:]) != nil) ||
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

func (a *API) saveInvite(w http.ResponseWriter, r *http.Request, _ *User) {
	var in struct {
		Name       string   `json:"name"`
		Groups     []string `json:"groups"`
		ExpiresHrs int      `json:"expiresHours"`
		MaxUses    int      `json:"maxUses"`
	}
	if !decode(w, r, &in) {
		return
	}
	a.reply(w, a.st.Update(func(d *Data) error {
		inv := &Invite{
			ID: newID(), Token: newSecret(12), Name: clean(in.Name, 40), Groups: filterGroups(d, in.Groups),
			MaxUses: max(in.MaxUses, 0), CreatedAt: time.Now(),
		}
		if inv.Name == "" {
			inv.Name = "Guest invite"
		}
		if in.ExpiresHrs > 0 {
			inv.ExpiresAt = time.Now().Add(time.Duration(in.ExpiresHrs) * time.Hour)
		}
		d.Invites = append(d.Invites, inv)
		return nil
	}))
}

func (a *API) delInvite(w http.ResponseWriter, r *http.Request, _ *User) {
	id := r.PathValue("id")
	a.reply(w, a.st.Update(func(d *Data) error {
		for i, x := range d.Invites {
			if x.ID == id {
				d.Invites = append(d.Invites[:i], d.Invites[i+1:]...)
				// Revoke guests who joined through it.
				kept := d.Users[:0]
				for _, u := range d.Users {
					if !(u.Guest && u.InviteID == id) {
						kept = append(kept, u)
					}
				}
				d.Users = kept
				return nil
			}
		}
		return errNotFound
	}))
}
