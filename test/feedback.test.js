// Numerical test of the feedback suppressor in web/worklet.js. Run: node test/feedback.test.js
const assert = require('assert');
let Ctor;
global.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {}, onmessage: null }; } };
global.registerProcessor = (_n, c) => { Ctor = c; };
require('../web/worklet.js');

function make(opts) {
  const p = new Ctor({ processorOptions: opts });
  const st = { out: [], events: [] };
  p.port.postMessage = (m) => { if (m.frame) st.out.push(...m.frame); if (m.feedback) st.events.push(m.feedback); };
  return { p, st };
}
const rms = (a, s, e) => { let t = 0; for (let i = s; i < e; i++) t += a[i] * a[i]; return Math.sqrt(t / (e - s)); };
const db = (x) => 20 * Math.log10(x + 1e-12);

// Speech-like source: gliding pitch, decaying harmonics, 4 Hz syllable envelope, a little noise.
function speech(n, f0Fn) {
  const out = new Float32Array(n); const ph = new Float64Array(25); let seed = 1;
  for (let i = 0; i < n; i++) {
    const t = i / 48000, f0 = f0Fn(t); let s = 0;
    for (let h = 1; h <= 24; h++) { ph[h] += (2 * Math.PI * f0 * h) / 48000; s += Math.sin(ph[h]) / h * (1 + 2 * Math.exp(-Math.pow((f0 * h - 700) / 400, 2))); }
    seed = (seed * 16807) % 2147483647;
    out[i] = 0.12 * s * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t)) + 0.002 * (seed / 2147483647 - 0.5);
  }
  return out;
}

// Room + speaker: resonance near 1.8 kHz with gain 1.6 (loop gain > 1), 125 ms round trip, speaker clipping.
function runLoop(feedback, seconds) {
  const { p, st } = make({ channels: 1, gate: false, feedback });
  const N = seconds * 48000, D = 6000, v = speech(N, (t) => 120 + 25 * Math.sin(2 * Math.PI * 0.7 * t));
  const w = (2 * Math.PI * 1800) / 48000, Q = 6, al = Math.sin(w) / (2 * Q), a0 = 1 + al;
  const b0 = al / a0, b2 = -al / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const mic = new Float32Array(128);
  for (let n0 = 0; n0 + 128 <= N; n0 += 128) {
    for (let i = 0; i < 128; i++) {
      const n = n0 + i, played = n - D >= 0 && n - D < st.out.length ? st.out[n - D] : 0;
      const bp = b0 * played + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = played; y2 = y1; y1 = bp;
      mic[i] = v[n] + Math.tanh(1.6 * bp * 6 + 0.15 * played);   // *6 restores the filter's peak gain to ~1
    }
    p.process([[mic]]);
  }
  return st;
}

const off = runLoop(false, 10), on = runLoop(true, 10);
const tail = (s) => { const a = s.out; let m = 0; for (let i = a.length - 3 * 48000; i < a.length; i++) m = Math.max(m, Math.abs(a[i])); return m; };
console.log(`loop gain>1, no suppressor : peak over last 3 s = ${tail(off).toFixed(2)} (${db(rms(off.out, off.out.length - 144000, off.out.length)).toFixed(1)} dBFS rms)`);
console.log(`loop gain>1, suppressor ON  : peak over last 3 s = ${tail(on).toFixed(2)} (${db(rms(on.out, on.out.length - 144000, on.out.length)).toFixed(1)} dBFS rms); notches at ${on.events.map((e) => e.freq + 'Hz').join(', ')}`);
assert(tail(off) > 0.6, 'sanity: the loop must really howl without the suppressor');
assert(tail(on) < 0.35 && tail(on) < tail(off) / 2, 'suppressor must keep the loop from howling');
assert(on.events.length > 0 && on.events.length <= 12, 'should find the howl without notch spam');

// Normal speech, no loop: level and tone must be essentially unchanged, and no false alarms.
const sp = speech(48000 * 8, (t) => 110 + 40 * Math.sin(2 * Math.PI * 0.5 * t) + 20 * Math.sin(2 * Math.PI * 1.3 * t));
const a = make({ channels: 1, gate: false, feedback: true });
const blk = new Float32Array(128);
for (let n0 = 0; n0 + 128 <= sp.length; n0 += 128) { blk.set(sp.subarray(n0, n0 + 128)); a.p.process([[blk]]); }
const delta = Math.abs(db(rms(a.st.out, 48000, a.st.out.length)) - db(rms(sp, 48000, a.st.out.length)));
console.log(`plain speech: level change ${delta.toFixed(2)} dB, false feedback detections: ${a.st.events.length}`);
assert(delta < 0.5, 'speech level must not change');
assert(a.st.events.length === 0, 'no false detections on speech');

// A sustained steady vowel (constant pitch) is the hardest case for false positives.
const vow = speech(48000 * 3, () => 220);
const b = make({ channels: 1, gate: false, feedback: true });
for (let n0 = 0; n0 + 128 <= vow.length; n0 += 128) { blk.set(vow.subarray(n0, n0 + 128)); b.p.process([[blk]]); }
const vd = Math.abs(db(rms(b.st.out, 24000, b.st.out.length)) - db(rms(vow, 24000, b.st.out.length)));
console.log(`steady 220 Hz vowel: level change ${vd.toFixed(2)} dB, detections: ${b.st.events.length}`);
assert(vd < 1.5, 'a held vowel must stay audible');
console.log('OK');
