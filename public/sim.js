// Host-authoritative air hockey simulation.
//
// World coordinates: one continuous rink in CSS pixels of the HOST screen.
//   x: 0 .. W            (left .. right, as seen by the host)
//   y: 0 .. H            guest's half   (guest's goal at y = 0)
//   y: H .. H + G        the seam gap: the bezels between the two screens,
//                        where the puck travels but is invisible
//   y: H + G .. 2H + G   host's half    (host's goal at y = 2H + G)
//
// Only the host runs this. The guest sends its mallet position in world
// coordinates and renders whatever state the host streams back.
//
// No DOM dependencies: this module also runs under Node (tools/sim-smoke.mjs).

import { createBot } from './bot.js';

export const PHASE = {
  READY: 'ready',
  COUNTDOWN: 'countdown',
  PLAY: 'play',
  GOAL: 'goal',
  OVER: 'over',
};

export const MODES = ['classic', 'bumpers', 'ice', 'mines', 'bombs', 'glitch', 'battle'];

// Per-mode physics. fric = fraction of puck speed kept after one second of
// sliding, wall = rail restitution, mallet = mallet restitution, max = puck
// speed cap (px/s). Everything the pure helpers below (predictMalletHit,
// advancePuck) need lives here, keyed by cfg.mode.
export const MODE_PHYS = {
  classic: { fric: 0.8, wall: 0.92, mallet: 0.85, max: 2600 },
  bumpers: { fric: 0.8, wall: 0.92, mallet: 0.85, max: 2600 },
  mines: { fric: 0.8, wall: 0.92, mallet: 0.85, max: 2600 },
  bombs: { fric: 0.8, wall: 0.92, mallet: 0.85, max: 2600 },
  glitch: { fric: 0.8, wall: 0.92, mallet: 0.85, max: 2600 },
  battle: { fric: 0.8, wall: 0.92, mallet: 0.85, max: 2600 },
  ice: { fric: 0.95, wall: 1.0, mallet: 0.85, max: 3000 },
};

const BUMPER_RESTITUTION = 0.95;
const BUMPER_R_FACTOR = 0.6; // of malletR
const MINE_R_FACTOR = 0.45; // of malletR
const MINE_REARM_S = 4;
const MINE_BLAST_FACTOR = 0.92; // of max puck speed
// Bombs: rigid bodies the puck can knock around. A mallet touching an armed
// bomb detonates it and the other player scores.
const BOMB_R_FACTOR = 0.5; // of malletR
const BOMB_PUCK_MASS = 1;
const BOMB_MASS = 2.2;
const BOMB_PUCK_REST = 0.85; // puck vs bomb restitution
const BOMB_BOMB_REST = 0.7; // bomb vs bomb (equal masses)
const BOMB_WALL_REST = 0.6; // bomb vs rails (end rails are solid, no goal mouths)
const BOMB_FRIC = 0.12; // fraction of speed kept after one second of sliding
const BOMB_MAX = 1600; // px/s
const BOMB_STOP = 8; // px/s: slower than this snaps to rest
const BOMB_ARM_MARGIN = 12; // px beyond malletR + r a mallet must stay away to arm
const BOMB_SEAM_REST_S = 1; // at rest fully inside the seam gap this long = nudge
const BOMB_SEAM_NUDGE = 220; // px/s
const BOMB_PUCK_SPEED_REF = 1800; // approach speed for a full-strength bombhit event
// Glitch mode: the puck teleports a short way every few seconds.
const GLITCH_WARN_S = 0.35;
const GLITCH_GIVE_UP_S = 0.6;
const GLITCH_TRIES = 12;
const GLITCH_MIN_SPEED = 350; // px/s
// Battle mode: item boxes, one held item per player (see the battle section in createSim).
const BOX_R_FACTOR = 0.55; // of malletR
const BOX_RESPAWN_MIN_S = 6;
const BOX_RESPAWN_MAX_S = 8;
const BOX_FIRST_SPAWN_S = 1; // after the first serve of the match
const BOX_TRIES = 12;
const ITEMS = ['rocket', 'shield', 'ghost', 'shrink', 'freeze', 'mine'];
const OFFENSIVE_ITEMS = ['rocket', 'ghost', 'shrink', 'mine'];
const ROCKET_MULT = 1.6;
const ROCKET_MIN = 1800; // px/s
const ROCKET_MAX = 3900; // px/s, puck cap while the rocket flight timer runs
const ROCKET_FLIGHT_S = 1;
const SHIELD_S = 1;
const SHIELD_BOUNCE = 1.15;
const GHOST_S = 2;
const SHRINK_S = 4;
const SHRINK_FACTOR = 0.6; // of malletR
const FREEZE_S = 0.5;
const DROP_FUSE_S = 1;
const DROP_LIVE_S = 10;
const BOT_HOLD_MIN_S = 1;
const BOT_HOLD_MAX_S = 2.5;
const BOT_WAIT_S = 10; // shield / freeze: use anyway this long after the hold time
const MAX_MALLET_SPEED = 3200; // px/s
const SERVE_SPEED = 600;
const SUBSTEPS = 4;
const GOAL_PAUSE_S = 1.6;
const SERVE_COUNTDOWN_S = 1;
const EVENT_CAP = 16;

// Obstacle layouts in the HOST half, as fractions: [fx of W, fv of H] where fv
// is the distance from the seam towards the host's own goal. The guest half
// is the point reflection (W - x, bottom - y), so both players see the same
// layout from their own side of the table.
const BUMPER_LAYOUTS = {
  3: [[0.25, 0.34], [0.75, 0.34], [0.5, 0.62]],
  4: [[0.2, 0.3], [0.8, 0.3], [0.36, 0.6], [0.64, 0.6]],
  5: [[0.2, 0.3], [0.8, 0.3], [0.36, 0.6], [0.64, 0.6], [0.5, 0.44]],
};
const MINE_LAYOUTS = {
  2: [[0.25, 0.4], [0.75, 0.4]],
  3: [[0.22, 0.32], [0.78, 0.32], [0.5, 0.62]],
};
const BOMB_LAYOUT = [[0.24, 0.3], [0.76, 0.3], [0.5, 0.58]];
// Item box spots in the host half; the guest half is the point reflection.
const BOX_SPOTS = [[0.25, 0.35], [0.75, 0.35], [0.5, 0.55], [0.3, 0.72], [0.7, 0.72]];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Physics constants for a mode (classic when the mode is unknown). */
export function physOf(mode) {
  return MODE_PHYS[mode] || MODE_PHYS.classic;
}

// --- shared collision math (pure; used by the sim, predictMalletHit, advancePuck)

/** Friction for dt seconds, then the speed cap. Mutates p {x,y,vx,vy}. */
function frictionStep(p, phys, dt) {
  const k = Math.pow(phys.fric, dt);
  p.vx *= k;
  p.vy *= k;
  const speed = Math.hypot(p.vx, p.vy);
  if (speed > phys.max) {
    p.vx *= phys.max / speed;
    p.vy *= phys.max / speed;
  }
}

/** Rail bounces for the puck. g = {puckR, W, bottom}. `mouth(x, side)` says
 *  whether x is inside the goal mouth on side 'guest' (top) or 'host' (bottom).
 *  `onWall(vn)` is called with the impact speed of every rail bounce. Returns
 *  the side that was scored on ('guest' | 'host') when the puck fully entered
 *  a goal mouth, else null. */
function railBounce(p, g, phys, mouth, onWall) {
  const { puckR, W, bottom } = g;
  // Side rails.
  if (p.x < puckR) {
    p.x = puckR;
    if (p.vx < 0) onWall(-p.vx);
    p.vx = Math.abs(p.vx) * phys.wall;
  } else if (p.x > W - puckR) {
    p.x = W - puckR;
    if (p.vx > 0) onWall(p.vx);
    p.vx = -Math.abs(p.vx) * phys.wall;
  }
  // End rails and goals.
  if (p.y < puckR) {
    if (mouth(p.x, 'guest')) {
      if (p.y < -puckR) return 'guest';
    } else {
      p.y = puckR;
      if (p.vy < 0) onWall(-p.vy);
      p.vy = Math.abs(p.vy) * phys.wall;
    }
  } else if (p.y > bottom - puckR) {
    if (mouth(p.x, 'host')) {
      if (p.y > bottom + puckR) return 'host';
    } else {
      p.y = bottom - puckR;
      if (p.vy > 0) onWall(p.vy);
      p.vy = -Math.abs(p.vy) * phys.wall;
    }
  }
  return null;
}

const HIT = { vn: 0, nx: 0, ny: 0 }; // scratch result of malletHit (read immediately)

/** Puck vs mallet: push out, slide along rails if shoved through one, reflect
 *  the relative velocity along the normal (mallet has infinite mass) with the
 *  mode's mallet restitution, clamp to the mode's max speed. Mutates p
 *  {x,y,vx,vy}. Returns null when the circles do not overlap, otherwise the
 *  shared HIT scratch {vn, nx, ny} (vn < 0 means a velocity response was
 *  applied; vn is the pre-impact approach speed along the normal). */
function malletHit(p, m, role, g, phys, mouth) {
  const { puckR, malletR, W, bottom } = g;
  let dx = p.x - m.x;
  let dy = p.y - m.y;
  let dist = Math.hypot(dx, dy);
  const minDist = puckR + malletR;
  if (dist >= minDist) return null;
  let nx;
  let ny;
  if (dist < 1e-6) {
    nx = 0;
    ny = role === 'host' ? -1 : 1; // away from the mallet's own goal
    dist = 0;
  } else {
    nx = dx / dist;
    ny = dy / dist;
  }
  // Push the puck out of the mallet.
  p.x = m.x + nx * minDist;
  p.y = m.y + ny * minDist;
  // If that shoved the puck through a rail, slide it along the rail instead.
  dx = p.x - m.x;
  dy = p.y - m.y;
  const sgnY = dy >= 0 ? 1 : -1;
  const sgnX = dx >= 0 ? 1 : -1;
  if (p.x < puckR) {
    p.x = puckR;
    p.y = m.y + sgnY * Math.sqrt(Math.max(0, minDist * minDist - (p.x - m.x) ** 2));
  } else if (p.x > W - puckR) {
    p.x = W - puckR;
    p.y = m.y + sgnY * Math.sqrt(Math.max(0, minDist * minDist - (p.x - m.x) ** 2));
  }
  if (p.y < puckR && !mouth(p.x, 'guest')) {
    p.y = puckR;
    p.x = m.x + sgnX * Math.sqrt(Math.max(0, minDist * minDist - (p.y - m.y) ** 2));
  } else if (p.y > bottom - puckR && !mouth(p.x, 'host')) {
    p.y = bottom - puckR;
    p.x = m.x + sgnX * Math.sqrt(Math.max(0, minDist * minDist - (p.y - m.y) ** 2));
  }
  p.x = clamp(p.x, puckR, W - puckR);
  // Reflect the relative velocity along the normal.
  const rvx = p.vx - m.vx;
  const rvy = p.vy - m.vy;
  const vn = rvx * nx + rvy * ny;
  if (vn < 0) {
    p.vx -= (1 + phys.mallet) * vn * nx;
    p.vy -= (1 + phys.mallet) * vn * ny;
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > phys.max) {
      p.vx *= phys.max / sp;
      p.vy *= phys.max / sp;
    }
  }
  HIT.vn = vn;
  HIT.nx = nx;
  HIT.ny = ny;
  return HIT;
}

const mouthFor = (W, gw) => (x, side) => Math.abs(x - W / 2) < (side === 'guest' ? gw[1] : gw[0]) / 2;
const NO_MOUTH = () => false;

/**
 * Pure: would the local mallet touch the puck within `dtSeconds`?
 *   snap  snapshot object ({p:[x,y,vx,vy], g?, gw?}); only p (and optionally
 *         g = seam gap, gw = goal widths) are read
 *   cfg   {puckR, malletR, W, H, G, mode}
 *   role  'guest' | 'host' (only picks the push-out direction when the circles
 *         are exactly concentric)
 *   mallet {x, y, vx, vy} in world coordinates, at time 0; it is moved along
 *         its own velocity during the sweep, like the puck
 * Returns null when there is no contact; otherwise a NEW puck state
 * [x, y, vx, vy] right after the first contact, computed with the same
 * response the sim uses (push out, restitution, speed cap).
 */
export function predictMalletHit(snap, cfg, role, mallet, dtSeconds) {
  const sp = snap && snap.p;
  if (!sp || !mallet) return null;
  const phys = physOf(cfg.mode);
  const Gp = typeof snap.g === 'number' ? snap.g : cfg.G;
  const g = { puckR: cfg.puckR, malletR: cfg.malletR, W: cfg.W, bottom: 2 * cfg.H + Gp };
  const gw = snap.gw || [cfg.goalW, cfg.goalW];
  const mouth = cfg.goalW || snap.gw ? mouthFor(cfg.W, gw) : NO_MOUTH;
  const mvx = mallet.vx || 0;
  const mvy = mallet.vy || 0;
  const dt = Math.max(0, dtSeconds || 0);
  // Relative sweep distance decides how finely to sample (half a puck radius).
  const rel = Math.hypot(sp[2] - mvx, sp[3] - mvy) * dt;
  const steps = clamp(Math.ceil(rel / (cfg.puckR * 0.5)), 1, 24);
  const p = { x: 0, y: 0, vx: sp[2], vy: sp[3] };
  const m = { x: 0, y: 0, vx: mvx, vy: mvy };
  for (let i = 0; i <= steps; i++) {
    const t = (dt * i) / steps;
    p.x = sp[0] + sp[2] * t;
    p.y = sp[1] + sp[3] * t;
    m.x = mallet.x + mvx * t;
    m.y = mallet.y + mvy * t;
    if (malletHit(p, m, role, g, phys, mouth)) return [p.x, p.y, p.vx, p.vy];
  }
  return null;
}

/**
 * Pure: advance a puck [x, y, vx, vy] by `dtSeconds` with the mode's friction
 * and rail bounces (no goals, no mallets, no obstacles; the end rails are
 * solid). cfg needs {puckR, W, H, G, mode}. Returns a NEW [x, y, vx, vy]. Uses
 * the same per-step code as the sim, in sub-steps of at most 1/240 s.
 */
export function advancePuck(pArr, cfg, dtSeconds) {
  const phys = physOf(cfg.mode);
  const g = { puckR: cfg.puckR, W: cfg.W, bottom: 2 * cfg.H + cfg.G };
  const p = { x: pArr[0], y: pArr[1], vx: pArr[2], vy: pArr[3] };
  const dt = dtSeconds > 0 ? dtSeconds : 0;
  const n = clamp(Math.ceil(dt * 240 - 1e-9), 1, 1200);
  const h = dt / n;
  const noop = () => {};
  if (dt > 0) {
    for (let i = 0; i < n; i++) {
      frictionStep(p, phys, h);
      p.x += p.vx * h;
      p.y += p.vy * h;
      railBounce(p, g, phys, NO_MOUTH, noop);
    }
  }
  return [p.x, p.y, p.vx, p.vy];
}

/** Events of a snapshot, same call for host and guest renderers. */
export function eventsOf(snap) {
  return (snap && snap.ev) || [];
}

export function createSim(cfg, opts = {}) {
  // Defaults for the optional fields (mutating cfg so it is sent to the guest
  // with the defaults filled in).
  if (!MODES.includes(cfg.mode)) cfg.mode = 'classic';
  if (typeof cfg.comeback !== 'boolean') cfg.comeback = true;
  if (!['duo', 'bot', 'pass'].includes(cfg.players)) cfg.players = 'duo';
  if (!['easy', 'medium', 'hard', 'impossible'].includes(cfg.botLevel)) cfg.botLevel = 'medium';
  if (!(cfg.target >= 1)) cfg.target = 7;

  const { W, H, puckR, malletR, goalW, target, mode } = cfg;
  let G = cfg.G; // seam gap; adjustable through setGap() while phase is 'ready'
  const rng = opts.rng || Math.random;
  const phys = MODE_PHYS[mode];
  const battleMode = mode === 'battle';
  const physRocket = { ...phys, max: ROCKET_MAX }; // puck cap while a rocket flies
  const MAX_PUCK_SPEED = phys.max;
  const seamTop = H; // where the guest half ends
  let seamBottom = H + G; // where the host half starts
  let bottom = 2 * H + G;
  const geom = { puckR, malletR, W, bottom }; // shared-helper geometry; bottom follows setGap()
  // Per-side geometry for mallet hits: in battle mode a shrunk mallet has its
  // own radius, so host and guest each get their own object.
  const sideGeom = battleMode ? { host: { ...geom }, guest: { ...geom } } : { host: geom, guest: geom };

  const state = {
    phase: PHASE.READY,
    ready: { host: false, guest: cfg.players === 'bot' }, // the bot is always ready
    timer: 3,
    stage: 0, // 1 during the post-goal mini countdown (phase stays 'goal')
    time: 0, // simulated seconds since creation
    serveTo: rng() < 0.5 ? 'host' : 'guest',
    puck: { x: W / 2, y: bottom / 2, vx: 0, vy: 0 },
    mallets: {
      host: { x: W / 2, y: bottom - H * 0.2, vx: 0, vy: 0, lastT: 0 },
      guest: { x: W / 2, y: H * 0.2, vx: 0, vy: 0, lastT: 0 },
    },
    score: { host: 0, guest: 0 },
    gw: [goalW, goalW], // current goal widths [host, guest]
    lastGoalBy: null,
    winner: null,
  };
  if (battleMode) {
    state.items = { host: null, guest: null };
    state.lastHit = null; // side whose mallet last touched the puck; null after each serve
    state.bt = { sh: [0, 0], gh: [0, 0], sk: [0, 0], fz: 0, rk: [0, 0], mr: [malletR, malletR] };
  }

  let events = [];
  let seq = 0;
  let lastTick = Infinity;
  let seamStill = 0;
  const bombMode = mode === 'bombs';
  const glitchMode = mode === 'glitch';
  let glitchAt = Infinity; // sim time of the next glitch
  let glitchWarned = false;
  let glitchN = 0; // glitches (or skipped attempts) this rally
  // Battle mode bookkeeping (unused in the other modes).
  let boxes = []; // the two item box slots (also in `obstacles`)
  let boxesStarted = false; // first serve of the match seen
  let firstPair = false; // the opening pair of boxes is still to spawn
  let rocketT = 0; // seconds of rocket flight left (raises the puck speed cap)
  let frozenVx = 0; // puck velocity held aside while it is frozen
  let frozenVy = 0;
  let botUseAt = -1; // sim time at which the bot may use its item (-1 = not holding)
  const lastUsed = { host: null, guest: null };

  function emit(k, x, y, s, extra) {
    if (events.length >= EVENT_CAP) return;
    const e = { k, x: r(x), y: r(y), s: Math.round(s * 100) / 100 };
    if (extra) Object.assign(e, extra);
    events.push(e);
  }

  // --- obstacles ------------------------------------------------------------

  const obstacles = buildObstacles(); // mutated in place by setGap()
  state.obs = obstacles; // the bot reads this (same array reference)

  function buildObstacles() {
    if (battleMode) return makeBoxes();
    const list = [];
    if (mode !== 'bumpers' && mode !== 'mines' && mode !== 'bombs') return list;
    const isBumper = mode === 'bumpers';
    const rad = malletR * (bombMode ? BOMB_R_FACTOR : isBumper ? BUMPER_R_FACTOR : MINE_R_FACTOR);
    let layout;
    if (bombMode) {
      layout = BOMB_LAYOUT;
    } else if (isBumper) {
      const n = clamp(Math.round(cfg.bumperCount || 4), 3, 5);
      layout = BUMPER_LAYOUTS[n];
    } else {
      const total = cfg.mineCount || 6;
      layout = MINE_LAYOUTS[clamp(Math.round(total / 2), 2, 3)];
    }
    const creaseLimit = goalW / 2 + malletR * 2 + rad; // distance from goal-mouth centre
    for (const [fx, fv0] of layout) {
      let fv = Math.max(fv0, 0.2); // keep clear of the seam
      const x = fx * W;
      // Keep out of the goal crease (push towards the seam if too close).
      while (fv > 0.2 && Math.hypot(x - W / 2, (1 - fv) * H) < creaseLimit) fv -= 0.02;
      const y = seamBottom + fv * H;
      if (bombMode) {
        list.push(makeBomb(x, y, rad));
        list.push(makeBomb(W - x, bottom - y, rad));
        continue;
      }
      list.push({ k: isBumper ? 'bumper' : 'mine', x, y, r: rad, rearmAt: 0 });
      list.push({ k: isBumper ? 'bumper' : 'mine', x: W - x, y: bottom - y, r: rad, rearmAt: 0 });
    }
    return list;
  }

  function makeBomb(x, y, rad) {
    return { k: 'bomb', x, y, r: rad, vx: 0, vy: 0, hx: x, hy: y, armed: false, still: 0 };
  }

  /** Mines rearm; bombs go home, at rest, unarmed. */
  function rearmAll() {
    for (const o of obstacles) {
      if (o.k === 'box' || o.drop) continue; // item boxes and dropped mines have their own timers
      o.rearmAt = 0;
      if (o.k === 'bomb') {
        o.x = o.hx;
        o.y = o.hy;
        o.vx = 0;
        o.vy = 0;
        o.armed = false;
        o.still = 0;
      }
    }
  }

  function collideObstacles() {
    const p = state.puck;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (o.k === 'bomb' || o.k === 'box') continue; // bombs are bodies, see stepBombs(); boxes are not solid
      const dx = p.x - o.x;
      const dy = p.y - o.y;
      const minDist = puckR + o.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minDist * minDist) continue;
      if (o.k === 'mine') {
        if (state.time < o.rearmAt) continue; // disarmed mines are inert
        const a = rng() * Math.PI * 2;
        const sp = MAX_PUCK_SPEED * MINE_BLAST_FACTOR;
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp;
        // Start the puck just outside the mine so it cannot re-trigger.
        p.x = o.x + Math.cos(a) * (minDist + 1);
        p.y = o.y + Math.sin(a) * (minDist + 1);
        emit('mine', o.x, o.y, 1);
        if (o.drop) {
          obstacles.splice(i, 1); // a dropped mine goes off once
          i--;
        } else {
          o.rearmAt = state.time + MINE_REARM_S;
        }
        continue;
      }
      let dist = Math.sqrt(d2);
      let nx;
      let ny;
      if (dist < 1e-6) {
        // Exactly on the centre: push out against the puck's travel direction.
        const sp = Math.hypot(p.vx, p.vy) || 1;
        nx = -p.vx / sp || 0;
        ny = -p.vy / sp || -1;
        dist = 0;
      } else {
        nx = dx / dist;
        ny = dy / dist;
      }
      p.x = o.x + nx * (minDist + 0.01);
      p.y = o.y + ny * (minDist + 0.01);
      const vn = p.vx * nx + p.vy * ny;
      if (vn < 0) {
        p.vx -= (1 + BUMPER_RESTITUTION) * vn * nx;
        p.vy -= (1 + BUMPER_RESTITUTION) * vn * ny;
        const s = Math.min(1, -vn / 1800);
        if (s > 0.04) emit('bumper', o.x, o.y, s);
      }
    }
  }

  // --- bombs ----------------------------------------------------------------

  function bombRails(b) {
    if (b.x < b.r) {
      b.x = b.r;
      b.vx = Math.abs(b.vx) * BOMB_WALL_REST;
    } else if (b.x > W - b.r) {
      b.x = W - b.r;
      b.vx = -Math.abs(b.vx) * BOMB_WALL_REST;
    }
    if (b.y < b.r) {
      b.y = b.r;
      b.vy = Math.abs(b.vy) * BOMB_WALL_REST;
    } else if (b.y > bottom - b.r) {
      b.y = bottom - b.r;
      b.vy = -Math.abs(b.vy) * BOMB_WALL_REST;
    }
  }

  /** Two bombs (equal masses): push apart evenly, exchange normal velocity. */
  function bombBomb(a, b) {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const minDist = a.r + b.r;
    const d2 = dx * dx + dy * dy;
    if (d2 >= minDist * minDist) return;
    let d = Math.sqrt(d2);
    if (d < 1e-6) {
      dx = 1;
      dy = 0;
      d = 1;
    }
    const nx = dx / d;
    const ny = dy / d;
    const push = (minDist - d) / 2 + 0.005;
    a.x -= nx * push;
    a.y -= ny * push;
    b.x += nx * push;
    b.y += ny * push;
    const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (vn < 0) {
      const j = (-(1 + BOMB_BOMB_REST) * vn) / 2;
      a.vx -= j * nx;
      a.vy -= j * ny;
      b.vx += j * nx;
      b.vy += j * ny;
    }
  }

  /** Puck vs bomb: two-body response along the normal, both pushed apart. */
  function puckBomb(b) {
    const p = state.puck;
    let dx = p.x - b.x;
    let dy = p.y - b.y;
    const minDist = puckR + b.r;
    const d2 = dx * dx + dy * dy;
    if (d2 >= minDist * minDist) return;
    let d = Math.sqrt(d2);
    let nx;
    let ny;
    if (d < 1e-6) {
      const rvx = p.vx - b.vx;
      const rvy = p.vy - b.vy;
      const rs = Math.hypot(rvx, rvy);
      nx = rs > 1e-6 ? -rvx / rs : 0;
      ny = rs > 1e-6 ? -rvy / rs : -1;
      d = 0;
    } else {
      nx = dx / d;
      ny = dy / d;
    }
    const total = BOMB_PUCK_MASS + BOMB_MASS;
    const push = minDist - d + 0.01;
    p.x += nx * push * (BOMB_MASS / total);
    p.y += ny * push * (BOMB_MASS / total);
    b.x -= nx * push * (BOMB_PUCK_MASS / total);
    b.y -= ny * push * (BOMB_PUCK_MASS / total);
    const vn = (p.vx - b.vx) * nx + (p.vy - b.vy) * ny;
    if (vn < 0) {
      const j = (-(1 + BOMB_PUCK_REST) * vn) / (1 / BOMB_PUCK_MASS + 1 / BOMB_MASS);
      p.vx += (j / BOMB_PUCK_MASS) * nx;
      p.vy += (j / BOMB_PUCK_MASS) * ny;
      b.vx -= (j / BOMB_MASS) * nx;
      b.vy -= (j / BOMB_MASS) * ny;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > MAX_PUCK_SPEED) {
        p.vx *= MAX_PUCK_SPEED / sp;
        p.vy *= MAX_PUCK_SPEED / sp;
      }
      const s = Math.min(1, -vn / BOMB_PUCK_SPEED_REF);
      if (s > 0.04) emit('bombhit', b.x + nx * b.r, b.y + ny * b.r, s);
    }
  }

  /** Keep the puck on the table after a bomb pushed it (goal mouths stay open). */
  function clampPuck() {
    const p = state.puck;
    p.x = clamp(p.x, puckR, W - puckR);
    if (p.y < puckR && !inMouth(p.x, 'guest')) p.y = puckR;
    else if (p.y > bottom - puckR && !inMouth(p.x, 'host')) p.y = bottom - puckR;
  }

  /** An armed bomb under mallet `m` goes off: the mallet's owner loses a point.
   *  Returns true when a bomb detonated (the phase has changed). */
  function detonateCheck(m, role) {
    if (state.phase !== PHASE.PLAY) return false;
    for (const b of obstacles) {
      if (!b.armed) continue;
      if (Math.hypot(m.x - b.x, m.y - b.y) < malletR + b.r) {
        emit('bomb', b.x, b.y, 1, { by: role });
        goal(role, { x: b.x, y: b.y, why: 'bomb' });
        return true;
      }
    }
    return false;
  }

  /** One physics substep for every bomb: arming, friction, rails, bomb-bomb,
   *  puck-bomb, seam rescue, detonation by a mallet the bomb slid into. */
  function stepBombs(dt) {
    const mh = state.mallets.host;
    const mg = state.mallets.guest;
    const armDist = malletR + BOMB_ARM_MARGIN;
    const k = Math.pow(BOMB_FRIC, dt);
    for (const b of obstacles) {
      if (!b.armed) {
        const lim = armDist + b.r;
        if (Math.hypot(b.x - mh.x, b.y - mh.y) >= lim && Math.hypot(b.x - mg.x, b.y - mg.y) >= lim) b.armed = true;
      }
      b.vx *= k;
      b.vy *= k;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > BOMB_MAX) {
        b.vx *= BOMB_MAX / sp;
        b.vy *= BOMB_MAX / sp;
      } else if (sp < BOMB_STOP) {
        b.vx = 0;
        b.vy = 0;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      bombRails(b);
    }
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < obstacles.length; i++) {
        for (let j = i + 1; j < obstacles.length; j++) bombBomb(obstacles[i], obstacles[j]);
      }
      for (const b of obstacles) puckBomb(b);
      for (const b of obstacles) bombRails(b);
      clampPuck();
    }
    // A bomb resting fully inside the seam gap is out of reach: nudge it out.
    if (G > 0) {
      for (const b of obstacles) {
        const inGap = b.y - b.r > seamTop && b.y + b.r < seamBottom;
        if (inGap && Math.hypot(b.vx, b.vy) < 30) {
          b.still += dt;
          if (b.still > BOMB_SEAM_REST_S) {
            b.vx = 0;
            b.vy = b.y < (seamTop + seamBottom) / 2 ? -BOMB_SEAM_NUDGE : BOMB_SEAM_NUDGE;
            b.still = 0;
          }
        } else {
          b.still = 0;
        }
      }
    }
    if (detonateCheck(mh, 'host')) return;
    detonateCheck(mg, 'guest');
  }

  // --- serving --------------------------------------------------------------

  function placePuckForServe() {
    const p = state.puck;
    p.vx = 0;
    p.vy = 0;
    p.x = W / 2;
    // Serve into the half of the player who receives the puck.
    p.y = state.serveTo === 'host' ? seamBottom + H / 2 : seamTop - H / 2;
  }

  function launchServe() {
    const p = state.puck;
    p.x = W / 2;
    p.y = bottom / 2; // inside the seam gap, heading toward the receiver
    const dir = state.serveTo === 'host' ? 1 : -1;
    const angle = (rng() - 0.5) * 0.8;
    p.vx = Math.sin(angle) * SERVE_SPEED;
    p.vy = Math.cos(angle) * SERVE_SPEED * dir;
    seamStill = 0;
    rearmAll();
    if (battleMode) {
      state.lastHit = null;
      if (!boxesStarted) {
        boxesStarted = true;
        firstPair = true;
        for (const b of boxes) b.spawnAt = state.time + BOX_FIRST_SPAWN_S;
      }
    }
    if (glitchMode) {
      glitchAt = state.time + rand(1.8, 3.0);
      glitchWarned = false;
      glitchN = 0;
    }
    emit('serve', p.x, p.y, 1);
  }

  // --- mallets --------------------------------------------------------------

  function clampMallet(role, m) {
    const rr = battleMode ? state.bt.mr[role === 'host' ? 0 : 1] : malletR;
    m.x = Math.min(W - rr, Math.max(rr, m.x));
    if (role === 'host') m.y = Math.min(bottom - rr, Math.max(seamBottom + rr, m.y));
    else m.y = Math.min(seamTop - rr, Math.max(rr, m.y));
  }

  /** Sweep a mallet from (prevX, prevY) to its current spot so a fast flick
   *  cannot jump through the puck between two samples. */
  function sweepMallet(m, prevX, prevY, role) {
    if (state.phase !== PHASE.PLAY) return;
    const endX = m.x;
    const endY = m.y;
    const dist = Math.hypot(endX - prevX, endY - prevY);
    const steps = Math.min(8, Math.max(1, Math.ceil(dist / puckR)));
    for (let i = 1; i <= steps; i++) {
      m.x = prevX + ((endX - prevX) * i) / steps;
      m.y = prevY + ((endY - prevY) * i) / steps;
      collideMallet(m, role);
    }
    m.x = endX;
    m.y = endY;
  }

  /** Move a mallet to a new target position; velocity derives from the move.
   *  `jump` (a brand-new touch, or a step longer than 6 mallet radii) teleports
   *  the mallet: no velocity, no sweep, so it cannot fire the puck. */
  function setMallet(role, x, y, now, jump = false) {
    if (role === 'guest' && cfg.players === 'bot') return; // the bot owns it
    const m = state.mallets[role];
    if (!m) return;
    const prevX = m.x;
    const prevY = m.y;
    m.x = x;
    m.y = y;
    clampMallet(role, m);
    if (jump || Math.hypot(m.x - prevX, m.y - prevY) > 6 * malletR) {
      m.vx = 0;
      m.vy = 0;
      m.lastT = now;
      return;
    }
    const dt = Math.max(0.004, Math.min(0.05, (now - m.lastT) / 1000));
    m.lastT = now;
    let vx = (m.x - prevX) / dt;
    let vy = (m.y - prevY) / dt;
    const speed = Math.hypot(vx, vy);
    if (speed > MAX_MALLET_SPEED) {
      vx *= MAX_MALLET_SPEED / speed;
      vy *= MAX_MALLET_SPEED / speed;
    }
    // Smooth so a single jittery sample does not launch the puck.
    m.vx = m.vx * 0.5 + vx * 0.5;
    m.vy = m.vy * 0.5 + vy * 0.5;
    sweepMallet(m, prevX, prevY, role);
  }

  /** Mallet velocity decays when no touch samples arrive. */
  function decayMallets(dt) {
    for (const m of Object.values(state.mallets)) {
      const k = Math.pow(0.001, dt); // fast decay
      m.vx *= k;
      m.vy *= k;
    }
  }

  function inMouth(x, side) {
    // side 'guest' = top goal, 'host' = bottom goal
    const w = side === 'guest' ? state.gw[1] : state.gw[0];
    return Math.abs(x - W / 2) < w / 2;
  }

  function collideMallet(m, role) {
    if (bombMode && detonateCheck(m, role)) return;
    const p = state.puck;
    if (battleMode) {
      if (state.bt.fz > 0) return; // a frozen puck ignores mallets
      const hit = malletHit(p, m, role, sideGeom[role], rocketT > 0 ? physRocket : phys, mouthB);
      if (!hit) return;
      state.lastHit = role;
      if (hit.vn < 0) {
        const s = Math.min(1, -hit.vn / 2000);
        if (s > 0.03) emit('hit', p.x - hit.nx * puckR, p.y - hit.ny * puckR, s);
        rocketHit(role, hit);
      }
      return;
    }
    const hit = malletHit(p, m, role, geom, phys, inMouth);
    if (hit && hit.vn < 0) {
      const s = Math.min(1, -hit.vn / 2000);
      if (s > 0.03) emit('hit', p.x - hit.nx * puckR, p.y - hit.ny * puckR, s);
    }
  }

  // --- goals ----------------------------------------------------------------

  function updateGoalWidths() {
    let h = goalW;
    let g = goalW;
    if (cfg.comeback) {
      const behind = (d) => (d >= 2 ? 0.6 : d === 1 ? 0.75 : 1);
      h = goalW * behind(state.score.guest - state.score.host);
      g = goalW * behind(state.score.host - state.score.guest);
    }
    state.gw = [h, g];
  }

  /** `extra` {x, y, why} marks a goal that did not come from the puck (a bomb
   *  going off): the event is placed at x, y and carries `why`. */
  function goal(scoredOn, extra) {
    const scorer = scoredOn === 'host' ? 'guest' : 'host';
    if (extra) emit('goal', extra.x, extra.y, 1, { by: scorer, why: extra.why });
    else emit('goal', state.puck.x, scoredOn === 'guest' ? 0 : bottom, 1, { by: scorer });
    state.score[scorer] += 1;
    state.lastGoalBy = scorer;
    state.serveTo = scoredOn;
    updateGoalWidths();
    if (state.score[scorer] >= target) {
      state.phase = PHASE.OVER;
      state.winner = scorer;
      state.timer = 0;
      emit('over', W / 2, bottom / 2, 1);
    } else {
      state.phase = PHASE.GOAL;
      state.stage = 0;
      state.timer = GOAL_PAUSE_S;
    }
    if (battleMode) battleClear();
    placePuckForServe();
  }

  // --- puck physics ---------------------------------------------------------

  function stepPuck(dt) {
    const p = state.puck;
    if (battleMode && state.bt.fz > 0) return; // frozen: no motion, no collisions
    const ph = battleMode && rocketT > 0 ? physRocket : phys;
    frictionStep(p, ph, dt);
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Shield: an end rail bounce inside a shielded mouth is a shield bounce.
    let shield = -1;
    let shieldVn = 0;
    if (battleMode) {
      if (state.bt.sh[0] > 0 && p.y > bottom - puckR && p.vy > 0 && inMouth(p.x, 'host')) {
        shield = 0;
        shieldVn = p.vy;
      } else if (state.bt.sh[1] > 0 && p.y < puckR && p.vy < 0 && inMouth(p.x, 'guest')) {
        shield = 1;
        shieldVn = -p.vy;
      }
    }

    // Rails and goals.
    const scoredOn = railBounce(p, geom, ph, battleMode ? mouthB : inMouth, shield >= 0 ? noWall : wallBounce);
    if (shield >= 0) {
      p.vx *= SHIELD_BOUNCE;
      p.vy *= SHIELD_BOUNCE;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > ph.max) {
        p.vx *= ph.max / sp;
        p.vy *= ph.max / sp;
      }
      emit('shieldhit', p.x, p.y, Math.min(1, shieldVn / 2000), { by: shield === 0 ? 'host' : 'guest' });
    }
    if (scoredOn) return goal(scoredOn);

    // Mallets first, obstacles last, so a mallet can never shove the puck
    // into a bumper and keep it there with energy gained from the squeeze.
    const mh = state.mallets.host;
    const mg = state.mallets.guest;
    for (let i = 0; i < 3; i++) {
      collideMallet(mh, 'host');
      collideMallet(mg, 'guest');
      if (obstacles.length) collideObstacles();
      if (state.phase !== PHASE.PLAY) return; // a bomb went off
    }
    // Bombs are bodies: the puck and each other can shove them around.
    if (bombMode) {
      stepBombs(dt);
      if (state.phase !== PHASE.PLAY) return;
    }
    if (battleMode) collectBoxes();
    // Still overlapping a mallet = squeezed between it and an obstacle or rail:
    // the puck just rides along with half the mallet's velocity.
    for (const m of [mh, mg]) {
      const minDist = puckR + (battleMode ? state.bt.mr[m === mh ? 0 : 1] : malletR) - 0.5;
      if (Math.hypot(p.x - m.x, p.y - m.y) < minDist) {
        p.vx = m.vx * 0.5;
        p.vy = m.vy * 0.5;
        break;
      }
    }

    // Final safety: never leave the rink sideways.
    p.x = clamp(p.x, puckR, W - puckR);

    // A puck that dies in the seam gap is out of reach of both players.
    if (G > 2 * puckR) {
      const inGap = p.y > seamTop + puckR && p.y < seamBottom - puckR;
      if (inGap && Math.hypot(p.vx, p.vy) < 30) {
        seamStill += dt;
        if (seamStill > 1.2) {
          const dir = rng() < 0.5 ? 1 : -1;
          p.vx = (rng() - 0.5) * 80;
          p.vy = dir * 260;
          seamStill = 0;
        }
      } else {
        seamStill = 0;
      }
    }
  }

  // --- battle ---------------------------------------------------------------
  // Item boxes sit on the rink; the puck collects them for whoever touched it
  // last. Each player holds one item and fires it with useItem(). Everything
  // here is a no-op outside battle mode.

  const sideIdx = (role) => (role === 'host' ? 0 : 1);

  /** Goal mouths, except that a shielded side's mouth is solid. */
  function mouthB(x, side) {
    if (state.bt.sh[side === 'host' ? 0 : 1] > 0) return false;
    return inMouth(x, side);
  }

  /** World box spot j (0..9): even = host half, odd = its point reflection. */
  function boxSpot(j) {
    const [fx, fv0] = BOX_SPOTS[j >> 1];
    const rad = malletR * BOX_R_FACTOR;
    const creaseLimit = goalW / 2 + malletR * 2 + rad;
    const x = fx * W;
    let fv = Math.max(fv0, 0.2);
    while (fv > 0.2 && Math.hypot(x - W / 2, (1 - fv) * H) < creaseLimit) fv -= 0.02;
    const y = seamBottom + fv * H;
    return j & 1 ? { x: W - x, y: bottom - y } : { x, y };
  }

  /** The two box slots in their initial (not yet spawned) state. */
  function makeBoxes() {
    const rad = malletR * BOX_R_FACTOR;
    const a = boxSpot(4);
    const b = boxSpot(5);
    boxes = [
      { k: 'box', x: a.x, y: a.y, r: rad, on: false, spawnAt: Infinity },
      { k: 'box', x: b.x, y: b.y, r: rad, on: false, spawnAt: Infinity },
    ];
    boxesStarted = false;
    firstPair = false;
    return boxes.slice();
  }

  function removeDroppedMines() {
    for (let i = obstacles.length - 1; i >= 0; i--) if (obstacles[i].drop) obstacles.splice(i, 1);
  }

  /** Change a side's mallet radius (physics and clamping follow). */
  function setMalletRadius(idx, rad) {
    const role = idx === 0 ? 'host' : 'guest';
    state.bt.mr[idx] = rad;
    sideGeom[role].malletR = rad;
    clampMallet(role, state.mallets[role]);
  }

  /** Drop every timed effect except rocket arming (goals and restart). The
   *  frozen puck is not thawed: the caller repositions it. */
  function battleClear() {
    const bt = state.bt;
    bt.sh[0] = bt.sh[1] = 0;
    bt.gh[0] = bt.gh[1] = 0;
    bt.sk[0] = bt.sk[1] = 0;
    bt.fz = 0;
    rocketT = 0;
    for (let i = 0; i < 2; i++) if (bt.mr[i] !== malletR) setMalletRadius(i, malletR);
    removeDroppedMines();
  }

  /** New match: held items, rocket arming, boxes and the bot's hold clock. */
  function battleReset() {
    battleClear();
    state.items.host = null;
    state.items.guest = null;
    state.lastHit = null;
    state.bt.rk[0] = state.bt.rk[1] = 0;
    lastUsed.host = lastUsed.guest = null;
    botUseAt = -1;
    const a = boxSpot(4);
    const b = boxSpot(5);
    boxes[0].x = a.x;
    boxes[0].y = a.y;
    boxes[1].x = b.x;
    boxes[1].y = b.y;
    for (const bx of boxes) {
      bx.on = false;
      bx.spawnAt = Infinity;
    }
    boxesStarted = false;
    firstPair = false;
  }

  /** Weighted item for `side`: offensive items favour the player who is behind. */
  function rollItem(side) {
    const other = side === 'host' ? 'guest' : 'host';
    const d = state.score[other] - state.score[side];
    const off = d >= 1 ? 1 + 0.5 * d : d <= -2 ? 0.5 : 1;
    const pick = () => {
      let total = 0;
      for (const id of ITEMS) total += OFFENSIVE_ITEMS.includes(id) ? off : 1;
      let t = rng() * total;
      for (const id of ITEMS) {
        t -= OFFENSIVE_ITEMS.includes(id) ? off : 1;
        if (t < 0) return id;
      }
      return ITEMS[ITEMS.length - 1];
    };
    let item = pick();
    if (item === lastUsed[side]) item = pick(); // re-roll once
    // Pass and play shares one screen: a ghost would blind both players.
    if (item === 'ghost' && cfg.players === 'pass') item = pick();
    if (item === 'ghost' && cfg.players === 'pass') item = 'shield';
    return item;
  }

  /** The puck touches an active box: the credited player gets an item. */
  function collectBoxes() {
    const p = state.puck;
    for (const b of boxes) {
      if (!b.on) continue;
      if (Math.hypot(p.x - b.x, p.y - b.y) >= puckR + b.r) continue;
      const side = state.lastHit || (b.y > H + G / 2 ? 'host' : 'guest');
      if (state.items[side]) continue; // a full slot cannot collect: the puck passes through
      const item = rollItem(side);
      state.items[side] = item;
      b.on = false;
      b.spawnAt = state.time + rand(BOX_RESPAWN_MIN_S, BOX_RESPAWN_MAX_S);
      emit('box', b.x, b.y, 1, { by: side, item });
    }
  }

  /** A spot for a new box: clear of the puck, both mallets and dropped mines. */
  function boxSpotOk(sp, rad) {
    const p = state.puck;
    if (Math.hypot(sp.x - p.x, sp.y - p.y) < puckR * 3) return false;
    for (const role of ['host', 'guest']) {
      const m = state.mallets[role];
      if (Math.hypot(sp.x - m.x, sp.y - m.y) < malletR * 2.5 + rad) return false;
    }
    for (const o of obstacles) {
      if (o.drop && Math.hypot(sp.x - o.x, sp.y - o.y) < o.r + rad) return false;
    }
    return true;
  }

  function spawnBox(b, sp) {
    b.x = sp.x;
    b.y = sp.y;
    b.on = true;
    emit('boxspawn', b.x, b.y, 1);
  }

  /** Spawn boxes whose timers are due. The opening pair is a random spot and
   *  its mirror; later boxes pick any free spot. Gives up for this tick after
   *  BOX_TRIES attempts. */
  function boxTick() {
    if (!boxesStarted) return;
    const rad = malletR * BOX_R_FACTOR;
    if (firstPair) {
      if (state.time < boxes[0].spawnAt) return;
      for (let t = 0; t < BOX_TRIES; t++) {
        const j = Math.floor(rng() * 10);
        const a = boxSpot(j);
        const b = boxSpot(j ^ 1);
        if (!boxSpotOk(a, rad) || !boxSpotOk(b, rad)) continue;
        spawnBox(boxes[0], a);
        spawnBox(boxes[1], b);
        firstPair = false;
        return;
      }
      return;
    }
    for (const b of boxes) {
      if (b.on || state.time < b.spawnAt) continue;
      const other = boxes[0] === b ? boxes[1] : boxes[0];
      for (let t = 0; t < BOX_TRIES; t++) {
        const sp = boxSpot(Math.floor(rng() * 10));
        if (other.on && Math.hypot(sp.x - other.x, sp.y - other.y) < 1) continue;
        if (!boxSpotOk(sp, rad)) continue;
        spawnBox(b, sp);
        break;
      }
    }
  }

  /** A mallet hit by a side with a rocket armed: speed x1.6 (min 1800, cap 3900)
   *  and the puck keeps that cap for the flight time. */
  function rocketHit(role, hit) {
    const idx = sideIdx(role);
    if (!state.bt.rk[idx]) return;
    state.bt.rk[idx] = 0;
    const p = state.puck;
    const sp = Math.hypot(p.vx, p.vy);
    const ux = sp > 1e-6 ? p.vx / sp : hit.nx;
    const uy = sp > 1e-6 ? p.vy / sp : hit.ny;
    const ns = Math.min(ROCKET_MAX, Math.max(ROCKET_MIN, sp * ROCKET_MULT));
    p.vx = ux * ns;
    p.vy = uy * ns;
    rocketT = ROCKET_FLIGHT_S;
    emit('rocket', p.x, p.y, 1, { by: role });
  }

  /** Random spot in `ti`'s half for a dropped mine, or null. */
  function findMineSpot(ti) {
    const rad = malletR * MINE_R_FACTOR;
    const lo = ti === 0 ? seamBottom + malletR * 2 : malletR * 2;
    const hi = ti === 0 ? bottom - malletR * 2 : seamTop - malletR * 2;
    const creaseLimit = goalW / 2 + malletR * 2 + rad;
    const p = state.puck;
    for (let t = 0; t < BOX_TRIES; t++) {
      const x = rand(puckR * 3, W - puckR * 3);
      const y = rand(lo, hi);
      if (Math.hypot(x - W / 2, y) < creaseLimit || Math.hypot(x - W / 2, y - bottom) < creaseLimit) continue;
      let ok = true;
      for (const role of ['host', 'guest']) {
        const m = state.mallets[role];
        if (Math.hypot(x - m.x, y - m.y) < malletR * 2.5 + rad) ok = false;
      }
      if (Math.hypot(x - p.x, y - p.y) < puckR * 3 + rad) ok = false;
      for (const o of obstacles) {
        if (o.k === 'box' && !o.on) continue;
        if (Math.hypot(x - o.x, y - o.y) < Math.max(2 * rad, rad + o.r)) ok = false;
      }
      if (ok) return { x, y, r: rad };
    }
    return null;
  }

  /** Fire the item `role` holds. Returns true when it was used (phase 'play',
   *  an item in hand, and for a mine a free spot); otherwise false and the
   *  item is kept. */
  function useItem(role) {
    if (!battleMode || state.phase !== PHASE.PLAY) return false;
    if (role !== 'host' && role !== 'guest') return false;
    const item = state.items[role];
    if (!item) return false;
    const idx = sideIdx(role);
    const ti = 1 - idx; // the target
    const bt = state.bt;
    const p = state.puck;
    let mineSpot = null;
    if (item === 'mine') {
      mineSpot = findMineSpot(ti);
      if (!mineSpot) return false;
    }
    switch (item) {
      case 'rocket':
        bt.rk[idx] = 1;
        break;
      case 'shield':
        bt.sh[idx] = SHIELD_S;
        break;
      case 'ghost':
        bt.gh[ti] = GHOST_S;
        break;
      case 'shrink':
        bt.sk[ti] = SHRINK_S;
        setMalletRadius(ti, malletR * SHRINK_FACTOR);
        break;
      case 'freeze':
        if (bt.fz <= 0) {
          frozenVx = p.vx;
          frozenVy = p.vy;
          p.vx = 0;
          p.vy = 0;
        }
        bt.fz = FREEZE_S;
        break;
      case 'mine':
        obstacles.push({
          k: 'mine',
          x: mineSpot.x,
          y: mineSpot.y,
          r: mineSpot.r,
          rearmAt: state.time + DROP_FUSE_S,
          expireAt: state.time + DROP_FUSE_S + DROP_LIVE_S,
          drop: true,
        });
        emit('minedrop', mineSpot.x, mineSpot.y, 1, { by: role });
        break;
    }
    state.items[role] = null;
    lastUsed[role] = item;
    const m = state.mallets[role];
    emit('use', m.x, m.y, 1, { by: role, item });
    return true;
  }

  /** The bot (guest) fires its item after a short hold. */
  function botItemTick() {
    const item = state.items.guest;
    if (!item) {
      botUseAt = -1;
      return;
    }
    if (botUseAt < 0) botUseAt = state.time + rand(BOT_HOLD_MIN_S, BOT_HOLD_MAX_S);
    if (state.time < botUseAt) return;
    const p = state.puck;
    const late = state.time >= botUseAt + BOT_WAIT_S;
    let go = true;
    if (item === 'shield') go = late || (p.vy < 0 && Math.hypot(p.vx, p.vy) > 600 && p.y < 0.6 * H);
    else if (item === 'freeze') go = late || (p.y < H && p.vy < -800 && p.y < 0.5 * H);
    if (go && useItem('guest')) botUseAt = -1;
  }

  /** Per-step battle upkeep while playing: effect timers, thaw, mine expiry,
   *  box spawns and the bot's item use. */
  function battleTick(dt) {
    const bt = state.bt;
    if (rocketT > 0) rocketT = Math.max(0, rocketT - dt);
    for (let i = 0; i < 2; i++) {
      if (bt.sh[i] > 0) bt.sh[i] = Math.max(0, bt.sh[i] - dt);
      if (bt.gh[i] > 0) bt.gh[i] = Math.max(0, bt.gh[i] - dt);
      if (bt.sk[i] > 0) {
        bt.sk[i] -= dt;
        if (bt.sk[i] <= 0) {
          bt.sk[i] = 0;
          setMalletRadius(i, malletR);
        }
      }
    }
    if (bt.fz > 0) {
      bt.fz -= dt;
      if (bt.fz <= 0) {
        bt.fz = 0;
        const p = state.puck;
        p.vx = frozenVx;
        p.vy = frozenVy;
        emit('thaw', p.x, p.y, 1);
      }
    }
    for (let i = obstacles.length - 1; i >= 0; i--) {
      if (obstacles[i].drop && state.time >= obstacles[i].expireAt) obstacles.splice(i, 1);
    }
    boxTick();
    if (bot) botItemTick();
  }

  // --- glitch ---------------------------------------------------------------

  function rand(lo, hi) {
    return lo + rng() * (hi - lo);
  }

  function glitchReschedule() {
    glitchN += 1;
    glitchAt = state.time + rand(1.4, 2.4) * Math.max(0.55, 1 - 0.07 * glitchN);
    glitchWarned = false;
  }

  /** Telegraph, then hop the puck a short way. Runs once per step while playing. */
  function glitchTick() {
    const p = state.puck;
    if (!glitchWarned && state.time >= glitchAt - GLITCH_WARN_S) {
      emit('glitchwarn', p.x, p.y, 1);
      glitchWarned = true;
    }
    if (!glitchWarned || state.time < glitchAt) return;
    const inGap = (y) => y > seamTop - puckR && y < seamBottom + puckR;
    if (inGap(p.y)) {
      // Never hop out of (or into) the seam: wait for the puck to leave it.
      if (state.time >= glitchAt + GLITCH_GIVE_UP_S) glitchReschedule();
      return;
    }
    const mh = state.mallets.host;
    const mg = state.mallets.guest;
    const margin = puckR * 1.5;
    const mallDist = malletR * 2.5 + puckR;
    const goalDist = goalW / 2 + puckR * 3;
    for (let i = 0; i < GLITCH_TRIES; i++) {
      const len = rand(3, 6) * puckR;
      const ang = rng() * Math.PI * 2;
      const cx = p.x + Math.cos(ang) * len;
      const cy = p.y + Math.sin(ang) * len;
      if (cx < margin || cx > W - margin || cy < margin || cy > bottom - margin) continue;
      if (inGap(cy)) continue;
      if (Math.hypot(cx - mh.x, cy - mh.y) < mallDist || Math.hypot(cx - mg.x, cy - mg.y) < mallDist) continue;
      if (Math.hypot(cx - W / 2, cy) <= goalDist || Math.hypot(cx - W / 2, cy - bottom) <= goalDist) continue;
      const ox = p.x;
      const oy = p.y;
      const sp0 = Math.hypot(p.vx, p.vy);
      const dir = (sp0 > 1e-6 ? Math.atan2(p.vy, p.vx) : ang) + rand(-0.6, 0.6);
      const sp = Math.min(MAX_PUCK_SPEED, Math.max(GLITCH_MIN_SPEED, sp0));
      p.x = cx;
      p.y = cy;
      p.vx = Math.cos(dir) * sp;
      p.vy = Math.sin(dir) * sp;
      seamStill = 0;
      emit('glitch', cx, cy, Math.min(5, len / puckR), { fx: r(ox), fy: r(oy) });
      break;
    }
    glitchReschedule();
  }

  const noWall = () => {}; // a shield bounce is not a rail tick

  function wallBounce(vn) {
    const s = Math.min(1, vn / 2600);
    if (s > 0.04) emit('wall', state.puck.x, state.puck.y, s);
  }

  // --- frame step -----------------------------------------------------------

  let bot = null;
  function makeBot() {
    bot = createBot(cfg.botLevel, {
      W,
      H,
      G,
      puckR,
      malletR,
      goalW,
      friction: phys.fric,
      wallRestitution: phys.wall,
      rng, // the bot's aim noise follows the sim's rng, so seeded runs repeat
    });
  }
  if (cfg.players === 'bot') makeBot();

  function tickCountdown(t) {
    const tick = Math.ceil(t - 1e-9);
    if (tick >= 1 && tick < lastTick) {
      lastTick = tick;
      emit('countdown', W / 2, bottom / 2, tick);
    }
  }

  function startPlay() {
    state.phase = PHASE.PLAY;
    state.stage = 0;
    lastTick = Infinity;
    launchServe();
  }

  function step(dt, now) {
    if (!(dt > 0)) return;
    if (dt > 0.05) dt = 0.05; // survive a backgrounded tab
    state.time += dt;
    decayMallets(dt);
    if (state.phase === PHASE.READY) return; // waiting for both players: nothing moves

    if (bot && state.phase !== PHASE.OVER) {
      const m = state.mallets.guest;
      const px = m.x;
      const py = m.y;
      bot.update(state, dt, now === undefined ? state.time * 1000 : now);
      clampMallet('guest', m);
      sweepMallet(m, px, py, 'guest');
    }

    switch (state.phase) {
      case PHASE.COUNTDOWN:
        state.timer -= dt;
        tickCountdown(state.timer + dt);
        if (state.timer <= 0) startPlay();
        break;
      case PHASE.GOAL:
        state.timer -= dt;
        if (state.stage === 0) {
          if (state.timer <= 0) {
            state.stage = 1;
            state.timer = SERVE_COUNTDOWN_S;
            emit('countdown', W / 2, bottom / 2, SERVE_COUNTDOWN_S);
          }
        } else if (state.timer <= 0) {
          startPlay();
        }
        break;
      case PHASE.PLAY: {
        if (battleMode) battleTick(dt);
        const h = dt / SUBSTEPS;
        for (let i = 0; i < SUBSTEPS && state.phase === PHASE.PLAY; i++) stepPuck(h);
        if (glitchMode && state.phase === PHASE.PLAY) glitchTick();
        break;
      }
      case PHASE.OVER:
        break;
    }
  }

  function restart() {
    state.score.host = 0;
    state.score.guest = 0;
    state.winner = null;
    state.lastGoalBy = null;
    state.phase = PHASE.READY;
    state.ready.host = false;
    state.ready.guest = cfg.players === 'bot';
    state.timer = 3;
    state.stage = 0;
    lastTick = Infinity;
    seamStill = 0;
    state.serveTo = rng() < 0.5 ? 'host' : 'guest';
    updateGoalWidths();
    if (battleMode) battleReset();
    rearmAll();
    placePuckForServe();
  }

  /** Mark a side ready (or not) during the pre-match phase. When both sides are
   *  ready the countdown starts. The bot's side is always ready. Returns true
   *  when the call was accepted (phase 'ready', valid role). */
  function setReady(role, value = true) {
    if (state.phase !== PHASE.READY) return false;
    if (role !== 'host' && role !== 'guest') return false;
    const v = !!value;
    if (role === 'guest' && cfg.players === 'bot') return v; // always ready
    if (state.ready[role] === v) return true;
    state.ready[role] = v;
    if (!v) return true;
    emit('ready', W / 2, bottom / 2, 1, { by: role });
    if (state.ready.host && state.ready.guest) {
      state.phase = PHASE.COUNTDOWN;
      state.timer = 3;
      state.stage = 0;
      lastTick = Infinity;
      emit('go', W / 2, bottom / 2, 1);
    }
    return true;
  }

  /** Change the seam gap (mm of bezel, in world px) while phase is 'ready'.
   *  Recomputes every derived bound and obstacle layout in place. */
  function setGap(newG) {
    if (state.phase !== PHASE.READY) return false;
    if (!(typeof newG === 'number' && Number.isFinite(newG)) || newG < 0) return false;
    const delta = newG - G;
    G = newG;
    cfg.G = newG;
    seamBottom = H + G;
    bottom = 2 * H + G;
    geom.bottom = bottom;
    sideGeom.host.bottom = bottom;
    sideGeom.guest.bottom = bottom;
    // The host's half slides down with the gap; keep the mallet at the same
    // place relative to the host's own goal, then clamp it into the half.
    const mh = state.mallets.host;
    mh.y += delta;
    mh.vx = 0;
    mh.vy = 0;
    clampMallet('host', mh);
    clampMallet('guest', state.mallets.guest);
    obstacles.length = 0;
    obstacles.push(...buildObstacles());
    if (bot) makeBot();
    placePuckForServe();
    return true;
  }

  /** Events accumulated since the previous call (also returned by snapshot). */
  function drainEvents() {
    const out = events;
    events = [];
    return out;
  }

  /** Compact snapshot streamed to the guest every frame. Drains the event
   *  queue, so call it once per frame and pass the result to every consumer
   *  (the host's own view included). */
  function snapshot() {
    const p = state.puck;
    const mh = state.mallets.host;
    const mg = state.mallets.guest;
    const ob = obstacles.map((o) => ({
      k: o.k,
      x: r(o.x),
      y: r(o.y),
      r: r(o.r),
      a: o.k === 'bumper' ? 1 : o.k === 'bomb' ? (o.armed ? 1 : 0) : o.k === 'box' ? (o.on ? 1 : 0) : state.time >= o.rearmAt ? 1 : 0,
    }));
    const snap = {
      t: 's',
      seq: ++seq,
      ts: Math.round(state.time * 1000) / 1000,
      sv: state.serveTo,
      p: [r(p.x), r(p.y), r(p.vx), r(p.vy)],
      m: [r(mh.x), r(mh.y), r(mg.x), r(mg.y)],
      sc: [state.score.host, state.score.guest],
      ph: state.phase,
      rd: [state.ready.host ? 1 : 0, state.ready.guest ? 1 : 0],
      g: G,
      tm: Math.round(state.timer * 100) / 100,
      sd: state.stage,
      lg: state.lastGoalBy,
      wn: state.winner,
      gw: [r(state.gw[0]), r(state.gw[1])],
      ob,
      ev: null,
    };
    if (battleMode) {
      const b = state.bt;
      const r2 = (v) => Math.round(v * 100) / 100;
      snap.it = [state.items.host || '', state.items.guest || ''];
      snap.bt = {
        sh: [r2(b.sh[0]), r2(b.sh[1])],
        gh: [r2(b.gh[0]), r2(b.gh[1])],
        sk: [r2(b.sk[0]), r2(b.sk[1])],
        fz: r2(b.fz),
        rk: [b.rk[0], b.rk[1]],
        mr: [r(b.mr[0]), r(b.mr[1])],
      };
    }
    snap.ev = drainEvents();
    return snap;
  }

  updateGoalWidths();
  placePuckForServe();
  return { state, cfg, step, setMallet, setReady, setGap, restart, snapshot, drainEvents, obstacles, useItem };
}

function r(v) {
  return Math.round(v * 10) / 10;
}
