// Audio engine: Opus over the app WebSocket, Web Audio mixing, mic capture.
export const supported = typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined' &&
  typeof AudioData !== 'undefined' && typeof AudioWorkletNode !== 'undefined';

export const PRESETS = {
  phone:  { label: 'Phone / noisy place', ec: true,  ns: true,  agc: true,  hpf: 120, gate: true,  gateDb: -52 },
  headset:{ label: 'Headset',             ec: true,  ns: true,  agc: false, hpf: 80,  gate: false, gateDb: -55 },
  raw:    { label: 'Raw (no processing)', ec: false, ns: false, agc: false, hpf: 0,   gate: false, gateDb: -55 },
};

export class Engine {
  constructor() {
    this.ctx = null;
    this.voices = new Map();   // "ch:sender" -> Voice
    this.chans = new Map();    // ch -> {kind:'room'|'feed', id}
    this.gains = new Map();    // "room:id"/"feed:id" -> GainNode
    this.vol = { master: 1, mic: 1 };
    this.jitter = { room: 0.08, feed: 0.25 };
    this.duck = 0.4;           // program level while comms are active (1 = no ducking)
    this.lastComms = 0;
    this.onLevel = () => {};
    this.sendFrame = () => {};
    this.captures = new Map(); // name -> Capture
    this.sinkId = '';
    this.stats = { rx: 0, tx: 0, rxLast: 0, decodeErr: 0 };
  }

  async start() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {}); return; }
    const ctx = this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.master = ctx.createGain();
    this.comms = ctx.createGain();
    this.program = ctx.createGain();
    this.comms.connect(this.master);
    this.program.connect(this.master);
    // Output through a media element so playback continues with the screen off.
    const dest = ctx.createMediaStreamDestination();
    this.master.connect(dest);
    this.el = new Audio();
    this.el.srcObject = dest.stream;
    this.el.setAttribute('playsinline', '');
    await this.el.play().catch(() => {});
    if (this.sinkId && this.el.setSinkId) this.el.setSinkId(this.sinkId).catch(() => {});
    await ctx.audioWorklet.addModule('/worklet.js');
    this.master.gain.value = this.vol.master;
    setInterval(() => this.housekeeping(), 1000);
    setInterval(() => this.duckTick(), 100);
  }

  async resume() {
    if (!this.ctx) return;
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    if (this.el && this.el.paused) await this.el.play().catch(() => {});
  }

  async setSink(id) {
    this.sinkId = id || '';
    if (this.el && this.el.setSinkId) await this.el.setSinkId(this.sinkId).catch(() => {});
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
    g.gain.value = muted ? 0 : v;
  }

  // ---- receive ----
  receive(buf) {
    const dv = new DataView(buf);
    if (dv.byteLength < 10 || dv.getUint8(0) !== 1 || !this.ctx) return;
    this.stats.rx++; this.stats.rxLast = performance.now();
    const ch = dv.getUint16(1), sender = dv.getUint16(3), seq = dv.getUint32(5);
    const ref = this.chans.get(ch);
    if (!ref) return;
    const key = ch + ':' + sender;
    let v = this.voices.get(key);
    if (!v) { v = this.makeVoice(ref); this.voices.set(key, v); }
    v.last = performance.now();
    if (ref.kind === 'room') this.lastComms = v.last;
    try {
      v.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: seq * 20000, data: new Uint8Array(buf, 9) }));
    } catch (e) { /* decoder closed; recreated on next frame */ this.voices.delete(key); }
  }

  makeVoice(ref) {
    const ctx = this.ctx;
    const feed = ref.kind === 'feed';
    const v = { next: 0, last: 0, ref };
    v.dec = new AudioDecoder({
      output: (data) => this.play(v, data, feed),
      error: () => { this.stats.decodeErr++; try { v.dec.close(); } catch {} v.dead = true; },
    });
    v.dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: feed ? 2 : 1 });
    return v;
  }

  play(v, data, feed) {
    const ctx = this.ctx;
    const ch = data.numberOfChannels, n = data.numberOfFrames;
    const ab = ctx.createBuffer(ch, n, 48000);
    for (let c = 0; c < ch; c++) {
      const tmp = new Float32Array(n);
      data.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
      ab.copyToChannel(tmp, c);
    }
    data.close();
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.gainFor(v.ref.kind, v.ref.id));
    const now = ctx.currentTime;
    const target = this.jitter[feed ? 'feed' : 'room'];
    // Resync when we underrun or drift too far ahead (keeps latency bounded).
    if (v.next < now + 0.01 || v.next > now + target * 4 + 0.3) v.next = now + target;
    src.start(v.next);
    v.next += n / 48000;
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

  duckTick() {
    if (!this.ctx) return;
    const active = performance.now() - this.lastComms < 600 || this.talkingNow;
    const target = active ? this.duck : 1;
    this.program.gain.setTargetAtTime(target, this.ctx.currentTime, active ? 0.05 : 0.5);
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
      ec: true, ns: true, agc: true, hpf: 0, gate: false, gateDb: -55, onFrame: () => {}, onLevel: () => {} }, o);
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
    this.node = new AudioWorkletNode(ctx, 'ns-framer', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [o.channels],
      processorOptions: { channels: o.channels, gate: o.gate, threshold: o.gateDb },
    });
    this.gain.connect(this.node);
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
      const { frame, level } = m.data;
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
  setGate(on, db) { this.node?.port.postMessage({ gate: on, threshold: db }); }
  get deviceId() { return this.track?.getSettings().deviceId; }

  async close() {
    this.sending = false;
    try { this.node.port.onmessage = null; this.node.disconnect(); this.sink.disconnect(); } catch {}
    try { this.src.disconnect(); } catch {}
    try { this.stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { this.enc.close(); } catch {}
  }
}
