// Procedural car audio: multi-oscillator engine following RPM and throttle,
// tyre squeal, off-road rumble, wind, crowd, crashes and effect sounds.
export const Snd = {
  ac: null, muted: false, ready: false,

  init() {
    if (this.ac) { this.ac.resume && this.ac.resume(); return; }
    try {
      const ac = this.ac = new (window.AudioContext || window.webkitAudioContext)();
      this.master = ac.createGain(); this.master.gain.value = 0.9;
      const comp = ac.createDynamicsCompressor();
      this.master.connect(comp).connect(ac.destination);

      // noise source shared by several layers
      const n = ac.sampleRate * 2, buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      const noise = () => { const s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };

      // engine: three oscillators -> soft clipper -> lowpass -> gain
      this.e1 = ac.createOscillator(); this.e1.type = 'sawtooth';
      this.e2 = ac.createOscillator(); this.e2.type = 'square';
      this.e3 = ac.createOscillator(); this.e3.type = 'sawtooth';
      const g1 = ac.createGain(), g2 = ac.createGain(), g3 = ac.createGain();
      g1.gain.value = 0.5; g2.gain.value = 0.35; g3.gain.value = 0.18;
      const shaper = ac.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 2.5); }
      shaper.curve = curve;
      this.eFilt = ac.createBiquadFilter(); this.eFilt.type = 'lowpass'; this.eFilt.Q.value = 3;
      this.eGain = ac.createGain(); this.eGain.gain.value = 0;
      this.e1.connect(g1).connect(shaper); this.e2.connect(g2).connect(shaper); this.e3.connect(g3).connect(shaper);
      shaper.connect(this.eFilt).connect(this.eGain).connect(this.master);
      [this.e1, this.e2, this.e3].forEach(o => { o.frequency.value = 40; o.start(); });

      // other cars' engines (nearest one)
      this.o1 = ac.createOscillator(); this.o1.type = 'sawtooth';
      this.oFilt = ac.createBiquadFilter(); this.oFilt.type = 'lowpass'; this.oFilt.frequency.value = 900;
      this.oGain = ac.createGain(); this.oGain.gain.value = 0;
      this.o1.connect(this.oFilt).connect(this.oGain).connect(this.master); this.o1.start();

      // tyre squeal
      this.sq = ac.createBiquadFilter(); this.sq.type = 'bandpass'; this.sq.Q.value = 9; this.sq.frequency.value = 1100;
      this.sqGain = ac.createGain(); this.sqGain.gain.value = 0;
      noise().connect(this.sq).connect(this.sqGain).connect(this.master);

      // gravel / grass rumble
      this.rb = ac.createBiquadFilter(); this.rb.type = 'lowpass'; this.rb.frequency.value = 280;
      this.rbGain = ac.createGain(); this.rbGain.gain.value = 0;
      noise().connect(this.rb).connect(this.rbGain).connect(this.master);

      // wind
      this.wd = ac.createBiquadFilter(); this.wd.type = 'highpass'; this.wd.frequency.value = 1400;
      this.wdGain = ac.createGain(); this.wdGain.gain.value = 0;
      noise().connect(this.wd).connect(this.wdGain).connect(this.master);

      // crowd
      this.cr = ac.createBiquadFilter(); this.cr.type = 'bandpass'; this.cr.frequency.value = 650; this.cr.Q.value = 0.6;
      this.crGain = ac.createGain(); this.crGain.gain.value = 0;
      noise().connect(this.cr).connect(this.crGain).connect(this.master);

      this.ready = true;
    } catch (e) { this.ac = null; }
  },

  set(param, v, tc = 0.05) { param.setTargetAtTime(v, this.ac.currentTime, tc); },

  // per-frame update
  update(s) {
    if (!this.ready) return;
    const m = this.muted || !s.active ? 0 : 1;
    const f = s.rpm / 30; // 4-cylinder firing frequency
    this.set(this.e1.frequency, f, 0.03);
    this.set(this.e2.frequency, f * 0.5, 0.03);
    this.set(this.e3.frequency, f * 2.01, 0.03);
    this.set(this.eFilt.frequency, 350 + s.throttle * 2200 + s.rpm * 0.25, 0.04);
    this.set(this.eGain.gain, m * (0.05 + s.throttle * 0.07 + (s.boost ? 0.03 : 0)), 0.05);

    this.set(this.o1.frequency, Math.max(30, s.otherRpm / 30), 0.05);
    this.set(this.oGain.gain, m * s.otherVol * 0.05, 0.1);

    const sq = Math.max(0, Math.min(1, (s.slip - 0.1) * 3)) * Math.min(1, s.speed / 200) * (s.off ? 0.2 : 1);
    this.set(this.sq.frequency, 900 + sq * 500, 0.05);
    this.set(this.sqGain.gain, m * sq * 0.22, 0.04);
    this.set(this.rbGain.gain, m * (s.off ? Math.min(1, s.speed / 300) * 0.35 : 0), 0.08);
    this.set(this.wdGain.gain, m * Math.min(1, (s.speed / 900) ** 2) * 0.1, 0.2);
    this.set(this.crGain.gain, m * s.crowd * 0.18, 0.3);
  },

  silence() {
    if (!this.ready) return;
    for (const g of [this.eGain, this.oGain, this.sqGain, this.rbGain, this.wdGain, this.crGain]) this.set(g.gain, 0, 0.1);
  },

  burst(dur, freq, type, vol, q = 1) {
    if (!this.ready || this.muted) return;
    const ac = this.ac, t = ac.currentTime, s = ac.createBufferSource();
    s.buffer = this.noiseBuf;
    const flt = ac.createBiquadFilter(); flt.type = type; flt.frequency.value = freq; flt.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(flt).connect(g).connect(this.master);
    s.start(t, Math.random()); s.stop(t + dur);
  },
  tone(f, dur = 0.12, type = 'square', vol = 0.08, slide = 0) {
    if (!this.ready || this.muted) return;
    const ac = this.ac, t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + slide), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur);
  },

  crash(intensity) {
    if (!this.ready || this.muted) return;
    const k = Math.min(1, intensity / 500);
    this.burst(0.25 + k * 0.3, 700 + k * 900, 'lowpass', 0.15 + k * 0.45);
    this.burst(0.15, 3000, 'bandpass', 0.06 + k * 0.12, 2); // metal
    this.tone(70 + Math.random() * 30, 0.25, 'sine', 0.2 * k + 0.05, -30);
  },
  boom() {
    if (!this.ready || this.muted) return;
    this.burst(0.9, 500, 'lowpass', 0.6);
    this.tone(55, 0.6, 'sine', 0.35, -25);
  },
  whoosh() { if (this.ready && !this.muted) this.burst(0.6, 1800, 'bandpass', 0.18, 1.5); },
  splat() { if (this.ready && !this.muted) this.burst(0.3, 400, 'lowpass', 0.25); },
  pickup() { this.tone(880, 0.08); this.tone(1320, 0.14, 'triangle', 0.07); },
  cheer() { if (this.ready && !this.muted) this.burst(2.5, 900, 'bandpass', 0.35, 0.5); },
};
