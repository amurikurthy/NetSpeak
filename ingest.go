package main

import (
	"bufio"
	"crypto/subtle"
	"encoding/binary"
	"io"
	"log"
	"net/http"
	"time"
)

// handleIngest accepts a streamed Ogg/Opus body (e.g. from ffmpeg or curl) and
// publishes each Opus packet to a feed untouched. No transcoding happens
// server-side, so program audio stays exactly as encoded by the source.
//
//	ffmpeg -re -i INPUT -c:a libopus -b:a 192k -frame_duration 20 -ac 2 -ar 48000 \
//	  -f ogg - | curl -sST - https://HOST/ingest/KEY
func (h *Hub) handleIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, "use PUT or POST", http.StatusMethodNotAllowed)
		return
	}
	key := r.PathValue("key")
	var feedID string
	h.st.View(func(d *Data) {
		for _, f := range d.Feeds {
			if subtle.ConstantTimeCompare([]byte(f.IngestKey), []byte(key)) == 1 {
				feedID = f.ID
			}
		}
	})
	if feedID == "" {
		http.Error(w, "invalid key", http.StatusForbidden)
		return
	}
	src := "ingest:" + newID()
	if !h.claimFeed(feedID, src) {
		http.Error(w, "feed already has a live source", http.StatusConflict)
		return
	}
	defer h.releaseFeed(feedID, src)
	log.Printf("ingest: feed %s live from %s", feedID, h.auth.clientIP(r))
	rc := http.NewResponseController(w)
	_ = rc.EnableFullDuplex()

	br := bufio.NewReaderSize(r.Body, 64*1024)
	var pkt []byte
	var t0 time.Time
	var acc time.Duration
	hdr := make([]byte, 27)
	for {
		if _, err := io.ReadFull(br, hdr); err != nil {
			break
		}
		if string(hdr[:4]) != "OggS" {
			http.Error(w, "not an Ogg stream", http.StatusBadRequest)
			return
		}
		nseg := int(hdr[26])
		segs := make([]byte, nseg)
		if _, err := io.ReadFull(br, segs); err != nil {
			break
		}
		for _, l := range segs {
			buf := make([]byte, l)
			if _, err := io.ReadFull(br, buf); err != nil {
				return
			}
			pkt = append(pkt, buf...)
			if l == 255 {
				continue
			}
			p := pkt
			pkt = nil
			if len(p) == 0 || string(p[:min(8, len(p))]) == "OpusHead" || string(p[:min(8, len(p))]) == "OpusTags" {
				continue
			}
			d := opusDuration(p)
			if t0.IsZero() {
				t0 = time.Now()
			}
			// Pace to real time (keep ~200ms ahead) so bursty senders don't flood listeners.
			if ahead := acc - time.Since(t0) - 200*time.Millisecond; ahead > 0 {
				select {
				case <-time.After(ahead):
				case <-r.Context().Done():
					return
				}
			}
			acc += d
			h.feedPacket(feedID, p)
		}
	}
}

// opusDuration returns the playback duration of an Opus packet from its TOC byte.
func opusDuration(p []byte) time.Duration {
	if len(p) == 0 {
		return 20 * time.Millisecond
	}
	cfg := p[0] >> 3
	var us int
	switch {
	case cfg < 12:
		us = []int{10000, 20000, 40000, 60000}[cfg%4]
	case cfg < 16:
		us = []int{10000, 20000}[cfg%2]
	default:
		us = []int{2500, 5000, 10000, 20000}[cfg%4]
	}
	frames := 1
	switch p[0] & 3 {
	case 1, 2:
		frames = 2
	case 3:
		if len(p) > 1 {
			frames = int(p[1] & 0x3f)
		}
	}
	return time.Duration(us*frames) * time.Microsecond
}

var _ = binary.BigEndian
