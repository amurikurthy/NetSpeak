// Frames mic audio into 20 ms blocks (960 @ 48 kHz) with an optional noise gate.
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
    this.port.onmessage = (e) => {
      if ('gate' in e.data) { this.gate = !!e.data.gate; if (!this.gate) this.g = 1; }
      if ('threshold' in e.data) this.thr = Math.pow(10, e.data.threshold / 20);
    };
  }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < this.ch; c++) {
        const v = inp[Math.min(c, inp.length - 1)][i];
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
      for (let c = 0; c < this.ch; c++) {
        this.bufs[c][this.pos] = inp[Math.min(c, inp.length - 1)][i] * this.g;
      }
      if (++this.pos === this.N) {
        this.pos = 0;
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
