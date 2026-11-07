// Service worker: lets the game open offline and from the home screen.
//
// Strategy
//  * Every app file (page, scripts, styles, icons, manifest) lives in ONE cache
//    "generation": a cache named ah-<timestamp> that is filled completely
//    before it counts. A cache without the '.complete' marker is ignored, so
//    a half-downloaded set can never be served, and a stale main.js can never
//    pair with a newer sim.js (or the other way round).
//  * Install builds a new generation with cache:'reload' (bypassing the HTTP
//    cache, which static hosts like GitHub Pages set to ~10 minutes).
//  * Navigations and scripts / styles / manifest are network-first; if the
//    network fails the file comes from the newest complete generation. Icons
//    are cache-first.
//  * After a successful online navigation the worker quietly rebuilds the
//    whole generation (at most every 10 minutes) and then drops the old ones,
//    so the offline copy follows deploys even when this file did not change.
//  * Activate deletes every generation except the newest complete one.
//  * No skipWaiting / clients.claim: a new worker takes over only when the old
//    page is closed, so one page load never mixes two workers' files.
// Bump CACHE_VERSION when this list changes (it also forces a new install).

const CACHE_VERSION = 3;
const PREFIX = 'ah-';
const MARKER = '.complete';
const REFRESH_EVERY_MS = 10 * 60 * 1000;

// Relative to the worker's own location, so a sub-path deploy works.
const SHELL = ['./', 'index.html'];
const SCRIPTS = [
  'main.js',
  'sim.js',
  'bot.js',
  'view.js',
  'twists-view.js',
  'fx.js',
  'audio.js',
  'transport.js',
  'vendor/qrcode.js',
  'vendor/trystero.js',
];
const OPTIONAL = ['net.js']; // legacy WebSocket client; fine if it is gone
const STYLES = ['style.css', 'manifest.webmanifest'];
const ICONS = [
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/icon.svg',
];
const REQUIRED = [...SHELL, ...SCRIPTS, ...STYLES, ...ICONS];

const abs = (rel) => new URL(rel, self.registration.scope).href;
const ICON_URLS = new Set(ICONS.map(abs));
const APP_URLS = new Set([...REQUIRED, ...OPTIONAL].map(abs));
// The directory URL and index.html are the same document.
const normalize = (url) => (url === abs('./') ? abs('index.html') : url);

let lastRefresh = 0;
let refreshing = null;

/** Download every app file into a brand-new cache; only mark it complete when all succeeded. */
async function buildGeneration() {
  const name = PREFIX + String(CACHE_VERSION).padStart(4, '0') + '-' + Date.now().toString(36);
  const cache = await caches.open(name);
  try {
    await Promise.all(
      REQUIRED.map(async (rel) => {
        const res = await fetch(new Request(abs(rel), { cache: 'reload' }));
        if (!res.ok) throw new Error(rel + ' ' + res.status);
        await cache.put(abs(rel === './' ? 'index.html' : rel), res);
      }),
    );
    await Promise.all(
      OPTIONAL.map(async (rel) => {
        try {
          const res = await fetch(new Request(abs(rel), { cache: 'reload' }));
          if (res.ok) await cache.put(abs(rel), res);
        } catch {
          /* optional */
        }
      }),
    );
    await cache.put(MARKER_URL(), new Response('ok'));
  } catch (err) {
    await caches.delete(name);
    throw err;
  }
  return name;
}
const MARKER_URL = () => abs(MARKER);

/** Name of the newest complete generation, or null. */
async function currentGeneration() {
  const names = (await caches.keys()).filter((n) => n.startsWith(PREFIX)).sort().reverse();
  // Names sort by version, then by creation time.
  for (const name of names) {
    const cache = await caches.open(name);
    if (await cache.match(MARKER_URL())) return name;
  }
  return null;
}

async function dropOthers(keep) {
  for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== keep) await caches.delete(name);
}

async function fromCache(request) {
  const name = await currentGeneration();
  if (!name) return undefined;
  const cache = await caches.open(name);
  return cache.match(normalize(request.url.split('?')[0].split('#')[0]));
}

/** Rebuild the generation after a successful online page load. */
function refresh() {
  if (refreshing || Date.now() - lastRefresh < REFRESH_EVERY_MS) return refreshing;
  lastRefresh = Date.now();
  refreshing = buildGeneration()
    .then(dropOthers)
    .catch(() => {
      lastRefresh = 0; // try again on the next page load
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

self.addEventListener('install', (event) => {
  event.waitUntil(buildGeneration());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = await currentGeneration();
      if (keep) await dropOthers(keep);
      lastRefresh = Date.now();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // relays, CDNs: never touched
  const clean = url.origin + url.pathname;

  if (req.mode === 'navigate') {
    // Only pages inside our scope; query strings (?join=ABCD) are ignored for the cache lookup.
    if (!clean.startsWith(self.registration.scope.replace(/\/$/, ''))) return;
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) event.waitUntil(refresh() || Promise.resolve());
          return res;
        } catch (err) {
          const hit = await (async () => {
            const name = await currentGeneration();
            return name ? (await caches.open(name)).match(abs('index.html')) : undefined;
          })();
          if (hit) return hit;
          throw err;
        }
      })(),
    );
    return;
  }

  if (!APP_URLS.has(clean)) return; // /healthz, /info, dev pages ...

  if (ICON_URLS.has(clean)) {
    event.respondWith(
      (async () => (await fromCache(req)) || fetch(req))(),
    );
    return;
  }

  // Scripts, styles, manifest: network first, cache when offline.
  event.respondWith(
    (async () => {
      try {
        return await fetch(req);
      } catch (err) {
        const hit = await fromCache(req);
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
