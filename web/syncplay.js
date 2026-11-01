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
    this.lastLate = 0; this.episode = 0;   // audio-clock time the current run of late chunks began (0: none)
    this.lastDry = -1e9;         // audio-clock time of the last time the queue ran dry
    this.allow = 0;              // samples this device may still cut while catching up (5% of the audio played)
    this.stats = { drops: 0, reanchors: 0, corrections: 0, dry: 0, dryMaxMs: 0, catchUps: 0, splices: 0, spliceFallbacks: 0, skipped: 0 };
  }

  _anchor(desired0, now, n) {
    this.far = 0; this.bias = 0;
    if (this.next !== null) this.stats.reanchors++;
    let desired = desired0 + this.extra;
    const late = now + 0.002 - desired;
    if (late > 0) {
      if (late > 1.0) { this.stats.drops++; this.next = null; return { drop: true, when: desired, slip: 0 }; }   // hopelessly late
      if (!this.episode) this.episode = now;
      this.lastLate = now;
      if (now - this.episode < 1.5) {
        // A blip: this chunk is already past its time. Do not play it late and then hurry to make up: skip what was
        // missed and carry on from where the stream is now, so this device stays in step with the others.
        this.stats.skipped++; this.next = null;
        return { drop: true, skipped: true, when: desired, slip: 0 };
      }
      // Lateness that keeps going means this device's network is slower than the shared delay: skipping would chop the
      // sound all the time, so play late with a small cushion of its own instead (handed back later, see plan()).
      this.lastDry = now;
      this.extra = Math.min(1.0, this.extra + late + 0.03); desired = desired0 + this.extra;
    } else this.episode = 0;
    const when = Math.max(desired, now + 0.002);
    this.next = when + n / this.sr;
    return { when, slip: 0, drop: false };
  }

  // desired: audio-clock time this chunk is due; now: audio-clock time now; n: its length in samples.
  plan(desired0, now, n, planes) {
    if (this.next === null) return this._anchor(desired0, now, n);
    const desired = desired0 + this.extra;
    const err = desired - this.next;                          // positive: we are early, so lengthen
    // A real discontinuity persists for several chunks; a noisy reading does not. Only then jump.
    if (Math.abs(err) > 0.05) { if (++this.far >= 4) return this._anchor(desired0, now, n); } else this.far = 0;
    // Steer by the smoothed error, so noise averages out and only a real offset or drift is corrected.
    this.bias += 0.01 * (Math.max(-0.05, Math.min(0.05, err)) - this.bias);   // about a 2 s time constant
    let slip = 0, cut = null;
    if (Math.abs(this.bias) > 0.0008) {
      const lim = Math.abs(err) > 0.02 ? 12 : this.maxSlip;     // a larger gap to close (catching up) may be closed a little faster
      slip = Math.max(-lim, Math.min(lim, Math.round(this.bias * this.sr)));
      if (slip) { this.stats.corrections++; this.bias -= slip / this.sr; }
    }
    if (this.episode && now - this.lastLate > 2) this.episode = 0;   // lateness is over: the next blip is a new one
    let when = this.next;
    if (when < now - 0.005) {                                 // our queue ran dry
      const late = now - when;
      this.lastDry = now; this.stats.dry++; this.stats.dryMaxMs = Math.max(this.stats.dryMaxMs, Math.round(late * 1000));
      this.next = null;
      return this._anchor(desired0, now, n);                  // carry on from where the stream is now, not from where we stopped
    } else if (this.extra > 0 && now - this.lastDry > 0.5 && when - now > 0.05) {
      // Quiet for half a second: hand the extra cushion back, so this device catches up with the others instead of staying
      // behind. Playing 5% faster closes a gap of 100 ms in 2 s. With the audio at hand it does so without changing the
      // pitch: it cuts out a wave cycle at the best-matching point now and then (never more than 5% of what it plays).
      // If the sound has no cycle to match, it squeezes the chunk a little instead.
      this.allow = Math.min(2 * SPLICE_MAX, this.allow + 0.05 * n);
      const left = this.extra * this.sr;
      if (left < SPLICE_MIN) { this.extra = 0; this.allow = 0; }     // a remainder of a few ms: the steering absorbs it
      else if (planes && this.allow >= SPLICE_MIN) {
        const sp = spliceOut(planes);
        if (sp && sp.removed <= left + 24) {
          this.extra = Math.max(0, this.extra - sp.removed / this.sr); this.allow -= sp.removed; this.stats.splices++;
          cut = sp; n -= sp.removed;
        } else { this.stats.spliceFallbacks++; const c = Math.min(left, 0.05 * n); this.extra -= c / this.sr; slip -= Math.round(c); }
      } else if (!planes) { const c = Math.min(left, 0.05 * n); this.extra -= c / this.sr; slip -= Math.round(c); }
      this.stats.catchUps++;
    } else this.allow = 0;
    this.next = when + (n + slip) / this.sr;
    return { when, slip, drop: false, planes: cut ? cut.planes : null };
  }
}

// ---- pitch-preserving shortening ------------------------------------------------------------------------
// To play faster without raising the pitch, cut out about one wave cycle: pick the place where the waveform a little
// further on looks most like the waveform here, and cross-fade across the join. Nothing is squeezed, so every note keeps
// its pitch. (The classic "overlap-add" time-scale trick.) Returns null when no good match exists (noise, silence-to-sound
// changes), and the caller falls back to squeezing the chunk a little instead.
export const SPLICE_MIN = 150, SPLICE_MAX = 400, XFADE = 96;   // samples at 48 kHz: 3.1 ms to 8.3 ms removed, 2 ms cross-fade
export function spliceOut(planes, minScore = 0.6) {
  const n = planes[0].length;
  if (n < SPLICE_MAX + 2 * XFADE + 16) return null;
  const mono = new Float32Array(n);
  for (const pl of planes) for (let i = 0; i < n; i++) mono[i] += pl[i] / planes.length;
  // coarse search on a 4x decimated copy (average of 4 samples: a cheap low-pass)
  const D = 4, nd = (n / D) | 0, dm = new Float32Array(nd);
  for (let i = 0; i < nd; i++) dm[i] = (mono[i * D] + mono[i * D + 1] + mono[i * D + 2] + mono[i * D + 3]) / D;
  const Ld = XFADE / D, rLo = Math.ceil(SPLICE_MIN / D), rHi = Math.floor(SPLICE_MAX / D);
  const corr = (x, a, b, L) => { let ab = 0, aa = 0, bb = 0; for (let i = 0; i < L; i++) { const u = x[a + i], v = x[b + i]; ab += u * v; aa += u * u; bb += v * v; } return aa + bb < 1e-8 * L ? 1 : ab / Math.sqrt(aa * bb + 1e-12); };
  let best = -2, bp = 0, br = 0;
  for (let r = rLo; r <= rHi; r++) for (let q = 0; q + r + Ld <= nd; q += 2) {
    const sc = corr(dm, q, q + r, Ld) - 0.0004 * Math.abs(r - 60);   // slight preference for about 5 ms
    if (sc > best) { best = sc; bp = q; br = r; }
  }
  // refine on the full-rate signal around the coarse winner
  let fb = -2, fp = bp * D, fr = br * D;
  for (let dr = -D; dr <= D; dr++) for (let dp = -D; dp <= D; dp++) {
    const p = bp * D + dp, r = br * D + dr;
    if (p < 0 || r < SPLICE_MIN || r > SPLICE_MAX || p + r + XFADE > n) continue;
    const sc = corr(mono, p, p + r, XFADE);
    if (sc > fb) { fb = sc; fp = p; fr = r; }
  }
  if (fb < minScore) return null;
  const out = planes.map((x) => {
    const y = new Float32Array(n - fr);
    y.set(x.subarray(0, fp), 0);
    for (let j = 0; j < XFADE; j++) { const w = 0.5 - 0.5 * Math.cos(Math.PI * (j + 0.5) / XFADE); y[fp + j] = x[fp + j] * (1 - w) + x[fp + fr + j] * w; }
    y.set(x.subarray(fp + fr + XFADE), fp + XFADE);
    return y;
  });
  return { planes: out, removed: fr, score: fb };
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
