// Configurazione di StudioLive.
export const CONFIG = {
  // ID client OAuth "Applicazione web" di Google Cloud.
  // Origini JavaScript autorizzate: https://trottolinotrottolo0-jpg.github.io (+ http://localhost:8080 per le prove).
  googleClientId: '879028282433-mk8auc7bndkcsjq2n8f4mtjji24dt4v0.apps.googleusercontent.com',
  // Server STUN pubblici per attraversare i router (gratis).
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
    // ponte TURN (Metered, app tonywrestling-live): serve quando regia e ospite sono su reti che bloccano il collegamento diretto
    { urls: ["turn:global.relay.metered.ca:80", "turn:global.relay.metered.ca:80?transport=tcp", "turn:global.relay.metered.ca:443", "turns:global.relay.metered.ca:443?transport=tcp"], username: '060c03441e6a7510f123b0b2', credential: 'dgH7Bd1lZVHnv3I3' },
  ],
  // Server di "smistamento" PeerJS pubblico e gratuito (serve solo a far trovare regia, ospiti e OBS).
  peer: { host: '0.peerjs.com', port: 443, secure: true, path: '/' },
};

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// cartella del sito (funziona sia su GitHub Pages /studiolive/ sia in locale)
export const BASE = new URL('./', location.href).href.replace(/\/lib\/$/, '/');

export const isDev = () => ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('dev');
