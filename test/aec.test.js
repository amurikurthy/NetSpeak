// Numerical test of the echo canceller in web/worklet.js, using real synthesised speech (ffmpeg's flite voices).
// Run: node test/aec.test.js     (skips itself if ffmpeg has no flite)
const assert = require('assert');
const { execFileSync } = require('child_process');
let Ctor;
global.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {}, onmessage: null }; } };
global.registerProcessor = (_n, c) => { Ctor = c; };
require('../web/worklet.js');

const SR = 48000;
function voice(text, name) {
  const b = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `flite=text='${text}':voice=${name}`, '-ar', '48000', '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}
const norm = (a, rms) => { let s = 0; for (const v of a) s += v * v; const g = rms / Math.sqrt(s / a.length); return a.map((v) => v * g); };
let far, nearVoice;
try {
  const t1 = 'The quick brown fox jumps over the lazy dog. We need the second camera on the stage left now. Please check the program feed levels before the show starts. Standing by for the next cue, everyone listen carefully to the director.';
  const t2 = 'Copy that, camera two is ready. I can hear a slight delay on the program feed. Can someone confirm the audio is in sync. Moving to position now, tell me when you are live.';
  far = norm(voice(`${t1} ${t1} ${t1}`, 'kal16'), 0.1); nearVoice = norm(voice(`${t2} ${t2} ${t2} ${t2}`, 'slt'), 0.1);
} catch (e) { console.log('SKIPPED: ffmpeg with flite speech synthesis is not available'); process.exit(0); }

let seed = 5; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
// A small-room echo path: direct sound after 70 ms plus reflections (ms, gain).
const TAPS = [[70, 0.45], [71.5, -0.22], [75, 0.18], [84, 0.12], [97, -0.09], [120, 0.07], [160, 0.04]];
function echoOf(x, shiftMs = 0, drift = 0) {
  const e = new Float32Array(x.length);
  for (const [ms, g] of TAPS) { const d = Math.round((ms + shiftMs) * SR / 1000); for (let i = d; i < x.length; i++) e[i] += g * x[i - d]; }
  if (!drift) return e;
  const o = new Float32Array(x.length); for (let i = 0; i < x.length - 2; i++) { const p = i * (1 + drift), a = Math.floor(p), f = p - a; o[i] = e[a] * (1 - f) + e[a + 1] * f; } return o;
}
const db = (x) => 10 * Math.log10(x + 1e-20);
const pw = (a, s, e) => { let t = 0; for (let i = s; i < e; i++) t += a[i] * a[i]; return t / (e - s); };
function run(mic, ref) {
  const p = new Ctor({ processorOptions: { channels: 1, gate: false, feedback: false, aec: true } });
  const out = []; p.port.postMessage = (m) => { if (m.frame) out.push(...m.frame); };
  const a = new Float32Array(128), b = new Float32Array(128); const t0 = process.hrtime.bigint();
  for (let n = 0; n + 128 <= mic.length; n += 128) { a.set(mic.subarray(n, n + 128)); b.set(ref.subarray(n, n + 128)); p.process([[a], [b]]); }
  return { out: Float32Array.from(out), ms: Number(process.hrtime.bigint() - t0) / 1e6 / (mic.length / SR) };
}
const D = 384 + 28;   // the canceller's fixed delay (one 8 ms block plus resampler delay)
const N = SR * 40, x = far.subarray(0, N);
const noise = () => Float32Array.from({ length: N }, () => 0.0008 * rnd());
const erleOf = (mic, r) => (s, e) => { const e2 = Math.min(e * SR, r.out.length - D - 1); return db(pw(mic, s * SR, e2) / pw(r.out, s * SR + D, e2 + D)); };

// 1. far end only
let nz = noise(), mic = echoOf(x).map((v, i) => v + nz[i]);
let r = run(mic, x); let erle = erleOf(mic, r);
console.log(`1. one talker playing, echo into the mic: removed ${erle(2, 6).toFixed(1)} dB at 2-6 s, ${erle(10, 15).toFixed(1)} dB at 10-15 s, ${erle(30, 40).toFixed(1)} dB at 30-40 s   (CPU: ${r.ms.toFixed(0)} ms per second of audio)`);
assert(erle(30, 40) > 20, 'once converged the echo must drop by 20 dB or more');
assert(erle(2, 6) > 4, 'it must already help in the first seconds');
assert(r.ms < 150, 'must be cheap enough for a phone');

// 2. a near-end talker (a different voice) joins at 20 s while the far end keeps talking
const nearAll = nearVoice.subarray(0, N).map((v, i) => (i > SR * 20 ? v : 0));
nz = noise(); mic = echoOf(x).map((v, i) => v + nearAll[i] + nz[i]); r = run(mic, x); erle = erleOf(mic, r);
let err = 0, sig = 0; for (let i = SR * 22; i < SR * 38; i++) { const d = r.out[i + D] - nearAll[i]; err += d * d; sig += nearAll[i] * nearAll[i]; }
// reference: what the near-end signal would look like if we did nothing but remove the echo perfectly = just nearAll; so "err" is echo residue + damage
const sdr = db(sig / err);
console.log(`2. second talker joins at 20 s (double talk): their voice comes through ${sdr.toFixed(1)} dB above (echo leftover + damage); echo-only part after: ${erle(0, 20).toFixed(1)} dB over 0-20 s`);
assert(sdr > 15, 'the near-end talker must come through intact');

// 3. the room changes at 14 s (echo 45 ms later): it must re-learn (slowly: it cannot tell this apart from a talker at first)
nz = noise(); const e1 = echoOf(x), e2 = echoOf(x, 45); mic = e1.map((v, i) => (i < SR * 14 ? v : e2[i]) + nz[i]); r = run(mic, x); erle = erleOf(mic, r);
console.log(`3. echo path changes at 14 s: ${erle(10, 14).toFixed(1)} dB just before, ${erle(15, 18).toFixed(1)} dB right after, ${erle(35, 40).toFixed(1)} dB at the end`);
assert(erle(35, 40) > 12, 'must adapt to a changed room');

// 4. playback and capture clocks differ by 100 ppm
nz = noise(); mic = echoOf(x, 0, 100e-6).map((v, i) => v + nz[i]); r = run(mic, x); erle = erleOf(mic, r);
console.log(`4. clock mismatch 100 ppm: ${erle(30, 40).toFixed(1)} dB at 30-40 s`);
assert(erle(30, 40) > 12, 'must tolerate a small clock mismatch');

// 6. earbuds: something is playing but none of it reaches the mic (no echo at all). The canceller must not harm the voice.
{
  const nearOnly = nearVoice.subarray(0, N); nz = noise(); mic = nearOnly.map((v, i) => v + nz[i]); r = run(mic, x);
  let a2 = 0, b2 = 0; for (let i = SR * 5; i < SR * 38; i++) { const d = r.out[i + D] - mic[i]; a2 += d * d; b2 += mic[i] * mic[i]; }
  const damage = db(b2 / a2);
  console.log(`6. earbuds (playing, no echo in the mic): voice vs output differ by ${(-damage).toFixed(1)} dB (more negative is better)`);
  assert(damage > 20, 'with no echo present the canceller must leave the voice alone');
}

// 5. nothing playing: the mic passes through unchanged (apart from the fixed delay)
const talk = nearVoice.subarray(0, SR * 8), quiet = new Float32Array(talk.length); r = run(talk, quiet);
let dd = 0; for (let i = SR; i < SR * 7; i++) dd += Math.abs(r.out[i + D] - talk[i]);
console.log(`5. nothing playing: mic passes through, mean difference ${(dd / (SR * 6)).toExponential(1)}`);
assert(dd / (SR * 6) < 5e-4, 'must not alter the mic when nothing is playing');
console.log('OK');
