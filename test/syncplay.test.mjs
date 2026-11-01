// Simulates devices with different networks, clock errors and sound-card drift all playing the same feed.
// Run: node test/syncplay.test.mjs
import assert from 'node:assert';
import { ClockSync, SyncPlayout, stretch } from '../web/syncplay.js';
import { execFileSync } from 'node:child_process';

let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const SR = 48000, N = 960;

// ---- 1. clock offset measurement -------------------------------------------------------------------------
function measure({ up, down, jitter, P = 5000 }) {
  const cs = new ClockSync(); let w = 1000;
  const ping = () => {
    const sent = w - P;                                           // device performance.now() = world - P
    const toServer = up + jitter * rnd(), back = down + jitter * rnd();
    const serverMs = w + toServer;                                // server clock = world
    const recvWorld = w + toServer + back;
    cs.add(sent, serverMs, recvWorld - P);
    w = recvWorld;
  };
  for (let i = 0; i < 8; i++) { ping(); w += 150; }
  for (let i = 0; i < 12; i++) { ping(); w += 5000; }
  return { err: cs.offset - P, bound: cs.uncertaintyMs };   // true (server - perf) offset is P
}
const sym = measure({ up: 40, down: 40, jitter: 30 });
const asym = measure({ up: 20, down: 80, jitter: 30 });
console.log(`1. clock sync: symmetric 40/40 ms path -> error ${sym.err.toFixed(1)} ms; cellular-like 20 up / 80 down -> error ${asym.err.toFixed(1)} ms (limit is half the round trip = ${asym.bound.toFixed(0)} ms)`);
assert(Math.abs(sym.err) < 4, 'symmetric paths sync to a few ms');
assert(Math.abs(asym.err) <= asym.bound + 1, 'error never exceeds half the round trip');

// ---- 2. several devices, one stream ----------------------------------------------------------------------
const D = 350;                                                   // fixed listener delay, ms
function simulate(devices, seconds = 600) {
  const out = devices.map((d) => { const m = measure({ up: d.net, down: d.net, jitter: d.jit, P: d.P }); return { ...d, est: d.P + m.err, e: m.err, pl: new SyncPlayout(SR), times: [], slips: 0 }; });
  const count = Math.floor(seconds / 0.02);
  for (let i = 0; i < count; i++) {
    const emit = 5000 + i * 20;                                  // server clock = world ms; stamp = emit
    for (const d of out) {
      const stall = (d.stall && i % 1500 > 1480 ? 400 : 0) + (d.stallEarly && i < 1500 && i % 100 > 94 ? 450 : 0);       // an occasional 400 ms network stall
      const arrive = emit + d.net + d.jit * rnd() + stall;
      // (ctx, perf) pair at the moment of arrival: ctx = seconds on the audio clock, perf = ms
      const ctxAt = (W) => (W - d.T0) / 1000 * (1 + d.ppm * 1e-6), perfAt = (W) => W - d.P;
      const ctxRef = ctxAt(arrive), perfRef = perfAt(arrive);
      const desired = ctxRef + ((emit + D) - d.est - perfRef) / 1000 + ((d.noise || 0) * (rnd() - 0.5)) / 1000;   // coarse output-clock readings on phones
      const r = d.pl.plan(desired, ctxRef, N);
      if (r.drop) { d.times.push(null); continue; }
      if (r.slip) d.slips++;
      d.times.push(d.T0 + r.when * 1000 / (1 + d.ppm * 1e-6)); // world time at which this chunk sounds
    }
  }
  return out;
}
const spread = (devs, skip = 150) => { let worst = 0, n = 0; const len = devs[0].times.length;
  for (let i = skip; i < len; i++) { const t = devs.map((d) => d.times[i]).filter((x) => x !== null); if (t.length < 2) continue; worst = Math.max(worst, Math.max(...t) - Math.min(...t)); n++; } return worst; };

const devs = simulate([
  { net: 10, jit: 10, P: 12345, T0: 100, ppm: 120 },
  { net: 30, jit: 15, P: -777, T0: 5000, ppm: -80 },
  { net: 60, jit: 20, P: 98765, T0: 1, ppm: 0 },
]);
const es = devs.map((d) => d.e), eSpread = Math.max(...es) - Math.min(...es);
const worst = spread(devs);
console.log(`2. three devices (10/30/60 ms networks, clocks +120/-80/0 ppm), 10 min: devices' clock-estimate errors ${es.map((e) => e.toFixed(1)).join(', ')} ms`);
console.log(`   worst moment-to-moment disagreement between devices: ${worst.toFixed(2)} ms (clock-estimate spread ${eSpread.toFixed(2)} ms); drops: ${devs.map((d) => d.pl.stats.drops)}, sample corrections: ${devs.map((d) => d.slips)}`);
assert(devs.every((d) => d.pl.stats.drops === 0), 'nothing may be late when the delay exceeds every path');
assert(worst <= eSpread + 2.0, 'devices may only disagree by their clock-measurement error');

// A device with 400 ms network stalls skips what it missed and resumes in step; everyone else stays aligned.
const devs2 = simulate([
  { net: 10, jit: 10, P: 1, T0: 100, ppm: 50 },
  { net: 30, jit: 15, P: 2, T0: 7, ppm: -60, stall: true },
  { net: 60, jit: 20, P: 3, T0: 999, ppm: 20 },
], 300);
const ok = [devs2[0], devs2[2]];
const w2 = spread(ok), e2 = Math.max(...ok.map((d) => d.e)) - Math.min(...ok.map((d) => d.e));
console.log(`3. one device suffers 400 ms stalls: it skips ${devs2[1].pl.stats.skipped} late chunks and resumes in step (extra delay ${(devs2[1].pl.extra * 1000).toFixed(0)} ms); the other two still disagree by only ${w2.toFixed(2)} ms`);
assert(w2 <= e2 + 1.0 && devs2[1].pl.stats.drops === 0 && ok.every((d) => d.pl.stats.drops === 0));
assert(devs2[1].pl.extra === 0, 'a blip must not leave extra delay behind');

// A phone reports its output clock coarsely (+/- 8 ms of noise per reading): playback must stay smooth, not jump or warble.
const devs3 = simulate([{ net: 30, jit: 10, P: 11, T0: 50, ppm: 40, noise: 16 }, { net: 50, jit: 10, P: 22, T0: 80, ppm: -40, noise: 16 }], 600);
const stats3 = devs3.map((d) => d.pl.stats), chunks3 = devs3[0].times.length;
console.log(`4. noisy clock readings (+/-8 ms), 10 min: jumps ${stats3.map((s) => s.reanchors)}, skipped ${stats3.map((s) => s.drops)}, chunks nudged ${devs3.map((d) => (100 * d.slips / chunks3).toFixed(1) + '%')}`);
assert(stats3.every((s) => s.reanchors === 0 && s.drops === 0), 'noise must not cause jumps or skips');
assert(devs3.every((d) => d.slips / chunks3 < 0.2), 'noise must not make the player warble constantly');

// A network slower than the fixed delay (500 ms path, 350 ms delay): audio keeps playing, just not in lockstep with the others.
const devs4 = simulate([{ net: 500, jit: 40, P: 5, T0: 1, ppm: 0 }], 120);
const gapsMs = (() => { const t = devs4[0].times.filter((x) => x !== null); let g = 0; for (let i = 1; i < t.length; i++) { const gap = t[i] - t[i - 1] - 20; if (gap > 2) g += gap; } return g; })();
console.log(`5. network slower than the delay (500 ms vs 350 ms): skipped ${devs4[0].pl.stats.drops} chunks, total silence ${gapsMs.toFixed(0)} ms over 2 min, extra local cushion ${(devs4[0].pl.extra * 1000).toFixed(0)} ms, ${devs4[0].pl.stats.skipped} chunks skipped before it settled`);
assert(devs4[0].pl.stats.drops === 0, 'slow networks must degrade to late playback, not skipping');
assert(gapsMs < 6000, 'and the audio must stay smooth (under 5% silence)');

// A device that fell behind after stalls must catch up with the others once its network is good again.
const devs5 = simulate([
  { net: 10, jit: 10, P: 1, T0: 100, ppm: 50 },
  { net: 30, jit: 15, P: 2, T0: 7, ppm: -60, stallEarly: true },
], 240);
const lagAfterStalls = devs5[1].pl.stats.dry;
const tail = (devs) => { let worst = 0; const len = devs[0].times.length; for (let i = len - 1000; i < len; i++) { const t = devs.map((d) => d.times[i]).filter((x) => x !== null); if (t.length === 2) worst = Math.max(worst, Math.max(...t) - Math.min(...t)); } return worst; };
const e5 = Math.abs(devs5[0].e - devs5[1].e);
console.log(`7. catching up: the stalled device ran dry ${lagAfterStalls}x early on; four minutes later its extra delay is ${(devs5[1].pl.extra * 1000).toFixed(1)} ms and it differs from the other device by ${tail(devs5).toFixed(2)} ms`);
assert(lagAfterStalls > 0, 'the scenario must actually make it fall behind');
assert(devs5[1].pl.extra < 0.002, 'extra delay must be handed back after things are quiet');
assert(tail(devs5) <= e5 + 2.0, 'and it must be back in step with the other device');

// What happens after a blip? One 460 ms network stall (its audio arrives in a burst), then clean. The device must skip what
// it missed and carry on exactly in step: no extra delay, no speeding up to make up for it.
{
  const pl = new SyncPlayout(SR), dt = N / SR; let maxSpeedup = 0, worstAfter = 0, firstOnTime = null;
  for (let i = 0; i < 1500; i++) {
    const due = 5 + i * dt + D / 1000, sent = 5 + i * dt;
    const stalled = i >= 500 && i < 523;                        // chunks 500..522 are held up, then arrive together
    const arrive = stalled ? 5 + 500 * dt + 0.46 : sent + 0.02;
    const r = pl.plan(due, arrive, N);
    if (r.slip < 0) maxSpeedup = Math.max(maxSpeedup, -r.slip / N);
    if (!r.drop && i >= 500) { if (firstOnTime === null) firstOnTime = i; worstAfter = Math.max(worstAfter, Math.abs(r.when - due)); }
  }
  console.log(`8. blip of 460 ms: ran dry ${pl.stats.dry}x, skipped ${pl.stats.skipped} late chunks, then played exactly on time (worst error ${(worstAfter * 1000).toFixed(1)} ms), extra delay ${(pl.extra * 1000).toFixed(0)} ms, fastest playback +${(maxSpeedup * 100).toFixed(1)}%`);
  assert(pl.stats.dry > 0 && pl.stats.skipped > 0, 'the blip must actually run the buffer dry');
  assert(pl.extra === 0, 'no extra delay may be left behind');
  assert(worstAfter < 0.005, 'after the skip it must be exactly in step again');
  assert(maxSpeedup < 0.015, 'and it must not speed up to catch up');
}

// ---- pitch lock while catching up ---------------------------------------------------------------------------
// A device 300 ms behind catches up over several seconds. Feed it real audio and measure the pitch of what it plays.
function catchUp(sig, usePlanes) {
  const pl = new SyncPlayout(SR); pl.extra = 0.3;
  const out = []; let removed = 0, maxStep = 0;
  for (let i = 0; i + N <= sig.length; i++) {
    const chunk = sig.subarray(i * N, (i + 1) * N);
    if (chunk.length < N) break;
    const planes = [Float32Array.from(chunk), Float32Array.from(chunk)];
    const due = 5 + i * (N / SR) + 0.35, now = 5 + i * (N / SR) + 0.02;
    const r = pl.plan(due, now, N, usePlanes ? planes : undefined);
    let base = r.planes || planes;
    if (r.slip) base = base.map((p) => stretch(p, p.length + r.slip));
    removed += N - base[0].length; out.push(base[0]);
  }
  const y = new Float32Array(out.reduce((a, c) => a + c.length, 0)); let o = 0; for (const c of out) { y.set(c, o); o += c.length; }
  for (let i = 2; i < y.length; i++) maxStep = Math.max(maxStep, Math.abs(y[i] - 2 * y[i - 1] + y[i - 2]));
  return { y, removed, stats: pl.stats, maxStep, extraLeft: pl.extra };
}
// median pitch of the voiced frames (autocorrelation), 80-400 Hz
function medianPitch(y) {
  const W = 2048, f = [];
  for (let s = 0; s + W <= y.length; s += 1024) {
    let e0 = 0; for (let i = 0; i < W; i++) e0 += y[s + i] * y[s + i];
    if (e0 < 1e-3) continue;
    let best = 0, bl = 0; const ac = [];
    for (let l = Math.floor(SR / 400); l <= Math.floor(SR / 80); l++) { let a = 0, b = 0; for (let i = 0; i + l < W; i++) { a += y[s + i] * y[s + i + l]; b += y[s + i + l] * y[s + i + l]; } const v = a / Math.sqrt(e0 * b + 1e-12); ac[l] = v; if (v > best) { best = v; bl = l; } }
    if (best < 0.6) continue;
    const a0 = ac[bl - 1] ?? best, a2 = ac[bl + 1] ?? best, den = a0 - 2 * best + a2, d = den ? 0.5 * (a0 - a2) / den : 0;
    f.push(SR / (bl + d));
  }
  f.sort((p, q) => p - q); return f.length ? f[f.length >> 1] : NaN;
}
const synth = (secs, fn) => Float32Array.from({ length: Math.floor(SR * secs) }, (_, i) => fn(i / SR));
const voice = synth(10, (t) => { let v = 0; for (let k = 1; k <= 10; k++) v += Math.sin(2 * Math.PI * 140 * k * t) / k; return 0.25 * v * (0.8 + 0.2 * Math.sin(2 * Math.PI * 3 * t)); });
{
  const a = catchUp(voice, true), b = catchUp(voice, false);
  const f0 = medianPitch(voice), fa = medianPitch(a.y.subarray(SR)), fb = medianPitch(b.y.subarray(SR));
  console.log(`9. pitch lock, voice-like tone (140 Hz): input ${f0.toFixed(2)} Hz; pitch-locked catch-up ${fa.toFixed(2)} Hz (${((fa / f0 - 1) * 100).toFixed(2)}%), ${a.stats.splices} cuts, ${(a.removed / SR * 1000).toFixed(0)} ms removed; plain squeeze ${fb.toFixed(2)} Hz (${((fb / f0 - 1) * 100).toFixed(2)}%)`);
  const sm = (y) => { let m = 0; for (let i = 2; i < y.length; i++) m = Math.max(m, Math.abs(y[i] - 2 * y[i - 1] + y[i - 2])); return m; };
  assert(Math.abs(fa / f0 - 1) < 0.004, 'pitch must be unchanged while catching up');
  assert(Math.abs(fb / f0 - 1) > 0.03, 'sanity: the squeeze does change the pitch');
  assert(a.stats.splices > 10 && a.extraLeft < 0.002, 'it must actually catch up');
  assert(a.maxStep < sm(voice) * 1.5, 'the cuts must not click');
}
// real synthesised speech, if ffmpeg has flite
try {
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', "flite=text='The quick brown fox jumps over the lazy dog. Program audio should keep its natural pitch while it catches up. One two three four five six seven eight nine ten.':voice=slt", '-ar', '48000', '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const sp = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
  const a = catchUp(sp, true), b = catchUp(sp, false), f0 = medianPitch(sp);
  console.log(`10. pitch lock, real speech: input ${f0.toFixed(1)} Hz; pitch-locked ${medianPitch(a.y).toFixed(1)} Hz (${((medianPitch(a.y) / f0 - 1) * 100).toFixed(2)}%), cuts ${a.stats.splices}, fell back to squeezing ${a.stats.spliceFallbacks}x; plain squeeze ${medianPitch(b.y).toFixed(1)} Hz (${((medianPitch(b.y) / f0 - 1) * 100).toFixed(2)}%)`);
  assert(Math.abs(medianPitch(a.y) / f0 - 1) < 0.015, 'speech pitch must stay put');
} catch (e) { if (e.code === 'ERR_ASSERTION') throw e; console.log('10. (speech check skipped: ffmpeg with flite not available)'); }
// music-like: three unrelated tones, no single cycle to cut. It may fall back to squeezing; it must still catch up.
{
  const chord = synth(10, (t) => 0.15 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.18 * t) + Math.sin(2 * Math.PI * 329.63 * t)));
  const a = catchUp(chord, true);
  console.log(`11. chord (no single cycle): ${a.stats.splices} clean cuts, ${a.stats.spliceFallbacks} fallbacks to squeezing; still caught up: extra left ${(a.extraLeft * 1000).toFixed(1)} ms`);
  assert(a.extraLeft < 0.002, 'must catch up even when no clean cut exists');
}

// ---- 3. interpolation quality ---------------------------------------------------------------------------
const err = (f, m) => { const x = Float32Array.from({ length: N }, (_, i) => Math.sin(2 * Math.PI * f * i / SR)); const y = stretch(x, m); let e = 0, s = (N - 1) / (m - 1);
  for (let j = 4; j < m - 4; j++) e = Math.max(e, Math.abs(y[j] - Math.sin(2 * Math.PI * f * j * s / SR))); return e; };
const e1 = err(1000, N - 1), e10 = err(10000, N + 8);
console.log(`6. sample correction accuracy (max error vs ideal): 1 kHz ${e1.toExponential(1)}, 10 kHz ${e10.toExponential(1)}`);
assert(e1 < 1e-3 && e10 < 0.02);
console.log('OK');
