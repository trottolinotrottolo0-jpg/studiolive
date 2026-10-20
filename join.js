import { ClientSignal } from './lib/net.js';
import { Peer } from './lib/peer.js';
import { ChunkRecorder, DriveSink, RemoteSink } from './lib/recorder.js';
import { icon } from './lib/icons.js';
import { CONFIG } from './lib/config.js';

const $ = (s) => document.querySelector(s);
const QS = new URLSearchParams(location.search);
const KEY = QS.get('k');
const ROOM = QS.get('r');
const PART_MS = 30 * 60 * 1000;
const urlWaiters = new Map(); // kind -> resolve(url) quando la regia apre il file su Drive
if (!ROOM || !KEY) setTimeout(() => end('Link non valido', 'Il link è incompleto: chiedi di nuovo il link a chi ti ha invitato.'));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let cam = null, screen = null, peer = null, signal = null, iceServers = null;
let myName = '';
let recSession = null;
const recs = new Map(); // 'cam' | 'screen' -> ChunkRecorder
let meterCtx = null, meterRaf = 0;

// ---------- prima di entrare ----------
$('#name').value = store.get('studiolive-name') || '';
$('#name').oninput = () => { $('#joinBtn').disabled = !cam || !$('#name').value.trim(); };
openMedia(store.get('studiolive-cam') || '', store.get('studiolive-mic') || '');

async function getMedia(camId, micId) {
  const audio = { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const video = { deviceId: camId ? { exact: camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  try { return await navigator.mediaDevices.getUserMedia({ audio, video }); } catch (e) {
    if (camId || micId) return getMedia('', '');
    if (['NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(e.name)) return navigator.mediaDevices.getUserMedia({ audio });
    throw e;
  }
}

async function openMedia(camId, micId) {
  try {
    const st = await getMedia(camId, micId);
    cam?.getTracks().forEach((t) => t.stop());
    cam = st;
    $('#preview').srcObject = st;
    $('#previewOff').classList.toggle('hidden', st.getVideoTracks().length > 0);
    $('#preErr').textContent = '';
    startPreMeter(st);
    await fillDevices();
  } catch (e) {
    $('#preErr').textContent = e.name === 'NotAllowedError'
      ? 'Hai negato il permesso a camera e microfono. Clicca sull’icona del lucchetto nella barra degli indirizzi, consenti e ricarica la pagina.'
      : 'Non riesco ad accedere a camera e microfono: ' + e.message;
  }
  $('#joinBtn').disabled = !cam || !$('#name').value.trim();
}

async function fillDevices() {
  const list = await navigator.mediaDevices.enumerateDevices();
  const cur = (t) => t?.getSettings().deviceId;
  const opts = (kind, id, label) => list.filter((d) => d.kind === kind).map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === id ? 'selected' : ''}>${(d.label || `${label} ${i + 1}`).replace(/</g, '&lt;')}</option>`).join('');
  $('#cam').innerHTML = opts('videoinput', cur(cam.getVideoTracks()[0]), 'Camera') || '<option value="">Nessuna camera</option>';
  $('#mic').innerHTML = opts('audioinput', cur(cam.getAudioTracks()[0]), 'Microfono') || '<option value="">Nessun microfono</option>';
}
$('#cam').onchange = () => { store.set('studiolive-cam', $('#cam').value); openMedia($('#cam').value, $('#mic').value); };
$('#mic').onchange = () => { store.set('studiolive-mic', $('#mic').value); openMedia($('#cam').value, $('#mic').value); };

function startPreMeter(st) {
  cancelAnimationFrame(meterRaf);
  if (!st.getAudioTracks().length) return;
  meterCtx = meterCtx || new AudioContext();
  const an = meterCtx.createAnalyser();
  an.fftSize = 512;
  meterCtx.createMediaStreamSource(st).connect(an);
  const buf = new Float32Array(an.fftSize);
  let lvl = 0;
  const loop = () => {
    an.getFloatTimeDomainData(buf);
    let s = 0; for (const v of buf) s += v * v;
    const db = 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9);
    const v = Math.max(0, Math.min(1, (db + 60) / 60));
    lvl = v > lvl ? v : lvl * 0.85 + v * 0.15;
    $('#preMeter').style.width = `${lvl * 100}%`;
    meterRaf = requestAnimationFrame(loop);
  };
  loop();
}

$('#joinBtn').onclick = async () => {
  myName = $('#name').value.trim();
  if (!myName) return $('#name').focus();
  store.set('studiolive-name', myName);
  cancelAnimationFrame(meterRaf);
  meterCtx?.close(); meterCtx = null;
  $('#pre').remove();
  $('#room').classList.add('on');
  $('#self').srcObject = cam;
  if (!navigator.mediaDevices.getDisplayMedia) $('#screenBtn').classList.add('hidden');
  renderBar();
  iceServers = CONFIG.iceServers;
  showWaiting('Mi collego allo studio…', 'Un attimo.');
  signal = new ClientSignal({ room: ROOM, role: 'guest', key: KEY, name: myName, onMessage, onStatus: onSignalStatus });
};

// ---------- nello studio ----------
function onMessage(m) {
  switch (m.type) {
    case 'welcome':
      $('#chatList').innerHTML = '';
      m.chat.forEach(addChat);
      showWaiting('Sei nello studio', 'La regia ti sta collegando…');
      break;
    case 'host-offline':
      showWaiting('In attesa della regia…', 'La diretta non è ancora iniziata. Resta su questa pagina: entri da solo appena la regia apre lo studio.');
      break;
    case 'rec-url': {
      const w = urlWaiters.get(m.kind);
      if (w && w.session === m.session) { urlWaiters.delete(m.kind); m.error ? w.reject(new Error(m.error)) : w.resolve(m.url); }
      break;
    }
    case 'host-ready': resetPeer(); break;
    case 'host-left':
      resetPeer();
      showWaiting('La regia si è scollegata', 'Resta su questa pagina: ti ricolleghi da solo appena torna.');
      break;
    case 'sdp': case 'ice':
      if (!peer) createPeer();
      peer.handle(m);
      break;
    case 'status': onHostStatus(m); break;
    case 'chat': addChat(m); break;
    case 'kicked': end('Sei stato rimosso dallo studio', 'La regia ti ha fatto uscire.'); break;
  }
}

function onSignalStatus(st, code) {
  if (code === 4003) end('Link non valido', 'Questo link invito non funziona più. Chiedi un nuovo link a chi ti ha invitato.');
  if (code === 4001) end('Il link è cambiato', 'La regia ha creato un nuovo link invito. Chiedi quello nuovo.');
}

function createPeer() {
  peer = new Peer({
    polite: false,
    iceServers,
    opus: 'maxaveragebitrate=96000;useinbandfec=1',
    send: (msg) => signal.send(msg),
    beforeAnswer: addLocalTracks,
    onTrack: (e) => {
      const v = $('#prog');
      if (v.srcObject !== e.streams[0]) {
        v.srcObject = e.streams[0];
        v.play().catch(() => {
          $('#tap').classList.remove('hidden');
          $('#tapBtn').onclick = () => { v.play(); $('#tap').classList.add('hidden'); };
        });
      }
      $('#waiting').classList.add('hidden');
    },
    onState: (st) => {
      if (st === 'connected') { sendMeta(); setBitrates(); }
      if (st === 'failed' || st === 'disconnected') showWaiting('Connessione instabile…', 'Provo a ricollegarmi.');
      if (st === 'connected') $('#waiting').classList.add('hidden');
    },
  });
}

function resetPeer() {
  peer?.close();
  peer = null;
  $('#prog').srcObject = null;
}

function addLocalTracks() {
  const has = (t) => peer.pc.getSenders().some((s) => s.track === t);
  for (const t of cam.getTracks()) if (!has(t)) peer.pc.addTrack(t, cam);
  if (screen) for (const t of screen.getTracks()) if (!has(t)) peer.pc.addTrack(t, screen);
  sendMeta();
}

function sendMeta() {
  const v = cam.getVideoTracks()[0], a = cam.getAudioTracks()[0];
  signal?.send({ type: 'meta', name: myName, cam: cam.id, screen: screen?.id || null, camOff: !v || !v.enabled, micOff: !a || !a.enabled });
}

async function setBitrates() {
  if (!peer) return;
  for (const s of peer.pc.getSenders()) {
    if (s.track?.kind !== 'video') continue;
    const p = s.getParameters();
    if (!p.encodings?.length) continue;
    const isScreen = screen?.getVideoTracks().includes(s.track);
    p.encodings[0].maxBitrate = isScreen ? 3_000_000 : 2_500_000;
    if (isScreen) p.degradationPreference = 'maintain-resolution';
    try { await s.setParameters(p); } catch {}
  }
}

function showWaiting(title, sub) {
  const w = $('#waiting');
  w.innerHTML = `<div><b>${title}</b>${sub}</div>`;
  w.classList.remove('hidden');
}

function onHostStatus(m) {
  const pill = $('#airPill');
  pill.className = 'pill' + (m.onAir ? ' live' : '');
  pill.innerHTML = `<span class="dot"></span>${m.onAir ? 'SEI IN ONDA' : 'BACKSTAGE'}`;
  if (m.rec && recSession !== m.rec.session) startRec(m.rec);
  if (!m.rec && recSession) stopRec();
}

// ---------- registrazione locale in qualità piena ----------
let recDest = 'drive';
function startRec(rec) {
  stopRec();
  recSession = rec.session;
  recDest = rec.dest;
  recStart('cam', cam, myName);
  if (screen) recStart('screen', screen, `${myName}_schermo`);
  $('#recPill').classList.remove('hidden');
}

function recStart(kind, stream, name) {
  const session = recSession;
  const makeSink = (part, type) => {
    if (recDest === 'local') return Promise.resolve(new RemoteSink((m) => signal.send(m), `${session}|${kind}|${part}|${type.ext}`));
    // Drive: la regia apre il file sul suo Drive e ci manda l'indirizzo dove caricarlo
    return new Promise((resolve, reject) => {
      urlWaiters.set(kind, { session, resolve: (url) => resolve(new DriveSink(url)), reject });
      signal.send({ type: 'rec-request', kind, session, ext: type.ext, mime: type.base });
      setTimeout(() => { if (urlWaiters.get(kind)?.session === session) { urlWaiters.delete(kind); reject(new Error('La regia non risponde')); } }, 30000);
    });
  };
  const r = new ChunkRecorder({
    stream, makeSink, partMs: recDest === 'local' ? PART_MS : 0,
    videoBitsPerSecond: recDest === 'local' ? 4_000_000 : 6_000_000,
    onStatus: (st) => signal.send({ type: 'rec-status', kind, ...st }),
  });
  r.start();
  recs.set(kind, r);
}

function stopRec() {
  urlWaiters.clear();
  for (const r of recs.values()) r.stop();
  recs.clear();
  recSession = null;
  $('#recPill').classList.add('hidden');
}

// ---------- condivisione schermo ----------
async function toggleScreen() {
  if (screen) return stopScreen();
  try {
    const st = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true, selfBrowserSurface: 'exclude' });
    screen = st;
    st.getVideoTracks()[0].contentHint = 'detail';
    st.getVideoTracks()[0].onended = stopScreen;
    if (peer) for (const t of st.getTracks()) peer.pc.addTrack(t, st);
    sendMeta();
    setTimeout(setBitrates, 1500);
    if (recSession) recStart('screen', st, `${myName}_schermo`);
  } catch (e) {
    if (e.name !== 'NotAllowedError') alert('Condivisione schermo non riuscita: ' + e.message);
  }
  renderBar();
}

function stopScreen() {
  if (!screen) return;
  recs.get('screen')?.stop(); recs.delete('screen');
  if (peer) for (const s of peer.pc.getSenders()) if (s.track && screen.getTracks().includes(s.track)) peer.pc.removeTrack(s);
  screen.getTracks().forEach((t) => t.stop());
  screen = null;
  sendMeta();
  renderBar();
}

// ---------- barra controlli ----------
function renderBar() {
  const a = cam.getAudioTracks()[0], v = cam.getVideoTracks()[0];
  const set = (id, ic, label, off) => { const b = $(id); b.innerHTML = icon(ic, 20) + `<span class="lbl">${label}</span>`; b.classList.toggle('off', Boolean(off)); };
  set('#micBtn', a?.enabled ? 'mic' : 'micOff', a?.enabled ? 'Microfono' : 'Mic spento', !a?.enabled);
  set('#camBtn', v?.enabled ? 'cam' : 'camOff', v?.enabled ? 'Camera' : 'Camera spenta', !v?.enabled);
  set('#screenBtn', 'screen', screen ? 'Ferma schermo' : 'Condividi schermo', false);
  $('#screenBtn').classList.toggle('on', Boolean(screen));
  set('#chatBtn', 'chat', 'Chat', false);
  set('#leaveBtn', 'leave', 'Esci', false);
  $('#micBtn').disabled = !a; $('#camBtn').disabled = !v;
}
$('#micBtn').onclick = () => { const t = cam.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; renderBar(); sendMeta(); } };
$('#camBtn').onclick = () => { const t = cam.getVideoTracks()[0]; if (t) { t.enabled = !t.enabled; renderBar(); sendMeta(); } };
$('#screenBtn').onclick = toggleScreen;
$('#chatBtn').onclick = () => $('#roomMain').classList.toggle('nochat');
$('#leaveBtn').onclick = async () => {
  if (!confirm('Vuoi uscire dallo studio?')) return;
  await leave();
  end('Sei uscito dallo studio', 'Grazie per aver partecipato!');
};

async function leave() {
  const pending = [...recs.values()];
  stopRec();
  // aspetta che la registrazione finisca di caricarsi
  if (pending.length) {
    showWaiting('Salvo la registrazione…', 'Non chiudere la pagina, ci vuole poco.');
    await Promise.all(pending.map((r) => r.drain(150_000)));
  }
  signal?.close();
  peer?.close();
  cam?.getTracks().forEach((t) => t.stop());
  screen?.getTracks().forEach((t) => t.stop());
}

function end(title, sub) {
  $('#endedTitle').textContent = title;
  $('#endedSub').textContent = sub;
  $('#ended').classList.remove('hidden');
  signal?.close();
  peer?.close();
}

window.addEventListener('beforeunload', (e) => {
  if ([...recs.values()].some((r) => r.pending)) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- chat ----------
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  signal.send({ type: 'chat', text });
  $('#chatInput').value = '';
};

function addChat(m) {
  const list = $('#chatList');
  const d = document.createElement('div');
  d.className = 'chat-msg' + (m.host ? ' host' : '');
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const time = new Date(m.ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  d.innerHTML = `<b>${esc(m.from)} · ${time}</b><p>${esc(m.text)}</p>`;
  list.append(d);
  list.scrollTop = list.scrollHeight;
}
