// Headless smoke test for public/sim.js + public/bot.js.
// Run: node tools/sim-smoke.mjs
import { createSim, PHASE, MODES, eventsOf } from '../public/sim.js';

const W = 1024;
const H = 768;
const G = 40;
const base = {
  W,
  H,
  G,
  puckR: Math.round(Math.min(W, H) * 0.035),
  malletR: Math.round(Math.min(W, H) * 0.055),
  goalW: Math.round(W * 0.36),
  target: 7,
};
const bottom = 2 * H + G;
const DT = 1 / 60;
const SECONDS = 20;

function rngFor(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + msg);
  }
}

/** Scripted host: chases the puck while it is in the host half, else sits at home. */
function hostScript(sim, now, mode) {
  const p = sim.state.puck;
  const m = sim.state.mallets.host;
  let tx = W / 2 + Math.sin(now / 900) * 120;
  let ty = bottom - H * 0.2;
  if (p.y > H + G && mode === 'chase') {
    tx = p.x;
    ty = p.y - (p.vy > 0 ? 0 : -1) * 0 - 60;
    ty = Math.min(ty, bottom - H * 0.2);
  }
  const dx = tx - m.x;
  const dy = ty - m.y;
  const d = Math.hypot(dx, dy) || 1;
  const step = Math.min(d, 1500 * DT);
  sim.setMallet('host', m.x + (dx / d) * step, m.y + (dy / d) * step, now);
}

function run(name, cfgExtra, { hostMode = 'chase', serveTo = null, seed = 1 } = {}) {
  const cfg = { ...base, ...cfgExtra };
  const sim = createSim(cfg, { rng: rngFor(seed) });
  if (serveTo) {
    sim.state.serveTo = serveTo;
    sim.restart();
    sim.state.serveTo = serveTo;
    sim.state.puck.y = serveTo === 'host' ? H + G + H / 2 : H / 2;
  }
  const kinds = {};
  let nan = 0;
  let oob = 0;
  let inBumper = 0;
  let badGw = 0;
  let minGw = Infinity;
  let now = 1000;
  let goals = 0;
  const frames = Math.round(SECONDS / DT);
  for (let i = 0; i < frames; i++) {
    now += DT * 1000;
    hostScript(sim, now, hostMode);
    sim.step(DT, now);
    const s = sim.state;
    const p = s.puck;
    const vals = [p.x, p.y, p.vx, p.vy, s.mallets.host.x, s.mallets.host.y, s.mallets.guest.x, s.mallets.guest.y];
    if (vals.some((v) => !Number.isFinite(v))) nan++;
    // Bounds: inside the rink, or inside a goal mouth (may poke out by one puck radius).
    const e = 0.5;
    const okX = p.x >= cfg.puckR - e && p.x <= W - cfg.puckR + e;
    const mouthTop = Math.abs(p.x - W / 2) < s.gw[1] / 2;
    const mouthBot = Math.abs(p.x - W / 2) < s.gw[0] / 2;
    const okY =
      (p.y >= cfg.puckR - e || (mouthTop && p.y >= -cfg.puckR - e)) &&
      (p.y <= bottom - cfg.puckR + e || (mouthBot && p.y <= bottom + cfg.puckR + e));
    if (!okX || !okY) oob++;
    // Never inside a bumper (small tolerance for being squeezed by a mallet).
    for (const o of sim.obstacles) {
      if (o.k === 'bumper' && s.phase === PHASE.PLAY) {
        if (Math.hypot(p.x - o.x, p.y - o.y) < cfg.puckR + o.r - 2.5) inBumper++;
      }
    }
    const snap = sim.snapshot();
    for (const ev of eventsOf(snap)) {
      kinds[ev.k] = (kinds[ev.k] || 0) + 1;
      if (ev.k === 'goal') goals++;
      if (!(ev.s >= 0 && ev.s <= 5)) nan++;
    }
    check(snap.ev.length <= 16, 'event cap');
    // Comeback widths follow the score.
    const [sh, sg] = snap.sc;
    const want = (d) => (cfg.comeback === false ? 1 : d >= 2 ? 0.6 : d === 1 ? 0.75 : 1) * cfg.goalW;
    if (Math.abs(snap.gw[0] - want(sg - sh)) > 0.2 || Math.abs(snap.gw[1] - want(sh - sg)) > 0.2) badGw++;
    minGw = Math.min(minGw, snap.gw[0], snap.gw[1]);
    if (s.phase === PHASE.OVER) break;
  }
  const sc = sim.state.score;
  const snap = sim.snapshot();
  console.log(
    `${name.padEnd(34)} score ${sc.host}-${sc.guest} goals=${goals} events=${JSON.stringify(kinds)} ob=${snap.ob.length} minGw=${Math.round(minGw)}`,
  );
  check(nan === 0, `${name}: NaN/invalid values (${nan})`);
  check(oob === 0, `${name}: puck out of bounds ${oob} frames`);
  check(inBumper === 0, `${name}: puck inside a bumper ${inBumper} frames`);
  check(badGw === 0, `${name}: goal width mismatch ${badGw} frames`);
  check((kinds.countdown || 0) >= 3, `${name}: countdown events`);
  check((kinds.serve || 0) >= 1, `${name}: serve event`);
  return { sim, kinds, sc, goals, snap };
}

// ---- obstacle layouts ------------------------------------------------------
console.log('Obstacle layouts');
for (const mode of ['classic', 'ice', 'heavy', 'bumpers', 'mines']) {
  const sim = createSim({ ...base, mode });
  const ob = sim.snapshot().ob;
  const n = ob.length;
  if (mode === 'bumpers') check(n >= 6 && n <= 10 && n % 2 === 0, `bumper count ${n}`);
  else if (mode === 'mines') check(n >= 4 && n <= 6 && n % 2 === 0, `mine count ${n}`);
  else check(n === 0, `${mode} should have no obstacles`);
  for (const o of ob) {
    check(Math.abs(o.y - (H + G / 2)) > H * 0.15, `${mode} obstacle too close to seam`);
    const crease = Math.min(Math.hypot(o.x - W / 2, o.y), Math.hypot(o.x - W / 2, o.y - bottom));
    check(crease > base.goalW / 2 + base.malletR * 2, `${mode} obstacle in goal crease`);
    const mirror = ob.find((q) => Math.abs(q.x - (W - o.x)) < 0.2 && Math.abs(q.y - (bottom - o.y)) < 0.2);
    check(!!mirror, `${mode} obstacle without mirror`);
    check(o.x - o.r > 0 && o.x + o.r < W, `${mode} obstacle outside rink`);
  }
  console.log(`  ${mode.padEnd(8)} obstacles=${n}`);
}

// ---- every mode, bot at every level ----------------------------------------
console.log('\nModes x bot levels (scripted host chasing the puck)');
for (const mode of MODES) {
  for (const botLevel of ['easy', 'medium', 'hard', 'impossible']) {
    run(`${mode}/${botLevel}`, { mode, players: 'bot', botLevel, comeback: true }, { seed: 7 });
  }
}

console.log('\nOther configurations');
run('duo/classic (both scripted)', { mode: 'classic', players: 'duo' });
run('pass/bumpers', { mode: 'bumpers', players: 'pass' });
run('comeback off', { mode: 'classic', players: 'bot', botLevel: 'impossible', comeback: false }, { hostMode: 'idle', serveTo: 'guest' });

// ---- required: bot impossible vs idle host must score ----------------------
console.log('\nRequired: impossible bot vs idle host mallet scores at least once');
for (const mode of MODES) {
  const res = run(`idle-host ${mode}/impossible`, { mode, players: 'bot', botLevel: 'impossible' }, { hostMode: 'idle', serveTo: 'guest', seed: 3 });
  check(res.sc.host + res.sc.guest >= 1, `${mode}: no goal in ${SECONDS}s`);
  check(res.sc.guest >= 1, `${mode}: bot never scored`);
}

// comeback with mines: random blasts can score on both sides; check mine event appears with chaser over several seeds
let mineEvents = 0;
let bumperEvents = 0;
for (let seed = 1; seed <= 6; seed++) {
  mineEvents += run(`mines seed ${seed}`, { mode: 'mines', players: 'bot', botLevel: 'hard' }, { seed }).kinds.mine || 0;
  bumperEvents += run(`bumpers seed ${seed}`, { mode: 'bumpers', players: 'bot', botLevel: 'hard' }, { seed }).kinds.bumper || 0;
}
check(mineEvents > 0, 'no mine events in any seed');
check(bumperEvents > 0, 'no bumper events in any seed');

// ---- mallet pushing the puck into a bumper (collision order) ---------------
console.log('\nMallet pushes a puck resting against a bumper at 150 px/s');
{
  const cfg = { ...base, mode: 'bumpers', players: 'pass' };
  const sim = createSim(cfg, { rng: rngFor(5) });
  const ob = sim.obstacles.filter((o) => o.k === 'bumper' && o.y > H + G + H * 0.1)[0];
  const st = sim.state;
  st.phase = PHASE.PLAY;
  const p = st.puck;
  p.x = ob.x;
  p.y = ob.y + ob.r + cfg.puckR + 0.5;
  p.vx = 0;
  p.vy = 0;
  const mal = st.mallets.host;
  let my = p.y + cfg.puckR + cfg.malletR + 1;
  mal.x = ob.x;
  mal.y = my;
  let now = 5000;
  sim.setMallet('host', ob.x, my, now, true);
  const MS = 150;
  let maxOver = 0;
  let maxSpeed = 0;
  for (let i = 0; i < 40; i++) {
    now += DT * 1000;
    my -= MS * DT;
    sim.setMallet('host', ob.x, my, now);
    sim.step(DT, now);
    maxOver = Math.max(maxOver, cfg.puckR + ob.r - Math.hypot(p.x - ob.x, p.y - ob.y));
    maxSpeed = Math.max(maxSpeed, Math.hypot(p.vx, p.vy));
  }
  console.log(`  max overlap ${maxOver.toFixed(2)} px, max puck speed ${Math.round(maxSpeed)} px/s`);
  check(maxOver <= 1, `puck overlaps bumper by ${maxOver.toFixed(2)} px`);
  check(maxSpeed <= 2 * MS + 300, `puck reached ${Math.round(maxSpeed)} px/s from a ${MS} px/s mallet`);
}

// ---- setMallet jump: a new touch far away must not fire the puck ------------
console.log('\nsetMallet jump does not launch the puck');
{
  const cfg = { ...base, mode: 'classic', players: 'pass' };
  const sim = createSim(cfg, { rng: rngFor(2) });
  const st = sim.state;
  st.phase = PHASE.PLAY;
  st.puck.x = W / 2;
  st.puck.y = H + G + H * 0.5;
  st.puck.vx = 0;
  st.puck.vy = 0;
  sim.setMallet('host', W / 2, bottom - 60, 1000, true);
  sim.setMallet('host', W / 2, st.puck.y, 1016, true); // lands on the puck
  check(Math.hypot(st.mallets.host.vx, st.mallets.host.vy) === 0, 'jump keeps mallet velocity at zero');
  sim.setMallet('host', W / 2, bottom - 60, 1032, true);
  sim.setMallet('host', W / 2, H + G + 20, 1048); // long step without the flag: auto-jump
  check(Math.hypot(st.puck.vx, st.puck.vy) === 0, 'long step must not fire the puck');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
process.exit(failures ? 1 : 0);
