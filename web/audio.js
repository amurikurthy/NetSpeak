import { ClockSync, SyncPlayout, stretch } from './syncplay.js';

// Audio engine: Opus over the app WebSocket, Web Audio mixing, mic capture.
// One second of exact digital silence as a WAV blob, so the browser sees real media playing. (It must be true
// silence: even faint noise in a looping clip can be heard as a hiss on some phones.)
function silentClipUrl() {
  const rate = 8000, n = rate, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export const supported = typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined' &&
  typeof AudioData !== 'undefined' && typeof AudioWorkletNode !== 'undefined';

export class Engine {
  constructor() {
    this.ctx = null;
    this.voices = new Map();   // "ch:sender" -> Voice
    this.chans = new Map();    // ch -> {kind:'room'|'feed', id}
    this.gains = new Map();    // "room:id"/"feed:id" -> GainNode
    this.vol = { master: 1, mic: 1 };
    this.jitter = { room: 0.08, feed: 0.05 };   // fixed playout buffers (seconds)
    this.onLevel = () => {};
    this.sendFrame = () => {};
    this.captures = new Map(); // name -> Capture
    this.sinkId = '';
    this.stats = { rx: 0, tx: 0, rxLast: 0, decodeErr: 0, syncDrops: 0, syncCorr: 0 };
    this.clock = new ClockSync();   // this device's clock vs the server's
    this.feedDelayMs = 250;         // set by the server: every device plays program audio this long after its stamp
  }

  // One-time setup. Safe to call any time, with or without a user gesture; concurrent calls share it.
  init() {
    if (!this._init) this._init = this._setup().catch((e) => { this._init = null; this.ctx = null; throw e; });
    return this._init;
  }
  async start() { await this.init(); await this.resume(); }

  async _setup() {
    const ctx = this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    ctx.onstatechange = () => this.onState && this.onState();
    this.master = ctx.createGain();
    this.comms = ctx.createGain();
    this.program = ctx.createGain();
    this.comms.connect(this.master);
    this.program.connect(this.master);
    // All sound leaves through the AudioContext, on the phone's normal media volume. (Playing it through a
    // media element fed from a MediaStream would put it on Android's separate "call" volume.)
    this.master.connect(ctx.destination);
    if (this.sinkId && ctx.setSinkId) ctx.setSinkId(this.sinkId).catch(() => {});
    // A silent, looping clip keeps the page registered as media playback, so the browser keeps it running
    // with the screen off and shows lock-screen controls. It carries no sound of its own.
    this.el = new Audio(silentClipUrl());
    this.el.loop = true;
    this.el.setAttribute('playsinline', '');
    this.el.play().catch(() => {});
    await ctx.audioWorklet.addModule('/worklet.js');
    this.master.gain.value = this.vol.master;
    setInterval(() => this.housekeeping(), 1000);
  }

  // Starts playback if the browser allows it. Without a user gesture (and outside an installed app)
  // browsers keep audio blocked, so never wait on it for long.
  async resume() {
    if (!this.ctx) return;
    const soft = (p) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    if (this.ctx.state !== 'running') await soft(this.ctx.resume());
    if (this.el && this.el.paused) await soft(this.el.play());
  }

  async setSink(id) {
    this.sinkId = id || '';
    if (this.ctx && this.ctx.setSinkId) await this.ctx.setSinkId(this.sinkId).catch(() => {});
  }

  setMaster(v) { this.vol.master = v; if (this.master) this.master.gain.value = v; }

  registerChannels(rooms, feeds) {
    this.chans.clear();
    for (const r of rooms) this.chans.set(r.ch, { kind: 'room', id: r.id });
    for (const f of feeds) this.chans.set(f.ch, { kind: 'feed', id: f.id });
  }

  gainFor(kind, id) {
    const k = kind + ':' + id;
    let g = this.gains.get(k);
    if (!g) {
      g = this.ctx.createGain();
      g.connect(kind === 'feed' ? this.program : this.comms);
      this.gains.set(k, g);
      g._v = 1; g._muted = false;
    }
    return g;
  }

  setVolume(kind, id, v, muted = false) {
    if (!this.ctx) return;
    const g = this.gainFor(kind, id);
    g._v = v; g._muted = muted;
    g.gain.setTargetAtTime(muted ? 0 : v, this.ctx.currentTime, 0.02);   // short ramp: no clicks
  }

  // ---- receive ----
  receive(buf) {
    const dv = new DataView(buf);
    const type = dv.byteLength > 0 ? dv.getUint8(0) : 0;
    // 1 = room voice [1][chan u16][sender u16][seq u32][opus]; 2 = program feed, same plus a u64 server stamp (us)
    const hdr = type === 2 ? 17 : 9;
    if ((type !== 1 && type !== 2) || dv.byteLength <= hdr || !this.ctx) return;
    this.stats.rx++; this.stats.rxLast = performance.now();
    const ch = dv.getUint16(1), sender = dv.getUint16(3), seq = dv.getUint32(5);
    const ref = this.chans.get(ch);
    if (!ref) return;
    const key = ch + ':' + sender;
    let v = this.voices.get(key);
    if (!v) { v = this.makeVoice(ref); this.voices.set(key, v); }
    v.last = performance.now();
    const timestamp = type === 2 ? Number(dv.getBigUint64(9)) : seq * 20000;   // feed: the stamp rides through the decoder
    try {
      v.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: new Uint8Array(buf, hdr) }));
    } catch (e) { /* decoder closed; recreated on next frame */ this.voices.delete(key); }
  }

  makeVoice(ref) {
    const ctx = this.ctx;
    const feed = ref.kind === 'feed';
    const v = { next: 0, last: 0, ref, sp: feed ? new SyncPlayout(48000) : null };
    v.dec = new AudioDecoder({
      output: (data) => this.play(v, data, feed),
      error: () => { this.stats.decodeErr++; try { v.dec.close(); } catch {} v.dead = true; },
    });
    v.dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: feed ? 2 : 1 });
    return v;
  }

  // Audio-clock time at which the server-clock instant sMs should sound on this device.
  serverToCtx(sMs) {
    const ot = this.ctx.getOutputTimestamp ? this.ctx.getOutputTimestamp() : null;
    const ok = ot && ot.performanceTime > 0 && ot.contextTime > 0;
    const ctxRef = ok ? ot.contextTime : this.ctx.currentTime, perfRef = ok ? ot.performanceTime : performance.now();
    return ctxRef + (sMs - this.clock.offset - perfRef) / 1000;
  }

  play(v, data, feed) {
    const ctx = this.ctx;
    const ch = data.numberOfChannels, n = data.numberOfFrames;
    const planes = [];
    for (let c = 0; c < ch; c++) {
      const tmp = new Float32Array(n);
      data.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
      planes.push(tmp);
    }
    const stampUs = data.timestamp;
    data.close();
    const now = ctx.currentTime;
    let when, slip = 0;
    if (feed && this.clock.ready && v.sp) {
      // Synchronised: sound this chunk exactly feedDelayMs after its server stamp, like every other listener.
      const r = v.sp.plan(this.serverToCtx(stampUs / 1000 + this.feedDelayMs), now, n);
      this.stats.syncCorr = (this.stats.syncCorr || 0) + (r.slip ? 1 : 0);
      if (r.drop) { this.stats.syncDrops++; return; }   // too late to play in sync: skip it
      when = r.when; slip = r.slip;
    } else {
      // Not synchronised yet (first moments after connecting) or a room voice: simple low-delay queue.
      const target = this.jitter[feed ? 'feed' : 'room'];
      if (v.next < now + 0.01 || v.next > now + target * 4 + 0.3) v.next = now + target;   // resync when we underrun or drift far ahead
      when = v.next; v.next += n / 48000;
    }
    const m = n + slip;
    const ab = ctx.createBuffer(ch, m, 48000);
    for (let c = 0; c < ch; c++) ab.copyToChannel(slip ? stretch(planes[c], m) : planes[c], c);
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.gainFor(v.ref.kind, v.ref.id));
    src.start(when);
  }

  housekeeping() {
    const t = performance.now();
    for (const [k, v] of this.voices) {
      if (v.dead || t - v.last > 15000) {
        try { v.dec.close(); } catch {}
        this.voices.delete(k);
      }
    }
  }

  // ---- capture ----
  async capture(name, opts) {
    await this.start();
    await this.stopCapture(name);
    const c = new Capture(this, opts);
    this.captures.set(name, c);
    try { await c.open(); } catch (e) { this.captures.delete(name); throw e; }
    return c;
  }

  async stopCapture(name) {
    const c = this.captures.get(name);
    if (c) { this.captures.delete(name); await c.close(); }
  }
}

class Capture {
  constructor(engine, o) {
    this.e = engine;
    this.o = Object.assign({ channels: 1, bitrate: 32000, application: 'voip', deviceId: '', gain: 1,
      ec: true, ns: true, agc: true, hpf: 0, gate: false, gateDb: -55, feedback: false, aec: false, compressor: false, onAec: () => {}, onFeedback: () => {}, onFrame: () => {}, onLevel: () => {} }, o);
    this.seq = 0; this.ts = 0; this.sending = false;
  }

  async open() {
    const e = this.e, ctx = e.ctx, o = this.o;
    const audio = {
      channelCount: o.channels, sampleRate: 48000, sampleSize: 16,
      echoCancellation: o.ec, noiseSuppression: o.ns, autoGainControl: o.agc,
    };
    if (o.deviceId) audio.deviceId = { exact: o.deviceId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio });
    this.track = this.stream.getAudioTracks()[0];
    this.src = ctx.createMediaStreamSource(this.stream);
    let tail = this.src;
    if (o.hpf > 0) {
      this.hp = ctx.createBiquadFilter();
      this.hp.type = 'highpass'; this.hp.frequency.value = o.hpf; this.hp.Q.value = 0.707;
      tail.connect(this.hp); tail = this.hp;
    }
    this.gain = ctx.createGain();
    this.gain.gain.value = o.gain;
    tail.connect(this.gain);
    tail = this.gain;
    if (o.compressor) {
      // Program audio: gentle compressor to even out loud and quiet parts, then a fast limiter so peaks never clip.
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -24; this.comp.knee.value = 12; this.comp.ratio.value = 3;
      this.comp.attack.value = 0.01; this.comp.release.value = 0.25;
      this.lim = ctx.createDynamicsCompressor();
      this.lim.threshold.value = -2; this.lim.knee.value = 0; this.lim.ratio.value = 20;
      this.lim.attack.value = 0.001; this.lim.release.value = 0.1;
      tail.connect(this.comp); this.comp.connect(this.lim); tail = this.lim;
    }
    this.node = new AudioWorkletNode(ctx, 'ns-framer', {
      numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [o.channels],
      processorOptions: { channels: o.channels, gate: o.gate, threshold: o.gateDb, feedback: o.feedback, aec: o.aec },
    });
    tail.connect(this.node);
    // Echo cancellation: what this device is playing is the reference (input 1), so the mic can be cleaned of it
    // in software, without the phone's own echo cancellation (which switches Android into call mode).
    if (o.aec) e.master.connect(this.node, 0, 1);
    this.sink = ctx.createGain(); this.sink.gain.value = 0;   // keeps the graph pulled, outputs silence
    this.node.connect(this.sink); this.sink.connect(ctx.destination);
    this.enc = new AudioEncoder({
      output: (chunk) => {
        const d = new Uint8Array(chunk.byteLength);
        chunk.copyTo(d);
        this.e.stats.tx++;
        o.onFrame(this.seq++, d);
      },
      error: () => {},
    });
    this.enc.configure({
      codec: 'opus', sampleRate: 48000, numberOfChannels: o.channels, bitrate: o.bitrate,
      opus: { application: o.application, signal: o.application === 'voip' ? 'voice' : 'music', frameDuration: 20000, useinbandfec: false, usedtx: false },
    });
    this.node.port.onmessage = (m) => {
      const { frame, level, feedback, aec } = m.data;
      if (feedback) o.onFeedback(feedback);
      if (aec !== undefined) o.onAec(aec);
      o.onLevel(level);
      if (!frame || !this.sending) return;
      if (this.enc.encodeQueueSize > 10) return;
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 960,
        numberOfChannels: o.channels, timestamp: this.ts, data: frame });
      this.ts += 20000;
      this.enc.encode(ad);
      ad.close();
    };
  }

  setGain(v) { if (this.gain) this.gain.gain.value = v; }
  setFeedback(on) { this.node?.port.postMessage({ feedback: on }); }
  setGate(on, db) { this.node?.port.postMessage({ gate: on, threshold: db }); }
  get deviceId() { return this.track?.getSettings().deviceId; }

  async close() {
    this.sending = false;
    try { this.e.master.disconnect(this.node); } catch {}
    try { this.node.port.onmessage = null; this.node.disconnect(); this.sink.disconnect(); } catch {}
    try { this.src.disconnect(); } catch {}
    try { this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.enc.close(); } catch {}
  }
}
