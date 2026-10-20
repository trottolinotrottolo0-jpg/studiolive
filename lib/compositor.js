// Disegna l'immagine della diretta (1920×1080) su un canvas: layout, nomi, banner, scritta che scorre, logo, overlay, pausa.
export const W = 1920;
export const H = 1080;
const FONT = '"Instrument Sans", -apple-system, "Helvetica Neue", Arial, sans-serif';
const GAP = 24;
const MARGIN = 56;
const TICKER_H = 64;

const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
const lerp = (a, b, t) => a + (b - a) * t;

export class Compositor {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = W; canvas.height = H;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.rects = new Map(); // id -> rettangolo animato {x,y,w,h,a}
  }

  // ---------- layout ----------
  layoutRects(state) {
    const list = state.sources;
    const n = list.length;
    const out = new Map();
    if (!n) return out;
    const bottom = state.ticker ? TICKER_H : 0;
    const area = { x: MARGIN, y: MARGIN, w: W - MARGIN * 2, h: H - MARGIN * 2 - bottom };
    let layout = state.layout;
    const screen = list.find((s) => s.kind === 'screen');
    if (layout === 'auto') layout = screen ? 'screen' : n === 1 ? 'solo' : n <= 3 ? 'side' : 'grid';
    if (layout === 'screen' && !screen) layout = 'spotlight';

    if (layout === 'solo') {
      const main = list.find((s) => s.id === state.spotlightId) || screen || list[0];
      out.set(main.id, { x: 0, y: 0, w: W, h: H - bottom, full: true });
      return out;
    }
    if (layout === 'side') {
      const tw = (area.w - GAP * (n - 1)) / n;
      list.forEach((s, i) => out.set(s.id, { x: area.x + i * (tw + GAP), y: area.y, w: tw, h: area.h }));
      return out;
    }
    if (layout === 'grid' || n === 1) {
      gridRects(list, area).forEach((r, id) => out.set(id, r));
      return out;
    }
    // spotlight / screen: uno grande + colonna a destra
    const main = layout === 'screen'
      ? (list.find((s) => s.id === state.spotlightId && s.kind === 'screen') || screen)
      : (list.find((s) => s.id === state.spotlightId) || list[0]);
    const others = list.filter((s) => s !== main);
    const colW = others.length > 4 ? area.w * 0.18 : area.w * 0.22;
    const mainW = area.w - colW - GAP;
    const mh = Math.min(area.h, (mainW * 9) / 16);
    out.set(main.id, { x: area.x, y: area.y + (area.h - mh) / 2, w: mainW, h: mh, contain: main.kind === 'screen' });
    const cols = others.length > 4 ? 2 : 1;
    gridRects(others, { x: area.x + mainW + GAP, y: area.y, w: colW, h: area.h }, cols).forEach((r, id) => out.set(id, r));
    return out;
  }

  // ---------- disegno ----------
  draw(state, now = performance.now()) {
    const c = this.ctx;
    const b = state.brand;
    c.save();
    drawBackground(c, b);

    if (state.pause) {
      this.drawPause(state, now);
    } else {
      const targets = this.layoutRects(state);
      // animazione morbida tra un layout e l'altro
      for (const [id, t] of targets) {
        const r = this.rects.get(id);
        if (!r) this.rects.set(id, { ...t, a: 0 });
        else { r.x = lerp(r.x, t.x, 0.22); r.y = lerp(r.y, t.y, 0.22); r.w = lerp(r.w, t.w, 0.22); r.h = lerp(r.h, t.h, 0.22); r.full = t.full; r.contain = t.contain; }
      }
      for (const id of [...this.rects.keys()]) if (!targets.has(id)) this.rects.delete(id);
      // prima i riquadri grandi, poi i piccoli sopra
      const order = [...state.sources].sort((a, z) => (this.rects.get(z.id)?.w || 0) - (this.rects.get(a.id)?.w || 0));
      for (const s of order) {
        const r = this.rects.get(s.id);
        if (!r) continue;
        r.a = Math.min(1, r.a + 0.12);
        this.drawTile(s, r, b, state.showNames);
      }
    }

    if (b.overlay?.complete && b.overlay.naturalWidth) c.drawImage(b.overlay, 0, 0, W, H);
    if (b.logo?.complete && b.logo.naturalWidth && !state.pause) drawLogo(c, b.logo, W - 40, 40, 300, 120);
    if (state.banner) this.drawBanner(state.banner, b, now, state.ticker ? TICKER_H : 0);
    if (state.ticker) this.drawTicker(state.ticker, b, now);
    c.restore();
  }

  drawTile(s, r, b, showNames) {
    const c = this.ctx;
    const radius = r.full ? 0 : (b.radius ?? 18);
    c.save();
    c.globalAlpha = r.a;
    c.beginPath();
    c.roundRect(r.x, r.y, r.w, r.h, radius);
    c.clip();
    const v = s.video;
    if (v && v.videoWidth && !s.camOff) {
      if (r.contain) { c.fillStyle = '#000'; c.fillRect(r.x, r.y, r.w, r.h); drawMedia(c, v, r, false, s.mirror); }
      else drawMedia(c, v, r, true, s.mirror);
    } else {
      c.fillStyle = shade(b.color, -0.55);
      c.fillRect(r.x, r.y, r.w, r.h);
      const d = Math.min(r.w, r.h) * 0.36;
      c.fillStyle = b.color;
      c.beginPath(); c.arc(r.x + r.w / 2, r.y + r.h / 2, d / 2, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#fff';
      c.font = `700 ${d * 0.42}px ${FONT}`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(initials(s.name), r.x + r.w / 2, r.y + r.h / 2 + 2);
    }
    c.restore();

    // bordo luminoso quando parla
    if (s.speaking > 0.05 && s.kind !== 'screen') {
      c.save();
      c.globalAlpha = Math.min(1, s.speaking) * r.a;
      c.strokeStyle = b.color;
      c.lineWidth = 6;
      c.beginPath(); c.roundRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6, Math.max(0, radius - 3)); c.stroke();
      c.restore();
    }

    if (showNames && s.name && s.kind !== 'screen') {
      const fs = Math.max(18, Math.min(34, r.h * 0.055));
      c.save();
      c.globalAlpha = r.a;
      c.font = `700 ${fs}px ${FONT}`;
      const tw = c.measureText(s.name).width;
      const px = fs * 0.7, ph = fs * 1.7;
      const x = r.x + (r.full ? 48 : 16), y = r.y + r.h - ph - (r.full ? 48 : 16);
      c.fillStyle = b.color;
      c.beginPath(); c.roundRect(x, y, tw + px * 2, ph, 8); c.fill();
      c.fillStyle = b.textColor || '#fff';
      c.textBaseline = 'middle';
      c.fillText(s.name, x + px, y + ph / 2 + 1);
      c.restore();
    }
  }

  drawBanner(banner, b, now, bottom) {
    const c = this.ctx;
    const p = easeOut((now - banner.shownAt) / 450);
    const x0 = 64;
    const maxW = W - 128;
    c.save();
    let tf = 50;
    c.font = `800 ${tf}px ${FONT}`;
    while (c.measureText(banner.title).width > maxW - 64 && tf > 24) { tf -= 2; c.font = `800 ${tf}px ${FONT}`; }
    const tw = c.measureText(banner.title).width;
    let sw = 0, sf = 30;
    if (banner.sub) {
      c.font = `500 ${sf}px ${FONT}`;
      while (c.measureText(banner.sub).width > maxW - 56 && sf > 18) { sf -= 2; c.font = `500 ${sf}px ${FONT}`; }
      sw = c.measureText(banner.sub).width;
    }
    const th = tf * 1.75, sh = banner.sub ? sf * 1.8 : 0;
    const y = H - 56 - bottom - th - sh;
    const shift = -(Math.max(tw, sw) + 200) * (1 - p);
    c.globalAlpha = p;
    c.fillStyle = b.color;
    c.beginPath(); c.roundRect(x0 + shift, y, tw + 64, th, [10, 10, banner.sub ? 0 : 10, 10]); c.fill();
    c.fillStyle = b.textColor || '#fff';
    c.font = `800 ${tf}px ${FONT}`;
    c.textBaseline = 'middle';
    c.fillText(banner.title, x0 + 32 + shift, y + th / 2 + 2);
    if (banner.sub) {
      c.fillStyle = '#ffffff';
      c.beginPath(); c.roundRect(x0 + shift, y + th, sw + 56, sh, [0, 10, 10, 10]); c.fill();
      c.fillStyle = '#111';
      c.font = `500 ${sf}px ${FONT}`;
      c.fillText(banner.sub, x0 + 28 + shift, y + th + sh / 2 + 1);
    }
    c.restore();
  }

  drawTicker(ticker, b, now) {
    const c = this.ctx;
    const y = H - TICKER_H;
    c.save();
    c.fillStyle = shade(b.color, -0.45);
    c.fillRect(0, y, W, TICKER_H);
    c.fillStyle = b.color;
    c.fillRect(0, y, W, 4);
    c.font = `600 30px ${FONT}`;
    c.fillStyle = '#fff';
    c.textBaseline = 'middle';
    const unit = ticker.text + '     •     ';
    const uw = c.measureText(unit).width || 1;
    const offset = (((now - ticker.shownAt) / 1000) * 130) % uw;
    for (let x = W - offset - uw * Math.ceil(W / uw); x < W; x += uw) {
      if (x + uw > 0) c.fillText(unit, x, y + TICKER_H / 2 + 3);
    }
    c.restore();
  }

  drawPause(state, now) {
    const c = this.ctx;
    const b = state.brand;
    c.save();
    let top = H / 2;
    if (b.logo?.complete && b.logo.naturalWidth) {
      drawLogo(c, b.logo, W / 2, H / 2 - 230, 520, 220, 'center');
      top = H / 2 + 60;
    }
    const pulse = 0.75 + 0.25 * Math.sin(now / 600);
    c.fillStyle = b.textColor || '#fff';
    c.globalAlpha = pulse;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    let f = 96;
    c.font = `800 ${f}px ${FONT}`;
    while (c.measureText(state.pause.text).width > W - 200 && f > 40) { f -= 4; c.font = `800 ${f}px ${FONT}`; }
    c.fillText(state.pause.text, W / 2, top);
    c.restore();
  }
}

// ---------- utilità ----------
function gridRects(list, area, forceCols) {
  const n = list.length;
  const out = new Map();
  if (!n) return out;
  let best = null;
  for (let cols = forceCols || 1; cols <= (forceCols || n); cols++) {
    const rows = Math.ceil(n / cols);
    const tw = Math.min((area.w - GAP * (cols - 1)) / cols, (((area.h - GAP * (rows - 1)) / rows) * 16) / 9);
    if (!best || tw > best.tw) best = { cols, rows, tw };
  }
  const { cols, rows, tw } = best;
  const th = (tw * 9) / 16;
  const totalH = rows * th + (rows - 1) * GAP;
  list.forEach((s, i) => {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const rowW = inRow * tw + (inRow - 1) * GAP;
    const col = i - row * cols;
    out.set(s.id, {
      x: area.x + (area.w - rowW) / 2 + col * (tw + GAP),
      y: area.y + (area.h - totalH) / 2 + row * (th + GAP),
      w: tw, h: th,
    });
  });
  return out;
}

function drawMedia(c, v, r, cover, mirror) {
  const vw = v.videoWidth, vh = v.videoHeight;
  const scale = cover ? Math.max(r.w / vw, r.h / vh) : Math.min(r.w / vw, r.h / vh);
  const dw = vw * scale, dh = vh * scale;
  const dx = r.x + (r.w - dw) / 2, dy = r.y + (r.h - dh) / 2;
  if (mirror) {
    c.save();
    c.translate(dx + dw, dy);
    c.scale(-1, 1);
    c.drawImage(v, 0, 0, dw, dh);
    c.restore();
  } else c.drawImage(v, dx, dy, dw, dh);
}

function drawBackground(c, b) {
  c.fillStyle = b.bgColor || '#0e1014';
  c.fillRect(0, 0, W, H);
  const img = b.bgImage;
  if (img?.complete && img.naturalWidth) {
    const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    const w = img.naturalWidth * s, h = img.naturalHeight * s;
    c.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  } else {
    const g = c.createRadialGradient(W * 0.25, H * 0.1, 50, W * 0.5, H * 0.5, W * 0.8);
    g.addColorStop(0, hexA(b.color, 0.22));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  }
}

function drawLogo(c, img, x, y, maxW, maxH, align = 'right') {
  const s = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
  const w = img.naturalWidth * s, h = img.naturalHeight * s;
  c.drawImage(img, align === 'center' ? x - w / 2 : x - w, y, w, h);
}

const initials = (name = '?') => name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || '?';

function parseHex(hex) {
  const h = (hex || '#ff3b30').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hexA(hex, a) { const [r, g, b] = parseHex(hex); return `rgba(${r},${g},${b},${a})`; }
function shade(hex, amt) {
  const [r, g, b] = parseHex(hex).map((v) => Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt));
  return `rgb(${r},${g},${b})`;
}
