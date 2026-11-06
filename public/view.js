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
import { createTwistLayer } from './twists-view.js';

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
const MODE_NAMES = { classic: 'Classic', bumpers: 'Bumpers', ice: 'Ice', bombs: 'Bombs', mines: 'Mines', glitch: 'Glitch', battle: 'Battle', random: 'Random' };
const MSG_PHASES = { ready: 1, countdown: 1, goal: 1, over: 1 };
const NO_UI = { held: false, calibrating: false };
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
// Bomb sprite: fuse tip offset from the bomb centre, in bomb radii (shared by sprite and flame).
const FUSE_X = 0.85;
const FUSE_Y = -1.02;
const BOMB_FLASH_S = 1.2; // how long a detonated bomb shows its scorch and blast
const BOMB_HIT_MS = 250; // squash and flash after the puck knocks a bomb
const GLITCH_WARN_MS = 380; // puck jitters this long before a jump
const GLITCH_GHOST_MS = 450; // fading ghost at the old spot
const GLITCH_TEAR_MS = 120; // horizontal tear bands
// Battle mode: items, corner buttons, boxes.
const ITEM_COL = {
  rocket: '#ff6a3d', shield: '#5aa6ff', ghost: '#c8a8ff', shrink: '#7cffd4', freeze: '#a8ecff',
  magnet: '#ff4fd8', widegoal: '#ffd166', goalie: '#7cc4ff', giant: '#ffb347', catch: '#5ee38a',
  mirror: '#d9f1ff', quake: '#ff7a45', decoys: '#b388ff', steal: '#f4f6ff', tinypuck: '#a8ecff',
};
const ITEM_RGB = {
  rocket: '255,106,61', shield: '90,166,255', ghost: '200,168,255', shrink: '124,255,212', freeze: '168,236,255',
  magnet: '255,79,216', widegoal: '255,209,102', goalie: '124,196,255', giant: '255,179,71', catch: '94,227,138',
  mirror: '217,241,255', quake: '255,122,69', decoys: '179,136,255', steal: '244,246,255', tinypuck: '168,236,255',
};
const ITEM_LABEL = {
  rocket: 'ROCKET', shield: 'SHIELD', ghost: 'GHOST', shrink: 'SHRINK', freeze: 'FREEZE',
  magnet: 'MAGNET', widegoal: 'WIDE', goalie: 'GOALIE', giant: 'GIANT', catch: 'CATCH',
  mirror: 'MIRROR', quake: 'QUAKE', decoys: 'DECOY', steal: 'STEAL', tinypuck: 'TINY',
};
const BTN_PRESS_MS = 120; // squash hold
const BTN_BACK_MS = 130; // spring back after the squash
const GOT_PULSE_MS = 1500; // pulsing ring after an item arrives
const USE_FLY_MS = 420; // icon flying out of the button after a use
const BOX_FLY_MS = 500; // icon flying from a collected box to the button
const BOX_FADE_MS = 400; // box fade in
const BOX_FRAMES = 6; // pre-rendered rainbow hue steps per box
const SHIELD_FADE_S = 0.2;
const SHIELD_HIT_MS = 260;
const ROCKET_TRAIL_MS = 1000;
const THAW_MS = 320;
const MINE_SCORCH_S = 4;
const FLY_N = 8;
const STEAL_FLY_MS = 650; // ghost hand carrying a stolen item to the thief's button
const GOALIE_HIT_MS = 260;
const GIANT_RING_MS = 600;
const MIRROR_SHIMMER_MS = 420;
const CATCH_HOLD_S = 1.5;
const QUAKE_DUST_MS = 90;
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
  const battle = mode === 'battle';
  const myIdx = role === 'guest' ? 1 : 0; // the side whose eyes this screen is (solo: the human host)
  const fT = W * 0.03; // frame thickness in world units
  const random = mode === 'random';
  let modeLabel = `${MODE_NAMES[mode] || mode} · first to ${target}`;
  let twName = null; // twist name the mode label was last built from (random mode)

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
  // x: smoothed world x of the mouth centre (W/2 + snap.gx[idx]).
  if (role !== 'guest') goals.push({ side: 'host', idx: 0, top: false, w: goalW0, x: W / 2 });
  if (role !== 'host') goals.push({ side: 'guest', idx: 1, top: solo, w: goalW0, x: W / 2 });

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

  // Battle corner buttons (CSS px, set in layout): radius, icon radius, the score lift that
  // keeps the own score clear of the button, and one entry per drawn button.
  let br = 30;
  let ir = 15;
  let btnShift = 0;
  let btnDash = DASH;
  let btnN = 0;
  const btns = [0, 1, 2, 3].map(() => ({ side: 'host', idx: 0, x: 0, y: 0, rot: false }));

  let bg = null;
  let spr = null; // sprites, rebuilt on resize
  const bumperSprites = new Map();
  const mineSprites = new Map();
  const bombSprites = new Map();
  const boxSprites = new Map(); // box half-size (px) -> array of BOX_FRAMES rainbow frames
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
  const glowOrange = battle || random ? makeGlow('255,140,40') : null;
  const glowViolet = battle || random ? makeGlow('190,150,255') : null;
  const glowIce = battle || random ? makeGlow('150,225,255') : null;
  const itemGlows = {}; // item id -> glow sprite (all built up front in Battle)
  if (battle) for (const k in ITEM_RGB) itemGlows[k] = makeGlow(ITEM_RGB[k]);
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

  // --- twist layer environment (random mode) -----------------------------------
  // One live object handed to twists-view.js. The layout fields are re-assigned in
  // layout(); everything else is fixed for the life of the view.
  let tw = null; // the twist layer, created at the end of createView in random mode
  let twErrLogged = false;
  let scratchCv = null;
  const envLocalM = { x: 0, y: 0 }; // reused; env.localM points here or is null
  const env = {
    role,
    solo,
    players,
    cfg,
    W,
    H,
    G,
    bottom: bottomY,
    puckR,
    malletR,
    myIdx,
    localM: null, // guest: live world position of the local mallet (render arg), else null
    HOST_COL,
    GUEST_COL,
    HOST_RGB,
    GUEST_RGB,
    ctx,
    fx,
    rx: 0,
    ry: 0,
    rw: 1,
    rh: 1,
    scale: 1,
    u: 1,
    kx: 1,
    ky: 1,
    X0: 0,
    Y0: 0,
    visTop,
    visBot,
    dpr: 1,
    screenW: 1,
    screenH: 1,
    sxw,
    syw,
    font,
    drawGlow: envGlow,
    drawPuck: envPuck,
    plate,
    glowText,
    plainText,
    scratch: envScratch,
  };

  function syncEnv() {
    env.rx = rx;
    env.ry = ry;
    env.rw = rw;
    env.rh = rh;
    env.scale = scale;
    env.u = u;
    env.kx = kx;
    env.ky = ky;
    env.X0 = X0;
    env.Y0 = Y0;
    env.dpr = dpr;
    env.screenW = screenW;
    env.screenH = screenH;
  }

  function glowByKind(kind) {
    switch (kind) {
      case 'host': return glowHost;
      case 'guest': return glowGuest;
      case 'gold': return glowGold;
      case 'red': return glowRed;
      case 'green': return glowGreen;
      case 'orange': return glowOrange || glowGold;
      case 'violet': return glowViolet || glowWhite;
      case 'ice': return glowIce || glowWhite;
      default: return glowWhite;
    }
  }

  function envGlow(kind, sx, sy, radiusPx, alpha) {
    const g = glowByKind(kind);
    if (g && radiusPx > 0) drawGlow(g, sx, sy, radiusPx, alpha);
  }

  // The real puck sprite and its shadow at a world position; k scales the radius.
  function envPuck(wx, wy, k, alpha) {
    if (!spr) return;
    const kk = k > 0 ? k : 1;
    const sx = sxw(wx);
    const sy = syw(wy);
    const pr = puckR * scale * kk;
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    drawSprite(spr.puckShadow, sx + pr * 0.18, sy + pr * 0.32, kk);
    drawSprite(spr.puck, sx, sy, kk);
    ctx.globalAlpha = 1;
  }

  // A cached offscreen canvas of at least w x h pixels; the caller clears it.
  function envScratch(w, h) {
    const cw = Math.max(1, Math.ceil(w));
    const ch = Math.max(1, Math.ceil(h));
    if (!scratchCv) scratchCv = document.createElement('canvas');
    if (scratchCv.width < cw || scratchCv.height < ch) {
      scratchCv.width = Math.max(scratchCv.width, cw);
      scratchCv.height = Math.max(scratchCv.height, ch);
    }
    return scratchCv;
  }

  function twFail(e) {
    if (twErrLogged) return;
    twErrLogged = true;
    if (typeof console !== 'undefined') console.warn('twists-view:', e && e.message);
  }

  // Twist layer draw hooks run inside save/restore so a half-finished draw (or a throw)
  // never leaks alpha, composite mode, dashes or an unbalanced save into the frame.
  function twDraw(which, snap, now) {
    if (!tw) return;
    const fn = tw[which];
    if (typeof fn !== 'function') return;
    ctx.save();
    try {
      fn.call(tw, snap, now);
    } catch (e) {
      twFail(e);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.setLineDash(NO_DASH);
  }

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
    if (battle) layoutButtons();
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
    syncEnv();
  }

  function addBtn(side, x, y, rot) {
    const b = btns[btnN++];
    b.side = side;
    b.idx = side === 'host' ? 0 : 1;
    b.x = x;
    b.y = y;
    b.rot = rot;
  }

  // Each side's buttons sit in the two corners of its goal end, br + 14u in from both rails.
  // Host and guest screens show their own side at the bottom corners; solo shows the host at
  // the bottom and (pass and play only) the guest at the top, turned to face that player.
  function layoutButtons() {
    br = Math.max(30, 36 * u);
    ir = br * 0.5;
    btnShift = Math.max(0, 2 * br - 33 * u);
    btnDash = [br * 0.2, br * 0.16];
    shTh = Math.max(4, puckR * scale * 0.5);
    shDash = [shTh * 1.4, shTh];
    const mrPx = malletR * scale;
    catchDash = [mrPx * 0.3, mrPx * 0.2];
    const prPx = puckR * scale;
    magDash = [prPx * 0.45, prPx * 0.35];
    const pad = br + 14 * u;
    const xl = rx + pad;
    const xr = rx + rw - pad;
    const yb = ry + rh - pad;
    const yt = ry + pad;
    btnN = 0;
    if (role === 'guest') {
      addBtn('guest', xl, yb, false);
      addBtn('guest', xr, yb, false);
    } else {
      addBtn('host', xl, yb, false);
      addBtn('host', xr, yb, false);
      if (solo && players === 'pass') {
        addBtn('guest', xl, yt, true);
        addBtn('guest', xr, yt, true);
      }
    }
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

  // Cast-iron bomb: near-black sphere, soft top-left highlight, thin rim light and a
  // short rope fuse in a metal collar at the upper right. The flame is dynamic.
  function makeBomb(r) {
    const pad = Math.ceil(r * 0.5) + 2;
    return makeSprite((r + pad) * 2, (c, cx, cy) => {
      discShadow(c, cx, cy, r, r * 0.45, r * 0.1, r * 0.2, 0.65);
      let g = c.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.05, cx, cy, r * 1.05);
      g.addColorStop(0, '#5d6272');
      g.addColorStop(0.3, '#2b2e3a');
      g.addColorStop(0.7, '#101118');
      g.addColorStop(1, '#040406');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r, 0, TAU);
      c.fill();
      // soft highlight
      const hx = cx - r * 0.4;
      const hy = cy - r * 0.45;
      g = c.createRadialGradient(hx, hy, 0, hx, hy, r * 0.42);
      g.addColorStop(0, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(hx, hy, r * 0.42, 0, TAU);
      c.fill();
      // rim light
      const lw = Math.max(1, r * 0.05);
      c.lineWidth = lw;
      c.strokeStyle = 'rgba(140,170,255,0.45)';
      c.beginPath();
      c.arc(cx, cy, r - lw / 2, 0.2, 1.5);
      c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.25)';
      c.beginPath();
      c.arc(cx, cy, r - lw / 2, Math.PI * 1.05, Math.PI * 1.55);
      c.stroke();
      // metal collar where the fuse enters
      const ca = -0.9;
      const bx = cx + Math.cos(ca) * r * 0.9;
      const by = cy + Math.sin(ca) * r * 0.9;
      c.save();
      c.translate(bx, by);
      c.rotate(ca + Math.PI / 2);
      g = c.createLinearGradient(-r * 0.22, 0, r * 0.22, 0);
      g.addColorStop(0, '#7b8196');
      g.addColorStop(0.5, '#2e3242');
      g.addColorStop(1, '#14161f');
      c.fillStyle = g;
      c.beginPath();
      c.ellipse(0, 0, r * 0.22, r * 0.12, 0, 0, TAU);
      c.fill();
      c.restore();
      // rope fuse
      const fw = Math.max(1.5, r * 0.12);
      const tx = cx + r * FUSE_X;
      const ty = cy + r * FUSE_Y;
      c.lineCap = 'round';
      c.strokeStyle = '#4a3820';
      c.lineWidth = fw + 1;
      c.beginPath();
      c.moveTo(bx, by);
      c.quadraticCurveTo(cx + r * 0.5, cy - r * 1.0, tx, ty);
      c.stroke();
      c.strokeStyle = '#b8975a';
      c.lineWidth = fw;
      c.beginPath();
      c.moveTo(bx, by);
      c.quadraticCurveTo(cx + r * 0.5, cy - r * 1.0, tx, ty);
      c.stroke();
      c.lineCap = 'butt';
    });
  }

  function getBombSprite(rCss) {
    const key = Math.round(rCss * 2);
    let s = bombSprites.get(key);
    if (!s) {
      s = makeBomb(key / 2);
      bombSprites.set(key, s);
    }
    return s;
  }

  // Copy of a sprite with every opaque pixel flooded with one colour (glitch ghosts).
  function tintSprite(src, col, alpha) {
    const cv = document.createElement('canvas');
    cv.width = src.width;
    cv.height = src.height;
    cv.cs = src.cs;
    const c = cv.getContext('2d');
    c.drawImage(src, 0, 0);
    c.globalCompositeOperation = 'source-atop';
    c.globalAlpha = alpha == null ? 0.85 : alpha;
    c.fillStyle = col;
    c.fillRect(0, 0, cv.width, cv.height);
    return cv;
  }

  // --- battle sprites -------------------------------------------------------------

  // Vector item icons: no fonts, centred on (cx, cy), fitting a circle of radius r.
  function drawItemIcon(c, item, cx, cy, r) {
    c.save();
    c.translate(cx, cy);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    const lw = Math.max(1, r * 0.1);
    const ink = 'rgba(8,12,34,0.75)';
    let g;
    if (item === 'rocket') {
      c.rotate(Math.PI / 4);
      g = c.createLinearGradient(0, r * 0.45, 0, r * 1.2);
      g.addColorStop(0, '#fff6c8');
      g.addColorStop(0.45, '#ffb13d');
      g.addColorStop(1, 'rgba(255,80,30,0)');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(-r * 0.2, r * 0.44);
      c.quadraticCurveTo(0, r * 1.5, r * 0.2, r * 0.44);
      c.closePath();
      c.fill();
      c.fillStyle = '#ff4d3a';
      c.strokeStyle = ink;
      c.lineWidth = lw * 0.8;
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        c.beginPath();
        c.moveTo(sgn * r * 0.32, r * 0.02);
        c.lineTo(sgn * r * 0.74, r * 0.6);
        c.lineTo(sgn * r * 0.3, r * 0.46);
        c.closePath();
        c.fill();
        c.stroke();
      }
      g = c.createLinearGradient(-r * 0.4, 0, r * 0.4, 0);
      g.addColorStop(0, '#9aa7cf');
      g.addColorStop(0.35, '#ffffff');
      g.addColorStop(1, '#8793bd');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(0, -r);
      c.quadraticCurveTo(r * 0.62, -r * 0.35, r * 0.36, r * 0.5);
      c.lineTo(-r * 0.36, r * 0.5);
      c.quadraticCurveTo(-r * 0.62, -r * 0.35, 0, -r);
      c.closePath();
      c.fill();
      c.stroke();
      c.fillStyle = '#ff4d3a';
      c.beginPath();
      c.moveTo(0, -r);
      c.quadraticCurveTo(r * 0.3, -r * 0.72, r * 0.27, -r * 0.5);
      c.lineTo(-r * 0.27, -r * 0.5);
      c.quadraticCurveTo(-r * 0.3, -r * 0.72, 0, -r);
      c.closePath();
      c.fill();
      c.fillStyle = '#2b5fd9';
      c.strokeStyle = '#ffffff';
      c.lineWidth = lw * 0.9;
      c.beginPath();
      c.arc(0, -r * 0.02, r * 0.19, 0, TAU);
      c.fill();
      c.stroke();
    } else if (item === 'shield') {
      c.beginPath();
      c.moveTo(0, -r);
      c.bezierCurveTo(r * 0.35, -r * 0.8, r * 0.65, -r * 0.78, r * 0.86, -r * 0.7);
      c.bezierCurveTo(r * 0.94, r * 0.15, r * 0.5, r * 0.7, 0, r);
      c.bezierCurveTo(-r * 0.5, r * 0.7, -r * 0.94, r * 0.15, -r * 0.86, -r * 0.7);
      c.bezierCurveTo(-r * 0.65, -r * 0.78, -r * 0.35, -r * 0.8, 0, -r);
      c.closePath();
      g = c.createLinearGradient(-r, -r, r, r);
      g.addColorStop(0, '#b4d8ff');
      g.addColorStop(0.5, '#4a88e8');
      g.addColorStop(1, '#1d3f94');
      c.fillStyle = g;
      c.fill();
      c.strokeStyle = '#ffffff';
      c.lineWidth = lw * 1.2;
      c.stroke();
      // lit left half and a centre ridge
      c.fillStyle = 'rgba(255,255,255,0.22)';
      c.beginPath();
      c.moveTo(0, -r * 0.82);
      c.bezierCurveTo(-r * 0.3, -r * 0.66, -r * 0.5, -r * 0.62, -r * 0.7, -r * 0.58);
      c.bezierCurveTo(-r * 0.72, r * 0.1, -r * 0.4, r * 0.55, 0, r * 0.82);
      c.closePath();
      c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.55)';
      c.lineWidth = lw * 0.7;
      c.beginPath();
      c.moveTo(0, -r * 0.82);
      c.lineTo(0, r * 0.82);
      c.stroke();
    } else if (item === 'ghost') {
      const w = r * 0.78;
      const bw = (2 * w) / 3;
      c.beginPath();
      c.moveTo(-w, r * 0.72);
      c.lineTo(-w, -r * 0.15);
      c.arc(0, -r * 0.15, w, Math.PI, TAU);
      c.lineTo(w, r * 0.72);
      for (let k = 0; k < 3; k++) c.quadraticCurveTo(w - bw * (k + 0.5), r * 1.14, w - bw * (k + 1), r * 0.72);
      c.closePath();
      g = c.createLinearGradient(0, -r, 0, r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#c4b0ff');
      c.fillStyle = g;
      c.fill();
      c.strokeStyle = 'rgba(70,40,140,0.8)';
      c.lineWidth = lw * 0.9;
      c.stroke();
      c.fillStyle = '#2a1b5c';
      c.beginPath();
      c.ellipse(-w * 0.4, -r * 0.2, r * 0.12, r * 0.17, 0, 0, TAU);
      c.ellipse(w * 0.4, -r * 0.2, r * 0.12, r * 0.17, 0, 0, TAU);
      c.fill();
      c.beginPath();
      c.ellipse(0, r * 0.22, r * 0.1, r * 0.13, 0, 0, TAU);
      c.fill();
    } else if (item === 'shrink') {
      // four arrows closing in on a small disc
      c.fillStyle = '#ffd36b';
      c.strokeStyle = ink;
      c.lineWidth = lw * 0.8;
      c.beginPath();
      c.arc(0, 0, r * 0.25, 0, TAU);
      c.fill();
      c.stroke();
      c.fillStyle = '#7cffd4';
      c.strokeStyle = '#7cffd4';
      const q = 0.7071;
      for (let k = 0; k < 4; k++) {
        const dx = k & 1 ? q : -q;
        const dy = k & 2 ? q : -q;
        const nx = -dy;
        const ny = dx;
        c.lineWidth = lw * 1.7;
        c.beginPath();
        c.moveTo(dx * r * 0.98, dy * r * 0.98);
        c.lineTo(dx * r * 0.66, dy * r * 0.66);
        c.stroke();
        c.beginPath();
        c.moveTo(dx * r * 0.42, dy * r * 0.42);
        c.lineTo(dx * r * 0.74 + nx * r * 0.22, dy * r * 0.74 + ny * r * 0.22);
        c.lineTo(dx * r * 0.74 - nx * r * 0.22, dy * r * 0.74 - ny * r * 0.22);
        c.closePath();
        c.fill();
      }
    } else if (item === 'freeze') {
      for (let pass = 0; pass < 2; pass++) {
        c.strokeStyle = pass ? '#e6f9ff' : 'rgba(20,70,140,0.7)';
        c.lineWidth = pass ? lw * 1.4 : lw * 2.6;
        for (let k = 0; k < 6; k++) {
          c.save();
          c.rotate((k * Math.PI) / 3);
          c.beginPath();
          c.moveTo(0, 0);
          c.lineTo(r * 0.98, 0);
          c.moveTo(r * 0.55, 0);
          c.lineTo(r * 0.82, -r * 0.22);
          c.moveTo(r * 0.55, 0);
          c.lineTo(r * 0.82, r * 0.22);
          c.stroke();
          c.restore();
        }
      }
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(0, 0, r * 0.12, 0, TAU);
      c.fill();
    } else if (item === 'magnet') {
      // horseshoe, poles down, silver tips
      const R = r * 0.5;
      const th = r * 0.38;
      const cy = -r * 0.08;
      const yb = r * 0.8;
      const yt = r * 0.42;
      c.lineCap = 'butt';
      c.beginPath();
      c.moveTo(-R, yb);
      c.lineTo(-R, cy);
      c.arc(0, cy, R, Math.PI, TAU);
      c.lineTo(R, yb);
      c.strokeStyle = ink;
      c.lineWidth = th + lw * 1.8;
      c.stroke();
      g = c.createLinearGradient(-r, -r, r, r);
      g.addColorStop(0, '#ffc2f2');
      g.addColorStop(0.45, '#ff4fd8');
      g.addColorStop(1, '#a0137f');
      c.strokeStyle = g;
      c.lineWidth = th;
      c.stroke();
      g = c.createLinearGradient(-R - th / 2, 0, -R + th / 2, 0);
      g.addColorStop(0, '#8d97b8');
      g.addColorStop(0.4, '#ffffff');
      g.addColorStop(1, '#9aa4c4');
      c.strokeStyle = g;
      c.beginPath();
      c.moveTo(-R, yb);
      c.lineTo(-R, yt);
      c.moveTo(R, yb);
      c.lineTo(R, yt);
      c.stroke();
      c.strokeStyle = 'rgba(255,255,255,0.65)';
      c.lineWidth = lw * 0.8;
      c.lineCap = 'round';
      c.beginPath();
      c.arc(0, cy, R + th * 0.22, Math.PI * 1.12, Math.PI * 1.55);
      c.stroke();
    } else if (item === 'widegoal') {
      // two posts and arrows pushing them apart
      const pw = r * 0.26;
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        const px = sgn * r * 0.78;
        c.beginPath();
        rrPath(c, px - pw / 2, -r * 0.72, pw, r * 1.44, pw / 2, pw / 2);
        g = c.createLinearGradient(px - pw / 2, 0, px + pw / 2, 0);
        g.addColorStop(0, '#fff3c4');
        g.addColorStop(0.5, '#ffd166');
        g.addColorStop(1, '#b8861c');
        c.fillStyle = g;
        c.fill();
        c.strokeStyle = ink;
        c.lineWidth = lw * 0.9;
        c.stroke();
      }
      for (let pass = 0; pass < 2; pass++) {
        c.strokeStyle = pass ? '#ffffff' : ink;
        c.fillStyle = pass ? '#ffffff' : ink;
        c.lineWidth = pass ? lw * 1.6 : lw * 3.2;
        c.beginPath();
        c.moveTo(-r * 0.3, 0);
        c.lineTo(r * 0.3, 0);
        c.stroke();
        const e = pass ? 0 : lw * 0.8;
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          c.beginPath();
          c.moveTo(sgn * (r * 0.56 + e), 0);
          c.lineTo(sgn * (r * 0.26 - e * 0.5), -r * 0.26 - e);
          c.lineTo(sgn * (r * 0.26 - e * 0.5), r * 0.26 + e);
          c.closePath();
          c.fill();
        }
      }
    } else if (item === 'goalie') {
      // a small mallet wearing a visor
      g = c.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.05, 0, 0, r * 0.9);
      g.addColorStop(0, '#d6ecff');
      g.addColorStop(0.5, '#7cc4ff');
      g.addColorStop(1, '#2a6fb8');
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, r * 0.08, r * 0.82, 0, TAU);
      c.fill();
      c.strokeStyle = ink;
      c.lineWidth = lw;
      c.stroke();
      c.fillStyle = 'rgba(255,255,255,0.35)';
      c.beginPath();
      c.arc(0, r * 0.16, r * 0.38, 0, TAU);
      c.fill();
      c.beginPath();
      rrPath(c, -r * 0.66, -r * 0.42, r * 1.32, r * 0.38, r * 0.19, r * 0.19);
      g = c.createLinearGradient(0, -r * 0.42, 0, -r * 0.04);
      g.addColorStop(0, '#3a4a7a');
      g.addColorStop(1, '#0b1030');
      c.fillStyle = g;
      c.fill();
      c.strokeStyle = '#ffffff';
      c.lineWidth = lw * 0.8;
      c.stroke();
      c.strokeStyle = 'rgba(160,220,255,0.9)';
      c.lineWidth = lw * 0.7;
      c.beginPath();
      c.moveTo(-r * 0.46, -r * 0.3);
      c.lineTo(-r * 0.1, -r * 0.3);
      c.stroke();
    } else if (item === 'giant') {
      // a big disc with arrows pushing outwards
      g = c.createRadialGradient(-r * 0.2, -r * 0.25, r * 0.05, 0, 0, r * 0.62);
      g.addColorStop(0, '#ffe2b8');
      g.addColorStop(0.55, '#ffb347');
      g.addColorStop(1, '#b8640e');
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, 0, r * 0.56, 0, TAU);
      c.fill();
      c.strokeStyle = ink;
      c.lineWidth = lw;
      c.stroke();
      const q = 0.7071;
      for (let pass = 0; pass < 2; pass++) {
        c.fillStyle = pass ? '#ffffff' : ink;
        const e = pass ? 0 : lw * 0.7;
        for (let k = 0; k < 4; k++) {
          const dx = k & 1 ? q : -q;
          const dy = k & 2 ? q : -q;
          const nx = -dy;
          const ny = dx;
          c.beginPath();
          c.moveTo(dx * (r * 1.02 + e), dy * (r * 1.02 + e));
          c.lineTo(dx * (r * 0.68 - e) + nx * (r * 0.24 + e), dy * (r * 0.68 - e) + ny * (r * 0.24 + e));
          c.lineTo(dx * (r * 0.68 - e) - nx * (r * 0.24 + e), dy * (r * 0.68 - e) - ny * (r * 0.24 + e));
          c.closePath();
          c.fill();
        }
      }
    } else if (item === 'catch') {
      // a cup holding a puck
      g = c.createLinearGradient(-r, -r, r, r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.5, '#c4cde6');
      g.addColorStop(1, '#5e6a96');
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, -r * 0.28, r * 0.4, 0, TAU);
      c.fill();
      c.strokeStyle = ink;
      c.lineWidth = lw;
      c.stroke();
      c.strokeStyle = 'rgba(40,52,110,0.5)';
      c.lineWidth = lw * 0.7;
      c.beginPath();
      c.arc(0, -r * 0.28, r * 0.22, 0, TAU);
      c.stroke();
      c.lineCap = 'round';
      c.strokeStyle = ink;
      c.lineWidth = r * 0.32 + lw * 1.8;
      c.beginPath();
      c.arc(0, -r * 0.05, r * 0.72, Math.PI * 0.12, Math.PI * 0.88);
      c.stroke();
      g = c.createLinearGradient(0, 0, 0, r);
      g.addColorStop(0, '#c4ffd8');
      g.addColorStop(1, '#22a656');
      c.strokeStyle = g;
      c.lineWidth = r * 0.32;
      c.stroke();
    } else if (item === 'mirror') {
      // two half pucks reflected across a bright line
      const pr = r * 0.66;
      const gap = r * 0.12;
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        c.beginPath();
        c.arc(sgn * gap, 0, pr, sgn < 0 ? Math.PI / 2 : -Math.PI / 2, sgn < 0 ? Math.PI * 1.5 : Math.PI / 2);
        c.closePath();
        g = c.createLinearGradient(sgn * gap, -pr, sgn * (gap + pr), pr);
        g.addColorStop(0, sgn < 0 ? '#ffffff' : '#c8e8ff');
        g.addColorStop(1, sgn < 0 ? '#6c7cae' : '#5a86b8');
        c.fillStyle = g;
        c.globalAlpha = sgn < 0 ? 1 : 0.75;
        c.fill();
        c.globalAlpha = 1;
        c.strokeStyle = ink;
        c.lineWidth = lw * 0.9;
        c.stroke();
      }
      c.fillStyle = '#ffffff';
      c.fillRect(-lw * 0.6, -r * 0.95, lw * 1.2, r * 1.9);
      c.strokeStyle = 'rgba(217,241,255,0.9)';
      c.lineWidth = lw * 0.8;
      c.beginPath();
      c.moveTo(-r * 0.62, -r * 0.82);
      c.lineTo(-r * 0.38, -r * 0.58);
      c.moveTo(r * 0.38, -r * 0.82);
      c.lineTo(r * 0.62, -r * 0.58);
      c.stroke();
    } else if (item === 'quake') {
      // a jagged crack with a branch
      for (let pass = 0; pass < 3; pass++) {
        c.strokeStyle = pass === 0 ? ink : pass === 1 ? '#ff7a45' : '#fff1e0';
        c.lineWidth = pass === 0 ? lw * 4.2 : pass === 1 ? lw * 2.6 : lw * 0.9;
        c.beginPath();
        c.moveTo(-r * 0.12, -r * 0.98);
        c.lineTo(r * 0.28, -r * 0.48);
        c.lineTo(-r * 0.22, -r * 0.08);
        c.lineTo(r * 0.32, r * 0.38);
        c.lineTo(-r * 0.02, r * 0.98);
        c.moveTo(-r * 0.22, -r * 0.08);
        c.lineTo(-r * 0.72, r * 0.18);
        c.moveTo(r * 0.28, -r * 0.48);
        c.lineTo(r * 0.76, -r * 0.6);
        c.stroke();
      }
    } else if (item === 'decoys') {
      // three pucks fanned out, the middle one real
      const pr = r * 0.36;
      const spots = [-r * 0.52, r * 0.28, r * 0.52, r * 0.28, 0, -r * 0.36];
      for (let k = 0; k < 3; k++) {
        const px = spots[k * 2];
        const py = spots[k * 2 + 1];
        g = c.createLinearGradient(px - pr, py - pr, px + pr, py + pr);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(0.5, k < 2 ? '#c9b4ff' : '#cdd6ee');
        g.addColorStop(1, k < 2 ? '#5b3fa8' : '#5e6a96');
        c.fillStyle = g;
        c.globalAlpha = k < 2 ? 0.85 : 1;
        c.beginPath();
        c.arc(px, py, pr, 0, TAU);
        c.fill();
        c.globalAlpha = 1;
        c.strokeStyle = k < 2 ? 'rgba(70,40,140,0.85)' : ink;
        c.lineWidth = lw * 0.9;
        c.stroke();
        c.strokeStyle = 'rgba(255,255,255,0.5)';
        c.lineWidth = lw * 0.6;
        c.beginPath();
        c.arc(px, py, pr * 0.55, 0, TAU);
        c.stroke();
      }
    } else if (item === 'steal') {
      // a ghostly hand with a wavy tail
      const fw2 = r * 0.22;
      const tops = [-r * 0.74, -r * 0.88, -r * 0.84, -r * 0.66];
      const xs = [-r * 0.33, -r * 0.11, r * 0.11, r * 0.33];
      const palm = () => {
        c.beginPath();
        c.moveTo(-r * 0.46, -r * 0.12);
        c.lineTo(-r * 0.46, r * 0.5);
        c.quadraticCurveTo(-r * 0.31, r * 0.98, -r * 0.15, r * 0.62);
        c.quadraticCurveTo(0, r * 0.98, r * 0.15, r * 0.62);
        c.quadraticCurveTo(r * 0.31, r * 0.98, r * 0.46, r * 0.5);
        c.lineTo(r * 0.46, -r * 0.12);
        c.closePath();
      };
      const fingers = () => {
        c.beginPath();
        for (let k = 0; k < 4; k++) {
          c.moveTo(xs[k], 0);
          c.lineTo(xs[k], tops[k]);
        }
        c.moveTo(-r * 0.3, r * 0.22);
        c.lineTo(-r * 0.74, -r * 0.14);
      };
      c.lineCap = 'round';
      c.strokeStyle = 'rgba(70,40,140,0.85)';
      c.lineWidth = fw2 + lw * 1.8;
      fingers();
      c.stroke();
      c.lineWidth = lw * 1.8;
      palm();
      c.stroke();
      g = c.createLinearGradient(0, -r, 0, r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#d4d8ff');
      c.strokeStyle = g;
      c.fillStyle = g;
      c.lineWidth = fw2;
      fingers();
      c.stroke();
      palm();
      c.fill();
      c.fillStyle = '#2a1b5c';
      c.beginPath();
      c.ellipse(-r * 0.17, r * 0.18, r * 0.07, r * 0.1, 0, 0, TAU);
      c.ellipse(r * 0.17, r * 0.18, r * 0.07, r * 0.1, 0, 0, TAU);
      c.fill();
    } else if (item === 'tinypuck') {
      // a small puck with arrows squeezing it from both sides
      const pr = r * 0.34;
      g = c.createLinearGradient(-pr, -pr, pr, pr);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.45, '#cdd6ee');
      g.addColorStop(1, '#4e5a88');
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, 0, pr, 0, TAU);
      c.fill();
      c.strokeStyle = ink;
      c.lineWidth = lw;
      c.stroke();
      c.strokeStyle = 'rgba(40,52,110,0.5)';
      c.lineWidth = lw * 0.6;
      c.beginPath();
      c.arc(0, 0, pr * 0.55, 0, TAU);
      c.stroke();
      for (let pass = 0; pass < 2; pass++) {
        c.strokeStyle = pass ? '#a8ecff' : ink;
        c.fillStyle = pass ? '#a8ecff' : ink;
        const e = pass ? 0 : lw * 0.7;
        c.lineWidth = pass ? lw * 1.7 : lw * 1.7 + e * 2;
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          c.beginPath();
          c.moveTo(sgn * r * 0.98, 0);
          c.lineTo(sgn * r * 0.7, 0);
          c.stroke();
          c.beginPath();
          c.moveTo(sgn * (r * 0.42 - e), 0);
          c.lineTo(sgn * (r * 0.76 + e * 0.5), -r * 0.26 - e);
          c.lineTo(sgn * (r * 0.76 + e * 0.5), r * 0.26 + e);
          c.closePath();
          c.fill();
        }
      }
    }
    c.restore();
  }

  function makeItemIcon(item, r) {
    const pad = Math.ceil(r * 0.3) + 2;
    return makeSprite((r + pad) * 2, (c, cx, cy) => drawItemIcon(c, item, cx, cy, r));
  }

  // Round corner button: dark glass disc with a rim in the side's colour.
  function makeBtn(side) {
    const pad = Math.ceil(br * 0.35) + 2;
    const rgb = side === 'host' ? HOST_RGB : GUEST_RGB;
    return makeSprite((br + pad) * 2, (c, cx, cy) => {
      discShadow(c, cx, cy, br, br * 0.5, 0, br * 0.12, 0.55);
      let g = c.createRadialGradient(cx - br * 0.3, cy - br * 0.35, br * 0.05, cx, cy, br);
      g.addColorStop(0, 'rgba(62,80,128,0.9)');
      g.addColorStop(0.7, 'rgba(16,22,46,0.9)');
      g.addColorStop(1, 'rgba(6,10,26,0.94)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, br, 0, TAU);
      c.fill();
      const lw = Math.max(2.5, br * 0.09);
      c.strokeStyle = `rgba(${rgb},0.95)`;
      c.lineWidth = lw;
      c.beginPath();
      c.arc(cx, cy, br - lw / 2, 0, TAU);
      c.stroke();
      g = c.createLinearGradient(cx - br, cy - br, cx + br, cy + br);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(0.45, 'rgba(255,255,255,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.35)');
      c.strokeStyle = g;
      c.lineWidth = lw * 0.7;
      c.beginPath();
      c.arc(cx, cy, br - lw * 1.4, 0, TAU);
      c.stroke();
    });
  }

  // One rainbow frame of the spinning item box: rounded square, hue stops shifted by `shift`,
  // glossy bevel and a white "?".
  function makeBoxFrame(rpx, shift) {
    const side = rpx * 2.1;
    const pad = 3;
    return makeSprite(side + pad * 2, (c, cx, cy) => {
      const h = side / 2;
      const rad = side * 0.24;
      c.beginPath();
      rrPath(c, cx - h, cy - h, side, side, rad, rad);
      const g = c.createLinearGradient(cx - h, cy - h, cx + h, cy + h);
      for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${(shift + i * 60) % 360},95%,60%)`);
      c.fillStyle = g;
      c.fill();
      // glossy top-left sheen
      c.save();
      c.clip();
      const sg = c.createLinearGradient(cx - h, cy - h, cx + h * 0.2, cy + h * 0.2);
      sg.addColorStop(0, 'rgba(255,255,255,0.55)');
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = sg;
      c.fillRect(cx - h, cy - h, side, side);
      const dg = c.createLinearGradient(cx, cy, cx + h, cy + h);
      dg.addColorStop(0, 'rgba(0,0,60,0)');
      dg.addColorStop(1, 'rgba(0,0,60,0.3)');
      c.fillStyle = dg;
      c.fillRect(cx - h, cy - h, side, side);
      c.restore();
      c.lineJoin = 'round';
      c.strokeStyle = 'rgba(255,255,255,0.9)';
      c.lineWidth = Math.max(1.5, side * 0.06);
      c.beginPath();
      rrPath(c, cx - h + c.lineWidth / 2, cy - h + c.lineWidth / 2, side - c.lineWidth, side - c.lineWidth, rad, rad);
      c.stroke();
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = font(side * 0.78, 900);
      c.strokeStyle = 'rgba(30,10,90,0.85)';
      c.lineWidth = Math.max(1.5, side * 0.09);
      c.strokeText('?', cx, cy + side * 0.04);
      c.fillStyle = '#ffffff';
      c.fillText('?', cx, cy + side * 0.04);
    });
  }

  function getBoxFrames(rCss) {
    const key = Math.max(4, Math.round(rCss * 2));
    let f = boxSprites.get(key);
    if (!f) {
      f = [];
      for (let i = 0; i < BOX_FRAMES; i++) f.push(makeBoxFrame(key / 2, (i * 360) / BOX_FRAMES));
      boxSprites.set(key, f);
    }
    return f;
  }

  function itemGlow(item) {
    return itemGlows[item] || (itemGlows[item] = makeGlow(ITEM_RGB[item]));
  }

  function freeCv(cv) {
    if (cv) {
      cv.width = 0;
      cv.height = 0;
    }
  }

  function freeBattleSprites() {
    for (const frames of boxSprites.values()) for (const cv of frames) freeCv(cv);
    boxSprites.clear();
    if (!spr) return;
    freeCv(spr.puckIce);
    spr.puckIce = null;
    freeCv(spr.puckMagnet);
    spr.puckMagnet = null;
    if (spr.btn) {
      freeCv(spr.btn.host);
      freeCv(spr.btn.guest);
      spr.btn = null;
    }
    if (spr.items) {
      for (const k in spr.items) freeCv(spr.items[k]);
      spr.items = null;
    }
  }

  function buildBattleSprites() {
    spr.puckIce = tintSprite(spr.puck, '#bfe9ff', 0.62);
    spr.puckMagnet = tintSprite(spr.puck, ITEM_COL.magnet, 0.5);
    spr.btn = { host: makeBtn('host'), guest: makeBtn('guest') };
    spr.items = {};
    for (const k in ITEM_COL) spr.items[k] = makeItemIcon(k, ir);
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
    if (battle) freeBattleSprites();
    const pr = puckR * scale;
    const mr = malletR * scale;
    const puck = makePuck(pr);
    spr = {
      puck,
      puckCyan: tintSprite(puck, '#49f2ff'),
      puckMag: tintSprite(puck, '#ff4bd8'),
      puckShadow: makePuckShadow(pr),
      host: makeMallet(mr, '#ffc3a2', '#ff7a45', '#b0400f', 'rgba(70,20,0,0.9)'),
      guest: makeMallet(mr, '#b9f0ff', '#4fd1ff', '#1580ab', 'rgba(0,40,60,0.9)'),
    };
    bumperSprites.clear();
    mineSprites.clear();
    bombSprites.clear();
    rays = { host: makeRays(HOST_RGB), guest: makeRays(GUEST_RGB) };
    if (battle) buildBattleSprites();
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
  const bombFlashT = []; // detonation time per obstacle index
  const bombHitT = []; // last puck knock per obstacle index
  let goalWhy = ''; // 'why' of the last goal event, cleared on serve ('bomb' changes the banner)
  // Glitch mode: last warning, last jump (with its from-point) and the puck's screen y.
  let glitchWarnT = -1e9;
  let glitchT = -1e9;
  let glitchFx = 0;
  let glitchFy = 0;
  let glitchPy = 0;
  let latency = null;
  let shOx = 0; // puck shadow offset (px), lags behind the puck
  let shOy = 0;
  let uiNow = NO_UI;
  let gA = 1; // alpha multiplier for message text (phase transitions)

  // Battle state: everything is timestamped with performance.now() and cleared by resetBattleFx().
  const prevIt = ['', ''];
  const gotT = [-1e9, -1e9]; // when each side's held item lands (pulse + pop)
  const useT = [-1e9, -1e9];
  const useItemId = ['', ''];
  const useLeft = [false, false]; // which corner the used icon flies out of
  const shT = [-1e9, -1e9]; // shield start per goal side
  const shHitT = [-1e9, -1e9];
  const prevSh = [0, 0];
  let prevFz = 0;
  let fzT = -1e9;
  let thawT = -1e9;
  let rocketT = -1e9;
  let btSync = false; // false: the next snapshot only syncs the trackers, no triggers
  const boxPrevA = [-1, -1, -1, -1, -1, -1, -1, -1];
  const boxInT = [-1e9, -1e9, -1e9, -1e9, -1e9, -1e9, -1e9, -1e9]; // by box ordinal in snap.ob
  const mrDraw = [malletR, malletR]; // smoothed drawn mallet radius per side (world units)
  let dtNow = 0.016;
  let ghWas = false;
  let ghX = 0;
  let ghY = 0;
  let shTh = 4; // shield bar thickness (px)
  let shDash = DASH;
  let catchDash = DASH;
  let magDash = DASH;
  let tgtX = 0;
  let tgtY = 0;
  let pillX = 0;
  let pillY = 0;
  // New items: goalie flashes, giant ring, tinypuck,
  // mirror shimmer and quake dust timers.
  const goalieHitT = [-1e9, -1e9];
  const prevGi = [0, 0];
  const giT = [-1e9, -1e9];
  let prevTp = 0;
  let mirWas = false;
  let mirOnT = -1e9;
  let mirOffT = -1e9;
  let quakeDustT = 0;
  let quakeSeed = 1;
  let puckK = 1; // smoothed drawn puck radius / puckR (snap.pr)
  let curBt = null; // snap.bt of the frame being drawn (battle only)
  let lastTw = null; // snap.tw of the last snapshot (random mode)
  const flights = [];
  // kind 0: box -> button, 1: used item out of the button, 2: steal (ghost hand from the
  // target's pill or button to the thief's button; src is the target side).
  for (let i = 0; i < FLY_N; i++) flights.push({ on: false, kind: 0, item: '', t0: 0, wx: 0, wy: 0, idx: 0, left: false, src: 0 });
  let flyHead = 0;

  // Instant replay treatment (ui.replay): letterbox bars, REPLAY badge, progress line.
  let replayOn = false;
  let rpK = 0; // 0..1 slide progress of the bars (eased when drawn)
  let rpT = 0; // last replay progress 0..1 (kept while the bars slide out)
  let rpEl = 0; // seconds the replay has played (the skip hint fades in after a moment)
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
    if (battle) trackBattle(snap, now);
    if (random) {
      // A new match may roll a different twist: drop the trail and rebuild the label.
      const twId = typeof snap.tw === 'string' ? snap.tw : null;
      if (twId !== lastTw) {
        lastTw = twId;
        trCount = 0;
      }
      if (tw && typeof tw.onSnap === 'function') {
        try {
          tw.onSnap(snap, now);
        } catch (e) {
          twFail(e);
        }
      }
    }
    if (ev && ev.length) {
      const n = Math.min(ev.length, 16);
      for (let i = 0; i < n; i++) {
        const e = ev[i];
        if (!e) continue;
        fx.onEvent(e, now, snap);
        if (tw && typeof tw.onEvent === 'function') {
          try {
            tw.onEvent(e, snap, now);
          } catch (err) {
            twFail(err);
          }
        }
        if (e.k === 'bumper' && snap.ob) markObstacle(snap.ob, e, now, 'bumper', bumperFlashT);
        else if (e.k === 'mine' && snap.ob) markObstacle(snap.ob, e, now, 'mine', mineFlashT);
        else if (e.k === 'bomb' && snap.ob) markObstacle(snap.ob, e, now, 'bomb', bombFlashT);
        else if (e.k === 'bombhit' && snap.ob) markObstacle(snap.ob, e, now, 'bomb', bombHitT);
        else if (e.k === 'goal') goalWhy = e.why || '';
        else if (e.k === 'serve') goalWhy = '';
        else if (e.k === 'glitchwarn') glitchWarnT = now;
        else if (e.k === 'glitch') {
          glitchT = now;
          glitchFx = e.fx == null ? e.x : e.fx;
          glitchFy = e.fy == null ? e.y : e.fy;
          trCount = 0; // no streak across the jump
        } else if (e.k === 'go' && !replayOn) goT = now;
        else if (battle) battleEvent(e, snap, now);
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

  // --- battle bookkeeping -------------------------------------------------------

  const sideIdx = (by) => (by === 'guest' ? 1 : by === 'host' ? 0 : -1);

  // Transitions read from successive snapshots: item received, shield up, freeze start, box back.
  function trackBattle(snap, now) {
    const it = snap.it;
    if (it) {
      for (let i = 0; i < 2; i++) {
        const v = it[i] || '';
        if (btSync && v && v !== prevIt[i] && !replayOn) gotT[i] = now;
        prevIt[i] = v;
      }
    }
    const bt = snap.bt;
    if (bt) {
      const sh = bt.sh || NO_RD;
      for (let i = 0; i < 2; i++) {
        const v = sh[i] || 0;
        if (btSync && v > 0 && !(prevSh[i] > 0)) shT[i] = now;
        prevSh[i] = v;
      }
      const fz = bt.fz || 0;
      if (btSync && fz > 0 && !(prevFz > 0)) fzT = now;
      prevFz = fz;
      const gi = bt.gi || NO_RD;
      for (let i = 0; i < 2; i++) {
        const v = gi[i] || 0;
        if (btSync && v > 0 && !(prevGi[i] > 0) && !replayOn) giT[i] = now;
        prevGi[i] = v;
      }
      const tp = bt.tp || 0;
      if (btSync && tp > 0 && !(prevTp > 0) && !replayOn && snap.p) {
        // the puck shrinks: a sparkle and a ring that closes in on it
        fx.sparkle(snap.p[0], snap.p[1], 14, null);
        fx.addRing(snap.p[0], snap.p[1], puckR * 3.4, puckR * 0.7, 0.36, ITEM_COL.tinypuck, 4, now, 0.85);
      }
      prevTp = tp;
    }
    if (snap.ob) {
      let ord = 0;
      for (let i = 0; i < snap.ob.length && ord < boxPrevA.length; i++) {
        const o = snap.ob[i];
        if (o.k !== 'box') continue;
        if (btSync && o.a === 1 && boxPrevA[ord] !== 1) boxInT[ord] = now;
        boxPrevA[ord] = o.a;
        ord++;
      }
    }
    btSync = true;
  }

  function battleEvent(e, snap, now) {
    const k = e.k;
    if (k === 'box') {
      const si = sideIdx(e.by);
      if (si >= 0 && e.item && !replayOn) {
        // the held item lands when the flying icon does
        gotT[si] = now + BOX_FLY_MS * 0.85;
        addFlight(0, e.item, e.x, e.y, si, false, now);
      }
    } else if (k === 'boxspawn') {
      if (snap.ob) markBox(snap.ob, e, now);
    } else if (k === 'use') {
      const si = sideIdx(e.by);
      if (si >= 0) {
        useT[si] = now;
        useItemId[si] = e.item || '';
        useLeft[si] = sxw(e.x == null ? W / 2 : e.x) < rx + rw / 2;
        if (e.item && !replayOn) addFlight(1, e.item, 0, 0, si, useLeft[si], now);
      }
    } else if (k === 'rocket') rocketT = now;
    else if (k === 'shieldhit') {
      const si = sideIdx(e.by);
      if (si >= 0) shHitT[si] = now;
    } else if (k === 'thaw') thawT = now;
    else if (k === 'goaliehit') {
      const si = sideIdx(e.by);
      if (si >= 0) goalieHitT[si] = now;
    } else if (k === 'steal') {
      const si = sideIdx(e.by);
      if (si >= 0 && e.item && !replayOn) {
        // the stolen item lands on the thief's button when the hand gets there
        gotT[si] = now + STEAL_FLY_MS * 0.85;
        addFlight(2, e.item, 0, 0, si, false, now);
      }
    }
  }

  // The n-th box of snap.ob nearest the event (boxes keep their slot, so the ordinal is stable
  // even when mines are spliced out of the list).
  function markBox(ob, e, now) {
    let best = -1;
    let bd = 1e12;
    let ord = 0;
    for (let i = 0; i < ob.length; i++) {
      if (ob[i].k !== 'box') continue;
      const d = (ob[i].x - e.x) * (ob[i].x - e.x) + (ob[i].y - e.y) * (ob[i].y - e.y);
      if (d < bd) {
        bd = d;
        best = ord;
      }
      ord++;
    }
    if (best >= 0 && best < boxInT.length) boxInT[best] = now;
  }

  function addFlight(kind, item, wx, wy, idx, left, now) {
    if (!spr || !spr.items || !spr.items[item]) return;
    const f = flights[flyHead];
    flyHead = (flyHead + 1) % FLY_N;
    f.on = true;
    f.kind = kind;
    f.item = item;
    f.t0 = now;
    f.wx = wx;
    f.wy = wy;
    f.idx = idx;
    f.left = left;
    f.src = 1 - idx;
  }

  // Replay enter/leave and destroy: no stale item state or effects survive.
  function resetBattleFx() {
    for (let i = 0; i < FLY_N; i++) flights[i].on = false;
    for (let i = 0; i < 2; i++) {
      gotT[i] = -1e9;
      useT[i] = -1e9;
      shT[i] = -1e9;
      shHitT[i] = -1e9;
      prevSh[i] = 0;
      prevIt[i] = '';
    }
    for (let i = 0; i < boxInT.length; i++) {
      boxInT[i] = -1e9;
      boxPrevA[i] = -1;
    }
    prevFz = 0;
    fzT = -1e9;
    thawT = -1e9;
    rocketT = -1e9;
    ghWas = false;
    btSync = false;
    for (let i = 0; i < 2; i++) {
      goalieHitT[i] = -1e9;
      prevGi[i] = 0;
      giT[i] = -1e9;
    }
    prevTp = 0;
    mirWas = false;
    mirOnT = -1e9;
    mirOffT = -1e9;
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
    const cx = sxw(g.x);
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
    const cx = sxw(g.x);
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

    // Battle: a wide goal pulses gold, a magnet target mouth glows magenta.
    if (curBt) {
      const wg = curBt.wg ? curBt.wg[g.idx] : 0;
      const mg = curBt.mg ? curBt.mg[g.idx] : 0;
      if (wg > 0) mouthTint(half, gwPx, itemGlow('widegoal'), ITEM_COL.widegoal, Math.min(1, wg / 0.3) * (0.55 + 0.4 * Math.sin(now / 150)));
      if (mg > 0) mouthTint(half, gwPx, itemGlow('magnet'), ITEM_COL.magnet, Math.min(1, mg / 0.2) * (0.6 + 0.35 * Math.sin(now / 80)));
    }

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

  // Coloured light pooled at a goal mouth, in drawGoalInside's local space (+y into the rink).
  function mouthTint(half, gwPx, glow, col, a) {
    if (a <= 0.01) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    ctx.drawImage(glow, -half * 1.2, -glowH * 1.5, gwPx * 1.2, glowH * 3.6);
    ctx.globalAlpha = a * 0.9;
    ctx.fillStyle = col;
    ctx.fillRect(-half, 0, gwPx, Math.max(2, 3 * u));
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Bombs move, so they are drawn at the snapshot position every frame. A detonated
  // bomb (still in the snapshot) is replaced by a scorch ring and a big blast for a moment.
  function drawBomb(o, i, sx, sy, r, now) {
    const bt = (now - (bombFlashT[i] || -1e9)) / 1000;
    if (bt >= 0 && bt < BOMB_FLASH_S) {
      const fade = 1 - bt / BOMB_FLASH_S;
      drawGlow(glowBlack, sx, sy, r * 3.4, 0.65 * fade);
      ctx.globalAlpha = 0.5 * fade;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = Math.max(2, r * 0.3);
      ctx.beginPath();
      ctx.arc(sx, sy, r * 1.15, 0, TAU);
      ctx.stroke();
      if (bt < 0.8) {
        const t = bt / 0.8;
        const rr = r * (1.2 + 6.7 * easeOutCubic(t)); // the mine blast, about 1.6x bigger
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(glowGold, sx, sy, rr, (1 - t) * (1 - t));
        drawGlow(glowRed, sx, sy, rr * 1.35, (1 - t) * 0.8);
        if (t < 0.25) {
          ctx.globalAlpha = (1 - t / 0.25) * 0.95;
          ctx.fillStyle = '#fff3d6';
          ctx.beginPath();
          ctx.arc(sx, sy, r * (1.3 + 11.5 * t), 0, TAU);
          ctx.fill();
        }
        ctx.globalAlpha = (1 - t) * 0.8;
        ctx.strokeStyle = '#ffb35a';
        ctx.lineWidth = Math.max(2, r * 0.28 * (1 - t));
        ctx.beginPath();
        ctx.arc(sx, sy, r * (1 + 5.4 * easeOutCubic(t)), 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = (1 - t) * 0.5;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1.5, r * 0.1);
        ctx.beginPath();
        ctx.arc(sx, sy, r * (0.9 + 3.4 * easeOutCubic(t)), 0, TAU);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = 1;
      return;
    }
    const armed = o.a === 1;
    const ht = (now - (bombHitT[i] || -1e9)) / BOMB_HIT_MS;
    const hitting = ht >= 0 && ht < 1;
    if (armed) {
      // faint warm halo under the bomb
      const pulse = 0.5 + 0.5 * Math.sin(now / 300 + i * 1.9);
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(glowGold, sx, sy, r * 1.9, 0.1 + 0.07 * pulse);
      ctx.globalCompositeOperation = 'source-over';
    }
    let kw = 1;
    let kh = 1;
    if (hitting) {
      const e = Math.sin(ht * Math.PI) * (1 - ht);
      kw = 1 + 0.14 * e;
      kh = 1 - 0.14 * e;
    }
    const bs = getBombSprite(r);
    const bw = bs.cs * kw;
    const bh = bs.cs * kh;
    ctx.globalAlpha = armed ? 1 : 0.6;
    ctx.drawImage(bs, sx - bw / 2, sy - bh / 2, bw, bh);
    const tx = sx + r * FUSE_X * kw;
    const ty = sy + r * FUSE_Y * kh;
    if (armed) {
      // burning fuse tip: flickering glow, hot core and two jittering sparks
      const fl = 0.65 + 0.35 * Math.sin(now * 0.05 + i * 2.3) * Math.sin(now * 0.071 + i);
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(glowGold, tx, ty, r * (0.42 + 0.16 * fl), 0.55 + 0.4 * fl);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#fff4d6';
      ctx.beginPath();
      ctx.arc(tx, ty, Math.max(1.5, r * 0.07 * (0.8 + 0.4 * fl)), 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#ffd27a';
      for (let q = 0; q < 2; q++) {
        const cyc = now * 0.0035 + q * 0.5 + i * 0.31;
        const ph = cyc - Math.floor(cyc);
        const ang = -1.57 + Math.sin(Math.floor(cyc) * 7.7 + q * 3.1 + i) * 1.4;
        const d = r * (0.1 + 0.38 * ph);
        ctx.globalAlpha = 0.9 * (1 - ph);
        ctx.beginPath();
        ctx.arc(tx + Math.cos(ang) * d, ty + Math.sin(ang) * d, Math.max(1, r * 0.04), 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#1d1812';
      ctx.beginPath();
      ctx.arc(tx, ty, Math.max(1.2, r * 0.06), 0, TAU);
      ctx.fill();
    }
    if (hitting) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.35 * (1 - ht);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(sx, sy, r * 0.95, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }

  // Two thin translucent bands across the whole screen at the puck's height, right
  // after a glitch jump.
  function drawGlitchTear(now) {
    const tt = now - glitchT;
    if (tt < 0 || tt >= GLITCH_TEAR_MS) return;
    const a = 0.28 * (1 - tt / GLITCH_TEAR_MS);
    const j = (((tt / 30) | 0) % 3) * 2;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    ctx.fillStyle = '#49f2ff';
    ctx.fillRect(0, glitchPy - 12 - j, screenW, 3);
    ctx.fillStyle = '#ff4bd8';
    ctx.fillRect(0, glitchPy + 9 + j, screenW, 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  function drawMineScorch(sx, sy, r, bt) {
    if (bt >= 0 && bt < MINE_SCORCH_S) {
      drawGlow(glowBlack, sx, sy, r * 2.4, 0.6 * (1 - bt / MINE_SCORCH_S));
      ctx.globalAlpha = 1;
    }
  }

  // bt: seconds since the blast.
  function drawMineBurst(sx, sy, r, bt) {
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
  }

  // Spinning rainbow item box. ord: its slot among the boxes in the snapshot.
  function drawBox(o, ord, sx, sy, r, now) {
    if (o.a !== 1) return;
    const inT = clamp((now - boxInT[ord < boxInT.length ? ord : 0]) / BOX_FADE_MS, 0, 1);
    const frames = getBoxFrames(Math.max(5, r));
    const fr = frames[((now / 120) | 0) % BOX_FRAMES];
    const spin = now / 540 + ord * 1.9;
    const w = 0.3 + 0.7 * Math.abs(Math.cos(spin));
    const pop = 0.55 + 0.45 * easeOutBack(inT);
    const bob = Math.sin(now / 430 + ord * 2.1) * r * 0.12;
    const pulse = 0.5 + 0.5 * Math.sin(now / 300 + ord);
    // Only the player on the far side can take a box: its halo and ring wear
    // that player's colour (a box in the host half is the guest's to take).
    const takerHost = !(o.y > H + G / 2);
    drawGlow(glowBlack, sx + r * 0.1, sy + r * 0.85, r * 1.15, 0.38 * inT);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(takerHost ? glowHost : glowGuest, sx, sy + bob, r * (2.6 + 0.3 * pulse), (0.5 + 0.2 * pulse) * inT);
    drawGlow(glowWhite, sx, sy + bob, r * (1.6 + 0.2 * pulse), (0.18 + 0.1 * pulse) * inT);
    ctx.globalAlpha = (0.35 + 0.25 * pulse) * inT;
    ctx.strokeStyle = takerHost ? HOST_COL : GUEST_COL;
    ctx.lineWidth = Math.max(1.5, r * 0.1);
    ctx.beginPath();
    ctx.arc(sx, sy + bob, r * 1.55, 0, TAU);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(sx, sy + bob);
    ctx.rotate(0.16 * Math.sin(now / 700 + ord));
    ctx.scale(w * pop, pop);
    ctx.globalAlpha = inT;
    const cs = fr.cs;
    ctx.drawImage(fr, -cs / 2, -cs / 2, cs, cs);
    ctx.restore();
    ctx.globalAlpha = 1;
    if (inT < 1) {
      // materialising ring
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (1 - inT) * 0.6;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1.5, r * 0.12);
      ctx.beginPath();
      ctx.arc(sx, sy, r * (1 + 1.4 * (1 - easeOutCubic(inT))), 0, TAU);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
  }

  // Goalie: a mini mallet in the owner's colour with a dark visor facing the opponent.
  function drawGoalie(o, sx, sy, R, now) {
    const a = o.a === 1 ? 1 : 0;
    const ht = (now - goalieHitT[a]) / GOALIE_HIT_MS;
    const hit = ht >= 0 && ht < 1 ? 1 - ht : 0;
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(a ? glowGuest : glowHost, sx, sy, R * (2.1 + 0.6 * hit), 0.35 + 0.5 * hit);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    drawSprite(a ? spr.guest : spr.host, sx, sy, (o.r / malletR) * (1 + 0.12 * hit * hit));
    // the visor sits on the side facing the other player's goal
    const down = (a === 0 ? -1 : 1) * (ky > 0 ? 1 : -1) > 0;
    const ang = down ? Math.PI / 2 : -Math.PI / 2;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.92;
    ctx.strokeStyle = '#0b1030';
    ctx.lineWidth = Math.max(2, R * 0.34);
    ctx.beginPath();
    ctx.arc(sx, sy, R * 0.6, ang - 0.85, ang + 0.85);
    ctx.stroke();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = '#a8dcff';
    ctx.lineWidth = Math.max(1, R * 0.08);
    ctx.beginPath();
    ctx.arc(sx, sy, R * 0.68, ang - 0.65, ang - 0.15);
    ctx.stroke();
    ctx.lineCap = 'butt';
    if (hit > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * hit;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(sx, sy, R * 0.95, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 0.9 * hit;
      ctx.strokeStyle = a ? GUEST_COL : HOST_COL;
      ctx.lineWidth = Math.max(2, R * 0.14);
      ctx.beginPath();
      ctx.arc(sx, sy, R * (1.05 + 0.9 * easeOutCubic(1 - hit)), 0, TAU);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }

  function drawObstacles(ob, now) {
    let boxOrd = 0;
    for (let i = 0; i < ob.length; i++) {
      const o = ob[i];
      const sx = sxw(o.x);
      const sy = syw(o.y);
      const r = o.r * scale;
      if (o.k === 'box') {
        if (!battle) continue;
        drawBox(o, boxOrd, sx, sy, r, now);
        boxOrd++;
      } else if (o.k === 'goalie') {
        if (!battle) continue;
        drawGoalie(o, sx, sy, r, now);
      } else if (o.k === 'bumper') {
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
      } else if (o.k === 'bomb') {
        drawBomb(o, i, sx, sy, r, now);
      } else {
        // mine
        const armed = o.a === 1;
        const bt = (now - (mineFlashT[i] || -1e9)) / 1000;
        // scorch mark left by the last blast
        drawMineScorch(sx, sy, r, bt);
        if (armed) {
          const pulse = 0.5 + 0.5 * Math.sin(now / 260 + o.x * 0.013);
          ctx.globalCompositeOperation = 'lighter';
          drawGlow(glowRed, sx, sy, r * (1.9 + 0.3 * pulse), 0.18 + 0.2 * pulse);
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
          drawSprite(getMineSprite(r), sx, sy, 1);
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
          // unarmed: dim
          ctx.globalAlpha = 0.62;
          drawSprite(getMineSprite(r), sx, sy, 1);
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
        drawMineBurst(sx, sy, r, bt);
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
    // A rocket hit lights the trail for a second: longer, fatter, orange to white.
    const rkAge = (now - rocketT) / ROCKET_TRAIL_MS;
    const rocket = rkAge >= 0 && rkAge < 1;
    const rkF = rocket ? 1 - rkAge * rkAge : 0;
    const life = (0.07 + 0.27 * k) * (1 + 0.6 * rkF);
    // Length is capped at about 9 puck radii so a fast puck never leaves a long streak.
    const maxLen = (9 + 4 * rkF) * puckR * scale * puckK;
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
    const wMax = puckR * scale * puckK * (0.5 + 0.4 * k) * (1 + 0.35 * rkF);
    const hot = speed > 1500;
    const am = 1 + 2.4 * rkF;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rocket ? '#ff6a2e' : hot ? '#ffb27a' : '#8fc4ff';
    ctx.globalAlpha = Math.min(1, (0.04 + 0.06 * k) * am);
    ribbon(m, wMax * 1.2, 1);
    ctx.fillStyle = rocket ? '#ffb347' : hot ? '#ffd9a8' : '#bfe3ff';
    ctx.globalAlpha = Math.min(1, (0.05 + 0.08 * k) * am);
    ribbon(Math.max(3, (m * 0.72) | 0), wMax, 0.7);
    ctx.fillStyle = rocket ? '#fff3d0' : '#ffffff';
    ctx.globalAlpha = Math.min(1, (0.06 + 0.12 * k) * am);
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
    const idx = i >> 1;
    // Battle: the radius follows snap.bt.mr (shrink) but is smoothed so it does not pop.
    const bt = battle ? curSnap.bt : null;
    const mrT = bt && bt.mr && bt.mr[idx] > 0 ? bt.mr[idx] : malletR;
    mrDraw[idx] += (mrT - mrDraw[idx]) * (1 - Math.exp(-dtNow * 12));
    if (Math.abs(mrT - mrDraw[idx]) < 0.01 * malletR) mrDraw[idx] = mrT;
    const R = mrDraw[idx] * scale;
    const mk = mrDraw[idx] === malletR ? 1 : mrDraw[idx] / malletR;
    const glowSpr = side === 'host' ? glowHost : glowGuest;
    const colr = side === 'host' ? HOST_COL : GUEST_COL;
    const rgb = side === 'host' ? HOST_RGB : GUEST_RGB;
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

    if (bt && bt.rk && bt.rk[idx]) drawRocketHalo(sx, sy, R, now);
    if (bt && bt.ca && bt.ca[idx]) drawCatchHalo(sx, sy, R, now);
    if (bt) {
      const gt = (now - giT[idx]) / GIANT_RING_MS;
      if (gt >= 0 && gt < 1) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = ITEM_COL.giant;
        for (let q = 0; q < 2; q++) {
          const t = gt - q * 0.25;
          if (t < 0) continue;
          ctx.globalAlpha = 0.85 * (1 - t) * (1 - t);
          ctx.lineWidth = Math.max(2, R * 0.12 * (1 - t));
          ctx.beginPath();
          ctx.arc(sx, sy, R * (1 + 0.9 * easeOutCubic(t)), 0, TAU);
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }
    }

    drawSprite(side === 'host' ? spr.host : spr.guest, sx, sy, mk);

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

  // --- battle drawing ------------------------------------------------------------

  // The puck is hidden from this player: a few flickering question marks and static
  // where it was when the ghost began.
  function drawGhostHint(now) {
    const cx = sxw(ghX);
    const cy = syw(ghY);
    const pr = puckR * scale * puckK;
    const q = (now / 110) | 0;
    ctx.font = font(Math.max(14, pr * 1.2), 800);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#d6e4ff';
    for (let k = 0; k < 3; k++) {
      const h1 = Math.sin(q * 12.9898 + k * 78.233) * 43758.5453;
      const h2 = Math.sin(q * 39.3468 + k * 11.135) * 24634.6345;
      const f1 = h1 - Math.floor(h1);
      const f2 = h2 - Math.floor(h2);
      ctx.globalAlpha = f1 > 0.3 ? 0.3 : 0.1;
      ctx.fillText('?', cx + (f1 - 0.5) * pr * 3.6, cy + (f2 - 0.5) * pr * 3.6);
    }
    ctx.fillStyle = '#ffffff';
    for (let k = 0; k < 8; k++) {
      const h1 = Math.sin(q * 5.123 + k * 31.7) * 43758.5453;
      const h2 = Math.sin(q * 9.771 + k * 17.3) * 24634.6345;
      const f1 = h1 - Math.floor(h1);
      const f2 = h2 - Math.floor(h2);
      ctx.globalAlpha = 0.3 * (f2 > 0.4 ? 1 : 0.4);
      ctx.fillRect(cx + (f1 - 0.5) * pr * 3.2, cy + (f2 - 0.5) * pr * 3.2, 2, 2);
    }
    ctx.globalAlpha = 1;
  }

  // Soft violet halo and outline on a puck the other player cannot see.
  function drawSpectral(sx, sy, pr, now) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 240);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(glowViolet, sx, sy, pr * (2.3 + 0.2 * pulse), 0.5);
    ctx.globalAlpha = 0.5 + 0.2 * pulse;
    ctx.strokeStyle = '#d8c4ff';
    ctx.lineWidth = Math.max(1.5, pr * 0.1);
    ctx.beginPath();
    ctx.arc(sx, sy, pr * (1.18 + 0.04 * pulse), 0, TAU);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Frost ring and ice crystals on the frozen puck.
  function drawFrost(sx, sy, pr, fk, now) {
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(glowIce, sx, sy, pr * 2.7, 0.5 * fk);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#d8f6ff';
    ctx.globalAlpha = 0.7 * fk;
    ctx.lineWidth = Math.max(1.5, pr * 0.09);
    ctx.beginPath();
    ctx.arc(sx, sy, pr * (1.18 + 0.14 * fk), 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.9 * fk;
    ctx.lineWidth = Math.max(1.8, pr * 0.13);
    ctx.beginPath();
    for (let k = 0; k < 9; k++) {
      const a = k * (TAU / 9) + 0.35;
      const r0 = pr * 1.12;
      const len = pr * (k & 1 ? 0.3 : 0.5) * fk;
      ctx.moveTo(sx + Math.cos(a) * r0, sy + Math.sin(a) * r0);
      ctx.lineTo(sx + Math.cos(a) * (r0 + len), sy + Math.sin(a) * (r0 + len));
    }
    ctx.stroke();
    // a twinkle that wanders round the ring
    const ta = now / 420;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (0.5 + 0.5 * Math.sin(now / 130)) * fk;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(sx + Math.cos(ta) * pr * 1.3, sy + Math.sin(ta) * pr * 1.3, Math.max(1.5, pr * 0.1), 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;
  }

  // Glowing bar across a goal mouth, one puck radius in from the rail.
  function drawShield(g, secs, now) {
    const idx = g.idx;
    const a = Math.min(1, secs / SHIELD_FADE_S) * clamp((now - shT[idx]) / 120, 0, 1);
    if (a <= 0.01) return;
    const y = g.top ? ry + puckR * scale : ry + rh - puckR * scale;
    const cx = sxw(g.x);
    const wpx = g.w * scale;
    const th = shTh;
    const col = idx === 0 ? HOST_COL : GUEST_COL;
    const pulse = 0.78 + 0.22 * Math.sin(now / 85 + idx * 2);
    const ht = (now - shHitT[idx]) / SHIELD_HIT_MS;
    const flash = ht >= 0 && ht < 1 ? 1 - ht : 0;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a * (0.5 * pulse + 0.45 * flash);
    ctx.drawImage(idx === 0 ? glowHost : glowGuest, cx - wpx * 0.62, y - th * 3.2, wpx * 1.24, th * 6.4);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = a * (0.6 + 0.3 * pulse);
    ctx.fillStyle = col;
    ctx.beginPath();
    rrPath(ctx, cx - wpx / 2, y - th / 2, wpx, th, th / 2, th / 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    // energy running along the bar
    ctx.globalAlpha = a * (0.5 + 0.4 * flash);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.5, th * 0.34);
    ctx.lineCap = 'round';
    ctx.setLineDash(shDash);
    ctx.lineDashOffset = -now / 28;
    ctx.beginPath();
    ctx.moveTo(cx - wpx / 2 + th * 0.5, y);
    ctx.lineTo(cx + wpx / 2 - th * 0.5, y);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    ctx.lineCap = 'butt';
    if (flash > 0) {
      ctx.globalAlpha = a * flash * 0.85;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      rrPath(ctx, cx - wpx / 2, y - th / 2, wpx, th, th / 2, th / 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Flame tongues and a hot glow round a mallet whose next hit is a rocket.
  function drawRocketHalo(sx, sy, R, now) {
    const f = 0.7 + 0.3 * Math.sin(now / 55) * Math.sin(now / 83);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(glowOrange, sx, sy, R * (2.3 + 0.3 * f), 0.7);
    drawGlow(glowGold, sx, sy, R * 1.6, 0.3);
    for (let pass = 0; pass < 2; pass++) {
      ctx.fillStyle = pass ? '#fff0b8' : '#ff9a3a';
      ctx.globalAlpha = pass ? 0.8 : 0.7;
      const k = pass ? 0.55 : 1;
      ctx.beginPath();
      for (let n = 0; n < 9; n++) {
        const a = n * (TAU / 9) + now / 700 * (pass ? -1 : 1);
        const len = R * k * (0.3 + 0.24 * (0.5 + 0.5 * Math.sin(now / 60 + n * 2.1 + pass)));
        const r0 = R * 0.94;
        ctx.moveTo(sx + Math.cos(a - 0.2) * r0, sy + Math.sin(a - 0.2) * r0);
        ctx.lineTo(sx + Math.cos(a) * (r0 + len), sy + Math.sin(a) * (r0 + len));
        ctx.lineTo(sx + Math.cos(a + 0.2) * r0, sy + Math.sin(a + 0.2) * r0);
      }
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Catch armed: green glow and a slowly turning dashed ring round the mallet.
  function drawCatchHalo(sx, sy, R, now) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 200);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(itemGlow('catch'), sx, sy, R * (2.2 + 0.25 * pulse), 0.65);
    drawGlow(glowGreen, sx, sy, R * 1.5, 0.25 + 0.15 * pulse);
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = ITEM_COL.catch;
    ctx.lineWidth = Math.max(2, R * 0.1);
    ctx.setLineDash(catchDash);
    ctx.lineDashOffset = -now / 40;
    ctx.beginPath();
    ctx.arc(sx, sy, R * (1.18 + 0.05 * pulse), 0, TAU);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Catch holding: a bright ring round the puck and an arc that shrinks as ct runs out.
  function drawCatchHold(sx, sy, pr, ct, now) {
    const f = clamp(ct / CATCH_HOLD_S, 0, 1);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(itemGlow('catch'), sx, sy, pr * 2.6, 0.55);
    ctx.globalAlpha = 0.6 + 0.3 * Math.sin(now / 70);
    ctx.strokeStyle = '#d6ffe4';
    ctx.lineWidth = Math.max(1.5, pr * 0.1);
    ctx.beginPath();
    ctx.arc(sx, sy, pr * 1.25, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = ITEM_COL.catch;
    ctx.lineWidth = Math.max(2.5, pr * 0.2);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(sx, sy, pr * 1.55, -Math.PI / 2, -Math.PI / 2 + TAU * f);
    ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Magnet: dashed pull line from the puck towards the target mouth.
  function drawMagnetPull(sx, sy, pr, t, now) {
    const gxa = curSnap && curSnap.gx ? curSnap.gx : NO_RD;
    const tx = sxw(W / 2 + (gxa[t] || 0));
    const ty = syw(t === 0 ? bottomY : 0);
    const dx = tx - sx;
    const dy = ty - sy;
    const d = Math.hypot(dx, dy);
    if (d < pr * 1.5) return;
    const ux = dx / d;
    const uy = dy / d;
    const len = Math.min(d - pr * 1.3, pr * 6);
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(itemGlow('magnet'), sx, sy, pr * 2.4, 0.45 + 0.15 * Math.sin(now / 90));
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = ITEM_COL.magnet;
    ctx.lineWidth = Math.max(2, pr * 0.16);
    ctx.lineCap = 'round';
    ctx.setLineDash(magDash);
    ctx.lineDashOffset = -now / 25;
    ctx.beginPath();
    ctx.moveTo(sx + ux * pr * 1.3, sy + uy * pr * 1.3);
    ctx.lineTo(sx + ux * (pr * 1.3 + len), sy + uy * (pr * 1.3 + len));
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Decoys: on the target's screen exactly like the puck; on the user's screen faint and dashed.
  function drawDecoys(dk, bt, now) {
    const v = solo ? 0 : myIdx;
    const dc = bt.dc || NO_RD;
    const fooled = dc[v] > 0;
    const pr = puckR * scale * puckK;
    for (let i = 0; i < dk.length && i < 4; i++) {
      const d = dk[i];
      if (!d || !Number.isFinite(d[0]) || !Number.isFinite(d[1])) continue;
      if (d[1] < visTop - puckR * 3 || d[1] > visBot + puckR * 3) continue;
      if (fooled) {
        envPuck(d[0], d[1], puckK, 1);
      } else {
        const sx = sxw(d[0]);
        const sy = syw(d[1]);
        ctx.globalAlpha = 0.35;
        drawSprite(spr.puck, sx, sy, puckK);
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = ITEM_COL.decoys;
        ctx.lineWidth = Math.max(1.5, pr * 0.1);
        ctx.setLineDash(magDash);
        ctx.lineDashOffset = -now / 60;
        ctx.beginPath();
        ctx.arc(sx, sy, pr * 1.15, 0, TAU);
        ctx.stroke();
        ctx.setLineDash(NO_DASH);
        ctx.globalAlpha = 1;
      }
    }
  }

  // A bright vertical band sweeping across the screen as the mirror starts and ends.
  function drawMirrorShimmer(now) {
    let t = (now - mirOnT) / MIRROR_SHIMMER_MS;
    if (!(t >= 0 && t < 1)) t = (now - mirOffT) / MIRROR_SHIMMER_MS;
    if (!(t >= 0 && t < 1)) return;
    const bw = Math.max(40, screenW * 0.12);
    const e = easeOutCubic(t);
    const bx = -bw + (screenW + 2 * bw) * e;
    const a = Math.sin(Math.PI * t);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55 * a;
    ctx.drawImage(itemGlow('mirror'), bx - bw, -screenH * 0.1, bw * 2, screenH * 1.2);
    ctx.globalAlpha = 0.5 * a;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(bx - 1.5, 0, 3, screenH);
    ctx.globalAlpha = 0.25 * a;
    ctx.fillRect(bx - bw * 0.45, 0, 2, screenH);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Quake dust: a few puffs on the shaken player's half and round their mallet.
  function quakeDust(v, snap) {
    const y0 = v === 0 ? H + G : 0;
    fx.dust(W * (0.08 + 0.84 * Math.random()), y0 + H * (0.1 + 0.8 * Math.random()), 2);
    const m = snap.m;
    if (m) fx.dust(m[v * 2], m[v * 2 + 1], 1);
  }

  // The button of `idx` nearest (in x) to sxRef, or null when this screen has none.
  function findBtn(idx, sxRef) {
    let best = null;
    let bd = 1e12;
    for (let i = 0; i < btnN; i++) {
      const b = btns[i];
      if (b.idx !== idx) continue;
      const d = Math.abs(b.x - sxRef);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  // Opponent item pill, to the left of their score (guest score row in solo).
  function pillXY() {
    pillX = rx + rw - 66 * u - 58 * u;
    pillY = solo ? ry + 104 * u : ry + 86 * u;
  }

  // Where an item landing for `idx` ends up: its nearest corner button, else the pill.
  function flightTarget(idx, sxRef) {
    const b = findBtn(idx, sxRef);
    if (b) {
      tgtX = b.x;
      tgtY = b.y;
    } else {
      pillXY();
      tgtX = pillX;
      tgtY = pillY;
    }
  }

  function drawPill(idx, item, now) {
    pillXY();
    const w = 52 * u;
    const h = 30 * u;
    const col = idx === 0 ? HOST_COL : GUEST_COL;
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = '#050a1a';
    ctx.beginPath();
    rrPath(ctx, pillX - w / 2, pillY - h / 2, w, h, h / 2, h / 2);
    ctx.fill();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1.5, 2 * u);
    ctx.stroke();
    const gt = now - gotT[idx];
    if (item && gt >= 0 && spr.items && spr.items[item]) {
      const pop = gt < 300 ? easeOutBack(gt / 300) : 1;
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(itemGlow(item), pillX, pillY, h * 0.9, 0.35);
      if (gt < 700) {
        ctx.globalAlpha = (1 - gt / 700) * 0.8;
        ctx.strokeStyle = ITEM_COL[item];
        ctx.beginPath();
        ctx.arc(pillX, pillY, h * (0.5 + 0.5 * easeOutCubic(gt / 700)), 0, TAU);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      drawSprite(spr.items[item], pillX, pillY, ((h * 0.38) / ir) * pop);
    } else {
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1.2, 1.5 * u);
      ctx.setLineDash(DASH);
      ctx.beginPath();
      ctx.arc(pillX, pillY, h * 0.28, 0, TAU);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
    }
    ctx.globalAlpha = 1;
  }

  function drawButton(b, snap, now) {
    const idx = b.idx;
    const item = (snap.it && snap.it[idx]) || '';
    const gt = now - gotT[idx];
    const ut = now - useT[idx];
    let sc = 1;
    let wob = 0;
    const bp = uiNow.btnPress;
    if (bp && bp.side === b.side) {
      const age = now - bp.t;
      if (age >= 0 && age < BTN_PRESS_MS + BTN_BACK_MS) {
        sc = age < BTN_PRESS_MS ? 0.9 : 0.9 + 0.1 * easeOutBack((age - BTN_PRESS_MS) / BTN_BACK_MS);
      }
      if (!item && age >= 0 && age < 420) wob = Math.sin(age / 32) * Math.exp(-age / 130) * 0.26;
    }
    ctx.save();
    ctx.translate(b.x, b.y);
    if (b.rot) ctx.rotate(Math.PI);
    if (wob) ctx.rotate(wob);
    ctx.scale(sc, sc);
    ctx.globalAlpha = 1;
    drawSprite(spr.btn[b.side], 0, 0);
    if (item && gt >= 0 && spr.items[item]) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 260);
      ctx.globalCompositeOperation = 'lighter';
      drawGlow(itemGlow(item), 0, 0, br * (1.35 + 0.1 * pulse), 0.3 + 0.14 * pulse);
      if (gt < GOT_PULSE_MS) {
        const fade = 1 - gt / GOT_PULSE_MS;
        const ph = (gt / 500) % 1;
        ctx.strokeStyle = ITEM_COL[item];
        ctx.lineWidth = Math.max(2, br * 0.07);
        for (let q = 0; q < 2; q++) {
          const t = (ph + q * 0.5) % 1;
          ctx.globalAlpha = fade * (1 - t) * 0.9;
          ctx.beginPath();
          ctx.arc(0, 0, br * (1 + 0.45 * t), 0, TAU);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      const pop = gt < 320 ? easeOutBack(gt / 320) : 1;
      drawSprite(spr.items[item], 0, -br * 0.14, pop * (1 + 0.04 * pulse));
      ctx.font = font(Math.max(8, br * 0.26), 800);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.92 * pop;
      ctx.fillText(ITEM_LABEL[item], 0, br * 0.6);
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = 0.26;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1.5, br * 0.06);
      ctx.setLineDash(btnDash);
      ctx.beginPath();
      ctx.arc(0, 0, br * 0.7, 0, TAU);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
      ctx.globalAlpha = 1;
    }
    if (ut >= 0 && ut < 320) {
      const t = ut / 320;
      const uc = useItemId[idx] && ITEM_COL[useItemId[idx]] ? ITEM_COL[useItemId[idx]] : '#ffffff';
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (1 - t) * 0.45;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, br * 0.96, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.strokeStyle = uc;
      ctx.lineWidth = Math.max(2, br * 0.1 * (1 - t));
      ctx.beginPath();
      ctx.arc(0, 0, br * (1 + 0.6 * easeOutCubic(t)), 0, TAU);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function drawButtons(snap, now) {
    if (!spr || !spr.btn) return;
    for (let i = 0; i < btnN; i++) drawButton(btns[i], snap, now);
  }

  // Item icons in flight: a collected box's icon to the player's button (or the opponent pill),
  // and a used item's icon out of its button towards the middle, fading.
  function drawFlights(now) {
    if (!spr || !spr.items) return;
    for (let i = 0; i < FLY_N; i++) {
      const f = flights[i];
      if (!f.on) continue;
      const age = now - f.t0;
      const dur = f.kind === 2 ? STEAL_FLY_MS : f.kind ? USE_FLY_MS : BOX_FLY_MS;
      if (age >= dur) {
        f.on = false;
        continue;
      }
      if (age < 0) continue;
      const p = age / dur;
      const icon = spr.items[f.item];
      let x;
      let y;
      let k;
      let a;
      if (f.kind === 0) {
        const x0 = sxw(f.wx);
        const y0 = syw(f.wy);
        flightTarget(f.idx, x0);
        const e = p * p * (3 - 2 * p);
        x = x0 + (tgtX - x0) * e;
        y = y0 + (tgtY - y0) * e - Math.sin(Math.PI * p) * br * 0.7;
        k = 0.8 + 0.45 * Math.sin(Math.PI * p);
        a = p < 0.85 ? 1 : (1 - p) / 0.15;
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(itemGlow(f.item), x, y, ir * 2.2, 0.6 * a);
        ctx.globalCompositeOperation = 'source-over';
      } else if (f.kind === 2) {
        // ghost hand from the victim's button (or pill) to the thief's button, item in tow
        const sb = findBtn(f.src, rx + rw / 2);
        let x0;
        let y0;
        if (sb) {
          x0 = sb.x;
          y0 = sb.y;
        } else {
          pillXY();
          x0 = pillX;
          y0 = pillY;
        }
        flightTarget(f.idx, x0);
        const e = p * p * (3 - 2 * p);
        x = x0 + (tgtX - x0) * e + Math.sin(p * Math.PI * 3) * br * 0.25;
        y = y0 + (tgtY - y0) * e - Math.sin(Math.PI * p) * br * 1.1;
        a = p < 0.12 ? p / 0.12 : p < 0.85 ? 1 : (1 - p) / 0.15;
        k = 0.85 + 0.3 * Math.sin(Math.PI * p);
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(itemGlow('steal'), x, y, ir * 2.4, 0.55 * a);
        drawGlow(itemGlow(f.item), x + ir * 0.7, y + ir * 0.6, ir * 1.6, 0.5 * a);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = a;
        drawSprite(icon, x + ir * 0.7, y + ir * 0.6, k * 0.75);
        ctx.globalAlpha = a * 0.9;
        drawSprite(spr.items.steal, x, y, k);
        continue;
      } else {
        const b = findBtn(f.idx, f.left ? rx : rx + rw);
        if (!b) {
          f.on = false;
          continue;
        }
        const e = easeOutCubic(p);
        const cx = rx + rw / 2;
        const cy = syw(H + G / 2);
        x = b.x + (cx - b.x) * 0.6 * e;
        y = b.y + (cy - b.y) * 0.6 * e;
        k = 1 + 0.8 * e;
        a = 1 - p;
      }
      ctx.globalAlpha = a;
      drawSprite(icon, x, y, k);
    }
    ctx.globalAlpha = 1;
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
    // Battle: scores next to a corner button move toward the middle so the button clears them.
    const lift = battle ? btnShift : 0;
    if (solo) {
      drawScore(rx + padX, ry + rh - 104 * u - lift, false, sc[0], labels[0], 'host', 0, popT[0], now);
      drawScore(rx + rw - padX, ry + 104 * u + (players === 'pass' ? lift : 0), true, sc[1], labels[1], 'guest', 1, popT[1], now);
    } else {
      const mine = role === 'host' ? 0 : 1;
      const other = 1 - mine;
      drawScore(rx + padX, ry + rh - 104 * u - lift, false, sc[mine], labels[0], role, mine, popT[mine], now);
      drawScore(rx + rw - padX, ry + 86 * u, false, sc[other], labels[1], role === 'host' ? 'guest' : 'host', other, popT[other], now);
    }
    if (battle && !replayOn && spr && spr.items && (!solo || players === 'bot')) {
      const oi = solo ? 1 : 1 - myIdx;
      drawPill(oi, (snap.it && snap.it[oi]) || '', now);
    }
  }

  // Random mode: 'Random: <twist>  ·  first to N', rebuilt only when the twist name changes.
  function updateModeLabel(snap) {
    if (!tw || typeof tw.label !== 'function') return;
    let name = null;
    try {
      name = tw.label(snap);
    } catch (e) {
      twFail(e);
    }
    if (typeof name !== 'string' || !name) name = null;
    if (name === twName) return;
    twName = name;
    modeLabel = name ? `Random: ${name}  ·  first to ${target}` : `Random · first to ${target}`;
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
      let twWhy = null;
      if (tw && goalWhy && typeof tw.goalWhy === 'function') {
        try {
          twWhy = tw.goalWhy(goalWhy);
        } catch (e) {
          twFail(e);
        }
      }
      if (typeof twWhy === 'string' && twWhy) sub = twWhy;
      else if (goalWhy === 'bomb') {
        if (solo && players === 'bot') sub = mine ? 'Bot touched a bomb' : 'You touched a bomb';
        else sub = mine ? 'They touched a bomb' : 'You touched a bomb';
      } else if (solo && players === 'bot') sub = mine ? 'You scored' : 'Bot scored';
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

  // "Tap to skip", right-aligned in the bottom bar, fading in once the replay
  // has played for a moment (a tap before that is ignored by main.js).
  function drawSkipHint(bh, e, el) {
    const a = e * clamp((el - 0.45) / 0.4, 0, 1);
    if (a <= 0) return;
    const fs = clamp(rpBar * 0.3, 11, 15);
    const cy = screenH - bh / 2;
    ctx.globalAlpha = a * (0.55 + 0.25 * (0.5 + 0.5 * Math.sin(performance.now() / 420)));
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = font(fs, 700);
    ctx.fillStyle = '#ffffff';
    if ('letterSpacing' in ctx) ctx.letterSpacing = Math.round(fs * 0.14) + 'px';
    ctx.fillText('TAP TO SKIP', screenW - 18, cy + 0.5);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
  }

  function drawReplay(now, e, el) {
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
    drawSkipHint(bh, e, el);
    if (solo && players === 'pass') {
      ctx.save();
      ctx.translate(screenW, screenH);
      ctx.rotate(Math.PI);
      drawBadge(bh, e);
      drawSkipHint(bh, e, el);
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
   *   replay:      { t: 0..1, speed, el } | null. Instant replay of old snapshots: letterbox
   *                bars, REPLAY badge, progress line, vignette + grain, no HUD messages,
   *                and a 'tap to skip' hint once `el` (seconds played) passes ~0.5 s.
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
    dtNow = dt;
    uiNow = ui || NO_UI;
    const rp = uiNow.replay || null;
    if (!!rp !== replayOn) {
      replayOn = !!rp;
      // Entering or leaving a replay: drop stale message fades, trail and particles.
      outSnap = null;
      trCount = 0;
      fx.reset();
      if (battle) resetBattleFx();
      if (tw && typeof tw.reset === 'function') {
        try {
          tw.reset();
        } catch (e) {
          twFail(e);
        }
      }
    }
    if (rp) {
      rpT = clamp(Number(rp.t) || 0, 0, 1);
      rpSpeed = rp.speed > 0 ? rp.speed : 1;
      rpEl = Number(rp.el) || 0;
    }
    rpK = clamp(rpK + ((replayOn ? 1 : -1) * dt) / (BAR_MS / 1000), 0, 1);
    const rpE = rpK * rpK * (3 - 2 * rpK);
    const z = rpE > 0 ? 1 - (1 - rpZoom) * rpE : 1;
    const zx = rpE > 0 ? (screenW * (1 - z)) / 2 : 0;
    const zy = rpE > 0 ? (screenH * (1 - z)) / 2 : 0;
    // The twist layer cuts the guest's blackout hole where its own mallet is drawn.
    if (role === 'guest' && localMallet && Number.isFinite(localMallet.x) && Number.isFinite(localMallet.y)) {
      envLocalM.x = localMallet.x;
      envLocalM.y = localMallet.y;
      env.localM = envLocalM;
    } else env.localM = null;
    // A shallow copy of the snapshot we already processed (same p/m arrays) is not new.
    if (snap !== curSnap && !(curSnap && snap.p === curP && snap.m === curM)) newSnap(snap, now);
    fx.setRain(!replayOn && snap.ph === 'over' && (solo || snap.wn === role));
    fx.update(now);
    heldK.v += ((uiNow.held ? 1 : 0) - heldK.v) * (1 - Math.exp(-dt * 14));

    let shaking = fx.getShake(now, shk);
    // Battle: quake shakes the target's screen every frame; mirror flips it left to right.
    const btE = battle ? snap.bt || null : null;
    curBt = btE;
    const vIdx = solo ? 0 : myIdx; // the side this screen belongs to (solo: the human host)
    if (players === 'pass') {
      // Shared screen: no shake (it would move both halves); dust in each quaked half.
      if (btE && btE.qk && !replayOn && (btE.qk[0] > 0 || btE.qk[1] > 0) && now - quakeDustT > QUAKE_DUST_MS) {
        quakeDustT = now;
        if (btE.qk[0] > 0) quakeDust(0, snap);
        if (btE.qk[1] > 0) quakeDust(1, snap);
      }
    } else if (btE && btE.qk && btE.qk[vIdx] > 0 && !replayOn) {
      const qa = 6 * u * Math.min(1, btE.qk[vIdx] / 0.25);
      quakeSeed = (quakeSeed * 1103515245 + 12345) >>> 0;
      shk[0] += Math.sin(now * 0.11) * qa * 0.6 + ((quakeSeed & 1023) / 1023 - 0.5) * qa * 0.8;
      shk[1] += Math.cos(now * 0.137) * qa * 0.6 + (((quakeSeed >>> 10) & 1023) / 1023 - 0.5) * qa * 0.8;
      shaking = true;
      if (now - quakeDustT > QUAKE_DUST_MS) {
        quakeDustT = now;
        quakeDust(vIdx, snap);
      }
    }
    const mir = !!(btE && btE.mi && btE.mi[vIdx] > 0 && !replayOn && rpE <= 0);
    if (battle && mir !== mirWas) {
      if (mir) mirOnT = now;
      else mirOffT = now;
      mirWas = mir;
    }
    // Every transform below goes through mirror: x' = cw - x when the screen is flipped.
    const cw = canvas.width;
    const shx = Math.round(shk[0] * 2) / 2;
    const shy = Math.round(shk[1] * 2) / 2;

    // Background (cached) at pixel-exact scale.
    if (mir) ctx.setTransform(-1, 0, 0, 1, cw, 0);
    else ctx.setTransform(1, 0, 0, 1, 0, 0);
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
    if (mir) ctx.setTransform(-dpr * z, 0, 0, dpr * z, cw - (zx + shx * z) * dpr, (zy + shy * z) * dpr);
    else ctx.setTransform(dpr * z, 0, 0, dpr * z, (zx + shx * z) * dpr, (zy + shy * z) * dpr);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (random) updateModeLabel(snap);
    // Drawn puck radius follows snap.pr (tinypuck), smoothed so it does not pop.
    const prT = snap.pr > 0 ? snap.pr / puckR : 1;
    puckK += (prT - puckK) * (1 - Math.exp(-dt * 12));
    if (Math.abs(prT - puckK) < 0.005) puckK = prT;

    if (hasLetterbox) drawBokeh(now);
    const gxa = snap.gx || NO_RD;
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i];
      const tgw = (snap.gw && snap.gw[g.idx]) || goalW0;
      g.w += (tgw - g.w) * (1 - Math.exp(-dt * 9));
      // Moving mouths: smoothed faster than the width so the drawn mouth keeps up with physics.
      const tgx = W / 2 + (Number.isFinite(gxa[g.idx]) ? gxa[g.idx] : 0);
      g.x += (tgx - g.x) * (1 - Math.exp(-dt * 24));
      if (Math.abs(tgx - g.x) < 0.05) g.x = tgx;
      drawGoalSlot(g, now);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();

    const s = snap;
    for (let i = 0; i < goals.length; i++) drawGoalInside(goals[i], now);
    if (tw) twDraw('drawUnder', s, now);
    let twHide = false;
    if (tw && typeof tw.hidePuck === 'function') {
      try {
        twHide = !!tw.hidePuck(s);
      } catch (e) {
        twFail(e);
      }
    }

    // Puck position (extrapolated along its velocity).
    const px = s.p[0] + s.p[2] * puckExtrapolate;
    const py = s.p[1] + s.p[3] * puckExtrapolate;
    const pvx = s.p[2];
    const pvy = s.p[3];
    const speed = Math.hypot(pvx, pvy);
    const playing = s.ph === 'play';

    // Battle: ghost hides the puck from the targeted screen (solo: the human host); the
    // side that fired it sees the puck with a spectral outline instead.
    const bt = btE;
    const ghArr = bt && bt.gh ? bt.gh : NO_RD;
    const ghosted = ghArr[myIdx] > 0;
    const ghSeen = !ghosted && ghArr[1 - myIdx] > 0;
    if (ghosted && !ghWas) {
      ghX = px;
      ghY = py;
    }
    if (ghosted !== ghWas) trCount = 0; // no streak across the ghost
    ghWas = ghosted;

    if (s.ph === 'ready' && uiNow.calibrating) drawCalibration(now);

    // Random mode draws the HUD after the mallets and the blackout (see below).
    if (!tw) drawHud(s, now, dt);

    // Seam glow: the puck is about to cross to the other iPad.
    if (playing && !ghosted && !twHide) {
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
    if (battle) {
      if (bt && bt.sh) {
        for (let i = 0; i < goals.length; i++) {
          const sh = bt.sh[goals[i].idx];
          if (sh > 0) drawShield(goals[i], sh, now);
        }
      }
    }

    if (s.ph === 'countdown') drawServeHint(s, now);

    // Battle decoys (snap.dk) under the real puck.
    if (bt && s.dk && s.dk.length && spr) drawDecoys(s.dk, bt, now);

    // Trail, shadow, glow and puck.
    if (playing && !ghosted && !twHide) {
      pushTrail(px, py, now);
      drawTrail(px, py, speed, now);
    }
    {
      const sx = sxw(px);
      const sy = syw(py);
      const pr = puckR * scale * puckK;
      const pk = puckK;
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
      glitchPy = sy;
      if (ghosted) drawGhostHint(now);
      else if (!twHide) {
        ctx.globalAlpha = dim;
        drawSprite(spr.puckShadow, sx + shOx, sy + shOy, pk);
        const hitT = (now - fx.state.hitAt) / 1000;
        const gk = clamp((speed - 500) / 1800, 0, 1) * 0.35 + (hitT >= 0 && hitT < 0.22 ? 0.85 * Math.pow(1 - hitT / 0.22, 2) : 0);
        if (gk > 0.02 && playing) {
          ctx.globalCompositeOperation = 'lighter';
          drawGlow(glowWhite, sx, sy, pr * 2.8, Math.min(1, gk));
          ctx.globalCompositeOperation = 'source-over';
        }
        // Rocket flame hugging the puck for a moment after the hit.
        const rkAge = (now - rocketT) / ROCKET_TRAIL_MS;
        if (rkAge >= 0 && rkAge < 1) {
          ctx.globalCompositeOperation = 'lighter';
          drawGlow(glowOrange, sx, sy, pr * 3.4, 0.75 * (1 - rkAge));
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
        }
        if (ghSeen) drawSpectral(sx, sy, pr, now);
        // Glitch ghost at the old spot, fading with a growing cyan / magenta split.
        const gt = now - glitchT;
        if (gt >= 0 && gt < GLITCH_GHOST_MS) {
          const ge = gt / GLITCH_GHOST_MS;
          const gx = sxw(glitchFx);
          const gy = syw(glitchFy);
          const off = 3 + 6 * ge;
          ctx.globalAlpha = 0.45 * (1 - ge) * (1 - ge);
          drawSprite(spr.puck, gx, gy, pk);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.5 * (1 - ge);
          drawSprite(spr.puckCyan, gx - off, gy, pk);
          drawSprite(spr.puckMag, gx + off, gy, pk);
          ctx.globalCompositeOperation = 'source-over';
        }
        // Glitch warning: the puck jitters and splits into cyan / magenta ghosts.
        const gw = now - glitchWarnT;
        let jx = 0;
        let jy = 0;
        const warn = gw >= 0 && gw < GLITCH_WARN_MS;
        if (warn) {
          const q = (gw / 40) | 0;
          const h1 = Math.sin(q * 12.9898) * 43758.5453;
          const h2 = Math.sin(q * 78.233) * 12345.6789;
          jx = (h1 - Math.floor(h1) - 0.5) * 8;
          jy = (h2 - Math.floor(h2) - 0.5) * 8;
        }
        ctx.globalAlpha = dim;
        drawSprite(spr.puck, sx + jx, sy + jy, pk);
        if (warn) {
          // The split has to read from across a table: a quarter puck radius each way.
          const woff = Math.max(6, pr * 0.28);
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 0.55;
          drawSprite(spr.puckCyan, sx + jx - woff, sy + jy, pk);
          drawSprite(spr.puckMag, sx + jx + woff, sy + jy, pk);
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.globalAlpha = 1;
        // Magnet: magenta tint on the puck and a dashed pull towards the target mouth.
        if (bt && bt.mg && spr.puckMagnet) {
          const mt = bt.mg[0] > 0 ? 0 : bt.mg[1] > 0 ? 1 : -1;
          if (mt >= 0) {
            ctx.globalAlpha = 0.6 + 0.25 * Math.sin(now / 90);
            drawSprite(spr.puckMagnet, sx, sy, pk);
            ctx.globalAlpha = 1;
            drawMagnetPull(sx, sy, pr, mt, now);
          }
        }
        // Catch: the puck sits in front of the owner's mallet.
        if (bt && bt.ct) {
          const ct = bt.ct[0] > 0 ? bt.ct[0] : bt.ct[1] > 0 ? bt.ct[1] : 0;
          if (ct > 0) drawCatchHold(sx, sy, pr, ct, now);
        }
        // Frozen: pale blue tint, frost ring and crystals; a brief flash when it thaws.
        if (bt && bt.fz > 0) {
          const fk = easeOutCubic(clamp((now - fzT) / 200, 0, 1));
          ctx.globalAlpha = fk;
          drawSprite(spr.puckIce, sx, sy, pk);
          ctx.globalAlpha = 1;
          drawFrost(sx, sy, pr, fk, now);
        }
        const tt = (now - thawT) / THAW_MS;
        if (tt >= 0 && tt < 1) {
          ctx.globalCompositeOperation = 'lighter';
          drawGlow(glowIce, sx, sy, pr * (2 + 1.6 * tt), (1 - tt) * 0.8);
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
        }
      }
      predK += ((uiNow.predicted && !ghosted && !twHide ? 1 : 0) - predK) * (1 - Math.exp(-dt * 12));
      if (predK > 0.02) drawPredRing(sx, sy, pr, now);
    }
    if (tw) twDraw('drawPucks', s, now);

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

    if (tw) {
      // Random: blackout over the rink, then the scores on top so they stay readable.
      twDraw('drawDark', s, now);
      drawHud(s, now, dt);
      twDraw('drawHud', s, now);
    }

    if (battle) {
      if (!replayOn) drawButtons(s, now);
      drawFlights(now);
    }

    if (!replayOn) drawMessages(s, now, false);
    fx.draw(ctx, map, now);

    if (!replayOn) {
      drawModeLabel(now);
      drawMessages(s, now, true);
      // The layer decides when its twist card shows (ready / countdown plus a fade-out).
      if (tw) twDraw('announce', s, now);
    }

    ctx.restore();

    drawGlitchTear(now);

    if (mir) ctx.setTransform(-dpr * z, 0, 0, dpr * z, cw - zx * dpr, zy * dpr);
    else ctx.setTransform(dpr * z, 0, 0, dpr * z, zx * dpr, zy * dpr);
    drawLatency();
    if (uiNow.diag) drawDiag(uiNow.diag);
    if (battle && !replayOn) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawMirrorShimmer(now);
    }

    if (rpE > 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawReplay(now, rpE, replayOn ? rpEl : 0);
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

  if (random) {
    try {
      tw = createTwistLayer(env);
    } catch (e) {
      tw = null;
      twFail(e);
    }
  }

  const onResize = () => resize();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  resize();

  function destroy() {
    destroyed = true;
    freeBattleSprites(); // item, button and box sprites, before spr is dropped
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
      free(spr.puckCyan);
      free(spr.puckMag);
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
    for (const cv of bombSprites.values()) free(cv);
    bombSprites.clear();
    free(glowWhite);
    free(glowHost);
    free(glowGuest);
    free(glowGold);
    free(glowRed);
    free(glowGreen);
    free(glowBlack);
    free(glowOrange);
    free(glowViolet);
    free(glowIce);
    for (const k in itemGlows) free(itemGlows[k]);
    resetBattleFx();
    if (tw && typeof tw.reset === 'function') {
      try {
        tw.reset();
      } catch (e) {
        twFail(e);
      }
    }
    tw = null;
    free(scratchCv);
    scratchCv = null;
    free(vignette);
    free(grain);
    vignette = null;
    grain = null;
    grainPat = null;
    fx.reset();
  }

  /**
   * Battle only (null in other modes): the side whose corner button contains the screen point
   * (CSS px, same space as the pointer events). The hit radius is 1.3 x the drawn radius.
   */
  function buttonAt(sx, sy) {
    if (!battle) return null;
    const hr = br * 1.3;
    for (let i = 0; i < btnN; i++) {
      const b = btns[i];
      const dx = sx - b.x;
      const dy = sy - b.y;
      if (dx * dx + dy * dy <= hr * hr) return b.side;
    }
    return null;
  }

  /** Drawn radius of a corner button in CSS px. */
  function itemRadius() {
    return br;
  }

  return { render, screenToWorld, worldToScreen, resize, setLatency, destroy, buttonAt, itemRadius };
}
