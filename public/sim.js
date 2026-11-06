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

export const MODES = ['classic', 'bumpers', 'ice', 'mines', 'bombs', 'glitch', 'battle', 'random'];

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
  random: { fric: 0.8, wall: 0.92, mallet: 0.85, max: 2600 },
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
export const ITEMS = [
  'rocket', 'shield', 'ghost', 'shrink', 'freeze',
  'magnet', 'widegoal', 'goalie', 'giant', 'catch', 'mirror', 'quake', 'decoys', 'steal', 'tinypuck',
];
const OFFENSIVE_ITEMS = ['rocket', 'ghost', 'shrink', 'magnet', 'widegoal', 'mirror', 'quake', 'decoys', 'steal'];
const PASS_BANNED = ['ghost', 'mirror', 'decoys']; // one shared screen: these would hit both players
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
const MAGNET_S = 2;
const MAGNET_MIN = 700; // px/s
const MAGNET_RATE = 6; // 1/s
const WIDEGOAL_S = 6;
const WIDEGOAL_MULT = 1.5;
const WIDEGOAL_MAX = 0.6; // of W
const GOALIE_S = 5;
const GOALIE_R_FACTOR = 0.55; // of malletR
const GOALIE_LINE = 0.9; // of malletR, from the end rail
const GOALIE_SPEED = 1.4; // of W, px/s
const GIANT_S = 5;
const GIANT_FACTOR = 1.5;
const CATCH_HOLD_S = 1.5;
const CATCH_FLICK = 900; // px/s of mallet speed that releases a held puck
const CATCH_FLING_MULT = 1.5;
const CATCH_DROP = 600; // px/s when the hold times out
const MIRROR_S = 3;
const QUAKE_S = 2;
const QUAKE_FOLLOW = 0.6; // fraction of each move a quaking mallet makes
const DECOY_S = 3;
const DECOY_SLOW = 300; // px/s: slower pucks send decoys at the target goal
const DECOY_SPEED = 800;
const TINY_S = 5;
const TINY_FACTOR = 0.6; // of puckR
const BOT_HOLD_MIN_S = 1;
const BOT_HOLD_MAX_S = 2.5;
const BOT_WAIT_S = 10; // shield / freeze: use anyway this long after the hold time
const MAX_MALLET_SPEED = 3200; // px/s
const SERVE_SPEED = 600;
const SUBSTEPS = 4;
const GOAL_PAUSE_S = 1.6;
const SERVE_COUNTDOWN_S = 1;
const EVENT_CAP = 16;
// Random mode: one twist per match.
export const TWISTS = ['twinpuck', 'movinggoals', 'gravity', 'blackout', 'wind', 'hotpotato', 'shrinking', 'turbo'];
const TWIN_REST = 0.9; // puck vs puck restitution
const GOAL_SWING = 0.2; // of W, moving goals amplitude
const GOAL_PERIOD_S = 4;
const WELL_K = 0.105; // of W^3
const WELL_S = 0.16; // of W, softening
const WELL_SWALLOW_R = 0.03; // of W
const WELL_SWALLOW_V = 500; // px/s
const WELL_HOLD_S = 0.7;
const WELL_SPIT_V = 900; // px/s
const WIND_ACC = 0.15; // of W, px/s^2
const WIND_TURN_S = 8;
const FUSE_MAX_S = 6;
const FUSE_MIN_S = 2;
const FUSE_PER_HIT_S = 0.5;
const SHRINK_RATE = 0.01; // of W per second
const SHRINK_MAX = 0.25; // of W
const TURBO_MULT = 1.1;
const TURBO_K_MAX = 2;

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

/** Rail bounces for the puck. g = {puckR, W, bottom, left?}: the side rails
 *  are at x = left (default 0) and x = W. `mouth(x, side)` says
 *  whether x is inside the goal mouth on side 'guest' (top) or 'host' (bottom).
 *  `onWall(vn)` is called with the impact speed of every rail bounce. Returns
 *  the side that was scored on ('guest' | 'host') when the puck fully entered
 *  a goal mouth, else null. */
function railBounce(p, g, phys, mouth, onWall) {
  const { puckR, W, bottom } = g;
  const left = g.left || 0;
  // Side rails.
  if (p.x < left + puckR) {
    p.x = left + puckR;
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
  const left = g.left || 0;
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
  if (p.x < left + puckR) {
    p.x = left + puckR;
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
  p.x = clamp(p.x, left + puckR, W - puckR);
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

const NO_GX = [0, 0];
const mouthFor = (W, gw, gx) => (x, side) =>
  side === 'guest' ? Math.abs(x - W / 2 - gx[1]) < gw[1] / 2 : Math.abs(x - W / 2 - gx[0]) < gw[0] / 2;

/** Shared-helper geometry and physics from a snapshot's optional fields:
 *  pr (puck radius), tx.in (side rail inset), tx.k (turbo cap multiplier). */
function snapGeom(snap, cfg, bottom) {
  const tx = snap && snap.tx;
  const inset = tx && tx.in > 0 ? tx.in : 0;
  const pr = snap && snap.pr > 0 ? snap.pr : cfg.puckR;
  return { puckR: pr, malletR: cfg.malletR, W: cfg.W - inset, left: inset, bottom };
}
const physScratch = {}; // reused by snapPhys so the Turbo helpers do not allocate per call
function snapPhys(snap, cfg) {
  const phys = physOf(cfg.mode);
  const k = snap && snap.tx && snap.tx.k > 1 ? snap.tx.k : 1;
  if (!(k > 1)) return phys;
  for (const key in phys) physScratch[key] = phys[key];
  physScratch.max = phys.max * k;
  return physScratch;
}
const NO_MOUTH = () => false;

/**
 * Pure: would the local mallet touch the puck within `dtSeconds`?
 *   snap  snapshot object ({p:[x,y,vx,vy], g?, gw?, gx?, pr?, tx?, tw?}); only
 *         p (and optionally g = seam gap, gw = goal widths, gx = goal offsets,
 *         pr = puck radius, tx.in = rail inset, tx.k = turbo cap, tw = twist:
 *         'turbo' adds the per-hit speed up) are read
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
  const phys = snapPhys(snap, cfg);
  const Gp = typeof snap.g === 'number' ? snap.g : cfg.G;
  const g = snapGeom(snap, cfg, 2 * cfg.H + Gp);
  const gw = snap.gw || [cfg.goalW, cfg.goalW];
  const mouth = cfg.goalW || snap.gw ? mouthFor(cfg.W, gw, snap.gx || NO_GX) : NO_MOUTH;
  const mvx = mallet.vx || 0;
  const mvy = mallet.vy || 0;
  const dt = Math.max(0, dtSeconds || 0);
  // Relative sweep distance decides how finely to sample (half a puck radius).
  const rel = Math.hypot(sp[2] - mvx, sp[3] - mvy) * dt;
  const steps = clamp(Math.ceil(rel / (g.puckR * 0.5)), 1, 24);
  const p = { x: 0, y: 0, vx: sp[2], vy: sp[3] };
  const m = { x: 0, y: 0, vx: mvx, vy: mvy };
  for (let i = 0; i <= steps; i++) {
    const t = (dt * i) / steps;
    p.x = sp[0] + sp[2] * t;
    p.y = sp[1] + sp[3] * t;
    m.x = mallet.x + mvx * t;
    m.y = mallet.y + mvy * t;
    const hit = malletHit(p, m, role, g, phys, mouth);
    if (!hit) continue;
    if (hit.vn < 0 && snap.tw === 'turbo') {
      // Turbo: the sim speeds the puck up 10 percent per hit and raises the cap.
      const k = Math.min(TURBO_K_MAX, (phys.max / physOf(cfg.mode).max) * TURBO_MULT);
      const cap = physOf(cfg.mode).max * k;
      p.vx *= TURBO_MULT;
      p.vy *= TURBO_MULT;
      const s = Math.hypot(p.vx, p.vy);
      if (s > cap) {
        p.vx *= cap / s;
        p.vy *= cap / s;
      }
    }
    return [p.x, p.y, p.vx, p.vy];
  }
  return null;
}

/**
 * Pure: advance a puck [x, y, vx, vy] by `dtSeconds` with the mode's friction
 * and rail bounces (no goals, no mallets, no obstacles; the end rails are
 * solid). cfg needs {puckR, W, H, G, mode}. Returns a NEW [x, y, vx, vy]. Uses
 * the same per-step code as the sim, in sub-steps of at most 1/240 s. The
 * optional `snap` supplies pr, tx.in and tx.k (see predictMalletHit).
 */
export function advancePuck(pArr, cfg, dtSeconds, snap) {
  const phys = snapPhys(snap, cfg);
  const g = snapGeom(snap, cfg, 2 * cfg.H + cfg.G);
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
  if (cfg.twist !== undefined && !(cfg.mode === 'random' && TWISTS.includes(cfg.twist))) delete cfg.twist;

  const { W, H, malletR, goalW, target, mode } = cfg;
  const puckR0 = cfg.puckR; // base puck radius; `puckR` below follows tinypuck
  let puckR = puckR0;
  let railL = 0; // side rails at x = railL and x = railR (the shrinking rink moves them)
  let railR = W;
  let G = cfg.G; // seam gap; adjustable through setGap() while phase is 'ready'
  const rng = opts.rng || Math.random;
  const phys = MODE_PHYS[mode];
  const battleMode = mode === 'battle';
  const randomMode = mode === 'random';
  const physRocket = { ...phys, max: ROCKET_MAX }; // puck cap while a rocket flies
  const MAX_PUCK_SPEED = phys.max;
  const seamTop = H; // where the guest half ends
  let seamBottom = H + G; // where the host half starts
  let bottom = 2 * H + G;
  // Shared-helper geometry: bottom follows setGap(), puckR follows tinypuck,
  // left / W are the side rails (shrinking rink). syncGeom() keeps them in step.
  const geom = { puckR, malletR, W, bottom, left: 0 };
  // Per-side geometry for mallet hits: in battle mode a shrunk mallet has its
  // own radius, so host and guest each get their own object.
  const sideGeom = battleMode ? { host: { ...geom }, guest: { ...geom } } : { host: geom, guest: geom };
  const goalieGeom = { ...geom, malletR: malletR * GOALIE_R_FACTOR };
  const geoms = [geom, sideGeom.host, sideGeom.guest, goalieGeom];
  function syncGeom() {
    for (const g of geoms) {
      g.puckR = puckR;
      g.W = railR;
      g.left = railL;
      g.bottom = bottom;
    }
  }

  const state = {
    phase: PHASE.READY,
    ready: { host: false, guest: cfg.players === 'bot' }, // the bot is always ready
    timer: 3,
    stage: 0, // 1 during the post-goal mini countdown (phase stays 'goal')
    time: 0, // simulated seconds since creation
    serveTo: rng() < 0.5 ? 'host' : 'guest',
    puck: { x: W / 2, y: bottom / 2, vx: 0, vy: 0, ss: 0 }, // ss = seconds at rest in the seam gap
    pucks: null, // [puck] or, with the twin puck twist, [puck, second puck]
    pr: puckR, // current puck radius
    gx: [0, 0], // goal mouth centre offsets from W / 2 [host, guest]
    lastHit: null, // side whose mallet (or goalie) last touched the puck; null after each serve
    twist: null, // random mode: the twist id
    tx: null, // random mode: twist data (streamed as snap.tx)
    mallets: {
      host: { x: W / 2, y: bottom - H * 0.2, vx: 0, vy: 0, lastT: 0 },
      guest: { x: W / 2, y: H * 0.2, vx: 0, vy: 0, lastT: 0 },
    },
    score: { host: 0, guest: 0 },
    gw: [goalW, goalW], // current goal widths [host, guest]
    lastGoalBy: null,
    winner: null,
  };
  state.pucks = [state.puck];
  const puck2 = { x: W / 2, y: bottom / 2, vx: 0, vy: 0, ss: 0 }; // twin puck (in pucks only while it runs)
  if (battleMode) {
    state.items = { host: null, guest: null };
    state.bt = {
      sh: [0, 0], gh: [0, 0], sk: [0, 0], fz: 0, rk: [0, 0], mr: [malletR, malletR],
      mg: [0, 0], wg: [0, 0], mi: [0, 0], qk: [0, 0], dc: [0, 0],
      go: [0, 0], gi: [0, 0], ca: [0, 0], ct: [0, 0], tp: 0,
    };
  }

  let events = [];
  let seq = 0;
  let lastTick = Infinity;
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
  const decoys = []; // decoy pucks {x, y, vx, vy, t (target index), by (user index)}
  let rallyHits = 0; // mallet hits since the serve (hot potato, turbo)
  // Random mode bookkeeping.
  const physTurbo = { ...phys }; // its max follows tx.k
  let swallowed = false; // gravity: the puck sits in the well
  let windT = 0; // wind: play seconds until the next turn
  let windAng = 0;
  let windOn = false; // the first direction is chosen at the first serve

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
      if (o.k === 'box' || o.k === 'goalie') continue; // these have their own timers
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

  function collideObstacles(p) {
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      // Bombs are bodies (stepBombs), boxes are not solid, goalies hit like mallets.
      if (o.k === 'bomb' || o.k === 'box' || o.k === 'goalie') continue;
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
        o.rearmAt = state.time + MINE_REARM_S;
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
  function clampPuck(p = state.puck) {
    p.x = clamp(p.x, railL + puckR, railR - puckR);
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

  /** The puck that threatens the guest (bot) goal soonest: the one heading
   *  to y = 0 that gets there first, else the one closest to that goal. */
  function botThreat() {
    const ps = state.pucks;
    if (ps.length < 2) return state.puck;
    let best = null;
    let bestT = Infinity;
    for (const q of ps) {
      if (q.vy < 0) {
        const t = q.y / -q.vy;
        if (t < bestT) {
          bestT = t;
          best = q;
        }
      }
    }
    if (best) return best;
    best = ps[0];
    for (const q of ps) if (q.y < best.y) best = q;
    return best;
  }

  // --- serving --------------------------------------------------------------

  function placePuckForServe() {
    const p = state.puck;
    p.vx = 0;
    p.vy = 0;
    p.x = W / 2;
    // Serve into the half of the player who receives the puck.
    const hostY = seamBottom + H / 2;
    const guestY = seamTop - H / 2;
    p.y = state.serveTo === 'host' ? hostY : guestY;
    if (state.pucks.length > 1) {
      // The twin waits in the other half.
      puck2.vx = 0;
      puck2.vy = 0;
      puck2.x = W / 2;
      puck2.y = state.serveTo === 'host' ? guestY : hostY;
    }
    swallowed = false;
    if (state.tx && state.tx.sw !== undefined) state.tx.sw = 0;
  }

  function launchServe() {
    const p = state.puck;
    p.x = W / 2;
    p.y = bottom / 2; // inside the seam gap, heading toward the receiver
    const dir = state.serveTo === 'host' ? 1 : -1;
    const angle = (rng() - 0.5) * 0.8;
    p.vx = Math.sin(angle) * SERVE_SPEED;
    p.vy = Math.cos(angle) * SERVE_SPEED * dir;
    p.ss = 0;
    if (state.pucks.length > 1) {
      // The twin leaves its waiting spot (centre of the other half, where
      // placePuckForServe parked it) towards that half's own goal, so each
      // player receives one puck.
      const a2 = (rng() - 0.5) * 0.8;
      puck2.x = W / 2;
      puck2.y = state.serveTo === 'host' ? seamTop - H / 2 : seamBottom + H / 2;
      puck2.vx = Math.sin(a2) * SERVE_SPEED;
      puck2.vy = -Math.cos(a2) * SERVE_SPEED * dir;
      puck2.ss = 0;
    }
    rearmAll();
    state.lastHit = null;
    rallyHits = 0;
    if (randomMode) twistServe();
    if (battleMode) {
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
    m.x = Math.min(railR - rr, Math.max(railL + rr, m.x));
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
    if (battleMode && state.bt.qk[sideIdx(role)] > 0) {
      // Quake: the mallet only makes part of each move.
      x = prevX + (x - prevX) * QUAKE_FOLLOW;
      y = prevY + (y - prevY) * QUAKE_FOLLOW;
    }
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
    if (side === 'guest') return Math.abs(x - W / 2 - state.gx[1]) < state.gw[1] / 2;
    return Math.abs(x - W / 2 - state.gx[0]) < state.gw[0] / 2;
  }

  /** Physics for the puck right now: rocket flight and turbo raise the cap. */
  function curPhys() {
    if (battleMode && rocketT > 0) return physRocket;
    if (randomMode && state.twist === 'turbo') return physTurbo;
    return phys;
  }

  /** A puck that skips all physics (frozen, held by a catch, swallowed). */
  function puckParked() {
    if (swallowed) return true;
    if (!battleMode) return false;
    const bt = state.bt;
    return bt.fz > 0 || bt.ct[0] > 0 || bt.ct[1] > 0;
  }

  /** Mallet `m` against every puck in play. */
  function collideMallet(m, role) {
    if (bombMode && detonateCheck(m, role)) return;
    for (let i = 0; i < state.pucks.length; i++) malletPuck(m, role, state.pucks[i]);
  }

  function malletPuck(m, role, p) {
    if (puckParked()) return; // frozen, caught or swallowed: mallets do nothing
    if (battleMode) {
      const idx = sideIdx(role);
      const bt = state.bt;
      const hit = malletHit(p, m, role, sideGeom[role], curPhys(), mouthB);
      if (!hit) return;
      state.lastHit = role;
      if (bt.ca[idx]) {
        catchPuck(idx, p);
        return;
      }
      if (hit.vn < 0) {
        const s = Math.min(1, -hit.vn / 2000);
        if (s > 0.03) emit('hit', p.x - hit.nx * puckR, p.y - hit.ny * puckR, s);
        if (bt.mg[idx] > 0) {
          bt.mg[idx] = 0;
          emit('magnetoff', p.x, p.y, 1, { by: role });
        }
        rocketHit(role, hit, p);
      }
      return;
    }
    const hit = malletHit(p, m, role, geom, curPhys(), inMouth);
    if (!hit) return;
    state.lastHit = role;
    if (hit.vn < 0) {
      const s = Math.min(1, -hit.vn / 2000);
      if (s > 0.03) emit('hit', p.x - hit.nx * puckR, p.y - hit.ny * puckR, s);
      rallyHits += 1;
      if (randomMode) twistHit(p);
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
    if (battleMode) {
      // Wide goal: the target's mouth grows while the timer runs.
      if (state.bt.wg[0] > 0) h = Math.min(h * WIDEGOAL_MULT, W * WIDEGOAL_MAX);
      if (state.bt.wg[1] > 0) g = Math.min(g * WIDEGOAL_MULT, W * WIDEGOAL_MAX);
    }
    state.gw = [h, g];
  }

  /** `extra` {x, y, why} marks a goal that did not come from the puck (a bomb
   *  going off, a hot potato): the event is placed at x, y and carries `why`.
   *  `p` is the puck that went in (twin puck). */
  function goal(scoredOn, extra, p = state.puck) {
    const scorer = scoredOn === 'host' ? 'guest' : 'host';
    if (extra) emit('goal', extra.x, extra.y, 1, { by: scorer, why: extra.why });
    else emit('goal', p.x, scoredOn === 'guest' ? 0 : bottom, 1, { by: scorer });
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
    if (randomMode) twistGoal();
    placePuckForServe();
  }

  // --- puck physics ---------------------------------------------------------

  let curP = state.puck; // the puck stepPuck is working on (wallBounce reads it)

  /** One substep for every puck, plus whatever moves with them. */
  function substep(dt) {
    if (battleMode) {
      catchTick();
      goalieTick(dt);
      stepDecoys(dt);
    }
    const n = state.pucks.length;
    for (let j = 0; j < n && state.phase === PHASE.PLAY; j++) stepPuck(state.pucks[j], dt);
    if (n > 1 && state.phase === PHASE.PLAY) puckPuck(state.pucks[0], state.pucks[1]);
  }

  function stepPuck(p, dt) {
    if (puckParked()) return; // frozen, held or swallowed: no motion, no collisions
    if (battleMode) magnetPull(p, dt);
    else if (randomMode) {
      twistForces(p, dt);
      if (swallowed) return; // the well just took it
    }
    const ph = curPhys();
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
    curP = p;
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
    if (scoredOn) return goal(scoredOn, null, p);

    // Mallets first, obstacles last, so a mallet can never shove the puck
    // into a bumper and keep it there with energy gained from the squeeze.
    const mh = state.mallets.host;
    const mg = state.mallets.guest;
    for (let i = 0; i < 3; i++) {
      if (bombMode && detonateCheck(mh, 'host')) return;
      malletPuck(mh, 'host', p);
      if (bombMode && detonateCheck(mg, 'guest')) return;
      malletPuck(mg, 'guest', p);
      if (obstacles.length) {
        if (battleMode) goaliesPuck(p);
        collideObstacles(p);
      }
      if (state.phase !== PHASE.PLAY) return; // a bomb went off
      if (puckParked()) return; // a catch took it
    }
    // Bombs are bodies: the puck and each other can shove them around.
    if (bombMode) {
      stepBombs(dt);
      if (state.phase !== PHASE.PLAY) return;
    }
    if (battleMode) collectBoxes(p);
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
    p.x = clamp(p.x, railL + puckR, railR - puckR);

    // A puck that dies in the seam gap is out of reach of both players.
    if (G > 2 * puckR) {
      const inGap = p.y > seamTop + puckR && p.y < seamBottom - puckR;
      if (inGap && Math.hypot(p.vx, p.vy) < 30) {
        p.ss += dt;
        if (p.ss > 1.2) {
          const dir = rng() < 0.5 ? 1 : -1;
          p.vx = (rng() - 0.5) * 80;
          p.vy = dir * 260;
          p.ss = 0;
        }
      } else {
        p.ss = 0;
      }
    }
  }

  /** Twin pucks: equal masses, restitution 0.9, pushed apart evenly. */
  function puckPuck(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const minDist = 2 * puckR;
    const d2 = dx * dx + dy * dy;
    if (d2 >= minDist * minDist) return;
    const d = Math.sqrt(d2);
    const nx = d < 1e-6 ? 0 : dx / d;
    const ny = d < 1e-6 ? 1 : dy / d;
    const push = (minDist - d + 0.01) / 2;
    a.x -= nx * push;
    a.y -= ny * push;
    b.x += nx * push;
    b.y += ny * push;
    const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (vn < 0) {
      const j = (-(1 + TWIN_REST) * vn) / 2;
      a.vx -= j * nx;
      a.vy -= j * ny;
      b.vx += j * nx;
      b.vy += j * ny;
      const s = Math.min(1, -vn / 2000);
      if (s > 0.02) emit('clack', a.x + nx * puckR, a.y + ny * puckR, s);
    }
    clampPuck(a);
    clampPuck(b);
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

  /** Change a side's mallet radius (physics and clamping follow). */
  function setMalletRadius(idx, rad) {
    const role = idx === 0 ? 'host' : 'guest';
    state.bt.mr[idx] = rad;
    sideGeom[role].malletR = rad;
    clampMallet(role, state.mallets[role]);
  }

  /** Mallet radius from shrink and giant: malletR * 0.6 (shrunk) * 1.5 (giant). */
  function refreshRadius(idx) {
    const bt = state.bt;
    const rad = malletR * (bt.sk[idx] > 0 ? SHRINK_FACTOR : 1) * (bt.gi[idx] > 0 ? GIANT_FACTOR : 1);
    if (bt.mr[idx] !== rad) setMalletRadius(idx, rad);
  }

  /** Change the puck radius for every collision (tinypuck). */
  function setPuckRadius(rad) {
    puckR = rad;
    state.pr = rad;
    syncGeom();
  }

  /** Remove obstacles of kind `k` (and, when given, target `t`) in place. */
  function removeObstacles(k, t) {
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      if (o.k === k && (t === undefined || o.t === t)) obstacles.splice(i, 1);
    }
  }

  /** Drop every timed effect except rocket and catch arming (goals and
   *  restart). The frozen or held puck is not released: the caller
   *  repositions it. */
  function battleClear() {
    const bt = state.bt;
    for (const key of ['sh', 'gh', 'sk', 'mg', 'wg', 'mi', 'qk', 'dc', 'go', 'gi', 'ct']) bt[key][0] = bt[key][1] = 0;
    bt.fz = 0;
    bt.tp = 0;
    rocketT = 0;
    for (let i = 0; i < 2; i++) refreshRadius(i);
    if (puckR !== puckR0) setPuckRadius(puckR0);
    removeObstacles('goalie');
    decoys.length = 0;
    updateGoalWidths();
  }

  /** New match: held items, rocket and catch arming, boxes and the bot's hold clock. */
  function battleReset() {
    battleClear();
    state.bt.ca[0] = state.bt.ca[1] = 0;
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
    // Pass and play shares one screen: ghost, mirror and decoys would hit both players.
    if (cfg.players === 'pass' && PASS_BANNED.includes(item)) item = pick();
    if (cfg.players === 'pass' && PASS_BANNED.includes(item)) item = 'shield';
    return item;
  }

  /** The puck touches an active box: the player on the OTHER side of the
   *  table gets an item, provided they hit the puck last (or nobody did).
   *  Dribbling the puck through a box in your own half does nothing, so the
   *  only way to collect is to shoot through a box on the far side. */
  function collectBoxes(p) {
    for (const b of boxes) {
      if (!b.on) continue;
      if (Math.hypot(p.x - b.x, p.y - b.y) >= puckR + b.r) continue;
      const side = b.y > H + G / 2 ? 'guest' : 'host'; // the far side of the box
      if (state.lastHit && state.lastHit !== side) continue; // your own box: pass through
      if (state.items[side]) continue; // a full slot cannot collect: the puck passes through
      const item = rollItem(side);
      state.items[side] = item;
      b.on = false;
      b.spawnAt = state.time + rand(BOX_RESPAWN_MIN_S, BOX_RESPAWN_MAX_S);
      emit('box', b.x, b.y, 1, { by: side, item });
    }
  }

  /** A spot for a new box: clear of the puck and both mallets. */
  function boxSpotOk(sp, rad) {
    const p = state.puck;
    if (Math.hypot(sp.x - p.x, sp.y - p.y) < puckR * 3) return false;
    for (const role of ['host', 'guest']) {
      const m = state.mallets[role];
      if (Math.hypot(sp.x - m.x, sp.y - m.y) < malletR * 2.5 + rad) return false;
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
  function rocketHit(role, hit, p) {
    const idx = sideIdx(role);
    if (!state.bt.rk[idx]) return;
    state.bt.rk[idx] = 0;
    const sp = Math.hypot(p.vx, p.vy);
    const ux = sp > 1e-6 ? p.vx / sp : hit.nx;
    const uy = sp > 1e-6 ? p.vy / sp : hit.ny;
    const ns = Math.min(ROCKET_MAX, Math.max(ROCKET_MIN, sp * ROCKET_MULT));
    p.vx = ux * ns;
    p.vy = uy * ns;
    rocketT = ROCKET_FLIGHT_S;
    emit('rocket', p.x, p.y, 1, { by: role });
  }

  const roleOf = (idx) => (idx === 0 ? 'host' : 'guest');

  /** Magnet: each running magnet steers the puck towards its target's mouth. */
  function magnetPull(p, dt) {
    const bt = state.bt;
    for (let t = 0; t < 2; t++) {
      if (bt.mg[t] <= 0) continue;
      const dx = W / 2 + state.gx[t] - p.x;
      const dy = (t === 0 ? bottom : 0) - p.y;
      const d = Math.hypot(dx, dy) || 1;
      const sp = Math.max(Math.hypot(p.vx, p.vy), MAGNET_MIN);
      const k = 1 - Math.exp(-MAGNET_RATE * dt);
      p.vx += ((dx / d) * sp - p.vx) * k;
      p.vy += ((dy / d) * sp - p.vy) * k;
    }
  }

  // Goalie: a small mallet on the owner's goal line.
  const goalieY = (o) => (o === 0 ? bottom - GOALIE_LINE * malletR : GOALIE_LINE * malletR);

  function placeGoalie(o) {
    for (const q of obstacles) if (q.k === 'goalie' && q.a === o) return; // already out: the timer restarts
    const rad = malletR * GOALIE_R_FACTOR;
    obstacles.push({ k: 'goalie', x: W / 2 + state.gx[o], y: goalieY(o), r: rad, a: o, t: o, vx: 0, vy: 0 });
  }

  /** Slide each goalie along its line towards where the puck will cross it. */
  function goalieTick(dt) {
    const p = state.puck;
    for (const g of obstacles) {
      if (g.k !== 'goalie') continue;
      g.y = goalieY(g.a);
      let tx = p.x;
      const coming = g.a === 0 ? p.vy > 1 : p.vy < -1;
      if (coming) tx = p.x + (p.vx * (g.y - p.y)) / p.vy;
      const cx = W / 2 + state.gx[g.a];
      const half = state.gw[g.a] / 2 + g.r;
      tx = clamp(tx, cx - half, cx + half);
      tx = clamp(tx, railL + g.r, railR - g.r);
      const maxStep = GOALIE_SPEED * W * dt;
      const dx = clamp(tx - g.x, -maxStep, maxStep);
      g.x += dx;
      g.vx = dx / dt;
      g.vy = 0;
    }
  }

  /** Goalies hit the puck exactly like mallets. */
  function goaliesPuck(p) {
    for (const g of obstacles) {
      if (g.k !== 'goalie') continue;
      const role = roleOf(g.a);
      const hit = malletHit(p, g, role, goalieGeom, curPhys(), mouthB);
      if (!hit) continue;
      state.lastHit = role;
      if (hit.vn < 0) {
        const s = Math.min(1, -hit.vn / 2000);
        if (s > 0.03) emit('goaliehit', p.x - hit.nx * puckR, p.y - hit.ny * puckR, s, { by: role });
      }
    }
  }

  // Catch: the armed side's next contact holds the puck in front of its mallet.
  const CATCH_MIN_S = 0.15; // a flick only counts after this much hold time

  function catchPuck(idx, p) {
    const bt = state.bt;
    bt.ca[idx] = 0;
    bt.ct[idx] = CATCH_HOLD_S;
    holdPuck(idx);
    emit('catch', p.x, p.y, 1, { by: roleOf(idx) });
  }

  function holdPuck(idx) {
    const p = state.puck;
    const m = state.mallets[roleOf(idx)];
    const s = idx === 0 ? -1 : 1;
    p.x = clamp(m.x, railL + puckR, railR - puckR);
    p.y = m.y + s * (state.bt.mr[idx] + puckR + 1);
    p.vx = 0;
    p.vy = 0;
  }

  /** Per substep: a held puck follows its mallet; a flick releases it. */
  function catchTick() {
    const bt = state.bt;
    for (let i = 0; i < 2; i++) {
      if (bt.ct[i] <= 0) continue;
      const m = state.mallets[roleOf(i)];
      if (bt.ct[i] < CATCH_HOLD_S - CATCH_MIN_S && Math.hypot(m.vx, m.vy) > CATCH_FLICK) releaseCatch(i, true);
      else holdPuck(i);
    }
  }

  /** Let go of a held puck: flung along the mallet (flick) or dropped forward. */
  function releaseCatch(idx, flick) {
    const bt = state.bt;
    const p = state.puck;
    const role = roleOf(idx);
    const m = state.mallets[role];
    const s = idx === 0 ? -1 : 1;
    holdPuck(idx);
    bt.ct[idx] = 0;
    if (flick) {
      p.vx = m.vx * CATCH_FLING_MULT;
      p.vy = m.vy * CATCH_FLING_MULT;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > phys.max) {
        p.vx *= phys.max / sp;
        p.vy *= phys.max / sp;
      }
    } else {
      p.vx = 0;
      p.vy = s * CATCH_DROP;
    }
    p.ss = 0;
    state.lastHit = role;
    emit('fling', p.x, p.y, Math.min(1, Math.hypot(p.vx, p.vy) / phys.max), { by: role });
    if (bt.rk[idx]) {
      HIT.vn = 0;
      HIT.nx = 0;
      HIT.ny = s;
      rocketHit(role, HIT, p);
    }
    if (bt.fz > 0) {
      // Frozen while held: the fling waits for the thaw.
      frozenVx = p.vx;
      frozenVy = p.vy;
      p.vx = 0;
      p.vy = 0;
    }
  }

  /** Decoys: two fake pucks fan out from the real one. */
  function spawnDecoys(ti, role) {
    removeDecoys(ti);
    const p = state.puck;
    const sp = Math.hypot(p.vx, p.vy);
    const deg = Math.PI / 180;
    for (const sgn of [1, -1]) {
      let vx;
      let vy;
      if (sp > DECOY_SLOW) {
        const a = sgn * rand(25, 40) * deg;
        const k = rand(0.9, 1.1);
        const c = Math.cos(a);
        const sn = Math.sin(a);
        vx = (p.vx * c - p.vy * sn) * k;
        vy = (p.vx * sn + p.vy * c) * k;
      } else {
        const base = Math.atan2((ti === 0 ? bottom : 0) - p.y, W / 2 + state.gx[ti] - p.x);
        const a = base + rand(-30, 30) * deg;
        vx = Math.cos(a) * DECOY_SPEED;
        vy = Math.sin(a) * DECOY_SPEED;
      }
      decoys.push({ x: p.x, y: p.y, vx, vy, t: ti });
    }
    state.bt.dc[ti] = DECOY_S;
    emit('decoys', p.x, p.y, 1, { by: role });
  }

  function removeDecoys(t) {
    for (let i = decoys.length - 1; i >= 0; i--) if (decoys[i].t === t) decoys.splice(i, 1);
  }

  /** Decoys slide with friction, bounce off the side rails and the user's end
   *  rail, ignore everything else and vanish past the target's goal line. */
  function stepDecoys(dt) {
    if (!decoys.length) return;
    for (let i = decoys.length - 1; i >= 0; i--) {
      const d = decoys[i];
      frictionStep(d, phys, dt);
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.x < railL + puckR) {
        d.x = railL + puckR;
        d.vx = Math.abs(d.vx) * phys.wall;
      } else if (d.x > railR - puckR) {
        d.x = railR - puckR;
        d.vx = -Math.abs(d.vx) * phys.wall;
      }
      let gone = false;
      if (d.t === 0) {
        if (d.y < puckR) {
          d.y = puckR;
          d.vy = Math.abs(d.vy) * phys.wall;
        }
        gone = d.y > bottom + puckR;
      } else {
        if (d.y > bottom - puckR) {
          d.y = bottom - puckR;
          d.vy = -Math.abs(d.vy) * phys.wall;
        }
        gone = d.y < -puckR;
      }
      if (gone) decoys.splice(i, 1);
    }
    for (let t = 0; t < 2; t++) {
      if (state.bt.dc[t] <= 0) continue;
      let any = false;
      for (const d of decoys) if (d.t === t) any = true;
      if (!any) state.bt.dc[t] = 0;
    }
  }

  /** Steal: take the target's item, or roll a fresh one (never steal). */
  function stealItem(role, target) {
    const got = state.items[target] ? 1 : 0;
    let item = 'shield';
    if (got) {
      item = state.items[target];
      state.items[target] = null;
    } else {
      for (let t = 0; t < 5; t++) {
        const c = rollItem(role);
        if (c !== 'steal') {
          item = c;
          break;
        }
      }
    }
    state.items[role] = item;
    const m = state.mallets[role];
    emit('steal', m.x, m.y, 1, { by: role, item, got });
  }

  /** Fire the item `role` holds. Returns true when it was used (phase 'play'
   *  and an item in hand); otherwise false and the item is kept. An id that
   *  is not a known item is refused and the slot cleared. */
  function useItem(role) {
    if (!battleMode || state.phase !== PHASE.PLAY) return false;
    if (role !== 'host' && role !== 'guest') return false;
    const item = state.items[role];
    if (!item) return false;
    if (!ITEMS.includes(item)) {
      state.items[role] = null;
      return false;
    }
    const idx = sideIdx(role);
    const ti = 1 - idx; // the target
    const bt = state.bt;
    const p = state.puck;
    state.items[role] = null;
    lastUsed[role] = item;
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
        refreshRadius(ti);
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
      case 'magnet':
        bt.mg[ti] = MAGNET_S;
        break;
      case 'widegoal':
        bt.wg[ti] = WIDEGOAL_S;
        updateGoalWidths();
        break;
      case 'goalie':
        bt.go[idx] = GOALIE_S;
        placeGoalie(idx);
        break;
      case 'giant':
        bt.gi[idx] = GIANT_S;
        refreshRadius(idx);
        break;
      case 'catch':
        bt.ca[idx] = 1;
        break;
      case 'mirror':
        bt.mi[ti] = MIRROR_S;
        break;
      case 'quake':
        bt.qk[ti] = QUAKE_S;
        break;
      case 'decoys':
        spawnDecoys(ti, role);
        break;
      case 'steal':
        stealItem(role, roleOf(ti));
        break;
      case 'tinypuck':
        bt.tp = TINY_S;
        setPuckRadius(puckR0 * TINY_FACTOR);
        break;
    }
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
    else if (item === 'magnet') go = p.y > H + G / 2 || p.vy > 0;
    else if (item === 'catch') go = p.y < H && p.vy < 0;
    else if (item === 'steal') go = late || !!state.items.host;
    if (go && useItem('guest')) botUseAt = -1;
  }

  /** Count a per-side timer down; returns true on the step it runs out. */
  function tickDown(arr, i, dt) {
    if (arr[i] <= 0) return false;
    arr[i] -= dt;
    if (arr[i] > 0) return false;
    arr[i] = 0;
    return true;
  }

  /** Per-step battle upkeep while playing: effect timers, thaw,
   *  box spawns and the bot's item use. */
  function battleTick(dt) {
    const bt = state.bt;
    if (rocketT > 0) rocketT = Math.max(0, rocketT - dt);
    for (let i = 0; i < 2; i++) {
      tickDown(bt.sh, i, dt);
      tickDown(bt.gh, i, dt);
      tickDown(bt.mg, i, dt);
      tickDown(bt.mi, i, dt);
      tickDown(bt.qk, i, dt);
      if (tickDown(bt.sk, i, dt)) refreshRadius(i);
      if (tickDown(bt.gi, i, dt)) refreshRadius(i);
      if (tickDown(bt.wg, i, dt)) updateGoalWidths();
      if (tickDown(bt.go, i, dt)) removeObstacles('goalie', i);
      if (tickDown(bt.dc, i, dt)) removeDecoys(i);
      if (tickDown(bt.ct, i, dt)) releaseCatch(i, false);
    }
    if (bt.tp > 0) {
      bt.tp -= dt;
      if (bt.tp <= 0) {
        bt.tp = 0;
        setPuckRadius(puckR0);
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
      p.ss = 0;
      emit('glitch', cx, cy, Math.min(5, len / puckR), { fx: r(ox), fy: r(oy) });
      break;
    }
    glitchReschedule();
  }

  const noWall = () => {}; // a shield bounce is not a rail tick

  function wallBounce(vn) {
    const s = Math.min(1, vn / 2600);
    if (s > 0.04) emit('wall', curP.x, curP.y, s);
  }

  // --- random mode twists -----------------------------------------------------

  /** A twist id for the next match: cfg.twist when forced, else uniform over
   *  the twists other than the current one. */
  function pickTwist() {
    if (cfg.twist) return cfg.twist;
    const pool = TWISTS.filter((t) => t !== state.twist);
    return pool[Math.floor(rng() * pool.length) % pool.length];
  }

  /** Install a twist: fresh twist data, puck list, rails and goal offsets. */
  function setTwist(id) {
    state.twist = id;
    const tx = {};
    if (id === 'wind') tx.w = [0, 0];
    else if (id === 'hotpotato') tx.f = tx.fm = FUSE_MAX_S;
    else if (id === 'shrinking') tx.in = 0;
    else if (id === 'turbo') tx.k = 1;
    else if (id === 'gravity') tx.sw = 0;
    state.tx = tx;
    state.pucks.length = 1;
    if (id === 'twinpuck') state.pucks.push(puck2);
    physTurbo.max = phys.max;
    swallowed = false;
    windOn = false;
    windT = 0;
    setInset(0);
    updateGoalOffsets();
  }

  function setInset(v) {
    if (state.tx && state.tx.in !== undefined) state.tx.in = v;
    railL = v;
    railR = W - v;
    syncGeom();
  }

  /** Moving goals: both mouths swing on the sim clock, a quarter period apart. */
  function updateGoalOffsets() {
    if (state.twist !== 'movinggoals') {
      state.gx[0] = 0;
      state.gx[1] = 0;
      return;
    }
    const A = GOAL_SWING * W;
    const ph = (2 * Math.PI * state.time) / GOAL_PERIOD_S;
    state.gx[0] = A * Math.sin(ph);
    state.gx[1] = A * Math.sin(ph + Math.PI / 2);
  }

  function windTurn(first) {
    windAng = first ? rng() * 2 * Math.PI : windAng + (rng() < 0.5 ? 1 : -1) * (Math.PI / 2 + rng() * (Math.PI / 2));
    windAng = ((windAng % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const a = WIND_ACC * W;
    state.tx.w[0] = Math.cos(windAng) * a;
    state.tx.w[1] = Math.sin(windAng) * a;
    windT = WIND_TURN_S;
    emit('wind', W / 2, bottom / 2, 1, { ang: Math.round(windAng * 1000) / 1000 });
  }

  const fuseFor = () => Math.max(FUSE_MIN_S, FUSE_MAX_S - FUSE_PER_HIT_S * rallyHits);

  /** Serve: per-rally twist state starts over. */
  function twistServe() {
    const tx = state.tx;
    if (state.twist === 'hotpotato') tx.f = tx.fm = fuseFor();
    else if (state.twist === 'turbo') {
      tx.k = 1;
      physTurbo.max = phys.max;
    } else if (state.twist === 'wind' && !windOn) {
      windOn = true;
      windTurn(true);
    }
  }

  /** A mallet hit (velocity response) on puck p. rallyHits already counts it. */
  function twistHit(p) {
    const tx = state.tx;
    if (state.twist === 'hotpotato') {
      tx.fm = fuseFor();
      tx.f = tx.fm;
    } else if (state.twist === 'turbo') {
      tx.k = Math.min(TURBO_K_MAX, Math.pow(TURBO_MULT, rallyHits));
      physTurbo.max = phys.max * tx.k;
      p.vx *= TURBO_MULT;
      p.vy *= TURBO_MULT;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > physTurbo.max) {
        p.vx *= physTurbo.max / sp;
        p.vy *= physTurbo.max / sp;
      }
      emit('turbo', p.x, p.y, Math.min(1, tx.k - 1));
    }
  }

  /** Per-substep forces on a puck: the gravity well and the wind. */
  function twistForces(p, dt) {
    if (state.twist === 'wind') {
      p.vx += state.tx.w[0] * dt;
      p.vy += state.tx.w[1] * dt;
    } else if (state.twist === 'gravity') {
      const dx = W / 2 - p.x;
      const dy = bottom / 2 - p.y;
      const d = Math.hypot(dx, dy);
      if (d < WELL_SWALLOW_R * W && Math.hypot(p.vx, p.vy) < WELL_SWALLOW_V) {
        swallowed = true;
        p.x = W / 2;
        p.y = bottom / 2;
        p.vx = 0;
        p.vy = 0;
        p.ss = 0;
        state.tx.sw = WELL_HOLD_S;
        emit('swallow', W / 2, bottom / 2, 1);
        return;
      }
      if (d > 1e-6) {
        const S = WELL_S * W;
        const a = (WELL_K * W * W * W * d) / Math.pow(d * d + S * S, 1.5);
        p.vx += (dx / d) * a * dt;
        p.vy += (dy / d) * a * dt;
      }
    }
  }

  /** The well spits the puck at the goal of whoever fed it. */
  function spit() {
    const p = state.puck;
    const side = state.lastHit || (state.serveTo === 'host' ? 'guest' : 'host');
    const base = side === 'host' ? Math.PI / 2 : -Math.PI / 2; // towards that side's own goal
    const a = base + rand(-30, 30) * (Math.PI / 180);
    swallowed = false;
    state.tx.sw = 0;
    p.x = W / 2;
    p.y = bottom / 2;
    p.vx = Math.cos(a) * WELL_SPIT_V;
    p.vy = Math.sin(a) * WELL_SPIT_V;
    p.ss = 0;
    emit('spit', p.x, p.y, 1, { by: side });
  }

  /** Per-step twist upkeep. Goal offsets run in every phase; the rest only in play. */
  function twistTick(dt) {
    const tx = state.tx;
    switch (state.twist) {
      case 'wind':
        if (windOn) {
          windT -= dt;
          if (windT <= 0) windTurn(false);
        }
        break;
      case 'gravity':
        if (swallowed) {
          tx.sw = Math.max(0, tx.sw - dt);
          if (tx.sw <= 0) spit();
        }
        break;
      case 'hotpotato':
        tx.f = Math.max(0, tx.f - dt);
        if (tx.f <= 0) {
          const p = state.puck;
          const side = p.y > bottom / 2 ? 'host' : 'guest';
          emit('potato', p.x, p.y, 1, { by: side });
          goal(side, { x: p.x, y: p.y, why: 'potato' });
        }
        break;
      case 'shrinking': {
        setInset(Math.min(SHRINK_MAX * W, tx.in + SHRINK_RATE * W * dt));
        // The rails push pucks and mallets inside without a bounce.
        for (const p of state.pucks) p.x = clamp(p.x, railL + puckR, railR - puckR);
        clampMallet('host', state.mallets.host);
        clampMallet('guest', state.mallets.guest);
        break;
      }
    }
  }

  /** A goal: the shrinking rink opens up again. */
  function twistGoal() {
    if (state.twist === 'shrinking') setInset(0);
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
    if (randomMode) updateGoalOffsets(); // the goals swing in every phase
    if (state.phase === PHASE.READY) return; // waiting for both players: nothing moves

    if (bot && state.phase !== PHASE.OVER) {
      const m = state.mallets.guest;
      const px = m.x;
      const py = m.y;
      state.botPuck = botThreat();
      bot.update(state, dt, now === undefined ? state.time * 1000 : now);
      if (battleMode && state.bt.qk[1] > 0) {
        // Quake: the bot's mallet lags like a human one.
        m.x = px + (m.x - px) * QUAKE_FOLLOW;
        m.y = py + (m.y - py) * QUAKE_FOLLOW;
        m.vx *= QUAKE_FOLLOW;
        m.vy *= QUAKE_FOLLOW;
      }
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
        if (randomMode) twistTick(dt);
        const h = dt / SUBSTEPS;
        for (let i = 0; i < SUBSTEPS && state.phase === PHASE.PLAY; i++) substep(h);
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
    state.lastHit = null;
    rallyHits = 0;
    state.serveTo = rng() < 0.5 ? 'host' : 'guest';
    if (randomMode) setTwist(pickTwist());
    for (const p of state.pucks) p.ss = 0;
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
    syncGeom();
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
      a: obstacleA(o),
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
      pr: r(state.pr),
      gx: [r(state.gx[0]), r(state.gx[1])],
      ev: null,
    };
    const r2 = (v) => Math.round(v * 100) / 100;
    if (randomMode) {
      const t = state.tx;
      const tx = {};
      if (t.w) tx.w = [r(t.w[0]), r(t.w[1])];
      if (t.f !== undefined) {
        tx.f = r2(t.f);
        tx.fm = r2(t.fm);
      }
      if (t.in !== undefined) tx.in = r(t.in);
      if (t.k !== undefined) tx.k = r2(t.k);
      if (t.sw !== undefined) tx.sw = r2(t.sw);
      snap.tw = state.twist;
      snap.tx = tx;
      if (state.pucks.length > 1) snap.p2 = [r(puck2.x), r(puck2.y), r(puck2.vx), r(puck2.vy)];
    }
    if (battleMode) {
      const b = state.bt;
      const pair = (a) => [r2(a[0]), r2(a[1])];
      snap.it = [state.items.host || '', state.items.guest || ''];
      snap.bt = {
        sh: pair(b.sh),
        gh: pair(b.gh),
        sk: pair(b.sk),
        fz: r2(b.fz),
        rk: [b.rk[0], b.rk[1]],
        mr: [r(b.mr[0]), r(b.mr[1])],
        mg: pair(b.mg),
        wg: pair(b.wg),
        mi: pair(b.mi),
        qk: pair(b.qk),
        dc: pair(b.dc),
        go: pair(b.go),
        gi: pair(b.gi),
        ca: [b.ca[0], b.ca[1]],
        ct: pair(b.ct),
        tp: r2(b.tp),
      };
      if (decoys.length) snap.dk = decoys.map((d) => [r(d.x), r(d.y), r(d.vx), r(d.vy)]);
    }
    snap.ev = drainEvents();
    return snap;
  }

  /** Obstacle `a` in the snapshot: armed / live flag, or the goalie's owner. */
  function obstacleA(o) {
    switch (o.k) {
      case 'bumper':
        return 1;
      case 'goalie':
        return o.a;
      case 'bomb':
        return o.armed ? 1 : 0;
      case 'box':
        return o.on ? 1 : 0;
      default:
        return state.time >= o.rearmAt ? 1 : 0;
    }
  }

  if (randomMode) setTwist(pickTwist());
  updateGoalWidths();
  placePuckForServe();
  return { state, cfg, step, setMallet, setReady, setGap, restart, snapshot, drainEvents, obstacles, useItem };
}

function r(v) {
  return Math.round(v * 10) / 10;
}
