// Accesso con Google (Google Identity Services) e Google Drive dell'utente (solo i file creati da StudioLive).
import { CONFIG, DRIVE_SCOPE, isDev } from './config.js';

const USER_KEY = 'studiolive:user';
const SESSION_DAYS = 30;

function loadGsi() {
  if (window.google?.accounts) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.onload = res; s.onerror = () => rej(new Error('Google non raggiungibile'));
    document.head.append(s);
  });
}

function decodeJwt(t) {
  const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(b))));
}

// ---------- accesso ----------
export function getUser() {
  if (isDev()) return { sub: 'dev', name: 'Tony (prova)', email: 'prova@localhost', picture: '' };
  try {
    const u = JSON.parse(localStorage.getItem(USER_KEY));
    if (u && u.until > Date.now()) return u;
  } catch {}
  return null;
}

let gsiReady = null;
let loginHandler = null;

export async function renderLogin(el, onLogin) {
  if (CONFIG.googleClientId.startsWith('__')) {
    el.innerHTML = '<p style="color:#ffb020">Manca l’ID client Google in <code>lib/config.js</code>.</p>';
    return;
  }
  loginHandler = onLogin;
  // inizializza una sola volta anche con più pulsanti nella pagina
  gsiReady ||= loadGsi().then(() => {
    google.accounts.id.initialize({
      client_id: CONFIG.googleClientId,
      auto_select: true,
      ux_mode: 'popup',
      callback: (r) => {
        const p = decodeJwt(r.credential);
        const u = { sub: p.sub, name: p.name || p.email, email: p.email, picture: p.picture || '', until: Date.now() + SESSION_DAYS * 864e5 };
        localStorage.setItem(USER_KEY, JSON.stringify(u));
        loginHandler?.(u);
      },
    });
    google.accounts.id.prompt();
  });
  await gsiReady;
  google.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'left', width: 300, locale: 'it' });
}

export async function logout() {
  localStorage.removeItem(USER_KEY);
  try { await loadGsi(); google.accounts.id.disableAutoSelect(); } catch {}
}

// ---------- Google Drive ----------
export class Drive {
  constructor(user) {
    this.user = user;
    this.token = null;
    this.exp = 0;
    this.email = null;
    this.rootId = null;
    this.listeners = new Set();
  }

  get connected() { return Boolean(this.token) && Date.now() < this.exp - 60_000; }
  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const f of this.listeners) f(this); }

  // va chiamato dentro un click (apre il popup di Google)
  async connect(prompt = '') {
    await loadGsi();
    const res = await new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.googleClientId,
        scope: DRIVE_SCOPE,
        login_hint: this.user?.email,
        callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r)),
        error_callback: (e) => reject(new Error(e.message || e.type || 'Accesso a Drive annullato')),
      });
      client.requestAccessToken({ prompt });
    });
    this.token = res.access_token;
    this.exp = Date.now() + Number(res.expires_in || 3600) * 1000;
    try { this.email = (await this.api('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)')).user.emailAddress; } catch {}
    localStorage.setItem('studiolive:drive', '1');
    this.emit();
    return this;
  }

  async ensure() { if (!this.connected) await this.connect(''); }

  disconnect() {
    if (this.token) try { google.accounts.oauth2.revoke(this.token); } catch {}
    this.token = null; this.exp = 0; this.email = null; this.rootId = null;
    localStorage.removeItem('studiolive:drive');
    this.emit();
  }

  async api(url, init = {}) {
    const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${this.token}` } });
    if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? null : r.json();
  }

  async folder(name, parent) {
    const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (parent ? ` and '${parent}' in parents` : '');
    const found = await this.api(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
    if (found.files?.length) return found.files[0].id;
    const made = await this.api('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: parent ? [parent] : undefined }),
    });
    return made.id;
  }

  async sessionFolder(session) {
    await this.ensure();
    if (!this.rootId) this.rootId = await this.folder('StudioLive');
    return this.folder(session, this.rootId);
  }

  // apre un caricamento "riprendibile": chi ha l'indirizzo può caricare il file senza altre chiavi
  async createUpload(name, mime, parent) {
    await this.ensure();
    const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime },
      body: JSON.stringify({ name, parents: [parent], mimeType: mime }),
    });
    const url = r.headers.get('Location');
    if (!r.ok || !url) throw new Error(`Drive non ha aperto il caricamento (${r.status})`);
    return url;
  }

  folderLink(id) { return `https://drive.google.com/drive/folders/${id}`; }
}
