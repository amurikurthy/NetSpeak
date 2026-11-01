// Mic framer for NetSpeak: 20 ms blocks (960 samples @ 48 kHz), optional noise gate,
// and an automatic acoustic-feedback suppressor.
//
// Feedback (the howl you get when a speaker's sound re-enters a microphone) is a tone that
// persists and sits far above the spectrum around it. We watch the mic spectrum; when one
// frequency stays that way for ~240 ms we put a very narrow notch filter on exactly that
// frequency. Speech is wideband and moves around, so it passes untouched, and nobody has to be
// muted. If howls keep appearing at several frequencies, we also trim the send level a few dB and
// let it recover once things calm down.

const FFT_N = 2048;
const BIN_HZ = 48000 / FFT_N;

class Fft {
  constructor(n) {
    this.n = n;
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = -Math.sin((2 * Math.PI * i) / n); }
    this.rev = new Uint16Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); this.rev[i] = r; }
    this.win = new Float32Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    this.re = new Float32Array(n);
    this.im = new Float32Array(n);
  }
  // Power spectrum (bins 0..n/2) of the windowed input into `out`.
  power(input, out) {
    const n = this.n, re = this.re, im = this.im;
    for (let i = 0; i < n; i++) { re[this.rev[i]] = input[i] * this.win[i]; im[this.rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = start + j, b = a + half;
          const tr = re[b] * this.cos[k] - im[b] * this.sin[k];
          const ti = re[b] * this.sin[k] + im[b] * this.cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let i = 0; i <= n / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
  }
}

class Notch {
  // RBJ notch biquad.
  constructor(freq, q) {
    const w = (2 * Math.PI * freq) / 48000, alpha = Math.sin(w) / (2 * q), c = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = 1 / a0; this.b1 = (-2 * c) / a0; this.b2 = 1 / a0;
    this.a1 = (-2 * c) / a0; this.a2 = (1 - alpha) / a0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    this.freq = freq;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}


// ---------------------------------------------------------------------------------------------------------
// Software echo canceller. It knows exactly what this device is playing (the reference), learns how that
// sound reaches the microphone, and subtracts it, so the phone's own call-mode echo cancellation (which
// brings Android's separate call volume) is not needed.
//
// It runs at 16 kHz (the voice band; a fifth of the cost of 48 kHz): partitioned-block frequency-domain
// adaptive filter, 32 blocks of 128 samples = a 256 ms window, wide enough for output + input latency and
// a room's tail. The echo estimate is then subtracted from the full-rate microphone signal.

class CFFT {
  constructor(n) {
    this.n = n; this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = Math.sin((2 * Math.PI * i) / n); }
    this.rev = new Uint16Array(n); const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); this.rev[i] = r; }
  }
  run(re, im, inverse) {
    const n = this.n;
    for (let i = 0; i < n; i++) { const j = this.rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = this.cos[k], wi = sgn * this.sin[k], a = start + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

class Aec {
  constructor() {
    this.B = 128; this.N = 256; this.K = 129; this.P = 32; this.CPB = 4;   // CPB: filter blocks length-constrained per call (the costly part: 2 FFTs each)
    const { N, K, P } = this;
    this.fft = new CFFT(N);
    this.xbuf = new Float64Array(N);
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.Xr = new Float32Array(P * K); this.Xi = new Float32Array(P * K);   // reference spectra, newest at `hp`
    this.Wr = new Float32Array(P * K); this.Wi = new Float32Array(P * K);   // filter: one spectrum per block of delay
    this.Er = new Float64Array(K); this.Ei = new Float64Array(K);
    this.wE = new Float64Array(P);
    this.dbuf = new Float64Array(N);                                        // mic window, for the echo-presence detector
    this.Cr = new Float32Array(P * K); this.Ci = new Float32Array(P * K);  // slow average of conj(X_p) * D, per delay block and frequency
    this.PX = new Float32Array(P * K); this.PD = new Float64Array(K);       // slow averages of |X_p|^2 and |D|^2
    this.coh = 0;                                                           // 0 = mic unrelated to playback, 1 = mic is playback
    this.hp = 0; this.cblk = 0; this.nb = 0;
    this.conv = 0; this.dtHold = 0; this.dtCount = 0; this.bad = 0;
    this.erle = 0;                                                          // smoothed echo reduction in dB (diagnostics)
    this.muHi = 1.2; this.muLo = 0.8; this.muDt = 0.002; this.freeze = 0; this.silent = 0; this.alpha = 0; this.leakK = 0; this.cohT = 0.38; this.cohBeta = 0.02; this.prop = 0.6; this.floorRel = 0.02; // tuning: step before/after convergence, proportionate share, power floor
  }

  // Forget the recent history (not the learned filter): used when the canceller has been idle and starts again.
  wake() {
    this.xbuf.fill(0); this.dbuf.fill(0); this.Xr.fill(0); this.Xi.fill(0);
    this.Cr.fill(0); this.Ci.fill(0); this.PX.fill(0); this.PD.fill(0);
    this.coh = 0; this.alpha = 0; this.silent = 0; this.freeze = 0;
  }

  // d: mic block, x: reference block (B samples each, 16 kHz). Writes the echo estimate to yhat.
  block(d, x, yhat) {
    const { B, N, K, P, re, im } = this;
    this.xbuf.copyWithin(0, B); for (let i = 0; i < B; i++) this.xbuf[B + i] = x[i];
    let px = 0, pd = 0;
    for (let i = 0; i < B; i++) { px += x[i] * x[i]; pd += d[i] * d[i]; }
    // Nothing playing (digital silence for longer than the filter window): there is nothing to cancel, so skip the
    // heavy work entirely. The history is then all zeros, so resuming later is exact.
    if (px / B < 1e-10) {
      if (++this.silent > P) { this.xbuf.fill(0); this.Xr.fill(0); this.Xi.fill(0); yhat.fill(0); return; }
    } else this.silent = 0;
    for (let i = 0; i < N; i++) { re[i] = this.xbuf[i]; im[i] = 0; }
    this.fft.run(re, im, false);
    this.hp = (this.hp + 1) % P;
    const base = this.hp * K;
    for (let k = 0; k < K; k++) { this.Xr[base + k] = re[k]; this.Xi[base + k] = im[k]; }
    this.nb = (this.nb + 1) | 0;
    // Echo-presence detector: averaged over about half a second, the mic is only coherent with the playback (at some
    // delay) if the playback really reaches the mic. Unrelated speech averages out to a low value.
    this.dbuf.copyWithin(0, B); for (let i = 0; i < B; i++) this.dbuf[B + i] = d[i];
    if ((this.nb & 3) === 0) {   // the averages are slow, so every fourth block is plenty (and a quarter of the cost)
      for (let i = 0; i < N; i++) { re[i] = this.dbuf[i]; im[i] = 0; }
      this.fft.run(re, im, false);
      const bt = this.cohBeta * 4; let cohMax = 0;
      for (let k = 0; k < K; k++) this.PD[k] += bt * (re[k] * re[k] + im[k] * im[k] - this.PD[k]);
      for (let p = 0; p < P; p++) {
        const xo = ((this.hp - p + P) % P) * K; let num = 0, den = 0;
        for (let k = 0; k < K; k++) {
          const xr = this.Xr[xo + k], xi = this.Xi[xo + k], o = p * K + k;   // averages are indexed by delay (p), not by ring slot
          this.Cr[o] += bt * (xr * re[k] + xi * im[k] - this.Cr[o]); this.Ci[o] += bt * (xr * im[k] - xi * re[k] - this.Ci[o]);
          this.PX[o] += bt * (xr * xr + xi * xi - this.PX[o]);
          num += Math.sqrt(this.Cr[o] * this.Cr[o] + this.Ci[o] * this.Ci[o]); den += Math.sqrt(this.PX[o] * this.PD[k]);
        }
        const c = num / (den + 1e-20); if (c > cohMax) cohMax = c;
      }
      this.coh = cohMax;
    }
    // echo estimate: sum over blocks of W_p * X_(now - p)
    const Yr = this.Er, Yi = this.Ei; Yr.fill(0); Yi.fill(0);
    for (let p = 0; p < P; p++) {
      const xo = ((this.hp - p + P) % P) * K, wo = p * K;
      for (let k = 0; k < K; k++) {
        const xr = this.Xr[xo + k], xi = this.Xi[xo + k], wr = this.Wr[wo + k], wi = this.Wi[wo + k];
        Yr[k] += wr * xr - wi * xi; Yi[k] += wr * xi + wi * xr;
      }
    }
    for (let k = 0; k < K; k++) { re[k] = Yr[k]; im[k] = Yi[k]; }
    for (let k = K; k < N; k++) { re[k] = re[N - k]; im[k] = -im[N - k]; }
    this.fft.run(re, im, true);
    let pe = 0, dy = 0, yy = 0;
    for (let i = 0; i < B; i++) { yhat[i] = re[B + i]; const e = d[i] - yhat[i]; pe += e * e; dy += d[i] * yhat[i]; yy += yhat[i] * yhat[i]; this.e = this.e || new Float64Array(B); this.e[i] = e; }
    // Trust in the estimate: the share of it that really matches the mic (0 = unrelated, 1 = exactly the echo). The
    // output subtracts only this share, so while the filter is still learning, or when there is no echo at all
    // (earbuds), the voice passes through untouched instead of being damaged. Smoothed to avoid level wobble.
    this.alpha += 0.3 * (Math.max(0, Math.min(1, dy / (yy + 1e-12))) - this.alpha);

    if (!Number.isFinite(pe)) { this.Wr.fill(0); this.Wi.fill(0); this.conv = 0; yhat.fill(0); return; }   // never let a numerical blow-up reach the output
    // Error spectrum (overlap-save: first half zero), needed both to judge the error and to update the filter.
    for (let i = 0; i < B; i++) { re[i] = 0; im[i] = 0; re[B + i] = this.e[i]; im[B + i] = 0; }
    this.fft.run(re, im, false);
    let pE = 0; for (let k = 0; k < K; k++) { this.Er[k] = re[k]; this.Ei[k] = im[k]; pE += re[k] * re[k] + im[k] * im[k]; }
    // Step size. Learn only while the far end is audible. Once converged: full speed if the echo estimate clearly
    // dominates the error (at least 6 dB of cancellation is happening, so the error is leftover echo); otherwise
    // nearly freeze, or a near-end talker's voice would be wrecked. A long unbroken freeze is taken to mean the room
    // changed (a talker's pauses would have broken it), and the filter relearns.
    let py = 0; for (let i = 0; i < B; i++) py += yhat[i] * yhat[i];
    const far = px / B > 4e-6, eps = 1e-12;
    let mu = 0;
    if (far) {
      if (this.coh < this.cohT && this.conv < 6) { mu = this.muDt; this.freeze = 0; }   // no sign of echo yet: do not learn from unrelated sound
      else if (this.conv < 6) { mu = this.muHi; this.freeze = 0; }
      else if (py > 4 * pe) { mu = this.conv > 15 ? this.muLo : this.muHi; this.freeze = 0; }
      else { mu = this.muDt; if (++this.freeze > 1200) { this.conv = 0; this.freeze = 0; } }   // 1200 blocks = about 9.6 s
      if (mu > this.muDt) this.conv += 0.1 * (10 * Math.log10((pd + eps) / (pe + eps)) - this.conv);
      this.erle = this.conv;
    }
    if (pe > 3 * pd + 1e-9 && far) { if (++this.bad > 20) { this.Wr.fill(0); this.Wi.fill(0); this.conv = 0; this.bad = 0; } } else this.bad = 0;
    if (mu === 0) return;

    // Proportionate step: blocks that already hold a lot of the echo path learn faster than empty ones. The power
    // used to normalise is weighted the same way, so the combined step is always mu: stable from the first block.
    const gains = this.gains || (this.gains = new Float64Array(P).fill(1)), Sg = this.Sg || (this.Sg = new Float64Array(K));
    if ((this.nb & 3) === 2) {   // which blocks hold the echo changes slowly: refresh the weights every fourth block
      let wSum = 0;
      for (let p = 0; p < P; p++) { let e = 0; const o = p * K; for (let k = 0; k < K; k++) e += this.Wr[o + k] * this.Wr[o + k] + this.Wi[o + k] * this.Wi[o + k]; this.wE[p] = e; wSum += e; }
      for (let p = 0; p < P; p++) gains[p] = P * ((1 - this.prop) / P + this.prop * (wSum > 1e-9 ? this.wE[p] / wSum : 1 / P));
    }
    Sg.fill(0);
    for (let p = 0; p < P; p++) { const xo = ((this.hp - p + P) % P) * K, gp = gains[p]; for (let k = 0; k < K; k++) Sg[k] += gp * (this.Xr[xo + k] * this.Xr[xo + k] + this.Xi[xo + k] * this.Xi[xo + k]); }
    let sMean = 0; for (let k = 0; k < K; k++) sMean += Sg[k]; sMean /= K;
    const floor = Math.max(1e-6, this.floorRel * sMean);   // keeps frequencies with almost no far-end energy from amplifying noise
    // Leak: a filter that is not being kept alive by real echo decays toward zero. Proportional to the step size, so
    // it is negligible while nearly frozen (double talk) and strong while learning.
    const leak = 1 - this.leakK * mu;
    for (let p = 0; p < P; p++) {
      const xo = ((this.hp - p + P) % P) * K, wo = p * K, gp = gains[p] * mu;
      for (let k = 0; k < K; k++) {
        const g = gp / (Sg[k] + floor), xr = this.Xr[xo + k], xi = this.Xi[xo + k];
        this.Wr[wo + k] = this.Wr[wo + k] * leak + g * (xr * this.Er[k] + xi * this.Ei[k]);
        this.Wi[wo + k] = this.Wi[wo + k] * leak + g * (xr * this.Ei[k] - xi * this.Er[k]);
      }
    }
    // keep filter blocks causal (taps only in the first B samples): a few per call, cycling through all
    for (let n = 0; n < this.CPB; n++) {
      const c = this.cblk = (this.cblk + 1) % P, wo = c * K;
      for (let k = 0; k < K; k++) { re[k] = this.Wr[wo + k]; im[k] = this.Wi[wo + k]; }
      for (let k = K; k < N; k++) { re[k] = re[N - k]; im[k] = -im[N - k]; }
      this.fft.run(re, im, true);
      for (let i = B; i < N; i++) { re[i] = 0; im[i] = 0; }
      this.fft.run(re, im, false);
      for (let k = 0; k < K; k++) { this.Wr[wo + k] = re[k]; this.Wi[wo + k] = im[k]; }
    }
  }
}

// 31-tap windowed-sinc low-pass (7 kHz at 48 kHz) used to go 48k -> 16k and back.
const RS_TAPS = 31, RS_H = (() => {
  const h = new Float64Array(RS_TAPS), fc = 7000 / 48000; let s = 0;
  for (let i = 0; i < RS_TAPS; i++) { const m = i - 15, x = 2 * Math.PI * fc * m; h[i] = (m === 0 ? 2 * fc : Math.sin(x) / (Math.PI * m)) * (0.42 - 0.5 * Math.cos((2 * Math.PI * i) / 30) + 0.08 * Math.cos((4 * Math.PI * i) / 30)); s += h[i]; }
  for (let i = 0; i < RS_TAPS; i++) h[i] /= s; return h;
})();

class Poly {   // streaming FIR with history
  constructor() { this.hist = new Float64Array(RS_TAPS - 1); }
  // decimate by 3: in.length = 3n -> out n
  decimate(inp, out) {
    const n = out.length, buf = new Float64Array(RS_TAPS - 1 + inp.length);
    buf.set(this.hist); buf.set(inp, RS_TAPS - 1);
    for (let m = 0; m < n; m++) { let a = 0; const t = RS_TAPS - 1 + 3 * m + 2; for (let j = 0; j < RS_TAPS; j++) a += RS_H[j] * buf[t - j]; out[m] = a; }
    this.hist.set(buf.subarray(buf.length - (RS_TAPS - 1)));
  }
  // interpolate by 3: in n -> out 3n
  interpolate(inp, out) {
    const n = inp.length, buf = new Float64Array(RS_TAPS - 1 + 3 * n);
    buf.set(this.hist);
    for (let m = 0; m < n; m++) buf[RS_TAPS - 1 + 3 * m] = 3 * inp[m];
    // only every third input is non-zero, so only taps j = t (mod 3) contribute
    for (let t = 0; t < 3 * n; t++) { let a = 0; for (let j = t % 3; j < RS_TAPS; j += 3) a += RS_H[j] * buf[RS_TAPS - 1 + t - j]; out[t] = a; }
    this.hist.set(buf.subarray(buf.length - (RS_TAPS - 1)));
  }
}

// Echo-cancels the 48 kHz mic in blocks of 384 samples (8 ms): total delay 384 + mdel samples.
class AecStage {
  constructor(mdel = 28) {
    this.mdel = mdel;
    this.aec = new Aec(); this.B48 = 384;
    this.dm = new Poly(); this.dr = new Poly(); this.up = new Poly();
    this.d16 = new Float64Array(128); this.x16 = new Float64Array(128); this.y16 = new Float64Array(128); this.yup = new Float64Array(384);
    this.micHist = new Float64Array(this.mdel);
  }
  wake() {
    this.aec.wake(); this.micHist.fill(0);
    for (const p of [this.dm, this.dr, this.up]) p.hist.fill(0);
  }
  process(mic, ref, out) {
    this.dm.decimate(mic, this.d16); this.dr.decimate(ref, this.x16);
    this.aec.block(this.d16, this.x16, this.y16);
    this.up.interpolate(this.y16, this.yup);
    // both filters delay by 15 samples; line the mic up with the echo estimate
    const comb = new Float64Array(this.mdel + 384); comb.set(this.micHist); comb.set(mic, this.mdel);
    const al = this.aec.alpha;
    for (let i = 0; i < 384; i++) out[i] = comb[i] - al * this.yup[i];
    this.micHist.set(comb.subarray(384));
  }
}

class Framer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.ch = o.channels || 1;
    this.N = 960;
    this.bufs = Array.from({ length: this.ch }, () => new Float32Array(this.N));
    this.pos = 0;
    this.gate = !!o.gate;
    this.thr = Math.pow(10, (o.threshold ?? -55) / 20);
    this.env = 0; this.hold = 0; this.g = this.gate ? 0 : 1;

    // Feedback suppressor (mono voice capture only).
    this.fb = !!o.feedback && this.ch === 1;
    this.fft = new Fft(FFT_N);
    this.ring = new Float32Array(FFT_N); this.ringPos = 0;
    this.frame = new Float32Array(FFT_N);
    this.pow = new Float32Array(FFT_N / 2 + 1);
    this.notches = [];            // active notch filters, most recent last
    this.cand = -1; this.count = 0;
    this.trigTimes = [];          // frame indices of recent detections
    this.frameNo = 0;
    this.guardDb = 0; this.guardLin = 1; this.lastTrig = -1e9;

    // Echo canceller (mono voice only): needs the playback signal on input 1.
    this.aec = o.aec && this.ch === 1 ? new AecStage(o.aecDelay) : null;
    if (this.aec) {
      this.aIn = new Float64Array(384); this.aRef = new Float64Array(384); this.aOut = new Float64Array(384);
      this.aPos = 0; this.aRead = 0;
    }
    this.aecOff = false;   // switched off from outside when this device cannot keep up
    // Idle (not talking): nothing is sent, so all processing is skipped and only the level is reported for the meter.
    this.active = o.active !== false;
    this.idleSum = 0; this.idleN = 0;
    this.port.onmessage = (e) => {
      if ('active' in e.data) {
        const on = !!e.data.active;
        if (on && !this.active) this.wake();
        this.active = on;
      }
      if ('aec' in e.data && this.aec) this.aecOff = !e.data.aec;
      if ('gate' in e.data) { this.gate = !!e.data.gate; if (!this.gate) this.g = 1; }
      if ('threshold' in e.data) this.thr = Math.pow(10, e.data.threshold / 20);
      if ('feedback' in e.data) this.fb = !!e.data.feedback && this.ch === 1;
    };
  }

  analyze() {
    // Unroll the ring buffer, oldest first.
    for (let i = 0; i < FFT_N; i++) this.frame[i] = this.ring[(this.ringPos + i) % FFT_N];
    const P = this.pow;
    this.fft.power(this.frame, P);
    const kMin = Math.ceil(250 / BIN_HZ), kMax = Math.floor(7500 / BIN_HZ);
    let k = kMin;
    for (let i = kMin; i <= kMax; i++) if (P[i] > P[k]) k = i;
    // Tone-to-surroundings ratio: peak against the average of bins 3..10 on either side.
    let sum = 0, n = 0;
    for (let d = 3; d <= 10; d++) { if (k - d >= 1) { sum += P[k - d]; n++; } if (k + d <= FFT_N / 2) { sum += P[k + d]; n++; } }
    const ratioDb = 10 * Math.log10((P[k] + 1e-20) / (sum / Math.max(n, 1) + 1e-20));
    // For a Hann window a tone of amplitude A gives |X| = A*N/4.
    const amp = (4 * Math.sqrt(P[k])) / FFT_N;
    const tonal = ratioDb > 20 && amp > 0.003;
    // A howl in a clipping loop wanders a few bins, so follow it rather than demanding one exact bin.
    if (tonal && Math.abs(k - this.cand) <= 4) { this.count++; this.cand = k; }
    else if (tonal) { this.cand = k; this.count = 1; }
    else this.count = Math.max(0, this.count - 2);

    if (this.count >= 12) {      // ~240 ms of the same tone
      this.count = 0;
      // Refine the frequency with parabolic interpolation on the log spectrum.
      const a = Math.log(P[k - 1] + 1e-20), b = Math.log(P[k] + 1e-20), c = Math.log(P[k + 1] + 1e-20);
      const off = 0.5 * (a - c) / (a - 2 * b + c || 1);
      const freq = (k + Math.max(-0.5, Math.min(0.5, off))) * BIN_HZ;
      if (!this.notches.some((nf) => Math.abs(nf.freq - freq) < 2 * BIN_HZ)) {
        this.notches.push(new Notch(freq, 18));
        if (this.notches.length > 10) this.notches.shift();
      } else {
        // Already notched yet still ringing: the loop is strong, so trim the send level too.
        this.guardDb = Math.max(-18, this.guardDb - 3);
        this.guardLin = Math.pow(10, this.guardDb / 20);
      }
      this.lastTrig = this.frameNo;
      this.trigTimes.push(this.frameNo);
      this.trigTimes = this.trigTimes.filter((t) => this.frameNo - t < 300);
      if (this.trigTimes.length >= 3) {   // several different howls within 6 s
        this.guardDb = Math.max(-18, this.guardDb - 3);
        this.guardLin = Math.pow(10, this.guardDb / 20);
        this.trigTimes = [];
      }
      this.port.postMessage({ feedback: { freq: Math.round(freq), notches: this.notches.length, guardDb: this.guardDb } });
    }
    // Recover the send level slowly once it has been quiet for 3 s.
    if (this.guardDb < 0 && this.frameNo - this.lastTrig > 150) {
      this.guardDb = Math.min(0, this.guardDb + 0.02);
      this.guardLin = Math.pow(10, this.guardDb / 20);
    }
  }

  // Starting to talk: begin from a clean slate (the learned echo filter is kept).
  wake() {
    this.pos = 0; this.env = 0; this.hold = 0; this.g = this.gate ? 0 : 1;
    if (this.aec) { this.aec.wake(); this.aPos = 0; this.aRead = 0; this.aOut.fill(0); }
  }

  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const n = inp[0].length;
    if (!this.active) {
      const x = inp[0];
      for (let i = 0; i < n; i++) this.idleSum += x[i] * x[i];
      this.idleN += n;
      if (this.idleN >= this.N) { this.port.postMessage({ level: Math.sqrt(this.idleSum / this.idleN) }); this.idleSum = 0; this.idleN = 0; }
      return true;
    }
    for (let i = 0; i < n; i++) {
      let peak = 0;
      const xs = [];
      for (let c = 0; c < this.ch; c++) {
        let v = inp[Math.min(c, inp.length - 1)][i];
        if (this.aec && !this.aecOff) {
          // Echo cancellation works in 384-sample blocks, so the mic is delayed by about 9 ms.
          const ref = inputs[1] && inputs[1].length ? (inputs[1].length > 1 ? 0.5 * (inputs[1][0][i] + inputs[1][1][i]) : inputs[1][0][i]) : 0;
          const o = this.aOut[this.aRead++];
          this.aIn[this.aPos] = v; this.aRef[this.aPos] = ref;
          if (++this.aPos === 384) { this.aec.process(this.aIn, this.aRef, this.aOut); this.aPos = 0; this.aRead = 0; }
          v = o;
        }
        if (this.fb) {
          this.ring[this.ringPos] = v; this.ringPos = (this.ringPos + 1) % FFT_N;   // analyse the raw mic
          for (let k = 0; k < this.notches.length; k++) v = this.notches[k].run(v);
          v *= this.guardLin;
        }
        xs.push(v);
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      if (this.gate) {
        this.env = peak > this.env ? peak : this.env * 0.9995;
        if (this.env > this.thr) this.hold = 9600; // keep open 200 ms after speech
        else if (this.hold > 0) this.hold--;
        const target = this.hold > 0 ? 1 : 0;
        this.g += (target - this.g) * (target > this.g ? 0.02 : 0.003);
      }
      for (let c = 0; c < this.ch; c++) this.bufs[c][this.pos] = xs[c] * this.g;
      if (++this.pos === this.N) {
        this.pos = 0;
        this.frameNo++;
        if (this.fb) this.analyze();
        if (this.aec && !this.aecOff && this.frameNo % 25 === 0) this.port.postMessage({ aec: Math.round(this.aec.aec.erle) });
        let sum = 0;
        const b0 = this.bufs[0];
        for (let k = 0; k < this.N; k++) sum += b0[k] * b0[k];
        const level = Math.sqrt(sum / this.N);
        const silent = this.gate && this.hold === 0 && this.g < 0.002;
        if (silent) {
          this.port.postMessage({ silent: true, level: 0 });
        } else {
          const out = new Float32Array(this.N * this.ch);
          for (let c = 0; c < this.ch; c++) out.set(this.bufs[c], c * this.N);
          this.port.postMessage({ frame: out, level }, [out.buffer]);
        }
      }
    }
    return true;
  }
}
registerProcessor('ns-framer', Framer);
