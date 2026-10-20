// Configurazione di StudioLive.
export const CONFIG = {
  // ID client OAuth "Applicazione web" di Google Cloud.
  // Origini JavaScript autorizzate: https://trottolinotrottolo0-jpg.github.io (+ http://localhost:8080 per le prove).
  googleClientId: '__GOOGLE_CLIENT_ID__',
  // Server STUN pubblici per attraversare i router (gratis).
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],
  // Server di "smistamento" PeerJS pubblico e gratuito (serve solo a far trovare regia, ospiti e OBS).
  peer: { host: '0.peerjs.com', port: 443, secure: true, path: '/' },
};

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// cartella del sito (funziona sia su GitHub Pages /studiolive/ sia in locale)
export const BASE = new URL('./', location.href).href.replace(/\/lib\/$/, '/');

export const isDev = () => ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('dev');
