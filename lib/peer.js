// RTCPeerConnection con "perfect negotiation": entrambi i lati possono aggiungere tracce quando vogliono.
// La regia è "polite", ospiti e OBS sono "impolite".
export class Peer {
  constructor({ polite, iceServers, send, onTrack, onState, beforeAnswer, opus }) {
    this.polite = polite;
    this.opus = opus; // parametri Opus che chiediamo all'altro lato (es. stereo, bitrate)
    this.send = send;
    this.beforeAnswer = beforeAnswer;
    this.makingOffer = false;
    this.ignoreOffer = false;
    const pc = (this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' }));

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.setLocal(await pc.createOffer());
        send({ type: 'sdp', description: plain(pc.localDescription) });
      } catch (e) {
        console.error('offerta fallita', e);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) send({ type: 'ice', candidate: candidate.toJSON() }); };
    pc.ontrack = (e) => onTrack?.(e);
    pc.onconnectionstatechange = () => {
      onState?.(pc.connectionState);
      if (pc.connectionState === 'failed') pc.restartIce();
    };
  }

  async handle(msg) {
    const pc = this.pc;
    try {
      if (msg.type === 'sdp') {
        const d = msg.description;
        const collision = d.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          await this.beforeAnswer?.();
          await this.setLocal(await pc.createAnswer());
          this.send({ type: 'sdp', description: plain(pc.localDescription) });
        }
      } else if (msg.type === 'ice') {
        try { await pc.addIceCandidate(msg.candidate); } catch (e) { if (!this.ignoreOffer) console.warn('ice', e); }
      }
    } catch (e) {
      console.error('negoziazione', e);
    }
  }

  async setLocal(desc) {
    if (this.opus) desc = { type: desc.type, sdp: mungeOpus(desc.sdp, this.opus) };
    await this.pc.setLocalDescription(desc);
  }

  close() { try { this.pc.close(); } catch {} }
}

// oggetti semplici: il canale dati non sa trasportare gli oggetti nativi del browser
const plain = (d) => ({ type: d.type, sdp: d.sdp });

// Aggiunge/sovrascrive parametri nella riga a=fmtp di Opus.
function mungeOpus(sdp, params) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  const extra = params.split(';').map((x) => x.split('='));
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`, 'g');
  if (re.test(sdp)) {
    return sdp.replace(re, (_, p) => {
      const kv = new Map(p.split(';').map((x) => x.trim().split('=')));
      for (const [k, v] of extra) kv.set(k, v);
      return `a=fmtp:${pt} ` + [...kv].map(([k, v]) => `${k}=${v}`).join(';');
    });
  }
  return sdp.split(m[0]).join(`${m[0]}\r\na=fmtp:${pt} ${params}`);
}
