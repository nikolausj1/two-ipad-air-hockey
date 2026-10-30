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
for (const mode of ['classic', 'ice', 'heavy']) {
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
  const cfg = { ...base, mode: 'heavy', players: 'pass' };
  const snap = { p: [W / 2, 400, 0, -3000], g: G };
  const out = predictMalletHit(snap, cfg, 'guest', { x: W / 2, y: 300, vx: 0, vy: -3000 }, 0.02);
  check(out === null || Math.hypot(out[2], out[3]) <= MODE_PHYS.heavy.max + 1e-6, 'predicted hit respects the heavy cap');
}

// ---- advancePuck -----------------------------------------------------------------
console.log('\nadvancePuck vs the sim\'s own free puck motion (1 s, no mallets/obstacles involved)');
for (const [mode, v0] of [
  ['classic', [700, 150]],
  ['classic', [-1400, 240]],
  ['ice', [900, -200]],
  ['heavy', [1200, 100]],
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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
process.exit(failures ? 1 : 0);
