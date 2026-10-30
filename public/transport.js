// Transport for the two-iPad air hockey game.
//
//   const t = createTransport({ kind: 'p2p' | 'ws', appId, onMessage, onPeer, onState, onNearby });
//
// kind 'p2p': WebRTC data channel between the two iPads, signalled through
//   public Nostr relays with the vendored Trystero library. No server of our
//   own: the page can be plain static files.
// kind 'ws':  the Node pairing/relay server on location.host (server.js).
//
// Both kinds expose the same object:
//   { kind, host(code?) -> Promise<code>, join(code) -> Promise<void>,
//     leave(), close(), send(msg) -> boolean, watchNearby(on), announce(info|null),
//     get state, get code, get rtt, get peerPresent }
//
// Callbacks (never allowed to throw into the transport):
//   onMessage(msg)      game messages, exactly as sent ({t:...}); internal
//                       messages (t starting with '_', and the handshake) never arrive here
//   onPeer(ev)          'joined' | 'left' | 'rejoined'
//   onState(s)          'connecting' | 'open' | 'reconnecting' | 'closed'
//   onNearby(list)      [{code, mode, players, since, ...}] hosts announcing on the same network
//
// Nearby discovery works with either kind: devices behind the same public IP
// meet in a Trystero room named after a hash of that IP and swap announcements.

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O
const DEFAULT_APP_ID = 'two-ipad-air-hockey';

// Public Nostr relays, all verified to accept connections. Trystero uses every
// URL given, so keep the list short: one live relay is enough to meet.
const RELAYS = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://0x-nostr-relay.fly.dev',
  'wss://cdn.satellite.earth',
];
const STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

const PING_MS = 2000; // RTT probe interval
const STALE_MS = 5000; // no traffic from the peer for this long = treat as gone
const REPLACE_MS = 3500; // a guest silent this long may be replaced by a new one
const JOIN_TIMEOUT_MS = 8000; // no host answering in the room
const HELLO_RETRY_MS = 2000;
const ANNOUNCE_MS = 3000;
const NEAR_TTL_MS = 10000;
const REBUILD_BACKOFF_MS = [4000, 8000, 15000, 30000];
const RELAY_DEAD_MS = 4000; // relays all down this long (and no peer) = 'reconnecting'

const noop = () => {};

function safe(fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    fn(...args);
  } catch {
    /* a callback must never break the transport */
  }
}

function makeCode() {
  let code = '';
  const bytes = new Uint8Array(4);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < 4; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < 4; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
}

function normCode(code) {
  return String(code == null ? '' : code).trim().toUpperCase();
}

/** 32-bit FNV-1a, base 36. Good enough to name a room after an IP address. */
export function simpleHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// --- vendored Trystero (loaded on demand) -----------------------------------

let trysteroPromise = null;
function loadTrystero() {
  if (!trysteroPromise) {
    trysteroPromise = import('./vendor/trystero.js').catch((e) => {
      trysteroPromise = null;
      throw e;
    });
  }
  return trysteroPromise;
}

function roomConfig(appId, relays) {
  return {
    appId,
    relayConfig: { urls: relays && relays.length ? relays : RELAYS, warnOnRelayFailure: false },
    rtcConfig: { iceServers: [{ urls: STUN }] },
  };
}

/** Number of the given relays whose socket is currently open. */
function openRelays(T, urls) {
  try {
    const want = new Set((urls && urls.length ? urls : RELAYS).map((u) => u.replace(/\/+$/, '')));
    let n = 0;
    for (const [key, s] of Object.entries(T.getRelaySockets())) {
      const url = String((s && s.url) || key).replace(/\/+$/, '');
      if (s && s.readyState === 1 && want.has(url)) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

// --- public IP -> nearby key --------------------------------------------------

let ipKey = null; // string once resolved
let ipFailedAt = 0;
let ipPending = null;

async function fetchWithTimeout(url, ms) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl && ctl.abort(), ms);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    if (!res.ok) throw new Error('http ' + res.status);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function validIp(s) {
  return typeof s === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(s) && /[.:]/.test(s);
}

/** Resolves to the nearby hash, or null when the public IP cannot be learned. */
function nearbyKey() {
  if (ipKey) return Promise.resolve(ipKey);
  if (ipPending) return ipPending;
  if (ipFailedAt && Date.now() - ipFailedAt < 30000) return Promise.resolve(null);
  ipPending = (async () => {
    let ip = null;
    try {
      const res = await fetchWithTimeout('https://api.ipify.org?format=json', 4000);
      const j = await res.json();
      if (validIp(j && j.ip)) ip = j.ip;
    } catch {
      /* fall through to the second service */
    }
    if (!ip) {
      try {
        const res = await fetchWithTimeout('https://icanhazip.com', 4000);
        const text = (await res.text()).trim();
        if (validIp(text)) ip = text;
      } catch {
        /* nearby simply stays unavailable */
      }
    }
    if (ip) {
      ipKey = simpleHash(ip);
      ipFailedAt = 0;
    } else {
      ipFailedAt = Date.now();
    }
    ipPending = null;
    return ipKey;
  })();
  return ipPending;
}

// --- nearby discovery -------------------------------------------------------

function makeNearby({ appId, relays, onNearby }) {
  let watching = false;
  let info = null; // what we announce, or null
  let announceSince = 0;
  let room = null;
  let action = null;
  let busy = false;
  let closed = false;
  let timer = null;
  let tickN = 0;
  let lastEmit = '[]';
  const entries = new Map(); // peerId -> entry

  function emit(force) {
    const now = Date.now();
    const list = [];
    for (const [id, e] of entries) {
      if (now - e.seen > NEAR_TTL_MS) {
        entries.delete(id);
        continue;
      }
      const { seen, ...pub } = e; // eslint-disable-line no-unused-vars
      list.push(pub);
    }
    list.sort((a, b) => b.since - a.since);
    const sig = JSON.stringify(list);
    if (!force && sig === lastEmit) return;
    lastEmit = sig;
    safe(onNearby, list);
  }

  function payload() {
    const { code, mode, players, ...rest } = info;
    return { ...rest, t: '_near', code, mode, players, age: Date.now() - announceSince };
  }

  function sendTo(target) {
    if (!room || !action || !info) return;
    try {
      const p = action.send(payload(), target ? { target } : undefined);
      if (p && p.catch) p.catch(noop);
    } catch {
      /* ignore */
    }
  }

  function onNear(msg, peerId) {
    if (!msg || msg.t !== '_near') return;
    if (!msg.code) {
      if (entries.delete(peerId)) emit();
      return;
    }
    const { t, age, code, mode, players, ...rest } = msg; // eslint-disable-line no-unused-vars
    const now = Date.now();
    const prev = entries.get(peerId);
    const sameTable = prev && prev.code === String(code);
    entries.set(peerId, {
      ...rest,
      code: String(code),
      mode,
      players,
      // Stable across repeats of the same announcement, so the list only changes when something real does.
      since: sameTable ? prev.since : now - (Number.isFinite(age) ? age : 0),
      seen: now,
    });
    emit();
  }

  function tick() {
    tickN++;
    if (info && tickN % Math.round(ANNOUNCE_MS / 1000) === 0) sendTo(null);
    emit();
  }

  async function ensure() {
    if (closed || busy || room) return;
    if (!watching && !info) return;
    busy = true;
    try {
      const key = await nearbyKey();
      if (!key) {
        emit();
        // Offline or blocked: try again later while somebody still cares.
        setTimeout(() => {
          busy = false;
          ensure();
        }, 31000);
        return;
      }
      const T = await loadTrystero();
      if (closed || room || (!watching && !info)) {
        busy = false;
        return;
      }
      const r = T.joinRoom(roomConfig(appId, relays), `${appId}-near-${key}`);
      room = r;
      action = r.makeAction('near');
      action.onMessage = (data, ctx) => {
        try {
          onNear(data, ctx && ctx.peerId);
        } catch {
          /* ignore */
        }
      };
      r.onPeerJoin = (id) => {
        try {
          sendTo(id); // newcomers learn about our table immediately
        } catch {
          /* ignore */
        }
      };
      r.onPeerLeave = (id) => {
        if (entries.delete(id)) emit();
      };
      tickN = 0;
      timer = setInterval(tick, 1000);
      busy = false;
      if (info) sendTo(null);
    } catch {
      busy = false;
      room = null;
      action = null;
      setTimeout(ensure, 10000);
    }
  }

  function stopIfIdle() {
    if (watching || info) return;
    clearInterval(timer);
    timer = null;
    const r = room;
    room = null;
    action = null;
    if (r) {
      try {
        const p = r.leave();
        if (p && p.catch) p.catch(noop);
      } catch {
        /* ignore */
      }
    }
    entries.clear();
    emit(true);
  }

  return {
    watch(on) {
      watching = !!on;
      if (watching) ensure();
      else stopIfIdle();
    },
    announce(next) {
      if (closed) return;
      if (next && typeof next === 'object' && next.code) {
        if (!info || info.code !== next.code) announceSince = Date.now();
        info = { ...next, code: String(next.code) };
        if (room) sendTo(null);
        else ensure();
      } else if (info) {
        if (room && action) {
          try {
            const p = action.send({ t: '_near', code: null });
            if (p && p.catch) p.catch(noop);
          } catch {
            /* ignore */
          }
        }
        info = null;
        stopIfIdle();
      }
    },
    close() {
      closed = true;
      watching = false;
      info = null;
      stopIfIdle();
    },
  };
}

// --- shared bookkeeping -------------------------------------------------------

function makeCore(o) {
  const core = {
    state: 'closed',
    code: null,
    rtt: null,
    present: false,
    everPeer: false,
    silent: false, // suppress onPeer('left') during a deliberate leave()
    reason: '',
    setState(s) {
      if (core.state === s) return;
      core.state = s;
      safe(o.onState, s);
    },
    setRtt(raw) {
      if (!(raw >= 0 && raw < 10000)) return;
      core.rtt = core.rtt == null ? raw : core.rtt * 0.6 + raw * 0.4;
    },
    /** Peer connected (or came back). Returns true when it changed. */
    peerUp() {
      if (core.present) return false;
      core.present = true;
      const ev = core.everPeer ? 'rejoined' : 'joined';
      core.everPeer = true;
      safe(o.onPeer, ev);
      return true;
    },
    peerDown() {
      if (!core.present) return false;
      core.present = false;
      core.rtt = null;
      if (!core.silent) safe(o.onPeer, 'left');
      return true;
    },
    deliver(msg) {
      if (!msg || typeof msg.t !== 'string' || msg.t[0] === '_') return;
      safe(o.onMessage, msg);
    },
    resetSession() {
      core.code = null;
      core.rtt = null;
      core.present = false;
      core.everPeer = false;
      core.reason = '';
    },
  };
  return core;
}

function publicApi(kind, core, extra, nearby) {
  const api = {
    kind,
    ...extra,
    watchNearby(on) {
      nearby.watch(on);
    },
    announce(info) {
      nearby.announce(info);
    },
  };
  Object.defineProperties(api, {
    state: { get: () => core.state, enumerable: true },
    code: { get: () => core.code, enumerable: true },
    rtt: { get: () => (core.rtt == null ? null : Math.round(core.rtt)), enumerable: true },
    peerPresent: { get: () => core.present, enumerable: true },
    reason: { get: () => core.reason, enumerable: true },
  });
  return api;
}

// ============================================================================
// kind 'p2p'
// ============================================================================

function makeP2p(o) {
  const appId = o.appId || DEFAULT_APP_ID;
  const relays = o.relays;
  const core = makeCore(o);
  const nearby = makeNearby({ appId, relays, onNearby: o.onNearby });

  let T = null; // trystero module
  let role = null; // 'host' | 'guest'
  let room = null;
  let ctl = null; // control channel action (config, restart, ready, calib, pings, handshake)
  let gme = null; // game channel action (s, input): coalesced so 60 Hz traffic cannot queue up
  let peerId = null; // the one remote peer we play with
  let lastSeen = 0;
  let welcomed = false;
  let rejoinFlag = false;
  const known = new Set(); // peer ids present in the room
  let joinDefer = null;
  let gen = 0; // bumps whenever the room is torn down, so old callbacks fall silent
  let opening = false;
  let closed = false;
  let timers = [];
  let rebuildAttempt = 0;
  let nextRebuildAt = 0;
  let relaysDownSince = 0;
  let everOpen = false;
  let lastHello = 0;
  let lastPing = 0;
  let offline = null;

  // game channel coalescing: at most one send in flight per message type
  const inflight = new Set();
  const latest = new Map();

  function ctlSend(msg, target) {
    if (!ctl) return false;
    try {
      const p = ctl.send(msg, { target });
      if (p && p.catch) p.catch(noop);
      return true;
    } catch {
      return false;
    }
  }

  function gameSend(msg, target) {
    const t = msg.t;
    if (inflight.has(t)) {
      latest.set(t, msg); // newest wins; it goes out as soon as the previous one cleared
      return true;
    }
    inflight.add(t);
    let p;
    try {
      p = gme.send(msg, { target });
    } catch {
      inflight.delete(t);
      return false;
    }
    const done = () => {
      inflight.delete(t);
      const next = latest.get(t);
      if (next) {
        latest.delete(t);
        if (peerId && core.present && gme) gameSend(next, peerId);
      }
    };
    if (p && p.then) p.then(done, done);
    else done();
    return true;
  }

  function touch(from) {
    if (from !== peerId) return;
    lastSeen = Date.now();
    if (!core.present) core.peerUp();
  }

  function helloAll() {
    lastHello = Date.now();
    for (const id of known) sendHello(id);
  }

  function sendHello(id) {
    if (role === 'host') ctlSend({ t: 'hello', role: 'host' }, id);
    else if (role === 'guest' && (!welcomed || id !== peerId)) ctlSend({ t: 'hello', role: 'guest', rejoin: rejoinFlag }, id);
  }

  function onCtl(msg, from) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'hello':
        if (role === 'host' && msg.role === 'guest') {
          if (peerId === from) {
            ctlSend({ t: 'welcome' }, from);
            lastSeen = Date.now();
            core.peerUp();
          } else if (
            !peerId ||
            !core.present ||
            Date.now() - lastSeen > REPLACE_MS ||
            (msg.rejoin && Date.now() - lastSeen > PING_MS)
          ) {
            if (peerId && peerId !== from) core.peerDown();
            peerId = from;
            lastSeen = Date.now();
            ctlSend({ t: 'welcome' }, from);
            core.peerUp();
          } else {
            ctlSend({ t: 'full' }, from); // first guest keeps the seat
          }
        } else if (role === 'guest' && msg.role === 'host') {
          sendHello(from);
        }
        return;
      case 'welcome':
        if (role !== 'guest') return;
        welcomed = true;
        if (peerId && peerId !== from) core.peerDown(); // a reloaded host replaces the old one
        peerId = from;
        lastSeen = Date.now();
        if (joinDefer) {
          clearTimeout(joinDefer.timer);
          const d = joinDefer;
          joinDefer = null;
          d.resolve();
        }
        core.setState('open');
        core.peerUp();
        return;
      case 'full':
        if (role === 'guest' && !welcomed && joinDefer) failJoin(new Error('Table is full'), 'full');
        return;
      case '_ping':
        if (from === peerId) {
          touch(from);
          ctlSend({ t: '_pong', c: msg.c }, from);
        }
        return;
      case '_pong':
        if (from === peerId) {
          touch(from);
          core.setRtt(performance.now() - msg.c);
        }
        return;
      default:
        if (from === peerId) {
          touch(from);
          core.deliver(msg);
        }
    }
  }

  function onGame(msg, from) {
    if (from !== peerId) return; // strangers and late joiners are ignored
    touch(from);
    core.deliver(msg);
  }

  function failJoin(err, code) {
    const d = joinDefer;
    joinDefer = null;
    if (d) clearTimeout(d.timer);
    if (code) err.code = code;
    core.silent = true;
    teardown();
    core.silent = false;
    core.setState('closed');
    if (d) d.reject(err);
  }

  async function openRoom() {
    if (opening || closed || !role || room) return;
    opening = true;
    const myGen = gen;
    try {
      T = await loadTrystero();
      if (myGen !== gen || closed || !role) return;
      const r = T.joinRoom(roomConfig(appId, relays), `${appId}-${core.code}`);
      room = r;
      ctl = r.makeAction('ctl');
      gme = r.makeAction('gme');
      ctl.onMessage = (data, ctx) => {
        if (myGen !== gen) return;
        try {
          onCtl(data, ctx && ctx.peerId);
        } catch {
          /* ignore */
        }
      };
      gme.onMessage = (data, ctx) => {
        if (myGen !== gen) return;
        try {
          onGame(data, ctx && ctx.peerId);
        } catch {
          /* ignore */
        }
      };
      r.onPeerJoin = (id) => {
        if (myGen !== gen) return;
        known.add(id);
        try {
          sendHello(id);
        } catch {
          /* ignore */
        }
      };
      r.onPeerLeave = (id) => {
        if (myGen !== gen) return;
        known.delete(id);
        if (id === peerId) {
          core.peerDown();
          peerId = null; // seat is free; whoever says hello next takes it
          welcomed = false;
          inflight.clear();
          latest.clear();
        }
      };
    } catch {
      room = null;
      ctl = null;
      gme = null;
      if (core.state !== 'closed') core.setState('reconnecting');
      scheduleRebuild();
    } finally {
      opening = false;
    }
  }

  function startTimers(myGen) {
    stopTimers();
    timers.push(
      setInterval(() => {
        if (myGen !== gen) return;
        try {
          tick();
        } catch {
          /* ignore */
        }
      }, 1000),
    );
  }

  function stopTimers() {
    for (const t of timers) clearInterval(t);
    timers = [];
  }

  function scheduleRebuild() {
    const wait = REBUILD_BACKOFF_MS[Math.min(rebuildAttempt, REBUILD_BACKOFF_MS.length - 1)];
    rebuildAttempt++;
    nextRebuildAt = Date.now() + wait;
  }

  function tick() {
    const now = Date.now();

    // No room yet (loading failed or joinRoom threw): retry with backoff.
    if (!room) {
      if (!opening && now >= nextRebuildAt) {
        scheduleRebuild();
        openRoom();
      }
      return;
    }

    // Relay health decides between 'open' and 'reconnecting'.
    const n = T ? openRelays(T, relays) : 0;
    if (n > 0 || core.present) {
      relaysDownSince = 0;
      if (n > 0) rebuildAttempt = 0;
      everOpen = true;
      if (core.state !== 'open') core.setState('open');
    } else {
      if (!relaysDownSince) relaysDownSince = now;
      if (now - relaysDownSince > RELAY_DEAD_MS) {
        if (core.state !== 'reconnecting') core.setState('reconnecting');
        if (now >= nextRebuildAt) {
          scheduleRebuild();
          rebuildRoom();
          return;
        }
      }
    }

    // Peer liveness: silence means gone, even if WebRTC has not noticed yet.
    if (core.present && now - lastSeen > STALE_MS) {
      core.peerDown(); // stays the peer: any traffic from it brings it back as 'rejoined'
    }

    // Guest keeps knocking until the host answers.
    if (role === 'guest' && !welcomed && now - lastHello > HELLO_RETRY_MS) helloAll();

    if (core.present && now - lastPing >= PING_MS - 50) {
      lastPing = now;
      ctlSend({ t: '_ping', c: performance.now() }, peerId);
    }
  }

  function leaveRoom() {
    const r = room;
    room = null;
    ctl = null;
    gme = null;
    if (r) {
      try {
        const p = r.leave();
        if (p && p.catch) p.catch(noop);
      } catch {
        /* ignore */
      }
    }
  }

  /** Drop the Trystero room but keep role/code so it can be reopened. */
  function rebuildRoom() {
    gen++;
    stopTimers();
    leaveRoom();
    known.clear();
    inflight.clear();
    latest.clear();
    opening = false;
    welcomed = false;
    peerId = null;
    core.peerDown();
    startTimers(gen);
    openRoom();
  }

  function teardown() {
    gen++;
    stopTimers();
    leaveRoom();
    known.clear();
    inflight.clear();
    latest.clear();
    opening = false;
    role = null;
    peerId = null;
    welcomed = false;
    relaysDownSince = 0;
    everOpen = false;
    rebuildAttempt = 0;
    nextRebuildAt = 0;
    const wasPresent = core.present;
    if (wasPresent) core.peerDown();
    core.code = null;
    core.rtt = null;
  }

  function onOnline() {
    if (role && !closed && core.state !== 'open') {
      rebuildAttempt = 0;
      nextRebuildAt = 0;
    }
  }
  if (typeof window !== 'undefined') {
    offline = onOnline;
    window.addEventListener('online', offline);
  }

  async function start(newRole, code) {
    if (closed) throw new Error('Transport closed');
    if (joinDefer) failJoin(new Error('Cancelled'), 'cancelled');
    teardown();
    core.resetSession();
    role = newRole;
    core.code = code;
    lastHello = 0;
    lastPing = 0;
    core.setState('connecting');
    startTimers(gen);
    await openRoom();
  }

  const api = publicApi(
    'p2p',
    core,
    {
      async host(code) {
        const wanted = normCode(code) || makeCode();
        await start('host', wanted);
        return wanted;
      },
      join(code) {
        const wanted = normCode(code);
        return new Promise((resolve, reject) => {
          if (!wanted) {
            reject(Object.assign(new Error('No table with that code'), { code: 'no-table' }));
            return;
          }
          rejoinFlag = false;
          start('guest', wanted).catch(() => {});
          joinDefer = {
            resolve,
            reject,
            timer: setTimeout(
              () => failJoin(Object.assign(new Error('No table with that code'), { code: 'no-table' }), 'no-table'),
              JOIN_TIMEOUT_MS,
            ),
          };
        });
      },
      leave() {
        if (joinDefer) failJoin(new Error('Cancelled'), 'cancelled');
        const had = !!role;
        core.silent = true;
        teardown();
        core.silent = false;
        core.resetSession();
        if (had || core.state !== 'closed') core.setState('closed');
      },
      close() {
        api.leave();
        closed = true;
        nearby.close();
        if (offline && typeof window !== 'undefined') window.removeEventListener('online', offline);
      },
      send(msg) {
        if (!msg || typeof msg.t !== 'string' || !peerId || !core.present) return false;
        if (msg.t === 's' || msg.t === 'input') return gme ? gameSend(msg, peerId) : false;
        return ctlSend(msg, peerId);
      },
    },
    nearby,
  );
  return api;
}

// ============================================================================
// kind 'ws' (the Node pairing/relay server)
// ============================================================================

// Copy of the reconnecting socket in net.js (kept in sync by hand; net.js itself is not touched).
const WS_BACKOFF_MS = [500, 1000, 2000, 4000, 5000];

function wsConnect({ onOpen, onMessage, onClose, onState } = {}) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let timer = null;
  let everOpen = false;
  let state = 'connecting';

  function setState(s) {
    if (state === s) return;
    state = s;
    if (onState) onState(s);
  }

  function schedule() {
    if (closed || timer) return;
    const delay = WS_BACKOFF_MS[Math.min(attempt, WS_BACKOFF_MS.length - 1)];
    attempt++;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
  }

  function open() {
    if (closed || ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let sock;
    try {
      sock = new WebSocket(`${proto}://${location.host}`);
    } catch {
      if (onClose) onClose();
      schedule();
      return;
    }
    ws = sock;
    setState(everOpen ? 'reconnecting' : 'connecting');

    sock.addEventListener('open', () => {
      if (ws !== sock) return;
      const again = everOpen;
      everOpen = true;
      attempt = 0;
      setState('open');
      if (onOpen) onOpen(again);
    });

    sock.addEventListener('message', (ev) => {
      if (ws !== sock) return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (onMessage) onMessage(msg);
    });

    sock.addEventListener('close', () => {
      if (ws !== sock) return;
      ws = null;
      if (closed) return setState('closed');
      setState('reconnecting');
      if (onClose) onClose();
      schedule();
    });

    sock.addEventListener('error', () => {});
  }

  function nudge() {
    if (closed || ws) return;
    clearTimeout(timer);
    timer = null;
    attempt = 0;
    open();
  }

  window.addEventListener('online', nudge);
  open();

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        return true;
      }
      return false;
    },
    nudge,
    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
      window.removeEventListener('online', nudge);
      const old = ws;
      ws = null;
      if (old) {
        try {
          old.close();
        } catch {
          /* ignore */
        }
      }
      setState('closed');
    },
    get isOpen() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
    get bufferedAmount() {
      return ws && ws.readyState === WebSocket.OPEN ? ws.bufferedAmount : 0;
    },
  };
}

function makeWs(o) {
  const appId = o.appId || DEFAULT_APP_ID;
  const core = makeCore(o);
  const nearby = makeNearby({ appId, relays: o.relays, onNearby: o.onNearby });

  let net = null;
  let role = null;
  let wantCode = ''; // code to join / reclaim
  let rejoin = false;
  let defer = null; // pending host() or join()
  let pingTimer = null;
  let closed = false;
  let cur = null; // token of the live socket wrapper; callbacks of older ones are ignored

  function settle(err) {
    const d = defer;
    defer = null;
    if (!d) return false;
    clearTimeout(d.timer);
    if (err) d.reject(err);
    else d.resolve(d.value());
    return true;
  }

  function stopNet() {
    clearInterval(pingTimer);
    pingTimer = null;
    const n = net;
    net = null;
    cur = null;
    if (n) {
      try {
        n.close();
      } catch {
        /* ignore */
      }
    }
  }

  function startPing() {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (core.present && net) net.send({ t: 'ping', c: performance.now() });
    }, PING_MS);
  }

  function reset(why) {
    const wasRole = role;
    role = null;
    core.peerDown();
    core.code = null;
    core.reason = why || '';
    stopNet();
    return wasRole;
  }

  function onSrv(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'hosted':
        core.code = msg.code;
        wantCode = msg.code;
        core.present = false; // 'paired' follows if the guest is still there
        settle();
        return;
      case 'joined':
        core.code = msg.code;
        wantCode = msg.code;
        settle();
        return;
      case 'guest-joined':
      case 'hb':
        return;
      case 'paired':
        if (core.peerUp()) startPing();
        return;
      case 'peer-left':
        core.peerDown();
        return;
      case 'closed':
        reset(msg.m || 'The table was closed.');
        core.peerDown();
        core.setState('closed');
        return;
      case 'error': {
        const code = msg.code;
        // Reclaim of a vanished table while hosting for the first time: just start a new one.
        if (role === 'host' && code === 'no-table' && defer && wantCode) {
          wantCode = '';
          if (net) net.send({ t: 'host' });
          return;
        }
        const text =
          code === 'no-table'
            ? 'No table with that code'
            : code === 'full'
              ? 'Table is full'
              : msg.m || 'Could not connect';
        const err = Object.assign(new Error(text), { code });
        const pending = !!defer;
        reset(text);
        core.setState('closed');
        if (pending) settle(err);
        return;
      }
      case 'ping':
        if (net) net.send({ t: 'pong', c: msg.c });
        return;
      case 'pong':
        core.setRtt(performance.now() - msg.c);
        return;
      default:
        core.deliver(msg);
    }
  }

  function begin(newRole, code, value, timeoutMessage) {
    if (closed) return Promise.reject(new Error('Transport closed'));
    if (defer) settle(new Error('Cancelled'));
    stopNet();
    core.peerDown();
    core.resetSession();
    role = newRole;
    wantCode = code;
    return new Promise((resolve, reject) => {
      defer = {
        resolve,
        reject,
        value,
        timer: setTimeout(() => {
          reset(timeoutMessage);
          core.setState('closed');
          settle(new Error(timeoutMessage));
        }, 10000),
      };
      core.setState('connecting');
      const token = {};
      cur = token;
      net = wsConnect({
        onOpen(again) {
          if (cur !== token || !net) return;
          if (role === 'host') net.send(wantCode ? { t: 'host', code: wantCode } : { t: 'host' });
          else if (role === 'guest') net.send({ t: 'join', code: wantCode, ...(again || rejoin ? { rejoin: true } : {}) });
        },
        onMessage: (m) => {
          if (cur !== token) return;
          try {
            onSrv(m);
          } catch {
            /* ignore */
          }
        },
        onClose() {
          if (cur === token) core.peerDown(); // the server tells the other side; we just stop sending
        },
        onState(s) {
          if (cur === token) core.setState(s);
        },
      });
    });
  }

  const api = publicApi(
    'ws',
    core,
    {
      host(code) {
        return begin('host', normCode(code), () => core.code, 'Cannot reach the server');
      },
      join(code, opts) {
        rejoin = !!(opts && opts.rejoin);
        return begin('guest', normCode(code), () => undefined, 'Cannot reach the server').then(() => {});
      },
      leave() {
        if (defer) settle(new Error('Cancelled'));
        if (net) net.send({ t: 'leave' });
        core.silent = true;
        reset('');
        core.silent = false;
        core.resetSession();
        core.setState('closed');
      },
      close() {
        api.leave();
        closed = true;
        nearby.close();
      },
      send(msg) {
        if (!msg || typeof msg.t !== 'string' || !net || !core.present) return false;
        if ((msg.t === 's' || msg.t === 'input') && net.bufferedAmount > 256 * 1024) return true; // drop stale frame
        return net.send(msg);
      },
    },
    nearby,
  );
  return api;
}

// ============================================================================

export function createTransport(opts = {}) {
  const kind = opts.kind === 'ws' ? 'ws' : 'p2p';
  return kind === 'ws' ? makeWs(opts) : makeP2p(opts);
}

export const _internals = { simpleHash, RELAYS, STUN };
