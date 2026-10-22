// Collegamento tra regia, ospiti e OBS senza server nostro: PeerJS fa solo da "centralino",
// poi ognuno parla direttamente con la regia (canale dati WebRTC). Sopra questo canale passano
// la negoziazione video, la chat e lo stato.
import { CONFIG } from './config.js';

const PJ = () => window.Peer; // libreria PeerJS caricata con <script>
const opts = () => ({ ...CONFIG.peer, debug: 1, config: { iceServers: CONFIG.iceServers } });
export const hostPeerId = (room) => `studiolive-${room}`;

const PING_MS = 4000;
const DEAD_MS = 15000;

// ---------- lato regia ----------
export class HostSignal {
  constructor({ room, keys, onMessage, onStatus }) {
    Object.assign(this, { room, keys, onMessage, onStatus });
    this.conns = new Map(); // id -> { conn, role, name, last }
    this.chat = [];
    this.nextId = 1;
    this.welcomed = false;
    this.start();
    this.timer = setInterval(() => this.heartbeat(), PING_MS);
  }

  start() {
    const p = (this.peer = new (PJ())(hostPeerId(this.room), opts()));
    p.on('open', () => {
      this.onStatus?.('open');
      if (!this.welcomed) { this.welcomed = true; this.onMessage({ type: 'welcome', peers: [], chat: [] }); }
    });
    p.on('connection', (conn) => this.accept(conn));
    p.on('disconnected', () => {
      this.onStatus?.('reconnecting');
      setTimeout(() => { if (!p.destroyed) p.reconnect(); }, 1500);
    });
    p.on('error', (e) => {
      if (e.type === 'unavailable-id') { this.onStatus?.('taken'); return; }
      console.warn('peerjs', e.type, e.message);
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
        this.onStatus?.('reconnecting');
        setTimeout(() => { if (p.destroyed) this.start(); else if (p.disconnected) p.reconnect(); }, 3000);
      }
    });
  }

  accept(conn) {
    let me = null;
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (!me) {
        if (msg.type !== 'hello') return conn.close();
        const ok = (msg.role === 'guest' && msg.key === this.keys.guest) || (msg.role === 'output' && msg.key === this.keys.host);
        if (!ok) { conn.send({ type: 'denied' }); setTimeout(() => conn.close(), 400); return; }
        me = 'p' + this.nextId++;
        const name = String(msg.name || (msg.role === 'output' ? 'OBS' : 'Ospite')).slice(0, 40);
        this.conns.set(me, { conn, role: msg.role, name, last: Date.now() });
        conn.send({ type: 'welcome', id: me, hostOnline: true, chat: msg.role === 'guest' ? this.chat : [] });
        this.onMessage({ type: 'peer-join', id: me, role: msg.role, name });
        return;
      }
      const c = this.conns.get(me);
      if (!c) return;
      c.last = Date.now();
      if (msg.type === 'pong') return;
      if (msg.type === 'chat') {
        if (c.role !== 'guest') return;
        return this.broadcastChat({ type: 'chat', from: c.name, host: false, text: String(msg.text || '').slice(0, 500), ts: Date.now() });
      }
      this.onMessage({ ...msg, from: me });
    });
    conn.on('close', () => this.drop(me, conn));
    conn.on('error', () => this.drop(me, conn));
  }

  drop(id, conn) {
    const c = id && this.conns.get(id);
    if (!c || (conn && c.conn !== conn)) return;
    this.conns.delete(id);
    try { c.conn.close(); } catch {}
    this.onMessage({ type: 'peer-leave', id });
  }

  heartbeat() {
    const now = Date.now();
    for (const [id, c] of this.conns) {
      if (now - c.last > DEAD_MS) { this.drop(id); continue; }
      if (c.conn.open) c.conn.send({ type: 'ping' });
    }
  }

  send(obj) {
    if (obj.type === 'chat' && !obj.to) {
      return this.broadcastChat({ type: 'chat', from: 'Regia', host: true, text: String(obj.text || '').slice(0, 500), ts: Date.now() });
    }
    if (obj.type === 'kick') {
      const c = this.conns.get(obj.id);
      if (c) { c.conn.send({ type: 'kicked' }); setTimeout(() => this.drop(obj.id), 400); }
      return;
    }
    if (obj.to) {
      const c = this.conns.get(obj.to);
      if (c?.conn.open) c.conn.send({ ...obj, from: 'host' });
    }
  }

  broadcastChat(m) {
    this.chat.push(m);
    if (this.chat.length > 200) this.chat.shift();
    this.onMessage(m);
    for (const c of this.conns.values()) if (c.role === 'guest' && c.conn.open) c.conn.send(m);
  }

  setKeys(keys) {
    this.keys = keys;
    for (const [id, c] of this.conns) if (c.role === 'guest') { c.conn.send({ type: 'denied', reason: 'regen' }); setTimeout(() => this.drop(id), 400); }
  }

  close() { clearInterval(this.timer); this.peer?.destroy(); }
}

// ---------- lato ospite / OBS ----------
export class ClientSignal {
  constructor({ room, role, key, name, onMessage, onStatus }) {
    Object.assign(this, { room, role, key, name, onMessage, onStatus });
    this.closed = false;
    this.everConnected = false;
    this.offlineNotified = false;
    this.start();
    this.timer = setInterval(() => {
      if (this.conn?.open && Date.now() - this.last > DEAD_MS) this.conn.close();
    }, PING_MS);
  }

  start() {
    const p = (this.peer = new (PJ())(opts()));
    p.on('open', () => this.dial());
    p.on('disconnected', () => setTimeout(() => { if (!p.destroyed && !this.closed) p.reconnect(); }, 1500));
    p.on('error', (e) => {
      if (this.closed) return;
      if (e.type === 'peer-unavailable') {
        this.hostDown();
        setTimeout(() => this.dial(), 3000);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
        setTimeout(() => { if (p.destroyed) this.start(); else if (p.disconnected) p.reconnect(); }, 3000);
      } else console.warn('peerjs', e.type, e.message);
    });
  }

  dial() {
    if (this.closed || this.peer.disconnected) return;
    const conn = this.peer.connect(hostPeerId(this.room), { reliable: true, serialization: 'binary' });
    this.conn = conn;
    conn.on('open', () => { this.last = Date.now(); conn.send({ type: 'hello', role: this.role, key: this.key, name: this.name }); });
    conn.on('data', (m) => {
      if (!m || typeof m !== 'object') return;
      this.last = Date.now();
      if (m.type === 'ping') return conn.send({ type: 'pong' });
      if (m.type === 'denied') {
        this.closed = true;
        this.onStatus?.('closed', m.reason === 'regen' ? 4001 : 4003);
        return;
      }
      if (m.type === 'kicked') { this.closed = true; this.onMessage(m); return; }
      if (m.type === 'welcome') {
        if (this.everConnected) this.onMessage({ type: 'host-ready' });
        this.everConnected = true;
        this.offlineNotified = false;
        this.onStatus?.('open');
      }
      this.onMessage(m);
    });
    conn.on('close', () => {
      if (this.conn !== conn) return;
      this.hostDown();
      if (!this.closed) setTimeout(() => this.dial(), 2000);
    });
  }

  hostDown() {
    if (this.everConnected && !this.offlineNotified) { this.offlineNotified = true; this.onMessage({ type: 'host-left' }); }
    else if (!this.everConnected && !this.offlineNotified) { this.offlineNotified = true; this.onMessage({ type: 'host-offline' }); }
  }

  send(obj) { if (!this.conn?.open) return false; this.conn.send(obj); return true; }

  close() { this.closed = true; clearInterval(this.timer); this.conn?.close(); this.peer?.destroy(); }
}
