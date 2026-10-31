package main

import (
	"testing"
	"time"
)

func TestPermissions(t *testing.T) {
	r := &Room{Access: []Grant{
		{Principal: "user:a", Listen: true, Talk: true},
		{Principal: "everyone", Listen: true},
		{Principal: "user:u9", Listen: true, Talk: true},
	}}
	if p := r.PermFor(&User{ID: "a"}); !p.Talk || !p.Listen {
		t.Fatal("assigned user should talk")
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

func TestOpusDuration(t *testing.T) {
	if d := opusDuration([]byte{0xfc}); d != 20*time.Millisecond {
		t.Fatalf("got %v", d)
	}
}

func TestMigrateGroups(t *testing.T) {
	d := &Data{Rooms: []*Room{{Access: []Grant{{Principal: "group:g1", Listen: true, Talk: true}, {Principal: "user:u2", Listen: true}}}}}
	if !d.migrateGroups(map[string][]string{"g1": {"u1", "u2"}}) {
		t.Fatal("expected change")
	}
	acc := d.Rooms[0].Access
	if len(acc) != 2 {
		t.Fatalf("got %+v", acc)
	}
	for _, g := range acc {
		if g.Principal == "user:u2" && !g.Talk {
			t.Fatal("u2 should have talk merged from its group")
		}
	}
}

func TestSortMembersIsStable(t *testing.T) {
	want := []presenceMember{{C: 3, N: "amy"}, {C: 9, N: "Bob"}, {C: 2, N: "bob"}, {C: 5, N: "Cat"}}
	for i := 0; i < 50; i++ {
		got := []presenceMember{{C: 5, N: "Cat"}, {C: 2, N: "bob"}, {C: 3, N: "amy"}, {C: 9, N: "Bob"}}
		if i%2 == 1 {
			got[0], got[3] = got[3], got[0]
		}
		sortMembers(got)
		if got[0].N != "amy" || got[3].N != "Cat" || got[1].C != 2 || got[2].C != 9 {
			t.Fatalf("round %d: %+v, want %+v", i, got, want)
		}
	}
}
