// Synchronised playout for the program feed. Pure logic (no Web Audio) so it can be tested in Node.
//
// Every feed packet carries a timestamp from the server's clock. Each device (1) measures how far its
// own clock is from the server's, then (2) plays every packet at stamp + one fixed delay. Since the
// stamp and the delay are the same for everybody, every device sounds the same audio at the same
// instant, whatever its network or sound card. The fixed delay must be longer than the slowest
// device's network path; a packet that arrives after its play time is skipped rather than played late.

// Measures (server clock - this device's performance.now()) with repeated ping/pong exchanges.
export class ClockSync {
  constructor() { this.samples = []; this.offset = null; this.rtt = null; }

  // sent/recv: this device's performance.now() when the ping left / the pong arrived; serverMs: the server's
  // clock when it answered. Assumes the answer was made halfway through the round trip.
  add(sent, serverMs, recv) {
    const rtt = recv - sent;
    if (!(rtt >= 0) || rtt > 3000) return;
    const off = serverMs + rtt / 2 - recv;
    // A device that sleeps can lose time on its monotonic clock, which makes every older measurement wrong by the same
    // amount (seconds). Spot it: three fresh measurements that agree with each other but are more than 0.4 s away from what
    // we had (ordinary network changes move it by tens of milliseconds). Start over from them.
    this.recent = (this.recent || []).concat({ rtt, off }).slice(-3);
    if (this.offset !== null && this.recent.length === 3) {
      const offs = this.recent.map((s) => s.off), mean = (offs[0] + offs[1] + offs[2]) / 3;
      if (Math.max(...offs) - Math.min(...offs) < 10 && Math.abs(mean - this.offset) > 400) this.samples = [...this.recent];
    }
    this.samples.push({ rtt, off });
    if (this.samples.length > 12) this.samples.shift();
    // The quickest round trips are the least disturbed by queuing. Use the median of the best three.
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3).sort((a, b) => a.off - b.off);
    this.offset = best[Math.floor(best.length / 2)].off;
    this.rtt = best[0].rtt;
  }
  reset() { this.samples = []; this.recent = []; this.offset = null; this.rtt = null; }   // after an absence the old measurements are wrong
  get ready() { return this.offset !== null && this.samples.length >= 3; }
  // Worst-case error from path asymmetry is half the best round trip.
  get uncertaintyMs() { return this.rtt === null ? Infinity : this.rtt / 2; }
}

// Queues chunks back to back on the audio clock, steering the queue toward the absolute time each chunk
// is due. Small errors are absorbed by stretching or squeezing a chunk by a few samples (see stretch());
// a large error re-anchors; a chunk that is already too late is dropped so everyone stays aligned.
export class SyncPlayout {
  constructor(sampleRate = 48000) {
    this.sr = sampleRate;
    this.next = null;            // audio-clock time at which the next chunk will start
    this.maxSlip = 8;            // max samples added/removed per chunk
    this.far = 0;                // consecutive chunks that were far from where they should be
    this.bias = 0;               // smoothed timing error: individual readings are noisy (phones report the output clock coarsely)
    // Extra local delay, only when this device's network is slower than the shared delay. Chunks that would arrive after
    // their play time make it grow (the listener drifts a little out of lockstep, but hears smooth audio instead of gaps);
    // it shrinks again slowly once chunks arrive comfortably early.
    this.extra = 0;
    this.stats = { drops: 0, reanchors: 0, corrections: 0, dry: 0, dryMaxMs: 0 };
  }

  _anchor(desired0, now, n) {
    this.far = 0; this.bias = 0;
    if (this.next !== null) this.stats.reanchors++;
    let desired = desired0 + this.extra;
    const late = now + 0.002 - desired;
    if (late > 0) {
      if (late > 1.0) { this.stats.drops++; this.next = null; return { drop: true, when: desired, slip: 0 }; }   // hopelessly late
      this.extra = Math.min(1.0, this.extra + late + 0.03); desired = desired0 + this.extra;
    }
    const when = Math.max(desired, now + 0.002);
    this.next = when + n / this.sr;
    return { when, slip: 0, drop: false };
  }

  // desired: audio-clock time this chunk is due; now: audio-clock time now; n: its length in samples.
  plan(desired0, now, n) {
    if (this.next === null) return this._anchor(desired0, now, n);
    const desired = desired0 + this.extra;
    const err = desired - this.next;                          // positive: we are early, so lengthen
    // A real discontinuity persists for several chunks; a noisy reading does not. Only then jump.
    if (Math.abs(err) > 0.05) { if (++this.far >= 4) return this._anchor(desired0, now, n); } else this.far = 0;
    // Steer by the smoothed error, so noise averages out and only a real offset or drift is corrected.
    this.bias += 0.01 * (Math.max(-0.05, Math.min(0.05, err)) - this.bias);   // about a 2 s time constant
    let slip = 0;
    if (Math.abs(this.bias) > 0.0008) {
      slip = Math.max(-this.maxSlip, Math.min(this.maxSlip, Math.round(this.bias * this.sr)));
      if (slip) { this.stats.corrections++; this.bias -= slip / this.sr; }
    }
    let when = this.next;
    if (when < now - 0.005) {                                 // our queue ran dry: this chunk is late for this network
      const late = now - when;
      this.stats.dry++; this.stats.dryMaxMs = Math.max(this.stats.dryMaxMs, Math.round(late * 1000));
      if (late > 1.0) { this.stats.drops++; this.next = null; return { drop: true, when, slip: 0 }; }
      this.extra = Math.min(1.0, this.extra + late + 0.02);
      when = now + 0.02;
    } else if (this.extra > 0 && when - now > 0.12) {
      this.extra = Math.max(0, this.extra - 0.0002);          // comfortably early: give some of the cushion back
    }
    this.next = when + (n + slip) / this.sr;
    return { when, slip, drop: false };
  }
}

// 8-tap Hann-windowed sinc fractional-delay kernel, 256 phases, unity gain at DC.
const TAPS = 8, PHASES = 256;
const KERNEL = (() => {
  const k = new Float32Array(PHASES * TAPS);
  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES; let sum = 0;
    for (let t = 0; t < TAPS; t++) {
      const x = frac - (t - 3);
      const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = Math.abs(x) >= 4 ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * x) / 4);
      k[p * TAPS + t] = sinc * w; sum += sinc * w;
    }
    for (let t = 0; t < TAPS; t++) k[p * TAPS + t] /= sum;
  }
  return k;
})();

// Resample one channel to m samples (m close to its length). Both ends line up with the original's first and
// last sample, so chunk boundaries stay continuous.
export function stretch(src, m) {
  const n = src.length;
  if (m === n || n < 2 || m < 2) return src;
  const out = new Float32Array(m);
  const step = (n - 1) / (m - 1), last = n - 1;
  for (let j = 0; j < m; j++) {
    const pos = j * step; let i = Math.floor(pos), ph = Math.round((pos - i) * PHASES);
    if (ph === PHASES) { ph = 0; i++; }
    let acc = 0; const base = ph * TAPS;
    for (let t = 0; t < TAPS; t++) {
      let idx = i + t - 3; idx = idx < 0 ? 0 : idx > last ? last : idx;
      acc += src[idx] * KERNEL[base + t];
    }
    out[j] = acc;
  }
  return out;
}
