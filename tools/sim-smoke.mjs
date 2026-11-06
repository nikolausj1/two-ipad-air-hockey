// Headless smoke test for public/sim.js + public/bot.js.
// Run: node tools/sim-smoke.mjs
import { createSim, PHASE, MODES, MODE_PHYS, TWISTS, ITEMS, eventsOf, predictMalletHit, advancePuck } from '../public/sim.js';

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
const ITEMS_ALL = [
  'rocket', 'shield', 'ghost', 'shrink', 'freeze',
  'magnet', 'widegoal', 'goalie', 'giant', 'catch', 'mirror', 'quake', 'decoys', 'steal', 'tinypuck',
];
const ITEMS_REMOVED = ['mine', 'barrier'];
const ITEMS_OK = ITEMS_ALL;
const OFFENSIVE = ['rocket', 'ghost', 'shrink', 'magnet', 'widegoal', 'mirror', 'quake', 'decoys', 'steal'];
const TWISTS_ALL = ['twinpuck', 'movinggoals', 'gravity', 'blackout', 'wind', 'hotpotato', 'shrinking', 'turbo'];
const ROCKET_CAP = 3900;
const SERVE_JUMP = 600 / 60 + 1; // one frame of serve-speed travel (SERVE_SPEED 600)

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

/** Puck q inside the rink (current puck radius, rail inset, goal offsets),
 *  or inside a goal mouth poking out by at most one puck radius. */
function inRink(s, q, e = 0.5) {
  const pr = s.pr;
  const inset = (s.tx && s.tx.in) || 0;
  const okX = q.x >= inset + pr - e && q.x <= W - inset - pr + e;
  const mouthTop = Math.abs(q.x - W / 2 - s.gx[1]) < s.gw[1] / 2;
  const mouthBot = Math.abs(q.x - W / 2 - s.gx[0]) < s.gw[0] / 2;
  const okY =
    (q.y >= pr - e || (mouthTop && q.y >= -pr - e)) &&
    (q.y <= bottom - pr + e || (mouthBot && q.y <= bottom + pr + e));
  return okX && okY;
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

/** Scripted host that goes round the puck: from behind it drives through,
 *  otherwise it moves to the side and below first. */
function strikerScript(sim, now) {
  const p = sim.state.puck;
  const m = sim.state.mallets.host;
  const R = sim.state.pr + base.malletR;
  let tx = W / 2 + Math.sin(now / 900) * 120;
  let ty = bottom - H * 0.2;
  if (p.y > H + G) {
    if (m.y > p.y + 20) {
      tx = p.x;
      ty = p.y;
    } else {
      tx = p.x + (m.x < p.x ? -1 : 1) * (R + 20);
      ty = p.y + R + 30;
    }
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
    for (const q of s.pucks) if (!inRink(s, q)) oob++;
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
    const wide = (i) => (snap.bt && snap.bt.wg[i] > 0 ? 1.5 : 1);
    const want = (d, i) => Math.min(W * 0.6, (cfg.comeback === false ? 1 : d >= 2 ? 0.6 : d === 1 ? 0.75 : 1) * cfg.goalW * wide(i));
    if (Math.abs(snap.gw[0] - want(sg - sh, 0)) > 0.2 || Math.abs(snap.gw[1] - want(sh - sg, 1)) > 0.2) badGw++;
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

  // Collection: a box goes to the player on the far side of it, if they hit the
  // puck last (or nobody did); your own side's boxes pass through; a full slot passes.
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
    // Your own box does nothing: the host dribbling through the host-half box.
    b.st.lastHit = 'host';
    parkOn(hostBox);
    let own = stepN(b, DT);
    check(!own.some((e) => e.k === 'box') && hostBox.on && b.st.items.host === null, 'a box in your own half cannot be collected');
    // The guest shooting through the host-half box collects it.
    b.st.lastHit = 'guest';
    parkOn(hostBox);
    let evs = stepN(b, DT);
    const ev = evs.find((e) => e.k === 'box');
    check(!!ev && ev.by === 'guest' && ITEMS_OK.includes(ev.item) && b.st.items.guest === ev.item && b.st.items.host === null, `box credits the far side's last hitter (${JSON.stringify(ev)})`);
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
    // lastHit null: the far side of the box gets it (a guest-half box goes to the host).
    b.st.lastHit = null;
    b.st.items.host = null;
    b.st.items.guest = null;
    const gb = b.sim.obstacles.filter((o) => o.k === 'box' && o.on && o.y < H)[0] || null;
    if (gb) {
      parkOn(gb);
      evs = stepN(b, DT);
      const e2 = evs.find((e) => e.k === 'box');
      check(!!e2 && e2.by === 'host', 'box in the guest half goes to the host when nobody hit the puck');
    }
    // Full slot: the host shoots through a guest-half box while holding an item:
    // puck passes through, box stays, item unchanged.
    b.st.items.host = 'freeze';
    b.st.lastHit = 'host';
    const hb = b.sim.obstacles.filter((o) => o.k === 'box' && o.on && o.y < H)[0];
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
        Object.assign(b.st.puck, { x: W / 2, y: H * 0.5, vx: 0, vy: 0 }); // a guest-half box: the host can take it
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
    const off = (n) => OFFENSIVE.reduce((a, id) => a + (n[id] || 0), 0) / Object.values(n).reduce((a, c) => a + c, 0);
    console.log(`  offensive share: even ${off(even).toFixed(2)}, behind ${off(behind).toFixed(2)}, ahead ${off(ahead).toFixed(2)}`);
    check(ITEMS_ALL.every((id) => even[id] > 100), `every item can roll (${JSON.stringify(even)})`);
    const pass = counts(0, 0, { players: 'pass' });
    const banned = ['ghost', 'mirror', 'decoys'];
    check(banned.every((id) => !pass[id]) && ITEMS_ALL.filter((id) => !banned.includes(id)).every((id) => pass[id] > 100), `pass and play never rolls ghost, mirror or decoys (${JSON.stringify(pass)})`);
    check(off(behind) > off(even) + 0.05 && off(ahead) < off(even) - 0.05, 'catch-up weighting favours offence when behind');
    const rolled = [even, behind, ahead, pass].reduce((a, n) => a + Object.values(n).reduce((x, c) => x + c, 0), 0);
    check(rolled > 1000 && [even, behind, ahead, pass].every((n) => ITEMS_REMOVED.every((id) => !n[id]) && Object.keys(n).every((id) => ITEMS_ALL.includes(id))), `mine and barrier never roll (${rolled} rolls)`);
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
    // Removed items (mine, barrier): useItem refuses and clears the slot.
    for (const id of ITEMS_REMOVED) {
      const b = newBattle({}, 40);
      barePlay(b);
      const ob0 = b.sim.obstacles.length;
      b.st.items.host = id;
      const ok = b.sim.useItem('host');
      const ev = b.sim.snapshot().ev;
      check(ok === false && b.st.items.host === null, `${id}: useItem refused and the slot cleared`);
      check(!ev.some((e) => e.k === 'use') && b.sim.obstacles.length === ob0, `${id}: no use event, no new obstacle`);
      check(!('ba' in b.st.bt), `${id}: no barrier timer in battle state`);
    }
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
    b.st.items.host = 'quake';
    Object.assign(b.st.puck, { x: W / 2, y: 30, vx: 0, vy: -900 });
    stepN(b, 0.3);
    const bt = b.st.bt;
    check(b.st.phase === PHASE.GOAL && bt.sh[0] === 0 && bt.gh[1] === 0 && bt.sk[0] === 0 && bt.mr[0] === mR && bt.fz === 0, 'goal clears shield, ghost, shrink and freeze');
    check(b.st.items.host === 'quake', 'held items survive goals');
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
  for (const item of ['rocket', 'ghost', 'shrink', 'quake']) {
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
        if (s.bt.mr.some((v) => v < mR * 0.6 - 1e-9 || v > mR * 1.5 + 1e-9)) bad++;
        for (const q of s.pucks) if (!inRink(s, q, 1)) bad++;
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

// ---- random mode: every twist for 30 s against the bot ----------------------------------
console.log('\nRandom mode: each twist, 30 s, scripted host vs bot');
check(MODES.includes('random') && MODE_PHYS.random.max === MODE_PHYS.classic.max && MODE_PHYS.random.fric === MODE_PHYS.classic.fric, 'random in MODES with classic physics');
check(TWISTS.join() === TWISTS_ALL.join(), `TWISTS exported (${TWISTS.join()})`);
{
  const pR = base.puckR;
  const mR = base.malletR;
  for (const tw of TWISTS_ALL) {
    const cfg = { ...base, mode: 'random', players: 'bot', botLevel: 'easy', twist: tw };
    const sim = createSim(cfg, { rng: rngFor(50) });
    const st = sim.state;
    check(cfg.twist === tw && st.twist === tw, `${tw}: forced twist kept`);
    let sn = sim.snapshot();
    check(sn.tw === tw && sn.tx && typeof sn.tx === 'object' && sn.ob.length === 0, `${tw}: snapshot tw/tx, no obstacles`);
    check(sn.pr === pR && Array.isArray(sn.gx) && sn.gx.length === 2, `${tw}: snapshot pr/gx`);
    sim.setReady('host');
    let now = 1000;
    let nan = 0;
    let oob = 0;
    let badS = 0;
    let goals = 0;
    let playT = 0;
    const kinds = {};
    const stat = { p2bad: 0, p2seen: 0, gxMin: Infinity, gxMax: -Infinity, gxBad: 0, winds: [], windNoAng: 0, inMax: 0, inGoalBad: 0, malBad: 0, kMax: 1, kServeBad: 0, overCap: 0, fuseBad: 0 };
    for (let i = 0; i < Math.round(30 / DT); i++) {
      now += DT * 1000;
      strikerScript(sim, now);
      const wasPlay = st.phase === PHASE.PLAY;
      sim.step(DT, now);
      if (wasPlay && st.phase === PHASE.PLAY) playT += DT;
      sn = sim.snapshot();
      const vals = [...sn.p, ...sn.m, sn.pr, ...sn.gx];
      if (sn.p2) vals.push(...sn.p2);
      if (sn.tx.w) vals.push(...sn.tx.w);
      for (const k of ['f', 'fm', 'in', 'k', 'sw']) if (sn.tx[k] !== undefined) vals.push(sn.tx[k]);
      if (!vals.every(Number.isFinite)) nan++;
      for (const q of st.pucks) if (!inRink(st, q)) oob++;
      // p2 only with the twin puck, always inside the rink.
      if (sn.p2) {
        stat.p2seen++;
        if (tw !== 'twinpuck' || !inRink(st, { x: sn.p2[0], y: sn.p2[1] }, 0.6)) stat.p2bad++;
      } else if (tw === 'twinpuck') stat.p2bad++;
      stat.gxMin = Math.min(stat.gxMin, sn.gx[0], sn.gx[1]);
      stat.gxMax = Math.max(stat.gxMax, sn.gx[0], sn.gx[1]);
      if (Math.abs(sn.gx[0]) > 0.2 * W + 0.1 || Math.abs(sn.gx[1]) > 0.2 * W + 0.1) stat.gxBad++;
      if (tw !== 'movinggoals' && (sn.gx[0] !== 0 || sn.gx[1] !== 0)) stat.gxBad++;
      if (tw === 'shrinking') {
        const inset = st.tx.in;
        stat.inMax = Math.max(stat.inMax, inset);
        for (const role of ['host', 'guest']) {
          const m = st.mallets[role];
          if (m.x < inset + mR - 1e-6 || m.x > W - inset - mR + 1e-6) stat.malBad++;
        }
        if (inset > 0.25 * W + 1e-6) stat.malBad++;
      }
      if (tw === 'turbo') {
        stat.kMax = Math.max(stat.kMax, sn.tx.k);
        if (Math.hypot(st.puck.vx, st.puck.vy) > 2600 * st.tx.k + 1e-6 || st.tx.k > 2 + 1e-9) stat.overCap++;
      }
      for (const e of sn.ev) {
        kinds[e.k] = (kinds[e.k] || 0) + 1;
        if (!(e.s >= 0 && e.s <= 5) || !Number.isFinite(e.x) || !Number.isFinite(e.y)) badS++;
        if (e.k === 'goal') {
          goals++;
          if (tw === 'shrinking' && sn.tx.in !== 0) stat.inGoalBad++;
        }
        if (e.k === 'serve' && tw === 'turbo' && sn.tx.k !== 1 && !sn.ev.some((q) => q.k === 'hit')) stat.kServeBad++;
        if (e.k === 'wind') {
          stat.winds.push(playT);
          if (!Number.isFinite(e.ang)) stat.windNoAng++;
        }
        if (e.k === 'hit' && tw === 'hotpotato' && Math.abs(sn.tx.f - sn.tx.fm) > DT + 0.011) stat.fuseBad++;
      }
      if (st.phase === PHASE.OVER) break;
    }
    const sc = st.score;
    console.log(`  ${tw.padEnd(12)} score ${sc.host}-${sc.guest} goals=${goals} ${JSON.stringify(kinds)}`);
    check(nan === 0, `${tw}: NaN values (${nan})`);
    check(oob === 0, `${tw}: puck out of bounds on ${oob} frames`);
    check(badS === 0, `${tw}: events without x, y or with s outside 0..5 (${badS})`);
    check(goals >= 1, `${tw}: no goal in 30 s`);
    check(stat.p2bad === 0, `${tw}: p2 wrong on ${stat.p2bad} frames`);
    check(stat.gxBad === 0, `${tw}: gx out of range on ${stat.gxBad} frames`);
    if (tw === 'twinpuck') check(stat.p2seen > 100 && (kinds.clack || 0) >= 0, 'twinpuck: p2 streamed');
    if (tw === 'movinggoals') check(stat.gxMax > 0.19 * W && stat.gxMin < -0.19 * W, `movinggoals: gx swings +-0.2W (${stat.gxMin.toFixed(0)}..${stat.gxMax.toFixed(0)})`);
    if (tw === 'wind') {
      const w = stat.winds;
      check(w.length >= 3 && stat.windNoAng === 0, `wind: wind events with ang (${w.length})`);
      let bad = 0;
      for (let k = 1; k < w.length; k++) if (Math.abs(w[k] - w[k - 1] - 8) > 0.1) bad++;
      check(bad === 0, `wind: turns every 8 s of play (${w.map((v) => v.toFixed(2)).join(', ')})`);
    }
    if (tw === 'shrinking') {
      check(stat.inMax > 0.05 * W, `shrinking: inset grew (${stat.inMax.toFixed(1)})`);
      check(stat.inGoalBad === 0, 'shrinking: inset resets to 0 on a goal');
      check(stat.malBad === 0, `shrinking: mallets outside the inset rails on ${stat.malBad} frames`);
    }
    if (tw === 'turbo') {
      check(stat.kMax > 1.1, `turbo: k rises with hits (max ${stat.kMax})`);
      check((kinds.turbo || 0) > 0, 'turbo: turbo events');
      check(stat.kServeBad === 0, 'turbo: k back to 1 at the serve');
      check(stat.overCap === 0, `turbo: speed over phys.max * k on ${stat.overCap} frames`);
    }
    if (tw === 'hotpotato') check(stat.fuseBad === 0, `hotpotato: fuse not reset by ${stat.fuseBad} hits`);
  }

  // Hot potato: the puck parked in the host half with nobody hitting it blows up there.
  {
    const cfg = { ...base, mode: 'random', players: 'pass', twist: 'hotpotato' };
    const sim = createSim(cfg, { rng: rngFor(51) });
    const st = sim.state;
    sim.setReady('host');
    sim.setReady('guest');
    let now = 1000;
    for (let i = 0; i < 400 && st.phase !== PHASE.PLAY; i++) {
      now += DT * 1000;
      sim.step(DT, now);
      sim.snapshot();
    }
    check(st.phase === PHASE.PLAY && st.tx.f === 6 && st.tx.fm === 6, `hotpotato: fuse 6 s at the serve (${st.tx.f})`);
    sim.setMallet('host', W * 0.9, bottom - mR, now, true);
    sim.setMallet('guest', W * 0.1, mR, now, true);
    const park = () => Object.assign(st.puck, { x: W * 0.25, y: H + G + H * 0.5, vx: 0, vy: 0 });
    let prevF = 6;
    let down = true;
    let potato = null;
    let goalEv = null;
    let t = 0;
    for (let i = 0; i < Math.round(7 / DT) && !goalEv; i++) {
      now += DT * 1000;
      park();
      sim.step(DT, now);
      t += DT;
      const sn = sim.snapshot();
      if (!potato && sn.tx.f > prevF + 1e-9) down = false;
      prevF = sn.tx.f;
      potato = potato || sn.ev.find((e) => e.k === 'potato') || null;
      goalEv = sn.ev.find((e) => e.k === 'goal') || null;
    }
    check(down, 'hotpotato: fuse only counts down');
    check(!!potato && potato.by === 'host', `hotpotato: potato event in the host half (${JSON.stringify(potato)})`);
    check(!!goalEv && goalEv.by === 'guest' && goalEv.why === 'potato', `hotpotato: goal for the guest, why potato (${JSON.stringify(goalEv)})`);
    check(Math.abs(t - 6) < 0.05, `hotpotato: blew after 6 s (${t.toFixed(2)})`);
    // Hits shorten the fuse: fm = max(2, 6 - 0.5 * hits).
    sim.restart();
    sim.setReady('host');
    sim.setReady('guest');
    for (let i = 0; i < 400 && st.phase !== PHASE.PLAY; i++) {
      now += DT * 1000;
      sim.step(DT, now);
      sim.snapshot();
    }
    let hits = 0;
    let fmOk = true;
    for (let n = 0; n < 4; n++) {
      Object.assign(st.puck, { x: W / 2, y: H + G + 300, vx: 0, vy: 0 });
      let my = st.puck.y + 80 + 20 * 10;
      sim.setMallet('host', W / 2, my, now, true);
      for (let i = 0; i < 12; i++) {
        now += DT * 1000;
        my -= 20;
        sim.setMallet('host', W / 2, my, now);
      }
      hits++;
      if (Math.abs(st.tx.fm - Math.max(2, 6 - 0.5 * hits)) > 1e-9 || st.tx.f !== st.tx.fm) fmOk = false;
      sim.setMallet('host', W / 2, bottom - mR, now, true);
    }
    check(fmOk, `hotpotato: fuse shortens with every hit (fm ${st.tx.fm})`);
  }

  // Gravity: a slow puck near the centre is swallowed, then spat out.
  {
    const cfg = { ...base, mode: 'random', players: 'pass', twist: 'gravity' };
    const sim = createSim(cfg, { rng: rngFor(52) });
    const st = sim.state;
    st.phase = PHASE.PLAY;
    st.lastHit = 'guest';
    Object.assign(st.puck, { x: W / 2 + 8, y: bottom / 2 - 6, vx: 40, vy: 0 });
    let now = 1000;
    let sw = null;
    let sp = null;
    let swAt = 0;
    let spAt = 0;
    let hiddenOk = true;
    let swCount = true;
    let prevSw = 0;
    for (let i = 0; i < Math.round(2 / DT) && !sp; i++) {
      now += DT * 1000;
      sim.step(DT, now);
      const sn = sim.snapshot();
      const e1 = sn.ev.find((e) => e.k === 'swallow');
      const e2 = sn.ev.find((e) => e.k === 'spit');
      if (e1 && !sw) {
        sw = e1;
        swAt = st.time;
        prevSw = sn.tx.sw;
      } else if (sw && !e2) {
        if (sn.p[0] !== r1(W / 2) || sn.p[1] !== r1(bottom / 2) || sn.p[2] !== 0) hiddenOk = false;
        if (!(sn.tx.sw < prevSw)) swCount = false;
        prevSw = sn.tx.sw;
      }
      if (e2) {
        sp = e2;
        spAt = st.time;
        check(sn.tx.sw === 0, 'gravity: sw back to 0 after the spit');
      }
    }
    check(!!sw && Math.abs(sw.x - W / 2) < 0.1 && sw.s === 1, `gravity: swallow at the well (${JSON.stringify(sw)})`);
    check(hiddenOk && swCount, 'gravity: swallowed puck parked at the centre, sw counts down');
    check(!!sp && sp.by === 'guest' && Math.abs(spAt - swAt - 0.7) < 0.05, `gravity: spit after 0.7 s at the feeder (${JSON.stringify(sp)})`);
    const v = Math.hypot(st.puck.vx, st.puck.vy);
    check(st.puck.vy < 0 && v > 800 && Math.abs(Math.atan2(st.puck.vx, -st.puck.vy)) < 0.53, `gravity: spat towards the guest goal at ~900 px/s (${Math.round(v)})`);
    // The pull bends a passing puck towards the centre, and is off outside play.
    const c = createSim({ ...cfg }, { rng: rngFor(53) });
    c.state.phase = PHASE.PLAY;
    Object.assign(c.state.puck, { x: W / 2 - 300, y: bottom / 2 + 250, vx: 0, vy: 0 });
    c.step(0.05, 1000);
    check(c.state.puck.vx > 0 && c.state.puck.vy < 0, 'gravity: pull points at the centre');
  }
}

// ---- random mode: twist picks ------------------------------------------------------------
console.log('\nRandom mode: twist re-rolls');
{
  const seen = new Set();
  let repeats = 0;
  let invalid = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const sim = createSim({ ...base, mode: 'random', players: 'pass' }, { rng: rngFor(100 + seed) });
    let prev = sim.state.twist;
    if (!TWISTS_ALL.includes(prev) || sim.snapshot().tw !== prev) invalid++;
    seen.add(prev);
    for (let k = 0; k < 8; k++) {
      sim.restart();
      const t = sim.state.twist;
      if (!TWISTS_ALL.includes(t) || sim.snapshot().tw !== t) invalid++;
      if (t === prev) repeats++;
      seen.add(t);
      prev = t;
      check(sim.state.pucks.length === (t === 'twinpuck' ? 2 : 1) && sim.state.pucks[0] === sim.state.puck, `restart into ${t}: puck list`);
    }
  }
  check(invalid === 0, `twists outside the list (${invalid})`);
  check(repeats === 0, `same twist twice in a row (${repeats})`);
  check(seen.size === 8, `every twist picked at least once (${[...seen].join()})`);
  const forced = createSim({ ...base, mode: 'random', twist: 'wind' }, { rng: rngFor(3) });
  forced.restart();
  forced.restart();
  check(forced.state.twist === 'wind', 'cfg.twist disables re-rolling');
  const badCfg = { ...base, mode: 'random', twist: 'lava' };
  createSim(badCfg);
  check(!('twist' in badCfg), 'an invalid cfg.twist is deleted');
  const classicCfg = { ...base, mode: 'classic', twist: 'wind' };
  const cs = createSim(classicCfg).snapshot();
  check(!('twist' in classicCfg) && cs.tw === undefined && cs.tx === undefined && cs.p2 === undefined, 'no twist outside random mode');
  check(cs.pr === base.puckR && cs.gx.join() === '0,0', 'classic snapshot pr and gx');
  console.log(`  picked: ${[...seen].join(', ')}`);
}

// ---- twin puck: puck vs puck, either puck scores, goal pause layout -------------------------
console.log('\nTwin puck: clack, goals, pause layout');
{
  const pR = base.puckR;
  const cfg = { ...base, mode: 'random', players: 'pass', twist: 'twinpuck' };
  const sim = createSim(cfg, { rng: rngFor(60) });
  const st = sim.state;
  const [a, b] = st.pucks;
  check(st.pucks.length === 2 && a === st.puck && b !== a, 'twinpuck: two pucks, pucks[0] is state.puck');
  sim.setMallet('host', W * 0.9, bottom - 60, 100, true);
  sim.setMallet('guest', W * 0.1, 60, 100, true);
  st.phase = PHASE.PLAY;
  Object.assign(a, { x: W / 2 - 200, y: H + G + 300, vx: 1200, vy: 0 });
  Object.assign(b, { x: W / 2 + 200, y: H + G + 300, vx: -1200, vy: 0 });
  let clack = null;
  let now = 1000;
  for (let i = 0; i < 30 && !clack; i++) {
    now += DT * 1000;
    sim.step(DT, now);
    clack = sim.snapshot().ev.find((e) => e.k === 'clack') || null;
  }
  check(!!clack && clack.s > 0.9 && clack.s <= 1 && Math.abs(clack.x - W / 2) < 30, `twinpuck: head-on clack (${JSON.stringify(clack)})`);
  check(a.vx < -900 && b.vx > 900 && Math.abs(a.vx + b.vx) < 1, `twinpuck: equal masses swap velocity (${Math.round(a.vx)}, ${Math.round(b.vx)})`);
  check(Math.hypot(a.x - b.x, a.y - b.y) >= 2 * pR - 0.1, 'twinpuck: pushed apart');
  // The second puck scores on its own.
  Object.assign(a, { x: W * 0.2, y: H + G + 300, vx: 0, vy: 0 });
  Object.assign(b, { x: W / 2, y: 80, vx: 0, vy: -1200 });
  const evs = [];
  for (let i = 0; i < 30 && st.phase === PHASE.PLAY; i++) {
    now += DT * 1000;
    sim.step(DT, now);
    evs.push(...sim.snapshot().ev);
  }
  const ge = evs.find((e) => e.k === 'goal');
  check(!!ge && ge.by === 'host' && st.phase === PHASE.GOAL, `twinpuck: p2 scores (${JSON.stringify(ge)})`);
  const sn = sim.snapshot();
  const recvY = st.serveTo === 'host' ? H + G + H / 2 : H / 2;
  const otherY = st.serveTo === 'host' ? H / 2 : H + G + H / 2;
  check(sn.p[1] === r1(recvY) && sn.p2[1] === r1(otherY) && sn.p[2] === 0 && sn.p2[2] === 0 && sn.p2[3] === 0, `twinpuck: pause shows p in the receiver half and p2 in the other (${sn.p} / ${sn.p2})`);
  // Serve: opposite directions.
  for (let i = 0; i < 300 && st.phase !== PHASE.PLAY; i++) {
    now += DT * 1000;
    sim.step(DT, now);
    sim.snapshot();
  }
  // Serve: p leaves the seam toward the receiver; p2 leaves its waiting spot
  // in the other half toward that half's own goal, so each player gets one.
  const toward = st.serveTo === 'host' ? 1 : -1;
  check(st.phase === PHASE.PLAY && Math.sign(a.vy) === toward && Math.sign(b.vy) === -toward, `twinpuck: serve sends one puck to each player (${Math.round(a.vy)}, ${Math.round(b.vy)})`);
}

// ---- twin puck: p2 never appears inside the seam gap at the serve -------------------------
console.log('\nTwin puck: serve spot outside the seam gap');
{
  const cfg = { ...base, mode: 'random', players: 'pass', twist: 'twinpuck' };
  const sim = createSim(cfg, { rng: rngFor(61) });
  const st = sim.state;
  sim.setMallet('host', W * 0.9, bottom - 60, 100, true);
  sim.setMallet('guest', W * 0.1, 60, 100, true);
  st.phase = PHASE.PLAY;
  const [a, b] = st.pucks;
  let now = 1000;
  let serves = 0;
  let bad = 0;
  let jumps = 0;
  for (let n = 0; n < 4; n++) {
    // Score with p2, alternating ends, then wait for the serve.
    Object.assign(a, { x: W * 0.2, y: n % 2 ? H / 2 : H + G + H / 2, vx: 0, vy: 0 });
    if (n % 2) Object.assign(b, { x: W / 2, y: bottom - 80, vx: 0, vy: 1200 });
    else Object.assign(b, { x: W / 2, y: 80, vx: 0, vy: -1200 });
    for (let i = 0; i < 60 && st.phase === PHASE.PLAY; i++) {
      now += DT * 1000;
      sim.step(DT, now);
      sim.snapshot();
    }
    let parkY = null;
    for (let i = 0; i < 400 && st.phase !== PHASE.PLAY; i++) {
      parkY = b.y;
      now += DT * 1000;
      sim.step(DT, now);
      sim.snapshot();
    }
    if (st.phase !== PHASE.PLAY) break;
    serves++;
    if (G > 0 && b.y > H && b.y < H + G) bad++;
    if (parkY !== null && Math.abs(b.y - parkY) > SERVE_JUMP) jumps++;
  }
  check(serves === 4, `twinpuck: four serves seen (${serves})`);
  check(bad === 0, `twinpuck: p2 inside the seam gap right after ${bad} serve(s)`);
  check(jumps === 0, `twinpuck: p2 jumped from its parked spot on ${jumps} serve(s)`);
}

// ---- bot: Twin Puck watches the puck that threatens its goal --------------------------------
console.log('\nBot: Twin Puck threat pick');
{
  const cfg = { ...base, mode: 'random', players: 'bot', botLevel: 'hard', twist: 'twinpuck' };
  const sim = createSim(cfg, { rng: rngFor(62) });
  const st = sim.state;
  sim.setMallet('host', W * 0.9, bottom - 60, 100, true);
  st.phase = PHASE.PLAY;
  const [a, b] = st.pucks;
  Object.assign(a, { x: W * 0.3, y: H * 0.4, vx: 0, vy: 600 });
  Object.assign(b, { x: W * 0.7, y: H + G + H * 0.6, vx: 0, vy: -900 });
  sim.step(DT, 1000 + DT * 1000);
  check(st.botPuck === b, 'bot twinpuck: botPuck is the puck heading at y = 0');
  // Both heading in: the sooner one wins.
  Object.assign(a, { x: W * 0.3, y: H * 0.5, vx: 0, vy: -300 });
  Object.assign(b, { x: W * 0.7, y: H * 0.3, vx: 0, vy: -900 });
  sim.step(DT, 1000 + 2 * DT * 1000);
  check(st.botPuck === b, 'bot twinpuck: the puck that arrives first is picked');
  // Neither heading in: the closest to the guest goal.
  Object.assign(a, { x: W * 0.3, y: H * 0.5, vx: 0, vy: 300 });
  Object.assign(b, { x: W * 0.7, y: H + G + 200, vx: 0, vy: 300 });
  sim.step(DT, 1000 + 3 * DT * 1000);
  check(st.botPuck === a, 'bot twinpuck: falls back to the puck closest to the guest goal');
  // One puck: botPuck is the puck itself.
  const one = createSim({ ...base, mode: 'classic', players: 'bot', botLevel: 'hard' }, { rng: rngFor(63) });
  one.state.phase = PHASE.PLAY;
  one.step(DT, 1000);
  check(one.state.botPuck === one.state.puck, 'bot one puck: botPuck is state.puck');
}

// ---- battle: the 11 new items -------------------------------------------------------------
console.log('\nBattle: new items');
{
  const mR = base.malletR;
  const pR = base.puckR;
  const nb = (extra = {}, seed = 70) => {
    const cfg = { ...base, mode: 'battle', players: 'pass', ...extra };
    const sim = createSim(cfg, { rng: rngFor(seed) });
    const b = { cfg, sim, st: sim.state, now: 1000 };
    b.st.phase = PHASE.PLAY;
    Object.assign(b.st.puck, { x: W * 0.1, y: H + G + H * 0.2, vx: 0, vy: 0 });
    sim.setMallet('host', W * 0.9, bottom - mR, 100, true);
    sim.setMallet('guest', W * 0.9, mR, 100, true);
    return b;
  };
  const run = (b, sec, each) => {
    const evs = [];
    for (let i = 0; i < Math.round(sec / DT); i++) {
      b.now += DT * 1000;
      if (each) each(i);
      b.sim.step(DT, b.now);
      for (const e of b.sim.snapshot().ev) evs.push(e);
    }
    return evs;
  };
  const use = (b, role, id) => {
    b.st.items[role] = id;
    const ok = b.sim.useItem(role);
    const evs = b.sim.snapshot().ev;
    return { ok, evs, ue: evs.find((e) => e.k === 'use') };
  };
  const parkFar = (b) => () => Object.assign(b.st.puck, { x: W * 0.1, y: H + G + H * 0.2, vx: 0, vy: 0 });
  const r2 = (v) => Math.round(v * 100) / 100;

  check(ITEMS.join() === ITEMS_ALL.join(), `ITEMS exported (${ITEMS.length})`);
  // Every item can be used, with a 'use' event; only steal leaves the hand full.
  for (const id of ITEMS_ALL) {
    const b = nb({}, 71);
    if (id === 'steal') b.st.items.guest = 'giant';
    const { ok, ue } = use(b, 'host', id);
    check(ok && ue && ue.by === 'host' && ue.item === id && ue.s === 1 && Number.isFinite(ue.x + ue.y), `${id}: used with a use event`);
    check(id === 'steal' ? b.st.items.host === 'giant' : b.st.items.host === null, `${id}: hand after use (${b.st.items.host})`);
  }
  // The snapshot carries every new bt field.
  {
    const sn = nb().sim.snapshot();
    const t = sn.bt;
    const pairs = ['mg', 'wg', 'mi', 'qk', 'dc', 'go', 'gi', 'ca', 'ct'];
    check(pairs.every((k) => Array.isArray(t[k]) && t[k].join() === '0,0') && t.tp === 0 && sn.dk === undefined && sn.pr === pR && !('ba' in t), `battle bt fields (${JSON.stringify(t)})`);
  }

  // magnet: a slow puck bends into the target goal.
  {
    const b = nb({}, 72);
    Object.assign(b.st.puck, { x: W / 2 + 150, y: H + G + H * 0.5, vx: 250, vy: -100 });
    const { ok } = use(b, 'guest', 'magnet');
    check(ok && b.st.bt.mg[0] === 2 && b.st.bt.mg[1] === 0, 'magnet: timer on the target (host)');
    let t = 0;
    const evs = run(b, 2, () => {
      if (b.st.phase === PHASE.PLAY) t += DT;
    });
    const ge = evs.find((e) => e.k === 'goal');
    check(!!ge && ge.by === 'guest' && t < 2, `magnet: puck pulled into the host goal (${t.toFixed(2)} s)`);
    // Cancelled by the target's own mallet hit.
    const c = nb({}, 72);
    Object.assign(c.st.puck, { x: W / 2, y: H + G + 300, vx: 0, vy: 0 });
    use(c, 'guest', 'magnet');
    let my = c.st.puck.y + 80 + 200;
    c.sim.setMallet('host', W / 2, my, 2000, true);
    let off = null;
    for (let i = 0; i < 12 && !off; i++) {
      my -= 20;
      c.sim.setMallet('host', W / 2, my, 2000 + (i + 1) * 16.7);
      off = c.sim.snapshot().ev.find((e) => e.k === 'magnetoff') || null;
    }
    check(!!off && off.by === 'host' && c.st.bt.mg[0] === 0, `magnet: cancelled by the target's hit (${JSON.stringify(off)})`);
  }

  // widegoal: 1.5x the target mouth for 6 s.
  {
    const b = nb({}, 73);
    use(b, 'host', 'widegoal');
    const sn = b.sim.snapshot();
    check(b.st.bt.wg[1] === 6 && Math.abs(b.st.gw[1] - base.goalW * 1.5) < 1e-9 && b.st.gw[0] === base.goalW, `widegoal: gw ${sn.gw}`);
    run(b, 5.9, parkFar(b));
    check(b.st.gw[1] > base.goalW * 1.4, 'widegoal: still wide at 5.9 s');
    run(b, 0.2, parkFar(b));
    check(b.st.bt.wg[1] === 0 && b.st.gw[1] === base.goalW, 'widegoal: restored after 6 s');
    // Capped at 0.6 W.
    const c = nb({ goalW: W * 0.5 }, 73);
    use(c, 'host', 'widegoal');
    check(Math.abs(c.st.gw[1] - W * 0.6) < 1e-9, 'widegoal: capped at 0.6 W');
  }

  // goalie: on the owner's goal line, tracks the puck, blocks a straight shot, 5 s.
  {
    const b = nb({}, 74);
    use(b, 'host', 'goalie');
    let g = b.sim.obstacles.find((o) => o.k === 'goalie');
    check(!!g && g.a === 0 && Math.abs(g.r - mR * 0.55) < 1e-9 && Math.abs(g.y - (bottom - 0.9 * mR)) < 1e-9, 'goalie: owner 0 on the host goal line');
    const so = b.sim.snapshot().ob.find((o) => o.k === 'goalie');
    check(!!so && so.a === 0, 'goalie: streamed in ob with a = owner');
    run(b, 0.5, () => Object.assign(b.st.puck, { x: W / 2 + 90, y: H + G + 200, vx: 0, vy: 0 }));
    check(Math.abs(g.x - (W / 2 + 90)) < 1, `goalie: tracks the puck x (${g.x.toFixed(1)})`);
    run(b, 0.5, () => Object.assign(b.st.puck, { x: W * 0.95, y: H + G + 200, vx: 0, vy: 0 }));
    check(Math.abs(g.x - (W / 2 + base.goalW / 2 + g.r)) < 1, `goalie: clamped to the mouth (${g.x.toFixed(1)})`);
    Object.assign(b.st.puck, { x: W / 2 + 30, y: bottom - 400, vx: 0, vy: 1500 });
    const evs = run(b, 0.6);
    const gh = evs.find((e) => e.k === 'goaliehit');
    check(!!gh && gh.by === 'host' && gh.s > 0 && gh.s <= 1 && !evs.some((e) => e.k === 'goal'), `goalie: blocks a straight shot (${JSON.stringify(gh)})`);
    check(b.st.lastHit === 'host', 'goalie: hit sets lastHit');
    // Control: the same shot scores without the goalie.
    const c = nb({}, 74);
    Object.assign(c.st.puck, { x: W / 2 + 30, y: bottom - 400, vx: 0, vy: 1500 });
    check(run(c, 0.6).some((e) => e.k === 'goal'), 'goalie control: the shot scores without it');
    run(b, 4, parkFar(b));
    g = b.sim.obstacles.find((o) => o.k === 'goalie');
    check(!g && b.st.bt.go[0] === 0 && !b.sim.snapshot().ob.some((o) => o.k === 'goalie'), 'goalie: gone after 5 s');
  }

  // giant: 1.5x mallet, composes with shrink.
  {
    const b = nb({}, 75);
    use(b, 'host', 'giant');
    check(b.st.bt.gi[0] === 5 && Math.abs(b.st.bt.mr[0] - mR * 1.5) < 1e-9 && b.sim.snapshot().bt.mr[0] === r1(mR * 1.5), 'giant: mr 1.5x');
    use(b, 'guest', 'shrink');
    check(Math.abs(b.st.bt.mr[0] - mR * 0.9) < 1e-9, `giant + shrink: 0.9x (${b.st.bt.mr[0]})`);
    run(b, 4.2, parkFar(b));
    check(Math.abs(b.st.bt.mr[0] - mR * 1.5) < 1e-9, 'giant: back to 1.5x when shrink ends');
    run(b, 1, parkFar(b));
    check(b.st.bt.gi[0] === 0 && b.st.bt.mr[0] === mR, 'giant: restored after 5 s');
  }

  // catch: armed, holds on the next contact, flick flings, timeout drops forward.
  {
    const b = nb({}, 76);
    use(b, 'host', 'catch');
    check(b.st.bt.ca[0] === 1 && b.sim.snapshot().bt.ca[0] === 1, 'catch: armed');
    const my = bottom - 300;
    let ce = null;
    let hitEv = false;
    const c = nb({}, 76);
    use(c, 'host', 'catch');
    c.sim.setMallet('host', W / 2, my, 2000, true);
    c.now = 2000;
    Object.assign(c.st.puck, { x: W / 2, y: my - 250, vx: 0, vy: 900 });
    for (let i = 0; i < 30 && !ce; i++) {
      c.now += DT * 1000;
      c.sim.step(DT, c.now);
      const evs = c.sim.snapshot().ev;
      ce = evs.find((e) => e.k === 'catch') || null;
      if (evs.some((e) => e.k === 'hit')) hitEv = true;
    }
    check(!!ce && ce.by === 'host' && c.st.bt.ca[0] === 0 && c.st.bt.ct[0] > 1.4 && !hitEv, `catch: next contact holds the puck (${JSON.stringify(ce)})`);
    const hold = () => Math.abs(c.st.puck.x - c.st.mallets.host.x) < 1e-6 && Math.abs(c.st.puck.y - (c.st.mallets.host.y - (mR + pR + 1))) < 1e-6;
    check(hold() && c.st.puck.vx === 0 && c.st.puck.vy === 0, 'catch: puck sits in front of the mallet');
    // Slow carry: the puck follows, ct counts down.
    const ct0 = c.st.bt.ct[0];
    let mx = W / 2;
    let follow = true;
    for (let i = 0; i < 18; i++) {
      c.now += DT * 1000;
      mx += 5; // 300 px/s
      c.sim.setMallet('host', mx, my, c.now);
      c.sim.step(DT, c.now);
      c.sim.snapshot();
      if (!hold()) follow = false;
    }
    check(follow && c.st.bt.ct[0] < ct0 - 0.25 && c.st.bt.ct[0] > 0, `catch: carried with ct counting down (${c.st.bt.ct[0].toFixed(2)})`);
    // Flick: fast move to the left and up.
    let fl = null;
    for (let i = 0; i < 6 && !fl; i++) {
      c.now += DT * 1000;
      mx -= 25;
      c.sim.setMallet('host', mx, my - 10 * (i + 1), c.now);
      c.sim.step(DT, c.now);
      fl = c.sim.snapshot().ev.find((e) => e.k === 'fling') || null;
    }
    const m = c.st.mallets.host;
    const pv = c.st.puck;
    const cos = (pv.vx * m.vx + pv.vy * m.vy) / (Math.hypot(pv.vx, pv.vy) * Math.hypot(m.vx, m.vy) || 1);
    check(!!fl && fl.by === 'host' && fl.s > 0.3 && fl.s <= 1 && c.st.bt.ct[0] === 0, `catch: flick flings (${JSON.stringify(fl)})`);
    check(cos > 0.9 && pv.vx < -900, `catch: fling along the mallet (cos ${cos.toFixed(3)}, v ${Math.round(pv.vx)},${Math.round(pv.vy)})`);
    // Timeout: dropped towards the opponent at 600 px/s.
    const d = nb({}, 77);
    use(d, 'guest', 'catch');
    d.sim.setMallet('guest', W / 2, 250, 2000, true);
    d.now = 2000;
    Object.assign(d.st.puck, { x: W / 2, y: 500, vx: 0, vy: -900 });
    let t0 = -1;
    let drop = null;
    for (let i = 0; i < Math.round(2.5 / DT) && !drop; i++) {
      d.now += DT * 1000;
      d.sim.step(DT, d.now);
      const evs = d.sim.snapshot().ev;
      if (t0 < 0 && evs.some((e) => e.k === 'catch')) t0 = d.st.time;
      drop = evs.find((e) => e.k === 'fling') || null;
    }
    check(t0 > 0 && !!drop && drop.by === 'guest' && Math.abs(d.st.time - t0 - 1.5) < 0.05, `catch: released after 1.5 s (${(d.st.time - t0).toFixed(2)})`);
    check(Math.abs(d.st.puck.vy - 600) < 30 && Math.abs(d.st.puck.vx) < 1, `catch: timeout drops forward at 600 (${Math.round(d.st.puck.vy)})`);
  }

  // mirror and quake: timers; quake lags the target mallet.
  {
    const b = nb({}, 79);
    use(b, 'host', 'mirror');
    check(b.st.bt.mi[1] === 3 && b.st.bt.mi[0] === 0, 'mirror: timer on the target');
    run(b, 3.05, parkFar(b));
    check(b.st.bt.mi[1] === 0, 'mirror: expires after 3 s');
    b.sim.setMallet('guest', W / 2, 300, 5000, true);
    use(b, 'host', 'quake');
    check(b.st.bt.qk[1] === 2, 'quake: timer on the target');
    b.sim.setMallet('guest', W / 2 + 100, 300, 5016);
    check(Math.abs(b.st.mallets.guest.x - (W / 2 + 60)) < 1e-6, `quake: mallet moves 60 percent (${b.st.mallets.guest.x})`);
    b.sim.setMallet('host', W / 2, bottom - 300, 5000, true);
    b.sim.setMallet('host', W / 2 + 100, bottom - 300, 5016);
    check(Math.abs(b.st.mallets.host.x - (W / 2 + 100)) < 1e-6, 'quake: the user is unaffected');
    run(b, 2.05, parkFar(b));
    check(b.st.bt.qk[1] === 0, 'quake: expires after 2 s');
    b.sim.setMallet('guest', W / 2, 300, 9000, true);
    b.sim.setMallet('guest', W / 2 + 100, 300, 9016);
    check(Math.abs(b.st.mallets.guest.x - (W / 2 + 100)) < 1e-6, 'quake: full moves again');
    // The bot's mallet lags too.
    const c = nb({ players: 'bot', botLevel: 'impossible' }, 79);
    const g = c.st.mallets.guest;
    const free = c.sim.state;
    use(c, 'host', 'quake');
    let x0 = g.x;
    let y0 = g.y;
    Object.assign(free.puck, { x: W * 0.2, y: H * 0.5, vx: 0, vy: 0 });
    c.now += DT * 1000;
    c.sim.step(DT, c.now);
    const moved = Math.hypot(g.x - x0, g.y - y0);
    check(moved > 0 && moved <= 2800 * DT * 0.6 + 1e-6, `quake: bot step capped at 60 percent (${moved.toFixed(1)} px)`);
  }

  // decoys: two fakes that move, ignore mallets and vanish within 3 s.
  {
    const b = nb({}, 80);
    Object.assign(b.st.puck, { x: W / 2, y: H + G + 200, vx: 0, vy: -1200 });
    const { evs } = use(b, 'host', 'decoys');
    const de = evs.find((e) => e.k === 'decoys');
    check(!!de && de.by === 'host', `decoys event ${JSON.stringify(de)}`);
    let sn = b.sim.snapshot();
    check(Array.isArray(sn.dk) && sn.dk.length === 2 && b.st.bt.dc[1] === 3, `decoys: dk has two entries (${JSON.stringify(sn.dk)})`);
    check(sn.dk.every((d) => d.length === 4 && d.every((v) => typeof v === 'number' && isFinite(v))) && sn.dk.some((d) => d[2] !== 0 || d[3] !== 0), `decoys: dk entries are [x, y, vx, vy] (${JSON.stringify(sn.dk)})`);
    run(b, 0.2);
    sn = b.sim.snapshot();
    const d0 = sn.dk;
    check(d0 && d0.length === 2 && d0.every((d) => d[1] < H + G + 200 - 100) && Math.abs(d0[0][0] - d0[1][0]) > 20, `decoys: they move and fan out (${JSON.stringify(d0)})`);
    // Park the guest mallet on a decoy: nothing happens.
    const target = d0[0];
    b.sim.setMallet('guest', target[0], Math.max(mR, Math.min(H - mR, target[1] - 40)), b.now, true);
    Object.assign(b.st.puck, { x: W * 0.1, y: H + G + H * 0.2, vx: 0, vy: 0 });
    let hits = 0;
    let lastDk = null;
    let vanishAt = -1;
    for (let i = 0; i < Math.round(3.1 / DT); i++) {
      b.now += DT * 1000;
      Object.assign(b.st.puck, { x: W * 0.1, y: H + G + H * 0.2, vx: 0, vy: 0 });
      b.sim.step(DT, b.now);
      const s2 = b.sim.snapshot();
      for (const e of s2.ev) if (e.k === 'hit' || e.k === 'goal') hits++;
      if (s2.dk) lastDk = s2.dk;
      else if (vanishAt < 0) vanishAt = (i + 1) * DT + 0.2;
    }
    check(hits === 0, `decoys never trigger hits or goals (${hits})`);
    check(vanishAt > 0 && vanishAt <= 3.0 + 1e-6 && b.sim.snapshot().dk === undefined && b.st.bt.dc[1] === 0, `decoys vanish within 3 s (${vanishAt.toFixed(2)})`);
    // A slow puck sends them at the target goal.
    const c = nb({}, 80);
    Object.assign(c.st.puck, { x: W / 2, y: H + G + 200, vx: 0, vy: 0 });
    use(c, 'host', 'decoys');
    run(c, 0.1, parkFar(c));
    const dk = c.sim.snapshot().dk;
    check(dk && dk.every((d) => d[1] < H + G + 200 - 40), 'decoys: slow puck sends them towards the target goal');
  }

  // steal: takes the target's item, or re-rolls.
  {
    const b = nb({}, 81);
    b.st.items.guest = 'magnet';
    const { evs } = use(b, 'host', 'steal');
    const se = evs.find((e) => e.k === 'steal');
    check(!!se && se.by === 'host' && se.item === 'magnet' && se.got === 1 && b.st.items.host === 'magnet' && b.st.items.guest === null, `steal: takes the target's item (${JSON.stringify(se)})`);
    let got0 = 0;
    let bad = 0;
    for (let i = 0; i < 40; i++) {
      const c = nb({}, 200 + i);
      const r = use(c, 'guest', 'steal');
      const e = r.evs.find((q) => q.k === 'steal');
      if (e && e.got === 0) got0++;
      const it = c.st.items.guest;
      if (!it || it === 'steal' || !ITEMS_ALL.includes(it) || !e || e.item !== it) bad++;
    }
    check(got0 === 40 && bad === 0, `steal: empty target re-rolls a real item (${got0}, ${bad} bad)`);
  }

  // tinypuck: pr = 0.6 puckR for collisions, then restored.
  {
    const b = nb({}, 82);
    use(b, 'host', 'tinypuck');
    let sn = b.sim.snapshot();
    check(b.st.bt.tp === 5 && sn.pr === r1(pR * 0.6) && sn.bt.tp === 5, `tinypuck: snap.pr ${sn.pr}`);
    const mx = W / 2;
    const my = bottom - 300;
    b.sim.setMallet('host', mx, my, 3000, true);
    const off = (0.8 * pR + mR); // between 0.6R + mr and R + mr
    Object.assign(b.st.puck, { x: mx + off, y: my - 200, vx: 0, vy: 900 });
    const evs = run(b, 0.45);
    check(!evs.some((e) => e.k === 'hit') && Math.abs(b.st.puck.vx) < 1e-9 && b.st.puck.y > my + 50, 'tinypuck: passes a mallet it would have hit at full size');
    // Control at full size.
    const c = nb({}, 82);
    c.sim.setMallet('host', mx, my, 3000, true);
    Object.assign(c.st.puck, { x: mx + off, y: my - 200, vx: 0, vy: 900 });
    run(c, 0.45);
    check(Math.abs(c.st.puck.vx) > 50, 'tinypuck control: full-size puck is deflected');
    run(b, 4.6, parkFar(b));
    sn = b.sim.snapshot();
    check(b.st.bt.tp === 0 && b.st.pr === pR && sn.pr === pR, 'tinypuck: restored after 5 s');
  }

  // battleClear on a goal drops every timer, goalie and decoys.
  {
    const b = nb({}, 83);
    for (const id of ['magnet', 'widegoal', 'goalie', 'giant', 'mirror', 'quake', 'tinypuck']) use(b, 'host', id);
    Object.assign(b.st.puck, { x: W / 2, y: H + G + 200, vx: 0, vy: -1200 });
    use(b, 'host', 'decoys');
    use(b, 'guest', 'catch');
    check(b.sim.obstacles.some((o) => o.k === 'goalie') && b.sim.snapshot().dk, 'clear: setup has goalie and decoys');
    Object.assign(b.st.puck, { x: W / 2, y: 40, vx: 0, vy: -1500 });
    b.st.bt.ct[0] = 0;
    const evs = run(b, 0.2);
    check(evs.some((e) => e.k === 'goal') && b.st.phase === PHASE.GOAL, 'clear: goal scored');
    const t = b.sim.snapshot();
    const zero = ['mg', 'wg', 'mi', 'qk', 'dc', 'go', 'gi', 'ct'].every((k) => t.bt[k].join() === '0,0');
    check(zero && t.bt.tp === 0 && t.pr === pR && t.bt.mr.join() === `${mR},${mR}`, `clear: timers zeroed (${JSON.stringify(t.bt)})`);
    check(!t.ob.some((o) => o.k === 'goalie') && t.dk === undefined && !('ba' in t.bt), 'clear: goalie and decoys gone');
    check(b.st.gw[0] === base.goalW && Math.abs(b.st.gw[1] - base.goalW * 0.75) < 1e-9, `clear: goal widths restored (${b.st.gw})`);
    check(t.bt.ca[1] === 1, 'clear: catch arming survives a goal');
    b.sim.restart();
    check(b.st.bt.ca.join() === '0,0', 'restart: catch arming cleared');
  }

  // Bot item rules: magnet waits for the puck in the host half, steal for a host item, catch for an incoming puck.
  {
    const mk = () => {
      const b = nb({ players: 'bot', botLevel: 'medium' }, 84);
      b.sim.setReady('host');
      b.st.phase = PHASE.PLAY;
      return b;
    };
    const guestPark = (b) => () => Object.assign(b.st.puck, { x: W * 0.1, y: H * 0.3, vx: 0, vy: 0 });
    let b = mk();
    b.st.items.guest = 'magnet';
    b.st.bt.fz = 100; // a frozen puck: the bot cannot knock it towards the host
    run(b, 3, guestPark(b));
    check(b.st.items.guest === 'magnet', 'bot holds magnet while the puck is in its half');
    run(b, 0.2, parkFar(b));
    b.st.bt.fz = 0;
    check(b.st.items.guest === null, 'bot uses magnet once the puck is in the host half');
    b = mk();
    b.st.items.guest = 'steal';
    run(b, 3, parkFar(b));
    check(b.st.items.guest === 'steal', 'bot holds steal while the host has nothing');
    b.st.items.host = 'goalie';
    run(b, 0.2, parkFar(b));
    check(b.st.items.guest === 'goalie' && b.st.items.host === null, 'bot steals the host item');
    b = mk();
    b.st.items.guest = 'catch';
    run(b, 3, parkFar(b));
    check(b.st.items.guest === 'catch', 'bot holds catch without an incoming puck');
    run(b, 0.2, () => Object.assign(b.st.puck, { x: W * 0.3, y: H * 0.6, vx: 0, vy: -300 }));
    check(b.st.items.guest === null && b.st.bt.ca[1] === 1, 'bot arms catch for an incoming puck');
  }
}

// ---- prediction helpers with the new snapshot fields ----------------------------------------
console.log('\npredictMalletHit / advancePuck with pr, gx, tx.in, tx.k');
{
  const pR = base.puckR;
  const mR = base.malletR;
  // pr: a still mallet beside a passing tiny puck.
  {
    const cfg = { ...base, mode: 'battle' };
    const off = 0.8 * pR + mR;
    const snap = { p: [W / 2 + off, bottom - 330, 0, 900], g: G };
    const mal = { x: W / 2, y: bottom - 300, vx: 0, vy: 0 };
    check(predictMalletHit(snap, cfg, 'host', mal, 0.05) !== null, 'pred: full-size puck touches');
    check(predictMalletHit({ ...snap, pr: pR * 0.6 }, cfg, 'host', mal, 0.05) === null, 'pred: snap.pr tiny puck misses');
  }
  // gx: the guest mallet shoves a puck at the end rail where the moved mouth is open.
  for (const twist of ['movinggoals', 'blackout']) {
    const cfg = { ...base, mode: 'random', players: 'pass', twist };
    const sim = createSim(cfg, { rng: rngFor(90) });
    const st = sim.state;
    st.phase = PHASE.PLAY;
    const px = W / 2 + 0.2 * W;
    Object.assign(st.puck, { x: px, y: pR + 3, vx: 0, vy: 0 });
    let my = st.puck.y + pR + mR + 10 + 200;
    let now = 1000;
    sim.setMallet('guest', px - 6, my, now, true);
    for (let i = 0; i < 10; i++) {
      now += DT * 1000;
      my -= 20;
      sim.setMallet('guest', px - 6, my, now);
    }
    const snap = sim.snapshot();
    const mg = st.mallets.guest;
    const pred = predictMalletHit(snap, cfg, 'guest', { x: mg.x, y: mg.y, vx: mg.vx, vy: mg.vy }, DT);
    now += DT * 1000;
    my -= 20;
    sim.setMallet('guest', px - 6, my, now);
    const p = st.puck;
    const ok = pred && Math.hypot(pred[0] - p.x, pred[1] - p.y) <= 2 && Math.hypot(pred[2] - p.vx, pred[3] - p.vy) <= 0.02 * Math.hypot(p.vx, p.vy) + 1;
    check(ok, `pred ${twist}: matches the sim at the rail (pred ${pred && pred.map((v) => v.toFixed(1))}, sim ${[p.x, p.y, p.vx, p.vy].map((v) => v.toFixed(1))})`);
    if (twist === 'movinggoals') check(snap.gx[1] === r1(0.2 * W) && p.y < pR - 0.5, `pred gx: mouth open at the shifted spot (y ${p.y.toFixed(1)})`);
    else check(p.y >= pR - 1e-6, 'pred gx control: solid rail at the same spot');
  }
  // tx.in: advancePuck bounces off the inset rail like the shrinking sim.
  {
    const cfg = { ...base, mode: 'random', players: 'pass', twist: 'shrinking' };
    const sim = createSim(cfg, { rng: rngFor(91) });
    const st = sim.state;
    sim.setReady('host');
    sim.setReady('guest');
    let now = 1000;
    for (let i = 0; i < 400 && st.phase !== PHASE.PLAY; i++) {
      now += DT * 1000;
      sim.step(DT, now);
      sim.snapshot();
    }
    for (let i = 0; i < Math.round(8 / DT); i++) {
      now += DT * 1000;
      Object.assign(st.puck, { x: W / 2, y: H + G + H / 2, vx: 0, vy: 0 });
      sim.step(DT, now);
      sim.snapshot();
    }
    const inset = st.tx.in;
    check(inset > 70 && inset < 90, `shrinking inset after 8 s of play (${inset.toFixed(1)})`);
    Object.assign(st.puck, { x: inset + 150, y: H + G + 300, vx: -1500, vy: 200 });
    const snap = sim.snapshot();
    const pred = advancePuck(snap.p, cfg, 0.3, snap);
    const flat = advancePuck(snap.p, cfg, 0.3);
    for (let i = 0; i < 18; i++) {
      now += DT * 1000;
      sim.step(DT, now);
    }
    const p = st.puck;
    const err = Math.hypot(pred[0] - p.x, pred[1] - p.y);
    check(err <= 4 && pred[2] > 0, `advancePuck tx.in: off by ${err.toFixed(2)} px after the inset bounce`);
    check(Math.hypot(flat[0] - p.x, flat[1] - p.y) > 50, 'advancePuck without snap ignores the inset (control)');
    console.log(`  inset ${inset.toFixed(1)} px, advancePuck err ${err.toFixed(2)} px`);
  }
  // tx.k: a turbo hit beyond the normal cap, advanced and predicted.
  {
    const cfg = { ...base, mode: 'random', players: 'pass', twist: 'turbo' };
    const sim = createSim(cfg, { rng: rngFor(92) });
    const st = sim.state;
    st.phase = PHASE.PLAY;
    const stage = (step) => {
      Object.assign(st.puck, { x: W / 2, y: H + G + 300, vx: 0, vy: 0 });
      let my = st.puck.y + 80 + step * 10;
      let now = 1000 + st.time * 1000;
      sim.setMallet('host', W / 2, my, now, true);
      for (let i = 0; i < 10; i++) {
        now += DT * 1000;
        my -= step;
        sim.setMallet('host', W / 2, my, now);
      }
      return { my, now };
    };
    // Two hits raise k to 1.21; the third is predicted.
    for (let n = 0; n < 2; n++) {
      const { my, now } = stage(40);
      sim.setMallet('host', W / 2, my - 40, now + DT * 1000);
      sim.setMallet('host', W / 2, bottom - mR, now + 2 * DT * 1000, true);
    }
    check(Math.abs(st.tx.k - 1.21) < 1e-9, `turbo k after two hits (${st.tx.k})`);
    const { my, now } = stage(40);
    const snap = sim.snapshot();
    const mh = st.mallets.host;
    const pred = predictMalletHit(snap, cfg, 'host', { x: mh.x, y: mh.y, vx: mh.vx, vy: mh.vy }, DT);
    sim.setMallet('host', W / 2, my - 40, now + DT * 1000);
    const p = st.puck;
    const real = Math.hypot(p.vx, p.vy);
    const ps = pred ? Math.hypot(pred[2], pred[3]) : 0;
    check(real > 2600 * 1.21, `turbo hit beyond the old cap (${Math.round(real)})`);
    check(pred && Math.abs(ps - real) / real < 0.02, `pred tx.k: ${Math.round(ps)} vs sim ${Math.round(real)}`);
    // Free motion of that fast puck.
    sim.setMallet('host', W * 0.9, bottom - mR, now + 2 * DT * 1000, true);
    Object.assign(p, { x: W * 0.3, y: H + G + 200, vx: 0.8 * real, vy: 0.6 * real * 0.1 });
    const s2 = sim.snapshot();
    const adv = advancePuck(s2.p, cfg, 0.25, s2);
    const flat = advancePuck(s2.p, cfg, 0.25);
    const turboMax = MODE_PHYS.random.max;
    const adv2 = advancePuck(s2.p, cfg, 0.25, s2);
    check(adv2.join() === adv.join() && adv2 !== adv, 'advancePuck tx.k: repeat call gives the identical result (scratch phys)');
    check(MODE_PHYS.random.max === turboMax && advancePuck(s2.p, cfg, 0.25).join() === flat.join(), 'advancePuck tx.k: mode phys untouched by the scratch');
    for (let i = 0; i < 15; i++) sim.step(DT, now + (i + 3) * DT * 1000);
    const e1 = Math.hypot(adv[0] - p.x, adv[1] - p.y);
    const e2 = Math.hypot(flat[0] - p.x, flat[1] - p.y);
    check(e1 <= 2 && e2 > 10, `advancePuck tx.k: err ${e1.toFixed(2)} px (without snap ${e2.toFixed(1)})`);
    console.log(`  turbo k ${snap.tx.k}, hit pred ${Math.round(ps)} vs sim ${Math.round(real)}, advance err ${e1.toFixed(2)} px`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
process.exit(failures ? 1 : 0);
