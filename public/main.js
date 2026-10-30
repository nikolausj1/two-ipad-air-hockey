// Lobby, app flow, networking glue and the per-frame loop.
//
// Three ways to play, one game loop:
//   duo   two iPads. The host runs the sim and streams snapshots, the guest
//         sends its mallet position and renders the host's snapshots.
//   bot   one device, local sim, the sim drives the guest mallet.
//   pass  one device, local sim, two people each drag their own half.
// 'solo' is the view role used for bot and pass (whole rink on one screen).
//
// Every match starts in the sim's 'ready' phase: each player presses down on
// their own half, then the countdown runs. The two-iPad host can adjust the
// seam gap during 'ready' (a calibration ring is drawn on both screens).
// Messages added on top of the relay: {t:'ready'} (guest pressed down),
// {t:'calib', on:0|1} (host -> guest: draw the calibration ring).

import { connect } from './net.js';
import { createSim } from './sim.js';
import { createView } from './view.js';

const $ = (id) => document.getElementById(id);
const canvas = $('rink');

// Rough CSS px per millimetre on an iPad (about 132 CSS px per inch).
const PX_PER_MM = 132 / 25.4;

// --- persisted settings -----------------------------------------------------

const SETTINGS_KEY = 'twoIpadHockey.settings.v1';
const SESSION_KEY = 'twoIpadHockey.table.v1'; // sessionStorage: {role, code}

const DEFAULTS = {
  play: 'duo', // last chosen way to play: 'duo' | 'bot' | 'pass'
  duoRole: 'host', // 'host' | 'join'
  mode: 'classic',
  target: 7,
  comeback: true,
  botLevel: 'medium',
  gap: 16,
  sound: true,
};
const MODES = ['classic', 'bumpers', 'ice', 'heavy', 'mines'];
const PLAYS = ['duo', 'bot', 'pass'];
const BOT_LEVELS = ['easy', 'medium', 'hard', 'impossible'];
const TARGETS = [5, 7, 11];

function sanitize(s) {
  const out = { ...DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
  if (!PLAYS.includes(out.play)) out.play = DEFAULTS.play;
  if (out.duoRole !== 'host' && out.duoRole !== 'join') out.duoRole = 'host';
  if (!MODES.includes(out.mode)) out.mode = DEFAULTS.mode;
  out.target = Number(out.target);
  if (!TARGETS.includes(out.target)) out.target = DEFAULTS.target;
  out.comeback = out.comeback !== false;
  if (!BOT_LEVELS.includes(out.botLevel)) out.botLevel = DEFAULTS.botLevel;
  out.gap = Math.max(0, Math.min(60, Math.round(Number(out.gap))));
  if (!Number.isFinite(out.gap)) out.gap = DEFAULTS.gap;
  out.sound = out.sound !== false;
  return out;
}

function loadSettings() {
  try {
    return sanitize(JSON.parse(localStorage.getItem(SETTINGS_KEY)));
  } catch {
    return sanitize(null);
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode */
  }
}
function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (s && (s.role === 'host' || s.role === 'guest') && /^[A-Z]{4}$/.test(s.code)) return s;
  } catch {
    /* ignore */
  }
  return null;
}
function saveSession() {
  try {
    if (intent && tableCode) sessionStorage.setItem(SESSION_KEY, JSON.stringify({ role: intent.role, code: tableCode }));
  } catch {
    /* ignore */
  }
}
function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

let settings = loadSettings();

// --- audio (loaded lazily so a missing file never breaks the game) -----------

const silent = { unlock() {}, onEvents() {}, setMuted() {}, setPerspective() {}, muted: false };
let audio = silent;
import('./audio.js')
  .then((m) => {
    audio = m.createAudio();
    audio.setMuted(!settings.sound);
    if (gestureSeen) unlockAudio();
  })
  .catch(() => {
    /* no audio module: play silently */
  });

let gestureSeen = false;
// iOS WebKit grants audio activation on pointerup / touchend / click, not on
// pointerdown, so listen for all of them. unlock() is cheap and idempotent.
function unlockAudio() {
  gestureSeen = true;
  if (audio === silent) return;
  try {
    audio.unlock();
  } catch {
    /* try again on the next gesture */
  }
}
for (const ev of ['pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(ev, unlockAudio, true);

function applySound() {
  audio.setMuted(!settings.sound);
}

// --- app state --------------------------------------------------------------

let net = null;
let netState = 'idle'; // 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'
let intent = null; // {role:'host'|'guest', code?:string}: what this device is doing at a table
let tableCode = null; // the table we are seated at (set once the server confirms)
let peerPresent = false; // the other iPad is connected right now
let resuming = false; // page load found a stored table; waiting for the server's answer
let lastRx = 0;
let rtt = null;
let rttAt = 0;

let role = null; // view role: 'host' | 'guest' | 'solo'
let gamePlay = null; // 'duo' | 'bot' | 'pass' for the running game
let cfg = null;
let sim = null;
let view = null;
let viewKey = '';
let running = false;
let paused = false;
let menuOpen = false;
let lastSnapshot = null;
let lastRendered = null; // guest: the last snapshot object handed to view.render
let lastSnapshotAt = 0;
let pendingInput = null; // guest: latest mallet sample {x, y, ts, j} in world coords
let guestTs = null; // host: ts of the previous guest input (guest clock)
let guestNow = 0; // host: synthetic sim clock for the guest mallet
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
let pendingEv = []; // host: events not yet delivered to the guest
let overSince = 0;
let prevPhase = null;
let everPaired = false; // this table has had both iPads at least once (toast wording)
let modeChange = false; // host/solo is in the setup screen between matches
let calibDone = false; // host dismissed the seam-gap overlay for this table
let calibSent = false; // host: last calib state sent to the guest
let calibRemote = false; // guest: the host asked us to draw the calibration ring
let overShown = false;
const ui = { held: false, calibrating: false }; // handed to view.render each frame

function setLatency(ms) {
  if (view && typeof view.setLatency === 'function') view.setLatency(ms);
}

// --- small UI helpers -------------------------------------------------------

function setStatus(msg) {
  for (const el of document.querySelectorAll('.status')) el.textContent = msg || '';
}

function showScreen(name) {
  for (const id of ['play', 'setup', 'wait']) $('screen-' + id).classList.toggle('hidden', id !== name);
  $('lobby').scrollTop = 0;
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function showLobby(screen) {
  $('lobby').classList.remove('hidden');
  $('btn-menu').classList.add('hidden');
  $('menu').classList.add('hidden');
  menuOpen = false;
  showScreen(screen || 'play');
  startLobbyBg();
}

function refreshUI() {
  for (const seg of document.querySelectorAll('[data-seg]')) {
    const key = seg.dataset.seg;
    for (const b of seg.querySelectorAll('button')) {
      const on = String(settings[key]) === b.dataset.v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
  for (const sw of document.querySelectorAll('[data-toggle]')) {
    sw.setAttribute('aria-checked', String(!!settings[sw.dataset.toggle]));
  }
  const play = settings.play;
  const duo = play === 'duo';
  const joining = duo && settings.duoRole === 'join';
  $('duo-tabs').classList.toggle('hidden', !duo);
  $('panel-options').classList.toggle('hidden', joining);
  $('field-bot').classList.toggle('hidden', play !== 'bot');
  $('field-gap').classList.toggle('hidden', !duo);
  $('panel-join').classList.toggle('hidden', !joining);
  $('actions').classList.toggle('hidden', joining);
  $('btn-primary').textContent = modeChange ? 'Start new match' : duo ? 'Host a table' : play === 'bot' ? 'Play vs bot' : 'Start game';
  $('setup-title').textContent = modeChange ? 'Change mode' : duo ? 'Two iPads' : play === 'bot' ? 'Solo vs bot' : 'Pass & play';
  $('btn-back').textContent = modeChange ? '\u2039 Cancel' : '\u2039 Back';
  if (modeChange) $('duo-tabs').classList.add('hidden');
  $('gap-value').textContent = settings.gap + ' mm';
  $('calib-value').textContent = settings.gap + ' mm';
  $('m-sound').textContent = 'Sound: ' + (settings.sound ? 'on' : 'off');
}

// Segmented controls (mode cards, first-to, bot level, host/join tabs).
document.addEventListener('click', (e) => {
  const seg = e.target.closest('[data-seg] > button');
  if (seg) {
    const key = seg.parentElement.dataset.seg;
    const raw = seg.dataset.v;
    settings[key] = key === 'target' ? Number(raw) : raw;
    settings = sanitize(settings);
    saveSettings();
    refreshUI();
    setStatus('');
    return;
  }
  const sw = e.target.closest('[data-toggle]');
  if (sw) {
    const key = sw.dataset.toggle;
    settings[key] = !settings[key];
    saveSettings();
    if (key === 'sound') applySound();
    refreshUI();
  }
});

// Seam gap stepper with press-and-hold repeat. `step` runs once per tick.
function bindStepper(id, step) {
  const el = $(id);
  let delay = null;
  let repeat = null;
  const stop = () => {
    clearTimeout(delay);
    clearInterval(repeat);
    delay = repeat = null;
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    stop();
    step();
    delay = setTimeout(() => {
      repeat = setInterval(step, 70);
    }, 400);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, stop);
  el.addEventListener('click', (e) => {
    if (e.detail === 0) step(); // keyboard activation
  });
}
const gapStep = (delta) => () => {
  settings.gap = clamp(settings.gap + delta, 0, 60);
  saveSettings();
  refreshUI();
};
bindStepper('gap-minus', gapStep(-1));
bindStepper('gap-plus', gapStep(1));
// The same stepper on the in-game calibration bar also moves the live sim.
bindStepper('calib-minus', () => adjustGap(-1));
bindStepper('calib-plus', () => adjustGap(1));

// Step 1 -> step 2.
for (const card of document.querySelectorAll('[data-play]')) {
  card.addEventListener('click', () => {
    settings.play = card.dataset.play;
    saveSettings();
    refreshUI();
    setStatus('');
    showScreen('setup');
  });
}
$('btn-back').addEventListener('click', () => {
  setStatus('');
  clearJoinError();
  if (modeChange) return cancelModeChange();
  showScreen('play');
});

function clearJoinError() {
  const el = $('join-error');
  el.classList.add('hidden');
  el.textContent = '';
  $('code-input').classList.remove('invalid');
}
function showJoinError(text, code) {
  const el = $('join-error');
  el.textContent = text;
  el.classList.remove('hidden');
  const input = $('code-input');
  if (typeof code === 'string') input.value = code;
  input.classList.remove('invalid');
  void input.offsetWidth; // restart the shake animation
  input.classList.add('invalid');
  try {
    input.focus();
    input.select();
  } catch {
    /* ignore */
  }
}
function submitCode() {
  unlockAudio();
  const code = $('code-input').value.trim().toUpperCase();
  clearJoinError();
  if (!/^[A-Z]{4}$/.test(code)) return showJoinError('Type the 4-letter code shown on the host iPad.');
  $('code-input').blur();
  startJoining(code);
}
$('code-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  clearJoinError();
  if (e.target.value.length === 4) submitCode(); // auto-join at 4 letters
});
$('code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitCode();
});

$('btn-primary').addEventListener('click', () => {
  unlockAudio();
  if (modeChange) applyModeChange();
  else if (settings.play === 'duo') startHosting();
  else startLocal(settings.play);
});
$('btn-join-auto').addEventListener('click', () => {
  unlockAudio();
  clearJoinError();
  startJoining('');
});
$('btn-join-code').addEventListener('click', submitCode);
$('btn-wait-cancel').addEventListener('click', () => leaveTable('', settings.play === 'duo' ? 'setup' : 'play'));
$('btn-conn-leave').addEventListener('click', () => leaveTable('', 'play'));

// --- waiting screen ---------------------------------------------------------

let qrFor = '';
// When this page was opened as localhost the QR code would be useless on the
// other iPad, so ask the server for its LAN address.
let baseUrl = location.origin;
if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  fetch('/info')
    .then((r) => r.json())
    .then((info) => {
      if (info && Array.isArray(info.urls) && typeof info.urls[0] === 'string') {
        baseUrl = info.urls[0];
        qrFor = '';
        if (intent && !running) renderWait();
      }
    })
    .catch(() => {
      /* keep location.origin */
    });
}
function renderQr(code) {
  if (qrFor === code) return;
  qrFor = code;
  const url = code ? `${baseUrl}/?join=${code}` : '';
  $('wait-url').textContent = code ? baseUrl : '';
  $('wait-code-inline').textContent = code || '';
  const box = $('wait-qr');
  box.innerHTML = '';
  if (code && typeof qrcode === 'function') {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    } catch {
      box.innerHTML = '';
    }
  }
}

function renderWait() {
  if (!intent) return;
  const host = intent.role === 'host';
  $('wait-code').textContent = tableCode || '';
  $('wait-share').classList.toggle('hidden', !(host && tableCode));
  renderQr(host ? tableCode || '' : '');
  let title;
  let text = '';
  if (host) {
    title = 'Waiting for the other iPad';
    if (!tableCode) text = netState === 'open' ? 'Opening a table…' : 'Connecting…';
    else if (netState !== 'open') text = 'Reconnecting…';
    else text = 'Lay the iPads flat, top edge against top edge, in portrait.';
  } else {
    title = tableCode ? 'Joined table ' + tableCode : 'Looking for a table…';
    if (netState !== 'open') text = tableCode ? 'Reconnecting…' : 'Connecting…';
    else if (!tableCode) text = intent.code ? 'Joining ' + intent.code + '…' : 'Looking for the open table…';
    else if (!peerPresent) text = 'The host iPad is not connected right now. Waiting for it to come back…';
    else text = 'Waiting for the host to start…';
  }
  $('wait-title').textContent = title;
  $('wait-text').textContent = text;
}

// --- connection overlay (reconnecting / other iPad away) ---------------------

function updateOverlays() {
  const overlay = $('overlay-conn');
  const show = (title, text) => {
    $('conn-title').textContent = title;
    $('conn-text').textContent = text;
    overlay.classList.remove('hidden');
  };
  if (!intent || !(running || resuming)) {
    overlay.classList.add('hidden');
  } else if (netState !== 'open') {
    show('Reconnecting…', 'Lost the connection. Trying again automatically.');
  } else if (resuming) {
    show('Reconnecting…', tableCode ? `Getting back to table ${tableCode}.` : 'Getting back to your table.');
  } else if (running && !peerPresent) {
    show('Other iPad disconnected', 'Waiting for it to come back. The game continues where it left off.');
  } else {
    overlay.classList.add('hidden');
  }
  if (!running) renderWait();
}

// --- networking -------------------------------------------------------------

function openNet() {
  closeNet();
  netState = 'connecting';
  net = connect({
    onOpen: handleOpen,
    onMessage,
    onClose: handleClose,
    onState: (s) => {
      netState = s;
      updateOverlays();
    },
  });
}

function closeNet() {
  if (net) net.close();
  net = null;
  netState = 'idle';
  rtt = null;
}

function handleOpen() {
  lastRx = performance.now();
  if (!intent) return;
  if (intent.role === 'host') {
    // With a code this reclaims our table; without one it opens a new table.
    net.send(tableCode ? { t: 'host', code: tableCode } : { t: 'host' });
  } else {
    net.send({ t: 'join', code: tableCode || intent.code || '', rejoin: !!tableCode });
  }
}

function handleClose() {
  peerPresent = false;
  setLatency(null);
  updateOverlays();
}

function startHosting() {
  beginSession('host', '');
  showScreen('wait');
  renderWait();
}

function startJoining(code) {
  setStatus('');
  beginSession('guest', code);
  showScreen('wait');
  renderWait();
}

function beginSession(sessionRole, code) {
  stopGame();
  clearSession();
  intent = { role: sessionRole, code: code || '' };
  tableCode = null;
  peerPresent = false;
  resuming = false;
  everPaired = false;
  calibDone = false;
  openNet();
}

function leaveTable(message, screen) {
  if (net && intent) net.send({ t: 'leave' });
  closeNet();
  intent = null;
  tableCode = null;
  peerPresent = false;
  resuming = false;
  everPaired = false;
  modeChange = false;
  clearSession();
  stopGame();
  updateOverlays();
  showLobby(screen || 'play');
  setStatus(message || '');
}

function onMessage(msg) {
  lastRx = performance.now();
  if (!intent) return;
  switch (msg.t) {
    case 'hosted': // we have a table (new, or reclaimed after a drop)
      tableCode = msg.code;
      resuming = false;
      peerPresent = false; // 'paired' follows if the guest is still there
      saveSession();
      updateOverlays();
      break;

    case 'joined':
      tableCode = msg.code;
      resuming = false;
      peerPresent = false; // 'paired' follows when the host is there
      saveSession();
      updateOverlays();
      break;

    case 'guest-joined':
      break; // 'paired' is what we act on

    case 'paired':
      peerPresent = true;
      guestTs = null;
      toast(everPaired ? 'Other iPad reconnected' : 'Other iPad connected');
      everPaired = true;
      if (intent.role === 'host') {
        if (sim && gamePlay === 'duo' && running) {
          net.send({ t: 'config', cfg }); // resume, score intact
          calibSent = false; // re-announce the calibration ring if it is open
        } else startAsHost();
      }
      updateOverlays();
      break;

    case 'config':
      if (!msg.cfg || !Number.isFinite(msg.cfg.W) || !Number.isFinite(msg.cfg.H)) break;
      if (intent.role === 'guest') startAsGuest(msg.cfg);
      break;

    case 's':
      audio.onEvents(msg.ev || [], msg);
      // Two snapshots between frames: carry the unrendered one's events over so
      // the view (which consumes events per snapshot object) still sees them.
      if (lastSnapshot && lastSnapshot !== lastRendered && lastSnapshot.ev && lastSnapshot.ev.length) {
        msg.ev = lastSnapshot.ev.concat(msg.ev || []).slice(-64);
      }
      lastSnapshot = msg;
      lastSnapshotAt = performance.now();
      break;

    case 'input': {
      if (!sim || intent.role !== 'host') break;
      if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) break;
      const jump = msg.j === 1 || msg.j === true;
      let t = performance.now();
      // Derive the mallet dt from the guest's own timestamps, not arrival time.
      if (!jump && guestTs != null && Number.isFinite(msg.ts)) t = guestNow + clamp(msg.ts - guestTs, 4, 50);
      guestTs = Number.isFinite(msg.ts) ? msg.ts : null;
      guestNow = t;
      sim.setMallet('guest', msg.x, msg.y, t, jump);
      break;
    }

    case 'ready': // guest pressed down on its half
      if (sim && intent.role === 'host' && typeof sim.setReady === 'function') sim.setReady('guest');
      break;

    case 'calib': // host: draw (or stop drawing) the seam-gap ring
      if (intent.role === 'guest') calibRemote = msg.on === 1 || msg.on === true;
      break;

    case 'restart':
      if (sim && intent.role === 'host' && !modeChange) sim.restart(); // not while the host is picking a new mode
      break;

    case 'ping':
      if (net) net.send({ t: 'pong', c: msg.c });
      break;

    case 'pong': {
      const now = performance.now();
      const raw = now - msg.c;
      if (raw >= 0 && raw < 10000) {
        rtt = rtt == null ? raw : rtt * 0.6 + raw * 0.4;
        rttAt = now;
        setLatency(Math.round(rtt));
      }
      break;
    }

    case 'peer-left':
      peerPresent = false;
      guestTs = null;
      setLatency(null);
      rtt = null;
      pointers.clear();
      updateOverlays();
      break;

    case 'closed':
      leaveTable(msg.m || 'The table was closed.', 'play');
      break;

    case 'error': {
      const wasInTable = running || resuming;
      const joining = intent.role === 'guest' && !wasInTable;
      const tried = intent.code || '';
      if (joining) {
        // Wrong or stale code: stay on the join form and say so in friendly words.
        const friendly = {
          'no-table': tried ? `No table with code ${tried}. Check the code on the host iPad.` : 'No table found.',
          full: 'That table already has two iPads.',
          'none-open': 'No table is waiting yet. Host one on the other iPad first.',
          multiple: 'Several tables are open. Type the code shown on the host iPad.',
        };
        leaveTable('', 'setup');
        settings.play = 'duo';
        settings.duoRole = 'join';
        refreshUI();
        showJoinError(friendly[msg.code] || msg.m || 'Could not join that table.', tried);
        break;
      }
      leaveTable(msg.m || 'Something went wrong.', wasInTable ? 'play' : 'setup');
      break;
    }
  }
}

// Ping the other iPad every 2 s to measure round-trip time.
setInterval(() => {
  if (!intent || !net || !net.isOpen || !peerPresent) return;
  const now = performance.now();
  net.send({ t: 'ping', c: now });
  if (rttAt && now - rttAt > 7000) {
    rtt = null;
    setLatency(null);
  }
}, 2000);

// Watchdog: a socket that is "open" but silent is dead (iPad slept). Any
// message counts, including the server's 15 s {t:'hb'}; paired we also get
// pings every 2 s, so 5 s of silence is enough then.
setInterval(() => {
  if (!intent || !net || !net.isOpen) return;
  if (performance.now() - lastRx > (peerPresent ? 5000 : 40000)) net.reset();
}, 1000);

// --- game start / stop ------------------------------------------------------

function buildCfg(play) {
  const iw = window.innerWidth;
  const ih = window.innerHeight;
  let W;
  let H;
  let G;
  let base;
  if (play === 'duo') {
    // Host screen defines the world; the gap stands in for the bezels.
    W = iw;
    H = ih;
    G = Math.round(settings.gap * PX_PER_MM);
    base = Math.min(W, H);
  } else {
    // One screen shows the whole rink (two halves, no seam gap).
    G = 0;
    H = Math.round((ih - G) / 2);
    W = Math.round(ih >= iw ? Math.min(iw, ih * 0.6) : ih * 0.62);
    base = W;
  }
  return {
    W,
    H,
    G,
    puckR: Math.round(base * 0.035),
    malletR: Math.round(base * 0.055),
    goalW: Math.round(W * 0.36),
    target: settings.target,
    mode: settings.mode,
    comeback: !!settings.comeback,
    players: play,
    botLevel: settings.botLevel,
  };
}

function startAsHost() {
  cfg = buildCfg('duo');
  sim = createSim(cfg);
  role = 'host';
  gamePlay = 'duo';
  lastSnapshot = null;
  guestTs = null;
  calibSent = false;
  net.send({ t: 'config', cfg });
  beginPlay();
}

function startAsGuest(c) {
  if (running && role === 'guest' && cfg) {
    if (JSON.stringify(cfg) === JSON.stringify(c)) {
      updateOverlays(); // same table, just resumed
      return;
    }
    // The host changed the seam gap or the mode: swap the geometry and view in
    // place. No lobby, no pointer / phase reset, snapshots keep flowing.
    cfg = c;
    rebuildView();
    lastRendered = null;
    updateOverlays();
    return;
  }
  cfg = c;
  sim = null;
  role = 'guest';
  gamePlay = 'duo';
  lastSnapshot = null;
  lastRendered = null;
  calibRemote = false;
  beginPlay();
}

/** (Re)create the view when role or cfg changed; cheap no-op otherwise. */
function rebuildView() {
  const key = role + JSON.stringify(cfg);
  if (view && viewKey === key) return;
  if (view && view.destroy) view.destroy();
  view = createView(canvas, role, cfg);
  viewKey = key;
  if (view.resize) view.resize();
  setLatency(gamePlay === 'duo' && rtt != null ? Math.round(rtt) : null);
}

// --- seam gap calibration (two-iPad host, phase 'ready') ----------------------

let gapTimer = null;
let gapDirty = false;
function adjustGap(delta) {
  settings.gap = clamp(settings.gap + delta, 0, 60);
  saveSettings();
  refreshUI();
  // Apply at most every 90 ms: re-creating the view is not free.
  if (gapTimer) {
    gapDirty = true;
    return;
  }
  applyGap();
  gapTimer = setTimeout(() => {
    gapTimer = null;
    if (gapDirty) {
      gapDirty = false;
      applyGap();
    }
  }, 90);
}

function applyGap() {
  if (!sim || role !== 'host' || gamePlay !== 'duo') return;
  const G = Math.round(settings.gap * PX_PER_MM);
  if (cfg.G === G) return;
  if (typeof sim.setGap !== 'function' || sim.setGap(G) === false) {
    // Too late (the countdown began): show the gap that is really in force.
    settings.gap = clamp(Math.round(cfg.G / PX_PER_MM), 0, 60);
    refreshUI();
    return;
  }
  cfg.G = G; // the sim already did this in place; harmless if so
  rebuildView();
  if (net) net.send({ t: 'config', cfg });
}

/** Show / hide the host's calibration bar and tell the guest to draw the ring. */
function syncCalib(ph) {
  if (role === 'host' && ph && ph !== 'ready') calibDone = true; // the match started: gap accepted, do not nag on rematches
  const want = role === 'host' && gamePlay === 'duo' && ph === 'ready' && !calibDone && !modeChange && peerPresent;
  $('calib').classList.toggle('hidden', !want);
  ui.calibrating = role === 'host' ? want : role === 'guest' ? calibRemote && ph === 'ready' : false;
  if (role === 'host' && net && peerPresent && calibSent !== want) {
    if (net.send({ t: 'calib', on: want ? 1 : 0 })) calibSent = want;
  }
}

$('calib-done').addEventListener('click', () => {
  calibDone = true;
  clearTimeout(gapTimer);
  gapTimer = null;
  if (gapDirty) {
    gapDirty = false;
    applyGap();
  }
});

// --- post-match sheet ----------------------------------------------------------

function syncOver(ph, now) {
  const want = running && !modeChange && ph === 'over' && now - overSince > 700;
  if (want === overShown) return;
  overShown = want;
  $('over').classList.toggle('hidden', !want);
  if (want) {
    const host = role !== 'guest';
    $('over-host').classList.toggle('hidden', !host);
    $('over-guest').classList.toggle('hidden', host);
    $('over-ask').disabled = false;
    $('over-ask').textContent = 'Ask for a rematch';
  }
}

$('over-rematch').addEventListener('click', () => requestRestart());
$('over-change').addEventListener('click', openChangeMode);
$('over-ask').addEventListener('click', () => {
  if (net) net.send({ t: 'restart' });
  const b = $('over-ask');
  b.disabled = true;
  b.textContent = 'Asked. Waiting for the host\u2026';
  setTimeout(() => {
    b.disabled = false;
    b.textContent = 'Ask for a rematch';
  }, 3500);
});

/** Back to the setup screen between matches. In duo the table stays paired. */
function openChangeMode() {
  if (!running || role === 'guest') return;
  if (gamePlay === 'duo') {
    modeChange = true;
    settings.play = 'duo';
    settings.duoRole = 'host';
    saveSettings();
    refreshUI();
    setStatus('');
    $('over').classList.add('hidden');
    overShown = false;
    $('calib').classList.add('hidden');
    showLobby('setup');
  } else {
    stopGame();
    refreshUI();
    showLobby('setup');
  }
}

function cancelModeChange() {
  modeChange = false;
  refreshUI();
  $('lobby').classList.add('hidden');
  $('btn-menu').classList.remove('hidden');
  pointers.clear();
  wakeMenuBtn();
}

/** Host: fresh sim with the newly chosen options; the guest follows via config. */
function applyModeChange() {
  modeChange = false;
  cfg = buildCfg('duo');
  sim = createSim(cfg);
  lastSnapshot = null;
  guestTs = null;
  calibSent = false;
  refreshUI();
  if (net && peerPresent) net.send({ t: 'config', cfg });
  beginPlay();
}

function startLocal(play) {
  stopGame();
  closeNet();
  intent = null;
  cfg = buildCfg(play);
  sim = createSim(cfg);
  role = 'solo';
  gamePlay = play;
  lastSnapshot = null;
  beginPlay();
}

function beginPlay() {
  rebuildView();
  if (audio.setPerspective) audio.setPerspective(role);
  if (view.resize) view.resize();

  $('lobby').classList.add('hidden');
  $('over').classList.add('hidden');
  overShown = false;
  modeChange = false;
  $('btn-menu').classList.remove('hidden');
  $('menu').classList.add('hidden');
  menuOpen = false;
  paused = false;
  pointers.clear();
  pendingInput = null;
  pendingEv = [];
  prevPhase = null;
  overSince = 0;
  running = true;
  lastFrame = performance.now();
  requestWakeLock();
  updateOverlays();
  updateRotateHint();
  wakeMenuBtn();
  if (!loopActive) {
    loopActive = true;
    requestAnimationFrame(frame);
  }
}

function stopGame() {
  running = false;
  paused = false;
  menuOpen = false;
  sim = null;
  lastSnapshot = null;
  lastRendered = null;
  pendingInput = null;
  pendingEv = [];
  pointers.clear();
  modeChange = false;
  overShown = false;
  calibSent = false;
  ui.held = ui.calibrating = false;
  $('btn-menu').classList.add('hidden');
  $('menu').classList.add('hidden');
  $('over').classList.add('hidden');
  $('calib').classList.add('hidden');
  releaseWakeLock();
  updateRotateHint();
}

/** Two-iPad games are played in portrait: nudge when the iPad is in landscape. */
function updateRotateHint() {
  const show = running && gamePlay === 'duo' && window.innerWidth > window.innerHeight;
  $('overlay-rotate').classList.toggle('hidden', !show);
}
window.addEventListener('resize', updateRotateHint);
window.addEventListener('orientationchange', updateRotateHint);

// --- input ------------------------------------------------------------------

/** pointerId -> {side:'host'|'guest', x, y} (world coordinates) */
const pointers = new Map();

function currentPhase() {
  if (sim) return sim.state.phase;
  return lastSnapshot ? lastSnapshot.ph : null;
}

function requestRestart() {
  if (sim) sim.restart();
  else if (net) net.send({ t: 'restart' });
  calibSent = false;
}

/** `jump` = first sample of a new touch: teleport the mallet, do not sweep. */
function moveMallet(side, wx, wy, jump = false) {
  const now = performance.now();
  if (sim) sim.setMallet(side, wx, wy, now, jump);
  else pendingInput = { x: wx, y: wy, ts: now, j: jump || !!(pendingInput && pendingInput.j) };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!running || menuOpen) return;
  e.preventDefault();
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* synthetic or already-released pointer */
  }
  const [wx, wy] = view.screenToWorld(e.clientX, e.clientY);

  const ph = currentPhase();

  // After the final goal a tap starts a new match (ignore the first moments
  // so a frantic last swipe does not skip the result).
  if (ph === 'over') {
    if (performance.now() - overSince > 700) requestRestart();
    return;
  }

  let side;
  if (gamePlay === 'pass') {
    side = wy > cfg.H + cfg.G / 2 ? 'host' : 'guest';
    for (const p of pointers.values()) if (p.side === side) return; // that half already has a finger
  } else {
    side = role === 'guest' ? 'guest' : 'host';
    pointers.clear(); // one finger at a time: the newest wins
  }
  pointers.set(e.pointerId, { side, x: wx, y: wy });
  moveMallet(side, wx, wy, true);

  // Pressing down on your own half is how you say "ready".
  if (ph === 'ready') {
    if (sim) {
      if (typeof sim.setReady === 'function') sim.setReady(side);
    } else if (net) {
      net.send({ t: 'ready' });
    }
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!running) return;
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const [wx, wy] = view.screenToWorld(e.clientX, e.clientY);
  p.x = wx;
  p.y = wy;
  moveMallet(p.side, wx, wy);
});

function releasePointer(e) {
  pointers.delete(e.pointerId);
}
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);
canvas.addEventListener('lostpointercapture', releasePointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// iOS: no pinch zoom, no double-tap zoom, no rubber band outside the lobby.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener(
  'touchmove',
  (e) => {
    if (!e.target.closest || !e.target.closest('.lobby')) e.preventDefault();
  },
  { passive: false },
);

// --- frame loop -------------------------------------------------------------

let lastFrame = 0;
let lastSend = 0;
let lastInputSend = 0;
let loopActive = false;
let loggedError = false;

function frame() {
  if (!running) {
    loopActive = false;
    return;
  }
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;

  try {
    if (sim) {
      // Host (duo) or local sim (bot / pass).
      const frozen = paused || (role === 'host' && !peerPresent);
      if (!frozen) sim.step(dt, now);
      const snap = sim.snapshot();
      lastSnapshot = snap;
      audio.onEvents(snap.ev || [], snap);
      trackPhase(snap.ph, now);

      if (role === 'host') {
        if (snap.ev && snap.ev.length) {
          pendingEv.push(...snap.ev);
          if (pendingEv.length > 200) pendingEv.splice(0, pendingEv.length - 200);
        }
        if (!peerPresent) {
          pendingEv = [];
        } else if (now - lastSend >= 15 && net.bufferedAmount < 64 * 1024) {
          // Stream at ~60 Hz even on 120 Hz displays, without dropping events.
          net.send({ ...snap, ev: pendingEv });
          pendingEv = [];
          lastSend = now;
        }
      }
      ui.held = pointers.size > 0;
      syncCalib(snap.ph);
      syncOver(snap.ph, now);
      view.render(snap, 0, now, null, ui);
    } else {
      // Guest.
      if (pendingInput && net && now - lastInputSend >= 15) {
        const msg = { t: 'input', x: pendingInput.x, y: pendingInput.y, ts: pendingInput.ts };
        if (pendingInput.j) msg.j = 1;
        net.send(msg);
        pendingInput = null;
        lastInputSend = now;
      }
      if (lastSnapshot) {
        trackPhase(lastSnapshot.ph, now);
        const age = Math.min(0.12, (now - lastSnapshotAt) / 1000);
        // Predicted local mallet: the clamped finger position while one is down.
        let local = null;
        for (const p of pointers.values()) {
          local = {
            x: clamp(p.x, cfg.malletR, cfg.W - cfg.malletR),
            y: clamp(p.y, cfg.malletR, cfg.H - cfg.malletR),
          };
          break;
        }
        ui.held = pointers.size > 0;
        syncCalib(lastSnapshot.ph);
        syncOver(lastSnapshot.ph, now);
        view.render(lastSnapshot, lastSnapshot.ph === 'play' ? age : 0, now, local, ui);
        lastRendered = lastSnapshot;
      }
    }
  } catch (err) {
    if (!loggedError) console.error(err);
    loggedError = true;
  }
}

function trackPhase(ph, now) {
  if (ph !== prevPhase) {
    if (ph === 'over') overSince = now;
    if (ph !== 'ready') calibRemote = false;
    prevPhase = ph;
  }
}

// --- menu / pause overlay ---------------------------------------------------

const fsTarget = document.documentElement;
const fsRequest = fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen;
const fsActive = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

function refreshMenu() {
  const duo = gamePlay === 'duo';
  $('menu-title').textContent = duo ? 'Menu' : 'Paused';
  $('m-leave').textContent = duo ? 'Leave table' : 'Quit to menu';
  $('m-fs').classList.toggle('hidden', !fsRequest || navigator.standalone === true);
  $('m-fs').textContent = fsActive() ? 'Exit fullscreen' : 'Fullscreen';
  $('m-restart').textContent = 'Restart';
  $('m-sound').textContent = 'Sound: ' + (settings.sound ? 'on' : 'off');
  const showCode = duo && !!tableCode;
  $('menu-code').classList.toggle('hidden', !showCode);
  $('menu-code-val').textContent = showCode ? tableCode : '';
}

function openMenu() {
  if (!running || menuOpen || modeChange) return;
  menuOpen = true;
  restartArmed = false;
  paused = gamePlay !== 'duo'; // a two-iPad game cannot pause the other iPad
  pointers.clear();
  refreshMenu();
  $('menu').classList.remove('hidden');
}

function closeMenu() {
  menuOpen = false;
  paused = false;
  lastFrame = performance.now();
  clearTimeout(restartConfirmTimer);
  $('menu').classList.add('hidden');
}

let restartConfirmTimer = null;
let restartArmed = false;

$('btn-menu').addEventListener('click', openMenu);
$('m-resume').addEventListener('click', closeMenu);
$('m-restart').addEventListener('click', () => {
  if (!restartArmed) {
    restartArmed = true;
    $('m-restart').textContent = 'Tap again to restart';
    clearTimeout(restartConfirmTimer);
    restartConfirmTimer = setTimeout(() => {
      restartArmed = false;
      $('m-restart').textContent = 'Restart';
    }, 3000);
    return;
  }
  restartArmed = false;
  requestRestart();
  closeMenu();
});
$('m-fs').addEventListener('click', () => {
  try {
    if (fsActive()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else fsRequest.call(fsTarget);
  } catch {
    /* not allowed right now */
  }
  setTimeout(refreshMenu, 250);
});
$('m-sound').addEventListener('click', () => {
  settings.sound = !settings.sound;
  saveSettings();
  applySound();
  refreshUI();
});
$('m-leave').addEventListener('click', () => {
  leaveTable('', 'play');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && running) {
    if (menuOpen) closeMenu();
    else openMenu();
  }
});
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, refreshMenu);

// --- menu button: fades while you play, wakes on any tap ------------------------

let dimTimer = null;
function wakeMenuBtn() {
  const btn = $('btn-menu');
  btn.classList.remove('dim');
  clearTimeout(dimTimer);
  dimTimer = setTimeout(() => {
    if (running && !menuOpen) btn.classList.add('dim');
  }, 3000);
}
document.addEventListener(
  'pointerdown',
  () => {
    if (running) wakeMenuBtn();
  },
  true,
);

// --- how to play sheet -----------------------------------------------------------

$('btn-howto').addEventListener('click', () => $('howto').classList.remove('hidden'));
$('howto-close').addEventListener('click', () => $('howto').classList.add('hidden'));
$('howto').addEventListener('click', (e) => {
  if (e.target === $('howto')) $('howto').classList.add('hidden');
});

// --- lobby background: a few slow glowing dots ------------------------------------

const lobbyBg = $('lobby-bg');
const bgCtx = lobbyBg.getContext('2d');
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let bgDots = null;
let bgSprites = null;
let bgRaf = 0;
let bgLast = 0;
let bgW = 0;
let bgH = 0;

function makeGlowSprite(rgb) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${rgb},0.9)`);
  grad.addColorStop(0.35, `rgba(${rgb},0.28)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

function resizeLobbyBg() {
  bgW = lobbyBg.width = Math.max(1, Math.round(window.innerWidth / 2)); // low-res on purpose: it is all blur
  bgH = lobbyBg.height = Math.max(1, Math.round(window.innerHeight / 2));
}

function initLobbyBg() {
  if (bgDots) return;
  bgSprites = [makeGlowSprite('79,209,255'), makeGlowSprite('255,122,69')];
  resizeLobbyBg();
  bgDots = [];
  for (let i = 0; i < 22; i++) {
    bgDots.push({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.018,
      vy: (Math.random() - 0.5) * 0.018,
      r: 14 + Math.random() * 34,
      a: 0.18 + Math.random() * 0.3,
      c: i % 2,
      ph: Math.random() * 6.28,
    });
  }
}

function drawLobbyBg(now) {
  const dt = Math.min(0.1, (now - bgLast) / 1000);
  bgLast = now;
  bgCtx.clearRect(0, 0, bgW, bgH);
  bgCtx.globalCompositeOperation = 'lighter';
  for (const d of bgDots) {
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    if (d.x < -0.05) d.x = 1.05;
    else if (d.x > 1.05) d.x = -0.05;
    if (d.y < -0.05) d.y = 1.05;
    else if (d.y > 1.05) d.y = -0.05;
    bgCtx.globalAlpha = d.a * (0.65 + 0.35 * Math.sin(now / 1800 + d.ph));
    const r = d.r * 2;
    bgCtx.drawImage(bgSprites[d.c], d.x * bgW - r, d.y * bgH - r, r * 2, r * 2);
  }
  bgCtx.globalAlpha = 1;
}

function lobbyBgFrame(now) {
  bgRaf = 0;
  // Paused whenever the lobby is hidden or the tab is in the background.
  if ($('lobby').classList.contains('hidden') || document.visibilityState !== 'visible') return;
  drawLobbyBg(now);
  if (!reduceMotion) bgRaf = requestAnimationFrame(lobbyBgFrame);
}

function startLobbyBg() {
  initLobbyBg();
  if (bgRaf) return;
  bgLast = performance.now();
  bgRaf = requestAnimationFrame(lobbyBgFrame);
}
window.addEventListener('resize', () => {
  if (bgDots) resizeLobbyBg();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('lobby').classList.contains('hidden')) startLobbyBg();
});

// --- wake lock / visibility -------------------------------------------------

let wakeLock = null;
let wakePending = false; // a request is in flight
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || wakePending) return;
  wakePending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!running) {
      // The game stopped while the request was in flight: do not keep the lock.
      lock.release().catch(() => {});
      return;
    }
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    wakeLock = null;
  } finally {
    wakePending = false;
  }
}
function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  lastRx = performance.now(); // give a returning tab a moment before the watchdog judges it
  if (running) requestWakeLock();
  if (net) net.nudge();
});

window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    if (view && view.resize) view.resize();
  }, 300);
});

// --- boot -------------------------------------------------------------------

refreshUI();
showLobby('play');
if (!fsRequest || navigator.standalone === true) $('m-fs').classList.add('hidden');

(function boot() {
  const params = new URLSearchParams(location.search);
  const joinCode = (params.get('join') || '').trim().toUpperCase();
  if (/^[A-Z]{4}$/.test(joinCode)) {
    // Scanned the QR code: go straight to joining that table.
    history.replaceState(null, '', location.pathname);
    settings.play = 'duo';
    settings.duoRole = 'join';
    refreshUI();
    startJoining(joinCode);
    return;
  }
  if (params.has('join')) history.replaceState(null, '', location.pathname);

  const session = loadSession();
  if (session) {
    // The page was reloaded (or the iPad slept) while seated at a table.
    intent = { role: session.role, code: session.code };
    tableCode = session.code;
    resuming = true;
    openNet();
    showScreen('wait');
    renderWait();
    updateOverlays();
  }
})();

// Debug hook for inspecting state from the console.
window.__dbg = () => ({
  role,
  cfg,
  state: sim && sim.state,
  lastSnapshot,
  running,
  paused,
  ui: { ...ui, calibRemote, calibDone, modeChange, overShown },
  pointers: [...pointers].map(([id, p]) => ({ id, side: p.side, x: p.x, y: p.y })),
  net: {
    state: netState,
    ws: net ? net.state : null,
    code: tableCode,
    intent: intent && { ...intent },
    peerPresent,
    resuming,
    rtt: rtt == null ? null : Math.round(rtt),
    attempts: net ? net.attempts : 0,
  },
});
