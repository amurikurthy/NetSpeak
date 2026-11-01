package main

import (
	"bytes"
	"log"
	"strings"
	"testing"
	"time"
)

func TestWatchGapLogsOnlyRealStalls(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(nil)
	fs := &feedState{}
	now := time.Now()
	fs.watchGap("f", now) // first packet: nothing to compare
	fs.last = now
	fs.watchGap("f", now.Add(20*time.Millisecond)) // normal pace
	if buf.Len() != 0 {
		t.Fatalf("logged for normal pacing: %q", buf.String())
	}
	fs.watchGap("f", now.Add(845*time.Millisecond))
	if !strings.Contains(buf.String(), "845 ms") {
		t.Fatalf("stall not logged: %q", buf.String())
	}
	buf.Reset()
	fs.watchGap("f", now.Add(30*time.Second)) // a restarted sender, not a stall
	if buf.Len() != 0 {
		t.Fatalf("logged for a long pause: %q", buf.String())
	}
}
