package main

import (
	"math"
	"math/rand"
	"testing"
)

// Source clock 300 ppm slow/fast, bursty network: stamps must never step, must keep the source's pace,
// and must stay close to arrival times (so the fixed listener delay isn't eaten by drift).
func TestFeedClockTracksDriftWithoutSteps(t *testing.T) {
	for _, ppm := range []float64{-300, 0, 300} {
		var c feedClock
		rng := rand.New(rand.NewSource(1))
		var prev int64
		var worstStep, maxLead, maxLag float64
		for i := 0; i < 60000; i++ { // 20 minutes
			nominal := float64(i)*20000*(1+ppm*1e-6) + 1_000_000
			jitter := rng.Float64() * 8000
			if i%900 > 880 { // a 400 ms stall every 18 s: packets arrive in a burst afterwards
				jitter = float64((900 - i%900) * 20000)
			}
			arrival := int64(nominal + jitter)
			s := c.stamp(arrival, 20000)
			if i > 0 {
				step := math.Abs(float64(s-prev) - 20000)
				if step > worstStep {
					worstStep = step
				}
				if s <= prev {
					t.Fatalf("ppm %v: stamps went backwards at %d", ppm, i)
				}
			}
			prev = s
			if i > 1000 {
				lead := float64(s) - float64(arrival) // stamp after arrival: positive
				if lead > maxLead {
					maxLead = lead
				}
				if -lead > maxLag {
					maxLag = -lead
				}
			}
		}
		t.Logf("ppm %+4.0f: worst step off 20 ms = %.0f us, stamp ahead of arrival max %.0f ms, behind max %.0f ms", ppm, worstStep, maxLead/1000, maxLag/1000)
		if worstStep > 21 {
			t.Fatalf("ppm %v: stamp spacing jumped by %.0f us (limit is the slew rate)", ppm, worstStep)
		}
		if maxLead > 60_000 || maxLag > 450_000 {
			t.Fatalf("ppm %v: stamps drifted away from arrival (lead %.0f ms, lag %.0f ms)", ppm, maxLead/1000, maxLag/1000)
		}
	}
}

func TestFeedClockReanchorsAfterGap(t *testing.T) {
	var c feedClock
	a := c.stamp(1_000_000, 20000)
	b := c.stamp(1_020_000, 20000)
	if b-a != 20000 {
		t.Fatalf("spacing %d", b-a)
	}
	z := c.stamp(9_000_000, 20000) // source restarted 8 s later
	if z != 9_000_000 {
		t.Fatalf("new stream should anchor at arrival, got %d", z)
	}
}
