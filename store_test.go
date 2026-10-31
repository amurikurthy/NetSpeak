package main

import (
	"testing"
	"time"
)

func TestPermissions(t *testing.T) {
	r := &Room{Access: []Grant{
		{Principal: "group:g1", Listen: true, Talk: true},
		{Principal: "everyone", Listen: true},
		{Principal: "user:u9", Listen: true, Talk: true},
	}}
	if p := r.PermFor(&User{ID: "a", Groups: []string{"g1"}}); !p.Talk || !p.Listen {
		t.Fatal("group member should talk")
	}
	if p := r.PermFor(&User{ID: "b"}); p.Talk || !p.Listen {
		t.Fatal("everyone should listen only")
	}
	if p := r.PermFor(&User{ID: "u9"}); !p.Talk {
		t.Fatal("user grant should talk")
	}
	if p := r.PermFor(&User{ID: "x", Role: "admin"}); !p.Talk || !p.Source {
		t.Fatal("admin has everything")
	}
	if p := (&Room{}).PermFor(&User{ID: "c"}); p.Listen {
		t.Fatal("no grants means no access")
	}
}

func TestInviteValid(t *testing.T) {
	if (&Invite{ExpiresAt: time.Now().Add(-time.Minute)}).Valid() {
		t.Fatal("expired")
	}
	if (&Invite{MaxUses: 1, Uses: 1}).Valid() {
		t.Fatal("used up")
	}
	if !(&Invite{}).Valid() {
		t.Fatal("unlimited should be valid")
	}
}

func TestOpusDuration(t *testing.T) {
	if d := opusDuration([]byte{0xfc}); d != 20*time.Millisecond {
		t.Fatalf("got %v", d)
	}
}
