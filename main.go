package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/pem"
	"errors"
	"io/fs"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/acme/autocert"
)

//go:embed web
var webFS embed.FS

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func main() {
	dataDir := env("NETSPEAK_DATA", "/data")
	domain := env("NETSPEAK_DOMAIN", "")
	mode := env("NETSPEAK_TLS", "auto")
	port := env("NETSPEAK_PORT", map[bool]string{true: "8080", false: "443"}[mode == "off"])

	st, first, err := OpenStore(dataDir)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	if first {
		pw := env("NETSPEAK_ADMIN_PASSWORD", "")
		generated := pw == ""
		if generated {
			pw = newSecret(6)
		}
		h, _ := hashPassword(pw)
		_ = st.Update(func(d *Data) error { d.Seed(h); return nil })
		if generated {
			log.Printf("================================================")
			log.Printf(" First start. Sign in as  admin / %s", pw)
			log.Printf(" (change it under Settings after signing in)")
			log.Printf("================================================")
		} else {
			log.Printf("First start: created user 'admin' with NETSPEAK_ADMIN_PASSWORD")
		}
	}

	auth := NewAuth(st, env("NETSPEAK_TRUST_PROXY", "") == "1")
	hub := NewHub(st, auth)
	api := &API{st: st, auth: auth, hub: hub}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", auth.handleLogin)
	mux.HandleFunc("POST /api/logout", auth.handleLogout)
	mux.HandleFunc("POST /api/join", auth.handleJoin)
	mux.HandleFunc("GET /api/invite/{token}", auth.handleInviteInfo)
	mux.HandleFunc("GET /api/me", auth.require(auth.handleMe))
	mux.HandleFunc("POST /api/me", auth.require(auth.handleMe))
	mux.HandleFunc("GET /ws", hub.ServeWS)
	mux.HandleFunc("PUT /ingest/{key}", hub.handleIngest)
	mux.HandleFunc("POST /ingest/{key}", hub.handleIngest)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	api.routes(mux)

	sub, _ := fs.Sub(webFS, "web")
	files := http.FileServer(http.FS(sub))
	index := func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = "/"
		files.ServeHTTP(w, r)
	}
	mux.HandleFunc("GET /join/{token}", index)
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/sw.js") || r.URL.Path == "/" {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})

	handler := secureHeaders(mux)
	go func() {
		for range time.Tick(time.Hour) {
			_ = st.Update(func(d *Data) error {
				kept := d.Users[:0]
				for _, u := range d.Users {
					if !(u.Guest && !u.ExpiresAt.IsZero() && time.Now().After(u.ExpiresAt)) {
						kept = append(kept, u)
					}
				}
				d.Users = kept
				return nil
			})
		}
	}()

	srv := &http.Server{
		Addr: ":" + port, Handler: handler,
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second,
	}
	switch mode {
	case "off":
		log.Printf("netspeak listening on http://:%s (TLS terminated by your reverse proxy)", port)
		log.Fatal(srv.ListenAndServe())
	case "auto":
		// Zero config: any hostname that reaches this server gets a trusted Let's Encrypt
		// certificate on first visit (tls-alpn-01, validated over 443 itself). Names that
		// cannot get one (IP addresses, LAN names, localhost, DNS not pointing here)
		// fall back to a self-signed certificate so the site still loads.
		m := &autocert.Manager{
			Prompt: autocert.AcceptTOS, HostPolicy: newHostGate(domain).policy,
			Cache: autocert.DirCache(filepath.Join(dataDir, "certs")), Email: env("NETSPEAK_EMAIL", ""),
		}
		ss := selfSigned(filepath.Join(dataDir, "certs"), domain)
		cfg := m.TLSConfig()
		cfg.GetCertificate = func(hi *tls.ClientHelloInfo) (*tls.Certificate, error) {
			for _, p := range hi.SupportedProtos {
				if p == "acme-tls/1" {
					return m.GetCertificate(hi)
				}
			}
			if !publicName(hi.ServerName) {
				return ss.get(hi)
			}
			c, err := m.GetCertificate(hi)
			if err != nil {
				return ss.get(hi)
			}
			return c, nil
		}
		srv.TLSConfig = cfg
		log.Printf("netspeak on https://:%s. Trusted HTTPS is automatic for any hostname pointing here; other addresses use a self-signed certificate.", port)
	default:
		srv.TLSConfig = &tls.Config{GetCertificate: selfSigned(filepath.Join(dataDir, "certs"), domain).get}
		log.Printf("netspeak on https://:%s with a self-signed certificate. Set NETSPEAK_DOMAIN for a trusted one.", port)
	}
	log.Fatal(srv.ListenAndServeTLS("", ""))
}

func secureHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("Permissions-Policy", "microphone=(self), camera=()")
		h.Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss: ws:; media-src 'self' blob:; worker-src 'self'; frame-ancestors 'none'")
		if r.TLS != nil {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// selfSignedCerts mints and caches a certificate per requested host/IP so the
// server works on a LAN with zero configuration.
type selfSignedCerts struct {
	dir, domain string
	mu          sync.Mutex
	cache       map[string]*tls.Certificate
}

func selfSigned(dir, domain string) *selfSignedCerts {
	_ = os.MkdirAll(dir, 0o700)
	return &selfSignedCerts{dir: dir, domain: domain, cache: map[string]*tls.Certificate{}}
}

func (s *selfSignedCerts) get(hi *tls.ClientHelloInfo) (*tls.Certificate, error) {
	name := hi.ServerName
	if name == "" {
		if a, ok := hi.Conn.LocalAddr().(*net.TCPAddr); ok {
			name = a.IP.String()
		}
	}
	if name == "" {
		name = "localhost"
	}
	safe := strings.Map(func(r rune) rune {
		if r == ':' || r == '/' || r == '\\' || r == '*' {
			return '_'
		}
		return r
	}, name)
	s.mu.Lock()
	defer s.mu.Unlock()
	if c := s.cache[safe]; c != nil {
		return c, nil
	}
	p := filepath.Join(s.dir, "selfsigned-"+safe+".pem")
	if b, err := os.ReadFile(p); err == nil {
		if c, err := tls.X509KeyPair(b, b); err == nil {
			s.cache[safe] = &c
			return &c, nil
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	t := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: name, Organization: []string{"netspeak"}},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(5, 0, 0),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	if ip := net.ParseIP(name); ip != nil {
		t.IPAddresses = []net.IP{ip}
	} else {
		t.DNSNames = []string{name}
	}
	der, err := x509.CreateCertificate(rand.Reader, t, t, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	kb, _ := x509.MarshalECPrivateKey(key)
	pemBytes := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb})...)
	_ = os.WriteFile(p, pemBytes, 0o600)
	c, err := tls.X509KeyPair(pemBytes, pemBytes)
	if err != nil {
		return nil, err
	}
	s.cache[safe] = &c
	return &c, nil
}

// publicName reports whether a TLS server name could plausibly get a public certificate.
func publicName(n string) bool {
	n = strings.ToLower(n)
	if n == "" || !strings.Contains(n, ".") || net.ParseIP(n) != nil || strings.ContainsAny(n, "_ ") {
		return false
	}
	for _, suf := range []string{".local", ".lan", ".internal", ".localhost", ".home", ".arpa", ".test", ".invalid", ".example"} {
		if strings.HasSuffix(n, suf) {
			return false
		}
	}
	return true
}

// hostGate decides which hostnames may trigger a Let's Encrypt order. It is what makes
// "any hostname" safe: scanners sending random SNI values cannot burn the ACME rate limit.
type hostGate struct {
	only  string
	mu    sync.Mutex
	first map[string]time.Time // start of the current attempt window per host
	hour  []time.Time          // window starts within the last hour
	now   func() time.Time
}

func newHostGate(only string) *hostGate {
	return &hostGate{only: strings.ToLower(only), first: map[string]time.Time{}, now: time.Now}
}

func (g *hostGate) policy(_ context.Context, host string) error { return g.allow(host) }

func (g *hostGate) allow(host string) error {
	host = strings.ToLower(host)
	if g.only != "" && host != g.only {
		return errors.New("host not allowed")
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	if t, ok := g.first[host]; ok {
		if now.Sub(t) < 2*time.Minute {
			return nil // order already in progress: let concurrent handshakes share it
		}
		if now.Sub(t) < 15*time.Minute {
			return errors.New("recently attempted; backing off")
		}
	}
	kept := g.hour[:0]
	for _, t := range g.hour {
		if now.Sub(t) < time.Hour {
			kept = append(kept, t)
		}
	}
	g.hour = kept
	if len(g.hour) >= 15 {
		return errors.New("too many certificate attempts this hour")
	}
	g.hour = append(g.hour, now)
	g.first[host] = now
	if len(g.first) > 1000 {
		g.first = map[string]time.Time{host: now}
	}
	return nil
}
