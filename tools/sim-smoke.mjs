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
const ITEMS_ALL = ['rocket', 'shield', 'ghost', 'shrink', 'freeze', 'mine'];
const ITEMS_OK = ITEMS_ALL;
const ROCKET_CAP = 3900;

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

// ---- battle ------------------------------------------------------------------------------
console.log('\nBattle: boxes, items, bot');
{
  const mR = base.malletR;
  const pR = base.puckR;
  const newBattle = (extra = {}, seed = 31) => {
    const cfg = { ...base, mode: 'battle', players: 'pass', ...extra };
    const sim = createSim(cfg, { rng: rngFor(seed) });
    return { cfg, sim, st: sim.state, clock: { now: 1000 } };
  };
  const stepN = (b, sec, each) => {
    const evs = [];
    for (let i = 0; i < Math.round(sec / DT); i++) {
      b.clock.now += DT * 1000;
      if (each) each();
      b.sim.step(DT, b.clock.now);
      for (const e of b.sim.snapshot().ev) evs.push(e);
    }
    return evs;
  };
  const toPlay = (b) => {
    b.sim.setReady('host');
    b.sim.setReady('guest');
    for (let i = 0; i < 400 && b.st.phase !== PHASE.PLAY; i++) {
      b.clock.now += DT * 1000;
      b.sim.step(DT, b.clock.now);
      b.sim.snapshot();
    }
  };
  /** Skip the serve: a bare play phase with a still puck and no box timers. */
  const barePlay = (b, x = W * 0.1, y = H + G + H * 0.2) => {
    b.st.phase = PHASE.PLAY;
    Object.assign(b.st.puck, { x, y, vx: 0, vy: 0 });
  };
  const speed = (p) => Math.hypot(p.vx, p.vy);

  // Mode wiring and the snapshot shape.
  check(MODES.includes('battle') && MODE_PHYS.battle.max === 2600 && MODE_PHYS.battle.fric === MODE_PHYS.classic.fric, 'battle in MODES and MODE_PHYS');
  for (const mode of MODES) {
    const sn = createSim({ ...base, mode }).snapshot();
    if (mode === 'battle') {
      check(Array.isArray(sn.it) && sn.it.join() === ',' && sn.bt && sn.bt.mr.join() === `${mR},${mR}`, `battle snapshot it/bt (${JSON.stringify(sn.it)})`);
      check(sn.bt.sh.length === 2 && sn.bt.gh.length === 2 && sn.bt.sk.length === 2 && sn.bt.rk.length === 2 && sn.bt.fz === 0, 'battle bt fields');
    } else {
      check(sn.it === undefined && sn.bt === undefined, `${mode}: no it/bt in the snapshot`);
      check(createSim({ ...base, mode }).state.bt === undefined && createSim({ ...base, mode }).useItem('host') === false, `${mode}: no battle state, useItem refuses`);
    }
  }

  // Boxes: two slots, hidden until 1 s after the first serve, one per half.
  {
    const b = newBattle();
    const ob0 = b.sim.snapshot().ob;
    check(ob0.length === 2 && ob0.every((o) => o.k === 'box' && o.a === 0), 'boxes start as two inactive slots');
    check(Math.abs(ob0[0].r - mR * 0.55) < 0.06, `box radius ${ob0[0].r}`);
    toPlay(b);
    check(b.st.phase === PHASE.PLAY, 'battle: reached play');
    const parkCorner = () => Object.assign(b.st.puck, { x: pR + 2, y: H + G + 60, vx: 0, vy: 0 });
    const early = stepN(b, 0.9, parkCorner);
    check(b.sim.snapshot().ob.every((o) => o.a === 0) && !early.some((e) => e.k === 'boxspawn'), 'no box before 1 s after the serve');
    const late = stepN(b, 0.3, parkCorner);
    const ob1 = b.sim.snapshot().ob;
    check(ob1.length === 2 && ob1.every((o) => o.a === 1), 'both boxes present 1 s after the serve');
    check(late.filter((e) => e.k === 'boxspawn').length === 2, 'two boxspawn events');
    const ys = ob1.map((o) => o.y).sort((p, q) => p - q);
    check(ys[0] < H && ys[1] > H + G, 'one box in each half');
    check(Math.abs(ob1[0].x - (W - ob1[1].x)) < 0.2 && Math.abs(ob1[0].y - (bottom - ob1[1].y)) < 0.2, 'opening boxes are a mirrored pair');
    check(b.st.obs === b.sim.obstacles, 'state.obs is the obstacle array');
  }

  // Collection: credit follows lastHit, then the box's half; a full slot passes.
  {
    const b = newBattle({}, 32);
    toPlay(b);
    stepN(b, 1.3);
    const boxes = b.sim.obstacles.filter((o) => o.k === 'box');
    const hostBox = boxes.find((o) => o.y > H + G);
    const guestBox = boxes.find((o) => o.y < H);
    const parkOn = (o) => {
      Object.assign(b.st.puck, { x: o.x, y: o.y, vx: 0, vy: 0 });
    };
    // Credited to lastHit even in the other half.
    b.st.lastHit = 'guest';
    parkOn(hostBox);
    let evs = stepN(b, DT);
    const ev = evs.find((e) => e.k === 'box');
    check(!!ev && ev.by === 'guest' && ITEMS_OK.includes(ev.item) && b.st.items.guest === ev.item && b.st.items.host === null, `box credits lastHit (${JSON.stringify(ev)})`);
    check(ev && ev.x === Math.round(hostBox.x * 10) / 10 && ev.s === 1, 'box event at the box');
    check(!hostBox.on && b.sim.snapshot().ob.filter((o) => o.a === 1).length === 1, 'collected box switches off');
    // Respawns 6..8 s later at a (new) free spot.
    const t0 = b.st.time;
    parkOn({ x: W * 0.1, y: H + G + H * 0.2 });
    let respawn = null;
    for (let i = 0; i < Math.round(9 / DT) && !respawn; i++) {
      const out = stepN(b, DT, () => Object.assign(b.st.puck, { x: W * 0.1, y: H + G + H * 0.2, vx: 0, vy: 0 }));
      respawn = out.find((e) => e.k === 'boxspawn') || null;
    }
    check(!!respawn && b.st.time - t0 >= 5.95 && b.st.time - t0 <= 8.1, `respawn 6..8 s later (${(b.st.time - t0).toFixed(2)})`);
    // lastHit null: the half decides. Guest already holds an item, so give host first.
    b.st.lastHit = null;
    b.st.items.host = null;
    b.st.items.guest = null;
    const gb = b.sim.obstacles.filter((o) => o.k === 'box' && o.on && o.y < H)[0] || null;
    if (gb) {
      parkOn(gb);
      evs = stepN(b, DT);
      const e2 = evs.find((e) => e.k === 'box');
      check(!!e2 && e2.by === 'guest', 'box in the guest half credits the guest when nobody hit the puck');
    }
    // Full slot: puck passes through, box stays, item unchanged.
    b.st.items.host = 'freeze';
    b.st.lastHit = 'host';
    const hb = b.sim.obstacles.filter((o) => o.k === 'box' && o.on)[0];
    if (hb) {
      parkOn(hb);
      evs = stepN(b, DT);
      check(!evs.some((e) => e.k === 'box') && hb.on && b.st.items.host === 'freeze', 'a full slot does not collect');
    } else check(true, 'no live box left for the full-slot check');
  }

  // Item roll: seeded, catch-up weighting.
  {
    const counts = (hostScore, guestScore, extra = { players: 'duo' }) => {
      const b = newBattle(extra, 33);
      b.st.score.host = hostScore;
      b.st.score.guest = guestScore;
      const n = {};
      for (let i = 0; i < 4000; i++) {
        b.st.phase = PHASE.PLAY;
        b.st.items.host = null;
        b.st.lastHit = 'host';
        b.st.time = 100;
        const bx = b.sim.obstacles[0];
        bx.on = true;
        bx.x = b.st.puck.x;
        bx.y = b.st.puck.y;
        b.sim.obstacles[1].on = false;
        b.sim.obstacles[1].spawnAt = Infinity;
        bx.spawnAt = Infinity;
        b.sim.step(DT, 1000 + i);
        const it = b.st.items.host;
        if (it) n[it] = (n[it] || 0) + 1;
        b.sim.snapshot();
      }
      return n;
    };
    const even = counts(0, 0);
    const behind = counts(0, 3);
    const ahead = counts(5, 0);
    const off = (n) => ((n.rocket || 0) + (n.ghost || 0) + (n.shrink || 0) + (n.mine || 0)) / Object.values(n).reduce((a, c) => a + c, 0);
    console.log(`  offensive share: even ${off(even).toFixed(2)}, behind ${off(behind).toFixed(2)}, ahead ${off(ahead).toFixed(2)}`);
    check(ITEMS_ALL.every((id) => even[id] > 100), `every item can roll (${JSON.stringify(even)})`);
    const pass = counts(0, 0, { players: 'pass' });
    check(!pass.ghost && ITEMS_ALL.filter((id) => id !== 'ghost').every((id) => pass[id] > 100), `pass and play never rolls ghost (${JSON.stringify(pass)})`);
    check(off(behind) > off(even) + 0.05 && off(ahead) < off(even) - 0.05, 'catch-up weighting favours offence when behind');
  }

  // Items.
  {
    // rocket
    const b = newBattle({}, 34);
    barePlay(b);
    b.st.items.host = 'rocket';
    check(b.sim.useItem('host') === true && b.st.bt.rk[0] === 1 && b.st.items.host === null, 'rocket: armed, item consumed');
    check(b.sim.useItem('host') === false, 'useItem with an empty hand is false');
    const ue = b.sim.snapshot().ev.find((e) => e.k === 'use');
    check(ue && ue.by === 'host' && ue.item === 'rocket' && ue.s === 1, `use event ${JSON.stringify(ue)}`);
    // Stage a fast mallet moving +x into a still puck.
    const STEP = 50;
    Object.assign(b.st.puck, { x: 700, y: H + G + 400, vx: 0, vy: 0 });
    let mx = 700 - 80 - STEP * 10;
    b.clock.now = 2000;
    b.sim.setMallet('host', mx, b.st.puck.y, b.clock.now, true);
    for (let i = 0; i < 10; i++) {
      b.clock.now += DT * 1000;
      mx += STEP;
      b.sim.setMallet('host', mx, b.st.puck.y, b.clock.now);
    }
    b.clock.now += DT * 1000;
    b.sim.setMallet('host', mx + STEP, b.st.puck.y, b.clock.now);
    const hitEv = b.sim.snapshot().ev;
    const re = hitEv.find((e) => e.k === 'rocket');
    check(!!re && re.by === 'host' && re.s === 1, `rocket event ${JSON.stringify(re)}`);
    const sp0 = speed(b.st.puck);
    check(sp0 > 3800 && sp0 <= 3900 + 1e-6, `rocket launch speed ${Math.round(sp0)} (cap 3900)`);
    check(b.st.bt.rk[0] === 0 && b.st.bt.rk[1] === 0, 'rocket consumed by the hit');
    let peak = sp0;
    let late = 0;
    let t = 0;
    const evs = stepN(b, 0.8, () => {
      t += DT;
      peak = Math.max(peak, speed(b.st.puck));
      if (t > 0.1) late = Math.max(late, speed(b.st.puck));
    });
    check(peak <= 3900 + 1e-6 && b.st.phase === PHASE.PLAY, `rocket flight speed stays under 3900 (${Math.round(peak)})`);
    check(late > 2700, `puck keeps speed above the normal cap during the flight (${Math.round(late)})`);
    stepN(b, 0.6);
    check(speed(b.st.puck) <= 2600 + 1e-6, `normal cap resumes (${Math.round(speed(b.st.puck))})`);
    check(evs.every((e) => e.s >= 0 && e.s <= 5), 'rocket events in range');
  }
  {
    // rocket arming survives a goal; a slow rocket hit still reaches the minimum 1800
    const b = newBattle({}, 35);
    barePlay(b);
    b.st.items.host = 'rocket';
    b.sim.useItem('host');
    b.sim.snapshot();
    Object.assign(b.st.puck, { x: W / 2, y: 30, vx: 0, vy: -900 });
    stepN(b, 0.3);
    check(b.st.phase === PHASE.GOAL && b.st.bt.rk[0] === 1, 'rocket arming survives a goal');
    const STEP = 8;
    barePlay(b);
    Object.assign(b.st.puck, { x: 700, y: H + G + 400 });
    let mx = 700 - 80 - STEP * 10;
    b.sim.setMallet('host', mx, b.st.puck.y, 3000, true);
    let now = 3000;
    for (let i = 0; i < 13; i++) {
      now += DT * 1000;
      mx += STEP;
      b.sim.setMallet('host', mx, b.st.puck.y, now);
    }
    const sp = speed(b.st.puck);
    check(sp >= 1800 - 1e-6 && sp <= 1900, `slow rocket hit is lifted to the minimum (${Math.round(sp)})`);
  }
  {
    // shield
    const b = newBattle({}, 36);
    barePlay(b);
    b.sim.setMallet('host', W * 0.15, bottom - 400, 100, true);
    b.st.items.host = 'shield';
    check(b.sim.useItem('host') && b.st.bt.sh[0] === 1 && b.st.bt.sh[1] === 0, 'shield: timer on the holder side');
    Object.assign(b.st.puck, { x: W / 2 + 40, y: bottom - 120, vx: 0, vy: 1600 });
    const evs = stepN(b, 0.5);
    const se = evs.find((e) => e.k === 'shieldhit');
    check(!!se && se.by === 'host' && se.s > 0 && se.s <= 1, `shieldhit event ${JSON.stringify(se)}`);
    check(b.st.phase === PHASE.PLAY && b.st.score.guest === 0, 'shield keeps the goal closed');
    check(b.st.puck.vy < 0, 'shield bounce reverses the puck');
    const impact = 1600 * Math.pow(0.8, 0.07);
    check(speed(b.st.puck) > impact * 0.5, 'shield bounce keeps its speed');
    // Without a shield the same shot scores.
    const c = newBattle({}, 36);
    barePlay(c);
    c.sim.setMallet('host', W * 0.15, bottom - 400, 100, true);
    Object.assign(c.st.puck, { x: W / 2 + 40, y: bottom - 120, vx: 0, vy: 1600 });
    stepN(c, 0.5);
    check(c.st.score.guest === 1, 'control: same shot scores without a shield');
    // Timer runs out, then the goal is open again.
    stepN(b, 0.6);
    check(b.st.bt.sh[0] === 0, 'shield expires');
    // Guest shield protects the guest goal.
    const g = newBattle({}, 36);
    barePlay(g);
    g.sim.setMallet('guest', W * 0.85, 400, 100, true);
    g.st.items.guest = 'shield';
    g.sim.useItem('guest');
    Object.assign(g.st.puck, { x: W / 2 - 30, y: 120, vx: 0, vy: -1600 });
    const gev = stepN(g, 0.5);
    check(gev.some((e) => e.k === 'shieldhit' && e.by === 'guest') && g.st.score.host === 0 && g.st.puck.vy > 0, 'guest shield bounces the puck');
  }
  {
    // ghost
    const b = newBattle({}, 37);
    barePlay(b);
    b.st.items.host = 'ghost';
    b.sim.useItem('host');
    check(b.st.bt.gh[1] === 2 && b.st.bt.gh[0] === 0, 'ghost: target side only');
    stepN(b, 1);
    check(Math.abs(b.st.bt.gh[1] - 1) < 0.02, `ghost counts down (${b.st.bt.gh[1]})`);
    stepN(b, 1.1);
    check(b.st.bt.gh[1] === 0, 'ghost expires');
  }
  {
    // shrink
    const b = newBattle({}, 38);
    barePlay(b);
    b.st.items.host = 'shrink';
    b.sim.useItem('host');
    check(b.st.bt.sk[1] === 4 && Math.abs(b.st.bt.mr[1] - mR * 0.6) < 1e-9 && b.st.bt.mr[0] === mR, 'shrink: target radius 0.6 x malletR');
    const sn = b.sim.snapshot();
    check(sn.bt.mr[1] === Math.round(mR * 0.6 * 10) / 10 && sn.bt.mr[0] === mR && sn.bt.sk[1] === 4, `snapshot mr ${JSON.stringify(sn.bt.mr)}`);
    b.sim.setMallet('guest', -50, -50, 5000, true);
    check(Math.abs(b.st.mallets.guest.x - mR * 0.6) < 1e-9 && Math.abs(b.st.mallets.guest.y - mR * 0.6) < 1e-9, 'shrunk guest mallet clamps with the smaller radius');
    b.sim.setMallet('host', -50, 99999, 5000, true);
    check(b.st.mallets.host.x === mR, 'host mallet keeps its full radius');
    // Puck just outside the shrunk radius but inside the full radius: no contact.
    b.sim.setMallet('guest', W / 2, 200, 5100, true);
    const gap = pR + mR * 0.6 + 3;
    Object.assign(b.st.puck, { x: W / 2, y: 200 + gap, vx: 0, vy: 0 });
    stepN(b, DT);
    check(Math.abs(b.st.puck.y - (200 + gap)) < 1e-9 && b.st.puck.vy === 0, 'shrunk mallet does not touch at the old radius');
    // The unshrunk host mallet still collides at its normal radius.
    b.sim.setMallet('host', W / 2, bottom - 300, 5200, true);
    Object.assign(b.st.puck, { x: W / 2, y: bottom - 300 - (pR + mR - 4), vx: 0, vy: 0 });
    b.st.mallets.host.vy = 300;
    b.sim.setMallet('host', W / 2, bottom - 300, 5216);
    check(Math.hypot(b.st.puck.x - W / 2, b.st.puck.y - (bottom - 300)) >= pR + mR - 1e-6, 'host mallet pushes the puck out at full radius');
    stepN(b, 4.1);
    check(b.st.bt.sk[1] === 0 && b.st.bt.mr[1] === mR, 'shrink expires and the radius is restored');
    // A shrunk mallet grown back next to a wall is clamped.
    const c = newBattle({}, 38);
    barePlay(c);
    c.st.items.host = 'shrink';
    c.sim.useItem('host');
    c.sim.setMallet('guest', 0, 400, 100, true);
    stepN(c, 4.1);
    check(c.st.mallets.guest.x >= mR - 1e-9, 'grown mallet is clamped back inside');
  }
  {
    // freeze
    const b = newBattle({}, 39);
    barePlay(b, W * 0.3, bottom / 2);
    b.st.puck.vx = 800;
    b.st.puck.vy = -500;
    b.st.items.guest = 'freeze';
    b.sim.useItem('guest');
    const sn = b.sim.snapshot();
    check(sn.p[2] === 0 && sn.p[3] === 0 && sn.bt.fz === 0.5, `frozen snapshot has zero velocity (${JSON.stringify(sn.p)}, fz ${sn.bt.fz})`);
    const px = b.st.puck.x;
    const py = b.st.puck.y;
    stepN(b, 0.3);
    check(b.st.puck.x === px && b.st.puck.y === py, 'frozen puck does not move');
    // A mallet pushed onto the frozen puck does nothing to it.
    b.sim.setMallet('host', px, py, 6000, true);
    b.sim.setMallet('host', px + 3, py + 3, 6016);
    check(b.st.puck.x === px && b.st.puck.y === py && b.st.puck.vx === 0, 'frozen puck ignores mallets');
    b.sim.setMallet('host', W / 2, bottom - H * 0.2, 6032, true);
    const evs = stepN(b, 0.4);
    const te = evs.find((e) => e.k === 'thaw');
    check(!!te && b.st.bt.fz === 0, 'thaw event after 0.5 s');
    check(b.st.puck.vx > 700 && b.st.puck.vx <= 800 && b.st.puck.vy < -400, `velocity restored (${Math.round(b.st.puck.vx)}, ${Math.round(b.st.puck.vy)})`);
    check(b.st.puck.x !== px, 'puck moves again after the thaw');
  }
  {
    // mine: fuse, armed, hit, expiry; the obstacle array reference never changes
    const b = newBattle({}, 40);
    barePlay(b);
    const ref = b.sim.obstacles;
    b.st.items.host = 'mine';
    check(b.sim.useItem('host') === true, 'mine: dropped');
    const dropEvs = b.sim.snapshot();
    const md = dropEvs.ev.find((e) => e.k === 'minedrop');
    check(!!md && md.by === 'host' && dropEvs.ev.some((e) => e.k === 'use' && e.item === 'mine'), `minedrop event ${JSON.stringify(md)}`);
    const mine = b.sim.obstacles.find((o) => o.k === 'mine');
    check(!!mine && mine.drop === true && mine.y < H && Math.abs(mine.r - mR * 0.45) < 1e-9, 'mine lands in the target half (guest) with the mine radius');
    check(Math.abs(mine.rearmAt - (b.st.time + 1)) < 1e-9 && Math.abs(mine.expireAt - (b.st.time + 11)) < 1e-9, 'fuse 1 s, live 10 s');
    const m0 = dropEvs.ob.find((o) => o.k === 'mine');
    check(m0 && m0.a === 0, 'mine unarmed during the fuse');
    check(Math.hypot(mine.x - b.st.mallets.guest.x, mine.y - b.st.mallets.guest.y) >= mR * 2.5 + mine.r - 1e-9, 'mine clear of the guest mallet');
    // On the fuse it is inert.
    Object.assign(b.st.puck, { x: mine.x, y: mine.y, vx: 0, vy: 0 });
    let evs = stepN(b, 0.5, () => Object.assign(b.st.puck, { x: mine.x, y: mine.y, vx: 0, vy: 0 }));
    check(!evs.some((e) => e.k === 'mine') && b.sim.obstacles.includes(mine), 'unarmed mine does not blast');
    Object.assign(b.st.puck, { x: W * 0.1, y: H * 0.5, vx: 0, vy: 0 });
    stepN(b, 0.6, () => Object.assign(b.st.puck, { x: W * 0.1, y: H * 0.5, vx: 0, vy: 0 }));
    check(b.sim.snapshot().ob.find((o) => o.k === 'mine').a === 1, 'mine armed after the fuse');
    // Hit: blast, removed, same array.
    Object.assign(b.st.puck, { x: mine.x, y: mine.y, vx: 0, vy: 0 });
    evs = stepN(b, DT);
    const me = evs.find((e) => e.k === 'mine');
    check(!!me && me.s === 1, 'armed mine blasts the puck');
    check(speed(b.st.puck) > 2000, `blast speed ${Math.round(speed(b.st.puck))}`);
    check(!b.sim.obstacles.includes(mine) && b.sim.obstacles === ref && b.st.obs === ref, 'hit mine is removed in place');
    check(b.sim.snapshot().ob.every((o) => o.k !== 'mine'), 'mine gone from the snapshot');
    // Expiry.
    barePlay(b);
    b.st.items.host = 'mine';
    check(b.sim.useItem('host'), 'second mine dropped');
    const keep = () => Object.assign(b.st.puck, { x: W * 0.1, y: H + G + H * 0.2, vx: 0, vy: 0 });
    stepN(b, 10.5, keep);
    check(b.sim.obstacles.some((o) => o.k === 'mine'), 'mine still live at 10.5 s');
    stepN(b, 1, keep);
    check(!b.sim.obstacles.some((o) => o.k === 'mine') && b.sim.obstacles === ref, 'mine expires after 11 s, array unchanged');
    // Goal clears an un-hit dropped mine.
    barePlay(b);
    b.st.items.guest = 'mine';
    b.sim.useItem('guest');
    check(b.sim.obstacles.some((o) => o.drop), 'guest mine dropped (host half)');
    Object.assign(b.st.puck, { x: W / 2, y: bottom - 30, vx: 0, vy: 900 });
    stepN(b, 0.3);
    check(b.st.phase === PHASE.GOAL && !b.sim.obstacles.some((o) => o.drop), 'goal clears dropped mines');
  }
  {
    // Not in play / wrong role.
    const b = newBattle({}, 41);
    b.st.items.host = 'freeze';
    check(b.sim.useItem('host') === false && b.st.items.host === 'freeze', 'useItem refused outside play, item kept');
    barePlay(b);
    check(b.sim.useItem('nobody') === false, 'useItem rejects a bad role');
    // Goal clears timers but keeps held items.
    b.st.items.guest = 'ghost';
    b.st.bt.sh[0] = 1;
    b.st.bt.gh[1] = 2;
    b.st.bt.sk[0] = 3;
    b.sim.useItem('guest');
    b.st.items.host = 'mine';
    Object.assign(b.st.puck, { x: W / 2, y: 30, vx: 0, vy: -900 });
    stepN(b, 0.3);
    const bt = b.st.bt;
    check(b.st.phase === PHASE.GOAL && bt.sh[0] === 0 && bt.gh[1] === 0 && bt.sk[0] === 0 && bt.mr[0] === mR && bt.fz === 0, 'goal clears shield, ghost, shrink and freeze');
    check(b.st.items.host === 'mine', 'held items survive goals');
    b.sim.restart();
    check(b.st.items.host === null && b.st.items.guest === null && b.st.bt.rk.join() === '0,0', 'restart clears held items and arming');
    const sn = b.sim.snapshot();
    check(sn.ob.length === 2 && sn.ob.every((o) => o.k === 'box' && o.a === 0), 'restart puts the boxes back to the initial state');
  }
  {
    // setGap rebuilds the initial box state and keeps the array.
    const b = newBattle({}, 42);
    const ref = b.sim.obstacles;
    check(b.sim.setGap(120) && b.sim.obstacles === ref && ref.length === 2 && ref.every((o) => o.k === 'box' && !o.on), 'setGap rebuilds boxes in place');
    b.sim.setGap(G);
  }

  // Bot: uses its item within a few seconds (shield and freeze wait for a cue).
  for (const item of ['rocket', 'ghost', 'shrink', 'mine']) {
    const b = newBattle({ players: 'bot', botLevel: 'medium' }, 43);
    b.sim.setReady('host');
    barePlay(b);
    b.st.items.guest = item;
    const evs = stepN(b, 2.6, () => Object.assign(b.st.puck, { x: W * 0.1, y: H + G + H * 0.2, vx: 0, vy: 0 }));
    const ue = evs.find((e) => e.k === 'use');
    check(!!ue && ue.by === 'guest' && ue.item === item && b.st.items.guest === null, `bot uses ${item} within 2.6 s`);
    check(ue && ue.s === 1, 'bot use event strength');
  }
  for (const item of ['shield', 'freeze']) {
    const b = newBattle({ players: 'bot', botLevel: 'medium' }, 44);
    b.sim.setReady('host');
    barePlay(b);
    b.st.items.guest = item;
    const park = () => Object.assign(b.st.puck, { x: W * 0.1, y: H + G + H * 0.2, vx: 0, vy: 0 });
    stepN(b, 6, park);
    check(b.st.items.guest === item, `bot holds ${item} without a cue`);
    stepN(b, 8, park);
    check(b.st.items.guest === null, `bot uses ${item} after the fallback wait`);
    // With the cue it fires right after the hold time.
    const c = newBattle({ players: 'bot', botLevel: 'medium' }, 44);
    c.sim.setReady('host');
    barePlay(c);
    c.st.items.guest = item;
    const evs = stepN(c, 2.7, () => Object.assign(c.st.puck, { x: W / 2, y: item === 'shield' ? H * 0.5 : H * 0.4, vx: 0, vy: item === 'shield' ? -900 : -1200 }));
    check(evs.some((e) => e.k === 'use' && e.item === item), `bot uses ${item} when the puck is coming`);
  }

  // Full battle runs against the bot, both sides firing whatever they hold.
  let totals = { box: 0, use: 0 };
  for (const botLevel of ['easy', 'medium', 'hard', 'impossible']) {
    for (const seed of [1, 2, 3]) {
      const b = newBattle({ players: 'bot', botLevel }, seed);
      const ref = b.sim.obstacles;
      b.sim.setReady('host');
      let bad = 0;
      let overCap = 0;
      const kinds = {};
      for (let i = 0; i < Math.round(30 / DT); i++) {
        b.clock.now += DT * 1000;
        hostScript(b.sim, b.clock.now, 'chase');
        if (b.st.items.host && i % 90 === 0) b.sim.useItem('host');
        b.sim.step(DT, b.clock.now);
        const s = b.st;
        const p = s.puck;
        if (![p.x, p.y, p.vx, p.vy, s.mallets.host.x, s.mallets.host.y, s.mallets.guest.x, s.mallets.guest.y, ...s.bt.mr, ...s.bt.sh, ...s.bt.gh, ...s.bt.sk, s.bt.fz].every(Number.isFinite)) bad++;
        if (speed(p) > ROCKET_CAP + 1e-6) overCap++;
        if (s.bt.mr.some((v) => v < mR * 0.6 - 1e-9 || v > mR + 1e-9)) bad++;
        for (const m of [s.mallets.host, s.mallets.guest]) if (m.x < 0 || m.x > W || m.y < 0 || m.y > bottom) bad++;
        const sn = b.sim.snapshot();
        if (sn.ob.some((o) => !Number.isFinite(o.x + o.y + o.r + o.a)) || sn.ob.filter((o) => o.k === 'box').length !== 2) bad++;
        if (sn.ev.length > 16) bad++;
        for (const e of sn.ev) {
          kinds[e.k] = (kinds[e.k] || 0) + 1;
          if (!(e.s >= 0 && e.s <= 5)) bad++;
        }
        if (!sn.it || sn.it.length !== 2 || !sn.bt || sn.bt.mr.length !== 2) bad++;
        if (s.phase === PHASE.OVER) break;
      }
      totals.box += kinds.box || 0;
      totals.use += kinds.use || 0;
      check(bad === 0, `battle/${botLevel} seed ${seed}: ${bad} bad values or events`);
      check(overCap === 0, `battle/${botLevel} seed ${seed}: puck over 3900 px/s`);
      check(b.sim.obstacles === ref && b.st.obs === ref, `battle/${botLevel} seed ${seed}: obstacle array reference kept`);
    }
  }
  console.log(`  12 x 30 s battle runs: ${totals.box} boxes collected, ${totals.use} items used`);
  check(totals.box > 0 && totals.use > 0, 'battle runs collect and use items');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
process.exit(failures ? 1 : 0);
