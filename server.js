// Pairing + relay server for the two-iPad air hockey game.
//
// Serves ./public over HTTP and runs a WebSocket endpoint on the same port.
// Two devices form a "table": the host creates one and gets a 4-letter code,
// the guest joins with that code (or auto-joins the only open table). After
// that every game message is relayed verbatim to the other device. The server
// never looks at game state; the host iPad is the authority.
//
// Reconnection: a table survives its sockets. If the host drops, the table
// stays for HOST_GRACE_MS in status 'host-away' and the host can reclaim it
// with {t:'host', code}. If the guest drops, the table stays open for a new or
// returning guest. A 15 s ping/pong heartbeat drops dead sockets.
//
// Messages the server understands (client -> server):
//   {t:'host', code?}              create a table, or reclaim `code`
//   {t:'join', code?, rejoin?}     join `code` (empty = the only open table)
//   {t:'leave'}                    deliberately leave the table
// Messages it sends (server -> client):
//   {t:'hosted', code, reclaimed?} {t:'joined', code}   {t:'guest-joined'}
//   {t:'paired', code}             both sides are connected
//   {t:'peer-left', reason:'host'|'guest'}
//   {t:'closed', m}                the table is gone (host left / timed out)
//   {t:'error', code, m}           code: no-table | full | none-open | multiple
// Only s / input / config / restart / ping / pong are relayed to the peer untouched;
// the server also sends {t:'hb'} to every socket each heartbeat.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST_GRACE_MS = 45000;
const HEARTBEAT_MS = 15000;

// Only these game messages are relayed between the two devices.
const RELAYED = new Set(['s', 'input', 'config', 'restart', 'ping', 'pong']);

// One bad request must never take down every table.
process.on('uncaughtException', (e) => console.error('uncaught', e));

function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
  }
  return urls;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webmanifest': 'application/manifest+json',
};

// --- tables -----------------------------------------------------------------

/**
 * @typedef {{host: import('ws').WebSocket|null, guest: import('ws').WebSocket|null,
 *            status: 'open'|'host-away', timer: NodeJS.Timeout|null}} Table
 * @type {Map<string, Table>}
 */
const tables = new Map();

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I, L, O: easy to read across a table
function newCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  } while (tables.has(code));
  return code;
}

function live(ws) {
  return !!ws && ws.readyState === ws.OPEN;
}

function send(ws, msg) {
  if (live(ws)) ws.send(JSON.stringify(msg));
}

function peerOf(ws) {
  const table = tables.get(ws.tableCode);
  if (!table) return null;
  if (ws.role === 'host') return table.host === ws ? table.guest : null;
  return table.guest === ws ? table.host : null;
}

function announcePaired(code, table) {
  if (live(table.host) && live(table.guest)) {
    send(table.host, { t: 'paired', code });
    send(table.guest, { t: 'paired', code });
  }
}

/** Remove a table and tell whoever is still attached. */
function closeTable(code, why) {
  const table = tables.get(code);
  if (!table) return;
  clearTimeout(table.timer);
  tables.delete(code);
  for (const ws of [table.host, table.guest]) {
    if (!ws) continue;
    send(ws, { t: 'closed', m: why });
    ws.tableCode = null;
    ws.role = null;
  }
}

/**
 * Detach a socket from its table. `deliberate` = the user pressed Leave;
 * otherwise the connection simply dropped and the table waits for a return.
 */
function detach(ws, deliberate) {
  const code = ws.tableCode;
  const role = ws.role;
  ws.tableCode = null;
  ws.role = null;
  if (!code) return;
  const table = tables.get(code);
  if (!table) return;

  if (role === 'host') {
    if (table.host !== ws) return; // already replaced by a reconnect
    table.host = null;
    if (deliberate) return closeTable(code, 'The host closed the table.');
    table.status = 'host-away';
    send(table.guest, { t: 'peer-left', reason: 'host' });
    clearTimeout(table.timer);
    table.timer = setTimeout(() => closeTable(code, 'The host did not come back.'), HOST_GRACE_MS);
  } else {
    if (table.guest !== ws) return;
    table.guest = null;
    send(table.host, { t: 'peer-left', reason: 'guest' });
  }
}

/** Silently drop a socket that has been superseded by a reconnect. */
function supersede(old) {
  if (!old) return;
  old.tableCode = null;
  old.role = null;
  try {
    old.terminate();
  } catch {
    /* already gone */
  }
}

function handleHost(ws, msg) {
  const wanted = String(msg.code || '').trim().toUpperCase();
  if (ws.tableCode && ws.tableCode !== wanted) detach(ws, true);

  if (wanted) {
    // Reclaim. A returning host replaces whatever socket the server still
    // believes is the host (it may be a half-dead connection).
    const table = tables.get(wanted);
    if (!table) return send(ws, { t: 'error', code: 'no-table', m: `Table ${wanted} no longer exists.` });
    if (table.host && table.host !== ws) supersede(table.host);
    clearTimeout(table.timer);
    table.timer = null;
    table.host = ws;
    table.status = 'open';
    ws.role = 'host';
    ws.tableCode = wanted;
    send(ws, { t: 'hosted', code: wanted, reclaimed: true });
    announcePaired(wanted, table);
    return;
  }

  const code = newCode();
  tables.set(code, { host: ws, guest: null, status: 'open', timer: null });
  ws.role = 'host';
  ws.tableCode = code;
  send(ws, { t: 'hosted', code });
}

function handleJoin(ws, msg) {
  let code = String(msg.code || '').trim().toUpperCase();
  if (ws.tableCode && ws.tableCode !== code) detach(ws, true);
  if (!code) {
    // Auto-join: exactly one table waiting for a guest.
    const open = [...tables.entries()].filter(([, t]) => live(t.host) && !live(t.guest));
    if (open.length === 1) code = open[0][0];
    else if (open.length) return send(ws, { t: 'error', code: 'multiple', m: 'Several tables are open. Type the code.' });
    else return send(ws, { t: 'error', code: 'none-open', m: 'No table is waiting. Host one on the other iPad first.' });
  }
  const table = tables.get(code);
  if (!table) return send(ws, { t: 'error', code: 'no-table', m: `No table with code ${code}.` });
  if (live(table.guest) && table.guest !== ws) {
    // A returning guest (rejoin) replaces its own stale socket.
    if (!msg.rejoin) return send(ws, { t: 'error', code: 'full', m: `Table ${code} already has two iPads.` });
    supersede(table.guest);
  }
  table.guest = ws;
  ws.role = 'guest';
  ws.tableCode = code;
  send(ws, { t: 'joined', code });
  if (live(table.host)) {
    send(table.host, { t: 'guest-joined' });
    announcePaired(code, table);
  } else {
    // Host is away (reconnecting); tell the guest so it can show the overlay.
    send(ws, { t: 'peer-left', reason: 'host' });
  }
}

// --- static files -----------------------------------------------------------

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400);
    return res.end();
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ tables: tables.size }));
  }

  if (url.pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ urls: lanUrls(), port: PORT }));
  }

  let file;
  try {
    file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(url.pathname)));
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (file.includes('\0')) {
    res.writeHead(400);
    return res.end();
  }
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  if (url.pathname === '/' || url.pathname === '') file = path.join(PUBLIC_DIR, 'index.html');

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

// --- websockets -------------------------------------------------------------

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  ws.role = null;
  ws.tableCode = null;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('error', () => {});

  ws.on('message', (raw) => {
    ws.isAlive = true;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'host') return handleHost(ws, msg);
    if (msg.t === 'join') return handleJoin(ws, msg);
    if (msg.t === 'leave') return detach(ws, true);

    // Only whitelisted game traffic is relayed to the other device untouched.
    if (!RELAYED.has(msg.t)) return;
    const peer = peerOf(ws);
    if (!live(peer)) return;
    // A slow peer must not accumulate a queue of stale frames.
    if ((msg.t === 's' || msg.t === 'input') && peer.bufferedAmount > 256 * 1024) return;
    peer.send(raw.toString());
  });

  ws.on('close', () => detach(ws, false));
});

// Heartbeat: drop sockets that stopped answering (iPad asleep, Wi-Fi gone).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
      ws.send('{"t":"hb"}');
    } catch {
      /* closing */
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

// --- start ------------------------------------------------------------------

server.listen(PORT, () => {
  console.log('Two iPad Air Hockey');
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  On iPad: ${u}`);
  console.log('Open the "On iPad" URL in Safari on both iPads (same Wi-Fi as this Mac).');
});
