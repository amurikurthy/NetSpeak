package main

// feedClock gives every program-feed packet a timestamp on the server's clock. Listeners play each
// packet at its stamp plus one fixed delay, so every device sounds the same audio at the same
// moment (see web/syncplay.js).
//
// Stamps follow the source's own pace (the sum of packet durations), anchored to when packets arrive
// at the server. Network jitter on the way in must not leak into the stamps, so the anchor follows
// only the lower envelope of arrival times and moves slowly: a source whose clock differs from the
// server's by a few hundred ppm is tracked without any step, and a burst of late packets is ignored.
type feedClock struct {
	started        bool
	anchor, m      int64 // microseconds: stamp = anchor + m
	curMin, prevMn int64 // lowest (arrival - m) in this and the previous window
	count          int
	lastUs         int64
}

const (
	clockWindow  = 250       // packets per minimum-tracking window (5 s of 20 ms packets)
	clockGap     = 1_500_000 // a silence this long means a new stream: re-anchor
	slewDownPPM  = 1000      // how fast the anchor may move earlier
	slewUpPPM    = 250       // how fast it may move later
	clockNoValue = int64(1) << 62
)

// stamp returns the server-clock stamp (microseconds) for a packet that arrived at arrivalUs and lasts durUs.
func (c *feedClock) stamp(arrivalUs, durUs int64) int64 {
	if !c.started || arrivalUs-c.lastUs > clockGap {
		*c = feedClock{started: true, anchor: arrivalUs, curMin: clockNoValue, prevMn: clockNoValue}
	}
	x := arrivalUs - c.m
	if x < c.curMin {
		c.curMin = x
	}
	if c.count++; c.count >= clockWindow {
		c.prevMn, c.curMin, c.count = c.curMin, clockNoValue, 0
	}
	target := c.curMin
	if c.prevMn < target {
		target = c.prevMn
	}
	d := target - c.anchor
	if lim := durUs * slewDownPPM / 1_000_000; d < -lim {
		d = -lim
	}
	if lim := durUs * slewUpPPM / 1_000_000; d > lim {
		d = lim
	}
	c.anchor += d
	s := c.anchor + c.m
	c.m += durUs
	c.lastUs = arrivalUs
	return s
}
