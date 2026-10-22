// Registrazione locale in qualità piena (nel browser di chi viene ripreso) + "destinazioni" dove scrivere i pezzi.
const TYPES = [
  // avc3: regge i cambi di risoluzione della camera durante la registrazione
  ['video/mp4;codecs=avc3.640028,mp4a.40.2', 'mp4'],
  ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],
  ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'webm'],
  ['video/webm;codecs=vp8,opus', 'webm'],
  ['video/webm', 'webm'],
];
export const pickType = () => {
  const [mime, ext] = TYPES.find(([t]) => window.MediaRecorder?.isTypeSupported(t)) || ['video/webm', 'webm'];
  return { mime, ext, base: mime.split(';')[0] };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// makeSink(part, type) → Promise<{ write(blob), close() }>
// partMs > 0: file nuovo ogni tot (dischi FAT32: max 4 GB a file)
export class ChunkRecorder {
  constructor({ stream, makeSink, partMs = 0, videoBitsPerSecond = 6_000_000, onStatus }) {
    Object.assign(this, { stream, makeSink, partMs, videoBitsPerSecond, onStatus });
    this.type = pickType();
    this.part = 0;
    this.queue = [];
    this.busy = false;
    this.bytes = 0;
    this.error = null;
    this.running = false;
    this.openParts = 0; // file aperti che non hanno ancora ricevuto l'ultimo pezzo + chiusura
  }

  get pending() { return this.queue.length + (this.busy ? 1 : 0) + (this.running ? 0 : this.openParts); }

  start() { this.running = true; this.startPart(); }

  startPart() {
    this.part += 1;
    this.openParts += 1;
    const sinkP = this.makeSink(this.part, this.type);
    sinkP.catch((e) => { this.error = e.message; this.status('error'); });
    const rec = new MediaRecorder(this.stream, { mimeType: this.type.mime, videoBitsPerSecond: this.videoBitsPerSecond, audioBitsPerSecond: 192_000 });
    rec.ondataavailable = (e) => { if (e.data.size) this.push({ sinkP, blob: e.data }); };
    rec.onstop = () => this.push({ sinkP, close: true });
    rec.start(2000);
    this.rec = rec;
    if (this.partMs) this.partTimer = setTimeout(() => {
      if (!this.running) return;
      const old = this.rec;
      this.startPart();
      old.stop();
    }, this.partMs);
    this.status('rec');
  }

  push(item) { this.queue.push(item); this.pump(); }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const it = this.queue.shift();
      if (it.close) this.openParts -= 1;
      try {
        const sink = await it.sinkP;
        if (it.close) await sink.close(); else { await sink.write(it.blob); this.bytes += it.blob.size; }
        if (this.error && !it.close) { this.error = null; }
      } catch (e) {
        this.error = e.message || 'Salvataggio non riuscito';
        console.error('registrazione', e);
      }
      this.status(this.running ? (this.error ? 'error' : 'rec') : this.pending ? 'saving' : 'done');
    }
    this.busy = false;
    if (!this.running) this.status('done');
  }

  stop() {
    this.running = false;
    clearTimeout(this.partTimer);
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    this.status('saving');
  }

  // aspetta che tutto sia stato scritto
  async drain(maxMs = 120_000) {
    const t0 = Date.now();
    // dopo stop() l'ultimo pezzo e la chiusura arrivano un attimo dopo: aspetta anche quelli
    while ((this.queue.length || this.busy || this.openParts > 0) && Date.now() - t0 < maxMs) await sleep(300);
  }

  status(state) { this.onStatus?.({ state, bytes: this.bytes, pending: this.pending, error: this.error }); }
}

// ---------- Google Drive: caricamento riprendibile a blocchi da 256 KB ----------
const CHUNK = 256 * 1024;
const SEND_AT = 32 * CHUNK; // invia ogni ~8 MB

export class DriveSink {
  constructor(url) { this.url = url; this.parts = []; this.size = 0; this.offset = 0; this.done = false; }

  async write(blob) {
    this.parts.push(blob); this.size += blob.size;
    if (this.size >= SEND_AT) await this.flush(false);
  }

  async close() { await this.flush(true); this.done = true; }

  async flush(final) {
    let data = new Blob(this.parts);
    const len = final ? data.size : Math.floor(data.size / CHUNK) * CHUNK;
    if (!len && !final) return;
    let body = data.slice(0, len);
    const rest = data.slice(len);
    for (let attempt = 0; ; attempt++) {
      const end = this.offset + body.size - 1;
      const total = final ? String(this.offset + body.size) : '*';
      const range = body.size ? `bytes ${this.offset}-${end}/${total}` : `bytes */${total}`;
      let r;
      try { r = await fetch(this.url, { method: 'PUT', headers: { 'Content-Range': range }, body }); }
      catch (e) { r = null; }
      if (r && (r.status === 200 || r.status === 201)) { this.offset += body.size; break; }
      if (r && r.status === 308) {
        // il server dice fin dove ha ricevuto: riprendiamo da lì
        const got = r.headers.get('Range');
        // senza intestazione Range (o se il browser non la espone) consideriamo il blocco ricevuto tutto
        const next = got ? Number(got.split('-')[1]) + 1 : this.offset + body.size;
        const sent = next - this.offset;
        this.offset = next;
        if (sent >= body.size) break;
        body = body.slice(sent);
        continue;
      }
      if (r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) throw new Error(`Drive ha rifiutato il file (${r.status})`);
      if (attempt >= 6) throw new Error('Connessione a Drive persa');
      await sleep(1000 * 2 ** Math.min(attempt, 4));
      // chiedi lo stato prima di riprovare
      try {
        const q = await fetch(this.url, { method: 'PUT', headers: { 'Content-Range': `bytes */${final ? this.offset + body.size : '*'}` } });
        if (q.status === 308) {
          const got = q.headers.get('Range');
          const next = got ? Number(got.split('-')[1]) + 1 : this.offset;
          body = body.slice(next - this.offset);
          this.offset = next;
        } else if (q.status === 200 || q.status === 201) { this.offset += body.size; break; }
      } catch {}
    }
    this.parts = rest.size ? [rest] : [];
    this.size = rest.size;
  }
}

// ---------- cartella sul computer (File System Access API, Chrome/Edge) ----------
export class LocalSink {
  constructor(dir, name) { this.dir = dir; this.name = name; this.w = null; }
  async open() { if (!this.w) { const fh = await this.dir.getFileHandle(this.name, { create: true }); this.w = await fh.createWritable(); } }
  async write(blob) { await this.open(); await this.w.write(blob); }
  async close() { await this.open(); await this.w.close(); }
}

// ---------- ospite → regia (quando la regia salva su una cartella del suo computer) ----------
export class RemoteSink {
  constructor(send, key) { this.send = send; this.key = key; }
  async write(blob) { await this.deliver({ type: 'rec-chunk', key: this.key, data: await blob.arrayBuffer() }); await sleep(20); }
  async close() { await this.deliver({ type: 'rec-end', key: this.key }); }
  // send() restituisce false se il collegamento è giù: riprova finché torna (max 5 minuti)
  async deliver(msg) {
    for (const t0 = Date.now(); !this.send(msg); await sleep(500)) if (Date.now() - t0 > 300_000) throw new Error('Regia irraggiungibile');
  }
}

export const sessionName = () => {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `LIVE_${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}`;
};

export const safeName = (s) => String(s || '').normalize('NFKD').replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'senza_nome';
