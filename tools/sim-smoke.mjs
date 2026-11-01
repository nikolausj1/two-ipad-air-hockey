// Headless smoke test for public/sim.js + public/bot.js.
// Run: node tools/sim-smoke.mjs
import { createSim, PHASE, MODES, MODE_PHYS, eventsOf, predictMalletHit, advancePuck } from '../public/sim.js';

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
let bottom = 2 * H + G;
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
  // Pre-match: every run starts in 'ready'; bot mode auto-readies the guest.
  check(sim.state.phase === PHASE.READY, `${name}: starts in ready`);
  sim.setReady('host');
  sim.setReady('guest');
  check(sim.state.phase === PHASE.COUNTDOWN, `${name}: both ready -> countdown`);
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

/** Run `sec` simulated seconds with no input; returns the event kinds seen. */
function idle(sim, sec, t0 = 1000) {
  const kinds = {};
  let now = t0;
  for (let i = 0; i < Math.round(sec / DT); i++) {
    now += DT * 1000;
    sim.step(DT, now);
    for (const ev of eventsOf(sim.snapshot())) kinds[ev.k] = (kinds[ev.k] || 0) + 1;
  }
  return kinds;
}

// ---- ready phase -----------------------------------------------------------
console.log('Ready phase');
check(PHASE.READY === 'ready', 'PHASE.READY');
for (const players of ['duo', 'pass', 'bot']) {
  const sim = createSim({ ...base, mode: 'bumpers', players, botLevel: 'hard' }, { rng: rngFor(4) });
  const st = sim.state;
  check(st.phase === 'ready', `${players}: starts in ready`);
  const guestAuto = players === 'bot';
  check(sim.snapshot().rd.join() === `0,${guestAuto ? 1 : 0}`, `${players}: initial rd`);
  check(sim.snapshot().ph === 'ready', `${players}: snapshot ph`);
  const puck0 = { ...st.puck };
  const bot0 = { x: st.mallets.guest.x, y: st.mallets.guest.y };
  const evs = idle(sim, 2);
  check(Object.keys(evs).length === 0, `${players}: events while nobody ready ${JSON.stringify(evs)}`);
  check(st.phase === 'ready' && st.timer === 3, `${players}: stays ready`);
  check(st.puck.x === puck0.x && st.puck.y === puck0.y && st.puck.vx === 0 && st.puck.vy === 0, `${players}: puck still`);
  check(st.mallets.guest.x === bot0.x && st.mallets.guest.y === bot0.y, `${players}: guest mallet/bot does not move in ready`);
  check(Math.abs(st.puck.y - (st.serveTo === 'host' ? H + G + H / 2 : H / 2)) < 1e-9, `${players}: puck at centre of receiver half`);
  // Mallets move (and clamp) in ready, and do not collide with the puck.
  sim.setMallet('host', st.puck.x, st.puck.y, 2000, true);
  if (players !== 'bot') sim.setMallet('guest', st.puck.x, st.puck.y, 2000, true);
  idle(sim, 0.5, 2000);
  check(st.puck.vx === 0 && st.puck.vy === 0 && st.puck.x === puck0.x && st.puck.y === puck0.y, `${players}: no collision in ready`);
  sim.setMallet('host', -500, -500, 2100, true);
  const mh = st.mallets.host;
  check(mh.x === base.malletR && mh.y === H + G + base.malletR, `${players}: host mallet clamped in ready`);
  sim.setMallet('host', W / 2, bottom - H * 0.2, 2200, true);
  // Only one side ready: still nothing for 2 s.
  if (players === 'bot') {
    check(sim.setReady('guest', false) === false || st.ready.guest === true, 'bot guest cannot unready');
    check(st.ready.guest === true, 'bot guest stays ready');
    check(sim.setReady('host') === true, 'bot: setReady host');
    check(st.phase === 'countdown' && st.timer === 3, 'bot: host ready alone starts countdown');
    const snap = sim.snapshot();
    check(snap.ev.some((e) => e.k === 'ready' && e.by === 'host'), 'bot: ready event');
    check(snap.ev.some((e) => e.k === 'go'), 'bot: go event');
    check(snap.rd.join() === '1,1', 'bot: rd 1,1');
  } else {
    sim.setReady('host');
    check(st.ready.host && !st.ready.guest, `${players}: host flag`);
    const s1 = sim.snapshot();
    check(s1.rd.join() === '1,0', `${players}: rd 1,0`);
    check(s1.ev.some((e) => e.k === 'ready' && e.by === 'host'), `${players}: ready event host`);
    sim.setReady('host'); // repeat: no second event
    const evs2 = idle(sim, 2, 3000);
    check(!evs2.countdown && !evs2.go && !evs2.serve && !evs2.ready, `${players}: no countdown with one side ready ${JSON.stringify(evs2)}`);
    check(st.phase === 'ready', `${players}: still ready after 2 s`);
    sim.setReady('host', false);
    check(sim.snapshot().rd.join() === '0,0', `${players}: unready`);
    sim.setReady('host');
    sim.snapshot();
    sim.setReady('guest');
    check(st.phase === 'countdown' && st.timer === 3, `${players}: both ready -> countdown 3`);
    const s2 = sim.snapshot();
    check(s2.rd.join() === '1,1', `${players}: rd 1,1`);
    check(s2.ev.some((e) => e.k === 'ready' && e.by === 'guest'), `${players}: ready event guest`);
    check(s2.ev.some((e) => e.k === 'go'), `${players}: go event`);
  }
  // Countdown flows into play, and setReady/setGap are refused afterwards.
  const evs3 = idle(sim, 3.2, 5000);
  check(evs3.countdown >= 3 && evs3.serve === 1, `${players}: countdown+serve after ready ${JSON.stringify(evs3)}`);
  check(st.phase === 'play', `${players}: play after countdown`);
  check(sim.setReady('host', false) === false && st.ready.host, `${players}: setReady refused in play`);
  // restart returns to ready
  sim.restart();
  check(st.phase === 'ready' && !st.ready.host && st.ready.guest === guestAuto, `${players}: restart -> ready`);
  console.log(`  ${players.padEnd(5)} ok`);
}

// ---- setGap ------------------------------------------------------------------
console.log('\nsetGap');
for (const mode of MODES) {
  for (const players of ['pass', 'bot']) {
    const cfg = { ...base, mode, players, botLevel: 'medium' };
    const sim = createSim(cfg, { rng: rngFor(9) });
    const st = sim.state;
    for (const g2 of [0, 12, 40, 90, 180, 24]) {
      sim.setMallet('host', W * 0.3, bottom - H * 0.05, 100, true); // low in the host half
      check(sim.setGap(g2) === true, `${mode}/${players}: setGap(${g2}) accepted`);
      bottom = 2 * H + g2;
      const sb = H + g2;
      check(cfg.G === g2 && sim.cfg.G === g2, `${mode}: cfg.G updated`);
      const pr = base.puckR;
      const mr = base.malletR;
      const p = st.puck;
      check(p.x >= pr && p.x <= W - pr && p.y >= pr && p.y <= bottom - pr, `${mode} G=${g2}: puck inside rink`);
      check(Math.abs(p.y - (st.serveTo === 'host' ? sb + H / 2 : H / 2)) < 1e-9 && p.vx === 0 && p.vy === 0, `${mode} G=${g2}: puck at receiver centre`);
      const mh = st.mallets.host;
      const mg = st.mallets.guest;
      check(mh.y >= sb + mr - 1e-9 && mh.y <= bottom - mr + 1e-9 && mh.x >= mr && mh.x <= W - mr, `${mode} G=${g2}: host mallet inside host half (${mh.y})`);
      check(mg.y >= mr && mg.y <= H - mr && mg.x >= mr && mg.x <= W - mr, `${mode} G=${g2}: guest mallet inside guest half`);
      const snap = sim.snapshot();
      check(snap.g === g2, `${mode}: snapshot g`);
      for (const o of snap.ob) {
        const hostSide = o.y > sb;
        const guestSide = o.y < H;
        check(hostSide || guestSide, `${mode} G=${g2}: obstacle in the seam gap`);
        check(o.y - o.r > 0 && o.y + o.r < bottom && o.x - o.r > 0 && o.x + o.r < W, `${mode} G=${g2}: obstacle inside rink`);
        check(Math.abs(o.y - (H + g2 / 2)) > H * 0.15, `${mode} G=${g2}: obstacle too close to seam`);
        const mirror = snap.ob.find((q) => Math.abs(q.x - (W - o.x)) < 0.2 && Math.abs(q.y - (bottom - o.y)) < 0.2);
        check(!!mirror, `${mode} G=${g2}: obstacle mirror`);
      }
      // Mallet clamps now follow the new bounds.
      sim.setMallet('host', 5000, 99999, 200, true);
      check(Math.abs(st.mallets.host.y - (bottom - mr)) < 1e-9, `${mode} G=${g2}: host clamp uses new bottom`);
      sim.setMallet('host', -5, -99999, 300, true);
      check(Math.abs(st.mallets.host.y - (sb + mr)) < 1e-9, `${mode} G=${g2}: host clamp uses new seam`);
    }
    // Play on with the final gap: nothing escapes, no NaN.
    bottom = 2 * H + 24;
    sim.setReady('host');
    sim.setReady('guest');
    check(st.phase === 'countdown', `${mode}: ready after setGap`);
    const evs = idle(sim, 3.5, 7000);
    check(st.phase === 'play' && evs.serve === 1, `${mode}: plays after setGap`);
    check(sim.setGap(100) === false && cfg.G === 24, `${mode}/${players}: setGap refused in play`);
    // Refused in countdown too, and with junk input.
    sim.restart();
    check(sim.setGap(NaN) === false && sim.setGap(-3) === false && sim.setGap('x') === false, 'setGap rejects junk');
    sim.setReady('host');
    sim.setReady('guest');
    if (players === 'pass') check(st.phase === 'countdown' && sim.setGap(60) === false, `${mode}: setGap refused in countdown`);
    bottom = 2 * H + G;
  }
}
// Bot still plays correctly after a gap change (bot rebuilt with the new G).
{
  const cfg = { ...base, mode: 'classic', players: 'bot', botLevel: 'impossible' };
  const sim = createSim(cfg, { rng: rngFor(3) });
  sim.setGap(100);
  sim.state.serveTo = 'guest';
  sim.setReady('host');
  idle(sim, 4, 1000);
  const mg = sim.state.mallets.guest;
  check(mg.y <= H - base.malletR + 1e-9 && mg.y >= base.malletR, 'bot stays in guest half after setGap');
  console.log('  bot after setGap ok');
}
bottom = 2 * H + G;

// ---- obstacle layouts ------------------------------------------------------
console.log('Obstacle layouts');
for (const mode of ['classic', 'ice', 'glitch', 'bumpers', 'mines', 'bombs']) {
  const sim = createSim({ ...base, mode });
  const ob = sim.snapshot().ob;
  const n = ob.length;
  if (mode === 'bumpers') check(n >= 6 && n <= 10 && n % 2 === 0, `bumper count ${n}`);
  else if (mode === 'mines') check(n >= 4 && n <= 6 && n % 2 === 0, `mine count ${n}`);
  else if (mode === 'bombs') {
    check(n === 6, `bomb count ${n}`);
    check(ob.every((o) => o.k === 'bomb'), 'bombs mode: every obstacle is a bomb');
    check(Math.abs(ob[0].r - base.malletR * 0.5) < 0.06, `bomb radius ${ob[0].r}`);
    check(ob.every((o) => o.a === 0), 'bombs start unarmed');
  } else check(n === 0, `${mode} should have no obstacles`);
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
  const res = run(`idle-host ${mode}/impossible`, { mode, players: 'bot', botLevel: 'impossible' }, { hostMode: 'idle', serveTo: 'guest', seed: 4 });
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
check(!MODES.includes('heavy') && !MODE_PHYS.heavy, 'heavy mode is gone');
check(MODES.includes('bombs') && MODES.includes('glitch'), 'bombs and glitch modes exist');
{
  const sim = createSim({ ...base, mode: 'heavy' });
  check(sim.cfg.mode === 'classic', 'unknown mode falls back to classic');
}
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

// ---- snapshot seq / ts / sv --------------------------------------------------
console.log('\nSnapshot seq, ts, sv');
{
  const sim = createSim({ ...base, mode: 'classic', players: 'pass' }, { rng: rngFor(8) });
  const a = sim.snapshot();
  const b = sim.snapshot();
  check(Number.isInteger(a.seq) && b.seq === a.seq + 1, `seq increments (${a.seq} -> ${b.seq})`);
  check(a.ts === 0 && b.ts === 0, 'ts is 0 before any step');
  check(a.sv === sim.state.serveTo && (a.sv === 'host' || a.sv === 'guest'), `sv is the serve side (${a.sv})`);
  let now = 1000;
  let prev = b;
  let monotonic = true;
  for (let i = 0; i < 90; i++) {
    now += DT * 1000;
    sim.step(DT, now);
    const sn = sim.snapshot();
    if (!(sn.seq === prev.seq + 1 && sn.ts >= prev.ts)) monotonic = false;
    prev = sn;
  }
  check(monotonic, 'seq +1 and ts non-decreasing every frame');
  check(Math.abs(prev.ts - 1.5) < 0.002, `ts tracks simulated time (${prev.ts})`);
  check(Math.round(prev.ts * 1000) === prev.ts * 1000 || Math.abs(prev.ts * 1000 - Math.round(prev.ts * 1000)) < 1e-6, 'ts has 3 decimals');
  console.log(`  seq ${a.seq}..${prev.seq}, ts ${prev.ts}, sv ${prev.sv}`);
}

// ---- predictMalletHit ----------------------------------------------------------
console.log('\npredictMalletHit');
for (const mode of ['classic', 'ice']) {
  const cfg = { ...base, mode, players: 'pass' };
  const sim = createSim(cfg, { rng: rngFor(6) });
  const st = sim.state;
  st.phase = PHASE.PLAY;
  const p = st.puck;
  p.x = W / 2;
  p.y = H + G + 300;
  p.vx = 0;
  p.vy = 0;
  const STEP = 20; // px per frame = 1200 px/s
  let my = p.y + 80 + STEP * 10;
  let now = 1000;
  sim.setMallet('host', W / 2, my, now, true);
  for (let i = 0; i < 10; i++) {
    now += DT * 1000;
    my -= STEP;
    sim.setMallet('host', W / 2, my, now);
  }
  const mh = st.mallets.host;
  check(Math.abs(mh.y - (p.y + 80)) < 1e-6, `${mode}: mallet staged 80 px below the puck`);
  const snap = sim.snapshot();
  const mallet = { x: mh.x, y: mh.y, vx: mh.vx, vy: mh.vy };
  // Far away / too short a sweep / moving away: no contact.
  const far = predictMalletHit(snap, cfg, 'host', { x: 100, y: bottom - 60, vx: 0, vy: 0 }, 0.05);
  check(far === null, `${mode}: far mallet -> null`);
  check(predictMalletHit(snap, cfg, 'host', { ...mallet, vy: 0 }, 0.001) === null, `${mode}: short dt, still mallet -> null`);
  check(predictMalletHit(snap, cfg, 'host', { ...mallet, vy: 500 }, 0.05) === null, `${mode}: mallet moving away -> null`);
  check(predictMalletHit(snap, cfg, 'host', mallet, 0.001) === null, `${mode}: 1 ms is too short to reach the puck`);
  const pred = predictMalletHit(snap, cfg, 'host', mallet, DT);
  check(pred !== null, `${mode}: mallet moving into puck -> hit`);
  // Real sim: the same step.
  now += DT * 1000;
  my -= STEP;
  sim.setMallet('host', W / 2, my, now);
  const real = Math.hypot(p.vx, p.vy);
  if (pred) {
    const ps = Math.hypot(pred[2], pred[3]);
    const err = Math.abs(ps - real) / real;
    check(pred[3] < 0, `${mode}: predicted puck moves away from the host mallet (up)`);
    check(err <= 0.05, `${mode}: predicted speed ${ps.toFixed(0)} vs sim ${real.toFixed(0)} (${(err * 100).toFixed(2)}%)`);
    check(Math.hypot(pred[0] - p.x, pred[1] - p.y) <= 2, `${mode}: predicted puck position matches sim`);
    check(ps <= MODE_PHYS[mode].max + 1e-6, `${mode}: predicted speed within cap`);
    console.log(`  ${mode.padEnd(8)} predicted ${ps.toFixed(0)} px/s, sim ${real.toFixed(0)} px/s (${(err * 100).toFixed(2)}%)`);
  }
  // Pure: input snapshot untouched, a NEW array is returned.
  check(snap.p[0] === r1(W / 2) && snap.p[2] === 0, `${mode}: snapshot not mutated`);
}
function r1(v) {
  return Math.round(v * 10) / 10;
}
// A fast puck hitting a still guest mallet from below, and the speed cap.
{
  const cfg = { ...base, mode: 'ice', players: 'pass' };
  const snap = { p: [W / 2, 400, 0, -3000], g: G };
  const out = predictMalletHit(snap, cfg, 'guest', { x: W / 2, y: 300, vx: 0, vy: -3000 }, 0.02);
  check(out === null || Math.hypot(out[2], out[3]) <= MODE_PHYS.ice.max + 1e-6, 'predicted hit respects the ice cap');
}

// ---- advancePuck -----------------------------------------------------------------
console.log('\nadvancePuck vs the sim\'s own free puck motion (1 s, no mallets/obstacles involved)');
for (const [mode, v0] of [
  ['classic', [700, 150]],
  ['classic', [-1400, 240]],
  ['ice', [900, -200]],
]) {
  const cfg = { ...base, mode, players: 'pass' };
  const sim = createSim(cfg, { rng: rngFor(2) });
  const st = sim.state;
  st.phase = PHASE.PLAY;
  const p = st.puck;
  p.x = W / 2 - 120;
  p.y = bottom / 2;
  [p.vx, p.vy] = v0;
  const start = [p.x, p.y, p.vx, p.vy];
  const pred = advancePuck(start, cfg, 1);
  check(pred !== start && start[0] === W / 2 - 120 && start[2] === v0[0], `${mode}: advancePuck returns a new array`);
  let now = 1000;
  for (let i = 0; i < 60; i++) {
    now += DT * 1000;
    sim.step(DT, now);
  }
  const err = Math.hypot(pred[0] - p.x, pred[1] - p.y);
  const verr = Math.hypot(pred[2] - p.vx, pred[3] - p.vy);
  check(st.phase === PHASE.PLAY, `${mode}: no goal during the check`);
  check(err <= 1, `${mode} ${JSON.stringify(v0)}: advancePuck off by ${err.toFixed(3)} px`);
  check(verr <= 1, `${mode} ${JSON.stringify(v0)}: advancePuck velocity off by ${verr.toFixed(3)} px/s`);
  console.log(`  ${mode.padEnd(8)} v0=${JSON.stringify(v0).padEnd(11)} pos err ${err.toFixed(4)} px, vel err ${verr.toFixed(4)} px/s`);
}
{
  // Zero / negative dt returns the same state; a puck at a rail bounces back inside.
  const cfg = { ...base, mode: 'classic' };
  const same = advancePuck([100, 500, 10, 20], cfg, 0);
  check(same.join() === '100,500,10,20', 'advancePuck dt=0 is identity');
  const b = advancePuck([cfg.puckR + 1, 600, -900, 0], cfg, 0.1);
  check(b[0] >= cfg.puckR && b[2] > 0, 'advancePuck bounces off the side rail');
  const top = advancePuck([W / 2, cfg.puckR + 1, 0, -900], cfg, 0.1);
  check(top[1] >= cfg.puckR && top[3] > 0, 'advancePuck treats the end rail as solid (no goals)');
}


// ---- bombs: detonation ---------------------------------------------------------
console.log('\nBombs: arming, detonation, reset on serve');
{
  const cfg = { ...base, mode: 'bombs', players: 'pass' };
  const sim = createSim(cfg, { rng: rngFor(11) });
  const st = sim.state;
  const rd = (v) => Math.round(v * 10) / 10;
  let now = 1000;
  const tick = () => {
    now += DT * 1000;
    sim.step(DT, now);
    return sim.snapshot();
  };
  check(sim.state.obs === sim.obstacles, 'state.obs is the obstacle array');
  sim.setReady('host');
  sim.setReady('guest');
  for (let i = 0; i < 300 && st.phase !== PHASE.PLAY; i++) tick();
  check(st.phase === PHASE.PLAY, 'bombs: reached play');
  const parkPuck = () => {
    st.puck.x = W * 0.1;
    st.puck.y = H + G + H * 0.2;
    st.puck.vx = 0;
    st.puck.vy = 0;
  };
  parkPuck();
  check(sim.obstacles.every((o) => o.armed === false), 'bombs: unarmed right after the serve');
  let snap = tick();
  for (let i = 0; i < 5; i++) {
    parkPuck();
    snap = tick();
  }
  check(snap.ob.length === 6 && snap.ob.every((o) => o.k === 'bomb' && o.a === 1), `bombs arm once mallets are far (${JSON.stringify(snap.ob.map((o) => o.a))})`);
  const target = sim.obstacles.find((o) => o.y > H + G);
  const tx0 = target.x;
  const ty0 = target.y;
  // Walk the host mallet onto the bomb in short, non-teleporting steps.
  const mh = st.mallets.host;
  let found = null;
  for (let i = 1; i <= 8 && !found; i++) {
    parkPuck();
    const x0 = mh.x;
    const y0 = mh.y;
    now += DT * 1000;
    sim.setMallet('host', x0 + (tx0 - x0) / (9 - i), y0 + (ty0 - y0) / (9 - i), now);
    let sn = sim.snapshot();
    if (!sn.ev.some((e) => e.k === 'goal')) {
      sim.step(DT, now);
      sn = sim.snapshot();
    }
    if (sn.ev.some((e) => e.k === 'goal')) found = sn;
  }
  check(!!found, 'bombs: host mallet reached a bomb and it went off');
  if (found) {
    const be = found.ev.find((e) => e.k === 'bomb');
    const ge = found.ev.find((e) => e.k === 'goal');
    check(be && be.by === 'host' && be.s === 1, `bomb event ${JSON.stringify(be)}`);
    check(ge && ge.by === 'guest' && ge.why === 'bomb' && ge.s === 1, `goal event ${JSON.stringify(ge)}`);
    check(be && ge && be.x === rd(tx0) && be.y === rd(ty0), 'bomb event at the bomb position');
    check(ge && ge.x === rd(tx0) && ge.y === rd(ty0), 'goal event at the bomb position');
    check(st.score.guest === 1 && st.score.host === 0, `score after detonation ${st.score.host}-${st.score.guest}`);
    check(st.phase === PHASE.GOAL && found.ph === 'goal' && found.sc.join() === '0,1', 'phase goal after detonation');
    check(st.serveTo === 'host' && found.lg === 'guest', 'detonation serves to the loser');
    check(found.ev.filter((e) => e.k === 'goal').length === 1, 'one detonation per step');
    check(found.ev.every((e) => e.s >= 0 && e.s <= 5), 'event strengths in range');
  }
  // Bombs stay put in the goal pause, then the serve resets them.
  const before = sim.obstacles.map((o) => [o.x, o.y]);
  for (let i = 0; i < 30; i++) tick();
  check(sim.obstacles.every((o, i) => o.x === before[i][0] && o.y === before[i][1]), 'bombs do not move outside play');
  for (let i = 0; i < 400 && st.phase !== PHASE.PLAY; i++) tick();
  check(st.phase === PHASE.PLAY, 'bombs: serve after the pause');
  snap = sim.snapshot();
  check(sim.obstacles.every((o) => o.x === o.hx && o.y === o.hy && o.vx === 0 && o.vy === 0 && o.armed === false), 'bombs home and unarmed after the serve');
  check(snap.ob.every((o) => o.a === 0), 'snapshot a === 0 after the serve');
  // The host mallet still sits on the detonated bomb's home: it must stay unarmed
  // and harmless until the mallet moves away.
  parkPuck();
  for (let i = 0; i < 6; i++) {
    parkPuck();
    snap = tick();
  }
  check(st.phase === PHASE.PLAY, 'mallet on an unarmed bomb does not detonate it');
  const n0 = snap.ob.filter((o) => o.a === 1).length;
  check(n0 === 5 && target.armed === false, `only the covered bomb stays unarmed (${n0} armed)`);
  for (let i = 0; i < 6; i++) {
    parkPuck();
    now += DT * 1000;
    sim.setMallet('host', mh.x, Math.min(bottom - base.malletR, mh.y + 40), now);
    snap = tick();
  }
  check(snap.ob.every((o) => o.a === 1) && st.phase === PHASE.PLAY, 'bombs arm again after the mallets move away');
}

// ---- bombs: puck interaction ------------------------------------------------------
console.log('\nBombs: puck knocks bombs around');
{
  const cfg = { ...base, mode: 'bombs', players: 'pass' };
  const sim = createSim(cfg, { rng: rngFor(12) });
  const st = sim.state;
  st.phase = PHASE.PLAY;
  const home = sim.obstacles.map((o) => [o.x, o.y]);
  const b0 = sim.obstacles.find((o) => o.y > H + G && o.x < W / 3);
  const mid = sim.obstacles.find((o) => o.y > H + G && Math.abs(o.x - W / 2) < 1);
  const dir = { x: mid.x - b0.x, y: mid.y - b0.y };
  const dl = Math.hypot(dir.x, dir.y);
  dir.x /= dl;
  dir.y /= dl;
  const p = st.puck;
  p.x = b0.x - dir.x * 200;
  p.y = b0.y - dir.y * 200;
  p.vx = dir.x * 1700;
  p.vy = dir.y * 1700;
  let now = 1000;
  let hit = null;
  let maxBomb = 0;
  let maxMid = 0;
  let nan = 0;
  let overlap = 0;
  let outside = 0;
  let worst = 0;
  for (let i = 0; i < Math.round(3 / DT); i++) {
    now += DT * 1000;
    sim.step(DT, now);
    const sn = sim.snapshot();
    const e = sn.ev.find((q) => q.k === 'bombhit');
    if (e && !hit) hit = e;
    for (const q of sn.ev) if (!(q.s >= 0 && q.s <= 5)) nan++;
    maxBomb = Math.max(maxBomb, Math.hypot(b0.vx, b0.vy));
    maxMid = Math.max(maxMid, Math.hypot(mid.vx, mid.vy));
    const vals = [p.x, p.y, p.vx, p.vy];
    for (const o of sim.obstacles) vals.push(o.x, o.y, o.vx, o.vy);
    if (vals.some((v) => !Number.isFinite(v))) nan++;
    for (const o of sim.obstacles) {
      if (o.x - o.r < -1e-6 || o.x + o.r > W + 1e-6 || o.y - o.r < -1e-6 || o.y + o.r > bottom + 1e-6) outside++;
    }
    for (let a = 0; a < sim.obstacles.length; a++) {
      for (let b = a + 1; b < sim.obstacles.length; b++) {
        const A = sim.obstacles[a];
        const B = sim.obstacles[b];
        const ov = A.r + B.r - Math.hypot(A.x - B.x, A.y - B.y);
        worst = Math.max(worst, ov);
        if (ov > 0.5) overlap++;
      }
    }
  }
  console.log(`  bombhit ${JSON.stringify(hit)}, bomb peak ${Math.round(maxBomb)} px/s, centre bomb peak ${Math.round(maxMid)} px/s, worst bomb overlap ${worst.toFixed(3)} px`);
  check(!!hit, 'puck-bomb contact emits bombhit');
  check(hit && hit.s > 0.04 && hit.s <= 1, 'bombhit strength in (0.04, 1]');
  check(maxBomb > 300, `bomb gained velocity (${Math.round(maxBomb)})`);
  check(maxMid > 20, `bomb-bomb collision moved the second bomb (${Math.round(maxMid)})`);
  check(nan === 0, `bombs: NaN or bad event strength (${nan})`);
  check(overlap === 0, `bombs overlapped on ${overlap} frames (worst ${worst.toFixed(2)} px)`);
  check(outside === 0, `bombs left the rink on ${outside} frames`);
  check(home.some((h, i) => Math.hypot(sim.obstacles[i].x - h[0], sim.obstacles[i].y - h[1]) > 20), 'a bomb ended away from home');
}

// ---- glitch ----------------------------------------------------------------------------
console.log('\nGlitch: warning, short hops, only during play');
{
  const cfg = { ...base, mode: 'glitch', players: 'bot', botLevel: 'hard' };
  const sim = createSim(cfg, { rng: rngFor(26) });
  const st = sim.state;
  sim.setReady('host');
  let now = 1000;
  let warned = false;
  let warns = 0;
  let glitches = 0;
  let unwarned = 0;
  let badLen = 0;
  let badLand = 0;
  let badPhase = 0;
  let badS = 0;
  let minLen = Infinity;
  let maxLen = 0;
  const pr = base.puckR;
  const gd = base.goalW / 2 + pr * 3;
  for (let i = 0; i < Math.round(20 / DT); i++) {
    now += DT * 1000;
    hostScript(sim, now, 'chase');
    sim.step(DT, now);
    const sn = sim.snapshot();
    for (const ev of sn.ev) {
      if (!(ev.s >= 0 && ev.s <= 5)) badS++;
      if (ev.k === 'serve') warned = false;
      else if (ev.k === 'glitchwarn') {
        warned = true;
        warns++;
      } else if (ev.k === 'glitch') {
        glitches++;
        if (!warned) unwarned++;
        warned = false;
        const len = Math.hypot(ev.x - ev.fx, ev.y - ev.fy);
        minLen = Math.min(minLen, len / pr);
        maxLen = Math.max(maxLen, len / pr);
        if (len < 2.5 * pr - 0.3 || len > 6.5 * pr + 0.3) badLen++;
        const inside = ev.x >= pr && ev.x <= W - pr && ev.y >= pr && ev.y <= bottom - pr;
        const far = Math.hypot(ev.x - W / 2, ev.y) > gd - 0.2 && Math.hypot(ev.x - W / 2, ev.y - bottom) > gd - 0.2;
        if (!inside || !far) badLand++;
        if (st.phase !== PHASE.PLAY || sn.ph !== 'play') badPhase++;
      }
    }
    if (st.phase === PHASE.OVER) break;
  }
  console.log(`  glitches=${glitches} warns=${warns} jump ${minLen.toFixed(2)}..${maxLen.toFixed(2)} puck radii`);
  check(glitches >= 3, `at least 3 glitches in 20 s (${glitches})`);
  check(warns >= glitches, `a warning for every glitch (${warns} vs ${glitches})`);
  check(unwarned === 0, `${unwarned} glitches without a preceding glitchwarn`);
  check(badLen === 0, `${badLen} glitches with a jump length outside [2.5, 6.5] puck radii`);
  check(badLand === 0, `${badLand} glitches landing outside the rink or near a goal mouth`);
  check(badPhase === 0, `${badPhase} glitches outside the play phase`);
  check(badS === 0, `${badS} glitch-run events with s outside 0..5`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
process.exit(failures ? 1 : 0);
