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

    this.port.onmessage = (e) => {
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

  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      const xs = [];
      for (let c = 0; c < this.ch; c++) {
        let v = inp[Math.min(c, inp.length - 1)][i];
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
