// Mixer audio della regia (Web Audio).
// - bus PROGRAMMA: solo le sorgenti in onda, non mute, col loro volume → va a OBS
// - bus "mix-minus" per ogni ospite: tutti gli altri (in onda o in backstage), MAI la sua voce → torna all'ospite
export class Mixer {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.program = this.ctx.createMediaStreamDestination();
    this.master = this.ctx.createGain();
    this.master.connect(this.program);
    this.masterAn = this.ctx.createAnalyser();
    this.masterAn.fftSize = 1024;
    this.master.connect(this.masterAn);
    this.masterState = { analyser: this.masterAn, buf: new Float32Array(1024), level: 0 };
    this.sources = new Map();   // id -> { owner, node, analyser, prog, talk: Map(listenerId -> gain), buf, level }
    this.listeners = new Map(); // listenerId (ospite) -> MediaStreamAudioDestinationNode
    this.keepAlive = [];
  }

  resume() { return this.ctx.resume(); }
  get programTrack() { return this.program.stream.getAudioTracks()[0]; }

  addSource(id, stream, owner) {
    this.removeSource(id);
    if (!stream.getAudioTracks().length) return;
    // Chrome: uno stream remoto in Web Audio resta muto se non è anche agganciato a un elemento media
    const holder = new Audio(); holder.muted = true; holder.srcObject = stream; holder.play().catch(() => {});
    const node = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    const prog = this.ctx.createGain();
    prog.gain.value = 0;
    node.connect(analyser);
    node.connect(prog).connect(this.master);
    const src = { owner, node, analyser, prog, holder, talk: new Map(), buf: new Float32Array(analyser.fftSize), level: 0, volume: 1, muted: false, onAir: false };
    this.sources.set(id, src);
    for (const [lid, dest] of this.listeners) if (lid !== owner) this.link(src, lid, dest);
  }

  removeSource(id) {
    const s = this.sources.get(id);
    if (!s) return;
    s.node.disconnect(); s.prog.disconnect();
    for (const g of s.talk.values()) g.disconnect();
    s.holder.srcObject = null;
    this.sources.delete(id);
  }

  link(src, lid, dest) {
    const g = this.ctx.createGain();
    g.gain.value = src.muted ? 0 : src.volume;
    src.node.connect(g).connect(dest);
    src.talk.set(lid, g);
  }

  // stream audio che l'ospite sente (tutti tranne lui)
  addListener(lid) {
    this.removeListener(lid);
    const dest = this.ctx.createMediaStreamDestination();
    this.listeners.set(lid, dest);
    for (const src of this.sources.values()) if (src.owner !== lid) this.link(src, lid, dest);
    return dest.stream.getAudioTracks()[0];
  }

  removeListener(lid) {
    this.listeners.delete(lid);
    for (const src of this.sources.values()) {
      const g = src.talk.get(lid);
      if (g) { g.disconnect(); src.talk.delete(lid); }
    }
  }

  set(id, { volume, muted, onAir }) {
    const s = this.sources.get(id);
    if (!s) return;
    if (volume !== undefined) s.volume = volume;
    if (muted !== undefined) s.muted = muted;
    if (onAir !== undefined) s.onAir = onAir;
    const t = this.ctx.currentTime;
    s.prog.gain.setTargetAtTime(s.onAir && !s.muted ? s.volume : 0, t, 0.03);
    for (const g of s.talk.values()) g.gain.setTargetAtTime(s.muted ? 0 : s.volume, t, 0.03);
  }

  setMaster(v) { this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03); }

  // livello 0..1 (scala in dB da -60 a 0), con discesa morbida
  masterLevel() { return this.measure(this.masterState); }

  level(id) {
    const s = this.sources.get(id);
    return s ? this.measure(s) : 0;
  }

  measure(s) {
    s.analyser.getFloatTimeDomainData(s.buf);
    let sum = 0;
    for (let i = 0; i < s.buf.length; i++) sum += s.buf[i] * s.buf[i];
    const db = 20 * Math.log10(Math.sqrt(sum / s.buf.length) + 1e-9);
    const v = Math.max(0, Math.min(1, (db + 60) / 60));
    s.level = v > s.level ? v : s.level * 0.85 + v * 0.15;
    return s.level;
  }
}
