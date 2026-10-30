// Rendering and the world <-> screen mapping.
//
// Roles:
//   'host'  shows the bottom half of the world (y from H+G to 2H+G) with its
//           goal at the bottom of the screen.
//   'guest' is rotated 180 degrees relative to the host (top edge against top
//           edge), so it shows the top half of the world flipped: world y = 0
//           is at the bottom of the guest's screen and world x runs right to left.
//   'solo'  one device shows the WHOLE rink (W x (2H+G) world units), the host
//           half at the bottom, the guest half at the top, with the seam gap
//           drawn as a dark bezel band between them.
//
// The mapping is always affine and axis-aligned:
//     screen x = X0 + kx * worldX      screen y = Y0 + ky * worldY
// (kx, ky are negative for the guest), which lets every layer share it.
//
// Performance notes: the static rink (floor, grid, vignette, rails, seam) is
// painted once into an offscreen canvas on resize. Puck, mallets and obstacles
// are pre-rendered sprites. Per frame we only blit, draw a few sprites, strokes
// and text, and the particle system from fx.js. No per-frame shadowBlur.

import { createFx } from './fx.js';

const TAU = Math.PI * 2;
const HOST_COL = '#ff7a45';
const GUEST_COL = '#4fd1ff';
const HOST_RGB = '255,122,69';
const GUEST_RGB = '79,209,255';
const GOOD = '#7CFF9A';
const BAD = '#ff6b6b';
const BG = '#0b1020';
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, system-ui, sans-serif';
const DASH = [5, 6];
const NO_DASH = [];
const TRAIL_N = 32;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeOutBack = (p) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const q = p - 1;
  return 1 + c3 * q * q * q + c1 * q * q;
};
const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);

export function createView(canvas, role, cfg) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const { W, H, G, puckR, malletR } = cfg;
  const goalW0 = cfg.goalW || W * 0.36;
  const target = cfg.target || 7;
  const mode = cfg.mode || 'classic';
  const players = cfg.players || 'duo';
  const bottomY = 2 * H + G;
  const solo = role === 'solo';

  // World y range visible on this screen.
  const visTop = role === 'host' ? H + G : 0;
  const visBot = role === 'guest' ? H : bottomY;
  const visH = visBot - visTop;

  const fx = createFx({
    W,
    H,
    G,
    puckR,
    seamY: role === 'host' ? H + G : role === 'guest' ? H : null,
    seamDir: role === 'host' ? 1 : -1,
    mySide: solo ? null : role,
    visible: (x, y, m) => x > -m && x < W + m && y > visTop - m && y < visBot + m,
  });

  const labels = solo ? (players === 'bot' ? ['YOU', 'BOT'] : ['P1', 'P2']) : ['YOU', 'THEM'];

  // Goals drawn on this screen. top=true means the goal is at the top of the screen.
  const goals = [];
  if (role !== 'guest') goals.push({ side: 'host', idx: 0, top: false, w: goalW0 });
  if (role !== 'host') goals.push({ side: 'guest', idx: 1, top: solo, w: goalW0 });

  // --- layout state -------------------------------------------------------------
  let dpr = 1;
  let screenW = 1;
  let screenH = 1;
  let scale = 1;
  let rx = 0; // rink rect on screen (CSS px)
  let ry = 0;
  let rw = 1;
  let rh = 1;
  let X0 = 0;
  let kx = 1;
  let Y0 = 0;
  let ky = 1;
  let u = 1; // HUD unit: 1 at 820 px wide rink

  let bg = null;
  let spr = null; // sprites, rebuilt on resize
  const bumperSprites = new Map();
  const goalGrad = {}; // local-space gradients per side, rebuilt on resize
  let seamGrad = null;
  let seamR = 1;
  let glowH = 40;

  const glowWhite = makeGlow('190,225,255');
  const glowHost = makeGlow(HOST_RGB);
  const glowGuest = makeGlow(GUEST_RGB);
  const glowGold = makeGlow('255,210,80');
  const glowRed = makeGlow('255,60,50');

  const map = { X0: 0, kx: 1, Y0: 0, ky: 1, scale: 1, dpr: 1 };
  const shk = [0, 0];

  const fontCache = new Map();
  function font(size, weight) {
    const key = Math.round(size) * 1000 + weight;
    let f = fontCache.get(key);
    if (!f) {
      f = `${weight} ${Math.round(size)}px ${FONT}`;
      fontCache.set(key, f);
    }
    return f;
  }

  const sxw = (wx) => X0 + kx * wx;
  const syw = (wy) => Y0 + ky * wy;

  function layout() {
    dpr = Math.min(3, window.devicePixelRatio || 1);
    screenW = window.innerWidth || canvas.clientWidth || 800;
    screenH = window.innerHeight || canvas.clientHeight || 600;
    canvas.width = Math.round(screenW * dpr);
    canvas.height = Math.round(screenH * dpr);
    canvas.style.width = screenW + 'px';
    canvas.style.height = screenH + 'px';

    scale = Math.min(screenW / W, screenH / visH);
    rw = W * scale;
    rh = visH * scale;
    rx = (screenW - rw) / 2;
    // Host/guest: anchor the seam edge (screen top) to the physical top edge of the
    // device and leave any slack at the bottom (goal end). Solo stays centred.
    ry = solo ? (screenH - rh) / 2 : 0;
    if (role === 'guest') {
      kx = -scale;
      X0 = rx + rw;
      ky = -scale;
      Y0 = ry + rh;
    } else {
      kx = scale;
      X0 = rx;
      ky = scale;
      Y0 = ry - visTop * scale;
    }
    u = clamp(rw / 820, 0.5, 1.6);
    map.X0 = X0;
    map.kx = kx;
    map.Y0 = Y0;
    map.ky = ky;
    map.scale = scale;
    map.dpr = dpr;
    glowH = Math.max(26, rh * 0.05);
    seamR = Math.max(60, rw * 0.3);
  }

  function resize() {
    layout();
    buildSprites();
    buildGradients();
    buildBg();
  }

  // --- offscreen helpers --------------------------------------------------------

  function makeSprite(cssSize, draw) {
    const px = Math.ceil(cssSize * dpr);
    const cv = document.createElement('canvas');
    cv.width = px;
    cv.height = px;
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = px / dpr;
    cv.cs = cs;
    draw(c, cs / 2, cs / 2);
    return cv;
  }

  function makeGlow(rgb) {
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 128;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, `rgba(${rgb},0.9)`);
    g.addColorStop(0.25, `rgba(${rgb},0.45)`);
    g.addColorStop(0.6, `rgba(${rgb},0.12)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
    return cv;
  }

  function discShadow(c, cx, cy, r, blur, ox, oy, alpha) {
    c.save();
    c.shadowColor = `rgba(0,0,0,${alpha})`;
    c.shadowBlur = blur * dpr;
    c.shadowOffsetX = ox * dpr;
    c.shadowOffsetY = oy * dpr;
    c.fillStyle = '#000';
    c.beginPath();
    c.arc(cx, cy, r, 0, TAU);
    c.fill();
    c.restore();
  }

  function makePuck(r) {
    const pad = Math.ceil(r * 0.7) + 2;
    return makeSprite((r + pad) * 2, (c, cx, cy) => {
      discShadow(c, cx, cy, r, r * 0.55, r * 0.16, r * 0.3, 0.6);
      let g = c.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.05, cx, cy, r * 1.05);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.35, '#e6ebfa');
      g.addColorStop(0.75, '#a9b3d6');
      g.addColorStop(1, '#6f7ba3');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r, 0, TAU);
      c.fill();
      // rim
      g = c.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.5, 'rgba(160,172,210,0.4)');
      g.addColorStop(1, 'rgba(40,50,90,0.85)');
      c.strokeStyle = g;
      c.lineWidth = Math.max(1.2, r * 0.1);
      c.beginPath();
      c.arc(cx, cy, r - c.lineWidth / 2, 0, TAU);
      c.stroke();
      // groove
      c.lineWidth = Math.max(1, r * 0.07);
      c.strokeStyle = 'rgba(50,62,110,0.4)';
      c.beginPath();
      c.arc(cx, cy, r * 0.62, 0, TAU);
      c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.45)';
      c.beginPath();
      c.arc(cx + 0.5, cy + 0.7, r * 0.62, 0, TAU);
      c.stroke();
      // gloss
      g = c.createLinearGradient(cx, cy - r * 0.6, cx, cy - r * 0.1);
      g.addColorStop(0, 'rgba(255,255,255,0.85)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.beginPath();
      c.ellipse(cx - r * 0.22, cy - r * 0.36, r * 0.46, r * 0.22, -0.5, 0, TAU);
      c.fill();
    });
  }

  function makeMallet(r, light, base, dark, deep) {
    const pad = Math.ceil(r * 0.7) + 2;
    return makeSprite((r + pad) * 2, (c, cx, cy) => {
      discShadow(c, cx, cy, r, r * 0.6, r * 0.18, r * 0.3, 0.65);
      let g = c.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r * 1.05);
      g.addColorStop(0, light);
      g.addColorStop(0.45, base);
      g.addColorStop(1, dark);
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r, 0, TAU);
      c.fill();
      // rim light: bright top-left, deep bottom-right
      g = c.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.05)');
      g.addColorStop(1, deep);
      c.strokeStyle = g;
      c.lineWidth = Math.max(1.5, r * 0.1);
      c.beginPath();
      c.arc(cx, cy, r - c.lineWidth / 2, 0, TAU);
      c.stroke();
      // groove
      c.lineWidth = Math.max(1, r * 0.06);
      c.strokeStyle = 'rgba(0,0,0,0.3)';
      c.beginPath();
      c.arc(cx, cy, r * 0.74, 0, TAU);
      c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.28)';
      c.beginPath();
      c.arc(cx + 0.6, cy + 0.8, r * 0.74, 0, TAU);
      c.stroke();
      // handle
      const hr = r * 0.46;
      c.fillStyle = 'rgba(0,0,0,0.28)';
      c.beginPath();
      c.arc(cx + r * 0.03, cy + r * 0.05, hr * 1.12, 0, TAU);
      c.fill();
      g = c.createRadialGradient(cx - hr * 0.35, cy - hr * 0.4, hr * 0.05, cx, cy, hr * 1.05);
      g.addColorStop(0, light);
      g.addColorStop(0.5, base);
      g.addColorStop(1, dark);
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, hr, 0, TAU);
      c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.35)';
      c.lineWidth = Math.max(1, r * 0.04);
      c.beginPath();
      c.arc(cx, cy, hr, Math.PI * 1.05, Math.PI * 1.7);
      c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.75)';
      c.beginPath();
      c.ellipse(cx - hr * 0.35, cy - hr * 0.42, hr * 0.28, hr * 0.16, -0.6, 0, TAU);
      c.fill();
    });
  }

  function makeBumper(r) {
    const pad = Math.ceil(r * 0.5) + 2;
    return makeSprite((r + pad) * 2, (c, cx, cy) => {
      discShadow(c, cx, cy, r, r * 0.5, r * 0.15, r * 0.25, 0.6);
      // outer brass collar
      let g = c.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      g.addColorStop(0, '#fff0b0');
      g.addColorStop(0.5, '#b88a22');
      g.addColorStop(1, '#4e3408');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r, 0, TAU);
      c.fill();
      // post body
      g = c.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.05, cx, cy, r * 0.85);
      g.addColorStop(0, '#fff2b8');
      g.addColorStop(0.45, '#e0ab3a');
      g.addColorStop(1, '#7a5214');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r * 0.84, 0, TAU);
      c.fill();
      c.strokeStyle = 'rgba(70,40,5,0.55)';
      c.lineWidth = Math.max(1, r * 0.05);
      c.beginPath();
      c.arc(cx, cy, r * 0.84, 0, TAU);
      c.stroke();
      // dome
      g = c.createRadialGradient(cx - r * 0.18, cy - r * 0.22, r * 0.02, cx, cy, r * 0.46);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.35, '#ffe38a');
      g.addColorStop(1, '#a8741c');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r * 0.46, 0, TAU);
      c.fill();
    });
  }

  function getBumperSprite(rCss) {
    const key = Math.round(rCss * 2);
    let s = bumperSprites.get(key);
    if (!s) {
      s = makeBumper(key / 2);
      bumperSprites.set(key, s);
    }
    return s;
  }

  function buildSprites() {
    const pr = puckR * scale;
    const mr = malletR * scale;
    spr = {
      puck: makePuck(pr),
      host: makeMallet(mr, '#ffc3a2', '#ff7a45', '#b0400f', 'rgba(70,20,0,0.9)'),
      guest: makeMallet(mr, '#b9f0ff', '#4fd1ff', '#1580ab', 'rgba(0,40,60,0.9)'),
    };
    bumperSprites.clear();
  }

  function buildGradients() {
    for (const side of ['host', 'guest']) {
      const rgb = side === 'host' ? HOST_RGB : GUEST_RGB;
      let g = ctx.createLinearGradient(0, 0, 0, glowH);
      g.addColorStop(0, `rgba(${rgb},0.95)`);
      g.addColorStop(0.35, `rgba(${rgb},0.4)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      const glow = g;
      // Unit radial gradient; scaled into an ellipse when drawn.
      g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.25, `rgba(${rgb},0.7)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      goalGrad[side] = { glow, flash: g };
    }
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, seamR);
    g.addColorStop(0, 'rgba(220,242,255,0.95)');
    g.addColorStop(0.3, 'rgba(120,200,255,0.4)');
    g.addColorStop(1, 'rgba(120,200,255,0)');
    seamGrad = g;
  }

  // --- static rink --------------------------------------------------------------

  function halfGeom(side) {
    const isHost = side === 'host';
    const a = syw(isHost ? H + G : 0);
    const b = syw(isHost ? bottomY : H);
    return { top: Math.min(a, b), h: Math.abs(b - a), yA: isHost ? H + G : 0 };
  }

  function drawHalf(c, side) {
    const isHost = side === 'host';
    const { top, h, yA } = halfGeom(side);
    const cx = rx + rw / 2;
    const cy = top + h / 2;
    const R = Math.hypot(rw / 2, h / 2);
    const ice = mode === 'ice';

    let g = c.createRadialGradient(cx, cy, 0, cx, cy, R);
    if (ice) {
      g.addColorStop(0, '#26407a');
      g.addColorStop(0.6, '#182c58');
      g.addColorStop(1, '#0c1630');
    } else {
      g.addColorStop(0, '#1b2b58');
      g.addColorStop(0.6, '#111d3d');
      g.addColorStop(1, '#080d1e');
    }
    c.fillStyle = g;
    c.fillRect(rx, top, rw, h);

    // Accent wash near this half's goal.
    const goalY = syw(isHost ? bottomY : 0);
    const rgb = isHost ? HOST_RGB : GUEST_RGB;
    g = c.createRadialGradient(cx, goalY, 0, cx, goalY, Math.max(rw, h) * 0.75);
    g.addColorStop(0, `rgba(${rgb},0.17)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    c.fillStyle = g;
    c.fillRect(rx, top, rw, h);

    // Grid.
    const step = (W / 20) * scale;
    c.strokeStyle = ice ? 'rgba(170,200,255,0.06)' : 'rgba(140,170,255,0.045)';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i < 20; i++) {
      const x = Math.round(rx + i * step) + 0.5;
      c.moveTo(x, top);
      c.lineTo(x, top + h);
    }
    const startY = syw(yA);
    const dirY = ky > 0 ? 1 : -1;
    for (let j = 0; j * step <= h; j++) {
      const y = Math.round(startY + dirY * j * step) + 0.5;
      c.moveTo(rx, y);
      c.lineTo(rx + rw, y);
    }
    c.stroke();

    // Brushed texture: seeded long hairlines.
    let seed = isHost ? 1337 : 7331;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    c.strokeStyle = ice ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.022)';
    c.lineWidth = 1;
    c.beginPath();
    const lines = ice ? 140 : 80;
    for (let i = 0; i < lines; i++) {
      const x = rx + rand() * rw * 0.9;
      const y = top + rand() * h;
      const len = rw * (0.15 + rand() * 0.5);
      c.moveTo(x, y);
      c.lineTo(x + len, y + (rand() - 0.5) * 3);
    }
    c.stroke();

    // Serve spot and face-off dots.
    const spotY = syw(yA + H / 2);
    c.strokeStyle = 'rgba(255,255,255,0.1)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(cx, spotY, puckR * 1.9 * scale, 0, TAU);
    c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.1)';
    c.beginPath();
    c.arc(cx, spotY, 3, 0, TAU);
    c.arc(rx + rw * 0.2, spotY, 3, 0, TAU);
    c.moveTo(rx + rw * 0.8 + 3, spotY);
    c.arc(rx + rw * 0.8, spotY, 3, 0, TAU);
    c.fill();
  }

  function drawCentreCircle(c) {
    const cx = rx + rw / 2;
    const cy = syw(H + G / 2);
    const r = W * 0.18 * scale;
    c.beginPath();
    c.arc(cx, cy, r, 0, TAU);
    c.strokeStyle = 'rgba(160,190,255,0.06)';
    c.lineWidth = 9;
    c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.16)';
    c.lineWidth = 2.5;
    c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.14)';
    c.beginPath();
    c.arc(cx, cy, 4, 0, TAU);
    c.fill();
  }

  // Solo with no seam gap: a faint line so the two halves read clearly.
  function drawCentreLine(c) {
    const y = Math.round(syw(H + G / 2)) + 0.5;
    c.strokeStyle = 'rgba(255,255,255,0.1)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(rx, y);
    c.lineTo(rx + rw, y);
    c.stroke();
  }

  function drawBand(c) {
    const t = syw(H);
    const b = syw(H + G);
    const bh = b - t;
    if (bh < 1) return;
    let g = c.createLinearGradient(0, t, 0, b);
    g.addColorStop(0, '#1a2138');
    g.addColorStop(0.2, '#070a14');
    g.addColorStop(0.8, '#070a14');
    g.addColorStop(1, '#1a2138');
    c.fillStyle = g;
    c.fillRect(rx, t, rw, bh);
    // cast shadows onto the felt on either side
    g = c.createLinearGradient(0, t - 18, 0, t);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    c.fillStyle = g;
    c.fillRect(rx, t - 18, rw, 18);
    g = c.createLinearGradient(0, b, 0, b + 18);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(rx, b, rw, 18);
    // bevel highlights
    c.fillStyle = 'rgba(255,255,255,0.14)';
    c.fillRect(rx, t, rw, 1);
    c.fillRect(rx, b - 1, rw, 1);
    c.fillStyle = 'rgba(255,255,255,0.05)';
    c.fillRect(rx, t + 1, rw, 1);
    // tiny sensor dot, like the bezel of a real iPad
    c.fillStyle = 'rgba(120,140,200,0.18)';
    c.beginPath();
    c.arc(rx + rw / 2, t + bh / 2, Math.min(3.5, bh * 0.14), 0, TAU);
    c.fill();
  }

  function drawSeamEdge(c) {
    // The top edge of a host/guest screen is where the other iPad begins.
    let g = c.createLinearGradient(0, ry, 0, ry + 26);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(rx, ry, rw, 26);
    c.setLineDash([10, 8]);
    c.strokeStyle = 'rgba(255,255,255,0.16)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(rx, ry + 1);
    c.lineTo(rx + rw, ry + 1);
    c.stroke();
    c.setLineDash(NO_DASH);
  }

  function drawRails(c) {
    const x1 = rx + 1.5;
    const x2 = rx + rw - 1.5;
    const g = c.createLinearGradient(0, syw(0), 0, syw(bottomY));
    g.addColorStop(0, 'rgb(79,209,255)');
    g.addColorStop((H + G / 2) / bottomY, 'rgb(205,225,255)');
    g.addColorStop(1, 'rgb(255,122,69)');
    c.strokeStyle = g;
    c.lineCap = 'butt';
    const segs = [];
    if (role !== 'guest') segs.push(halfGeom('host'));
    if (role !== 'host') segs.push(halfGeom('guest'));
    const passes = [
      [18, 0.06],
      [9, 0.13],
      [3.2, 0.9],
    ];
    for (const [lw, a] of passes) {
      c.globalAlpha = a;
      c.lineWidth = lw;
      c.beginPath();
      for (const s of segs) {
        c.moveTo(x1, s.top);
        c.lineTo(x1, s.top + s.h);
        c.moveTo(x2, s.top);
        c.lineTo(x2, s.top + s.h);
      }
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  function buildBg() {
    if (!bg) bg = document.createElement('canvas');
    bg.width = canvas.width;
    bg.height = canvas.height;
    const c = bg.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = BG;
    c.fillRect(0, 0, screenW, screenH);

    c.save();
    c.beginPath();
    c.rect(rx, ry, rw, rh);
    c.clip();
    if (role !== 'guest') drawHalf(c, 'host');
    if (role !== 'host') drawHalf(c, 'guest');
    drawCentreCircle(c);
    if (solo) {
      if (G > 0) drawBand(c);
      else drawCentreLine(c);
    } else drawSeamEdge(c);
    c.restore();
    drawRails(c);
  }

  // --- dynamic state ------------------------------------------------------------

  let curSnap = null;
  let lastNow = -1;
  let lastPhase = null;
  let phaseStart = 0;
  let lastSc0 = -1;
  let lastSc1 = -1;
  const popT = [-1e9, -1e9];
  const mp = [0, 0, 0, 0];
  const mv = [0, 0, 0, 0];
  let mvT = 0;
  let mvInit = false;
  // Guest local mallet prediction: position + smoothed velocity from successive calls.
  let lmX = 0;
  let lmY = 0;
  let lmVx = 0;
  let lmVy = 0;
  let lmT = 0;
  let lmInit = false;
  const bumperFlashT = [];
  let latency = null;

  const trX = new Float64Array(TRAIL_N);
  const trY = new Float64Array(TRAIL_N);
  const trT = new Float64Array(TRAIL_N);
  let trHead = 0;
  let trCount = 0;
  let trLast = -1e9;

  function newSnap(snap, now) {
    if (snap.ph !== lastPhase) {
      lastPhase = snap.ph;
      phaseStart = now;
      trCount = 0;
    }
    const sc = snap.sc || [0, 0];
    if (lastSc0 >= 0) {
      if (sc[0] !== lastSc0) popT[0] = now;
      if (sc[1] !== lastSc1) popT[1] = now;
    }
    lastSc0 = sc[0];
    lastSc1 = sc[1];

    // Mallet velocity from successive distinct snapshots (for the speed glow).
    const m = snap.m;
    if (m) {
      const dtS = clamp((now - mvT) / 1000, 0.004, 0.1);
      if (mvInit) {
        for (let i = 0; i < 4; i++) mv[i] = mv[i] * 0.5 + ((m[i] - mp[i]) / dtS) * 0.5;
      }
      for (let i = 0; i < 4; i++) mp[i] = m[i];
      mvT = now;
      mvInit = true;
    }

    const ev = snap.ev;
    if (ev && ev.length) {
      const n = Math.min(ev.length, 16);
      for (let i = 0; i < n; i++) {
        const e = ev[i];
        if (!e) continue;
        fx.onEvent(e, now, snap);
        if (e.k === 'bumper' && snap.ob) markBumper(snap.ob, e, now);
      }
    }
    curSnap = snap;
  }

  function markBumper(ob, e, now) {
    let best = -1;
    let bd = 1e12;
    for (let i = 0; i < ob.length; i++) {
      if (ob[i].k !== 'bumper') continue;
      const d = (ob[i].x - e.x) * (ob[i].x - e.x) + (ob[i].y - e.y) * (ob[i].y - e.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) bumperFlashT[best] = now;
  }

  // --- drawing helpers ----------------------------------------------------------

  function drawSprite(s, sx, sy, k) {
    const sz = s.cs * (k || 1);
    ctx.drawImage(s, sx - sz / 2, sy - sz / 2, sz, sz);
  }

  function drawGlow(g, sx, sy, radiusPx, alpha) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(g, sx - radiusPx, sy - radiusPx, radiusPx * 2, radiusPx * 2);
  }

  function seamIntensity(py, edgeWorld) {
    const d = py >= H && py <= H + G ? 0 : Math.abs(py - edgeWorld);
    const lim = puckR * 1.5;
    return d >= lim ? 0 : 1 - d / lim;
  }

  function drawSeamGlow(edgeScreenY, below, intensity, sx, now) {
    const a = intensity * (0.65 + 0.35 * Math.sin(now / 70));
    if (a < 0.02) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, below ? edgeScreenY : edgeScreenY - seamR * 0.55, rw, seamR * 0.55);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, a);
    ctx.translate(clamp(sx, rx, rx + rw), edgeScreenY);
    ctx.scale(1, 0.5);
    ctx.fillStyle = seamGrad;
    ctx.fillRect(-seamR, -seamR, seamR * 2, seamR * 2);
    ctx.restore();
    // bright hairline on the edge itself
    ctx.globalAlpha = Math.min(1, a) * 0.8;
    ctx.fillStyle = '#cfeeff';
    const lw = seamR * 1.2;
    ctx.fillRect(clamp(sx - lw / 2, rx, rx + rw - lw), below ? edgeScreenY : edgeScreenY - 2, lw, 2);
    ctx.globalAlpha = 1;
  }

  function drawGoal(g, now, dt) {
    const tw = (curSnap.gw && curSnap.gw[g.idx]) || goalW0;
    g.w += (tw - g.w) * (1 - Math.exp(-dt * 9));
    const gwPx = g.w * scale;
    const half = gwPx / 2;
    const rgb = g.side === 'host' ? HOST_RGB : GUEST_RGB;
    const col = g.side === 'host' ? HOST_COL : GUEST_COL;
    const cx = rx + rw / 2;
    const edgeY = g.top ? ry : ry + rh;
    const dir = g.top ? 1 : -1; // screen direction into the rink
    const grads = goalGrad[g.side];
    const pulse = 0.85 + 0.15 * Math.sin(now / 420 + g.idx * 2);

    ctx.save();
    ctx.translate(cx, edgeY);
    ctx.scale(1, dir); // local +y points into the rink

    // crease
    ctx.beginPath();
    ctx.arc(0, 0, gwPx * 0.9, 0, Math.PI);
    ctx.fillStyle = `rgba(${rgb},0.05)`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${rgb},0.3)`;
    ctx.lineWidth = 2;
    ctx.stroke();

    // glow gradient in the mouth
    ctx.globalAlpha = pulse;
    ctx.fillStyle = grads.glow;
    ctx.fillRect(-half, 0, gwPx, glowH);
    ctx.globalAlpha = 1;

    // goal flash after a goal
    const ft = now - fx.state.goalFlash[g.side];
    if (ft >= 0 && ft < 800) {
      const a = 1 - ft / 800;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a * a;
      ctx.fillStyle = grads.flash;
      ctx.save();
      ctx.scale(half * 1.5, glowH * 3.4);
      ctx.fillRect(-1, 0, 2, 1);
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // end rails with the mouth cut out
    ctx.strokeStyle = col;
    ctx.lineCap = 'round';
    const L = -rw / 2 + 1.5;
    const R = rw / 2 - 1.5;
    const passes = [
      [16, 0.07],
      [8, 0.16],
      [3.2, 0.95],
    ];
    for (const [lw, a] of passes) {
      ctx.globalAlpha = a;
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(L, 1.6);
      ctx.lineTo(-half, 1.6);
      ctx.moveTo(half, 1.6);
      ctx.lineTo(R, 1.6);
      ctx.stroke();
    }
    // bright line across the mouth + posts
    ctx.globalAlpha = 0.5 * pulse;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-half, 1);
    ctx.lineTo(half, 1);
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(-half, 1.6, 9, 0, TAU);
    ctx.arc(half, 1.6, 9, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-half, 1.6, 3.6, 0, TAU);
    ctx.moveTo(half + 3.6, 1.6);
    ctx.arc(half, 1.6, 3.6, 0, TAU);
    ctx.fill();
    ctx.restore();
    ctx.lineCap = 'butt';
  }

  function drawObstacles(ob, now) {
    for (let i = 0; i < ob.length; i++) {
      const o = ob[i];
      const sx = sxw(o.x);
      const sy = syw(o.y);
      const r = o.r * scale;
      if (o.k === 'bumper') {
        const ft = (now - (bumperFlashT[i] || -1e9)) / 330;
        const flashing = ft >= 0 && ft < 1;
        // idle warm halo
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(glowGold, sx, sy, r * 2.1, 0.22 + (flashing ? 0.7 * (1 - ft) : 0));
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        drawSprite(getBumperSprite(r), sx, sy, flashing ? 1 + 0.14 * (1 - ft) : 1);
        if (flashing) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = (1 - ft) * 0.55;
          ctx.fillStyle = '#fff6d0';
          ctx.beginPath();
          ctx.arc(sx, sy, r * 0.92, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = (1 - ft) * 0.9;
          ctx.strokeStyle = '#ffe28a';
          ctx.lineWidth = Math.max(2, r * 0.12);
          ctx.beginPath();
          ctx.arc(sx, sy, r * (1.05 + 0.9 * ft), 0, TAU);
          ctx.stroke();
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
        }
      } else {
        // mine
        const armed = o.a === 1;
        if (armed) {
          const pulse = 0.5 + 0.5 * Math.sin(now / 170 + o.x * 0.013);
          ctx.globalCompositeOperation = 'lighter';
          drawGlow(glowRed, sx, sy, r * (2.0 + 0.35 * pulse), 0.35 + 0.4 * pulse);
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 0.75;
          ctx.fillStyle = '#240606';
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 0.65 + 0.35 * pulse;
          ctx.strokeStyle = '#ff3b3b';
          ctx.lineWidth = Math.max(2, r * 0.13);
          ctx.beginPath();
          ctx.arc(sx, sy, r * (0.92 + 0.05 * pulse), 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = '#ff9a8a';
          ctx.lineWidth = Math.max(1, r * 0.06);
          ctx.setLineDash(DASH);
          ctx.lineDashOffset = -now / 60;
          ctx.beginPath();
          ctx.arc(sx, sy, r * 0.62, 0, TAU);
          ctx.stroke();
          ctx.setLineDash(NO_DASH);
          ctx.globalAlpha = 0.7 + 0.3 * pulse;
          ctx.fillStyle = '#ffd0c8';
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(2, r * 0.14), 0, TAU);
          ctx.fill();
        } else {
          ctx.globalAlpha = 0.55;
          ctx.fillStyle = '#10131c';
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 0.4;
          ctx.strokeStyle = '#8a93a8';
          ctx.lineWidth = Math.max(1.5, r * 0.08);
          ctx.setLineDash(DASH);
          ctx.beginPath();
          ctx.arc(sx, sy, r * 0.9, 0, TAU);
          ctx.stroke();
          ctx.setLineDash(NO_DASH);
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  function drawTrail(px, py, speed, now) {
    if (speed < 140) return;
    const k = clamp(speed / 2200, 0, 1);
    const life = 0.05 + 0.26 * k;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.strokeStyle = speed > 1500 ? '#ffd9a8' : '#bfe3ff';
    let ax = sxw(px);
    let ay = syw(py);
    const wBase = puckR * scale * 1.6;
    for (let n = 0; n < trCount; n++) {
      const i = (trHead - 1 - n + TRAIL_N * 2) % TRAIL_N;
      const age = (now - trT[i]) / 1000;
      if (age > life) break;
      const f = age / life;
      const bx = sxw(trX[i]);
      const by = syw(trY[i]);
      ctx.globalAlpha = 0.5 * (1 - f) * (0.4 + 0.6 * k);
      ctx.lineWidth = Math.max(1, wBase * (1 - f * 0.85));
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ax = bx;
      ay = by;
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'source-over';
  }

  function pushTrail(x, y, now) {
    if (now - trLast < 8) return;
    if (trCount > 0) {
      const i = (trHead - 1 + TRAIL_N) % TRAIL_N;
      const dx = x - trX[i];
      const dy = y - trY[i];
      if (dx * dx + dy * dy > 36 * puckR * puckR) trCount = 0; // teleport (serve, restart)
    }
    trX[trHead] = x;
    trY[trHead] = y;
    trT[trHead] = now;
    trHead = (trHead + 1) % TRAIL_N;
    if (trCount < TRAIL_N) trCount++;
    trLast = now;
  }

  // local: optional {x, y} world position overriding the snapshot (guest prediction).
  function drawMallet(side, i, now, local) {
    const wx = local ? local.x : curSnap.m[i];
    const wy = local ? local.y : curSnap.m[i + 1];
    if (wy < visTop - malletR || wy > visBot + malletR) return;
    const sx = sxw(wx);
    const sy = syw(wy);
    let sp;
    if (local) {
      sp = Math.hypot(lmVx, lmVy) * Math.exp(-(now - lmT) / 140);
    } else {
      sp = Math.hypot(mv[i], mv[i + 1]) * Math.exp(-(now - mvT) / 140);
    }
    const k = clamp((sp - 250) / 1500, 0, 1);
    if (k > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(side === 'host' ? glowHost : glowGuest, sx, sy, malletR * scale * (2.2 + 0.8 * k), 0.75 * k);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    drawSprite(side === 'host' ? spr.host : spr.guest, sx, sy);
  }

  // --- text ---------------------------------------------------------------------

  function glowText(str, x, y, size, fill, alpha, weight, glow) {
    ctx.font = font(size, weight);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = glow;
    ctx.lineWidth = size * 0.16;
    ctx.globalAlpha = alpha * 0.28;
    ctx.strokeText(str, x, y);
    ctx.fillStyle = fill;
    ctx.globalAlpha = alpha;
    ctx.fillText(str, x, y);
    ctx.globalAlpha = 1;
  }

  function plainText(str, x, y, size, fill, alpha, weight) {
    ctx.font = font(size, weight);
    ctx.fillStyle = fill;
    ctx.globalAlpha = alpha;
    ctx.fillText(str, x, y);
    ctx.globalAlpha = 1;
  }

  function drawScore(x, y, rot, value, label, side, popStart, now) {
    const col = side === 'host' ? HOST_COL : GUEST_COL;
    const rgb = side === 'host' ? HOST_RGB : GUEST_RGB;
    ctx.save();
    ctx.translate(x, y);
    if (rot) ctx.rotate(Math.PI);
    plainText(label, 0, -46 * u, 13 * u, '#ffffff', 0.5, 700);
    const t = (now - popStart) / 1000;
    let sc = 1;
    let hot = 0;
    if (t >= 0 && t < 0.55) {
      sc = 1 + 0.75 * Math.exp(-t * 7) * Math.cos(t * 9);
      hot = Math.exp(-t * 5);
    }
    ctx.save();
    ctx.scale(sc, sc);
    glowText(String(value), 0, 0, 60 * u, hot > 0.25 ? '#ffffff' : col, 0.95, 800, `rgb(${rgb})`);
    ctx.restore();
    if (target <= 11) {
      const gap = 15 * u;
      const x0 = (-(target - 1) * gap) / 2;
      const py = 44 * u;
      for (let i = 0; i < target; i++) {
        ctx.beginPath();
        ctx.arc(x0 + i * gap, py, 4.2 * u, 0, TAU);
        if (i < value) {
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = col;
          ctx.fill();
        } else {
          ctx.globalAlpha = 0.25;
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.3;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawHud(snap, now) {
    const sc = snap.sc || [0, 0];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const padX = 62 * u;
    if (solo) {
      drawScore(rx + padX, ry + rh - 96 * u, false, sc[0], labels[0], 'host', popT[0], now);
      drawScore(rx + rw - padX, ry + 96 * u, true, sc[1], labels[1], 'guest', popT[1], now);
    } else {
      const mine = role === 'host' ? 0 : 1;
      const other = 1 - mine;
      drawScore(rx + padX, ry + rh - 96 * u, false, sc[mine], labels[0], role, popT[mine], now);
      drawScore(rx + rw - padX, ry + 76 * u, false, sc[other], labels[1], role === 'host' ? 'guest' : 'host', popT[other], now);
    }
  }

  // Serve hint: chevrons sliding across the seam toward whoever receives.
  function drawServeHint(snap, now) {
    const recvHost = snap.p[1] > H + G / 2;
    const dir = recvHost ? 1 : -1;
    const col = recvHost ? HOST_COL : GUEST_COL;
    const cycle = 1.3;
    const ph = ((now / 1000) % cycle) / cycle;
    const seamC = H + G / 2;
    const screenDir = (ky > 0 ? 1 : -1) * dir;
    const cx = rx + rw / 2;
    const s = 26 * scale;
    ctx.strokeStyle = col;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2.5, 4 * u);
    for (let k = 0; k < 3; k++) {
      const t = (ph + k) / 3;
      const wy = seamC + dir * (-190 + 380 * t);
      const sy = syw(wy);
      ctx.globalAlpha = Math.sin(Math.PI * t) * 0.65;
      ctx.beginPath();
      ctx.moveTo(cx - s, sy - screenDir * s * 0.55);
      ctx.lineTo(cx, sy);
      ctx.lineTo(cx + s, sy - screenDir * s * 0.55);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }

  // Messages ------------------------------------------------------------------

  // Big pulsing countdown digit at the current origin; tm is seconds remaining.
  function drawCountdownDigit(tm) {
    const n = Math.max(1, Math.ceil(tm));
    const frac = clamp(n - tm, 0, 1);
    const sc = 1.55 - 0.65 * easeOutCubic(Math.min(1, frac / 0.8));
    const a = 1 - frac * frac * 0.9;
    // expanding ring
    ctx.strokeStyle = n === 1 ? '#ffd36b' : '#ffffff';
    ctx.lineWidth = 3 * u;
    ctx.globalAlpha = (1 - frac) * 0.45;
    ctx.beginPath();
    ctx.arc(0, 0, (70 + 170 * frac) * u, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.scale(sc, sc);
    glowText(String(n), 0, 0, 150 * u, n === 1 ? '#ffd36b' : '#ffffff', a, 800, n === 1 ? '#ffb020' : '#8fb4ff');
    ctx.restore();
  }

  function messageFor(side, snap, now, cx, cy, rot) {
    ctx.save();
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(Math.PI);
    const ph = snap.ph;
    if (ph === 'countdown') {
      drawCountdownDigit(snap.tm);
      plainText(solo ? 'Get ready' : 'Grab your mallet', 0, 105 * u, 24 * u, '#ffffff', 0.6, 600);
    } else if (ph === 'goal' && snap.sd === 1) {
      // Post-goal serve countdown: same digit as the pre-match countdown, so the
      // visual cue lines up with the beep the sim emits.
      drawCountdownDigit(snap.tm);
    } else if (ph === 'goal') {
      const el = (now - phaseStart) / 1000;
      const p = clamp(el / 0.42, 0, 1);
      const sc = 0.3 + 0.7 * easeOutBack(p);
      const a = Math.min(1, el / 0.12) * (snap.sd === 0 && snap.tm < 0.3 ? clamp(snap.tm / 0.3, 0, 1) : 1);
      const mine = snap.lg === side;
      const colr = mine ? GOOD : BAD;
      ctx.save();
      ctx.scale(sc, sc);
      glowText('GOAL!', 0, -18 * u, 98 * u, colr, a, 900, colr);
      ctx.restore();
      let sub;
      if (solo && players === 'bot') sub = mine ? 'You scored' : 'Bot scored';
      else sub = mine ? 'You scored' : 'They scored';
      plainText(sub, 0, 58 * u, 28 * u, '#ffffff', 0.75 * a, 600);
    } else if (ph === 'over') {
      const el = (now - phaseStart) / 1000;
      const p = clamp(el / 0.5, 0, 1);
      const sc = 0.3 + 0.7 * easeOutBack(p);
      const a = Math.min(1, el / 0.15);
      const won = snap.wn === side;
      const colr = won ? GOOD : BAD;
      ctx.save();
      ctx.scale(sc, sc);
      glowText(won ? 'YOU WIN' : 'YOU LOSE', 0, -18 * u, 88 * u, colr, a, 900, colr);
      ctx.restore();
      const pulse = 0.5 + 0.5 * Math.sin(now / 280);
      plainText('Tap to play again', 0, 58 * u, 28 * u, '#ffffff', a * (0.4 + 0.5 * pulse), 600);
    }
    ctx.restore();
  }

  function drawMessages(snap, now) {
    const ph = snap.ph;
    if (ph !== 'countdown' && ph !== 'goal' && ph !== 'over') return;
    if (ph === 'over' || ph === 'goal') {
      const el = clamp((now - phaseStart) / 300, 0, 1);
      ctx.globalAlpha = el * (ph === 'over' ? 0.5 : 0.2);
      ctx.fillStyle = '#05080f';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.globalAlpha = 1;
    }
    const cx = rx + rw / 2;
    if (!solo) {
      messageFor(role, snap, now, cx, ry + rh * 0.42, false);
    } else if (players === 'pass') {
      messageFor('host', snap, now, cx, ry + rh * 0.62, false);
      messageFor('guest', snap, now, cx, ry + rh * 0.38, true);
    } else {
      messageFor('host', snap, now, cx, ry + rh * 0.62, false);
    }
  }

  function drawLatency() {
    if (latency == null) return;
    const ms = Math.round(latency);
    const col = ms < 40 ? '#7CFF9A' : ms < 90 ? '#ffd36b' : '#ff6b6b';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.font = font(11, 600);
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.4;
    const lx = rx + rw;
    const ly = ry + rh;
    ctx.fillText(ms + ' ms', lx - 18, ly - 10);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.arc(lx - 10, ly - 14, 3, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  }

  // --- frame --------------------------------------------------------------------

  /**
   * snap: the sim snapshot. puckExtrapolate: seconds to advance the puck along its
   * velocity. now: performance.now() in ms. Safe to call repeatedly with the same
   * snapshot object (events are consumed once per distinct object).
   * localMallet: {x, y} in WORLD coordinates or null. For the guest role only, the
   * guest's own mallet is drawn there instead of at the (lagging) snapshot position;
   * host and solo ignore it.
   */
  function render(snap, puckExtrapolate = 0, now = performance.now(), localMallet = null) {
    if (!snap || !snap.p || !snap.m || !bg || !spr) return; // also a no-op after destroy()
    const dt = lastNow < 0 ? 0.016 : clamp((now - lastNow) / 1000, 0, 0.1);
    lastNow = now;
    if (snap !== curSnap) newSnap(snap, now);
    fx.update(now);

    const shaking = fx.getShake(now, shk);
    const shx = Math.round(shk[0] * 2) / 2;
    const shy = Math.round(shk[1] * 2) / 2;

    // Background (cached) at pixel-exact scale.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (shaking) {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bg, Math.round(shx * dpr), Math.round(shy * dpr));
    } else {
      ctx.drawImage(bg, 0, 0);
    }
    ctx.setTransform(dpr, 0, 0, dpr, shx * dpr, shy * dpr);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();

    const s = snap;
    for (let i = 0; i < goals.length; i++) drawGoal(goals[i], now, dt);

    // Puck position (extrapolated along its velocity).
    const px = s.p[0] + s.p[2] * puckExtrapolate;
    const py = s.p[1] + s.p[3] * puckExtrapolate;
    const pvx = s.p[2];
    const pvy = s.p[3];
    const speed = Math.hypot(pvx, pvy);
    const playing = s.ph === 'play';

    // Seam glow: the puck is about to cross to the other iPad.
    if (playing) {
      const sxp = sxw(px);
      if (solo) {
        // No physical seam without a gap: nothing crosses to another device.
        if (G > 0) {
          const i1 = seamIntensity(py, H);
          const i2 = seamIntensity(py, H + G);
          if (i1 > 0) drawSeamGlow(syw(H), false, i1, sxp, now);
          if (i2 > 0) drawSeamGlow(syw(H + G), true, i2, sxp, now);
        }
      } else {
        const i = seamIntensity(py, role === 'host' ? H + G : H);
        if (i > 0) drawSeamGlow(ry, true, i, sxp, now);
      }
    }

    if (s.ob && s.ob.length) drawObstacles(s.ob, now);

    if (s.ph === 'countdown') drawServeHint(s, now);

    // Trail, glow and puck.
    if (playing) {
      pushTrail(px, py, now);
      drawTrail(px, py, speed, now);
    }
    {
      const sx = sxw(px);
      const sy = syw(py);
      const hitT = (now - fx.state.hitAt) / 1000;
      const gk = clamp((speed - 500) / 1800, 0, 1) * 0.35 + (hitT >= 0 && hitT < 0.22 ? 0.85 * Math.pow(1 - hitT / 0.22, 2) : 0);
      if (gk > 0.02 && playing) {
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(glowWhite, sx, sy, puckR * scale * 2.8, Math.min(1, gk));
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = playing ? 1 : 0.5 + 0.12 * Math.sin(now / 260);
      drawSprite(spr.puck, sx, sy);
      ctx.globalAlpha = 1;
    }

    if (role !== 'guest') drawMallet('host', 0, now);
    if (role !== 'host') {
      let local = null;
      if (role === 'guest' && localMallet && Number.isFinite(localMallet.x) && Number.isFinite(localMallet.y)) {
        local = localMallet;
        const dtL = (now - lmT) / 1000;
        if (!lmInit || dtL > 0.25) {
          lmVx = 0;
          lmVy = 0;
          lmX = local.x;
          lmY = local.y;
          lmT = now;
          lmInit = true;
        } else if (dtL >= 0.004) {
          const k = dtL > 0.1 ? 0.1 / dtL : 1; // keep the estimate sane after a long frame
          lmVx = lmVx * 0.5 + ((local.x - lmX) / dtL) * 0.5 * k;
          lmVy = lmVy * 0.5 + ((local.y - lmY) / dtL) * 0.5 * k;
          lmX = local.x;
          lmY = local.y;
          lmT = now;
        }
      } else {
        lmInit = false;
      }
      drawMallet('guest', 2, now, local);
    }

    fx.draw(ctx, map, now);

    drawHud(s, now);
    drawMessages(s, now);

    ctx.restore();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLatency();
  }

  // --- mapping API --------------------------------------------------------------

  function worldToScreen(wx, wy) {
    return [X0 + kx * wx, Y0 + ky * wy];
  }

  function screenToWorld(sx, sy) {
    return [(sx - X0) / kx, (sy - Y0) / ky];
  }

  function setLatency(ms) {
    latency = ms == null || Number.isNaN(ms) ? null : ms;
  }

  const onResize = () => resize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  resize();

  function destroy() {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    // Zero out offscreen canvases so Safari reclaims their backing stores promptly.
    const free = (cv) => {
      if (cv) {
        cv.width = 0;
        cv.height = 0;
      }
    };
    free(bg);
    bg = null;
    if (spr) {
      free(spr.puck);
      free(spr.host);
      free(spr.guest);
      spr = null;
    }
    for (const cv of bumperSprites.values()) free(cv);
    bumperSprites.clear();
    free(glowWhite);
    free(glowHost);
    free(glowGuest);
    free(glowGold);
    free(glowRed);
  }

  return { render, screenToWorld, worldToScreen, resize, setLatency, destroy };
}
