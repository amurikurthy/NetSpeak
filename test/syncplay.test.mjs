// Simulates devices with different networks, clock errors and sound-card drift all playing the same feed.
// Run: node test/syncplay.test.mjs
import assert from 'node:assert';
import { ClockSync, SyncPlayout, stretch } from '../web/syncplay.js';

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
const D = 100;                                                   // fixed listener delay, ms
function simulate(devices, seconds = 600) {
  const out = devices.map((d) => { const m = measure({ up: d.net, down: d.net, jitter: d.jit, P: d.P }); return { ...d, est: d.P + m.err, e: m.err, pl: new SyncPlayout(SR), times: [], slips: 0 }; });
  const count = Math.floor(seconds / 0.02);
  for (let i = 0; i < count; i++) {
    const emit = 5000 + i * 20;                                  // server clock = world ms; stamp = emit
    for (const d of out) {
      const stall = d.stall && i % 1500 > 1480 ? 400 : 0;       // an occasional 400 ms network stall
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

// A device with 400 ms network stalls plays that audio late instead of skipping it; everyone else stays aligned.
const devs2 = simulate([
  { net: 10, jit: 10, P: 1, T0: 100, ppm: 50 },
  { net: 30, jit: 15, P: 2, T0: 7, ppm: -60, stall: true },
  { net: 60, jit: 20, P: 3, T0: 999, ppm: 20 },
], 300);
const ok = [devs2[0], devs2[2]];
const w2 = spread(ok), e2 = Math.max(...ok.map((d) => d.e)) - Math.min(...ok.map((d) => d.e));
console.log(`3. one device suffers 400 ms stalls: it skips ${devs2[1].pl.stats.drops} chunks (late audio is played, not skipped); the other two still disagree by only ${w2.toFixed(2)} ms`);
assert(w2 <= e2 + 1.0 && devs2[1].pl.stats.drops === 0 && ok.every((d) => d.pl.stats.drops === 0));

// A phone reports its output clock coarsely (+/- 8 ms of noise per reading): playback must stay smooth, not jump or warble.
const devs3 = simulate([{ net: 30, jit: 10, P: 11, T0: 50, ppm: 40, noise: 16 }, { net: 50, jit: 10, P: 22, T0: 80, ppm: -40, noise: 16 }], 600);
const stats3 = devs3.map((d) => d.pl.stats), chunks3 = devs3[0].times.length;
console.log(`4. noisy clock readings (+/-8 ms), 10 min: jumps ${stats3.map((s) => s.reanchors)}, skipped ${stats3.map((s) => s.drops)}, chunks nudged ${devs3.map((d) => (100 * d.slips / chunks3).toFixed(1) + '%')}`);
assert(stats3.every((s) => s.reanchors === 0 && s.drops === 0), 'noise must not cause jumps or skips');
assert(devs3.every((d) => d.slips / chunks3 < 0.2), 'noise must not make the player warble constantly');

// A network slower than the fixed delay (150 ms path, 100 ms delay): audio keeps playing, just not in lockstep with the others.
const devs4 = simulate([{ net: 150, jit: 30, P: 5, T0: 1, ppm: 0 }], 120);
const gapsMs = (() => { const t = devs4[0].times.filter((x) => x !== null); let g = 0; for (let i = 1; i < t.length; i++) { const gap = t[i] - t[i - 1] - 20; if (gap > 2) g += gap; } return g; })();
console.log(`5. network slower than the delay (150 ms vs 100 ms): skipped ${devs4[0].pl.stats.drops} chunks, total silence ${gapsMs.toFixed(0)} ms over 2 min, extra local cushion ${(devs4[0].pl.extra * 1000).toFixed(0)} ms`);
assert(devs4[0].pl.stats.drops === 0, 'slow networks must degrade to late playback, not skipping');
assert(gapsMs < 6000, 'and the audio must stay smooth (under 5% silence)');

// ---- 3. interpolation quality ---------------------------------------------------------------------------
const err = (f, m) => { const x = Float32Array.from({ length: N }, (_, i) => Math.sin(2 * Math.PI * f * i / SR)); const y = stretch(x, m); let e = 0, s = (N - 1) / (m - 1);
  for (let j = 4; j < m - 4; j++) e = Math.max(e, Math.abs(y[j] - Math.sin(2 * Math.PI * f * j * s / SR))); return e; };
const e1 = err(1000, N - 1), e10 = err(10000, N + 8);
console.log(`6. sample correction accuracy (max error vs ideal): 1 kHz ${e1.toExponential(1)}, 10 kHz ${e10.toExponential(1)}`);
assert(e1 < 1e-3 && e10 < 0.02);
console.log('OK');
