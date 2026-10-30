// Visual effects: particles, expanding rings, screen shake and goal flashes.
//
// Everything lives in WORLD coordinates. The view owns the world -> screen
// mapping and hands it to draw() as { X0, kx, Y0, ky, scale } so that
// screen x = X0 + kx * wx and screen y = Y0 + ky * wy (kx, ky may be negative
// when the guest iPad is rotated 180 degrees).
//
// Budget: at most MAX_PARTICLES live particles and MAX_RINGS rings, all pooled
// (no allocation while playing), no shadows, no gradients.

const MAX_PARTICLES = 400;
const MAX_RINGS = 20;
const SHAKE_MS = 250;
const TAU = Math.PI * 2;

const SPARK = 0; // short additive streak
const PUFF = 1; // soft circle that grows and fades
const CONFETTI = 2; // tumbling rectangle
const GLOW = 3; // additive dot

const SPARK_COLS = ['#fff6d6', '#ffe28a', '#ffffff', '#ffb36b'];
const PUFF_COLS = ['#cfe3ff', '#9fb8e8', '#e8f0ff'];
const MINE_COLS = ['#ff3b2e', '#ff7a1a', '#ffd23a', '#ffffff'];
const SMOKE_COLS = ['#3a2a2a', '#4a3b3b', '#2a2a33'];
const GOLD_COLS = ['#ffe28a', '#ffd23a', '#fff6d6', '#ffffff'];
const SIDE_COLS = {
  host: ['#ff7a45', '#ffb48f', '#ffd36b', '#ffffff', '#ff4d2e'],
  guest: ['#4fd1ff', '#a8ecff', '#7cffd4', '#ffffff', '#3b8bff'],
};
const BOTH_COLS = ['#ff7a45', '#4fd1ff', '#ffd36b', '#ffffff', '#7cffd4'];

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/**
 * opts: { W, H, G, puckR,
 *         visible(x, y, margin) -> bool   // is this world point on this screen?
 *         seamY: number | null            // world y of this screen's seam edge (host/guest views)
 *         seamDir: 1 | -1                 // direction pointing from the seam into this screen
 *         mySide: 'host' | 'guest' | null // null for the solo view }
 */
export function createFx(opts) {
  const { W, H, G, puckR } = opts;
  const bottomY = 2 * H + G;
  const visible = opts.visible || (() => true);
  const seamY = opts.seamY == null ? null : opts.seamY;
  const seamDir = opts.seamDir || 1;
  const mySide = opts.mySide || null;

  // --- pools ------------------------------------------------------------------
  const pool = new Array(MAX_PARTICLES);
  for (let i = 0; i < MAX_PARTICLES; i++) {
    pool[i] = { type: 0, x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1, size: 1, rot: 0, vr: 0, col: '#fff', drag: 0, grow: 0 };
  }
  let n = 0;

  const rings = new Array(MAX_RINGS);
  for (let i = 0; i < MAX_RINGS; i++) rings[i] = { x: 0, y: 0, r0: 0, r1: 0, t0: 0, dur: 1, col: '#fff', w: 2, a: 1 };
  let rn = 0;

  // Public, read by the view.
  const state = {
    goalFlash: { host: -1e9, guest: -1e9 }, // timestamp of the last goal scored ON that side
    hitAt: -1e9,
    hitS: 0,
  };

  let shakeAmp = 0;
  let shakeT0 = -1e9;
  let lastT = -1;
  let finaleUntil = 0;
  let nextFinale = 0;
  let finaleCols = BOTH_COLS;

  function spawn(type, x, y, vx, vy, life, size, col, drag) {
    let p;
    if (n < MAX_PARTICLES) p = pool[n++];
    else p = pool[(Math.random() * MAX_PARTICLES) | 0]; // full: recycle a random one
    p.type = type;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.age = 0;
    p.life = life;
    p.size = size;
    p.col = col;
    p.drag = drag;
    p.rot = 0;
    p.vr = 0;
    p.grow = 0;
    return p;
  }

  function addRing(x, y, r0, r1, dur, col, w, now, a) {
    let r;
    if (rn < MAX_RINGS) r = rings[rn++];
    else r = rings[0]; // recycle the oldest slot
    r.x = x;
    r.y = y;
    r.r0 = r0;
    r.r1 = r1;
    r.t0 = now;
    r.dur = dur * 1000;
    r.col = col;
    r.w = w;
    r.a = a;
  }

  function shake(amp, now) {
    const t = now - shakeT0;
    const remaining = t >= SHAKE_MS ? 0 : shakeAmp * (1 - t / SHAKE_MS) * (1 - t / SHAKE_MS);
    if (amp >= remaining) {
      shakeAmp = amp;
      shakeT0 = now;
    }
  }

  /** Writes the current shake offset (CSS px) into out[0], out[1]. Returns true while shaking. */
  function getShake(now, out) {
    const t = now - shakeT0;
    if (t >= SHAKE_MS || t < 0) {
      out[0] = 0;
      out[1] = 0;
      return false;
    }
    const k = 1 - t / SHAKE_MS;
    const a = shakeAmp * k * k;
    out[0] = Math.sin(t * 0.13 + 1.3) * a;
    out[1] = Math.cos(t * 0.17 + 0.4) * a;
    return true;
  }

  function sOf(ev) {
    const s = ev.s == null ? 0.6 : ev.s;
    return s < 0 ? 0 : s > 1 ? 1 : s;
  }

  // --- event bursts -------------------------------------------------------------

  function confettiBurst(x, y, dirAng, spread, count, cols, speedMax) {
    for (let i = 0; i < count; i++) {
      const a = dirAng + rnd(-spread, spread);
      const sp = rnd(speedMax * 0.25, speedMax);
      const p = spawn(CONFETTI, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rnd(0.9, 1.7), rnd(7, 13), pick(cols), 1.6);
      p.rot = rnd(0, TAU);
      p.vr = rnd(-9, 9);
    }
  }

  function sparkBurst(x, y, count, spMin, spMax, cols, lifeMin, lifeMax, drag) {
    for (let i = 0; i < count; i++) {
      const a = rnd(0, TAU);
      const sp = rnd(spMin, spMax);
      spawn(SPARK, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rnd(lifeMin, lifeMax), rnd(1.4, 2.8), pick(cols), drag);
    }
  }

  function finaleBurst(now) {
    const x = rnd(W * 0.12, W * 0.88);
    let y;
    if (seamY == null) y = rnd(H * 0.2, bottomY - H * 0.2);
    else y = seamY + seamDir * rnd(H * 0.15, H * 0.8);
    confettiBurst(x, y, rnd(0, TAU), Math.PI, 14, finaleCols, 520);
    sparkBurst(x, y, 8, 120, 520, SPARK_COLS, 0.3, 0.6, 2.5);
    addRing(x, y, 10, 150, 0.45, finaleCols[0], 4, now, 0.5);
  }

  function onEvent(ev, now, snap) {
    const k = ev.k;
    const x = ev.x == null ? W / 2 : ev.x;
    const y = ev.y == null ? bottomY / 2 : ev.y;
    const s = sOf(ev);

    switch (k) {
      case 'hit': {
        state.hitAt = now;
        state.hitS = s;
        if (!visible(x, y, 80)) return;
        const cnt = 4 + Math.round(s * 16);
        for (let i = 0; i < cnt; i++) {
          const a = rnd(0, TAU);
          const sp = rnd(120, 260 + 700 * s);
          spawn(SPARK, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rnd(0.18, 0.4) * (0.8 + s * 0.5), rnd(1.4, 2.6), pick(SPARK_COLS), 3.2);
        }
        addRing(x, y, puckR * 0.9, puckR * (1.7 + 1.2 * s), 0.18 + 0.1 * s, '#ffffff', 5, now, 0.45 + 0.5 * s);
        if (s > 0.6) shake(1.5 + ((s - 0.6) / 0.4) * 4.5, now);
        break;
      }
      case 'wall': {
        if (!visible(x, y, 80)) return;
        // Normal = away from the nearest boundary.
        let nx = 1;
        let ny = 0;
        let best = x;
        if (W - x < best) { best = W - x; nx = -1; ny = 0; }
        if (y < best) { best = y; nx = 0; ny = 1; }
        if (bottomY - y < best) { best = bottomY - y; nx = 0; ny = -1; }
        const base = Math.atan2(ny, nx);
        const cnt = 3 + Math.round(s * 5);
        for (let i = 0; i < cnt; i++) {
          const a = base + rnd(-1.1, 1.1);
          const sp = rnd(40, 180) * (0.5 + s);
          const p = spawn(PUFF, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rnd(0.25, 0.45), rnd(3, 6), pick(PUFF_COLS), 5);
          p.grow = rnd(14, 28);
        }
        for (let i = 0; i < 2; i++) {
          const a = base + rnd(-0.9, 0.9);
          const sp = rnd(160, 380) * (0.5 + s);
          spawn(SPARK, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rnd(0.12, 0.25), 1.4, '#ffffff', 4);
        }
        break;
      }
      case 'bumper': {
        if (!visible(x, y, 80)) return;
        sparkBurst(x, y, 10 + Math.round(s * 8), 160, 560, GOLD_COLS, 0.2, 0.45, 3);
        addRing(x, y, puckR * 1.2, puckR * 3.4, 0.32, '#ffd23a', 5, now, 0.8);
        shake(1.2 + s * 1.5, now);
        break;
      }
      case 'mine': {
        if (!visible(x, y, 140)) {
          shake(5, now);
          return;
        }
        for (let i = 0; i < 34; i++) {
          const a = rnd(0, TAU);
          const sp = rnd(120, 900);
          spawn(SPARK, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rnd(0.3, 0.75), rnd(2, 4), pick(MINE_COLS), 2.4);
        }
        for (let i = 0; i < 12; i++) {
          const a = rnd(0, TAU);
          const sp = rnd(30, 200);
          const p = spawn(PUFF, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rnd(0.6, 1.0), rnd(10, 18), pick(SMOKE_COLS), 2.5);
          p.grow = rnd(40, 90);
        }
        for (let i = 0; i < 8; i++) {
          const a = rnd(0, TAU);
          spawn(GLOW, x, y, Math.cos(a) * rnd(20, 120), Math.sin(a) * rnd(20, 120), rnd(0.25, 0.5), rnd(10, 20), '#ff9a3a', 3);
        }
        addRing(x, y, 8, puckR * 6, 0.5, '#ff7a1a', 8, now, 0.9);
        addRing(x, y, 4, puckR * 3.5, 0.3, '#ffffff', 4, now, 0.8);
        shake(7 + s * 2, now);
        break;
      }
      case 'goal': {
        const by = ev.by || (snap && snap.lg) || 'host';
        const conceded = by === 'host' ? 'guest' : 'host';
        state.goalFlash[conceded] = now;
        const cols = SIDE_COLS[by] || BOTH_COLS;
        const gy = by === 'host' ? 0 : bottomY; // the goal line that was crossed
        const inward = by === 'host' ? Math.PI / 2 : -Math.PI / 2; // into the rink from that goal
        const gx = Math.min(W * 0.8, Math.max(W * 0.2, x));
        if (visible(gx, gy, 20)) {
          confettiBurst(gx, gy, inward, 1.2, 60, cols, 950);
          sparkBurst(gx, gy, 30, 200, 900, cols, 0.35, 0.8, 2.2);
          addRing(gx, gy, 20, 280, 0.6, cols[0], 8, now, 0.9);
          addRing(gx, gy, 10, 170, 0.4, '#ffffff', 5, now, 0.8);
        } else if (seamY != null) {
          // The goal is on the other iPad: let the confetti spill in from the seam.
          const sy = seamY + seamDir * 6;
          const ang = seamDir > 0 ? Math.PI / 2 : -Math.PI / 2;
          confettiBurst(W / 2, sy, ang, 1.3, 36, cols, 800);
          sparkBurst(W / 2, sy, 14, 150, 600, cols, 0.3, 0.6, 2.2);
        }
        shake(9, now);
        break;
      }
      case 'serve': {
        if (!visible(x, y, 80)) return;
        addRing(x, y, puckR, puckR * 5, 0.38, '#ffffff', 3, now, 0.55);
        sparkBurst(x, y, 8, 80, 260, SPARK_COLS, 0.2, 0.4, 3);
        break;
      }
      case 'over': {
        const winner = (snap && snap.wn) || ev.by || null;
        finaleCols = winner ? SIDE_COLS[winner] : BOTH_COLS;
        const mine = !mySide || !winner || winner === mySide;
        const bursts = mine ? 6 : 3;
        for (let i = 0; i < bursts; i++) finaleBurst(now);
        finaleUntil = mine ? now + 2200 : now + 900;
        nextFinale = now + 220;
        shake(8, now);
        break;
      }
      default:
        break; // 'countdown' is drawn by the HUD from the snapshot timer
    }
  }

  // --- simulation ---------------------------------------------------------------

  function update(now) {
    const dt = lastT < 0 ? 0 : Math.min(0.05, Math.max(0, (now - lastT) / 1000));
    lastT = now;
    if (now < finaleUntil && now >= nextFinale) {
      finaleBurst(now);
      nextFinale = now + 200;
    }
    if (dt === 0) return;
    for (let i = n - 1; i >= 0; i--) {
      const p = pool[i];
      p.age += dt;
      if (p.age >= p.life) {
        // swap-remove
        n--;
        if (i !== n) {
          pool[i] = pool[n];
          pool[n] = p;
        }
        continue;
      }
      const f = Math.max(0, 1 - p.drag * dt);
      p.vx *= f;
      p.vy *= f;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
  }

  // --- drawing ------------------------------------------------------------------

  /** map: { X0, kx, Y0, ky, scale, dpr }. Draws rings and particles. */
  function draw(ctx, map, now) {
    const { X0, kx, Y0, ky, scale } = map;

    // Rings (additive).
    if (rn > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'butt';
      for (let i = rn - 1; i >= 0; i--) {
        const r = rings[i];
        const t = (now - r.t0) / r.dur;
        if (t >= 1) {
          rn--;
          if (i !== rn) {
            rings[i] = rings[rn];
            rings[rn] = r;
          }
          continue;
        }
        if (t < 0) continue;
        const e = 1 - (1 - t) * (1 - t);
        const rad = (r.r0 + (r.r1 - r.r0) * e) * scale;
        const sx = X0 + kx * r.x;
        const sy = Y0 + ky * r.y;
        ctx.globalAlpha = r.a * (1 - t) * (1 - t);
        ctx.strokeStyle = r.col;
        ctx.lineWidth = Math.max(1, r.w * (1 - t * 0.7) * scale * 1.2);
        ctx.beginPath();
        ctx.arc(sx, sy, rad, 0, TAU);
        ctx.stroke();
      }
    }

    // Pass 1: normal blending (puffs, confetti).
    ctx.globalCompositeOperation = 'source-over';
    let m = null;
    let lastFill = '';
    for (let i = 0; i < n; i++) {
      const p = pool[i];
      const t = p.age / p.life;
      if (p.type === PUFF) {
        const a = 0.5 * (1 - t) * (1 - t);
        if (a < 0.01) continue;
        ctx.globalAlpha = a;
        if (p.col !== lastFill) { ctx.fillStyle = p.col; lastFill = p.col; }
        ctx.beginPath();
        ctx.arc(X0 + kx * p.x, Y0 + ky * p.y, (p.size + p.grow * p.age) * scale, 0, TAU);
        ctx.fill();
      } else if (p.type === CONFETTI) {
        if (!m) m = ctx.getTransform();
        const a = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
        ctx.globalAlpha = a;
        if (p.col !== lastFill) { ctx.fillStyle = p.col; lastFill = p.col; }
        const c = Math.cos(p.rot);
        const s = Math.sin(p.rot);
        const flip = Math.cos(p.age * 9 + p.vr);
        const sx = X0 + kx * p.x;
        const sy = Y0 + ky * p.y;
        // final = base * [c, s, -s*flip, c*flip, sx, sy]
        const la = c, lb = s, lc = -s * flip, ld = c * flip;
        ctx.setTransform(
          m.a * la + m.c * lb,
          m.b * la + m.d * lb,
          m.a * lc + m.c * ld,
          m.b * lc + m.d * ld,
          m.a * sx + m.c * sy + m.e,
          m.b * sx + m.d * sy + m.f
        );
        const w = p.size * scale;
        ctx.fillRect(-w * 0.5, -w * 0.3, w, w * 0.6);
      }
    }
    if (m) ctx.setTransform(m);

    // Pass 2: additive (sparks, glow dots).
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    let lastStroke = '';
    for (let i = 0; i < n; i++) {
      const p = pool[i];
      const t = p.age / p.life;
      if (p.type === SPARK) {
        const a = 1 - t;
        ctx.globalAlpha = a * a + 0.05;
        if (p.col !== lastStroke) { ctx.strokeStyle = p.col; lastStroke = p.col; }
        ctx.lineWidth = Math.max(1, p.size * scale * (1 - t * 0.5));
        const sx = X0 + kx * p.x;
        const sy = Y0 + ky * p.y;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx - kx * p.vx * 0.035, sy - ky * p.vy * 0.035);
        ctx.stroke();
      } else if (p.type === GLOW) {
        const a = (1 - t) * (1 - t) * 0.6;
        ctx.globalAlpha = a;
        if (p.col !== lastFill) { ctx.fillStyle = p.col; lastFill = p.col; }
        ctx.beginPath();
        ctx.arc(X0 + kx * p.x, Y0 + ky * p.y, p.size * (1 - t * 0.5) * scale, 0, TAU);
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'butt';
  }

  function reset() {
    n = 0;
    rn = 0;
    finaleUntil = 0;
    shakeT0 = -1e9;
  }

  return {
    onEvent,
    update,
    draw,
    getShake,
    reset,
    state,
    get count() {
      return n;
    },
  };
}
