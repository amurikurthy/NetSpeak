package main

import (
	"testing"
	"time"
)

func TestHostGate(t *testing.T) {
	now := time.Now()
	g := newHostGate("")
	g.now = func() time.Time { return now }
	if g.allow("a.example.org") != nil {
		t.Fatal("first attempt allowed")
	}
	now = now.Add(time.Minute)
	if g.allow("a.example.org") != nil {
		t.Fatal("concurrent handshake shares the order")
	}
	now = now.Add(5 * time.Minute)
	if g.allow("a.example.org") == nil {
		t.Fatal("should back off after a failed window")
	}
	for i := 0; i < 20; i++ {
		_ = g.allow("h" + string(rune('a'+i)) + ".example.org")
	}
	if g.allow("zz.example.org") == nil {
		t.Fatal("global hourly cap")
	}
	if newHostGate("only.example.org").allow("other.example.org") == nil {
		t.Fatal("locked to one host")
	}
}

func TestPublicName(t *testing.T) {
	for n, want := range map[string]bool{"intercom.example.org": true, "": false, "192.168.1.5": false, "nas.local": false, "localhost": false, "box": false} {
		if publicName(n) != want {
			t.Fatalf("%q", n)
		}
	}
}
