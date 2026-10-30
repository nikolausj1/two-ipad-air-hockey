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

export const MODES = ['classic', 'bumpers', 'ice', 'heavy', 'mines'];

// Per-mode physics. fric = fraction of puck speed kept after one second of
// sliding, wall = rail restitution, mallet = mallet restitution, max = puck
// speed cap (px/s).
export const MODE_PHYS = {
  classic: { fric: 0.8, wall: 0.92, mallet: 0.85, max: 2600 },
  bumpers: { fric: 0.8, wall: 0.92, mallet: 0.85, max: 2600 },
  mines: { fric: 0.8, wall: 0.92, mallet: 0.85, max: 2600 },
  ice: { fric: 0.95, wall: 1.0, mallet: 0.85, max: 3000 },
  heavy: { fric: 0.6, wall: 0.7, mallet: 0.5, max: 1560 }, // 60% of classic
};

const BUMPER_RESTITUTION = 0.95;
const BUMPER_R_FACTOR = 0.6; // of malletR
const MINE_R_FACTOR = 0.45; // of malletR
const MINE_REARM_S = 4;
const MINE_BLAST_FACTOR = 0.92; // of max puck speed
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

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
  const MAX_PUCK_SPEED = phys.max;
  const seamTop = H; // where the guest half ends
  let seamBottom = H + G; // where the host half starts
  let bottom = 2 * H + G;

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

  let events = [];
  let lastTick = Infinity;
  let seamStill = 0;

  function emit(k, x, y, s, extra) {
    if (events.length >= EVENT_CAP) return;
    const e = { k, x: r(x), y: r(y), s: Math.round(s * 100) / 100 };
    if (extra) Object.assign(e, extra);
    events.push(e);
  }

  // --- obstacles ------------------------------------------------------------

  const obstacles = buildObstacles(); // mutated in place by setGap()

  function buildObstacles() {
    const list = [];
    if (mode !== 'bumpers' && mode !== 'mines') return list;
    const isBumper = mode === 'bumpers';
    const rad = malletR * (isBumper ? BUMPER_R_FACTOR : MINE_R_FACTOR);
    let layout;
    if (isBumper) {
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
      list.push({ k: isBumper ? 'bumper' : 'mine', x, y, r: rad, rearmAt: 0 });
      list.push({ k: isBumper ? 'bumper' : 'mine', x: W - x, y: bottom - y, r: rad, rearmAt: 0 });
    }
    return list;
  }

  function rearmAll() {
    for (const o of obstacles) o.rearmAt = 0;
  }

  function collideObstacles() {
    const p = state.puck;
    for (const o of obstacles) {
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
        o.rearmAt = state.time + MINE_REARM_S;
        emit('mine', o.x, o.y, 1);
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
    emit('serve', p.x, p.y, 1);
  }

  // --- mallets --------------------------------------------------------------

  function clampMallet(role, m) {
    const rr = malletR;
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
    const p = state.puck;
    let dx = p.x - m.x;
    let dy = p.y - m.y;
    let dist = Math.hypot(dx, dy);
    const minDist = puckR + malletR;
    if (dist >= minDist) return;
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
    if (p.y < puckR && !inMouth(p.x, 'guest')) {
      p.y = puckR;
      p.x = m.x + sgnX * Math.sqrt(Math.max(0, minDist * minDist - (p.y - m.y) ** 2));
    } else if (p.y > bottom - puckR && !inMouth(p.x, 'host')) {
      p.y = bottom - puckR;
      p.x = m.x + sgnX * Math.sqrt(Math.max(0, minDist * minDist - (p.y - m.y) ** 2));
    }
    p.x = clamp(p.x, puckR, W - puckR);
    // Reflect the relative velocity along the normal; the mallet has infinite mass.
    const rvx = p.vx - m.vx;
    const rvy = p.vy - m.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      p.vx -= (1 + phys.mallet) * vn * nx;
      p.vy -= (1 + phys.mallet) * vn * ny;
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > MAX_PUCK_SPEED) {
        p.vx *= MAX_PUCK_SPEED / sp;
        p.vy *= MAX_PUCK_SPEED / sp;
      }
      const s = Math.min(1, -vn / 2000);
      if (s > 0.03) emit('hit', p.x - nx * puckR, p.y - ny * puckR, s);
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

  function goal(scoredOn) {
    const scorer = scoredOn === 'host' ? 'guest' : 'host';
    emit('goal', state.puck.x, scoredOn === 'guest' ? 0 : bottom, 1, { by: scorer });
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
    placePuckForServe();
  }

  // --- puck physics ---------------------------------------------------------

  function stepPuck(dt) {
    const p = state.puck;
    const k = Math.pow(phys.fric, dt);
    p.vx *= k;
    p.vy *= k;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > MAX_PUCK_SPEED) {
      p.vx *= MAX_PUCK_SPEED / speed;
      p.vy *= MAX_PUCK_SPEED / speed;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Side rails.
    if (p.x < puckR) {
      p.x = puckR;
      if (p.vx < 0) wallBounce(-p.vx);
      p.vx = Math.abs(p.vx) * phys.wall;
    } else if (p.x > W - puckR) {
      p.x = W - puckR;
      if (p.vx > 0) wallBounce(p.vx);
      p.vx = -Math.abs(p.vx) * phys.wall;
    }

    // End rails and goals.
    if (p.y < puckR) {
      if (inMouth(p.x, 'guest')) {
        if (p.y < -puckR) return goal('guest');
      } else {
        p.y = puckR;
        if (p.vy < 0) wallBounce(-p.vy);
        p.vy = Math.abs(p.vy) * phys.wall;
      }
    } else if (p.y > bottom - puckR) {
      if (inMouth(p.x, 'host')) {
        if (p.y > bottom + puckR) return goal('host');
      } else {
        p.y = bottom - puckR;
        if (p.vy > 0) wallBounce(p.vy);
        p.vy = -Math.abs(p.vy) * phys.wall;
      }
    }

    // Mallets first, obstacles last, so a mallet can never shove the puck
    // into a bumper and keep it there with energy gained from the squeeze.
    const mh = state.mallets.host;
    const mg = state.mallets.guest;
    for (let i = 0; i < 3; i++) {
      collideMallet(mh, 'host');
      collideMallet(mg, 'guest');
      if (obstacles.length) collideObstacles();
    }
    // Still overlapping a mallet = squeezed between it and an obstacle or rail:
    // the puck just rides along with half the mallet's velocity.
    const minDist = puckR + malletR - 0.5;
    for (const m of [mh, mg]) {
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
        const h = dt / SUBSTEPS;
        for (let i = 0; i < SUBSTEPS && state.phase === PHASE.PLAY; i++) stepPuck(h);
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
      a: o.k === 'bumper' || state.time >= o.rearmAt ? 1 : 0,
    }));
    return {
      t: 's',
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
      ev: drainEvents(),
    };
  }

  updateGoalWidths();
  placePuckForServe();
  return { state, cfg, step, setMallet, setReady, setGap, restart, snapshot, drainEvents, obstacles };
}

function r(v) {
  return Math.round(v * 10) / 10;
}
