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

// ---------- accesso ----------
export function getUser() {
  if (isDev()) return { sub: 'dev', name: 'Tony (prova)', email: 'prova@localhost', picture: '' };
  try {
    const u = JSON.parse(localStorage.getItem(USER_KEY));
    if (u && u.until > Date.now()) return u;
  } catch {}
  return null;
}

const G_LOGO = '<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>';

const LOGIN_ERRORS = {
  popup_failed_to_open: 'Il browser ha bloccato la finestra di Google: consenti i popup per questo sito e riprova.',
  popup_closed: 'Hai chiuso la finestra di Google prima di finire.',
  access_denied: 'Google ha negato l’accesso. Se l’app è “in test”, la tua email va aggiunta tra gli utenti di test.',
};

// Accesso con la classica finestra di Google (funziona anche su Brave e con i cookie di terze parti bloccati)
export async function renderLogin(el, onLogin) {
  if (CONFIG.googleClientId.startsWith('__')) {
    el.innerHTML = '<p style="color:#ffb020">Manca l’ID client Google in <code>lib/config.js</code>.</p>';
    return;
  }
  el.innerHTML = `<div class="glogin"><button class="gbtn" type="button">${G_LOGO}<span>Continua con Google</span></button><div class="gerr" role="alert"></div></div>`;
  const btn = el.querySelector('.gbtn');
  const err = el.querySelector('.gerr');
  const fail = (msg) => { err.textContent = msg; btn.disabled = false; btn.querySelector('span').textContent = 'Continua con Google'; };
  let client = null;
  try {
    await loadGsi();
    client = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.googleClientId,
      scope: 'openid email profile',
      prompt: 'select_account',
      callback: async (r) => {
        if (r.error) return fail(LOGIN_ERRORS[r.error] || `Google: ${r.error_description || r.error}`);
        try {
          const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${r.access_token}` } });
          if (!res.ok) throw new Error(`profilo non letto (${res.status})`);
          const p = await res.json();
          const u = { sub: p.sub, name: p.name || p.email, email: p.email, picture: p.picture || '', until: Date.now() + SESSION_DAYS * 864e5 };
          localStorage.setItem(USER_KEY, JSON.stringify(u));
          onLogin(u);
        } catch (e) { fail('Accesso non riuscito: ' + e.message); }
      },
      error_callback: (e) => fail(LOGIN_ERRORS[e.type] || 'Accesso non riuscito: ' + (e.message || e.type)),
    });
  } catch {
    fail('Il browser blocca Google (blocco annunci, Brave Shields o estensioni). Disattivalo per questo sito e ricarica.');
  }
  btn.onclick = () => {
    if (!client) return;
    err.textContent = '';
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Apro Google…';
    client.requestAccessToken();
    setTimeout(() => { if (btn.disabled) { btn.disabled = false; btn.querySelector('span').textContent = 'Continua con Google'; } }, 60000);
  };
}

export async function logout() {
  localStorage.removeItem(USER_KEY);
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
