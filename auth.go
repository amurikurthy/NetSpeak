package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const cookieName = "ns_session"

type Auth struct {
	st         *Store
	trustProxy bool
	mu         sync.Mutex
	attempts   map[string]*attempt
}

type attempt struct {
	n     int
	since time.Time
}

func NewAuth(st *Store, trustProxy bool) *Auth {
	return &Auth{st: st, trustProxy: trustProxy, attempts: map[string]*attempt{}}
}

func hashPassword(p string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(p), 11)
	return string(b), err
}

func (a *Auth) sign(payload string) string {
	m := hmac.New(sha256.New, a.st.Secret())
	m.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (a *Auth) issue(w http.ResponseWriter, r *http.Request, u *User) {
	exp := time.Now().Add(90 * 24 * time.Hour)
	if u.Guest && !u.ExpiresAt.IsZero() {
		exp = u.ExpiresAt
	}
	tok := a.sign(u.ID + "|" + strconv.Itoa(u.TokenVersion) + "|" + strconv.FormatInt(exp.Unix(), 10))
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: tok, Path: "/", Expires: exp, HttpOnly: true,
		Secure: isSecure(r), SameSite: http.SameSiteLaxMode,
	})
}

func isSecure(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// UserFrom returns a snapshot copy of the authenticated user or nil.
func (a *Auth) UserFrom(r *http.Request) *User {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return nil
	}
	parts := strings.SplitN(c.Value, ".", 2)
	if len(parts) != 2 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil
	}
	if subtle.ConstantTimeCompare([]byte(a.sign(string(raw))), []byte(c.Value)) != 1 {
		return nil
	}
	f := strings.Split(string(raw), "|")
	if len(f) != 3 {
		return nil
	}
	ver, _ := strconv.Atoi(f[1])
	exp, _ := strconv.ParseInt(f[2], 10, 64)
	if time.Now().Unix() > exp {
		return nil
	}
	var out *User
	a.st.View(func(d *Data) {
		u := d.UserByID(f[0])
		if u == nil || u.Disabled || u.TokenVersion != ver {
			return
		}
		if u.Guest && !u.ExpiresAt.IsZero() && time.Now().After(u.ExpiresAt) {
			return
		}
		cp := *u
		cp.Groups = append([]string(nil), u.Groups...)
		out = &cp
	})
	return out
}

func (a *Auth) clientIP(r *http.Request) string {
	if a.trustProxy {
		if x := r.Header.Get("X-Forwarded-For"); x != "" {
			return strings.TrimSpace(strings.Split(x, ",")[0])
		}
	}
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

// throttled records an attempt and reports whether the caller must back off.
func (a *Auth) throttled(ip string, fail bool) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	at := a.attempts[ip]
	if at == nil || time.Since(at.since) > 10*time.Minute {
		at = &attempt{since: time.Now()}
		a.attempts[ip] = at
	}
	if fail {
		at.n++
	}
	return at.n >= 10
}

func (a *Auth) clearAttempts(ip string) {
	a.mu.Lock()
	delete(a.attempts, ip)
	a.mu.Unlock()
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func publicUser(u *User) map[string]any {
	return map[string]any{
		"id": u.ID, "username": u.Username, "displayName": u.DisplayName,
		"role": u.Role, "guest": u.Guest,
	}
}

func (a *Auth) handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := a.clientIP(r)
	if a.throttled(ip, false) {
		writeErr(w, 429, "Too many attempts. Try again in a few minutes.")
		return
	}
	var in struct{ Username, Password string }
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil {
		writeErr(w, 400, "bad request")
		return
	}
	var u *User
	a.st.View(func(d *Data) {
		if x := d.UserByName(in.Username); x != nil {
			cp := *x
			u = &cp
		}
	})
	// Always run a bcrypt compare to keep timing uniform.
	hash := "$2a$11$0000000000000000000000000000000000000000000000000000."
	if u != nil {
		hash = u.PasswordHash
	}
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password))
	if u == nil || err != nil || u.Disabled {
		a.throttled(ip, true)
		writeErr(w, 401, "Wrong username or password")
		return
	}
	a.clearAttempts(ip)
	a.issue(w, r, u)
	writeJSON(w, 200, publicUser(u))
}

func (a *Auth) handleJoin(w http.ResponseWriter, r *http.Request) {
	ip := a.clientIP(r)
	if a.throttled(ip, false) {
		writeErr(w, 429, "Too many attempts")
		return
	}
	var in struct{ Token, Name string }
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil {
		writeErr(w, 400, "bad request")
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || len(name) > 40 {
		writeErr(w, 400, "Enter a name (max 40 characters)")
		return
	}
	var user *User
	err := a.st.Update(func(d *Data) error {
		inv := d.InviteByToken(in.Token)
		if inv == nil || !inv.Valid() {
			return errNotFound
		}
		inv.Uses++
		exp := inv.ExpiresAt
		if exp.IsZero() {
			exp = time.Now().Add(7 * 24 * time.Hour)
		}
		user = &User{
			ID: newID(), Username: "guest-" + newID(), DisplayName: name, Role: "user",
			Groups: append([]string(nil), inv.Groups...), Guest: true, InviteID: inv.ID,
			ExpiresAt: exp, CreatedAt: time.Now(),
		}
		d.Users = append(d.Users, user)
		return nil
	})
	if err != nil {
		a.throttled(ip, true)
		writeErr(w, 400, "This invite link is invalid or has expired")
		return
	}
	a.issue(w, r, user)
	writeJSON(w, 200, publicUser(user))
}

func (a *Auth) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleInviteInfo lets the join page show what the invite is for.
func (a *Auth) handleInviteInfo(w http.ResponseWriter, r *http.Request) {
	tok := r.PathValue("token")
	var name string
	ok := false
	a.st.View(func(d *Data) {
		if i := d.InviteByToken(tok); i != nil && i.Valid() {
			ok, name = true, i.Name
		}
	})
	if !ok {
		writeErr(w, 404, "invalid or expired invite")
		return
	}
	writeJSON(w, 200, map[string]string{"name": name})
}

func (a *Auth) require(next func(http.ResponseWriter, *http.Request, *User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := a.UserFrom(r)
		if u == nil {
			writeErr(w, 401, "not signed in")
			return
		}
		next(w, r, u)
	}
}

func (a *Auth) requireAdmin(next func(http.ResponseWriter, *http.Request, *User)) http.HandlerFunc {
	return a.require(func(w http.ResponseWriter, r *http.Request, u *User) {
		if u.Role != "admin" {
			writeErr(w, 403, "admin only")
			return
		}
		next(w, r, u)
	})
}

// handleMe returns the profile (GET) or updates display name / password (POST).
func (a *Auth) handleMe(w http.ResponseWriter, r *http.Request, u *User) {
	if r.Method == http.MethodGet {
		writeJSON(w, 200, publicUser(u))
		return
	}
	var in struct {
		DisplayName string `json:"displayName"`
		OldPassword string `json:"oldPassword"`
		NewPassword string `json:"newPassword"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in) != nil {
		writeErr(w, 400, "bad request")
		return
	}
	if in.NewPassword != "" {
		if u.Guest {
			writeErr(w, 400, "guests have no password")
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(in.OldPassword)) != nil {
			writeErr(w, 403, "current password is wrong")
			return
		}
		if len(in.NewPassword) < 8 {
			writeErr(w, 400, "password must be at least 8 characters")
			return
		}
	}
	var updated *User
	err := a.st.Update(func(d *Data) error {
		x := d.UserByID(u.ID)
		if x == nil {
			return errNotFound
		}
		if n := strings.TrimSpace(in.DisplayName); n != "" && len(n) <= 40 {
			x.DisplayName = n
		}
		if in.NewPassword != "" {
			h, err := hashPassword(in.NewPassword)
			if err != nil {
				return err
			}
			x.PasswordHash = h
			x.TokenVersion++
		}
		cp := *x
		updated = &cp
		return nil
	})
	if err != nil {
		writeErr(w, 500, "could not save")
		return
	}
	a.issue(w, r, updated)
	writeJSON(w, 200, publicUser(updated))
}
