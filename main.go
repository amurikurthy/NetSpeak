package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/pem"
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
	mode := env("NETSPEAK_TLS", "selfsigned")
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

	auth := NewAuth(st, env("NETSPEAK_TRUST_PROXY", "1") == "1")
	hub := NewHub(st, auth)
	api := &API{st: st, auth: auth, hub: hub}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", auth.handleLogin)
	mux.HandleFunc("POST /api/logout", auth.handleLogout)
	mux.HandleFunc("GET /api/me", auth.require(auth.handleMe))
	mux.HandleFunc("POST /api/me", auth.require(auth.handleMe))
	mux.HandleFunc("GET /ws", hub.ServeWS)
	mux.HandleFunc("PUT /ingest/{key}", hub.handleIngest)
	mux.HandleFunc("POST /ingest/{key}", hub.handleIngest)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	api.routes(mux)

	sub, _ := fs.Sub(webFS, "web")
	files := http.FileServer(http.FS(sub))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/sw.js") || r.URL.Path == "/" {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})

	handler := secureHeaders(mux)
	srv := &http.Server{
		Addr: ":" + port, Handler: handler,
		ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second,
	}
	switch mode {
	case "off":
		log.Printf("NetSpeak listening on http://:%s (TLS terminated by your reverse proxy)", port)
		log.Fatal(srv.ListenAndServe())
	default:
		srv.TLSConfig = &tls.Config{GetCertificate: selfSigned(filepath.Join(dataDir, "certs")).get}
		log.Printf("NetSpeak on https://:%s with a self-signed certificate (put your reverse proxy in front)", port)
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
	dir   string
	mu    sync.Mutex
	cache map[string]*tls.Certificate
}

func selfSigned(dir string) *selfSignedCerts {
	_ = os.MkdirAll(dir, 0o700)
	return &selfSignedCerts{dir: dir, cache: map[string]*tls.Certificate{}}
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
		SerialNumber: serial, Subject: pkix.Name{CommonName: name, Organization: []string{"NetSpeak"}},
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
