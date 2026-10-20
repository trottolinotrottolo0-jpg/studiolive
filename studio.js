import { HostSignal } from './lib/net.js';
import { Peer } from './lib/peer.js';
import { Mixer } from './lib/mixer.js';
import { Compositor } from './lib/compositor.js';
import { ChunkRecorder, DriveSink, LocalSink, sessionName, safeName } from './lib/recorder.js';
import { icon, layoutIcon } from './lib/icons.js';
import { CONFIG, BASE } from './lib/config.js';
import { getUser, logout, Drive } from './lib/google.js';
import { loadJSON, saveJSON, idbGet, idbSet, idbDel, randKey } from './lib/store.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------- accesso obbligatorio ----------
const USER = getUser();
if (!USER) { location.replace('index.html' + location.search); throw new Error('accesso richiesto'); }
const SKEY = `studiolive:settings:${USER.sub}`;
const drive = new Drive(USER);
let recDir = null; // cartella scelta sul computer (FileSystemDirectoryHandle)
const PART_MS = 30 * 60 * 1000;

// ---------- impostazioni (salvate nel browser, per account) ----------
const DEFAULTS = {
  hostName: (USER.name || 'Tony').split(' ')[0],
  room: '', hostKey: '', guestKey: '',
  recProgram: true, recPeople: true, recDest: 'drive',
  brand: { color: '#ff3b30', textColor: '#ffffff', bgColor: '#0e1014', radius: 18, logo: null, bgImage: null, overlay: null },
  banners: [{ id: 'b1', title: 'Benvenuti in diretta!', sub: 'Scrivete le vostre domande in chat' }],
  ticker: '',
  pauseText: 'Torniamo subito',
  master: 100,
  camId: '',
  micId: '',
};
let S = structuredClone(DEFAULTS);
let saveTimer;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveJSON(SKEY, S), 300);
};

// ---------- stato della regia ----------
const live = { layout: 'auto', spotlightId: null, showNames: true, bannerId: null, bannerAt: 0, tickerOn: false, tickerAt: 0, pause: false, rec: null, monitor: true };
const sources = new Map(); // id -> sorgente (camera o schermo di qualcuno)
const order = [];          // ordine delle sorgenti in onda
const peers = new Map();   // id -> ospite o OBS
const recorders = new Map();
const imgs = { logo: null, bgImage: null, overlay: null };
const assetUrls = {};
const remoteSinks = new Map(); // file che gli ospiti mandano alla regia (salvataggio su cartella)
const sessionDirs = new Map();
const urlWaiters = new Map();
let info = {};
let mixer, comp, programVideo, iceServers, signal;
let hostCam = null, hostScreen = null;

// ---------- avvio ----------
renderIcons();
$('#startBtn').onclick = async () => {
  $('#startBtn').disabled = true;
  try {
    const saved = loadJSON(SKEY, {});
    S = { ...structuredClone(DEFAULTS), ...saved, brand: { ...DEFAULTS.brand, ...(saved.brand || {}) } };
    if (!S.room) { S.room = randKey(10); S.hostKey = randKey(); S.guestKey = randKey(); }
    saveJSON(SKEY, S);
    recDir = (await idbGet(`dir:${USER.sub}`)) || null;
    mixer = new Mixer();
    await mixer.resume();
    mixer.setMaster(S.master / 100);
    comp = new Compositor($('#program'));
    programVideo = $('#program').captureStream(30).getVideoTracks()[0];
    programVideo.contentHint = 'motion';
    await openHostCam();
    await Promise.all(Object.keys(imgs).map(loadImg));
    buildUI();
    startLoop();
    iceServers = CONFIG.iceServers;
    signal = new HostSignal({
      room: S.room, keys: { host: S.hostKey, guest: S.guestKey }, onMessage,
      onStatus: (st) => {
        if (st === 'open') setInfo();
        if (st === 'taken') { $('#inviteText').textContent = 'Regia già aperta altrove'; toast('La regia è già aperta in un’altra finestra o su un altro computer. Chiudi quella e ricarica.', 8000); }
        if (st === 'reconnecting') $('#inviteText').textContent = 'Riconnessione in corso…';
      },
    });
    $('#startScrim').remove();
  } catch (e) {
    console.error(e);
    $('#startErr').textContent = 'Non riesco ad avviare: ' + (e.message || e) + '. Controlla i permessi di camera e microfono.';
    $('#startBtn').disabled = false;
  }
};

async function getMedia(camId, micId) {
  const audio = { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const video = { deviceId: camId ? { exact: camId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  try { return await navigator.mediaDevices.getUserMedia({ audio, video }); } catch (e) {
    if (camId || micId) return getMedia('', '');
    if (e.name === 'NotFoundError' || e.name === 'NotReadableError' || e.name === 'OverconstrainedError') {
      toast('Videocamera non disponibile: entro solo con il microfono.');
      return navigator.mediaDevices.getUserMedia({ audio });
    }
    throw e;
  }
}

async function openHostCam() {
  const old = hostCam;
  hostCam = await getMedia(S.camId, S.micId);
  old?.getTracks().forEach((t) => t.stop());
  const s = upsertSource({ id: 'host:cam', owner: 'host', kind: 'cam', name: S.hostName, stream: hostCam, mirror: true });
  if (!old) setOnAir(s, true);
  // le tracce nuove vanno anche nei mix degli ospiti: aggiornati da upsertSource tramite mixer
  updateHostButtons();
  fillDevices();
}

// ---------- sorgenti ----------
const audioKey = (st) => st.getAudioTracks().map((t) => t.id).join(',');

function upsertSource({ id, owner, kind, name, stream, mirror = false }) {
  let s = sources.get(id);
  if (!s) {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.autoplay = true;
    $('#mediaPool').append(video);
    s = { id, owner, kind, name, stream: null, video, onAir: false, volume: 1, muted: false, mirror, camOff: false, micOff: false, audioKey: null, level: 0 };
    sources.set(id, s);
    createCard(s);
  }
  if (s.stream !== stream) {
    s.stream = stream;
    s.video.srcObject = stream; s.video.play().catch(() => {});
    s.card.video.srcObject = stream; s.card.video.play().catch(() => {});
  }
  if (s.audioKey !== audioKey(stream)) {
    s.audioKey = audioKey(stream);
    mixer.addSource(id, stream, owner);
    mixer.set(id, { volume: s.volume, muted: s.muted, onAir: s.onAir });
    if (owner !== 'host') setMonitor(s);
  }
  updateCard(s);
  renderCounts();
  return s;
}

function removeSource(id) {
  const s = sources.get(id);
  if (!s) return;
  recorders.get(id)?.stop(); recorders.delete(id);
  mixer.removeSource(id);
  if (s.monitor) { s.monitor.srcObject = null; s.monitor = null; }
  s.video.remove(); s.card.el.remove();
  const i = order.indexOf(id); if (i >= 0) order.splice(i, 1);
  if (live.spotlightId === id) live.spotlightId = null;
  sources.delete(id);
  if (s.owner !== 'host') sendStatus(s.owner);
  renderCounts();
}

function setOnAir(s, on) {
  s.onAir = on;
  const i = order.indexOf(s.id);
  if (on && i < 0) order.push(s.id);
  if (!on && i >= 0) order.splice(i, 1);
  mixer.set(s.id, { onAir: on });
  updateCard(s);
  renderCounts();
  if (s.owner !== 'host') sendStatus(s.owner);
}

function setMonitor(s) {
  if (!s.monitor) { s.monitor = new Audio(); s.monitor.autoplay = true; }
  if (s.monitor.srcObject !== s.stream) { s.monitor.srcObject = s.stream; s.monitor.play().catch(() => {}); }
  s.monitor.muted = !live.monitor || s.muted;
  s.monitor.volume = Math.min(1, s.volume);
}

// ---------- ospiti e OBS ----------
function onMessage(m) {
  switch (m.type) {
    case 'welcome':
      $('#chatList').innerHTML = '';
      m.chat.forEach((c) => addChat(c, true));
      for (const id of [...peers.keys()]) dropPeer(id);
      m.peers.forEach(addPeer);
      break;
    case 'peer-join': addPeer(m); break;
    case 'peer-leave': dropPeer(m.id); break;
    case 'chat': addChat(m); break;
    case 'sdp': case 'ice': peers.get(m.from)?.peer.handle(m); break;
    case 'meta': onMeta(m.from, m); break;
    case 'rec-status': onRecStatus(m.from, m); break;
    case 'rec-request': onRecRequest(m.from, m); break;
    case 'rec-chunk': onRemoteChunk(m.from, m); break;
    case 'rec-end': onRemoteEnd(m.from, m); break;
  }
}

function addPeer({ id, role, name }) {
  if (peers.has(id)) dropPeer(id);
  const p = { id, role, name, streams: new Map(), meta: {}, rec: null, state: 'new' };
  p.peer = new Peer({
    polite: true,
    iceServers,
    opus: 'maxaveragebitrate=128000;useinbandfec=1',
    send: (msg) => signal.send({ ...msg, to: id }),
    onTrack: (e) => onTrack(p, e),
    onState: (st) => onPeerState(p, st),
  });
  const pc = p.peer.pc;
  if (role === 'output') {
    // OBS: immagine piena 1080p + audio della diretta in stereo
    const out = new MediaStream([programVideo, mixer.programTrack]);
    const tv = pc.addTransceiver(programVideo, { direction: 'sendonly', streams: [out], sendEncodings: [{ maxBitrate: 12_000_000, maxFramerate: 30 }] });
    preferH264(tv);
    pc.addTransceiver(mixer.programTrack, { direction: 'sendonly', streams: [out] });
  } else {
    // ospite: anteprima leggera della diretta + audio di tutti gli altri (senza la sua voce)
    const talk = mixer.addListener(id);
    const ret = new MediaStream([programVideo, talk]);
    pc.addTransceiver(programVideo, { direction: 'sendrecv', streams: [ret], sendEncodings: [{ maxBitrate: 900_000, scaleResolutionDownBy: 3, maxFramerate: 20 }] });
    pc.addTransceiver(talk, { direction: 'sendrecv', streams: [ret] });
  }
  peers.set(id, p);
  updateObsPill();
  renderCounts();
}

function preferH264(tr) {
  try {
    const codecs = RTCRtpSender.getCapabilities('video').codecs;
    const h264 = codecs.filter((c) => c.mimeType === 'video/H264');
    if (h264.length) tr.setCodecPreferences([...h264, ...codecs.filter((c) => c.mimeType !== 'video/H264')]);
  } catch {}
}

function dropPeer(id) {
  const p = peers.get(id);
  if (!p) return;
  p.peer.close();
  removeSource(`${id}:cam`);
  removeSource(`${id}:screen`);
  mixer.removeListener(id);
  peers.delete(id);
  updateObsPill();
  renderCounts();
}

function onTrack(p, e) {
  const st = e.streams[0];
  if (!st) return;
  p.streams.set(st.id, st);
  st.onremovetrack = () => reconcile(p);
  e.track.onended = () => reconcile(p);
  reconcile(p);
}

function onMeta(id, m) {
  const p = peers.get(id);
  if (!p) return;
  if (m.name) p.name = String(m.name).slice(0, 40);
  p.meta = { ...p.meta, cam: m.cam, screen: m.screen, camOff: m.camOff, micOff: m.micOff };
  reconcile(p);
}

function reconcile(p) {
  for (const kind of ['cam', 'screen']) {
    const sid = p.meta[kind];
    const st = sid && p.streams.get(sid);
    const id = `${p.id}:${kind}`;
    const alive = st && st.getTracks().some((t) => t.readyState === 'live');
    if (alive) upsertSource({ id, owner: p.id, kind, name: kind === 'screen' ? `Schermo · ${p.name}` : p.name, stream: st });
    else if (sources.has(id)) removeSource(id);
  }
  const cam = sources.get(`${p.id}:cam`);
  if (cam) { cam.camOff = Boolean(p.meta.camOff); cam.micOff = Boolean(p.meta.micOff); updateCard(cam); }
}

function onPeerState(p, st) {
  p.state = st;
  if (p.role === 'output') {
    // per OBS meglio perdere qualche fotogramma che la risoluzione
    if (st === 'connected') for (const s of p.peer.pc.getSenders()) {
      if (s.track?.kind !== 'video') continue;
      const prm = s.getParameters();
      prm.degradationPreference = 'maintain-resolution';
      s.setParameters(prm).catch(() => {});
    }
    return updateObsPill();
  }
  if (st === 'connected') sendStatus(p.id);
  const cam = sources.get(`${p.id}:cam`);
  if (cam) updateCard(cam);
}

function sendStatus(peerId) {
  const p = peers.get(peerId);
  if (!p || p.role !== 'guest') return;
  const onAir = Boolean(sources.get(`${peerId}:cam`)?.onAir || sources.get(`${peerId}:screen`)?.onAir);
  const r = live.rec;
  signal.send({ to: peerId, type: 'status', onAir, rec: r && r.people ? { session: r.session, dest: r.dest } : null });
}

function onRecStatus(id, m) {
  const p = peers.get(id);
  if (!p) return;
  p.rec = m;
  const cam = sources.get(`${id}:cam`);
  if (cam) updateCard(cam);
}

function updateObsPill() {
  const pill = $('#obsPill');
  const outs = [...peers.values()].filter((p) => p.role === 'output');
  const ok = outs.some((p) => p.state === 'connected');
  pill.className = 'pill' + (ok ? ' ok' : outs.length ? ' warn' : '');
  pill.innerHTML = `<span class="dot"></span>${ok ? 'OBS collegato' : outs.length ? 'OBS in collegamento…' : 'OBS non collegato'}`;
  document.body.classList.toggle('live', ok);
  $('#pgmState').textContent = ok ? '● In onda su OBS' : 'Anteprima · OBS non collegato';
  const so = $('#statObs');
  so.textContent = ok ? 'Collegata' : outs.length ? 'Collego…' : 'Spenta';
  so.className = ok ? 'ok' : '';
}

// ---------- registrazione: diretta completa e/o ogni persona, su Google Drive o su una cartella ----------
async function startRec() {
  const session = sessionName();
  const dest = S.recDest;
  if (!S.recProgram && !S.recPeople) return toast('Scegli cosa registrare.');
  try {
    let target;
    if (dest === 'drive') {
      await drive.ensure();
      target = { folderId: await drive.sessionFolder(session) };
    } else {
      if (!recDir) throw new Error('Scegli prima la cartella dove salvare.');
      if ((await recDir.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Permesso sulla cartella negato.');
      target = { dir: await recDir.getDirectoryHandle(session, { create: true }) };
      sessionDirs.set(session, target.dir);
    }
    live.rec = { session, dest, startedAt: Date.now(), program: S.recProgram, people: S.recPeople, ...target };
  } catch (e) {
    console.error(e);
    return toast('Non riesco ad avviare la registrazione: ' + e.message, 6000);
  }
  closeRecDialog();
  if (live.rec.program) {
    startRecorder('program', new MediaStream([programVideo, mixer.programTrack]), 'DIRETTA', 8_000_000, (st) => { live.programRec = st; updateRecUI(); });
  }
  if (live.rec.people) for (const s of sources.values()) if (s.owner === 'host') startHostRecorder(s);
  for (const id of peers.keys()) sendStatus(id);
  updateRecUI();
  toast(dest === 'drive' ? `Registro su Google Drive → StudioLive/${session}` : `Registro in ${recDir.name}/${session}`);
}

function stopRec() {
  const done = [...recorders.values()];
  for (const r of done) r.stop();
  recorders.clear();
  const rec = live.rec;
  live.rec = null;
  for (const id of peers.keys()) sendStatus(id);
  updateRecUI();
  toast('Registrazione fermata: finisco di salvare i file…');
  Promise.all(done.map((r) => r.drain())).then(() => {
    const err = done.find((r) => r.error);
    if (err) return toast('Attenzione: un file non è stato salvato bene (' + err.error + ').', 8000);
    toast(rec.dest === 'drive' ? 'Registrazione salvata su Google Drive ✓' : 'Registrazione salvata nella cartella ✓', 5000);
  });
}

function makeSinkFor(name) {
  const rec = live.rec;
  return async (part, type) => {
    if (rec.dest === 'drive') return new DriveSink(await drive.createUpload(`${name}.${type.ext}`, type.base, rec.folderId));
    return new LocalSink(rec.dir, `${name}_parte${String(part).padStart(2, '0')}.${type.ext}`);
  };
}

function startRecorder(id, stream, name, bitrate, onStatus) {
  if (!live.rec || recorders.has(id)) return;
  const r = new ChunkRecorder({ stream, makeSink: makeSinkFor(safeName(name)), partMs: live.rec.dest === 'local' ? PART_MS : 0, videoBitsPerSecond: bitrate, onStatus });
  r.start();
  recorders.set(id, r);
}

function startHostRecorder(s) {
  if (!live.rec?.people || !s.stream) return;
  startRecorder(s.id, s.stream, s.kind === 'screen' ? `${S.hostName}_schermo` : S.hostName, 6_000_000, (st) => { s.recStatus = st; updateCard(s); });
}

// l'ospite chiede dove caricare il suo file su Drive
async function onRecRequest(from, m) {
  const p = peers.get(from);
  const rec = live.rec;
  if (!p || !rec || rec.dest !== 'drive' || m.session !== rec.session) return;
  try {
    const name = safeName(p.name) + (m.kind === 'screen' ? '_schermo' : '');
    const url = await drive.createUpload(`${name}.${m.ext}`, m.mime, rec.folderId);
    signal.send({ to: from, type: 'rec-url', kind: m.kind, session: rec.session, url });
  } catch (e) {
    signal.send({ to: from, type: 'rec-url', kind: m.kind, session: rec.session, error: e.message });
  }
}

// l'ospite manda i pezzi alla regia, che li scrive nella cartella scelta
function onRemoteChunk(from, m) {
  const id = `${from}|${m.key}`;
  let w = remoteSinks.get(id);
  if (!w) {
    const [session, kind, part, ext] = String(m.key).split('|');
    const dir = sessionDirs.get(session);
    if (!dir) return;
    const p = peers.get(from);
    const name = `${safeName(p?.name)}${kind === 'screen' ? '_schermo' : ''}_parte${String(part).padStart(2, '0')}.${safeName(ext)}`;
    w = { sink: new LocalSink(dir, name), p: Promise.resolve() };
    remoteSinks.set(id, w);
  }
  const blob = new Blob([m.data]);
  w.p = w.p.then(() => w.sink.write(blob)).catch((e) => console.error('scrittura file ospite', e));
}

function onRemoteEnd(from, m) {
  const id = `${from}|${m.key}`;
  const w = remoteSinks.get(id);
  if (!w) return;
  w.p = w.p.then(() => w.sink.close()).catch(() => {});
  remoteSinks.delete(id);
}

// ---------- finestra REC / impostazioni registrazione ----------
function openRecDialog() {
  renderRecSettings($('#recDialogBody'));
  $('#recScrim').classList.remove('hidden');
}
function closeRecDialog() { $('#recScrim').classList.add('hidden'); }

function renderRecSettings(box) {
  if (!box) return;
  const canLocal = 'showDirectoryPicker' in window;
  box.innerHTML = `
    <div class="rs-group">
      <span class="rs-label">Cosa registrare</span>
      <label class="check"><input type="checkbox" data-k="recProgram" ${S.recProgram ? 'checked' : ''}><span><b>La diretta completa</b><small>Quello che va su OBS: layout, banner, audio mixato</small></span></label>
      <label class="check"><input type="checkbox" data-k="recPeople" ${S.recPeople ? 'checked' : ''}><span><b>Ogni persona su un file separato</b><small>In qualità piena, perfetto per il montaggio</small></span></label>
    </div>
    <div class="rs-group">
      <span class="rs-label">Dove salvare</span>
      <label class="dest ${S.recDest === 'drive' ? 'on' : ''}"><input type="radio" name="dest-${box.id}" value="drive" ${S.recDest === 'drive' ? 'checked' : ''}>
        <span class="dest-ic">${driveIcon()}</span>
        <span><b>Google Drive</b><small>${drive.connected ? `Collegato · ${escapeHtml(drive.email || USER.email)}` : 'Il tuo Drive, cartella “StudioLive”'}</small></span>
        <button class="btn sm drive-btn" type="button">${drive.connected ? 'Scollega' : 'Collega'}</button>
      </label>
      <label class="dest ${S.recDest === 'local' ? 'on' : ''} ${canLocal ? '' : 'off'}"><input type="radio" name="dest-${box.id}" value="local" ${S.recDest === 'local' ? 'checked' : ''} ${canLocal ? '' : 'disabled'}>
        <span class="dest-ic">${icon('screen', 18)}</span>
        <span><b>Cartella sul computer</b><small>${canLocal ? (recDir ? `📁 ${escapeHtml(recDir.name)}` : 'Es. TONY DISK 2 · file nuovo ogni 30 min') : 'Solo con Chrome o Edge'}</small></span>
        ${canLocal ? '<button class="btn sm dir-btn" type="button">Scegli</button>' : ''}
      </label>
    </div>`;
  for (const c of $$('input[type=checkbox]', box)) c.onchange = () => { S[c.dataset.k] = c.checked; save(); syncRecSettings(); };
  for (const r of $$('input[type=radio]', box)) r.onchange = () => { S.recDest = r.value; save(); syncRecSettings(); };
  $('.drive-btn', box).onclick = async (e) => {
    e.preventDefault();
    try {
      if (drive.connected) drive.disconnect(); else { await drive.connect('consent'); S.recDest = 'drive'; save(); toast('Google Drive collegato ✓'); }
    } catch (err) { toast('Drive: ' + err.message, 6000); }
    syncRecSettings();
  };
  const dirBtn = $('.dir-btn', box);
  if (dirBtn) dirBtn.onclick = async (e) => {
    e.preventDefault();
    try {
      recDir = await window.showDirectoryPicker({ id: 'studiolive-rec', mode: 'readwrite' });
      await idbSet(`dir:${USER.sub}`, recDir);
      S.recDest = 'local'; save();
    } catch (err) { if (err.name !== 'AbortError') toast('Cartella: ' + err.message); }
    syncRecSettings();
  };
}

function syncRecSettings() {
  renderRecSettings($('#recSettings'));
  if (!$('#recScrim').classList.contains('hidden')) renderRecSettings($('#recDialogBody'));
}

const driveIcon = () => '<svg width="18" height="18" viewBox="0 0 87.3 78" aria-hidden="true"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/><path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/><path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg>';

function updateRecUI() {
  const b = $('#recBtn');
  b.classList.toggle('recording', Boolean(live.rec));
  $('#recLabel').textContent = live.rec ? 'REC 00:00' : 'REC';
  $('#statRec').textContent = live.rec ? '00:00' : 'Ferma';
  $('#statRecDest').textContent = live.rec ? (live.rec.dest === 'drive' ? 'su Google Drive' : `in ${recDir?.name || 'cartella'}`) : (S.recDest === 'drive' ? 'Google Drive' : 'Cartella');
  if (live.programRec?.error) $('#statRecDest').textContent = '⚠ ' + live.programRec.error;
  $('#statRec').className = live.rec ? 'live' : '';
  $('#camSelect').disabled = $('#micSelect').disabled = Boolean(live.rec);
  for (const s of sources.values()) updateCard(s);
}

function updateRecTimer() {
  $('#clock').textContent = new Date().toLocaleTimeString('it-IT');
  if (!live.rec) return;
  const t = Math.floor((Date.now() - live.rec.startedAt) / 1000);
  const z = (n) => String(n).padStart(2, '0');
  const dur = `${t >= 3600 ? Math.floor(t / 3600) + ':' : ''}${z(Math.floor(t / 60) % 60)}:${z(t % 60)}`;
  $('#recLabel').textContent = `REC ${dur}`;
  $('#statRec').textContent = dur;
}

// ---------- disegno della diretta ----------
function startLoop() {
  // timer in un Worker: non viene rallentato come requestAnimationFrame
  const w = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 1000 / 30)'], { type: 'text/javascript' })));
  let frame = 0;
  w.onmessage = () => { frame++; tick(frame); };
}

function activeBanner() {
  const b = S.banners.find((x) => x.id === live.bannerId);
  return b ? { title: b.title, sub: b.sub, shownAt: live.bannerAt } : null;
}

function tick(frame) {
  const now = performance.now();
  for (const s of sources.values()) s.level = mixer.level(s.id);
  const onAir = order.map((id) => sources.get(id)).filter(Boolean);
  comp.draw({
    layout: live.layout,
    spotlightId: live.spotlightId,
    showNames: live.showNames,
    sources: onAir.map((s) => ({ id: s.id, name: s.name, kind: s.kind, video: s.video, camOff: s.camOff, speaking: s.muted || s.micOff ? 0 : Math.max(0, (s.level - 0.5) * 3) })),
    brand: { ...S.brand, logo: imgs.logo, bgImage: imgs.bgImage, overlay: imgs.overlay },
    banner: activeBanner(),
    ticker: live.tickerOn && S.ticker.trim() ? { text: S.ticker.trim(), shownAt: live.tickerAt } : null,
    pause: live.pause ? { text: S.pauseText || 'Torniamo subito' } : null,
  }, now);
  if (frame % 2 === 0) {
    for (const s of sources.values()) s.card.meter.style.width = `${Math.round(s.level * 100)}%`;
    $('#masterMeter').style.width = `${Math.round(mixer.masterLevel() * 100)}%`;
  }
  if (frame % 15 === 0) updateRecTimer();
}

// ---------- interfaccia ----------
function renderIcons(root = document) {
  for (const el of $$('[data-icon]', root)) {
    el.outerHTML = icon(el.dataset.icon, el.closest('.tabs') ? 20 : 16);
  }
}

function toast(text, ms = 3200) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copiato`); }
  catch { prompt(`Copia ${what.toLowerCase()}:`, text); }
}

function setInfo() {
  info = {
    inviteUrl: `${BASE}join.html?r=${S.room}&k=${S.guestKey}`,
    outputUrl: `${BASE}output.html?r=${S.room}&k=${S.hostKey}`,
  };
  $('#inviteText').textContent = info.inviteUrl;
  $('#copyInvite').disabled = false;
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildUI() {
  // barra in alto
  $('#copyInvite').onclick = () => info.inviteUrl && copy(info.inviteUrl, 'Link ospiti');
  $('#copyObs').onclick = () => info.outputUrl ? copy(info.outputUrl, 'Link OBS') : toast('Un attimo, mi sto collegando…');
  $('#recBtn').onclick = () => (live.rec ? stopRec() : openRecDialog());
  $('#recGo').onclick = startRec;
  $('#recCancel').onclick = closeRecDialog;
  $('#recScrim').onclick = (e) => { if (e.target.id === 'recScrim') closeRecDialog(); };
  renderRecSettings($('#recSettings'));
  drive.onChange(syncRecSettings);

  // utente
  $('#userChip').innerHTML = `${USER.picture ? `<img src="${escapeHtml(USER.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar">${escapeHtml((USER.name || '?')[0])}</span>`}<span class="un">${escapeHtml(USER.name)}</span>`;
  $('#userChip').onclick = () => $('#userMenu').classList.toggle('hidden');
  $('#userEmail').textContent = USER.email;
  $('#logoutBtn').onclick = async () => {
    if (live.rec && !confirm('Stai registrando: se esci la registrazione si interrompe. Esco lo stesso?')) return;
    await logout();
    location.href = 'index.html';
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('.user-wrap')) $('#userMenu').classList.add('hidden'); });

  // layout
  const LAYOUTS = [['auto', 'Auto'], ['solo', 'Solo'], ['side', 'Affiancati'], ['grid', 'Griglia'], ['spotlight', 'Relatore'], ['screen', 'Schermo']];
  $('#layouts').innerHTML = LAYOUTS.map(([k, l]) => `<button data-layout="${k}" class="${k === live.layout ? 'active' : ''}">${layoutIcon(k)}${l}</button>`).join('');
  for (const b of $$('#layouts button')) b.onclick = () => setLayout(b.dataset.layout);
  $('#namesToggle').onchange = (e) => { live.showNames = e.target.checked; };
  $('#pauseBtn').onclick = () => { live.pause = !live.pause; $('#pauseBtn').classList.toggle('on', live.pause); };

  // controlli tuoi
  $('#hostMic').onclick = () => {
    const t = hostCam?.getAudioTracks()[0]; if (!t) return;
    t.enabled = !t.enabled;
    const s = sources.get('host:cam'); s.micOff = !t.enabled; updateCard(s);
    updateHostButtons();
  };
  $('#hostCam').onclick = () => {
    const t = hostCam?.getVideoTracks()[0]; if (!t) return;
    t.enabled = !t.enabled;
    const s = sources.get('host:cam'); s.camOff = !t.enabled; updateCard(s);
    updateHostButtons();
  };
  $('#hostScreen').onclick = toggleHostScreen;

  // schede laterali
  for (const b of $$('#tabs button')) {
    b.onclick = () => {
      for (const x of $$('#tabs button')) x.classList.toggle('active', x === b);
      for (const p of $$('.tab')) p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab);
      if (b.dataset.tab === 'chat') { $('#chatBadge').classList.add('hidden'); $('#chatInput').focus(); }
    };
  }

  // banner
  renderBanners();
  $('#bannerForm').onsubmit = (e) => {
    e.preventDefault();
    const title = $('#bTitle').value.trim();
    if (!title) return $('#bTitle').focus();
    S.banners.push({ id: 'b' + Date.now().toString(36), title, sub: $('#bSub').value.trim() });
    $('#bTitle').value = $('#bSub').value = '';
    renderBanners(); save();
  };
  $('#tickerText').value = S.ticker;
  $('#tickerText').oninput = (e) => { S.ticker = e.target.value; save(); };
  $('#tickerToggle').onchange = (e) => { live.tickerOn = e.target.checked; live.tickerAt = performance.now(); };
  $('#pauseText').value = S.pauseText;
  $('#pauseText').oninput = (e) => { S.pauseText = e.target.value; save(); };

  // stile
  const SW = ['#ff3b30', '#ff2d55', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#5e5ce6', '#bf5af2', '#ffffff'];
  const renderSwatches = () => {
    $('#swatches').innerHTML = SW.map((c) => `<button style="background:${c}" data-c="${c}" class="${c === S.brand.color ? 'active' : ''}" title="${c}"></button>`).join('') + `<input type="color" id="customColor" value="${S.brand.color}" title="Colore personalizzato">`;
    for (const b of $$('#swatches button')) b.onclick = () => { S.brand.color = b.dataset.c; renderSwatches(); save(); };
    $('#customColor').oninput = (e) => { S.brand.color = e.target.value; save(); };
    $('#customColor').onchange = renderSwatches;
  };
  renderSwatches();
  $('#textColor').value = S.brand.textColor;
  $('#textColor').oninput = (e) => { S.brand.textColor = e.target.value; save(); };
  $('#bgColor').value = S.brand.bgColor;
  $('#bgColor').oninput = (e) => { S.brand.bgColor = e.target.value; save(); };
  $('#radius').value = S.brand.radius;
  $('#radius').oninput = (e) => { S.brand.radius = Number(e.target.value); save(); };
  for (const box of $$('.asset')) setupAsset(box);

  // chat
  $('#chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text) return;
    signal.send({ type: 'chat', text });
    $('#chatInput').value = '';
  };

  // impostazioni
  $('#hostName').value = S.hostName;
  $('#hostName').oninput = (e) => {
    S.hostName = e.target.value.trim() || 'Tony';
    const s = sources.get('host:cam');
    if (s && !s.customName) { s.name = S.hostName; s.card.name.value = s.name; }
    save();
  };
  $('#camSelect').onchange = async (e) => { S.camId = e.target.value; save(); await openHostCam(); };
  $('#micSelect').onchange = async (e) => { S.micId = e.target.value; save(); await openHostCam(); };
  $('#masterVol').value = S.master;
  $('#masterVol').oninput = (e) => { S.master = Number(e.target.value); mixer.setMaster(S.master / 100); save(); };
  $('#monitorToggle').onchange = (e) => { live.monitor = e.target.checked; for (const s of sources.values()) if (s.owner !== 'host') setMonitor(s); };
  $('#regenInvite').onclick = async () => {
    if (!confirm('Rigenero il link ospiti? Gli ospiti collegati vengono scollegati e il vecchio link smette di funzionare.')) return;
    S.guestKey = randKey(); save();
    signal.setKeys({ host: S.hostKey, guest: S.guestKey });
    setInfo();
    toast('Nuovo link ospiti pronto');
  };

  document.addEventListener('visibilitychange', () => $('#hiddenWarn').classList.toggle('hidden', !document.hidden));
  window.addEventListener('beforeunload', (e) => {
    if (live.rec || [...peers.values()].some((p) => p.role === 'output')) { e.preventDefault(); e.returnValue = ''; }
  });
  renderIcons();
  updateHostButtons();
  renderCounts();
  updateObsPill();
  document.addEventListener('input', (e) => { if (e.target.type === 'range') fillRange(e.target); });
  $$('input[type=range]').forEach(fillRange);
}

function fillRange(el) {
  const min = Number(el.min || 0), max = Number(el.max || 100);
  el.style.setProperty('--p', `${((Number(el.value) - min) / (max - min)) * 100}%`);
}

function setLayout(k) {
  live.layout = k;
  for (const b of $$('#layouts button')) b.classList.toggle('active', b.dataset.layout === k);
}

function updateHostButtons() {
  const a = hostCam?.getAudioTracks()[0], v = hostCam?.getVideoTracks()[0];
  $('#hostMic').innerHTML = icon(a?.enabled ? 'mic' : 'micOff', 16) + (a?.enabled ? 'Microfono' : 'Mic spento');
  $('#hostMic').classList.toggle('muted-on', !a?.enabled);
  $('#hostMic').disabled = !a;
  $('#hostCam').innerHTML = icon(v?.enabled ? 'cam' : 'camOff', 16) + (v?.enabled ? 'Camera' : 'Camera spenta');
  $('#hostCam').classList.toggle('muted-on', !v?.enabled);
  $('#hostCam').disabled = !v;
  $('#hostScreen').innerHTML = icon('screen', 16) + (hostScreen ? 'Ferma condivisione' : 'Condividi schermo');
  $('#hostScreen').classList.toggle('on', Boolean(hostScreen));
}

async function toggleHostScreen() {
  if (hostScreen) return stopHostScreen();
  try {
    const st = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include',
    });
    hostScreen = st;
    st.getVideoTracks()[0].contentHint = 'detail';
    st.getVideoTracks()[0].onended = stopHostScreen;
    const s = upsertSource({ id: 'host:screen', owner: 'host', kind: 'screen', name: 'Il tuo schermo', stream: st });
    setOnAir(s, true);
    startHostRecorder(s);
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('Condivisione schermo non riuscita: ' + e.message);
  }
  updateHostButtons();
}

function stopHostScreen() {
  hostScreen?.getTracks().forEach((t) => t.stop());
  hostScreen = null;
  removeSource('host:screen');
  updateHostButtons();
}

async function fillDevices() {
  const list = await navigator.mediaDevices.enumerateDevices();
  const camId = hostCam?.getVideoTracks()[0]?.getSettings().deviceId;
  const micId = hostCam?.getAudioTracks()[0]?.getSettings().deviceId;
  const opts = (kind, cur) => list.filter((d) => d.kind === kind).map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === cur ? 'selected' : ''}>${escapeHtml(d.label || `${kind === 'videoinput' ? 'Camera' : 'Microfono'} ${i + 1}`)}</option>`).join('');
  $('#camSelect').innerHTML = opts('videoinput', camId) || '<option>Nessuna camera</option>';
  $('#micSelect').innerHTML = opts('audioinput', micId) || '<option>Nessun microfono</option>';
}

function renderCounts() {
  const guests = [...peers.values()].filter((p) => p.role === 'guest').length;
  const onAir = order.length;
  $('#countLabel').textContent = `${guests} ${guests === 1 ? 'ospite' : 'ospiti'} · ${onAir} in onda`;
  $('#statGuests').textContent = guests;
  $('#statOnAir').textContent = onAir;
  $('#statOnAir').className = onAir ? 'live' : '';
  $('#stripEmpty').classList.toggle('hidden', guests > 0);
}

// ---------- schede sorgente (backstage) ----------
function createCard(s) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="thumb"><video muted playsinline autoplay class="${s.mirror ? 'mirror' : ''} ${s.kind === 'screen' ? 'contain' : ''}"></video><span class="tag"></span><div class="flags"></div></div>
    <div class="card-body">
      <div class="card-name">${icon(s.kind === 'screen' ? 'screen' : 'cam', 15)}<input class="nm" maxlength="40" title="Clicca per cambiare il nome in onda">
        <button class="btn sm icon ghost star" title="Metti in primo piano">${icon('star', 15)}</button>
        ${s.owner !== 'host' && s.kind === 'cam' ? `<button class="btn sm icon ghost kick" title="Rimuovi dallo studio">${icon('x', 15)}</button>` : ''}
      </div>
      <div class="meter"><i></i></div>
      <div class="card-ctrl"><button class="btn sm icon mute" title="Muta nella diretta"></button><input type="range" min="0" max="150" value="100" class="vol" title="Volume"><span class="vol-v muted" style="width:34px;text-align:right;font-size:12px">100%</span></div>
      <button class="btn sm air"></button>
    </div>`;
  s.card = { el, video: $('video', el), meter: $('.meter i', el), name: $('.nm', el) };
  s.card.name.value = s.name;
  fillRange($('.vol', el));
  s.card.name.onchange = (e) => {
    s.name = e.target.value.trim() || s.name; s.customName = true;
    if (s.id === 'host:cam') { S.hostName = s.name; $('#hostName').value = s.name; save(); }
  };
  $('.air', el).onclick = () => setOnAir(s, !s.onAir);
  $('.mute', el).onclick = () => { s.muted = !s.muted; mixer.set(s.id, { muted: s.muted }); if (s.monitor) setMonitor(s); updateCard(s); };
  $('.vol', el).oninput = (e) => {
    s.volume = Number(e.target.value) / 100;
    $('.vol-v', el).textContent = `${e.target.value}%`;
    mixer.set(s.id, { volume: s.volume });
    if (s.monitor) setMonitor(s);
  };
  $('.star', el).onclick = () => {
    live.spotlightId = live.spotlightId === s.id ? null : s.id;
    if (live.spotlightId) {
      if (!s.onAir) setOnAir(s, true);
      if (['auto', 'grid', 'side'].includes(live.layout)) setLayout(s.kind === 'screen' ? 'screen' : 'spotlight');
    }
    for (const x of sources.values()) updateCard(x);
  };
  const kick = $('.kick', el);
  if (kick) kick.onclick = () => { if (confirm(`Rimuovo ${s.name} dallo studio?`)) signal.send({ type: 'kick', id: s.owner }); };
  // l'host sempre per primo
  if (s.owner === 'host') $('#strip').prepend(el); else $('#strip').append(el);
}

function updateCard(s) {
  if (!s.card) return;
  const { el } = s.card;
  el.classList.toggle('onair', s.onAir);
  $('.tag', el).textContent = s.onAir ? 'IN ONDA' : 'BACKSTAGE';
  const air = $('.air', el);
  air.textContent = s.onAir ? 'Togli dalla diretta' : 'Aggiungi alla diretta';
  air.classList.toggle('primary', !s.onAir);
  const mute = $('.mute', el);
  mute.innerHTML = icon(s.muted ? 'micOff' : 'mic', 15);
  mute.classList.toggle('muted-on', s.muted);
  mute.title = s.muted ? 'Riattiva audio in diretta' : 'Muta nella diretta';
  $('.star', el).classList.toggle('on', live.spotlightId === s.id);

  const flags = [];
  const p = peers.get(s.owner);
  const rec = s.owner === 'host' ? s.recStatus : p?.rec;
  if (live.rec && rec) {
    if (rec.error) flags.push(`<span class="e" title="${escapeHtml(rec.error)}">⚠ REC</span>`);
    else if (rec.state === 'rec') flags.push(`<span class="r">● REC</span>`);
  } else if (!live.rec && rec?.state === 'saving') flags.push(`<span class="e">Salvo… ${rec.pending}</span>`);
  if (p && p.state !== 'connected') flags.push(`<span class="e">collegamento…</span>`);
  if (s.micOff) flags.push(`<span>${icon('micOff', 11)}</span>`);
  if (s.camOff) flags.push(`<span>${icon('camOff', 11)}</span>`);
  $('.flags', el).innerHTML = flags.join('');
}

// ---------- banner ----------
function renderBanners() {
  const list = $('#bannerList');
  list.innerHTML = S.banners.length ? '' : '<p class="hint">Nessun banner. Aggiungine uno qui sotto.</p>';
  for (const b of S.banners) {
    const it = document.createElement('div');
    it.className = 'banner-item' + (live.bannerId === b.id ? ' active' : '');
    it.innerHTML = `<div class="bt"><b>${escapeHtml(b.title)}</b>${b.sub ? `<small>${escapeHtml(b.sub)}</small>` : ''}</div>${live.bannerId === b.id ? '<span class="live">IN ONDA</span>' : ''}<button class="btn sm icon ghost del" title="Elimina">${icon('trash', 14)}</button>`;
    it.onclick = () => {
      live.bannerId = live.bannerId === b.id ? null : b.id;
      live.bannerAt = performance.now();
      renderBanners();
    };
    $('.del', it).onclick = (e) => {
      e.stopPropagation();
      S.banners = S.banners.filter((x) => x !== b);
      if (live.bannerId === b.id) live.bannerId = null;
      renderBanners(); save();
    };
    list.append(it);
  }
}

// ---------- immagini (logo, sfondo, overlay): restano nel browser ----------
const assetKey = (key) => `asset:${USER.sub}:${key}`;

async function loadImg(key) {
  if (assetUrls[key]) URL.revokeObjectURL(assetUrls[key]);
  assetUrls[key] = null; imgs[key] = null;
  if (!S.brand[key]) return;
  const blob = await idbGet(assetKey(key));
  if (!blob) { S.brand[key] = null; return; }
  assetUrls[key] = URL.createObjectURL(blob);
  const im = new Image();
  im.src = assetUrls[key];
  imgs[key] = im;
}

function setupAsset(box) {
  const key = box.dataset.asset;
  const prev = $('.asset-prev', box);
  const btns = $('.asset-btns', box);
  const render = () => {
    prev.style.backgroundImage = assetUrls[key] ? `url("${assetUrls[key]}")` : '';
    btns.innerHTML = `<button class="btn sm up">${assetUrls[key] ? 'Cambia' : 'Carica'}</button>${assetUrls[key] ? `<button class="btn sm icon rm" title="Rimuovi">${icon('trash', 14)}</button>` : ''}`;
    $('.up', btns).onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
      inp.onchange = async () => {
        const f = inp.files[0]; if (!f) return;
        if (f.size > 25e6) return toast('Immagine troppo grande (max 25 MB)');
        await idbSet(assetKey(key), f);
        S.brand[key] = true; save();
        await loadImg(key); render();
      };
      inp.click();
    };
    const rm = $('.rm', btns);
    if (rm) rm.onclick = async () => { await idbDel(assetKey(key)); S.brand[key] = null; save(); await loadImg(key); render(); };
  };
  render();
}

// ---------- chat ----------
function addChat(m, history = false) {
  const list = $('#chatList');
  const d = document.createElement('div');
  d.className = 'chat-msg' + (m.host ? ' host' : '');
  const time = new Date(m.ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  d.innerHTML = `<b>${escapeHtml(m.from)} · ${time}</b><p>${escapeHtml(m.text)}</p>`;
  list.append(d);
  list.scrollTop = list.scrollHeight;
  const chatOpen = $('#tabs button[data-tab="chat"]').classList.contains('active');
  if (!history && !chatOpen && !m.host) $('#chatBadge').classList.remove('hidden');
}
