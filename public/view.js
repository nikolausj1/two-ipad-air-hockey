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
// Layout: the rink rect (rx, ry, rw, rh) is the playing surface; a beveled metal
// frame of width `fw` surrounds it on the sides and at the goal end(s). The seam
// edge of a host/guest screen has no frame, only a bright hairline. Scale is
// chosen so rink + frame fit the screen; the area outside is the "letterbox"
// (vignetted gradient with slow floating bokeh).
//
// Performance notes: everything static (letterbox, ice, markings, frame, seam)
// is painted once into an offscreen canvas on resize. Puck, mallets, bumpers,
// mines, glows and goal rays are pre-rendered sprites. Per frame we only blit,
// draw sprites, a few filled shapes, strokes and text, plus the particle system
// from fx.js. No per-frame gradient creation for static parts and no shadowBlur.

import { createFx } from './fx.js';

const TAU = Math.PI * 2;
const HOST_COL = '#ff7a45';
const GUEST_COL = '#4fd1ff';
const HOST_RGB = '255,122,69';
const GUEST_RGB = '79,209,255';
const GOOD = '#7CFF9A';
const WIN_COL = '#ffd36b';
const LOSE_COL = '#ff7b7b';
const BG = '#04060d';
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, system-ui, sans-serif';
const DASH = [5, 6];
const NO_DASH = [];
const NO_RD = [0, 0];
const TRAIL_N = 32;
const MODE_NAMES = { classic: 'Classic', bumpers: 'Bumpers', ice: 'Ice', heavy: 'Heavy', mines: 'Mines' };
const MSG_PHASES = { ready: 1, countdown: 1, goal: 1, over: 1 };
const NO_UI = { held: false, calibrating: false };
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const REPLAY_RED = '#ff3b3b';
const BAR_MS = 200; // replay letterbox slide time
const DIAG_ROWS = 7;
const DIAG_LABELS = ['fps', 'frame', 'rtt', 'jitter', 'link', 'seq', 'drops'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeOutBack = (p) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const q = p - 1;
  return 1 + c3 * q * q * q + c1 * q * q;
};
const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);

// Rounded-rect subpath with separate top and bottom corner radii.
function rrPath(c, x, y, w, h, rt, rb) {
  c.moveTo(x + rt, y);
  c.lineTo(x + w - rt, y);
  if (rt) c.arcTo(x + w, y, x + w, y + rt, rt);
  c.lineTo(x + w, y + h - rb);
  if (rb) c.arcTo(x + w, y + h, x + w - rb, y + h, rb);
  c.lineTo(x + rb, y + h);
  if (rb) c.arcTo(x, y + h, x, y + h - rb, rb);
  c.lineTo(x, y + rt);
  if (rt) c.arcTo(x, y, x + rt, y, rt);
  c.closePath();
}

export function createView(canvas, role, cfg) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const { W, H, G, puckR, malletR } = cfg;
  const goalW0 = cfg.goalW || W * 0.36;
  const target = cfg.target || 7;
  const mode = cfg.mode || 'classic';
  const players = cfg.players || 'duo';
  const bottomY = 2 * H + G;
  const solo = role === 'solo';
  const fT = W * 0.03; // frame thickness in world units
  const modeLabel = `${MODE_NAMES[mode] || mode} · first to ${target}`;

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
  let fw = 16; // frame width in px
  let ri = 8; // inner corner radius
  let ox = 0; // outer frame rect
  let oy = 0;
  let ow = 1;
  let oh = 1;
  let hasLetterbox = false;
  let X0 = 0;
  let kx = 1;
  let Y0 = 0;
  let ky = 1;
  let u = 1; // HUD unit: 1 at 820 px wide rink
  let destroyed = false;

  let bg = null;
  let spr = null; // sprites, rebuilt on resize
  const bumperSprites = new Map();
  const mineSprites = new Map();
  const goalGrad = {}; // local-space gradients per side, rebuilt on resize
  let rays = null;
  let seamGrad = null;
  let seamR = 1;
  let glowH = 40;

  const glowWhite = makeGlow('190,225,255');
  const glowHost = makeGlow(HOST_RGB);
  const glowGuest = makeGlow(GUEST_RGB);
  const glowGold = makeGlow('255,210,80');
  const glowRed = makeGlow('255,60,50');
  const glowGreen = makeGlow('80,255,150');
  const glowBlack = makeGlow('0,0,0');
  const bokehGlows = [glowWhite, glowHost, glowGuest];

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

    // Rink + frame must fit. The seam edge of host/guest has no frame.
    const needH = solo ? visH + 2 * fT : visH + fT;
    scale = Math.min(screenW / (W + 2 * fT), screenH / needH);
    fw = fT * scale;
    ri = fw * 0.6;
    rw = W * scale;
    rh = visH * scale;
    rx = (screenW - rw) / 2;
    // Host/guest: anchor the seam edge (screen top) to the physical top edge of the
    // device and leave any slack at the bottom (goal end). Solo stays centred.
    ry = solo ? (screenH - rh) / 2 : 0;
    ox = rx - fw;
    ow = rw + 2 * fw;
    oy = solo ? ry - fw : -80;
    oh = ry + rh + fw - oy;
    hasLetterbox = ox > 3 || oy + oh < screenH - 3 || (solo && oy > 3);
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
    u = clamp(rw / 820, 0.62, 1.6);
    map.X0 = X0;
    map.kx = kx;
    map.Y0 = Y0;
    map.ky = ky;
    map.scale = scale;
    map.dpr = dpr;
    rpBar = clamp(screenH * 0.07, 30, 78);
    rpZoom = 1 - (2 * rpBar) / screenH;
    glowH = Math.max(26, rh * 0.05);
    seamR = Math.max(60, rw * 0.3);
  }

  function resize() {
    if (destroyed) return;
    layout();
    buildSprites();
    buildGradients();
    buildBg();
    buildReplayLayers();
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

  function discShadow(c, cx, cy, r, blur, ox_, oy_, alpha) {
    c.save();
    c.shadowColor = `rgba(0,0,0,${alpha})`;
    c.shadowBlur = blur * dpr;
    c.shadowOffsetX = ox_ * dpr;
    c.shadowOffsetY = oy_ * dpr;
    c.fillStyle = '#000';
    c.beginPath();
    c.arc(cx, cy, r, 0, TAU);
    c.fill();
    c.restore();
  }

  function makePuck(r) {
    const pad = Math.ceil(r * 0.3) + 3;
    return makeSprite((r + pad) * 2, (c, cx, cy) => {
      // outer bevel: bright top-left, deep bottom-right
      let g = c.createLinearGradient(cx - r * 0.8, cy - r * 0.8, cx + r * 0.8, cy + r * 0.8);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.28, '#d9e1f6');
      g.addColorStop(0.58, '#6874a0');
      g.addColorStop(1, '#171c38');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r, 0, TAU);
      c.fill();
      // crisp outline
      c.strokeStyle = 'rgba(8,12,34,0.8)';
      c.lineWidth = 1;
      c.beginPath();
      c.arc(cx, cy, r - 0.5, 0, TAU);
      c.stroke();
      // flat top face, slightly cooler than the bevel
      const fr = r * 0.74;
      g = c.createRadialGradient(cx - fr * 0.4, cy - fr * 0.45, fr * 0.05, cx, cy, fr * 1.15);
      g.addColorStop(0, '#f5f8ff');
      g.addColorStop(0.45, '#cdd6ee');
      g.addColorStop(0.85, '#8d9acb');
      g.addColorStop(1, '#6f7cae');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, fr, 0, TAU);
      c.fill();
      // chamfer between face and bevel (inverse lighting)
      g = c.createLinearGradient(cx - fr, cy - fr, cx + fr, cy + fr);
      g.addColorStop(0, 'rgba(30,40,95,0.8)');
      g.addColorStop(0.5, 'rgba(30,40,95,0.1)');
      g.addColorStop(1, 'rgba(255,255,255,0.9)');
      c.strokeStyle = g;
      c.lineWidth = Math.max(1.2, r * 0.08);
      c.beginPath();
      c.arc(cx, cy, fr, 0, TAU);
      c.stroke();
      // inner groove
      c.lineWidth = Math.max(1, r * 0.06);
      c.strokeStyle = 'rgba(40,52,110,0.45)';
      c.beginPath();
      c.arc(cx, cy, r * 0.46, 0, TAU);
      c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.6)';
      c.beginPath();
      c.arc(cx + 0.5, cy + 0.7, r * 0.46, 0, TAU);
      c.stroke();
      // fixed specular: it belongs to the light, never rotates with the puck
      g = c.createLinearGradient(cx, cy - r * 0.7, cx, cy - r * 0.1);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.beginPath();
      c.ellipse(cx - r * 0.22, cy - r * 0.4, r * 0.46, r * 0.2, -0.55, 0, TAU);
      c.fill();
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(cx - r * 0.45, cy - r * 0.55, Math.max(1.1, r * 0.08), 0, TAU);
      c.fill();
    });
  }

  function makePuckShadow(r) {
    const pad = Math.ceil(r * 0.9);
    return makeSprite((r + pad) * 2, (c, cx, cy) => {
      const g = c.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 1.45);
      g.addColorStop(0, 'rgba(0,0,10,0.62)');
      g.addColorStop(0.55, 'rgba(0,0,10,0.42)');
      g.addColorStop(1, 'rgba(0,0,10,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r * 1.45, 0, TAU);
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

  // Brass post: shadow, turned collar, banded body with a metallic sheen, domed cap.
  function makeBumper(r) {
    const pad = Math.ceil(r * 0.5) + 2;
    return makeSprite((r + pad) * 2, (c, cx, cy) => {
      discShadow(c, cx, cy, r, r * 0.5, r * 0.15, r * 0.25, 0.6);
      // outer brass collar
      let g = c.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      g.addColorStop(0, '#fff3bd');
      g.addColorStop(0.25, '#e2b647');
      g.addColorStop(0.55, '#9b6f19');
      g.addColorStop(0.8, '#5a3c08');
      g.addColorStop(1, '#2c1c03');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r, 0, TAU);
      c.fill();
      c.strokeStyle = 'rgba(40,24,2,0.7)';
      c.lineWidth = 1;
      c.beginPath();
      c.arc(cx, cy, r - 0.5, 0, TAU);
      c.stroke();
      // post body
      g = c.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.05, cx, cy, r * 0.85);
      g.addColorStop(0, '#fff6c8');
      g.addColorStop(0.4, '#e6b343');
      g.addColorStop(0.8, '#9a6b16');
      g.addColorStop(1, '#6a4510');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r * 0.84, 0, TAU);
      c.fill();
      // turned ridges
      c.lineWidth = Math.max(1, r * 0.04);
      c.strokeStyle = 'rgba(70,40,5,0.45)';
      c.beginPath();
      c.arc(cx, cy, r * 0.7, 0, TAU);
      c.stroke();
      c.strokeStyle = 'rgba(255,240,170,0.4)';
      c.beginPath();
      c.arc(cx + 0.5, cy + 0.7, r * 0.7, 0, TAU);
      c.stroke();
      // metallic sheen: a diagonal band of light across the body
      c.save();
      c.beginPath();
      c.arc(cx, cy, r * 0.84, 0, TAU);
      c.clip();
      g = c.createLinearGradient(cx - r * 0.9, cy - r * 0.9, cx + r * 0.9, cy + r * 0.9);
      g.addColorStop(0.2, 'rgba(255,255,255,0)');
      g.addColorStop(0.36, 'rgba(255,252,225,0.55)');
      g.addColorStop(0.46, 'rgba(255,255,255,0)');
      g.addColorStop(0.72, 'rgba(255,230,150,0.28)');
      g.addColorStop(0.8, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(cx - r, cy - r, r * 2, r * 2);
      c.restore();
      // dome
      g = c.createRadialGradient(cx - r * 0.18, cy - r * 0.22, r * 0.02, cx, cy, r * 0.46);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.35, '#ffe38a');
      g.addColorStop(1, '#a8741c');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r * 0.46, 0, TAU);
      c.fill();
      c.strokeStyle = 'rgba(90,55,8,0.5)';
      c.lineWidth = Math.max(1, r * 0.04);
      c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.85)';
      c.beginPath();
      c.ellipse(cx - r * 0.15, cy - r * 0.2, r * 0.13, r * 0.07, -0.7, 0, TAU);
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

  // Mine casing: dark steel, studs, recessed LED socket. The LED itself is dynamic.
  function makeMine(r) {
    const pad = Math.ceil(r * 0.4) + 2;
    return makeSprite((r + pad) * 2, (c, cx, cy) => {
      discShadow(c, cx, cy, r, r * 0.45, r * 0.1, r * 0.2, 0.6);
      let g = c.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.05, cx, cy, r * 1.05);
      g.addColorStop(0, '#59607a');
      g.addColorStop(0.5, '#262b3b');
      g.addColorStop(1, '#0e1018');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r, 0, TAU);
      c.fill();
      g = c.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      g.addColorStop(0, 'rgba(255,255,255,0.7)');
      g.addColorStop(0.45, 'rgba(255,255,255,0.05)');
      g.addColorStop(1, 'rgba(0,0,0,0.8)');
      c.strokeStyle = g;
      c.lineWidth = Math.max(1.5, r * 0.09);
      c.beginPath();
      c.arc(cx, cy, r - c.lineWidth / 2, 0, TAU);
      c.stroke();
      // studs
      for (let k = 0; k < 8; k++) {
        const a = (k + 0.5) * (TAU / 8);
        const sx = cx + Math.cos(a) * r * 0.7;
        const sy = cy + Math.sin(a) * r * 0.7;
        const sr = Math.max(1.5, r * 0.085);
        g = c.createRadialGradient(sx - sr * 0.3, sy - sr * 0.3, sr * 0.1, sx, sy, sr);
        g.addColorStop(0, '#c9d0e6');
        g.addColorStop(1, '#3a4058');
        c.fillStyle = g;
        c.beginPath();
        c.arc(sx, sy, sr, 0, TAU);
        c.fill();
      }
      // recessed plate
      c.fillStyle = 'rgba(0,0,0,0.4)';
      c.beginPath();
      c.arc(cx, cy, r * 0.46, 0, TAU);
      c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.22)';
      c.lineWidth = Math.max(1, r * 0.04);
      c.beginPath();
      c.arc(cx + 0.4, cy + 0.6, r * 0.46, 0, TAU);
      c.stroke();
      // LED socket
      c.fillStyle = '#05060a';
      c.beginPath();
      c.arc(cx, cy, r * 0.2, 0, TAU);
      c.fill();
      c.strokeStyle = 'rgba(190,200,230,0.5)';
      c.lineWidth = Math.max(1, r * 0.04);
      c.stroke();
    });
  }

  function getMineSprite(rCss) {
    const key = Math.round(rCss * 2);
    let s = mineSprites.get(key);
    if (!s) {
      s = makeMine(key / 2);
      mineSprites.set(key, s);
    }
    return s;
  }

  // Fan of light rays shining from a goal mouth into the rink. Origin at the top centre.
  function makeRays(rgb) {
    const w = 640;
    const h = 320;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const c = cv.getContext('2d');
    const ox_ = w / 2;
    const n = 11;
    c.fillStyle = '#fff';
    for (let i = 0; i < n; i++) {
      const a = Math.PI / 2 + ((i - (n - 1) / 2) / ((n - 1) / 2)) * 1.15;
      const hw = i % 2 ? 0.028 : 0.05;
      c.beginPath();
      c.moveTo(ox_, 0);
      c.lineTo(ox_ + Math.cos(a - hw) * h * 3, Math.sin(a - hw) * h * 3);
      c.lineTo(ox_ + Math.cos(a + hw) * h * 3, Math.sin(a + hw) * h * 3);
      c.closePath();
      c.fill();
    }
    c.globalCompositeOperation = 'source-in';
    const g = c.createRadialGradient(ox_, 0, 0, ox_, 0, h);
    g.addColorStop(0, `rgba(255,255,255,0.95)`);
    g.addColorStop(0.25, `rgba(${rgb},0.7)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    return cv;
  }

  function buildSprites() {
    const pr = puckR * scale;
    const mr = malletR * scale;
    spr = {
      puck: makePuck(pr),
      puckShadow: makePuckShadow(pr),
      host: makeMallet(mr, '#ffc3a2', '#ff7a45', '#b0400f', 'rgba(70,20,0,0.9)'),
      guest: makeMallet(mr, '#b9f0ff', '#4fd1ff', '#1580ab', 'rgba(0,40,60,0.9)'),
    };
    bumperSprites.clear();
    mineSprites.clear();
    rays = { host: makeRays(HOST_RGB), guest: makeRays(GUEST_RGB) };
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
      const flash = g;
      // Recessed slot: dark at the lip, the player's colour at the back wall.
      g = ctx.createLinearGradient(0, 0, 0, fw);
      g.addColorStop(0, 'rgba(0,0,0,0.25)');
      g.addColorStop(0.55, `rgba(${rgb},0.16)`);
      g.addColorStop(1, `rgba(${rgb},0.7)`);
      goalGrad[side] = { glow, flash, slot: g };
    }
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, seamR);
    g.addColorStop(0, 'rgba(220,242,255,0.95)');
    g.addColorStop(0.3, 'rgba(120,200,255,0.4)');
    g.addColorStop(1, 'rgba(120,200,255,0)');
    seamGrad = g;
  }

  // --- static rink --------------------------------------------------------------

  // Rink rect expanded outward by d, as a rounded subpath. d = 0 is the playing
  // surface, d = fw the outer edge of the frame. The seam end is never rounded.
  function framePath(c, d) {
    const r = ri + d;
    const y0 = solo ? ry - d : -80;
    rrPath(c, rx - d, y0, rw + 2 * d, ry + rh + d - y0, solo ? r : 0, r);
  }

  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function noiseCanvas(w, h, rand, lo, hi) {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const c = cv.getContext('2d');
    const id = c.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const v = lo + rand() * (hi - lo);
      id.data[i * 4] = v;
      id.data[i * 4 + 1] = v;
      id.data[i * 4 + 2] = v;
      id.data[i * 4 + 3] = 255;
    }
    c.putImageData(id, 0, 0);
    return cv;
  }

  function drawLetterbox(c) {
    const cx = screenW / 2;
    const cy = solo ? screenH / 2 : screenH * 0.42;
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(screenW, screenH) * 0.62);
    g.addColorStop(0, '#17234d');
    g.addColorStop(0.5, '#0a1230');
    g.addColorStop(1, '#03050c');
    c.fillStyle = g;
    c.fillRect(0, 0, screenW, screenH);
  }

  function drawSurface(c) {
    const ice = mode === 'ice';
    const rand = rng(90210);
    const lcx = rx + rw / 2;
    const lcy = solo ? ry + rh / 2 : ry + rh * 0.36;
    const lR = Math.hypot(rw / 2, Math.max(lcy - ry, ry + rh - lcy)) * 1.02;

    // Overhead light: bright pool, falling off to the corners.
    let g = c.createRadialGradient(lcx, lcy, 0, lcx, lcy, lR);
    if (ice) {
      g.addColorStop(0, '#79a6d8');
      g.addColorStop(0.4, '#4a78b2');
      g.addColorStop(0.75, '#274b82');
      g.addColorStop(1, '#14284f');
    } else {
      g.addColorStop(0, '#4a73ad');
      g.addColorStop(0.4, '#2f568e');
      g.addColorStop(0.75, '#1b3563');
      g.addColorStop(1, '#0d1a38');
    }
    c.fillStyle = g;
    c.fillRect(rx, ry, rw, rh);

    // Large-scale frosting: soft blotches.
    for (let i = 0; i < 34; i++) {
      const bx = rx + rand() * rw;
      const by = ry + rand() * rh;
      const br = rw * (0.12 + rand() * 0.3);
      const light = rand() < 0.65;
      const a = 0.02 + rand() * 0.03;
      g = c.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0, light ? `rgba(215,235,255,${a})` : `rgba(10,25,60,${a * 1.4})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(bx - br, by - br, br * 2, br * 2);
    }

    // Smooth value noise (two octaves, upscaled with filtering), soft-light blended.
    c.save();
    c.beginPath();
    c.rect(rx, ry, rw, rh);
    c.clip();
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.globalCompositeOperation = 'soft-light';
    const aspect = rh / rw;
    const n1 = noiseCanvas(14, Math.max(8, Math.round(14 * aspect)), rand, 70, 190);
    const n2 = noiseCanvas(40, Math.max(8, Math.round(40 * aspect)), rand, 90, 170);
    c.globalAlpha = ice ? 0.4 : 0.3;
    c.drawImage(n1, rx, ry, rw, rh);
    c.globalAlpha = ice ? 0.22 : 0.16;
    c.drawImage(n2, rx, ry, rw, rh);
    c.restore();

    // Fine frost grain (tiled, very faint).
    {
      const tile = document.createElement('canvas');
      tile.width = 128;
      tile.height = 128;
      const tc = tile.getContext('2d');
      const id = tc.createImageData(128, 128);
      for (let i = 0; i < 128 * 128; i++) {
        const r0 = rand();
        const on = r0 < 0.16;
        id.data[i * 4] = 225;
        id.data[i * 4 + 1] = 240;
        id.data[i * 4 + 2] = 255;
        id.data[i * 4 + 3] = on ? 6 + rand() * (ice ? 26 : 18) : 0;
      }
      tc.putImageData(id, 0, 0);
      c.fillStyle = c.createPattern(tile, 'repeat');
      c.fillRect(rx, ry, rw, rh);
    }

    // Soft sheen from the lamp.
    c.save();
    c.translate(lcx, lcy);
    c.scale(1, 0.62);
    g = c.createRadialGradient(0, 0, 0, 0, 0, rw * 0.55);
    g.addColorStop(0, `rgba(235,246,255,${ice ? 0.17 : 0.11})`);
    g.addColorStop(1, 'rgba(235,246,255,0)');
    c.fillStyle = g;
    c.fillRect(-rw, -rw, rw * 2, rw * 2);
    c.restore();

    // Accent wash at each goal end.
    for (const gl of goals) {
      const gy = gl.top ? ry : ry + rh;
      const rgb = gl.side === 'host' ? HOST_RGB : GUEST_RGB;
      g = c.createRadialGradient(lcx, gy, 0, lcx, gy, Math.max(rw, rh * 0.5) * 0.8);
      g.addColorStop(0, `rgba(${rgb},0.2)`);
      g.addColorStop(0.5, `rgba(${rgb},0.06)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      c.fillStyle = g;
      c.fillRect(rx, ry, rw, rh);
    }

    drawMarkings(c);
  }

  function drawMarkings(c) {
    const lw = Math.max(1.5, 2 * u);
    // Face-off dots + serve spots per visible half.
    const halves = [];
    if (role !== 'guest') halves.push({ yA: H + G, rgb: HOST_RGB });
    if (role !== 'host') halves.push({ yA: 0, rgb: GUEST_RGB });
    for (const h of halves) {
      const cy = syw(h.yA + H / 2);
      const cx = rx + rw / 2;
      c.fillStyle = 'rgba(235,245,255,0.2)';
      c.strokeStyle = 'rgba(235,245,255,0.13)';
      c.lineWidth = lw * 0.8;
      for (const fx_ of [0.2, 0.8]) {
        const x = rx + rw * fx_;
        c.beginPath();
        c.arc(x, cy, Math.max(3, 5 * u), 0, TAU);
        c.fill();
        c.beginPath();
        c.arc(x, cy, 26 * u, 0, TAU);
        c.stroke();
      }
      c.beginPath();
      c.arc(cx, cy, Math.max(3, 4.5 * u), 0, TAU);
      c.fill();
      c.beginPath();
      c.arc(cx, cy, puckR * 2.1 * scale, 0, TAU);
      c.stroke();
    }

    // Goal crease arcs.
    for (const gl of goals) {
      const rgb = gl.side === 'host' ? HOST_RGB : GUEST_RGB;
      const gy = gl.top ? ry : ry + rh;
      const R = goalW0 * scale * 0.78;
      c.save();
      c.translate(rx + rw / 2, gy);
      c.scale(1, gl.top ? 1 : -1);
      const g = c.createRadialGradient(0, 0, R * 0.2, 0, 0, R);
      g.addColorStop(0, `rgba(${rgb},0.2)`);
      g.addColorStop(1, `rgba(${rgb},0.03)`);
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, 0, R, 0, Math.PI);
      c.closePath();
      c.fill();
      c.strokeStyle = `rgba(${rgb},0.5)`;
      c.lineWidth = lw;
      c.beginPath();
      c.arc(0, 0, R, 0, Math.PI);
      c.stroke();
      c.strokeStyle = `rgba(${rgb},0.14)`;
      c.lineWidth = lw * 4;
      c.beginPath();
      c.arc(0, 0, R + lw * 2, 0, Math.PI);
      c.stroke();
      c.restore();
    }

    // Centre circle straddling the seam.
    const ccx = rx + rw / 2;
    const ccy = syw(H + G / 2);
    const cr = W * 0.18 * scale;
    c.beginPath();
    c.arc(ccx, ccy, cr, 0, TAU);
    c.strokeStyle = 'rgba(200,225,255,0.07)';
    c.lineWidth = lw * 5;
    c.stroke();
    c.strokeStyle = 'rgba(235,245,255,0.3)';
    c.lineWidth = lw;
    c.stroke();
    c.beginPath();
    c.arc(ccx, ccy, cr * 0.34, 0, TAU);
    c.strokeStyle = 'rgba(235,245,255,0.13)';
    c.lineWidth = lw * 0.7;
    c.stroke();
    c.fillStyle = 'rgba(235,245,255,0.3)';
    c.beginPath();
    c.arc(ccx, ccy, Math.max(3, 5 * u), 0, TAU);
    c.fill();
  }

  // Solo with no seam gap: a faint line so the two halves read clearly.
  function drawCentreLine(c) {
    const y = Math.round(syw(H + G / 2)) + 0.5;
    c.strokeStyle = 'rgba(235,245,255,0.18)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(rx, y);
    c.lineTo(rx + rw, y);
    c.stroke();
  }

  // Solo with a seam gap: a dark beveled bezel band between the two halves.
  function drawBand(c) {
    const t = syw(H);
    const b = syw(H + G);
    const bh = b - t;
    if (bh < 1) return;
    let g = c.createLinearGradient(0, t, 0, b);
    g.addColorStop(0, '#2b3350');
    g.addColorStop(0.2, '#0a0e1a');
    g.addColorStop(0.8, '#0a0e1a');
    g.addColorStop(1, '#2b3350');
    c.fillStyle = g;
    c.fillRect(rx, t, rw, bh);
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
    c.fillStyle = 'rgba(255,255,255,0.22)';
    c.fillRect(rx, t, rw, 1);
    c.fillRect(rx, b - 1, rw, 1);
    c.fillStyle = 'rgba(120,140,200,0.2)';
    c.beginPath();
    c.arc(rx + rw / 2, t + bh / 2, Math.min(3.5, bh * 0.14), 0, TAU);
    c.fill();
  }

  // The top edge of a host/guest screen is where the other iPad begins: no frame,
  // just a thin bright hairline so both halves read as one table.
  function drawSeamEdge(c) {
    let g = c.createLinearGradient(0, ry, 0, ry + 22);
    g.addColorStop(0, 'rgba(190,225,255,0.2)');
    g.addColorStop(1, 'rgba(190,225,255,0)');
    c.fillStyle = g;
    c.fillRect(rx, ry, rw, 22);
    c.fillStyle = 'rgba(235,246,255,0.8)';
    c.fillRect(rx, ry, rw, 1);
    // continue across the frame sides, dimmer
    c.fillStyle = 'rgba(235,246,255,0.35)';
    c.fillRect(ox, ry, fw, 1);
    c.fillRect(rx + rw, ry, fw, 1);
  }

  // Metal frame around the rink: drop shadow, body, machined groove, lit bevel,
  // inner lip and a coloured inlay.
  function drawFrameShadow(c) {
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.75)';
    c.shadowBlur = fw * 1.6 * dpr;
    c.shadowOffsetY = fw * 0.35 * dpr;
    c.fillStyle = '#000';
    c.beginPath();
    framePath(c, fw);
    c.fill();
    c.restore();
  }

  function drawFrame(c) {
    const x1 = rx + rw + fw;
    const y1 = ry + rh + fw;
    // body
    let g = c.createLinearGradient(rx - fw, ry, x1, y1);
    g.addColorStop(0, '#79849e');
    g.addColorStop(0.3, '#4a536a');
    g.addColorStop(0.65, '#2a3144');
    g.addColorStop(1, '#171b28');
    c.fillStyle = g;
    c.beginPath();
    framePath(c, fw);
    framePath(c, 0);
    c.fill('evenodd');

    c.save();
    c.beginPath();
    framePath(c, fw);
    framePath(c, 0);
    c.clip('evenodd');

    // broad reflections
    g = c.createLinearGradient(rx - fw, 0, x1, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0)');
    g.addColorStop(0.82, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,0.05)');
    c.fillStyle = g;
    c.fillRect(rx - fw, -80, rw + 2 * fw, y1 + 80);

    // outer edge highlight
    g = c.createLinearGradient(rx - fw, ry, x1, y1);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0.5)');
    c.strokeStyle = g;
    c.lineWidth = 3;
    c.beginPath();
    framePath(c, fw);
    c.stroke();

    // machined groove
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.beginPath();
    framePath(c, fw * 0.8);
    c.stroke();
    c.strokeStyle = 'rgba(255,255,255,0.12)';
    c.beginPath();
    framePath(c, fw * 0.8 - 1);
    c.stroke();

    // lit bevel on the inner side of the frame
    const bw = fw * 0.34;
    g = c.createLinearGradient(rx, ry, rx + rw, ry + rh);
    g.addColorStop(0, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.4, 'rgba(210,222,255,0.2)');
    g.addColorStop(0.62, 'rgba(0,0,0,0.3)');
    g.addColorStop(1, 'rgba(0,0,0,0.7)');
    c.strokeStyle = g;
    c.lineWidth = bw;
    c.beginPath();
    framePath(c, bw / 2);
    c.stroke();

    // coloured inlay running round the rink: guest blue -> white -> host orange
    const ig = c.createLinearGradient(0, syw(0), 0, syw(bottomY));
    ig.addColorStop(0, 'rgb(79,209,255)');
    ig.addColorStop((H + G / 2) / bottomY, 'rgb(215,232,255)');
    ig.addColorStop(1, 'rgb(255,122,69)');
    c.strokeStyle = ig;
    c.lineCap = 'round';
    c.beginPath();
    framePath(c, fw * 0.56);
    c.globalAlpha = 0.16;
    c.lineWidth = Math.max(5, fw * 0.3);
    c.stroke();
    c.globalAlpha = 0.95;
    c.lineWidth = Math.max(1.5, fw * 0.08);
    c.stroke();
    c.globalAlpha = 1;
    c.restore();

    // inner lip: dark line against the ice, then a bright catch-light
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(0,0,0,0.7)';
    c.beginPath();
    framePath(c, 0.5);
    c.stroke();
    g = c.createLinearGradient(rx, ry, rx + rw, ry + rh);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.08)');
    g.addColorStop(1, 'rgba(255,255,255,0.18)');
    c.strokeStyle = g;
    c.beginPath();
    framePath(c, -0.5);
    c.stroke();
  }

  // Shadow the frame casts onto the ice (light from the top left).
  function drawInnerShadow(c) {
    c.save();
    c.beginPath();
    framePath(c, 0);
    c.clip();
    c.shadowColor = 'rgba(0,6,20,0.7)';
    c.shadowBlur = fw * 1.1 * dpr;
    c.shadowOffsetX = fw * 0.14 * dpr;
    c.shadowOffsetY = fw * 0.22 * dpr;
    c.fillStyle = '#000';
    c.beginPath();
    c.rect(-200, -300, screenW + 400, screenH + 600);
    framePath(c, 0);
    c.fill('evenodd');
    c.restore();
  }

  function buildBg() {
    if (!bg) bg = document.createElement('canvas');
    bg.width = canvas.width;
    bg.height = canvas.height;
    const c = bg.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = BG;
    c.fillRect(0, 0, screenW, screenH);
    drawLetterbox(c);
    drawFrameShadow(c);

    c.save();
    c.beginPath();
    framePath(c, 0);
    c.clip();
    drawSurface(c);
    if (solo) {
      if (G > 0) drawBand(c);
      else drawCentreLine(c);
    }
    c.restore();
    drawInnerShadow(c);
    drawFrame(c);
    if (!solo) drawSeamEdge(c);
  }

  // --- dynamic state ------------------------------------------------------------

  let curSnap = null;
  let lastNow = -1;
  let lastPhase = null;
  let phaseStart = 0;
  let outSnap = null; // frozen copy of the previous message phase, fading out
  let outT = -1e9;
  let outEl = 0;
  let inLabel = false;
  let labelT = -1e9;
  let lastSc0 = -1;
  let lastSc1 = -1;
  let goT = -1e9;
  const popT = [-1e9, -1e9];
  const progK = [0, 0];
  const prevRd = [0, 0];
  const readyT = [-1e9, -1e9];
  const heldK = { v: 0 };
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
  const mineFlashT = [];
  let latency = null;
  let shOx = 0; // puck shadow offset (px), lags behind the puck
  let shOy = 0;
  let uiNow = NO_UI;
  let gA = 1; // alpha multiplier for message text (phase transitions)

  // Instant replay treatment (ui.replay): letterbox bars, REPLAY badge, progress line.
  let replayOn = false;
  let rpK = 0; // 0..1 slide progress of the bars (eased when drawn)
  let rpT = 0; // last replay progress 0..1 (kept while the bars slide out)
  let rpSpeed = 1;
  let rpBar = 40; // bar height in px (set in layout)
  let rpZoom = 1; // world zoom while the bars are in, so goals stay visible
  let vignette = null; // screen-sized dark-edge overlay, built on resize
  let grain = null; // tiled noise pattern
  let grainPat = null;
  let grainSeed = 0;
  let grainT = 0;
  // Predicted-hit ring (ui.predicted).
  let predK = 0;
  // Diagnostics panel (ui.diag): cached strings so the steady state does not allocate.
  const diagStr = new Array(DIAG_ROWS).fill('');
  const diagNum = new Array(DIAG_ROWS).fill(NaN);
  const diagCol = new Array(DIAG_ROWS).fill('#ffffff');
  let diagKind = '';
  // Identity of the last distinct snapshot. A shallow copy of a snapshot shares the
  // same p/m arrays, so copies count as the same snapshot.
  let curP = null;
  let curM = null;
  let liveP = null; // p/m of the last non-replay snapshot
  let liveM = null;

  const trX = new Float64Array(TRAIL_N);
  const trY = new Float64Array(TRAIL_N);
  const trT = new Float64Array(TRAIL_N);
  let trHead = 0;
  let trCount = 0;
  let trLast = -1e9;
  const RB = TRAIL_N + 2;
  const rbX = new Float64Array(RB);
  const rbY = new Float64Array(RB);
  const rbF = new Float64Array(RB);
  const rbNX = new Float64Array(RB);
  const rbNY = new Float64Array(RB);

  // Slow floating bokeh for the letterbox.
  const bokeh = [];
  {
    const r = rng(4242);
    for (let i = 0; i < 18; i++) {
      bokeh.push({ x: r(), y: r(), r: 14 + r() * 48, sp: 5 + r() * 12, ph: r() * TAU, tint: i % 3 === 0 ? 1 : i % 3 === 1 ? 2 : 0, a: 0.05 + r() * 0.11 });
    }
  }

  function newSnap(snap, now) {
    if (snap.ph !== lastPhase) {
      if (curSnap && lastPhase && MSG_PHASES[lastPhase]) {
        outSnap = { ph: lastPhase, tm: curSnap.tm, sd: curSnap.sd, lg: curSnap.lg, wn: curSnap.wn, sc: curSnap.sc, rd: curSnap.rd };
        outT = now;
        outEl = (now - phaseStart) / 1000;
      }
      lastPhase = snap.ph;
      phaseStart = now;
      trCount = 0;
      const inGroup = snap.ph === 'ready' || snap.ph === 'countdown';
      if (inGroup && !inLabel) labelT = now;
      else if (!inGroup && inLabel) labelT = now;
      inLabel = inGroup;
    }
    const sc = snap.sc || [0, 0];
    if (lastSc0 >= 0) {
      // During a replay the score may step backwards; only pop on a real increase.
      if (replayOn ? sc[0] > lastSc0 : sc[0] !== lastSc0) popT[0] = now;
      if (replayOn ? sc[1] > lastSc1 : sc[1] !== lastSc1) popT[1] = now;
    }
    lastSc0 = sc[0];
    lastSc1 = sc[1];

    const rd = snap.rd || NO_RD;
    for (let i = 0; i < 2; i++) {
      if (rd[i] && !prevRd[i]) readyT[i] = now;
      prevRd[i] = rd[i] ? 1 : 0;
    }

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

    // Events of a live snapshot are consumed once: coming back from a replay to the
    // very snapshot (or a shallow copy of it) that was live before must not re-fire.
    const seenLive = snap.p === liveP && snap.m === liveM;
    if (!replayOn) {
      liveP = snap.p;
      liveM = snap.m;
    }
    const ev = seenLive ? null : snap.ev;
    if (ev && ev.length) {
      const n = Math.min(ev.length, 16);
      for (let i = 0; i < n; i++) {
        const e = ev[i];
        if (!e) continue;
        fx.onEvent(e, now, snap);
        if (e.k === 'bumper' && snap.ob) markObstacle(snap.ob, e, now, 'bumper', bumperFlashT);
        else if (e.k === 'mine' && snap.ob) markObstacle(snap.ob, e, now, 'mine', mineFlashT);
        else if (e.k === 'go' && !replayOn) goT = now;
      }
    }
    curSnap = snap;
    curP = snap.p;
    curM = snap.m;
  }

  function markObstacle(ob, e, now, kind, arr) {
    let best = -1;
    let bd = 1e12;
    for (let i = 0; i < ob.length; i++) {
      if (ob[i].k !== kind) continue;
      const d = (ob[i].x - e.x) * (ob[i].x - e.x) + (ob[i].y - e.y) * (ob[i].y - e.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) arr[best] = now;
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

  function drawBokeh(now) {
    const t = now / 1000;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, screenW, screenH);
    ctx.rect(ox, oy, ow, oh);
    ctx.clip('evenodd');
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < bokeh.length; i++) {
      const b = bokeh[i];
      const x = b.x * screenW + Math.sin(t * 0.13 + b.ph) * 26;
      let y = (b.y * screenH - t * b.sp) % screenH;
      if (y < 0) y += screenH;
      const r = b.r * u;
      ctx.globalAlpha = b.a * (0.7 + 0.3 * Math.sin(t * 0.5 + b.ph * 2));
      ctx.drawImage(bokehGlows[b.tint], x - r, y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  // Goal slot: a recessed, glowing opening cut into the frame. Drawn unclipped,
  // over the frame, with the tweened mouth width.
  function drawGoalSlot(g, now) {
    const gwPx = g.w * scale;
    const half = gwPx / 2;
    const col = g.side === 'host' ? HOST_COL : GUEST_COL;
    const cx = rx + rw / 2;
    const edgeY = g.top ? ry : ry + rh;
    const pulse = 0.82 + 0.18 * Math.sin(now / 420 + g.idx * 2);
    const grads = goalGrad[g.side];
    const glowSpr = g.side === 'host' ? glowHost : glowGuest;
    const bwall = Math.max(2, fw * 0.14);

    ctx.save();
    ctx.translate(cx, edgeY);
    ctx.scale(1, g.top ? -1 : 1); // local +y points out of the rink, into the frame

    // lip cut, then the dark recess
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(-half - 3, -1, gwPx + 6, fw + 2);
    ctx.fillStyle = '#04060b';
    ctx.fillRect(-half, -1, gwPx, fw + 1);
    ctx.fillStyle = grads.slot;
    ctx.fillRect(-half, 0, gwPx, fw);
    // side walls: lit on the left, shaded on the right
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(-half, 0, 1.5, fw);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(half - 1.5, 0, 1.5, fw);
    // back wall light
    ctx.globalAlpha = 0.95 * pulse;
    ctx.fillStyle = col;
    ctx.fillRect(-half + 1, fw - bwall, gwPx - 2, bwall);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.7 * pulse;
    ctx.drawImage(glowSpr, -half * 1.08, fw - fw * 1.6, gwPx * 1.08, fw * 2.4);
    ctx.globalAlpha = 0.35 * pulse;
    ctx.fillStyle = col;
    ctx.fillRect(-half, 0, gwPx, 1.5);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // posts at the mouth
    const pr = Math.max(3.5, fw * 0.34);
    for (let s = -1; s <= 1; s += 2) {
      const px = s * half;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath();
      ctx.arc(px + 1, 2, pr + 1, 0, TAU);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(px, 0, pr, 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(px - pr * 0.25, -pr * 0.25, pr * 0.42, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // Inside the rink: colour spill from the mouth, flash and light rays after a goal.
  function drawGoalInside(g, now) {
    const gwPx = g.w * scale;
    const half = gwPx / 2;
    const cx = rx + rw / 2;
    const edgeY = g.top ? ry : ry + rh;
    const grads = goalGrad[g.side];
    const pulse = 0.85 + 0.15 * Math.sin(now / 420 + g.idx * 2);

    ctx.save();
    ctx.translate(cx, edgeY);
    ctx.scale(1, g.top ? 1 : -1); // local +y points into the rink

    ctx.globalAlpha = pulse;
    ctx.fillStyle = grads.glow;
    ctx.fillRect(-half, 0, gwPx, glowH);
    ctx.globalAlpha = 1;

    const ft = now - fx.state.goalFlash[g.side];
    if (ft >= 0 && ft < 1200) {
      const t = ft / 1200;
      const a = 1 - t;
      ctx.globalCompositeOperation = 'lighter';
      // radial flash
      ctx.globalAlpha = a * a * (ft < 800 ? 1 : 0);
      ctx.fillStyle = grads.flash;
      ctx.save();
      ctx.scale(half * 1.5, glowH * 3.4);
      ctx.fillRect(-1, 0, 2, 1);
      ctx.restore();
      // light rays
      const rr = Math.min(rh * 0.8, rw * 0.95);
      ctx.globalAlpha = Math.min(1, ft / 90) * Math.pow(a, 1.4) * 0.6;
      ctx.save();
      ctx.rotate(Math.sin(now / 500) * 0.05);
      ctx.drawImage(rays[g.side], -rr, 0, rr * 2, rr);
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawObstacles(ob, now) {
    for (let i = 0; i < ob.length; i++) {
      const o = ob[i];
      const sx = sxw(o.x);
      const sy = syw(o.y);
      const r = o.r * scale;
      if (o.k === 'bumper') {
        const ft = (now - (bumperFlashT[i] || -1e9)) / 380;
        const flashing = ft >= 0 && ft < 1;
        // idle warm halo
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(glowGold, sx, sy, r * 2.1, 0.2 + (flashing ? 0.7 * (1 - ft) : 0));
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        drawSprite(getBumperSprite(r), sx, sy, flashing ? 1 + 0.12 * (1 - ft) * (1 - ft) : 1);
        if (flashing) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = (1 - ft) * 0.5;
          ctx.fillStyle = '#fff6d0';
          ctx.beginPath();
          ctx.arc(sx, sy, r * 0.92, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = (1 - ft) * 0.9;
          ctx.strokeStyle = '#ffe28a';
          ctx.lineWidth = Math.max(2, r * 0.14 * (1 - ft * 0.5));
          ctx.beginPath();
          ctx.arc(sx, sy, r * (1.05 + 1.1 * easeOutCubic(ft)), 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = (1 - ft) * 0.5;
          ctx.lineWidth = Math.max(1.5, r * 0.07);
          ctx.beginPath();
          ctx.arc(sx, sy, r * (0.95 + 0.6 * easeOutCubic(ft)), 0, TAU);
          ctx.stroke();
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
        }
      } else {
        // mine
        const armed = o.a === 1;
        const bt = (now - (mineFlashT[i] || -1e9)) / 1000;
        // scorch mark left by the last blast
        if (bt >= 0 && bt < 4) {
          drawGlow(glowBlack, sx, sy, r * 2.4, 0.6 * (1 - bt / 4));
          ctx.globalAlpha = 1;
        }
        if (armed) {
          const pulse = 0.5 + 0.5 * Math.sin(now / 260 + o.x * 0.013);
          ctx.globalCompositeOperation = 'lighter';
          drawGlow(glowRed, sx, sy, r * (1.9 + 0.3 * pulse), 0.18 + 0.2 * pulse);
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
          drawSprite(getMineSprite(r), sx, sy);
          // danger ring
          ctx.globalAlpha = 0.35 + 0.3 * pulse;
          ctx.strokeStyle = '#ff3b3b';
          ctx.lineWidth = Math.max(1.5, r * 0.07);
          ctx.setLineDash(DASH);
          ctx.lineDashOffset = -now / 70;
          ctx.beginPath();
          ctx.arc(sx, sy, r * 1.12, 0, TAU);
          ctx.stroke();
          ctx.setLineDash(NO_DASH);
          // blinking LED
          const on = ((now + o.x * 3) % 700) < 320;
          const lr = Math.max(2.5, r * 0.15);
          if (on) {
            ctx.globalCompositeOperation = 'lighter';
            drawGlow(glowRed, sx, sy, lr * 5, 1);
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#ff4638';
            ctx.beginPath();
            ctx.arc(sx, sy, lr, 0, TAU);
            ctx.fill();
            ctx.fillStyle = '#ffd6cf';
            ctx.beginPath();
            ctx.arc(sx - lr * 0.25, sy - lr * 0.3, lr * 0.4, 0, TAU);
            ctx.fill();
          } else {
            ctx.fillStyle = '#4d0e0b';
            ctx.beginPath();
            ctx.arc(sx, sy, lr, 0, TAU);
            ctx.fill();
          }
        } else {
          ctx.globalAlpha = 0.62;
          drawSprite(getMineSprite(r), sx, sy);
          ctx.globalAlpha = 1;
          const lr = Math.max(2.5, r * 0.15);
          ctx.fillStyle = '#6d7488';
          ctx.beginPath();
          ctx.arc(sx, sy, lr, 0, TAU);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.beginPath();
          ctx.arc(sx - lr * 0.25, sy - lr * 0.3, lr * 0.4, 0, TAU);
          ctx.fill();
        }
        // explosion burst
        if (bt >= 0 && bt < 0.55) {
          const t = bt / 0.55;
          const rr = r * (1.2 + 4.2 * easeOutCubic(t));
          ctx.globalCompositeOperation = 'lighter';
          drawGlow(glowGold, sx, sy, rr, (1 - t) * (1 - t));
          drawGlow(glowRed, sx, sy, rr * 1.35, (1 - t) * 0.8);
          if (t < 0.25) {
            ctx.globalAlpha = (1 - t / 0.25) * 0.95;
            ctx.fillStyle = '#fff3d6';
            ctx.beginPath();
            ctx.arc(sx, sy, r * (0.8 + 1.8 * t * 4), 0, TAU);
            ctx.fill();
          }
          ctx.globalAlpha = (1 - t) * 0.8;
          ctx.strokeStyle = '#ffb35a';
          ctx.lineWidth = Math.max(2, r * 0.18 * (1 - t));
          ctx.beginPath();
          ctx.arc(sx, sy, r * (1 + 3.4 * easeOutCubic(t)), 0, TAU);
          ctx.stroke();
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  // Tapered ribbon: wide at the puck, thinning to nothing. Length and brightness
  // follow speed. Three nested fills approximate a fade towards the tail.
  function ribbon(cnt, wMax, wScale) {
    ctx.beginPath();
    for (let j = 0; j < cnt; j++) {
      const w = wMax * wScale * Math.pow(1 - rbF[j] / (rbF[cnt - 1] + 0.0001) * 0.999, 1.5);
      const x = rbX[j] + rbNX[j] * w;
      const y = rbY[j] + rbNY[j] * w;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    for (let j = cnt - 1; j >= 0; j--) {
      const w = wMax * wScale * Math.pow(1 - rbF[j] / (rbF[cnt - 1] + 0.0001) * 0.999, 1.5);
      ctx.lineTo(rbX[j] - rbNX[j] * w, rbY[j] - rbNY[j] * w);
    }
    ctx.closePath();
    ctx.fill();
  }

  function drawTrail(px, py, speed, now) {
    if (speed < 160) return;
    const k = clamp((speed - 160) / 2000, 0, 1);
    const life = 0.07 + 0.27 * k;
    // Length is capped at about 9 puck radii so a fast puck never leaves a long streak.
    const maxLen = 9 * puckR * scale;
    let m = 1;
    let dist = 0;
    rbX[0] = sxw(px);
    rbY[0] = syw(py);
    rbF[0] = 0;
    for (let n = 0; n < trCount && m < RB; n++) {
      const i = (trHead - 1 - n + TRAIL_N * 2) % TRAIL_N;
      const age = (now - trT[i]) / 1000;
      if (age > life) break;
      const sx = sxw(trX[i]);
      const sy = syw(trY[i]);
      const seg = Math.abs(sx - rbX[m - 1]) + Math.abs(sy - rbY[m - 1]);
      if (seg < 1.2) continue;
      dist += Math.hypot(sx - rbX[m - 1], sy - rbY[m - 1]);
      if (dist > maxLen) break;
      rbX[m] = sx;
      rbY[m] = sy;
      rbF[m] = Math.max(age / life, dist / maxLen);
      m++;
    }
    if (m < 3) return;
    for (let j = 0; j < m; j++) {
      const a = j > 0 ? j - 1 : j;
      const b = j < m - 1 ? j + 1 : j;
      const dx = rbX[a] - rbX[b];
      const dy = rbY[a] - rbY[b];
      const len = Math.hypot(dx, dy) || 1;
      rbNX[j] = -dy / len;
      rbNY[j] = dx / len;
    }
    const wMax = puckR * scale * (0.5 + 0.4 * k);
    const hot = speed > 1500;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = hot ? '#ffb27a' : '#8fc4ff';
    ctx.globalAlpha = 0.04 + 0.06 * k;
    ribbon(m, wMax * 1.2, 1);
    ctx.fillStyle = hot ? '#ffd9a8' : '#bfe3ff';
    ctx.globalAlpha = 0.05 + 0.08 * k;
    ribbon(Math.max(3, (m * 0.72) | 0), wMax, 0.7);
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.06 + 0.12 * k;
    ribbon(Math.max(3, (m * 0.42) | 0), wMax, 0.34);
    ctx.globalAlpha = 1;
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

  function isLocalSide(side) {
    if (!solo) return side === role;
    return players === 'pass' || side === 'host';
  }

  // local: optional {x, y} world position overriding the snapshot (guest prediction).
  function drawMallet(side, i, now, local) {
    const wx = local ? local.x : curSnap.m[i];
    const wy = local ? local.y : curSnap.m[i + 1];
    if (wy < visTop - malletR || wy > visBot + malletR) return;
    const sx = sxw(wx);
    const sy = syw(wy);
    const R = malletR * scale;
    const glowSpr = side === 'host' ? glowHost : glowGuest;
    const colr = side === 'host' ? HOST_COL : GUEST_COL;
    const rgb = side === 'host' ? HOST_RGB : GUEST_RGB;
    const idx = i >> 1;
    let sp;
    if (local) {
      sp = Math.hypot(lmVx, lmVy) * Math.exp(-(now - lmT) / 140);
    } else {
      sp = Math.hypot(mv[i], mv[i + 1]) * Math.exp(-(now - mvT) / 140);
    }
    const k = clamp((sp - 250) / 1500, 0, 1);
    if (k > 0.02) {
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(glowSpr, sx, sy, R * (2.2 + 0.8 * k), 0.75 * k);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    const readyPhase = curSnap.ph === 'ready';
    const isReady = !!(curSnap.rd && curSnap.rd[idx]);
    // "grab me" halo for a side that is not ready yet
    if (readyPhase && !isReady) {
      const ph = (now / 1250) % 1;
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(glowSpr, sx, sy, R * (2.5 + 0.3 * Math.sin(now / 260)), 0.55 + 0.25 * Math.sin(now / 260));
      ctx.strokeStyle = colr;
      for (let q = 0; q < 2; q++) {
        const t = (ph + q * 0.5) % 1;
        ctx.globalAlpha = 0.75 * Math.pow(1 - t, 1.6);
        ctx.lineWidth = Math.max(2, 3.5 * u * (1 - t * 0.5));
        ctx.beginPath();
        ctx.arc(sx, sy, R * (1.1 + 1.15 * easeOutCubic(t)), 0, TAU);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // soft contact ring under the local mallet while the finger is down
    if (heldK.v > 0.01 && isLocalSide(side)) {
      const hk = heldK.v;
      const rr = R * (1.3 + 0.03 * Math.sin(now / 150));
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(glowSpr, sx, sy, R * 2.1, 0.5 * hk);
      ctx.globalAlpha = 0.1 * hk;
      ctx.fillStyle = colr;
      ctx.beginPath();
      ctx.arc(sx, sy, rr, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 0.8 * hk;
      ctx.strokeStyle = colr;
      ctx.lineWidth = Math.max(2, 3 * u);
      ctx.beginPath();
      ctx.arc(sx, sy, rr, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.35 * hk;
      ctx.strokeStyle = `rgba(${rgb},1)`;
      ctx.lineWidth = Math.max(5, 9 * u);
      ctx.beginPath();
      ctx.arc(sx, sy, rr + 3 * u, 0, TAU);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    drawSprite(side === 'host' ? spr.host : spr.guest, sx, sy);

    // ready check badge
    if (readyPhase && isReady) {
      const pop = easeOutBack(clamp((now - readyT[idx]) / 340, 0, 1));
      const br = Math.max(8, R * 0.36) * pop;
      if (br > 0.5) {
        const bx = sx + R * 0.8;
        const by = sy - R * 0.8;
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.arc(bx + 1, by + 2, br + 1, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#2fd37a';
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1.5, br * 0.14);
        ctx.stroke();
        ctx.lineWidth = Math.max(2, br * 0.26);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(bx - br * 0.42, by + br * 0.02);
        ctx.lineTo(bx - br * 0.1, by + br * 0.36);
        ctx.lineTo(bx + br * 0.48, by - br * 0.34);
        ctx.stroke();
        ctx.lineCap = 'butt';
      }
    }
  }

  // Seam alignment helper: a big ring centred on the seam gap on both iPads, plus
  // a short tick at the seam centre. When the halves line up the arcs meet.
  function drawCalibration(now) {
    const cx = rx + rw / 2;
    const cy = syw(H + G / 2);
    const rad = 0.3 * W * scale;
    const pulse = 0.75 + 0.25 * Math.sin(now / 300);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#8fe0ff';
    ctx.globalAlpha = 0.18 * pulse;
    ctx.lineWidth = 16 * u;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, TAU);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = '#f2fbff';
    ctx.lineWidth = Math.max(2.5, 4 * u);
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, TAU);
    ctx.stroke();
    // graduation ticks every 15 degrees
    ctx.lineWidth = Math.max(1.5, 2 * u);
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (let a = 0; a < 24; a++) {
      const th = (a / 24) * TAU;
      const c0 = Math.cos(th);
      const s0 = Math.sin(th);
      ctx.moveTo(cx + c0 * (rad - 6 * u), cy + s0 * (rad - 6 * u));
      ctx.lineTo(cx + c0 * (rad - (a % 6 === 0 ? 24 : 14) * u), cy + s0 * (rad - (a % 6 === 0 ? 24 : 14) * u));
    }
    ctx.stroke();
    // seam centre tick
    ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(3, 4.5 * u);
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    if (solo) {
      ctx.moveTo(cx, cy - 16 * u);
      ctx.lineTo(cx, cy + 16 * u);
    } else {
      ctx.moveTo(cx, ry);
      ctx.lineTo(cx, ry + 30 * u);
    }
    ctx.stroke();
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  }

  // --- text ---------------------------------------------------------------------

  function glowText(str, x, y, size, fill, alpha, weight, glow) {
    ctx.font = font(size, weight);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = glow;
    ctx.lineWidth = size * 0.34;
    ctx.globalAlpha = alpha * 0.1 * gA;
    ctx.strokeText(str, x, y);
    ctx.lineWidth = size * 0.16;
    ctx.globalAlpha = alpha * 0.26 * gA;
    ctx.strokeText(str, x, y);
    ctx.fillStyle = fill;
    ctx.globalAlpha = alpha * gA;
    ctx.fillText(str, x, y);
    ctx.globalAlpha = 1;
  }

  function plainText(str, x, y, size, fill, alpha, weight) {
    ctx.font = font(size, weight);
    ctx.fillStyle = fill;
    ctx.globalAlpha = alpha * gA;
    ctx.fillText(str, x, y);
    ctx.globalAlpha = 1;
  }

  // A soft dark plate behind a line of text so it reads over the ice.
  function plate(w, h, y, alpha) {
    ctx.globalAlpha = alpha * gA;
    ctx.fillStyle = '#050a1a';
    ctx.beginPath();
    rrPath(ctx, -w / 2, y - h / 2, w, h, h / 2, h / 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawScore(x, y, rot, value, label, side, idx, popStart, now) {
    const col = side === 'host' ? HOST_COL : GUEST_COL;
    const rgb = side === 'host' ? HOST_RGB : GUEST_RGB;
    ctx.save();
    ctx.translate(x, y);
    if (rot) ctx.rotate(Math.PI);
    plainText(label, 0, -50 * u, Math.max(10, 13 * u), '#ffffff', 0.55, 800);
    const t = (now - popStart) / 1000;
    let sc = 1;
    let hot = 0;
    if (t >= 0 && t < 0.55) {
      sc = 1 + 0.75 * Math.exp(-t * 7) * Math.cos(t * 9);
      hot = Math.exp(-t * 5);
    }
    ctx.save();
    ctx.scale(sc, sc);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(side === 'host' ? glowHost : glowGuest, 0, -2 * u, 64 * u * (1 + hot * 0.6), 0.34 + hot * 0.5);
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = font(64 * u, 800);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(4,8,22,0.55)';
    ctx.lineWidth = 6 * u;
    ctx.strokeText(String(value), 0, 0);
    ctx.fillStyle = hot > 0.25 ? '#ffffff' : col;
    ctx.globalAlpha = 0.97;
    ctx.fillText(String(value), 0, 0);
    ctx.globalAlpha = 1;
    ctx.restore();

    // goals-to-target progress bar
    const bw = 96 * u;
    const bh = Math.max(3, 5 * u);
    const by = 46 * u;
    const bx = -bw / 2;
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#050a1a';
    ctx.beginPath();
    rrPath(ctx, bx - 1, by - bh / 2 - 1, bw + 2, bh + 2, bh, bh);
    ctx.fill();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    rrPath(ctx, bx, by - bh / 2, bw, bh, bh / 2, bh / 2);
    ctx.fill();
    const fillW = bw * clamp(progK[idx], 0, 1);
    if (fillW > 0.5) {
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = col;
      ctx.beginPath();
      rrPath(ctx, bx, by - bh / 2, Math.max(bh, fillW), bh, bh / 2, bh / 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.28;
      ctx.fillRect(bx + 2, by - bh / 2, Math.max(0, fillW - 4), bh * 0.4);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (target <= 11) {
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#050a1a';
      for (let i = 1; i < target; i++) ctx.fillRect(bx + (bw * i) / target - 0.5, by - bh / 2, 1, bh);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawHud(snap, now, dt) {
    const sc = snap.sc || [0, 0];
    const k = 1 - Math.exp(-dt * 7);
    progK[0] += (sc[0] / target - progK[0]) * k;
    progK[1] += (sc[1] / target - progK[1]) * k;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const padX = 66 * u;
    gA = 1;
    if (snap.ph === 'ready' && uiNow.calibrating) return; // host's calibration bar sits here
    if (solo) {
      drawScore(rx + padX, ry + rh - 104 * u, false, sc[0], labels[0], 'host', 0, popT[0], now);
      drawScore(rx + rw - padX, ry + 104 * u, true, sc[1], labels[1], 'guest', 1, popT[1], now);
    } else {
      const mine = role === 'host' ? 0 : 1;
      const other = 1 - mine;
      drawScore(rx + padX, ry + rh - 104 * u, false, sc[mine], labels[0], role, mine, popT[mine], now);
      drawScore(rx + rw - padX, ry + 86 * u, false, sc[other], labels[1], role === 'host' ? 'guest' : 'host', other, popT[other], now);
    }
  }

  function drawModeLabel(now) {
    const a = inLabel ? easeOutCubic(clamp((now - labelT) / 250, 0, 1)) : 1 - clamp((now - labelT) / 220, 0, 1);
    if (a < 0.02) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    gA = a;
    const cx = rx + rw / 2;
    const draw = (rot, y) => {
      ctx.save();
      ctx.translate(cx, y);
      if (rot) ctx.rotate(Math.PI);
      const fs = Math.max(12, 15 * u);
      ctx.font = font(fs, 800);
      const w = ctx.measureText(modeLabel).width + fs * 2.2;
      plate(w, fs * 1.9, 0, 0.5);
      plainText(modeLabel, 0, 0.5, fs, '#ffffff', 0.85, 800);
      ctx.restore();
    };
    if (!solo) draw(false, ry + 34 * u);
    else if (players === 'pass') {
      draw(false, ry + rh / 2 + 28 * u);
      draw(true, ry + rh / 2 - 28 * u);
    } else draw(false, ry + rh / 2 + 28 * u);
    gA = 1;
  }

  // Serve hint: chevrons sliding toward whoever receives the serve. On a host/guest
  // screen they run from the seam edge into the rink when we receive, and towards
  // the seam when we serve; solo shows them crossing the centre.
  function drawServeHint(snap, now) {
    // snap.sv is the side receiving the serve; older snapshots: infer from the puck.
    const recvHost = snap.sv === 'host' || snap.sv === 'guest' ? snap.sv === 'host' : snap.p[1] > H + G / 2;
    const col = recvHost ? HOST_COL : GUEST_COL;
    const cycle = 1.3;
    const ph = ((now / 1000) % cycle) / cycle;
    const cx = rx + rw / 2;
    const s = 30 * u;
    ctx.strokeStyle = col;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, 6 * u);
    const span = rh * (solo ? 0.18 : 0.3);
    let y0;
    let dirS; // +1: chevrons point down the screen
    if (solo) {
      y0 = syw(H + G / 2);
      dirS = (ky > 0 ? 1 : -1) * (recvHost ? 1 : -1);
    } else {
      const receiving = recvHost === (role === 'host');
      dirS = receiving ? 1 : -1;
      y0 = ry + 56 * u + (receiving ? 0 : span);
    }
    for (let k = 0; k < 3; k++) {
      const t = (ph + k) / 3;
      const sy = solo ? y0 + dirS * (-span + 2 * span * t) : y0 + dirS * t * span;
      ctx.globalAlpha = Math.sin(Math.PI * t) * 0.95;
      ctx.beginPath();
      ctx.moveTo(cx - s, sy - dirS * s * 0.55);
      ctx.lineTo(cx, sy);
      ctx.lineTo(cx + s, sy - dirS * s * 0.55);
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
    ctx.globalAlpha = (1 - frac) * 0.45 * gA;
    ctx.beginPath();
    ctx.arc(0, 0, (70 + 170 * frac) * u, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.scale(sc, sc);
    glowText(String(n), 0, 0, 150 * u, n === 1 ? '#ffd36b' : '#ffffff', a, 800, n === 1 ? '#ffb020' : '#8fb4ff');
    ctx.restore();
  }

  // m: snapshot-like { tm, sd, lg, wn, sc, rd }; el: seconds since the phase began.
  function messageFor(side, m, ph, el, now, cx, cy, rot, sMul) {
    ctx.save();
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(Math.PI);
    ctx.scale(sMul, sMul);
    const idx = side === 'host' ? 0 : 1;
    const sc = m.sc || NO_RD;
    const scol = side === 'host' ? HOST_COL : GUEST_COL;
    const srgb = side === 'host' ? HOST_RGB : GUEST_RGB;
    if (ph === 'ready') {
      const rd = m.rd || NO_RD;
      const own = !!rd[idx];
      const pulse = 0.5 + 0.5 * Math.sin(now / 420);
      let sub = '';
      if (own && !rd[1 - idx]) sub = solo ? (players === 'pass' ? 'Waiting for the other player' : '') : 'Waiting for the other iPad';
      const title = uiNow.calibrating ? 'Line up the ring, then hold your mallet' : 'Hold your mallet to get ready';
      ctx.font = font(30 * u, 800);
      const tw = ctx.measureText(title).width + 56 * u;
      plate(tw, sub ? 100 * u : 62 * u, sub ? 14 * u : 0, 0.42);
      // a small accent bar in the side colour
      ctx.globalAlpha = (own ? 0.35 : 0.5 + 0.4 * pulse) * gA;
      ctx.fillStyle = scol;
      ctx.beginPath();
      rrPath(ctx, -tw * 0.18, (sub ? -30 : -22) * u, tw * 0.36, 3 * u, 1.5 * u, 1.5 * u);
      ctx.fill();
      ctx.globalAlpha = 1;
      glowText(title, 0, -4 * u, 30 * u, '#ffffff', own ? 0.6 : 0.85 + 0.15 * pulse, 800, `rgb(${srgb})`);
      if (sub) plainText(sub, 0, 36 * u, 21 * u, '#ffffff', 0.78, 700);
    } else if (ph === 'countdown') {
      drawCountdownDigit(m.tm);
      plainText(solo ? 'Get ready' : 'Grab your mallet', 0, 105 * u, 24 * u, '#ffffff', 0.6, 600);
    } else if (ph === 'goal' && m.sd === 1) {
      // Post-goal serve countdown: same digit as the pre-match countdown, so the
      // visual cue lines up with the beep the sim emits.
      drawCountdownDigit(m.tm);
    } else if (ph === 'goal') {
      const p = clamp(el / 0.42, 0, 1);
      const gs = 0.3 + 0.7 * easeOutBack(p);
      const a = Math.min(1, el / 0.12) * (m.sd === 0 && m.tm < 0.3 ? clamp(m.tm / 0.3, 0, 1) : 1);
      const mine = m.lg === side;
      const lgCol = m.lg === 'host' ? HOST_COL : GUEST_COL;
      const lgRgb = m.lg === 'host' ? HOST_RGB : GUEST_RGB;
      ctx.save();
      ctx.scale(gs, gs);
      // White text with a dark outline/shadow so it reads on both screens (the wash
      // behind is the scorer's colour, so a coloured fill would wash out).
      ctx.save();
      ctx.shadowColor = 'rgba(4,8,22,0.7)';
      ctx.shadowBlur = 14 * u * dpr;
      ctx.shadowOffsetY = 4 * u * dpr;
      ctx.font = font(98 * u, 900);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(4,8,22,0.8)';
      ctx.lineWidth = 98 * u * 0.12;
      ctx.globalAlpha = a * gA;
      ctx.strokeText('GOAL!', 0, -18 * u);
      ctx.restore();
      glowText('GOAL!', 0, -18 * u, 98 * u, '#ffffff', a, 900, `rgb(${lgRgb})`);
      ctx.restore();
      let sub;
      if (solo && players === 'bot') sub = mine ? 'You scored' : 'Bot scored';
      else sub = mine ? 'You scored' : 'They scored';
      ctx.save();
      ctx.shadowColor = 'rgba(4,8,22,0.85)';
      ctx.shadowBlur = 8 * u * dpr;
      ctx.shadowOffsetY = 2 * u * dpr;
      ctx.font = font(28 * u, 800);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(4,8,22,0.7)';
      ctx.lineWidth = 5 * u;
      ctx.globalAlpha = 0.95 * a * gA;
      ctx.strokeText(sub, 0, 58 * u);
      ctx.restore();
      plainText(sub, 0, 58 * u, 28 * u, lgCol, 0.95 * a, 800);
    } else if (ph === 'over') {
      const p = clamp(el / 0.5, 0, 1);
      const os = 0.3 + 0.7 * easeOutBack(p);
      const a = Math.min(1, el / 0.15);
      const won = m.wn === side;
      const colr = won ? WIN_COL : LOSE_COL;
      ctx.save();
      ctx.scale(os, os);
      glowText(won ? 'YOU WIN' : 'YOU LOSE', 0, -34 * u, 88 * u, colr, a, 900, won ? '#ffb020' : '#ff3b3b');
      ctx.restore();
      // final score, your colour first
      const a0 = sc[idx];
      const a1 = sc[1 - idx];
      const c0 = side === 'host' ? HOST_COL : GUEST_COL;
      const c1 = side === 'host' ? GUEST_COL : HOST_COL;
      const r0 = side === 'host' ? HOST_RGB : GUEST_RGB;
      const r1 = side === 'host' ? GUEST_RGB : HOST_RGB;
      const sa = clamp((el - 0.15) / 0.3, 0, 1);
      ctx.save();
      ctx.scale(0.8 + 0.2 * easeOutCubic(sa), 0.8 + 0.2 * easeOutCubic(sa));
      ctx.textAlign = 'right';
      glowText(String(a0), -34 * u, 62 * u, 76 * u, c0, a * sa, 800, `rgb(${r0})`);
      ctx.textAlign = 'center';
      plainText('–', 0, 60 * u, 52 * u, '#ffffff', 0.55 * a * sa, 700);
      ctx.textAlign = 'left';
      glowText(String(a1), 34 * u, 62 * u, 76 * u, c1, a * sa, 800, `rgb(${r1})`);
      ctx.textAlign = 'center';
      ctx.restore();
      const pulse = 0.5 + 0.5 * Math.sin(now / 280);
      plainText('Tap to play again', 0, 140 * u, 28 * u, '#ffffff', a * (0.4 + 0.5 * pulse), 700);
    }
    ctx.restore();
  }

  // Screen-wide tint behind a message (colour wash after a goal, dim on game over).
  function overlayFor(m, ph, el, k) {
    if (k <= 0.001) return;
    if (ph === 'over') {
      ctx.globalAlpha = Math.min(1, el / 0.3) * 0.52 * k;
      ctx.fillStyle = '#05080f';
      ctx.fillRect(rx, ry, rw, rh);
    } else if (ph === 'goal') {
      ctx.globalAlpha = Math.min(1, el / 0.3) * 0.2 * k;
      ctx.fillStyle = '#05080f';
      ctx.fillRect(rx, ry, rw, rh);
      const env = el < 0.06 ? el / 0.06 : Math.exp(-(el - 0.06) * 2.8);
      if (env > 0.01) {
        // a pool of the scorer's colour behind the text, plus a faint flat tint
        const sp = m.lg === 'host' ? glowHost : glowGuest;
        const cy = solo ? ry + rh / 2 : ry + rh * 0.42;
        drawGlow(sp, rx + rw / 2, cy, Math.max(rw, rh * 0.55) * 0.95, Math.min(1, 0.63 * env) * k);
        ctx.globalAlpha = 0.067 * env * k;
        ctx.fillStyle = m.lg === 'host' ? HOST_COL : GUEST_COL;
        ctx.fillRect(rx, ry, rw, rh);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawMsgSet(m, ph, el, now, aMul, sMul, textPass) {
    if (!textPass) {
      overlayFor(m, ph, el, aMul);
      return;
    }
    gA = aMul;
    const cx = rx + rw / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (!solo) {
      messageFor(role, m, ph, el, now, cx, ry + rh * 0.42, false, sMul);
    } else if (players === 'pass') {
      messageFor('host', m, ph, el, now, cx, ry + rh * 0.62, false, sMul);
      messageFor('guest', m, ph, el, now, cx, ry + rh * 0.38, true, sMul);
    } else {
      messageFor('host', m, ph, el, now, cx, ry + rh * 0.62, false, sMul);
    }
    gA = 1;
  }

  // textPass false: tints/dims behind the particles; true: the message text on top.
  function drawMessages(snap, now, textPass) {
    const ph = snap.ph;
    if (MSG_PHASES[ph]) {
      const el = (now - phaseStart) / 1000;
      const k = easeOutCubic(clamp(el / 0.25, 0, 1));
      drawMsgSet(snap, ph, el, now, k, 0.9 + 0.1 * k, textPass);
    }
    if (outSnap) {
      const ok = (now - outT) / 220;
      if (ok < 1) drawMsgSet(outSnap, outSnap.ph, outEl, now, 1 - ok, 1 + 0.08 * ok, textPass);
      else if (textPass) outSnap = null;
    }
    if (!textPass) return;
    // "GO!" flash as play starts
    const gt = (now - goT) / 650;
    if (ph === 'play' && gt >= 0 && gt < 1) {
      const cx = rx + rw / 2;
      const draw = (rot, cy) => {
        ctx.save();
        ctx.translate(cx, cy);
        if (rot) ctx.rotate(Math.PI);
        const s = 1 + 0.5 * easeOutCubic(gt);
        ctx.scale(s, s);
        gA = 1 - gt * gt;
        glowText('GO!', 0, 0, 120 * u, '#7CFF9A', 1, 900, 'rgb(80,255,150)');
        gA = 1;
        ctx.restore();
      };
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (!solo) draw(false, ry + rh * 0.42);
      else if (players === 'pass') {
        draw(false, ry + rh * 0.62);
        draw(true, ry + rh * 0.38);
      } else draw(false, ry + rh * 0.62);
    }
  }

  function drawLatency() {
    if (latency == null) return;
    const ms = Math.round(latency);
    const col = ms < 40 ? '#7CFF9A' : ms < 90 ? '#ffd36b' : '#ff6b6b';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = font(10, 700);
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.45;
    const lx = rx + rw;
    // sits on the bottom frame rail, out of the way of play
    const ly = ry + rh + Math.min(fw * 0.5, 11);
    ctx.fillText(ms + ' ms', lx - 12, ly);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(lx - 5, ly, 2.2, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
  }

  // --- replay / diagnostics / predicted ----------------------------------------

  let diagFont = '';
  let diagSz = 11;
  let predDash = NO_DASH;

  function buildReplayLayers() {
    // Vignette at half resolution (it is smooth), stretched when drawn.
    const vw = Math.max(2, Math.round(screenW / 2));
    const vh = Math.max(2, Math.round(screenH / 2));
    if (!vignette) vignette = document.createElement('canvas');
    vignette.width = vw;
    vignette.height = vh;
    const c = vignette.getContext('2d');
    const g = c.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.25, vw / 2, vh / 2, Math.hypot(vw, vh) * 0.55);
    g.addColorStop(0, 'rgba(0,0,10,0)');
    g.addColorStop(0.65, 'rgba(0,0,10,0.28)');
    g.addColorStop(1, 'rgba(0,0,10,0.72)');
    c.fillStyle = g;
    c.fillRect(0, 0, vw, vh);
    if (!grain) {
      grain = document.createElement('canvas');
      grain.width = 128;
      grain.height = 128;
      const gc = grain.getContext('2d');
      const id = gc.createImageData(128, 128);
      const r = rng(777);
      for (let i = 0; i < 128 * 128; i++) {
        const v = r() < 0.5 ? 255 : 0;
        id.data[i * 4] = v;
        id.data[i * 4 + 1] = v;
        id.data[i * 4 + 2] = v;
        id.data[i * 4 + 3] = r() * 46;
      }
      gc.putImageData(id, 0, 0);
      grainPat = ctx.createPattern(grain, 'repeat');
    }
    diagSz = clamp(11 * u, 10, 13);
    diagFont = `600 ${Math.round(diagSz * 10) / 10}px ${MONO}`;
    const pr = puckR * scale * 1.6;
    predDash = [pr * 0.42, pr * 0.3];
  }

  // Letterbox bars, vignette, grain, REPLAY badge and a progress line. Drawn in plain
  // screen space (transform dpr) after the (zoomed) world.
  function drawBadge(bh, e) {
    const cy = bh / 2;
    const fs = clamp(rpBar * 0.34, 11, 17);
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);
    const a = clamp((e - 0.55) / 0.45, 0, 1);
    if (a <= 0) return;
    ctx.globalAlpha = a;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const x0 = 16 + fs * 0.7;
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(glowRed, x0, cy, fs * (1.5 + pulse * 0.7), a * (0.35 + 0.45 * pulse));
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = a * (0.65 + 0.35 * pulse);
    ctx.fillStyle = REPLAY_RED;
    ctx.beginPath();
    ctx.arc(x0, cy, fs * (0.3 + 0.05 * pulse), 0, TAU);
    ctx.fill();
    ctx.globalAlpha = a;
    ctx.font = font(fs, 800);
    ctx.fillStyle = '#ffffff';
    if ('letterSpacing' in ctx) ctx.letterSpacing = Math.round(fs * 0.16) + 'px';
    ctx.fillText('REPLAY', x0 + fs * 0.75, cy + 0.5);
    const tw = ctx.measureText('REPLAY').width;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.globalAlpha = a * 0.55;
    ctx.font = font(fs * 0.85, 700);
    ctx.fillText(rpSpeed.toFixed(rpSpeed < 1 ? 1 : 0).replace(/\.0$/, '') + '×', x0 + fs * 0.75 + tw + fs * 0.8, cy + 0.5);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
  }

  function drawReplay(now, e) {
    const bh = rpBar * e;
    ctx.globalAlpha = e;
    ctx.drawImage(vignette, 0, 0, screenW, screenH);
    // film grain: a tiny noise tile, re-seated at a random offset ~24 times a second
    if (grainPat) {
      if (now - grainT > 42) {
        grainT = now;
        grainSeed = (grainSeed * 1103515245 + 12345) >>> 0;
      }
      const gx = grainSeed % 128;
      const gy = (grainSeed >>> 8) % 128;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, gx, gy);
      ctx.globalAlpha = e * 0.5;
      ctx.fillStyle = grainPat;
      ctx.fillRect(-gx, -gy, canvas.width, canvas.height);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    // bars
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, screenW, bh + 0.5);
    ctx.fillRect(0, screenH - bh - 0.5, screenW, bh + 0.5);
    // progress line along the bottom bar
    const ly = screenH - bh;
    const lh = 3;
    const px0 = 0;
    ctx.globalAlpha = 0.9 * e;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(px0, ly, screenW, lh);
    ctx.fillStyle = REPLAY_RED;
    ctx.fillRect(px0, ly, screenW * rpT, lh);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(glowRed, screenW * rpT, ly + lh / 2, 14, e * 0.9);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // badge (and a mirrored one for the player across the table in pass & play)
    drawBadge(bh, e);
    if (solo && players === 'pass') {
      ctx.save();
      ctx.translate(screenW, screenH);
      ctx.rotate(Math.PI);
      drawBadge(bh, e);
      ctx.restore();
    }
  }

  function fmtDiag(i, v, digits, suffix, col) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      if (diagNum[i] !== -1) {
        diagNum[i] = -1;
        diagStr[i] = '–';
        diagCol[i] = '#ffffff';
      }
      return;
    }
    const q = Math.round(v * digits);
    if (q === diagNum[i]) return;
    diagNum[i] = q;
    diagStr[i] = (digits > 1 ? (q / digits).toFixed(digits === 10 ? 1 : 2) : String(q)) + suffix;
    diagCol[i] = col;
  }

  function drawDiag(d) {
    const fps = d.fps;
    const rtt = d.rtt;
    fmtDiag(0, fps, 1, '', fps >= 50 ? GOOD : fps >= 30 ? '#ffd36b' : '#ff6b6b');
    fmtDiag(1, d.frameMs, 10, ' ms', d.frameMs <= 20 ? '#ffffff' : d.frameMs <= 34 ? '#ffd36b' : '#ff6b6b');
    fmtDiag(2, rtt, 1, ' ms', rtt < 40 ? GOOD : rtt < 90 ? '#ffd36b' : '#ff6b6b');
    fmtDiag(3, d.jitter, 10, ' ms', d.jitter < 6 ? '#ffffff' : d.jitter < 15 ? '#ffd36b' : '#ff6b6b');
    const kind = typeof d.kind === 'string' ? d.kind : '';
    if (kind !== diagKind) {
      diagKind = kind;
      diagStr[4] = kind || '–';
      diagNum[4] = 0;
    }
    diagCol[4] = kind === 'p2p' ? GOOD : kind === 'ws' ? '#ffd36b' : '#9fb8e8';
    fmtDiag(5, d.seq, 1, '', '#ffffff');
    fmtDiag(6, d.drops, 1, '', d.drops > 0 ? '#ff6b6b' : '#ffffff');

    const sz = diagSz;
    const lh = sz * 1.5;
    const pad = sz * 0.7;
    const pw = sz * 0.62 * 17 + pad * 2;
    const ph = lh * DIAG_ROWS + pad * 2 - (lh - sz) * 0.5;
    const x1 = rx + rw - 10;
    const y0 = solo ? ry + rh - 10 - ph : ry + 144 * u;
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = '#04081a';
    ctx.beginPath();
    rrPath(ctx, x1 - pw, y0, pw, ph, sz * 0.6, sz * 0.6);
    ctx.fill();
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = diagFont;
    ctx.textBaseline = 'middle';
    for (let i = 0; i < DIAG_ROWS; i++) {
      const yy = y0 + pad + lh * (i + 0.5) - (lh - sz) * 0.25;
      ctx.textAlign = 'left';
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(DIAG_LABELS[i], x1 - pw + pad, yy);
      ctx.textAlign = 'right';
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = diagCol[i];
      ctx.fillText(diagStr[i], x1 - pad, yy);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
  }

  function drawPredRing(sx, sy, pr, now) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 300);
    ctx.save();
    ctx.setLineDash(predDash);
    ctx.lineDashOffset = -now / 70;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#bfe9ff';
    ctx.lineWidth = Math.max(1.4, pr * 0.07);
    ctx.globalAlpha = predK * (0.22 + 0.12 * pulse);
    ctx.beginPath();
    ctx.arc(sx, sy, pr * (1.55 + 0.05 * pulse), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  // --- frame --------------------------------------------------------------------

  /**
   * snap: the sim snapshot. puckExtrapolate: seconds to advance the puck along its
   * velocity. now: performance.now() in ms. Safe to call repeatedly with the same
   * snapshot object (events are consumed once per distinct object).
   * localMallet: {x, y} in WORLD coordinates or null. For the guest role only, the
   * guest's own mallet is drawn there instead of at the (lagging) snapshot position;
   * host and solo ignore it.
   * ui: optional {
   *   held:        the local finger is on the canvas,
   *   calibrating: the host is adjusting the seam gap,
   *   replay:      { t: 0..1, speed } | null. Instant replay of old snapshots: letterbox
   *                bars, REPLAY badge, progress line, vignette + grain, no HUD messages.
   *                Events in replayed snapshots spark but never re-fire once the live
   *                snapshot returns. Bars slide out when it goes back to null.
   *   diag:        { fps, frameMs, rtt, jitter, kind: 'p2p'|'ws'|'local', seq, drops } | null.
   *                Small monospace panel under the opponent score (bottom-right in solo).
   *   predicted:   true while the guest shows a locally predicted hit the host has not
   *                confirmed: a faint dashed ring around the puck.
   * }
   * snapshot.sv ('host'|'guest') is the side receiving the serve (serve arrow).
   */
  function render(snap, puckExtrapolate = 0, now = performance.now(), localMallet = null, ui = null) {
    if (destroyed || !snap || !snap.p || !snap.m || !bg || !spr) return; // also a no-op after destroy()
    const dt = lastNow < 0 ? 0.016 : clamp((now - lastNow) / 1000, 0, 0.1);
    lastNow = now;
    uiNow = ui || NO_UI;
    const rp = uiNow.replay || null;
    if (!!rp !== replayOn) {
      replayOn = !!rp;
      // Entering or leaving a replay: drop stale message fades, trail and particles.
      outSnap = null;
      trCount = 0;
      fx.reset();
    }
    if (rp) {
      rpT = clamp(Number(rp.t) || 0, 0, 1);
      rpSpeed = rp.speed > 0 ? rp.speed : 1;
    }
    rpK = clamp(rpK + ((replayOn ? 1 : -1) * dt) / (BAR_MS / 1000), 0, 1);
    const rpE = rpK * rpK * (3 - 2 * rpK);
    const z = rpE > 0 ? 1 - (1 - rpZoom) * rpE : 1;
    const zx = rpE > 0 ? (screenW * (1 - z)) / 2 : 0;
    const zy = rpE > 0 ? (screenH * (1 - z)) / 2 : 0;
    // A shallow copy of the snapshot we already processed (same p/m arrays) is not new.
    if (snap !== curSnap && !(curSnap && snap.p === curP && snap.m === curM)) newSnap(snap, now);
    fx.setRain(!replayOn && snap.ph === 'over' && (solo || snap.wn === role));
    fx.update(now);
    heldK.v += ((uiNow.held ? 1 : 0) - heldK.v) * (1 - Math.exp(-dt * 14));

    const shaking = fx.getShake(now, shk);
    const shx = Math.round(shk[0] * 2) / 2;
    const shy = Math.round(shk[1] * 2) / 2;

    // Background (cached) at pixel-exact scale.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (rpE > 0) {
      // Replay: the whole world is scaled down a little so the goals sit between the bars.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(z, 0, 0, z, (zx + shx * z) * dpr, (zy + shy * z) * dpr);
      ctx.drawImage(bg, 0, 0);
    } else if (shaking) {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bg, Math.round(shx * dpr), Math.round(shy * dpr));
    } else {
      ctx.drawImage(bg, 0, 0);
    }
    ctx.setTransform(dpr * z, 0, 0, dpr * z, (zx + shx * z) * dpr, (zy + shy * z) * dpr);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (hasLetterbox) drawBokeh(now);
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i];
      const tw = (snap.gw && snap.gw[g.idx]) || goalW0;
      g.w += (tw - g.w) * (1 - Math.exp(-dt * 9));
      drawGoalSlot(g, now);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();

    const s = snap;
    for (let i = 0; i < goals.length; i++) drawGoalInside(goals[i], now);

    // Puck position (extrapolated along its velocity).
    const px = s.p[0] + s.p[2] * puckExtrapolate;
    const py = s.p[1] + s.p[3] * puckExtrapolate;
    const pvx = s.p[2];
    const pvy = s.p[3];
    const speed = Math.hypot(pvx, pvy);
    const playing = s.ph === 'play';

    if (s.ph === 'ready' && uiNow.calibrating) drawCalibration(now);

    drawHud(s, now, dt);

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

    // Trail, shadow, glow and puck.
    if (playing) {
      pushTrail(px, py, now);
      drawTrail(px, py, speed, now);
    }
    {
      const sx = sxw(px);
      const sy = syw(py);
      const pr = puckR * scale;
      // The light is fixed at the top left, so the shadow falls down-right; it also
      // lags behind the puck in proportion to its velocity.
      const vsx = kx * pvx;
      const vsy = ky * pvy;
      let tox = pr * 0.18 - vsx * 0.0115;
      let toy = pr * 0.32 - vsy * 0.0115;
      const tl = Math.hypot(tox, toy);
      const lim = pr * 1.25;
      if (tl > lim) {
        tox *= lim / tl;
        toy *= lim / tl;
      }
      const sk = 1 - Math.exp(-dt * 12);
      shOx += (tox - shOx) * sk;
      shOy += (toy - shOy) * sk;
      const dim = playing ? 1 : 0.6 + 0.12 * Math.sin(now / 260);
      ctx.globalAlpha = dim;
      drawSprite(spr.puckShadow, sx + shOx, sy + shOy);
      const hitT = (now - fx.state.hitAt) / 1000;
      const gk = clamp((speed - 500) / 1800, 0, 1) * 0.35 + (hitT >= 0 && hitT < 0.22 ? 0.85 * Math.pow(1 - hitT / 0.22, 2) : 0);
      if (gk > 0.02 && playing) {
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(glowWhite, sx, sy, pr * 2.8, Math.min(1, gk));
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = dim;
      drawSprite(spr.puck, sx, sy);
      ctx.globalAlpha = 1;
      predK += ((uiNow.predicted ? 1 : 0) - predK) * (1 - Math.exp(-dt * 12));
      if (predK > 0.02) drawPredRing(sx, sy, pr, now);
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

    if (!replayOn) drawMessages(s, now, false);
    fx.draw(ctx, map, now);

    if (!replayOn) {
      drawModeLabel(now);
      drawMessages(s, now, true);
    }

    ctx.restore();

    ctx.setTransform(dpr * z, 0, 0, dpr * z, zx * dpr, zy * dpr);
    drawLatency();
    if (uiNow.diag) drawDiag(uiNow.diag);

    if (rpE > 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawReplay(now, rpE);
    }
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
    destroyed = true;
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
      free(spr.puckShadow);
      free(spr.host);
      free(spr.guest);
      spr = null;
    }
    if (rays) {
      free(rays.host);
      free(rays.guest);
      rays = null;
    }
    for (const cv of bumperSprites.values()) free(cv);
    bumperSprites.clear();
    for (const cv of mineSprites.values()) free(cv);
    mineSprites.clear();
    free(glowWhite);
    free(glowHost);
    free(glowGuest);
    free(glowGold);
    free(glowRed);
    free(glowGreen);
    free(glowBlack);
    free(vignette);
    free(grain);
    vignette = null;
    grain = null;
    grainPat = null;
    fx.reset();
  }

  return { render, screenToWorld, worldToScreen, resize, setLatency, destroy };
}
