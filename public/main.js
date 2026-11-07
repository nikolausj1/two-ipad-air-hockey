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
// {t:'calib', on:0|1} (host -> guest: draw the calibration ring),
// {t:'use'} (guest tapped its item button in Battle mode).
//
// Networking goes through ./transport.js: 'p2p' (WebRTC data channel, works
// from static hosting, no computer needed) or 'ws' (the optional Node server).

import { createTransport } from './transport.js';
import { createSim, predictMalletHit, advancePuck, physOf } from './sim.js';
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
  conn: 'auto', // 'auto' | 'p2p' | 'ws' (see pickKind)
  diag: false, // diagnostics panel (fps, rtt, jitter...) in the pause menu
};
const TWIST_IDS = ['twinpuck', 'movinggoals', 'gravity', 'blackout', 'wind', 'hotpotato', 'shrinking', 'turbo'];
const MODES = ['classic', 'bumpers', 'ice', 'bombs', 'mines', 'glitch', 'battle', ...TWIST_IDS, 'random'];
const MODE_NAMES = {
  classic: 'Classic',
  bumpers: 'Bumpers',
  ice: 'Ice',
  bombs: 'Bombs',
  mines: 'Mines',
  glitch: 'Glitch',
  battle: 'Battle',
  twinpuck: 'Twin Puck',
  movinggoals: 'Moving Goals',
  gravity: 'Gravity Well',
  blackout: 'Blackout',
  wind: 'Wind',
  hotpotato: 'Hot Potato',
  shrinking: 'Shrinking Rink',
  turbo: 'Turbo',
  random: 'Random',
};
const PLAYS = ['duo', 'bot', 'pass'];
const BOT_LEVELS = ['easy', 'medium', 'hard', 'impossible'];
const TARGETS = [5, 7, 11];
const CONNS = ['auto', 'p2p', 'ws'];

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
  if (!CONNS.includes(out.conn)) out.conn = DEFAULTS.conn;
  out.diag = out.diag === true;
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
    if (s && (s.role === 'host' || s.role === 'guest') && /^[A-Z]{4}$/.test(s.code)) {
      return { role: s.role, code: s.code, kind: s.kind === 'p2p' || s.kind === 'ws' ? s.kind : '' };
    }
  } catch {
    /* ignore */
  }
  return null;
}
function saveSession() {
  try {
    if (intent && tableCode) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ role: intent.role, code: tableCode, kind: trKind || '' }));
    }
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

let tr = null; // the transport (also used table-less to watch for nearby tables)
let trKind = null; // 'p2p' | 'ws': kind of `tr`
let netState = 'idle'; // 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'
let intent = null; // {role:'host'|'guest', code?:string, kind?:string}: what this device is doing at a table
let tableCode = null; // the table we are seated at (set once host() / join() resolved)
let peerPresent = false; // the other iPad is connected right now
let pendingPair = false; // peer event arrived before host() / join() resolved
let resuming = false; // page load found a stored table; waiting for it to be reclaimed
let connectStart = 0; // when the current connection attempt began (slow-connect hint)
let trGen = 0; // bumped whenever `tr` is replaced; stale callbacks check it
let sessionGen = 0; // bumped whenever a connection attempt is started or cancelled
let nearby = []; // tables announced by other iPads, newest first
let watchingNearby = false;
let nearbyGen = 0;
let announceKey = '';
let connecting = false; // host() / join() is in flight

let serverProbe = null;

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
  syncNearby();
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
  syncNearby();
}

const CONN_HINTS = {
  auto: 'Uses this server when the page came from one, otherwise a direct connection between the iPads.',
  p2p: 'The iPads talk to each other directly. Needs internet to find each other, works from any host.',
  ws: 'Plays through the computer running the Node server this page came from. No internet needed.',
};

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
  $('field-conn').classList.toggle('hidden', !duo || modeChange);
  $('conn-hint').textContent = CONN_HINTS[settings.conn] || '';
  $('panel-join').classList.toggle('hidden', !joining);
  $('actions').classList.toggle('hidden', joining);
  $('btn-primary').textContent = modeChange ? 'Start new match' : duo ? 'Host a table' : play === 'bot' ? 'Play vs bot' : 'Start game';
  $('setup-title').textContent = modeChange ? 'Change mode' : duo ? 'Two iPads' : play === 'bot' ? 'Solo vs bot' : 'Pass & play';
  $('btn-back').textContent = modeChange ? '\u2039 Cancel' : '\u2039 Back';
  if (modeChange) $('duo-tabs').classList.add('hidden');
  $('gap-value').textContent = settings.gap + ' mm';
  $('calib-value').textContent = settings.gap + ' mm';
  $('m-sound').textContent = 'Sound: ' + (settings.sound ? 'on' : 'off');
  $('m-diag').textContent = 'Diagnostics: ' + (settings.diag ? 'on' : 'off');
  syncNearby();
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
    if (key === 'conn') stopNearby(); // watch again on the newly chosen kind
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
$('btn-join-code').addEventListener('click', submitCode);
$('btn-wait-cancel').addEventListener('click', () => leaveTable('', settings.play === 'duo' ? 'setup' : 'play'));
$('btn-conn-leave').addEventListener('click', () => leaveTable('', 'play'));

// --- waiting screen ---------------------------------------------------------

let qrFor = '';
// The join link is this very page (query and hash dropped), so it also works
// from a sub-path such as https://user.github.io/two-ipad-air-hockey/. When the
// page was opened as localhost on the Node server the QR code would be useless
// on the other iPad, so there we swap in the server's LAN address.
let baseOverride = '';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
function joinBase() {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  return baseOverride ? baseOverride + u.pathname : u.href;
}
if (LOCAL_HOSTS.includes(location.hostname)) {
  probeServer().then((isServer) => {
    if (!isServer) return;
    fetch('/info')
      .then((r) => r.json())
      .then((info) => {
        if (info && Array.isArray(info.urls) && typeof info.urls[0] === 'string') {
          baseOverride = info.urls[0];
          qrFor = '';
          if (intent && !running) renderWait();
        }
      })
      .catch(() => {
        /* keep location.href */
      });
  });
}
function renderQr(code) {
  const base = joinBase();
  const key = code ? code + '|' + base + '|' + trKind : '';
  if (qrFor === key) return;
  qrFor = key;
  const url = code ? `${base}?join=${code}${trKind ? '&via=' + trKind : ''}` : '';
  $('wait-url').textContent = code ? base : '';
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
  const slow = !tableCode && connectStart && performance.now() - connectStart > 10000;
  const slowNote = slow ? ' Still trying. Direct play needs an internet connection to find the other iPad.' : '';
  $('wait-code').textContent = tableCode || '';
  $('wait-share').classList.toggle('hidden', !(host && tableCode));
  renderQr(host ? tableCode || '' : '');
  $('wait-kind').textContent = trKind === 'ws' ? 'Via this server' : trKind === 'p2p' ? 'Direct connection' : '';
  let title;
  let text = '';
  if (host) {
    title = 'Waiting for the other iPad';
    if (!tableCode) text = (netState === 'open' ? 'Opening a table…' : 'Connecting…') + slowNote;
    else if (netState === 'reconnecting') text = 'Reconnecting…';
    else text = 'Lay the iPads flat, top edge against top edge, in portrait.';
  } else {
    title = tableCode ? 'Joined table ' + tableCode : 'Looking for a table…';
    if (!tableCode) text = (intent.code ? 'Joining ' + intent.code + '…' : 'Looking for the table…') + slowNote;
    else if (netState === 'reconnecting') text = 'Reconnecting…';
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
  } else if (netState === 'reconnecting' || netState === 'closed') {
    show('Reconnecting…', 'Lost the connection. Trying again automatically.');
  } else if (resuming) {
    show('Reconnecting…', tableCode ? `Getting back to table ${tableCode}.` : 'Getting back to your table.');
  } else if (running && !peerPresent) {
    show('Other iPad disconnected', 'Waiting for it to come back. The game continues where it left off.');
  } else {
    overlay.classList.add('hidden');
  }
  if (!running) renderWait();
  syncAnnounce();
}

// --- networking -------------------------------------------------------------
//
// One transport object (./transport.js) carries everything. Its kind is picked
// per session: 'ws' when this page is served by our Node server, else 'p2p'.
// Reconnection, the heartbeat and the round-trip time live inside the
// transport; the game only reacts to onPeer / onState / onMessage.

const APP_ID = 'two-ipad-air-hockey';
/** Is this page served by our Node server? (GET /healthz answers JSON with `tables`.) */
function probeServer() {
  if (serverProbe) return serverProbe;
  serverProbe = (async () => {
    if (!/^https?:$/.test(location.protocol)) return false;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    try {
      const res = await fetch('/healthz', { cache: 'no-store', signal: ctl.signal });
      if (!res.ok) return false;
      const j = await res.json();
      return !!j && typeof j === 'object' && typeof j.tables === 'number';
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  })();
  return serverProbe;
}
probeServer(); // start early so 'Auto' never waits at the first tap

async function pickKind() {
  if (settings.conn === 'p2p') return 'p2p';
  if (settings.conn === 'ws') return 'ws';
  return (await probeServer()) ? 'ws' : 'p2p';
}

function makeTransport(kind) {
  const gen = ++trGen;
  const live = () => gen === trGen;
  trKind = kind;
  tr = createTransport({
    kind,
    appId: APP_ID,
    onMessage: (m) => live() && onMessage(m),
    onPeer: (ev) => live() && onPeer(ev),
    onState: (st) => live() && onTransportState(st),
    onNearby: (list) => live() && setNearby(list),
  });
  return tr;
}

function closeTransport() {
  trGen++;
  const t = tr;
  tr = null;
  trKind = null;
  netState = 'idle';
  watchingNearby = false;
  nearbyGen++;
  announceKey = '';
  if (t) {
    try {
      t.close();
    } catch {
      /* ignore */
    }
  }
  setNearby([]);
}

function sendNet(msg) {
  try {
    return !!tr && tr.send(msg) !== false;
  } catch {
    return false;
  }
}

function onTransportState(st) {
  netState = st;
  // While host() / join() is pending a 'closed' just precedes its rejection,
  // which carries the friendly message; afterwards it means the table is gone.
  if (st === 'closed' && intent && !connecting) {
    leaveTable((tr && tr.reason) || 'The table was closed.', running ? 'play' : 'setup');
    return;
  }
  updateOverlays();
}

// --- nearby tables ("Tables near you")

function nearbyWanted() {
  return (
    !intent &&
    !$('lobby').classList.contains('hidden') &&
    !$('screen-setup').classList.contains('hidden') &&
    settings.play === 'duo' &&
    settings.duoRole === 'join' &&
    !modeChange
  );
}

/** Start / stop watching to match what is on screen. Cheap to call often. */
async function syncNearby() {
  if (!nearbyWanted()) {
    if (watchingNearby) stopNearby(true);
    return;
  }
  if (watchingNearby) return;
  watchingNearby = true;
  const my = ++nearbyGen;
  const kind = await pickKind();
  if (my !== nearbyGen || !watchingNearby || intent) return;
  if (!tr || trKind !== kind) {
    closeTransport();
    makeTransport(kind);
    watchingNearby = true;
    nearbyGen = my;
  }
  try {
    tr.watchNearby(true);
  } catch {
    /* no nearby support: the list just stays empty */
  }
}

/** Stop watching. `release` also closes the table-less transport. */
function stopNearby(release) {
  watchingNearby = false;
  nearbyGen++;
  if (tr) {
    try {
      tr.watchNearby(false);
    } catch {
      /* ignore */
    }
    if (release && !intent) closeTransport();
  }
  setNearby([]);
}

function setNearby(list) {
  const seen = new Set();
  nearby = [];
  for (const e of Array.isArray(list) ? list : []) {
    const code = e && typeof e.code === 'string' ? e.code.trim().toUpperCase() : '';
    if (!/^[A-Z]{4}$/.test(code) || seen.has(code) || code === tableCode) continue;
    seen.add(code);
    nearby.push({ code, mode: MODES.includes(e.mode) ? e.mode : '', since: Number(e.since) || 0 });
  }
  nearby.sort((a, b) => b.since - a.since);
  renderNearby();
}

let nearbyShown = ''; // codes on screen, to scroll a newly found table into view once

function renderNearby() {
  const ul = $('nearby-list');
  ul.textContent = '';
  const has = nearby.length > 0;
  nearby.forEach((e, i) => {
    const li = document.createElement('li');
    // The whole card is the button: the one big thing to tap on this screen.
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nearby-cta' + (i === 0 ? ' nearby-first' : '');
    btn.setAttribute('aria-label', 'Join table ' + e.code + (e.mode ? ', ' + (MODE_NAMES[e.mode] || e.mode) : ''));
    const eyebrow = document.createElement('span');
    eyebrow.className = 'nearby-eyebrow';
    eyebrow.textContent = i === 0 ? 'An iPad near you is hosting' : 'Also nearby';
    const main = document.createElement('span');
    main.className = 'nearby-main';
    const code = document.createElement('span');
    code.className = 'nearby-code';
    code.textContent = e.code;
    const mode = document.createElement('span');
    mode.className = 'nearby-mode';
    mode.textContent = e.mode ? (MODE_NAMES[e.mode] || e.mode) + ' table' : 'table';
    main.append(code, mode);
    const go = document.createElement('span');
    go.className = 'nearby-go';
    go.textContent = 'Join';
    btn.append(eyebrow, main, go);
    btn.addEventListener('click', () => {
      unlockAudio();
      clearJoinError();
      startJoining(e.code);
    });
    li.append(btn);
    ul.append(li);
  });
  $('nearby-empty').classList.toggle('hidden', has);
  $('nearby-label').textContent = has ? 'Ready to join' : 'Tables near you';
  // Everything else on the screen steps back while a table is waiting.
  $('panel-join').classList.toggle('has-nearby', has);
  $('screen-setup').classList.toggle('nearby-ready', has);
  const key = nearby.map((n) => n.code).join(',');
  if (key !== nearbyShown) {
    nearbyShown = key;
    if (has && typeof ul.scrollIntoView === 'function') {
      try {
        ul.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch {
        /* older WebKit: no options object */
      }
    }
  }
}

/** Tell nearby iPads about our table while we are hosting and nobody has joined. */
function syncAnnounce() {
  if (!tr) return;
  const want = !!(intent && intent.role === 'host' && tableCode && !peerPresent);
  const mode = running && cfg ? cfg.mode : settings.mode;
  const key = want ? tableCode + '|' + mode : '';
  if (key === announceKey) return;
  announceKey = key;
  try {
    tr.announce(want ? { code: tableCode, mode, players: 'duo' } : null);
  } catch {
    /* ignore */
  }
}

// --- session

function startHosting() {
  beginSession('host', '');
  showScreen('wait');
  renderWait();
}

function startJoining(code, kind) {
  setStatus('');
  beginSession('guest', code, kind);
  showScreen('wait');
  renderWait();
}

function beginSession(sessionRole, code, kind) {
  stopGame();
  clearSession();
  stopNearby(false); // keep the transport if it is the right kind
  intent = { role: sessionRole, code: code || '', kind: kind || '' };
  tableCode = null;
  peerPresent = false;
  pendingPair = false;
  resuming = false;
  everPaired = false;
  calibDone = false;
  connectSession();
}

/** Open (or reuse) the transport and take the seat: host() or join(). */
async function connectSession() {
  const my = ++sessionGen;
  const wantRole = intent.role;
  const resume = resuming;
  const wanted = tableCode || intent.code || '';
  connectStart = performance.now();
  connecting = true;
  netState = 'connecting';
  updateOverlays();
  const kind = intent.kind || (await pickKind());
  if (my !== sessionGen || !intent) return;
  if (!tr || trKind !== kind) {
    closeTransport();
    makeTransport(kind);
  }
  netState = 'connecting';
  const t = tr;
  renderWait();
  try {
    let res;
    if (wantRole === 'host') res = await t.host(wanted || undefined);
    else if (wanted) res = await t.join(wanted, resume ? { rejoin: true } : undefined);
    else throw new Error('No table with that code');
    if (my !== sessionGen || t !== tr) return;
    connecting = false;
    tableReady(typeof res === 'string' && /^[A-Za-z]{4}$/.test(res) ? res.toUpperCase() : wanted);
  } catch (err) {
    if (my !== sessionGen || t !== tr) return;
    connecting = false;
    connectFailed(err, wantRole, wanted, resume);
  }
}

function tableReady(code) {
  tableCode = code;
  resuming = false;
  saveSession();
  if (tr && tr.peerPresent) {
    pendingPair = true;
    peerPresent = true;
  }
  if (pendingPair && peerPresent) {
    pendingPair = false;
    pairUp(false);
  }
  updateOverlays();
}

function connectFailed(err, wantRole, tried, resume) {
  const m = String((err && err.message) || err || '');
  const gone = /no table|not found|no longer/i.test(m);
  const full = /full/i.test(m);
  if (resume) {
    leaveTable(gone || full ? 'That table is gone. Host or join a new one.' : 'Could not get back to your table.', 'play');
    return;
  }
  if (wantRole === 'guest') {
    // Wrong or stale code: stay on the join form and say so in friendly words.
    let text;
    if (gone) text = tried ? `No table with code ${tried}. Check the code on the host iPad.` : 'No table found.';
    else if (full) text = 'That table already has two iPads.';
    else if (trKind === 'ws') text = 'Could not reach the server. Check that it is running and try again.';
    else text = 'Could not connect. Check your internet connection and try again.';
    leaveTable('', 'setup');
    settings.play = 'duo';
    settings.duoRole = 'join';
    refreshUI();
    showJoinError(text, tried);
    return;
  }
  leaveTable(
    trKind === 'ws'
      ? 'Could not reach the server. Check that it is running and try again.'
      : 'Could not open a table. Check your internet connection and try again.',
    'setup',
  );
}

function leaveTable(message, screen) {
  sessionGen++; // cancel a connection attempt that is still in flight
  connecting = false;
  trGen++; // and ignore anything the transport says while we leave
  if (tr && intent) {
    try {
      tr.announce(null);
      tr.leave();
    } catch {
      /* ignore */
    }
  }
  closeTransport();
  intent = null;
  tableCode = null;
  peerPresent = false;
  pendingPair = false;
  resuming = false;
  everPaired = false;
  modeChange = false;
  clearSession();
  stopGame();
  updateOverlays();
  showLobby(screen || 'play');
  setStatus(message || '');
}

/** The other iPad is (back) at the table. */
function onPeer(ev) {
  if (!intent) return;
  if (ev === 'left') {
    peerPresent = false;
    pendingPair = false;
    guestTs = null;
    setLatency(null);
    pointers.clear();
    updateOverlays();
    return;
  }
  if (ev !== 'joined' && ev !== 'rejoined') return;
  const was = peerPresent;
  peerPresent = true;
  if (!tableCode) {
    pendingPair = true; // host() / join() has not resolved yet
    return;
  }
  pairUp(was);
}

function pairUp(wasPresent) {
  guestTs = null;
  seqPrev = skPrev = -1; // a fresh connection: do not count the gap as drops
  if (!wasPresent) toast(everPaired ? 'Other iPad reconnected' : 'Other iPad connected');
  everPaired = true;
  if (intent.role === 'host') {
    if (sim && gamePlay === 'duo' && running) {
      sendNet({ t: 'config', cfg }); // resume, score intact
      calibSent = false; // re-announce the calibration ring if it is open
    } else startAsHost();
  }
  updateOverlays();
}

function onMessage(msg) {
  if (!intent || !msg) return;
  switch (msg.t) {
    case 'config':
      if (!msg.cfg || !Number.isFinite(msg.cfg.W) || !Number.isFinite(msg.cfg.H)) break;
      if (intent.role === 'guest') startAsGuest(msg.cfg);
      break;

    case 's': {
      const t = performance.now();
      noteArrival(msg, t); // jitter, seq gaps, history, replay buffer, goal detection
      dropPredictedHit(msg, t); // the host's copy of a hit we already showed
      if (rp.st !== 2) audio.onEvents(msg.ev || [], msg); // silent during an instant replay
      // Two snapshots between frames: carry the unrendered one's events over so
      // the view (which consumes events per snapshot object) still sees them.
      if (lastSnapshot && lastSnapshot !== lastRendered && lastSnapshot.ev && lastSnapshot.ev.length) {
        msg.ev = lastSnapshot.ev.concat(msg.ev || []).slice(-64);
      }
      lastSnapshot = msg;
      lastSnapshotAt = t;
      break;
    }

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

    case 'use': // guest tapped its item button (Battle mode)
      if (sim && intent.role === 'host' && typeof sim.useItem === 'function') sim.useItem('guest');
      break;

    case 'rpskip': // the other player tapped to skip the instant replay
      skipReplay(false);
      break;
  }
}

// Latency readout in the corner, from the transport's own ping/pong.
setInterval(() => {
  if (intent && !running) renderWait(); // refreshes the slow-connect hint
  if (!tr || !intent || !peerPresent || tr.rtt == null || !Number.isFinite(tr.rtt)) return setLatency(null);
  setLatency(Math.round(tr.rtt));
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
  const cfgOut = {
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
  if (cfgOut.mode === 'random') {
    // Dev aid: ?twist=<id> forces one twist (no lobby UI).
    let tw = null;
    try {
      tw = new URLSearchParams(location.search).get('twist');
    } catch (e) {
      tw = null;
    }
    if (tw && TWIST_IDS.includes(tw)) cfgOut.twist = tw;
  }
  return cfgOut;
}

function startAsHost() {
  cfg = buildCfg('duo');
  sim = createSim(cfg);
  role = 'host';
  gamePlay = 'duo';
  lastSnapshot = null;
  guestTs = null;
  calibSent = false;
  sendNet({ t: 'config', cfg });
  beginPlay();
}

function startAsGuest(c) {
  if (running && role === 'guest' && cfg) {
    if (JSON.stringify(cfg) === JSON.stringify(c)) {
      seqPrev = skPrev = -1; // resumed: the gap while away is not packet loss
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
  setLatency(gamePlay === 'duo' && tr && tr.rtt != null ? Math.round(tr.rtt) : null);
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
  sendNet({ t: 'config', cfg });
}

/** Show / hide the host's calibration bar and tell the guest to draw the ring. */
function syncCalib(ph) {
  if (role === 'host' && ph && ph !== 'ready') calibDone = true; // the match started: gap accepted, do not nag on rematches
  const want = role === 'host' && gamePlay === 'duo' && ph === 'ready' && !calibDone && !modeChange && peerPresent;
  $('calib').classList.toggle('hidden', !want);
  ui.calibrating = role === 'host' ? want : role === 'guest' ? calibRemote && ph === 'ready' : false;
  if (role === 'host' && tr && peerPresent && calibSent !== want) {
    if (sendNet({ t: 'calib', on: want ? 1 : 0 })) calibSent = want;
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
  sendNet({ t: 'restart' });
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
  if (peerPresent) sendNet({ t: 'config', cfg });
  beginPlay();
}

function startLocal(play) {
  stopGame();
  sessionGen++;
  connecting = false;
  closeTransport();
  intent = null;
  tableCode = null;
  peerPresent = false;
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
  replayReset();
  rbClear();
  resetDiag();
  resetGuestFeel();
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
  replayReset();
  rbClear();
  resetGuestFeel();
  ui.diag = null;
  modeChange = false;
  overShown = false;
  calibSent = false;
  ui.held = ui.calibrating = false;
  ui.btnPress = null;
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
  else if (tr) sendNet({ t: 'restart' });
  calibSent = false;
}

/** Does this device control `side`'s mallet (and item button)? */
function ownsSide(side) {
  if (gamePlay === 'pass') return true;
  if (gamePlay === 'bot') return side === 'host';
  return side === role;
}

/** Battle mode: fire the item `side` holds (the sim decides if it can). */
function useItem(side) {
  if (sim) {
    if (typeof sim.useItem === 'function') sim.useItem(side);
  } else if (tr && side === 'guest') {
    sendNet({ t: 'use' });
  }
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

  // A tap during the instant replay skips it (after a moment, so the last
  // frantic swipe at the puck does not cancel the replay by accident).
  if (rp.st === 2 && rp.el > 0.35) {
    skipReplay(true);
    return;
  }

  // After the final goal a tap starts a new match (ignore the first moments
  // so a frantic last swipe does not skip the result).
  if (ph === 'over') {
    if (performance.now() - overSince > 700) requestRestart();
    return;
  }

  // Battle mode: a touch that starts on a corner item button is a button
  // press, never a mallet (except in 'ready', where every touch is the ready
  // press). The sim decides whether anything happens.
  if (ph !== 'ready' && cfg && cfg.mode === 'battle' && typeof view.buttonAt === 'function') {
    const btn = view.buttonAt(e.clientX, e.clientY);
    if (btn && ownsSide(btn)) {
      ui.btnPress = { side: btn, t: performance.now() };
      useItem(btn);
      return;
    }
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
  if (role === 'guest') feedMal(wx, wy, evTime(e, performance.now()), true);
  moveMallet(side, wx, wy, true);

  // Pressing down on your own half is how you say "ready".
  if (ph === 'ready') {
    if (sim) {
      if (typeof sim.setReady === 'function') sim.setReady(side);
    } else if (tr) {
      sendNet({ t: 'ready' });
    }
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!running) return;
  const p = pointers.get(e.pointerId);
  if (!p) return;
  // Coalesced events carry every touch sample since the last event: the last one
  // is the freshest position, the last two give the mallet velocity.
  const co = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
  const n = co ? co.length : 0;
  const last = n ? co[n - 1] : e;
  const [wx, wy] = view.screenToWorld(last.clientX, last.clientY);
  p.x = wx;
  p.y = wy;
  if (role === 'guest') {
    const nowP = performance.now();
    if (n >= 2) {
      const [px, py] = view.screenToWorld(co[n - 2].clientX, co[n - 2].clientY);
      feedMal(px, py, evTime(co[n - 2], nowP), !mal.ok);
    }
    feedMal(wx, wy, evTime(last, nowP), false);
  }
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

// --- feel: diagnostics, instant replay, guest hit prediction ------------------------
//
// Guest view of the puck, per frame:
//   live        advancePuck(latest.p, age) with real friction and rail bounces,
//               never more than 120 ms past the snapshot (no linear extrapolation)
//   predicted   when the local mallet would touch the displayed puck within the
//               next frame, show predictMalletHit's result at once and keep
//               advancing it locally until the host catches up (see renderGuest)
//   replay      after a goal, the last ~2 s of snapshots at half speed (tickReplay)
// The view dedupes events by snapshot object and by shared p+m arrays, so a new
// host snapshot is handed to render() as the original object exactly once (its
// `ev` fires), and every later frame gets a shallow copy with a NEW `p` and
// `ev: []`.

const NO_EV = [];
const PRED_MS = 250; // a prediction lives at most this long without host confirmation
const MAX_MALLET_SPEED = 3200; // px/s, same cap as the sim

// ---- diagnostics (ring buffers and scalars only: nothing allocates per frame) ----

const diag = { fps: 0, frameMs: 0, rtt: null, jitter: 0, kind: 'local', seq: 0, drops: 0 };
const FPS_CAP = 512;
const fpsTs = new Float64Array(FPS_CAP);
let fpsHead = 0;
let fpsCount = 0;
const FT_N = 60;
const frameDts = new Float32Array(FT_N);
let ftIdx = 0;
let ftCount = 0;
const arrIv = new Float32Array(60); // guest: snapshot inter-arrival times (ms)
let arrIdx = 0;
let arrCount = 0;
let lastArrival = 0;
let diagAt = 0;
let seqPrev = -1;
let skPrev = -1;
let rateSkips = 0; // host: frames not sent on purpose (rate limit)
const hist = [null, null, null, null]; // guest: last 4 snapshots...
const histAt = new Float64Array(4); // ...and when they arrived
let histN = 0;

function resetDiag() {
  fpsHead = fpsCount = ftIdx = ftCount = arrIdx = arrCount = 0;
  lastArrival = 0;
  diagAt = 0;
  seqPrev = skPrev = -1;
  rateSkips = 0;
  histN = 0;
  hist.fill(null);
  diag.drops = 0;
  diag.seq = 0;
}

function stdev(arr, n) {
  if (n < 2) return 0;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    sum += arr[i];
    sq += arr[i] * arr[i];
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

function diagFrame(now, rawMs, seq) {
  fpsTs[fpsHead] = now;
  fpsHead = (fpsHead + 1) % FPS_CAP;
  if (fpsCount < FPS_CAP) fpsCount++;
  while (fpsCount > 1 && now - fpsTs[(fpsHead - fpsCount + FPS_CAP) % FPS_CAP] > 1000) fpsCount--;
  if (rawMs > 0) {
    frameDts[ftIdx] = Math.min(250, rawMs);
    ftIdx = (ftIdx + 1) % FT_N;
    if (ftCount < FT_N) ftCount++;
  }
  if (!settings.diag) {
    ui.diag = null;
    return;
  }
  diag.seq = seq | 0;
  if (now - diagAt >= 250) {
    diagAt = now;
    diag.fps = fpsCount;
    let sum = 0;
    for (let i = 0; i < ftCount; i++) sum += frameDts[i];
    diag.frameMs = ftCount ? sum / ftCount : 0;
    diag.jitter = role === 'guest' ? stdev(arrIv, arrCount) : stdev(frameDts, ftCount);
    diag.rtt = tr && peerPresent && tr.rtt != null && Number.isFinite(tr.rtt) ? tr.rtt : null;
    diag.kind = gamePlay === 'duo' ? trKind || 'p2p' : 'local';
  }
  ui.diag = diag;
}

/** Guest, per received snapshot: jitter, seq gaps, history, replay buffer, goals. */
function noteArrival(msg, t) {
  if (lastArrival > 0) {
    const iv = t - lastArrival;
    if (iv < 2000) {
      arrIv[arrIdx] = iv;
      arrIdx = (arrIdx + 1) % arrIv.length;
      if (arrCount < arrIv.length) arrCount++;
    }
  }
  lastArrival = t;
  if (typeof msg.seq === 'number') {
    const sk = typeof msg.sk === 'number' ? msg.sk : 0;
    if (seqPrev >= 0 && msg.seq > seqPrev + 1) {
      const intended = skPrev >= 0 ? Math.max(0, sk - skPrev) : 0;
      diag.drops += Math.max(0, msg.seq - seqPrev - 1 - intended);
    }
    seqPrev = msg.seq;
    skPrev = sk;
  }
  hist[histN & 3] = msg;
  histAt[histN & 3] = t;
  histN++;
  rbPush(msg);
  noteGoal(msg);
}

// ---- instant replay ----------------------------------------------------------------
//
// A ring buffer keeps the last ~3.6 s of snapshots (host: its own sim.snapshot()
// results; guest: the received ones), keyed by sim time `ts`, so the replay is
// smooth whatever the network jitter. When a 'goal' event is seen and the match
// is not over, wait RP_WAIT s (the goal flash), then play [goal - 2.0 s,
// goal + 0.2 s] at half speed: 4.4 s of real time. The host / solo sim is frozen
// while it plays (the 1.6 s goal pause + 1 s serve countdown resume afterwards),
// which also stops snapshots from changing for the guest.

const RB_CAP = 640;
const RB_KEEP_S = 3.6;
const RP_WAIT = 0.9;
const RP_PRE = 2.0;
const RP_POST = 0.2;
const RP_SPEED = 0.5;
const rbSnap = new Array(RB_CAP).fill(null);
const rbTs = new Float64Array(RB_CAP);
let rbHead = 0;
let rbCount = 0;
// st: 0 idle, 1 waiting for the goal flash, 2 playing
const rp = { st: 0, wait: 0, goalTs: 0, clip: null, gi: 0, hold: null, sc: 0, k: 0, t0: 0, dur: 0, el: 0 };
// rp.sc: which puck scored, 0 = p, 1 = p2 (Twin Puck). That one gets rp.hold.
const replayUi = { t: 0, speed: RP_SPEED, el: 0 }; // el: seconds played (the view fades in 'tap to skip')

function rbClear() {
  rbSnap.fill(null);
  rbHead = rbCount = 0;
}
const rbIdx = (i) => (rbHead - rbCount + i + RB_CAP) % RB_CAP;

function rbPush(snap) {
  const ts = snap.ts;
  if (!Number.isFinite(ts)) return;
  if (rbCount) {
    const last = rbTs[(rbHead - 1 + RB_CAP) % RB_CAP];
    if (ts === last) return; // frozen host: the same moment again
    if (ts < last - 0.5) rbClear(); // a fresh sim restarted the clock
  }
  rbSnap[rbHead] = snap;
  rbTs[rbHead] = ts;
  rbHead = (rbHead + 1) % RB_CAP;
  if (rbCount < RB_CAP) rbCount++;
  while (rbCount > 1) {
    const ti = rbIdx(0);
    if (ts - rbTs[ti] <= RB_KEEP_S) break;
    rbSnap[ti] = null;
    rbCount--;
  }
}

function replayReset() {
  rp.st = 0;
  rp.clip = null;
  rp.hold = null;
  ui.replay = null;
}

/**
 * End the replay now on this iPad and, when `tell`, on the other one too, so the
 * serve resumes at the same moment on both. (The host sim is frozen while a
 * replay plays; the guest follows the host's snapshots once it stops.)
 */
function skipReplay(tell) {
  if (rp.st === 0) return;
  replayReset();
  if (tell && tr && intent && peerPresent) sendNet({ t: 'rpskip' });
}

/** Look at a freshly produced / received snapshot for a goal that deserves a replay. */
function noteGoal(snap) {
  if (rp.st !== 0 || snap.ph === 'over') return;
  const ev = snap.ev;
  if (!ev || !ev.length) return;
  for (let i = 0; i < ev.length; i++) {
    if (ev[i] && ev[i].k === 'goal') {
      rp.st = 1;
      rp.wait = RP_WAIT;
      rp.goalTs = snap.ts;
      return;
    }
  }
}

/** Cut [goal - 2 s, goal + 0.2 s] out of the ring buffer (null when too little is there). */
function buildClip(goalTs) {
  let gi = -1;
  for (let i = rbCount - 1; i >= 0; i--) {
    if (rbTs[rbIdx(i)] <= goalTs + 1e-6) {
      gi = i;
      break;
    }
  }
  if (gi < 1) return null;
  // Start at the oldest snapshot of the unbroken stretch of 'play' before the goal.
  let s = gi;
  while (s > 0 && rbTs[rbIdx(s - 1)] >= goalTs - RP_PRE && rbSnap[rbIdx(s - 1)].ph === 'play') s--;
  if (s >= gi) return null;
  let e = gi;
  while (e + 1 < rbCount && rbTs[rbIdx(e + 1)] <= goalTs + RP_POST) e++;
  const clip = [];
  for (let i = s; i <= e; i++) clip.push(rbSnap[rbIdx(i)]);
  if (clip.length < 3) return null;
  return { clip, gi: gi - s, sc: scoringPuck(rbSnap[rbIdx(gi)], rbSnap[rbIdx(gi - 1)]) };
}

/**
 * Which puck went in: 0 = p, 1 = p2 (Twin Puck). `gs` is the snapshot with the
 * goal event, `pre` the one before it. The puck closer to the event's x, y wins;
 * without an event position, the one nearer the scored-on goal line.
 */
function scoringPuck(gs, pre) {
  const p = pre.p;
  const p2 = pre.p2;
  if (!p2 || !p) return 0;
  const ev = gs && gs.ev;
  let gx = NaN;
  let gy = NaN;
  let by = '';
  if (ev) {
    for (let i = 0; i < ev.length; i++) {
      if (ev[i] && ev[i].k === 'goal') {
        gx = ev[i].x;
        gy = ev[i].y;
        by = ev[i].by || '';
        break;
      }
    }
  }
  if (Number.isFinite(gx) && Number.isFinite(gy)) {
    return Math.hypot(p2[0] - gx, p2[1] - gy) < Math.hypot(p[0] - gx, p[1] - gy) ? 1 : 0;
  }
  const bottom = 2 * cfg.H + (cfg.G || 0);
  // The host scoring means the puck went into the guest goal (y = 0), and back.
  const lineDist = (q) => (by === 'host' ? q[1] : by === 'guest' ? bottom - q[1] : Math.min(q[1], bottom - q[1]));
  return lineDist(p2) < lineDist(p) ? 1 : 0;
}

/**
 * Advance the replay state machine by dt and return the snapshot copy to draw
 * while a replay is playing, else null. `livePhase` is the live phase: a
 * restart or rematch cancels the replay.
 */
function tickReplay(dt, livePhase) {
  if (rp.st === 0) return null;
  if (livePhase !== 'goal' && livePhase !== 'play') {
    replayReset();
    return null;
  }
  if (rp.st === 1) {
    if (!paused) rp.wait -= dt;
    if (rp.wait > 0) return null;
    const c = buildClip(rp.goalTs);
    if (!c) {
      replayReset();
      return null;
    }
    rp.clip = c.clip;
    rp.gi = c.gi;
    rp.sc = c.sc;
    const pre = c.clip[Math.max(0, c.gi - 1)];
    const last = (c.sc === 1 && pre.p2) || pre.p;
    rp.hold = [last[0], last[1], 0, 0]; // the puck that scored stays in the net
    rp.t0 = c.clip[0].ts;
    rp.dur = c.clip[c.clip.length - 1].ts - rp.t0;
    rp.k = 0;
    rp.el = 0;
    if (!(rp.dur > 0.2)) {
      replayReset();
      return null;
    }
    rp.st = 2;
    pred.active = false;
  } else if (!paused) {
    rp.el += dt;
  }
  const media = rp.t0 + rp.el * RP_SPEED;
  if (media >= rp.t0 + rp.dur) {
    replayReset();
    return null;
  }
  replayUi.t = (rp.el * RP_SPEED) / rp.dur;
  replayUi.el = rp.el;
  return replayFrame(media);
}

/** A copy of the buffered snapshots around `media` with NEW p / m arrays and no events. */
function replayFrame(media) {
  const clip = rp.clip;
  const n = clip.length;
  let k = rp.k;
  while (k < n - 2 && clip[k + 1].ts <= media) k++;
  rp.k = k;
  const a = clip[k];
  const b = clip[k + 1];
  const span = b.ts - a.ts;
  const f = span > 1e-6 ? clamp((media - a.ts) / span, 0, 1) : 0;
  const gi = rp.gi;
  // The puck that scored freezes in the net from the goal on; the other one
  // (Twin Puck) just follows the clip.
  const hp = rp.sc === 0;
  const pa = hp && k >= gi ? rp.hold : a.p;
  const pb = hp && k + 1 >= gi ? rp.hold : b.p;
  const p = lerpPuck(pa, pb, f);
  // p2 only when both ends of the pair have one (a scored p2 stays held in the
  // net even if the snapshots after the goal no longer carry it).
  const qa = !hp && k >= gi ? rp.hold : a.p2;
  const qb = !hp && k + 1 >= gi ? rp.hold : b.p2;
  const p2 = qa && qb ? lerpPuck(qa, qb, f) : null;
  const ma = a.m;
  const mb = b.m;
  const m = [ma[0], ma[1], ma[2], ma[3]];
  if (Math.hypot(mb[0] - ma[0], mb[1] - ma[1]) < cfg.W * 0.5 && Math.hypot(mb[2] - ma[2], mb[3] - ma[3]) < cfg.W * 0.5) {
    for (let i = 0; i < 4; i++) m[i] = ma[i] + (mb[i] - ma[i]) * f;
  }
  const out = { ...a, p, m, ev: NO_EV };
  if (p2) out.p2 = p2;
  else if (out.p2) delete out.p2; // only one side of the pair has it: drop it
  return out;
}

/** A NEW [x, y, vx, vy] between pa and pb at f (pa itself across a jump). */
function lerpPuck(pa, pb, f) {
  const p = [pa[0], pa[1], pa[2], pa[3]];
  if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) < cfg.W * 0.5) {
    for (let i = 0; i < 4; i++) p[i] = pa[i] + (pb[i] - pa[i]) * f;
  }
  return p;
}

// ---- guest hit prediction ------------------------------------------------------------

const pred = { active: false, p: null, t0: 0, seq0: 0, v0x: 0, v0y: 0, hitAt: -1e9 };
const suppress = []; // predicted hits whose host copy has not arrived yet: {x, y, t}
const mal = { x: 0, y: 0, vx: 0, vy: 0, t: 0, ok: false }; // guest finger as a mallet (world px, px/s)
const predSnap = { p: null, g: 0, gw: null, pr: 0, gx: null, tx: null, tw: '' }; // scratch argument of predictMalletHit
const predMallet = { x: 0, y: 0, vx: 0, vy: 0 };
const predCfg = {}; // cfg with the guest's current mallet radius (Battle shrink)
const localM = { x: 0, y: 0 };
const predStats = { hits: 0, suppressed: 0, confirmed: 0, timeouts: 0 }; // for window.__dbg()

function resetGuestFeel() {
  pred.active = false;
  pred.p = null;
  pred.hitAt = -1e9;
  suppress.length = 0;
  mal.ok = false;
  mal.vx = mal.vy = 0;
}

/** The guest mallet's current radius: smaller while a Battle shrink runs. */
function guestMalletR() {
  const bt = lastSnapshot && lastSnapshot.bt;
  const mr = bt && bt.mr ? bt.mr[1] : 0;
  return mr > 0 ? mr : cfg.malletR;
}

/** Side rail inset of the latest snapshot (Shrinking Rink), else 0. */
function guestInset() {
  const s = lastSnapshot;
  if (s && s.tw === 'shrinking' && s.tx && s.tx.in > 0) return s.tx.in;
  return 0;
}

/** Feed the local mallet model one finger sample (world coordinates), clamped like the sim. */
function feedMal(wx, wy, t, jump) {
  const rr = guestMalletR();
  const inset = guestInset();
  const x = clamp(wx, inset + rr, cfg.W - inset - rr);
  const y = clamp(wy, rr, cfg.H - rr);
  if (!jump && mal.ok) {
    const dtS = clamp((t - mal.t) / 1000, 0.004, 0.05);
    let vx = (x - mal.x) / dtS;
    let vy = (y - mal.y) / dtS;
    const sp = Math.hypot(vx, vy);
    if (sp > MAX_MALLET_SPEED) {
      vx *= MAX_MALLET_SPEED / sp;
      vy *= MAX_MALLET_SPEED / sp;
    }
    mal.vx = mal.vx * 0.5 + vx * 0.5; // same smoothing as the sim's setMallet
    mal.vy = mal.vy * 0.5 + vy * 0.5;
  } else {
    mal.vx = mal.vy = 0;
  }
  mal.x = x;
  mal.y = y;
  mal.t = t;
  mal.ok = true;
}

/** Event timestamp on the performance.now() clock (falls back for odd values). */
function evTime(e, nowPerf) {
  const t = e.timeStamp;
  return Number.isFinite(t) && Math.abs(t - nowPerf) < 5000 ? t : nowPerf;
}

/** Remove from an arriving snapshot the 'hit' event we already showed locally. */
function dropPredictedHit(msg, t) {
  if (!suppress.length) return;
  for (let i = suppress.length - 1; i >= 0; i--) if (t - suppress[i].t > PRED_MS) suppress.splice(i, 1);
  const ev = msg.ev;
  if (!suppress.length || !ev || !ev.length || !cfg) return;
  const lim = 2 * cfg.puckR;
  let kept = null;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    let dup = false;
    if (e && e.k === 'hit') {
      for (let j = 0; j < suppress.length; j++) {
        if (Math.hypot(e.x - suppress[j].x, e.y - suppress[j].y) <= lim) {
          suppress.splice(j, 1); // one host hit cancels one predicted hit
          predStats.suppressed++;
          dup = true;
          break;
        }
      }
    }
    if (dup && !kept) kept = ev.slice(0, i);
    else if (!dup && kept) kept.push(e);
  }
  if (kept) msg.ev = kept;
}

/** Is the host's puck close enough to ours (and past the hit) to hand control back? */
function predConfirmed(auth) {
  const pp = pred.p;
  if (Math.hypot(auth[0] - pp[0], auth[1] - pp[1]) > 2 * cfg.puckR) return false;
  // A snapshot made before the host saw the hit still has the old velocity.
  const dvTot = Math.hypot(pp[2] - pred.v0x, pp[3] - pred.v0y);
  if (dvTot > 150 && Math.hypot(auth[2] - pred.v0x, auth[3] - pred.v0y) < 0.25 * dvTot) return false;
  return true;
}

function hasGlitch(ev) {
  if (!ev) return false;
  for (let i = 0; i < ev.length; i++) if (ev[i] && ev[i].k === 'glitch') return true;
  return false;
}

const gDk = []; // scratch: the guest's displayed decoys
const gDkE = [
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
]; // scratch entries of gDk (the view draws at most 4)

/**
 * Push the second puck (Twin Puck) and moving decoys (Battle) of the displayed
 * copy `disp` forward by ageS, like the main puck. Decoys with only x, y stay put.
 */
function advanceExtras(disp, latest, ageS) {
  if (latest.p2) disp.p2 = advancePuck(latest.p2, cfg, ageS, latest);
  const dk = latest.dk;
  if (!dk || !dk.length) return;
  const n = Math.min(dk.length, gDkE.length);
  gDk.length = n;
  for (let i = 0; i < n; i++) {
    const d = dk[i];
    if (d && d.length >= 4) {
      const q = advancePuck(d, cfg, ageS, latest);
      const e = gDkE[i];
      e[0] = q[0];
      e[1] = q[1];
      e[2] = q[2];
      e[3] = q[3];
      gDk[i] = e;
    } else {
      gDk[i] = d;
    }
  }
  disp.dk = gDk;
}

function renderGuest(latest, now, dt) {
  const first = latest !== lastRendered; // a snapshot the view has not seen yet
  const playing = latest.ph === 'play';

  const rpSnap = tickReplay(dt, latest.ph);
  if (rpSnap) {
    ui.replay = replayUi;
    ui.predicted = false;
    view.render(rpSnap, 0, now, null, ui); // not lastRendered: events of live snapshots are carried over
    return;
  }
  ui.replay = null;

  // The local mallet: the clamped finger while one is down.
  let hasLocal = false;
  const rr = guestMalletR();
  const inset = guestInset();
  for (const p of pointers.values()) {
    localM.x = clamp(p.x, inset + rr, cfg.W - inset - rr);
    localM.y = clamp(p.y, rr, cfg.H - rr);
    hasLocal = true;
    break;
  }
  const k = Math.pow(0.001, dt); // finger velocity decays between samples, like in the sim
  mal.vx *= k;
  mal.vy *= k;

  if (!playing) {
    pred.active = false;
    ui.predicted = false;
    view.render(latest, 0, now, hasLocal ? localM : null, ui);
    lastRendered = latest;
    return;
  }

  const ageS = Math.min(0.12, (now - lastSnapshotAt) / 1000);

  // 1. Has the host caught up with a predicted hit? (A glitch jump reported in
  //    this snapshot makes any prediction moot: show the host's puck at once.)
  let auth = null;
  if (pred.active && first && hasGlitch(latest.ev)) pred.active = false;
  if (pred.active) {
    if (now - pred.t0 >= PRED_MS) {
      pred.active = false;
      predStats.timeouts++;
    } else if (first && latest.seq > pred.seq0) {
      auth = advancePuck(latest.p, cfg, ageS, latest);
      if (predConfirmed(auth)) {
        pred.active = false;
        predStats.confirmed++;
      }
    }
  }

  // 2. The puck as it is shown right now.
  let bp;
  if (pred.active) bp = pred.p = advancePuck(pred.p, cfg, dt, latest);
  else bp = auth || advancePuck(latest.p, cfg, ageS, latest);

  // 3. Would the local mallet hit it within the next frame? (Not a frozen puck:
  //    the host ignores mallets while a Battle freeze runs.)
  let hitEv = null;
  // No prediction for a frozen puck (the host ignores mallets) or an armed
  // rocket (the host's hit will be much faster than the prediction).
  const bt = latest.bt;
  const noPred = !!(
    bt &&
    (bt.fz > 0 ||
      (bt.rk && bt.rk[1]) ||
      (bt.ca && bt.ca[1]) ||
      (bt.ct && (bt.ct[0] > 0 || bt.ct[1] > 0)) ||
      (bt.qk && bt.qk[1] > 0))
  );
  // Quake shakes the guest mallet on the host; a catch hold parks the puck in
  // front of the host's copy of it. Either way the finger runs ahead of what
  // the host has, so draw the host's mallet instead of the local one.
  const quaking = !!(bt && ((bt.qk && bt.qk[1] > 0) || (bt.ct && bt.ct[1] > 0)));
  if (hasLocal && !noPred) {
    predMallet.x = localM.x;
    predMallet.y = localM.y;
    predMallet.vx = mal.vx;
    predMallet.vy = mal.vy;
    predSnap.p = bp;
    predSnap.g = latest.g;
    predSnap.gw = latest.gw;
    predSnap.pr = latest.pr;
    predSnap.gx = latest.gx;
    predSnap.tx = latest.tx;
    predSnap.tw = latest.tw;
    // A shrunk guest mallet (Battle) predicts with its current radius.
    let pc = cfg;
    const mr = latest.bt && latest.bt.mr ? latest.bt.mr[1] : 0;
    if (mr > 0 && Math.abs(mr - cfg.malletR) > 0.5) {
      Object.assign(predCfg, cfg);
      predCfg.malletR = mr;
      pc = predCfg;
    }
    const hit = predictMalletHit(predSnap, pc, 'guest', predMallet, clamp(dt, 0.008, 0.034));
    if (hit) {
      const dv = Math.hypot(hit[2] - bp[2], hit[3] - bp[3]);
      if (!pred.active) {
        pred.v0x = bp[2];
        pred.v0y = bp[3];
      }
      pred.active = true;
      pred.p = hit;
      pred.t0 = now;
      pred.seq0 = latest.seq;
      bp = hit;
      // Strength like the sim's: approach speed along the normal over 2000 px/s.
      const s = Math.min(1, dv / ((1 + physOf(cfg.mode).mallet) * 2000));
      if (s > 0.03 && now - pred.hitAt > 80) {
        let nx = hit[0] - predMallet.x;
        let ny = hit[1] - predMallet.y;
        const d = Math.hypot(nx, ny) || 1;
        nx /= d;
        ny /= d;
        const hx = Math.round((hit[0] - nx * cfg.puckR) * 10) / 10;
        const hy = Math.round((hit[1] - ny * cfg.puckR) * 10) / 10;
        hitEv = { k: 'hit', x: hx, y: hy, s: Math.round(s * 100) / 100 };
        pred.hitAt = now;
        predStats.hits++;
        suppress.push({ x: hx, y: hy, t: now });
        if (suppress.length > 4) suppress.shift();
        audio.onEvents([hitEv], latest);
      }
    }
  }

  // 4. What to hand to the view.
  let disp;
  if (pred.active) {
    const ev0 = first && latest.ev ? latest.ev : NO_EV;
    disp = { ...latest, p: bp, ev: hitEv ? ev0.concat(hitEv) : ev0 };
    advanceExtras(disp, latest, ageS);
  } else if (first) {
    disp = latest; // the original object, once: its events fire exactly once (p2 / dk stay raw)
  } else {
    disp = { ...latest, p: bp, ev: NO_EV };
    advanceExtras(disp, latest, ageS);
  }
  ui.predicted = pred.active;
  view.render(disp, 0, now, hasLocal && !quaking ? localM : null, ui);
  lastRendered = latest;
}

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
  const rawMs = now - lastFrame;
  const dt = Math.min(0.05, Math.max(0, rawMs / 1000));
  lastFrame = now;

  try {
    if (sim) {
      // Host (duo) or local sim (bot / pass).
      // Instant replay: while it plays the sim is frozen (so the serve waits for
      // the end of the replay) and only the replay is drawn.
      const rpSnap = tickReplay(dt, sim.state.phase);
      const frozen = paused || (role === 'host' && !peerPresent) || !!rpSnap;
      if (!frozen) sim.step(dt, now);
      const snap = sim.snapshot();
      lastSnapshot = snap;
      if (!rpSnap) audio.onEvents(snap.ev || [], snap);
      trackPhase(snap.ph, now);
      if (!frozen) rbPush(snap);
      if (!rpSnap) noteGoal(snap);

      if (role === 'host') {
        if (snap.ev && snap.ev.length) {
          pendingEv.push(...snap.ev);
          if (pendingEv.length > 200) pendingEv.splice(0, pendingEv.length - 200);
        }
        if (!peerPresent) {
          pendingEv = [];
        } else if (now - lastSend < 15) {
          rateSkips++; // 120 Hz display: every other frame is skipped on purpose
        } else if ((tr.bufferedAmount || 0) < 64 * 1024) {
          // Stream at ~60 Hz even on 120 Hz displays, without dropping events.
          // `sk` = frames skipped on purpose so far: the guest subtracts them
          // from the seq gaps it counts as drops.
          sendNet({ ...snap, ev: pendingEv, sk: rateSkips });
          pendingEv = [];
          lastSend = now;
        }
      }
      ui.held = pointers.size > 0;
      ui.predicted = false;
      ui.replay = rpSnap ? replayUi : null;
      syncCalib(snap.ph);
      syncOver(snap.ph, now);
      diagFrame(now, rawMs, snap.seq);
      view.render(rpSnap || snap, 0, now, null, ui);
    } else {
      // Guest.
      if (pendingInput && tr && now - lastInputSend >= 15) {
        const msg = { t: 'input', x: pendingInput.x, y: pendingInput.y, ts: pendingInput.ts };
        if (pendingInput.j) msg.j = 1;
        sendNet(msg);
        pendingInput = null;
        lastInputSend = now;
      }
      if (lastSnapshot) {
        trackPhase(lastSnapshot.ph, now);
        ui.held = pointers.size > 0;
        syncCalib(lastSnapshot.ph);
        syncOver(lastSnapshot.ph, now);
        diagFrame(now, rawMs, lastSnapshot.seq);
        renderGuest(lastSnapshot, now, dt);
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
  $('m-diag').textContent = 'Diagnostics: ' + (settings.diag ? 'on' : 'off');
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
$('m-diag').addEventListener('click', () => {
  settings.diag = !settings.diag;
  saveSettings();
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
  if (running) requestWakeLock();
  if (tr && typeof tr.nudge === 'function') tr.nudge(); // optional: reconnect right away
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
    const via = params.get('via');
    startJoining(joinCode, via === 'p2p' || via === 'ws' ? via : '');
    return;
  }
  if (params.has('join')) history.replaceState(null, '', location.pathname);

  const session = loadSession();
  if (session) {
    // The page was reloaded (or the iPad slept) while seated at a table.
    intent = { role: session.role, code: session.code, kind: session.kind };
    tableCode = session.code;
    resuming = true;
    connectSession();
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
  feel: {
    replay: { st: rp.st, wait: rp.wait, el: rp.el, dur: rp.dur, clip: rp.clip ? rp.clip.length : 0, buffered: rbCount },
    pred: { active: pred.active, suppress: suppress.length, ...predStats },
    diag: { ...diag },
    hist: histN,
  },
  pointers: [...pointers].map(([id, p]) => ({ id, side: p.side, x: p.x, y: p.y })),
  net: {
    kind: tr ? tr.kind || trKind : null,
    state: tr ? tr.state : netState,
    rtt: tr && tr.rtt != null ? Math.round(tr.rtt) : null,
    code: tr ? tr.code || tableCode : tableCode,
    intent: intent && { ...intent },
    peerPresent,
    transportPeer: tr ? !!tr.peerPresent : null,
    resuming,
    setting: settings.conn,
    nearby: nearby.map((n) => ({ ...n })),
  },
});

// --- offline / home-screen support ------------------------------------------
// Service workers need a secure context: https, or localhost for development.
if (
  'serviceWorker' in navigator &&
  (location.protocol === 'https:' || LOCAL_HOSTS.includes(location.hostname))
) {
  const registerSw = () =>
    navigator.serviceWorker
      .register('sw.js')
      .then((reg) => reg.update())
      .catch(() => {
        /* offline support is optional */
      });
  if (document.readyState === 'complete') registerSw();
  else window.addEventListener('load', registerSw);
}
