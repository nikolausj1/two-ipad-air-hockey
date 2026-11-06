// Air hockey bot. Controls the GUEST mallet inside sim.step.
//
// The bot defends the goal at y = 0 and attacks the host goal at the far end
// (y = 2H + G). It only ever moves inside the guest half. It does not touch
// the puck itself: it sets the mallet position and velocity, and the sim runs
// the same swept mallet/puck collision it uses for human mallets.
//
//   const bot = createBot('hard', { W, H, G, puckR, malletR, goalW, friction });
//   bot.update(state, dt, nowMs);   // moves state.mallets.guest

const LEVELS = {
  //          max speed, reaction delay (s), aim error (frac of W*0.3),
  //          defensive x tracking, goal-corner aim (frac of half goal width),
  //          predict rail bounces, defend line (frac of H), armed-bomb avoidance
  //          strength (1 = full), careful = never steps onto an armed bomb itself
  easy: { vmax: 700, delay: 0.25, aimErr: 1.0, track: 0.3, corner: 0, bounce: false, predictDef: false, defY: 0.1, bomb: 0.6, careful: false },
  medium: { vmax: 1200, delay: 0.08, aimErr: 0.45, track: 0.45, corner: 0.15, bounce: false, predictDef: false, defY: 0.12, bomb: 0.6, careful: false },
  hard: { vmax: 1800, delay: 0.03, aimErr: 0.15, track: 0.6, corner: 0.5, bounce: false, predictDef: true, defY: 0.15, bomb: 1, careful: true },
  impossible: { vmax: 2800, delay: 0, aimErr: 0, track: 0.8, corner: 0.75, bounce: true, predictDef: true, defY: 0.2, bomb: 1, careful: true },
};

const STRIKE_FACTOR = 0.6; // strike speed as a fraction of the level's max speed
const SLOW_PUCK = 140; // px/s: below this the puck is "at rest" for interception
const AWAY_SPEED = 350; // puck faster than this and heading to the host: do not chase
const BOMB_BAND = 70; // px beyond (malletR + bomb r) where the repulsion fades to zero
const BOMB_PUSH = 120; // px a full-strength repulsion shifts the target
const BOMB_KEEP = 10; // targets never sit closer than this beyond (malletR + bomb r)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function createBot(level, cfg) {
  const L = LEVELS[level] || LEVELS.medium;
  const { W, H, G, puckR, malletR } = cfg;
  const bottom = 2 * H + G;
  const fric = cfg.friction || 0.8;
  const lnF = Math.log(fric);
  const R = puckR + malletR; // mallet-centre to puck-centre at contact
  const minX = malletR;
  const maxX = W - malletR;
  const minY = malletR;
  const maxY = H - malletR;

  let clock = 0; // seconds, advanced by dt (deterministic, independent of `now`)
  const history = []; // delayed observation of the puck for easy/medium
  let aimNoise = 0; // current aim error in [-1, 1], re-rolled per approach
  let wasAttacking = false;
  const rnd = cfg.rng || Math.random;

  /** Puck position t seconds from the observation, with friction and (optionally) rail bounces. */
  function predict(o, t, bounce) {
    const k = lnF !== 0 ? (Math.pow(fric, t) - 1) / lnF : t; // integral of friction decay
    let x = o.x + o.vx * k;
    const y = o.y + o.vy * k;
    if (bounce) {
      const len = W - 2 * puckR;
      let u = (x - puckR) % (2 * len);
      if (u < 0) u += 2 * len;
      if (u > len) u = 2 * len - u;
      x = puckR + u;
    }
    return { x, y };
  }

  function observe(p) {
    history.push({ t: clock, x: p.x, y: p.y, vx: p.vx, vy: p.vy });
    while (history.length > 2 && history[1].t <= clock - L.delay) history.shift();
    if (L.delay <= 0) return history[history.length - 1];
    // Newest sample that is at least `delay` old (or the oldest we have).
    let pick = history[0];
    for (const h of history) if (h.t <= clock - L.delay) pick = h;
    return pick;
  }

  function aimPoint(state, from) {
    const gw0 = (state.gw && state.gw[0]) || cfg.goalW;
    const host = state.mallets.host;
    const cx = W / 2 + ((state.gx && state.gx[0]) || 0); // the host mouth centre (moving goals)
    let ax = cx;
    if (L.corner > 0) {
      // Go for the side of the goal the host mallet is not covering.
      const side = host.x > cx ? -1 : 1;
      ax += side * (gw0 / 2) * L.corner;
    }
    ax += aimNoise * W * 0.12 * L.aimErr;
    // Keep inside the table; bank shots are not attempted.
    ax = clamp(ax, W * 0.1, W * 0.9);
    return { x: ax, y: bottom };
  }

  /** Strike direction and staging spot for a puck at Q. */
  function plan(state, Q) {
    const A = aimPoint(state, Q);
    let ax = A.x - Q.x;
    let ay = A.y - Q.y;
    const len = Math.hypot(ax, ay) || 1;
    ax /= len;
    ay /= len;
    // Never swing backwards at our own goal.
    if (ay < 0.25) {
      ay = 0.25;
      const l2 = Math.hypot(ax, ay);
      ax /= l2;
      ay /= l2;
    }
    // Puck hugging our end wall: we cannot get behind it, so scoop it sideways.
    if (Q.y < R * 1.15) {
      const dir = Q.x < W / 2 ? 1 : -1;
      ax = dir * 0.9;
      ay = 0.436;
    }
    const stage = { x: Q.x - ax * (R + malletR * 0.8), y: Q.y - ay * (R + malletR * 0.8) };
    stage.x = clamp(stage.x, minX, maxX);
    stage.y = clamp(stage.y, minY, maxY);
    return { ax, ay, stage };
  }

  /** Armed bombs among the sim's obstacles (state.obs may be missing or empty). */
  function armedBombs(state) {
    const list = state.obs;
    if (!list || !list.length) return null;
    let out = null;
    for (const o of list) {
      if (o.k === 'bomb' && o.armed) (out || (out = [])).push(o);
    }
    return out;
  }

  /** Push the target (tx, ty) away from armed bombs near the mallet and keep it
   *  out of their blast margin. Returns the adjusted {x, y}. */
  function avoidBombs(m, bombs, tx, ty) {
    for (const o of bombs) {
      const D = malletR + o.r;
      const dx = m.x - o.x;
      const dy = m.y - o.y;
      const d = Math.hypot(dx, dy);
      if (d >= D + BOMB_BAND) continue;
      const depth = clamp((D + BOMB_BAND - d) / BOMB_BAND, 0, 1); // 1 when overlapping
      const nx = d > 1e-6 ? dx / d : 0;
      const ny = d > 1e-6 ? dy / d : 1;
      tx += nx * depth * L.bomb * BOMB_PUSH;
      ty += ny * depth * L.bomb * BOMB_PUSH;
    }
    // Never aim inside a bomb's keep-out circle: slide the target around it.
    for (let pass = 0; pass < 2; pass++) {
      tx = clamp(tx, minX, maxX);
      ty = clamp(ty, minY, maxY);
      for (const o of bombs) {
        const keep = malletR + o.r + BOMB_KEEP;
        let ex = tx - o.x;
        let ey = ty - o.y;
        let e = Math.hypot(ex, ey);
        if (e >= keep) continue;
        if (e < 1e-6) {
          ex = m.x - o.x;
          ey = m.y - o.y;
          e = Math.hypot(ex, ey);
          if (e < 1e-6) {
            ex = 0;
            ey = 1;
            e = 1;
          }
        }
        tx = o.x + (ex / e) * keep;
        ty = o.y + (ey / e) * keep;
      }
    }
    {
      // Do not cut across a bomb on the way to the target: detour around it.
      for (const o of bombs) {
        const D = malletR + o.r;
        const sx = tx - m.x;
        const sy = ty - m.y;
        const l2 = sx * sx + sy * sy;
        if (l2 < 1) continue;
        const u = clamp(((o.x - m.x) * sx + (o.y - m.y) * sy) / l2, 0, 1);
        if (u <= 0 || u >= 1) continue;
        const cx = m.x + sx * u - o.x;
        const cy = m.y + sy * u - o.y;
        if (Math.hypot(cx, cy) >= D + BOMB_KEEP + 4) continue;
        const len = Math.sqrt(l2);
        let px = -sy / len;
        let py = sx / len;
        const side = cx * px + cy * py;
        if (side < 0 || (side === 0 && o.x > W / 2)) {
          px = -px;
          py = -py;
        }
        tx = clamp(o.x + px * (D + BOMB_KEEP + 14), minX, maxX);
        ty = clamp(o.y + py * (D + BOMB_KEEP + 14), minY, maxY);
      }
    }
    return { x: tx, y: ty };
  }

  function update(state, dt, now) {
    clock += dt;
    const m = state.mallets.guest;
    if (state.phase === 'over') {
      m.vx = 0;
      m.vy = 0;
      return;
    }
    const obs = observe(state.botPuck || state.puck);
    const speed = Math.hypot(obs.vx, obs.vy);
    const defY = clamp(H * L.defY, minY, maxY);
    let tx = W / 2;
    let ty = defY;
    let vmax = L.vmax;
    let hurry = false;
    let attacking = false;

    const puckInMine = obs.y < H;
    const wantsAttack =
      state.phase === 'play' && puckInMine && !(speed > AWAY_SPEED && obs.vy > 150);

    if (wantsAttack) {
      let Q = null;
      if (speed < SLOW_PUCK) {
        Q = { x: obs.x, y: obs.y };
      } else {
        // Earliest point along the puck's path the mallet can get behind in time.
        for (let t = 0.02; t <= 1.2; t += 0.02) {
          const q = predict(obs, t, L.bounce);
          if (q.y > maxY || q.y < puckR * 0.5) break;
          const pl = plan(state, q);
          const need = Math.hypot(pl.stage.x - m.x, pl.stage.y - m.y) / (L.vmax * 0.95);
          if (need <= t) {
            Q = q;
            break;
          }
        }
        // Too fast to catch: stand in its way instead.
        if (!Q && obs.vy < 0) {
          const q = predict(obs, 0.3, L.bounce);
          Q = { x: q.x, y: Math.max(q.y, R) };
        }
      }
      if (Q) {
        attacking = true;
        if (!wasAttacking) aimNoise = (rnd() * 2 - 1);
        const pl = plan(state, Q);
        const rx = m.x - Q.x;
        const ry = m.y - Q.y;
        const s = rx * pl.ax + ry * pl.ay; // along the strike line (negative = behind)
        const d = rx * pl.ay - ry * pl.ax; // across it
        if (s < 0 && s > -(R + malletR * 4) && Math.abs(d) < R * 0.7) {
          // Lined up behind the puck: drive through it.
          tx = Q.x + pl.ax * R;
          ty = Q.y + pl.ay * R;
          vmax = L.vmax * STRIKE_FACTOR;
          hurry = true;
        } else {
          tx = pl.stage.x;
          ty = pl.stage.y;
          hurry = true;
          // Do not plough through the puck on the way to the staging spot.
          const dx = tx - m.x;
          const dy = ty - m.y;
          const l2 = dx * dx + dy * dy;
          if (l2 > 1) {
            const u = clamp(((obs.x - m.x) * dx + (obs.y - m.y) * dy) / l2, 0, 1);
            const cx = m.x + dx * u;
            const cy = m.y + dy * u;
            const gap = Math.hypot(cx - obs.x, cy - obs.y);
            if (gap < R * 1.2 && u > 0 && u < 1) {
              let nx = cx - obs.x;
              let ny = cy - obs.y;
              const nl = Math.hypot(nx, ny);
              if (nl < 1e-3) {
                nx = -dy;
                ny = dx;
                const l3 = Math.hypot(nx, ny) || 1;
                nx /= l3;
                ny /= l3;
              } else {
                nx /= nl;
                ny /= nl;
              }
              tx = obs.x + nx * R * 1.8;
              ty = obs.y + ny * R * 1.8;
            }
          }
        }
      }
    }

    if (!attacking) {
      // Defend: sit in front of the goal, shaded towards the puck.
      const home = W / 2 + ((state.gx && state.gx[1]) || 0); // our mouth centre (moving goals)
      let x = home + (obs.x - home) * L.track;
      let coming = false;
      if (state.phase === 'play' && obs.vy < -60 && speed > 150) {
        coming = true;
        if (L.predictDef) {
          // Where will it cross our defensive line?
          for (let t = 0.02; t <= 1.5; t += 0.02) {
            const q = predict(obs, t, L.bounce);
            if (q.y <= defY) {
              x = q.x;
              break;
            }
          }
        }
      }
      const half = Math.max(cfg.goalW * 0.65, W * 0.2);
      tx = clamp(x, home - half, home + half);
      ty = defY;
      hurry = coming;
    }
    wasAttacking = attacking;

    tx = clamp(tx, minX, maxX);
    ty = clamp(ty, minY, maxY);

    const bombs = armedBombs(state);
    if (bombs) {
      const a = avoidBombs(m, bombs, tx, ty);
      tx = clamp(a.x, minX, maxX);
      ty = clamp(a.y, minY, maxY);
    }

    // Move towards the target, capped by the level's top speed.
    const dx = tx - m.x;
    const dy = ty - m.y;
    const dist = Math.hypot(dx, dy);
    let sp = hurry ? vmax : Math.min(vmax, dist * 9);
    if (!hurry && dist < 2) sp = 0;
    const move = Math.min(dist, sp * dt);
    let nx = m.x;
    let ny = m.y;
    if (dist > 1e-6 && move > 0) {
      nx += (dx / dist) * move;
      ny += (dy / dist) * move;
    }
    nx = clamp(nx, minX, maxX);
    ny = clamp(ny, minY, maxY);
    if (bombs && L.careful) {
      // The careful levels never step onto an armed bomb themselves.
      for (const o of bombs) {
        const D = malletR + o.r + 2;
        const ex = nx - o.x;
        const ey = ny - o.y;
        const e = Math.hypot(ex, ey);
        if (e < D) {
          if (e < 1e-6) continue;
          nx = clamp(o.x + (ex / e) * D, minX, maxX);
          ny = clamp(o.y + (ey / e) * D, minY, maxY);
        }
      }
    }
    m.vx = (nx - m.x) / dt;
    m.vy = (ny - m.y) / dt;
    m.x = nx;
    m.y = ny;
    m.lastT = now;
  }

  return { update, level, maxSpeed: L.vmax };
}
