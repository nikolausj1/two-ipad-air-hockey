// Random mode: the drawing layer for the eight twists.
//
// view.js creates this layer when cfg.mode === 'random' and calls its hooks at
// fixed points of render() (see the hook list on createTwistLayer). The layer
// only reads the snapshot fields `tw` (twist id), `tx` (twist data), `p`, `p2`,
// `m`, `gx`, `gw`, `pr` and `ph`, and draws in CSS px through env.sxw / env.syw,
// so it works on every screen (host, guest, solo) with the same code.
//
// Every hook is defensive: a snapshot without `tw` draws nothing. env's live
// layout fields (rx, ry, rw, rh, scale, u, kx, ky, ...) change on resize, so
// they are read at call time and never cached across frames. Nothing allocates
// per frame: particles and trails live in preallocated typed arrays, gradients
// are built once at unit size and placed with translate/scale, and text widths
// are cached per label and size.

const TAU = Math.PI * 2;
const NO_DASH = [];
const EMPTY = {};

const TWIST_INFO = {
  twinpuck: { name: 'Twin Puck', rule: 'Two pucks in play. Score with either.' },
  movinggoals: { name: 'Moving Goals', rule: 'The goals slide from side to side. Aim for where they will be.' },
  gravity: { name: 'Gravity Well', rule: 'The centre pulls the puck in. Slow pucks get swallowed and spat back out.' },
  blackout: { name: 'Blackout', rule: 'Lights out. The puck is the lantern.' },
  wind: { name: 'Wind', rule: 'A wind pushes the puck. It turns every 8 seconds.' },
  hotpotato: { name: 'Hot Potato', rule: 'The puck has a fuse. If it blows in your half, they score.' },
  shrinking: { name: 'Shrinking Rink', rule: 'The rails creep inward during a rally. A goal resets them.' },
  turbo: { name: 'Turbo', rule: 'Every hit makes the puck 10 percent faster until someone scores.' },
};

const HOST_FALLBACK = '#ff7a45';
const GUEST_FALLBACK = '#4fd1ff';
const VIOLET = '#c8a8ff';
const VIOLET_DEEP = '#8f6bff';
const FUSE_RED = '#ff3b30';
const HAZARD_YELLOW = '#ffcc1a';
const HAZARD_BLACK = '#0b0b0b';
const RAIL_COL = '#fff1b0';
const BAND_COL = '#02040a';

const WELL_K = 2.2; // well visual radius in mallet radii
const SWALLOW_S = 0.7; // sim: seconds a swallowed puck stays in the well
const SPIRAL_MS = 480; // the swallowed puck spirals in over this long
const DARK_IN_MS = 400; // blackout fades in when play starts
const DARK_OUT_MS = 300; // and out when play / goal ends
const SPIT_MS = 360;
const WIND_TURN_MS = 400;
const WIND_N = 24;
const TRAIL_N = 12;
const ANN_IN_MS = 300;
const ANN_OUT_MS = 200;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
const num = (v, d) => (typeof v === 'number' && v === v ? v : d);

function makeTrail(n) {
  return { n, x: new Float32Array(n), y: new Float32Array(n), t: new Float64Array(n), head: 0, count: 0, last: -1e9 };
}

function trailPush(tr, x, y, now, jump) {
  if (now - tr.last < 12) return;
  if (tr.count > 0) {
    const i = (tr.head - 1 + tr.n) % tr.n;
    const dx = x - tr.x[i];
    const dy = y - tr.y[i];
    if (dx * dx + dy * dy > jump * jump) tr.count = 0; // teleport (serve, restart)
  }
  tr.x[tr.head] = x;
  tr.y[tr.head] = y;
  tr.t[tr.head] = now;
  tr.head = (tr.head + 1) % tr.n;
  if (tr.count < tr.n) tr.count++;
  tr.last = now;
}

export function createTwistLayer(env) {
  // --- state ----------------------------------------------------------------------
  const txt = {};
  for (const k in TWIST_INFO) txt[k] = { nW: 0, nS: -1, rW: 0, rS: -1 };

  let curTw = null;
  let twT = -1e9; // when the twist last changed
  let grpOn = false; // phase in ready / countdown
  let grpT = -1e9;
  let annLeaveA = 0; // card alpha at the moment the phase left ready / countdown
  let lastSeq = -1; // guest: repeated shallow copies of one snapshot carry the same seq

  // Blackout covers the rink only in play / goal: fades in on play, out when it leaves.
  let darkOn = false;
  let darkT = -1e9;
  let darkLeaveA = 0; // overlay alpha at the moment it started fading out

  // Hot potato fuse, smoothed between snapshots.
  let fSnap = 0;
  let fmSnap = 0;
  let fT = -1e9;
  let blown = false;

  // Gravity well.
  let swEnd = -1e9; // when the swallowed puck leaves (local clock)
  let swStart = -1e9;
  let swFlashT = -1e9;
  let spitT = -1e9;
  let spitBy = 0;
  let wellTight = 1;

  // Moving goals: smoothed mouth velocity per side (world px/s) and the last sample.
  const gxV = [0, 0];
  const gxP = [0, 0];
  const gxS = [0, 0];
  let gxT = -1e9;

  // Wind: eased world angle and drifting streaks (world coordinates).
  let wFrom = 0;
  let wTo = 0;
  let wTurnT = -1e9;
  let wHave = false;
  let wFlashT = -1e9;
  let wLastNow = -1;
  let wSeeded = false;
  const wpX = new Float32Array(WIND_N);
  const wpY = new Float32Array(WIND_N);
  const wpL = new Float32Array(WIND_N);
  const wpS = new Float32Array(WIND_N);
  const wpA = new Float32Array(WIND_N);
  const wDir = [1, 0]; // scratch: eased world unit vector

  // Shrinking: drawn inset eases toward tx.in.
  let inD = 0;
  let inLastNow = -1;

  // Turbo: smoothed multiplier, cached label and colour (rebuilt only when k changes by 0.1).
  let kD = 1;
  let kLastNow = -1;
  let kKey = -1;
  let kLabel = 'TURBO x1.0';
  let kCol = '#ffffff';
  let kLabelW = 0;
  let kLabelS = -1;
  let hudA = 0;

  // Trails: the twin puck, and the turbo heat trail behind the real puck.
  const trTwin = makeTrail(TRAIL_N);
  const trHeat = makeTrail(TRAIL_N);

  // Unit gradients (built once per context and reused through translate/scale).
  let gradCtx = null;
  let gWell = null;
  let scCanvas = null;
  let scCtx = null;
  let gHole = null;
  let gHoleSoft = null;

  // --- helpers --------------------------------------------------------------------
  function twOf(snap) {
    return snap && typeof snap.tw === 'string' && TWIST_INFO[snap.tw] ? snap.tw : null;
  }
  function txOf(snap) {
    return (snap && snap.tx) || EMPTY;
  }
  function done(c) {
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.setLineDash(NO_DASH);
  }
  function scl() {
    return env.scale > 0 ? env.scale : Math.abs(env.kx) || 1;
  }
  function ui() {
    return env.u > 0 ? env.u : 1;
  }
  function sgnX() {
    return env.kx < 0 ? -1 : 1;
  }
  function sgnY() {
    return env.ky < 0 ? -1 : 1;
  }
  function puckRad(snap) {
    return num(snap && snap.pr, env.puckR || 10);
  }
  function ensureMainGrads(c) {
    if (gradCtx === c && gWell) return;
    gradCtx = c;
    gWell = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    gWell.addColorStop(0, 'rgba(0,0,0,0.97)');
    gWell.addColorStop(0.45, 'rgba(2,0,10,0.92)');
    gWell.addColorStop(0.75, 'rgba(12,4,34,0.55)');
    gWell.addColorStop(1, 'rgba(20,8,50,0)');
  }
  function ensureScratch(cv) {
    if (cv === scCanvas && scCtx) return scCtx;
    scCanvas = cv;
    scCtx = cv && cv.getContext ? cv.getContext('2d') : null;
    gHole = null;
    gHoleSoft = null;
    if (scCtx) {
      gHole = scCtx.createRadialGradient(0, 0, 0, 0, 0, 1);
      gHole.addColorStop(0, 'rgba(0,0,0,1)');
      gHole.addColorStop(0.3, 'rgba(0,0,0,0.97)');
      gHole.addColorStop(0.6, 'rgba(0,0,0,0.6)');
      gHole.addColorStop(1, 'rgba(0,0,0,0)');
      gHoleSoft = scCtx.createRadialGradient(0, 0, 0, 0, 0, 1);
      gHoleSoft.addColorStop(0, 'rgba(0,0,0,0.85)');
      gHoleSoft.addColorStop(0.5, 'rgba(0,0,0,0.45)');
      gHoleSoft.addColorStop(1, 'rgba(0,0,0,0)');
    }
    return scCtx;
  }
  function goalOnScreen(s) {
    // Host screen shows the host goal (side 0), guest the guest goal, solo both.
    return env.role === 'solo' || (s === 0 ? env.role === 'host' : env.role === 'guest');
  }
  function goalWidth(snap, s) {
    const gw = snap && snap.gw;
    const W = env.W || 1;
    return num(gw && gw[s], (env.cfg && env.cfg.goalW) || W * 0.36);
  }
  function goalOff(snap, s) {
    const gx = snap && snap.gx;
    return num(gx && gx[s], 0);
  }

  // --- snapshots and events ---------------------------------------------------------
  function onSnap(snap, now) {
    if (!snap) return;
    const tw = twOf(snap);
    if (tw !== curTw) {
      curTw = tw;
      twT = now;
      trTwin.count = 0;
      trHeat.count = 0;
      wHave = false;
      inD = 0;
      kD = 1;
    }
    const inGrp = snap.ph === 'ready' || snap.ph === 'countdown';
    if (inGrp !== grpOn) {
      if (!inGrp) annLeaveA = annInAlpha(now);
      grpOn = inGrp;
      grpT = now;
    }
    const dk = snap.ph === 'play' || snap.ph === 'goal';
    if (dk !== darkOn) {
      if (!dk) darkLeaveA = darkAlpha(now);
      darkOn = dk;
      darkT = now;
    }
    // Per-snapshot deltas below (fuse clock, well timers, goal velocity) only on a new seq.
    const seq = snap.seq;
    if (typeof seq === 'number') {
      if (seq === lastSeq) return;
      lastSeq = seq;
    }
    if (!tw) return;
    const tx = txOf(snap);
    if (tw === 'hotpotato') {
      fSnap = num(tx.f, 0);
      fmSnap = num(tx.fm, 0);
      fT = now;
      if (snap.ph !== 'play') blown = false;
      else if (blown && fmSnap > 0 && fSnap > fmSnap - 0.25) blown = false; // a fresh fuse
    } else if (tw === 'gravity') {
      const sw = num(tx.sw, 0);
      if (sw > 0) {
        if (now > swEnd) swStart = now - (SWALLOW_S - sw) * 1000; // swallow event missed
        swEnd = now + sw * 1000;
      } else if (now < swEnd) swEnd = now;
    } else if (tw === 'movinggoals') {
      const gx = snap.gx;
      if (gx && gx.length >= 2) {
        const dtS = (now - gxT) / 1000;
        if (dtS > 0.004 && dtS < 0.5) {
          const lim = (env.W || 1000) * 0.4;
          for (let s = 0; s < 2; s++) {
            const v = clamp((num(gx[s], 0) - gxP[s]) / dtS, -lim, lim);
            gxV[s] += (v - gxV[s]) * 0.45;
          }
        }
        gxP[0] = num(gx[0], 0);
        gxP[1] = num(gx[1], 0);
        gxS[0] = gxP[0];
        gxS[1] = gxP[1];
        gxT = now;
      }
    }
  }

  function onEvent(e, snap, now) {
    if (!e || !twOf(snap)) return;
    // fx.js owns the rings and shakes for clack, swallow, spit and potato; this layer
    // only keeps its own state (well flash, spiral, spit beam, blown fuse).
    switch (e.k) {
      case 'swallow':
        swFlashT = now;
        swStart = now;
        swEnd = now + SWALLOW_S * 1000;
        break;
      case 'spit':
        spitT = now;
        spitBy = e.by === 'guest' ? 1 : 0;
        swEnd = Math.min(swEnd, now);
        break;
      case 'potato':
        blown = true;
        break;
      case 'wind':
        wFlashT = now;
        break;
      default:
        break;
    }
  }

  // --- simple queries -----------------------------------------------------------------
  function label(snap) {
    const tw = twOf(snap);
    return tw ? TWIST_INFO[tw].name : null;
  }

  function hidePuck(snap) {
    return twOf(snap) === 'gravity' && num(txOf(snap).sw, 0) > 0;
  }

  function goalWhy(why) {
    return why === 'potato' ? 'Hot potato!' : null;
  }

  // --- wind easing ----------------------------------------------------------------------
  // Updates the eased world wind angle and writes its unit vector into wDir.
  function windEase(snap, now) {
    const w = txOf(snap).w;
    if (w && w.length >= 2) {
      const ax = num(w[0], 0);
      const ay = num(w[1], 0);
      if (ax !== 0 || ay !== 0) {
        const target = Math.atan2(ay, ax);
        if (!wHave) {
          wFrom = target;
          wTo = target;
          wTurnT = -1e9;
          wHave = true;
        } else if (Math.abs(target - wTo) > 1e-3) {
          wFrom = windAngle(now);
          wTo = target;
          wTurnT = now;
        }
      }
    }
    const a = windAngle(now);
    wDir[0] = Math.cos(a);
    wDir[1] = Math.sin(a);
    return wHave;
  }
  function windAngle(now) {
    let d = wTo - wFrom;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    const p = clamp((now - wTurnT) / WIND_TURN_MS, 0, 1);
    return wFrom + d * easeOutCubic(p);
  }
  function seedWind() {
    const W = env.W || 1000;
    const top = num(env.visTop, 0);
    const bot = num(env.visBot, env.bottom || 1000);
    for (let i = 0; i < WIND_N; i++) {
      wpX[i] = Math.random() * W;
      wpY[i] = top + Math.random() * (bot - top);
      wpL[i] = Math.random();
      wpS[i] = Math.random();
      wpA[i] = 0.4 + 0.6 * Math.random();
    }
    wSeeded = true;
  }

  // --- drawUnder ------------------------------------------------------------------------
  function drawUnder(snap, now) {
    const tw = twOf(snap);
    if (!tw) return;
    const c = env.ctx;
    if (!c) return;
    if (tw === 'gravity') drawWell(c, snap, now);
    else if (tw === 'wind') drawWindStreaks(c, snap, now);
    else if (tw === 'shrinking') drawShrink(c, snap, now);
    else if (tw === 'movinggoals') drawGoalCues(c, snap, now);
    done(c);
  }

  function drawWell(c, snap, now) {
    ensureMainGrads(c);
    const sc = scl();
    const W = env.W || 1000;
    const cxw = W / 2;
    const cyw = (env.bottom || 0) / 2;
    const cx = env.sxw(cxw);
    const cy = env.syw(cyw);
    const R = WELL_K * (env.malletR || 30) * sc;
    const sw = num(txOf(snap).sw, 0);
    const k = 1 - Math.exp(-0.016 * 9);
    wellTight += ((sw > 0 ? 0.68 : 1) - wellTight) * k;
    const fl = now - swFlashT < 600 ? Math.exp(-(now - swFlashT) / 180) : 0;

    // Dark disc.
    c.save();
    c.translate(cx, cy);
    c.scale(R * 1.15, R * 1.15);
    c.fillStyle = gWell;
    c.globalAlpha = 1;
    c.beginPath();
    c.arc(0, 0, 1, 0, TAU);
    c.fill();
    c.restore();

    // Accretion ring: three arcs, violet and white, slowly rotating.
    c.globalCompositeOperation = 'lighter';
    env.drawGlow('violet', cx, cy, R * 1.6, 0.18 + 0.5 * fl);
    const lw = Math.max(1.5, R * 0.055);
    c.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const rr = R * (0.5 + 0.13 * i) * wellTight * (1 - 0.15 * fl);
      const rot = now * (0.0011 - 0.0003 * i) + (i * TAU) / 3;
      const len = 1.1 + 0.5 * Math.sin(now * 0.0007 + i * 2.1);
      c.strokeStyle = i === 1 ? '#ffffff' : i === 0 ? VIOLET : VIOLET_DEEP;
      c.globalAlpha = (i === 1 ? 0.35 : 0.55) + 0.45 * fl;
      c.lineWidth = lw * (i === 1 ? 0.7 : 1);
      c.beginPath();
      c.arc(cx, cy, rr, rot, rot + len);
      c.stroke();
      c.beginPath();
      c.arc(cx, cy, rr, rot + Math.PI, rot + Math.PI + len * 0.6);
      c.stroke();
    }
    // Outer lens ring.
    c.lineWidth = Math.max(1, R * 0.02);
    c.strokeStyle = '#ffffff';
    c.globalAlpha = 0.09 + 0.25 * fl;
    c.beginPath();
    c.arc(cx, cy, R, 0, TAU);
    c.stroke();
    c.strokeStyle = VIOLET;
    c.globalAlpha = 0.06;
    c.beginPath();
    c.arc(cx, cy, R * 1.22, 0, TAU);
    c.stroke();

    // Spit: a short beam toward the spit direction.
    const st = now - spitT;
    if (st >= 0 && st < SPIT_MS) {
      const p = snap.p;
      let dx = 0;
      let dy = spitBy === 0 ? 1 : -1;
      if (p && p.length >= 4) {
        const sp = Math.hypot(p[2], p[3]);
        if (sp > 100) {
          dx = p[2] / sp;
          dy = p[3] / sp;
        }
      }
      const sdx = sgnX() * dx;
      const sdy = sgnY() * dy;
      const e = st / SPIT_MS;
      const a = 1 - e;
      const L = R * (1.2 + 2.2 * easeOutCubic(e));
      c.strokeStyle = VIOLET;
      c.lineWidth = Math.max(2, R * 0.22) * a;
      c.globalAlpha = 0.45 * a;
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + sdx * L, cy + sdy * L);
      c.stroke();
      c.strokeStyle = '#ffffff';
      c.lineWidth = Math.max(1, R * 0.08) * a;
      c.globalAlpha = 0.8 * a;
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + sdx * L * 0.85, cy + sdy * L * 0.85);
      c.stroke();
    }
    c.lineCap = 'butt';
  }

  function drawWindStreaks(c, snap, now) {
    const dt = wLastNow < 0 ? 0.016 : clamp((now - wLastNow) / 1000, 0, 0.05);
    wLastNow = now;
    if (!windEase(snap, now)) return;
    if (!wSeeded) seedWind();
    const W = env.W || 1000;
    const top = num(env.visTop, 0);
    const bot = num(env.visBot, env.bottom || 1000);
    const span = bot - top;
    if (span <= 0) return;
    const mR = env.malletR || 30;
    const dx = wDir[0];
    const dy = wDir[1];
    const playing = snap.ph === 'play';
    const spd = W * (playing ? 0.32 : 0.12);
    for (let i = 0; i < WIND_N; i++) {
      const v = spd * (0.6 + 0.8 * wpS[i]);
      let x = wpX[i] + dx * v * dt;
      let y = wpY[i] + dy * v * dt;
      if (x < 0) x += W;
      else if (x > W) x -= W;
      if (y < top) y += span;
      else if (y > bot) y -= span;
      wpX[i] = x;
      wpY[i] = y;
    }
    c.globalCompositeOperation = 'lighter';
    c.strokeStyle = '#d8ecff';
    c.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      c.lineWidth = pass === 0 ? Math.max(1, 1.5 * ui()) : Math.max(1, 2.5 * ui());
      c.globalAlpha = pass === 0 ? 0.14 : 0.06;
      c.beginPath();
      for (let i = 0; i < WIND_N; i++) {
        if ((wpA[i] > 0.7) !== (pass === 1)) continue;
        const len = mR * (1.4 + 2.4 * wpL[i]);
        const x0 = env.sxw(wpX[i]);
        const y0 = env.syw(wpY[i]);
        c.moveTo(x0, y0);
        c.lineTo(env.sxw(wpX[i] - dx * len), env.syw(wpY[i] - dy * len));
      }
      c.stroke();
    }
    c.lineCap = 'butt';
  }

  function drawShrink(c, snap, now) {
    const dt = inLastNow < 0 ? 0.016 : clamp((now - inLastNow) / 1000, 0, 0.1);
    inLastNow = now;
    const W = env.W || 1000;
    const target = clamp(num(txOf(snap).in, 0), 0, W * 0.5);
    inD += (target - inD) * (1 - Math.exp(-dt * 10));
    if (Math.abs(target - inD) < 0.05) inD = target;
    const sc = scl();
    if (inD * sc < 0.5) return;
    const ry = env.ry;
    const rh = env.rh;
    const u = ui();
    for (let side = 0; side < 2; side++) {
      const wOut = side === 0 ? 0 : W;
      const wIn = side === 0 ? inD : W - inD;
      const xo = env.sxw(wOut);
      const xe = env.sxw(wIn);
      const x0 = Math.min(xo, xe);
      const bw = Math.abs(xe - xo);
      c.globalAlpha = 0.85;
      c.fillStyle = BAND_COL;
      c.fillRect(x0, ry, bw, rh);
      // Hazard stripes along the inner edge, inside the band.
      const sw = Math.min(10, bw);
      const dirIn = xo < xe ? -1 : 1;
      const sx0 = dirIn < 0 ? xe - sw : xe;
      if (sw > 1) {
        c.save();
        c.beginPath();
        c.rect(sx0, ry, sw, rh);
        c.clip();
        c.globalAlpha = 0.9;
        c.fillStyle = HAZARD_YELLOW;
        c.fillRect(sx0, ry, sw, rh);
        c.fillStyle = HAZARD_BLACK;
        c.beginPath();
        const step = 14;
        for (let y = ry - step; y < ry + rh + sw + step; y += step) {
          c.moveTo(sx0, y);
          c.lineTo(sx0, y + 7);
          c.lineTo(sx0 + sw, y + 7 - sw);
          c.lineTo(sx0 + sw, y - sw);
          c.closePath();
        }
        c.fill();
        c.restore();
      }
      // Thin bright rail line on the edge.
      c.globalCompositeOperation = 'lighter';
      c.fillStyle = RAIL_COL;
      c.globalAlpha = 0.16;
      c.fillRect(xe - 4 * u, ry, 8 * u, rh);
      c.globalAlpha = 0.85;
      c.fillRect(xe - 1, ry, 2, rh);
      c.globalCompositeOperation = 'source-over';
    }
  }

  function drawGoalCues(c, snap, now) {
    const W = env.W || 1000;
    const mR = env.malletR || 30;
    const u = ui();
    const vmax = W * 0.2 * (TAU / 4);
    const age = clamp((now - gxT) / 1000, 0, 0.12);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = Math.max(2, 3 * u);
    for (let s = 0; s < 2; s++) {
      if (!goalOnScreen(s)) continue;
      const v = gxV[s];
      const a = clamp(Math.abs(v) / vmax, 0, 1);
      if (a < 0.05) continue;
      const off = gxT > 0 ? gxS[s] + v * age : goalOff(snap, s);
      const wx = W / 2 + off;
      const wy = s === 0 ? (env.bottom || 0) - 1.7 * mR : 1.7 * mR;
      const sx = env.sxw(wx);
      const sy = env.syw(wy);
      const dir = (v < 0 ? -1 : 1) * sgnX();
      const h = 7 * u;
      const gap = 11 * u;
      c.strokeStyle = s === 0 ? env.HOST_COL || HOST_FALLBACK : env.GUEST_COL || GUEST_FALLBACK;
      c.globalAlpha = 0.12 + 0.26 * a;
      c.beginPath();
      for (let j = 0; j < 2; j++) {
        const tipX = sx + dir * (gap * (j + 0.5) + 4 * u);
        c.moveTo(tipX - dir * h, sy - h);
        c.lineTo(tipX, sy);
        c.lineTo(tipX - dir * h, sy + h);
      }
      c.stroke();
    }
    c.lineCap = 'butt';
    c.lineJoin = 'miter';
  }

  // --- drawPucks --------------------------------------------------------------------------
  function drawPucks(snap, now) {
    const tw = twOf(snap);
    if (!tw) return;
    const c = env.ctx;
    if (!c) return;
    if (tw === 'twinpuck') drawTwin(c, snap, now);
    else if (tw === 'hotpotato') drawFuse(c, snap, now);
    else if (tw === 'turbo') drawTurboFlame(c, snap, now);
    else if (tw === 'gravity') drawSpiral(c, snap, now);
    done(c);
  }

  function drawTrail(c, tr, life, r0, colOuter, colInner, aMul, now) {
    if (tr.count < 2) return;
    c.globalCompositeOperation = 'lighter';
    for (let n = 1; n < tr.count; n++) {
      const i = (tr.head - 1 - n + tr.n * 2) % tr.n;
      const age = (now - tr.t[i]) / 1000;
      if (age > life) break;
      const f = 1 - age / life;
      const sx = env.sxw(tr.x[i]);
      const sy = env.syw(tr.y[i]);
      c.globalAlpha = 0.22 * f * aMul;
      c.fillStyle = colOuter;
      c.beginPath();
      c.arc(sx, sy, r0 * (0.35 + 0.65 * f), 0, TAU);
      c.fill();
      c.globalAlpha = 0.3 * f * aMul;
      c.fillStyle = colInner;
      c.beginPath();
      c.arc(sx, sy, r0 * 0.45 * f, 0, TAU);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  }

  function drawTwin(c, snap, now) {
    const p2 = snap.p2;
    if (!p2 || p2.length < 2) return;
    const x = num(p2[0], 0);
    const y = num(p2[1], 0);
    const pR = puckRad(snap);
    trailPush(trTwin, x, y, now, 6 * pR);
    const sp = p2.length >= 4 ? Math.hypot(num(p2[2], 0), num(p2[3], 0)) : 0;
    if (sp > 160 && snap.ph === 'play') {
      const k = clamp((sp - 160) / 2000, 0, 1);
      drawTrail(c, trTwin, 0.06 + 0.16 * k, pR * scl() * 0.9, '#8fc4ff', '#ffffff', 0.6 + 0.6 * k, now);
    }
    env.drawPuck(x, y, pR / (env.puckR || pR), 1);
  }

  function drawFuse(c, snap, now) {
    if (blown || hidePuck(snap)) return;
    const ph = snap.ph;
    if (ph !== 'play' && ph !== 'countdown') return;
    const p = snap.p;
    if (!p || p.length < 2 || !(fmSnap > 0)) return;
    const f = ph === 'play' ? Math.max(0, fSnap - (now - fT) / 1000) : fmSnap;
    const frac = clamp(f / fmSnap, 0, 1);
    const sx = env.sxw(num(p[0], 0));
    const sy = env.syw(num(p[1], 0));
    const pr = puckRad(snap) * scl();
    const R = pr * 1.7;
    const u = ui();
    const hz = f < 2 ? 2 + (2 - f) * 5 : 1.2;
    const pulse = 0.5 + 0.5 * Math.sin((now / 1000) * hz * TAU);
    // Last second: the puck glows red.
    if (f < 1 && ph === 'play') {
      c.globalCompositeOperation = 'lighter';
      env.drawGlow('red', sx, sy, pr * (3 + pulse), (1 - f) * (0.55 + 0.4 * pulse));
      c.globalCompositeOperation = 'source-over';
    }
    c.lineWidth = Math.max(2, pr * 0.22);
    c.strokeStyle = '#2a0606';
    c.globalAlpha = 0.45;
    c.beginPath();
    c.arc(sx, sy, R, 0, TAU);
    c.stroke();
    if (frac <= 0.001) return;
    const a0 = -Math.PI / 2;
    const a1 = a0 + frac * TAU;
    c.lineCap = 'round';
    c.strokeStyle = FUSE_RED;
    c.globalAlpha = 0.7 + 0.3 * pulse;
    c.beginPath();
    c.arc(sx, sy, R, a0, a1);
    c.stroke();
    c.globalCompositeOperation = 'lighter';
    c.lineWidth = Math.max(4, pr * 0.5);
    c.globalAlpha = 0.12 + 0.18 * pulse * (f < 2 ? 1 : 0.4);
    c.beginPath();
    c.arc(sx, sy, R, a0, a1);
    c.stroke();
    // Flame tick at the burning end.
    const ex = sx + Math.cos(a1) * R;
    const ey = sy + Math.sin(a1) * R;
    const fl = 0.8 + 0.2 * Math.sin(now * 0.05) + 0.1 * Math.sin(now * 0.031);
    env.drawGlow('orange', ex, ey, Math.max(6, pr * 0.9) * fl, 0.85);
    c.fillStyle = '#fff6d0';
    c.globalAlpha = 0.95;
    c.beginPath();
    c.arc(ex, ey, Math.max(1.5, 2 * u) * fl, 0, TAU);
    c.fill();
    c.lineCap = 'butt';
  }

  function drawTurboFlame(c, snap, now) {
    const p = snap.p;
    if (!p || p.length < 2) return;
    const k = num(txOf(snap).k, 1);
    const x = num(p[0], 0);
    const y = num(p[1], 0);
    const pR = puckRad(snap);
    trailPush(trHeat, x, y, now, 6 * pR);
    if (k <= 1.2 || snap.ph !== 'play') return;
    const s = clamp((k - 1.2) / 0.8, 0, 1);
    const pr = pR * scl();
    drawTrail(c, trHeat, 0.1 + 0.22 * s, pr * (1 + 0.5 * s), '#ff6a1a', '#ffd27a', 0.6 + 0.8 * s, now);
    const sx = env.sxw(x);
    const sy = env.syw(y);
    const fl = 0.9 + 0.1 * Math.sin(now * 0.043) + 0.06 * Math.sin(now * 0.071);
    c.globalCompositeOperation = 'lighter';
    env.drawGlow('orange', sx, sy, pr * (2.2 + 1.6 * s) * fl, 0.3 + 0.45 * s);
    if (s > 0.5) env.drawGlow('red', sx, sy, pr * (3 + 1.5 * s) * fl, 0.25 * (s - 0.5) * 2);
    c.globalCompositeOperation = 'source-over';
  }

  function drawSpiral(c, snap, now) {
    if (!hidePuck(snap)) return;
    const el = now - swStart;
    const q = clamp(el / SPIRAL_MS, 0, 1);
    if (q >= 1) return;
    const W = env.W || 1000;
    const rr = WELL_K * (env.malletR || 30) * 0.55 * (1 - q);
    const ang = q * 2.5 * TAU + now * 0.002;
    const wx = W / 2 + Math.cos(ang) * rr;
    const wy = (env.bottom || 0) / 2 + Math.sin(ang) * rr;
    const k = (puckRad(snap) / (env.puckR || 10)) * (1 - 0.85 * q);
    env.drawPuck(wx, wy, k, 1 - q * q);
    c.globalCompositeOperation = 'lighter';
    env.drawGlow('violet', env.sxw(wx), env.syw(wy), puckRad(snap) * scl() * 2 * (1 - q * 0.5), 0.5 * (1 - q));
  }

  // --- drawDark (blackout) ----------------------------------------------------------------
  function darkAlpha(now) {
    if (darkOn) return clamp((now - darkT) / DARK_IN_MS, 0, 1);
    return darkLeaveA * clamp(1 - (now - darkT) / DARK_OUT_MS, 0, 1);
  }

  function drawDark(snap, now) {
    if (twOf(snap) !== 'blackout') return;
    const c = env.ctx;
    if (!c || typeof env.scratch !== 'function') return;
    const da = darkAlpha(now);
    if (da <= 0.004) return; // ready / countdown: keep the seam ring and serve chevrons visible
    const rx = env.rx;
    const ry = env.ry;
    const rw = env.rw;
    const rh = env.rh;
    if (!(rw > 1 && rh > 1)) return;
    const w = Math.ceil(rw);
    const h = Math.ceil(rh);
    const cv = env.scratch(w, h);
    if (!cv) return;
    const s = ensureScratch(cv);
    if (!s || !gHole) return;
    const sc = scl();
    const mR = env.malletR || 30;

    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-over';
    s.globalAlpha = 1;
    s.clearRect(0, 0, w, h);
    s.fillStyle = '#000000';
    s.globalAlpha = 0.93;
    s.fillRect(0, 0, w, h);
    s.globalAlpha = 1;
    s.globalCompositeOperation = 'destination-out';
    // Draw in screen CSS px: shift by the rink origin.
    s.setTransform(1, 0, 0, 1, -rx, -ry);

    // The puck is the lantern (radius flickers by about 3 percent).
    const p = snap.p;
    let psx = 0;
    let psy = 0;
    let lit = false;
    if (p && p.length >= 2) {
      psx = env.sxw(num(p[0], 0));
      psy = env.syw(num(p[1], 0));
      lit = true;
      const flick = 1 + 0.03 * (0.6 * Math.sin(now * 0.0123) + 0.4 * Math.sin(now * 0.0371 + 1.3));
      holeAt(s, gHole, psx, psy, 3.5 * mR * sc * flick, 3.5 * mR * sc * flick, 1);
    }
    // Each mallet.
    const m = snap.m;
    if (m && m.length >= 4) {
      const r = 1.6 * mR * sc;
      // The guest draws its own mallet at the finger (env.localM), ahead of snap.m.
      const lm = env.localM;
      const mi = env.myIdx;
      for (let k = 0; k < 2; k++) {
        const wx = lm && k === mi ? lm.x : num(m[k * 2], 0);
        const wy = lm && k === mi ? lm.y : num(m[k * 2 + 1], 0);
        holeAt(s, gHole, env.sxw(wx), env.syw(wy), r, r, 0.9);
      }
    }
    // Each goal mouth, faintly.
    const W = env.W || 1000;
    for (let side = 0; side < 2; side++) {
      if (!goalOnScreen(side)) continue;
      const gx = env.sxw(W / 2 + goalOff(snap, side));
      const gy = env.syw(side === 0 ? env.bottom || 0 : 0);
      holeAt(s, gHoleSoft, gx, gy, (goalWidth(snap, side) / 2) * sc * 1.1, mR * sc * 0.9, 0.45);
    }
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = 'source-over';
    s.globalAlpha = 1;

    c.globalAlpha = da;
    c.globalCompositeOperation = 'source-over';
    c.save();
    c.beginPath();
    c.rect(rx, ry, rw, rh);
    c.clip();
    c.drawImage(cv, 0, 0, w, h, rx, ry, w, h);
    c.restore();
    c.globalAlpha = 1;
    // A warm core so the lantern reads as a flame.
    if (lit) {
      c.globalCompositeOperation = 'lighter';
      env.drawGlow('gold', psx, psy, mR * sc * 1.6, (0.16 + 0.03 * Math.sin(now * 0.017)) * da);
    }
    done(c);
  }

  function holeAt(s, g, x, y, rxp, ryp, a) {
    if (!(rxp > 0.5 && ryp > 0.5)) return;
    s.save();
    s.translate(x, y);
    s.scale(rxp, ryp);
    s.globalAlpha = a;
    s.fillStyle = g;
    s.beginPath();
    s.arc(0, 0, 1, 0, TAU);
    s.fill();
    s.restore();
  }

  // --- drawHud --------------------------------------------------------------------------
  function drawHud(snap, now) {
    const tw = twOf(snap);
    if (!tw) return;
    const c = env.ctx;
    if (!c) return;
    if (tw === 'wind') drawWindArrow(c, snap, now);
    else if (tw === 'turbo') drawTurboMeter(c, snap, now);
    done(c);
  }

  function drawWindArrow(c, snap, now) {
    if (!windEase(snap, now)) return;
    const u = ui();
    // Screen direction of the eased world vector.
    const ang = Math.atan2(sgnY() * wDir[1], sgnX() * wDir[0]);
    // Top left corner: the top right holds the opponent's score on every screen.
    const cx = env.rx + 52 * u;
    const cy = env.ry + 52 * u;
    const ft = now - wFlashT;
    const bump = ft >= 0 && ft < 500 ? Math.sin((ft / 500) * Math.PI) * 0.18 : 0;
    const r = 26 * u;
    c.globalAlpha = 0.5;
    c.fillStyle = '#050a1a';
    c.beginPath();
    c.arc(cx, cy, r, 0, TAU);
    c.fill();
    c.globalAlpha = 0.25 + bump;
    c.strokeStyle = '#d8ecff';
    c.lineWidth = Math.max(1, 1.5 * u);
    c.stroke();
    c.save();
    c.translate(cx, cy);
    c.rotate(ang);
    c.scale(1 + bump, 1 + bump);
    const L = 15 * u;
    c.globalAlpha = 0.95;
    c.strokeStyle = '#ffffff';
    c.lineWidth = Math.max(2, 3 * u);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(-L, 0);
    c.lineTo(L * 0.6, 0);
    c.stroke();
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.moveTo(L, 0);
    c.lineTo(L * 0.3, -7 * u);
    c.lineTo(L * 0.3, 7 * u);
    c.closePath();
    c.fill();
    c.restore();
    c.lineCap = 'butt';
    c.lineJoin = 'miter';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    env.plainText('WIND', cx, cy + r + 11 * u, Math.max(9, 11 * u), '#ffffff', 0.7, 800);
  }

  function drawTurboMeter(c, snap, now) {
    const dt = kLastNow < 0 ? 0.016 : clamp((now - kLastNow) / 1000, 0, 0.1);
    kLastNow = now;
    const show = snap.ph === 'play' || snap.ph === 'goal';
    hudA += ((show ? 1 : 0) - hudA) * (1 - Math.exp(-dt * 10));
    const k = clamp(num(txOf(snap).k, 1), 1, 2);
    kD += (k - kD) * (1 - Math.exp(-dt * 12));
    if (hudA < 0.02) return;
    const key = Math.round(k * 10);
    if (key !== kKey) {
      kKey = key;
      kLabel = 'TURBO x' + (key / 10).toFixed(1);
      kLabelS = -1;
      const t = clamp((key / 10 - 1) / 1, 0, 1);
      let g;
      let b;
      if (t < 0.5) {
        const q = t / 0.5;
        g = Math.round(255 - 105 * q);
        b = Math.round(255 - 215 * q);
      } else {
        const q = (t - 0.5) / 0.5;
        g = Math.round(150 - 90 * q);
        b = 40;
      }
      kCol = 'rgb(255,' + g + ',' + b + ')';
    }
    const u = ui();
    const cx = env.rx + env.rw / 2;
    const y = env.ry + 34 * u;
    const fs = Math.max(10, 13 * u);
    const bw = 150 * u;
    const bh = Math.max(4, 7 * u);
    const by = y + 15 * u;
    if (kLabelS !== Math.round(fs)) {
      c.font = env.font(fs, 900);
      kLabelW = c.measureText(kLabel).width;
      kLabelS = Math.round(fs);
    }
    const pw = Math.max(bw, kLabelW) + 28 * u;
    c.save();
    c.translate(cx, y + 7 * u);
    env.plate(pw, 46 * u, 0, 0.45 * hudA);
    c.restore();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    env.plainText(kLabel, cx, y, fs, kCol, 0.92 * hudA, 900);
    c.globalAlpha = 0.22 * hudA;
    c.fillStyle = '#ffffff';
    c.fillRect(cx - bw / 2, by - bh / 2, bw, bh);
    const fr = clamp((kD - 1) / 1, 0, 1);
    if (fr > 0.003) {
      c.globalAlpha = 0.95 * hudA;
      c.fillStyle = kCol;
      c.fillRect(cx - bw / 2, by - bh / 2, bw * fr, bh);
      c.globalCompositeOperation = 'lighter';
      env.drawGlow(fr > 0.5 ? 'red' : 'orange', cx - bw / 2 + bw * fr, by, 14 * u * (1 + fr), 0.5 * fr * hudA);
      c.globalCompositeOperation = 'source-over';
    }
  }

  // --- announce ---------------------------------------------------------------------------
  function annInAlpha(now) {
    const start = Math.max(twT, grpT);
    return easeOutCubic(clamp((now - start) / ANN_IN_MS, 0, 1));
  }

  function announce(snap, now) {
    const tw = twOf(snap);
    if (!tw) return;
    const c = env.ctx;
    if (!c) return;
    const inGrp = snap.ph === 'ready' || snap.ph === 'countdown';
    let a;
    if (inGrp && grpOn) a = annInAlpha(now);
    else if (inGrp) a = 1; // onSnap not seen yet
    else a = annLeaveA * (1 - clamp((now - grpT) / ANN_OUT_MS, 0, 1));
    if (a < 0.02) return;
    const info = TWIST_INFO[tw];
    const tc = txt[tw];
    const u = ui();
    const nS = 34 * u;
    const rS = Math.max(10, 16 * u);
    if (tc.nS !== Math.round(nS)) {
      c.font = env.font(nS, 900);
      tc.nW = c.measureText(info.name).width;
      tc.nS = Math.round(nS);
    }
    if (tc.rS !== Math.round(rS)) {
      c.font = env.font(rS, 700);
      tc.rW = c.measureText(info.rule).width;
      tc.rS = Math.round(rS);
    }
    const cw = Math.max(tc.nW, tc.rW) + 52 * u;
    const ch = 96 * u;
    const fit = clamp((env.rw - 24 * u) / cw, 0.4, 1);
    const cx = env.rx + env.rw / 2;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    if (env.role !== 'solo') {
      drawCard(c, info, cx, env.ry + 120 * u, false, fit, cw, ch, a, now);
    } else {
      // Between the mode label (just off the seam) and the centre message of each half.
      const mid = env.ry + env.rh / 2;
      const lo = 46 * u;
      const hi = env.rh * 0.12 - 40 * u;
      const k = Math.min(fit, clamp((hi - lo) / ch, 0.5, 1));
      const off = lo + (ch * k) / 2;
      if (env.players === 'pass') {
        drawCard(c, info, cx, mid + off, false, k, cw, ch, a, now);
        drawCard(c, info, cx, mid - off, true, k, cw, ch, a, now);
      } else {
        // Bot game: the top half is the bot's, free of messages; centre the card above the seam.
        drawCard(c, info, cx, mid - (lo + (ch * fit) / 2), false, fit, cw, ch, a, now);
      }
    }
    done(c);
  }

  function drawCard(c, info, x, y, rot, k, cw, ch, a, now) {
    const u = ui();
    const s = k * (0.94 + 0.06 * a);
    c.save();
    c.translate(x, y);
    if (rot) c.rotate(Math.PI);
    c.scale(s, s);
    env.plate(cw, ch, 0, 0.55 * a);
    // A violet accent bar on top.
    c.globalAlpha = (0.55 + 0.25 * Math.sin(now / 380)) * a;
    c.fillStyle = VIOLET;
    c.fillRect(-cw * 0.16, -ch / 2 + 9 * u, cw * 0.32, Math.max(2, 3 * u));
    c.globalAlpha = 1;
    env.glowText(info.name, 0, -11 * u, 34 * u, '#ffffff', a, 900, 'rgb(190,150,255)');
    env.plainText(info.rule, 0, 24 * u, Math.max(10, 16 * u), '#ffffff', 0.85 * a, 700);
    c.restore();
  }

  // --- reset ------------------------------------------------------------------------------
  function reset() {
    curTw = null;
    twT = -1e9;
    grpOn = false;
    grpT = -1e9;
    annLeaveA = 0;
    lastSeq = -1;
    darkOn = false;
    darkT = -1e9;
    darkLeaveA = 0;
    fSnap = 0;
    fmSnap = 0;
    fT = -1e9;
    blown = false;
    swEnd = -1e9;
    swStart = -1e9;
    swFlashT = -1e9;
    spitT = -1e9;
    wellTight = 1;
    gxV[0] = gxV[1] = 0;
    gxT = -1e9;
    wHave = false;
    wTurnT = -1e9;
    wFlashT = -1e9;
    wLastNow = -1;
    wSeeded = false;
    inD = 0;
    inLastNow = -1;
    kD = 1;
    kLastNow = -1;
    hudA = 0;
    trTwin.count = 0;
    trHeat.count = 0;
  }

  return { onSnap, onEvent, label, hidePuck, drawUnder, drawPucks, drawDark, drawHud, announce, goalWhy, reset };
}
