# Two iPad Air Hockey

Air hockey across two iPads laid **top edge against top edge**, in the browser.
The puck slides off one screen and onto the other. No app, no account, and no
computer needed: host the `public/` folder as a static site and both iPads
open it and connect directly to each other. One iPad is enough too: play
against a bot, or two people on one iPad flat on the table.

Inspired by [bigboard.games](https://bigboard.games/), where phones pushed
together become one board.

## Run it

### Recommended: a hosted static site (no computer in the loop)

`public/` is the whole game: plain files, no build step. Put it on any static
host, open the URL on both iPads, and play. The iPads exchange game data
**device to device** over WebRTC. Finding each other ("signaling") goes through
public Nostr relays, so **both iPads need internet access**; the match itself
never touches a server. *Tables near you* lists tables hosted by iPads on the
same Wi-Fi (same public IP), so usually you just tap *Join*. A code or QR code
works from anywhere.

**GitHub Pages**
1. Create a repo and put the *contents* of `public/` at its root (or keep this
   layout and publish `public/` with the stock "Deploy static content" Pages
   workflow, setting `path: public`).
2. Settings, Pages, Source: the branch (or GitHub Actions).
3. Open `https://<user>.github.io/<repo>/` on both iPads. Sub-paths work: every
   URL in the app is relative.

**Netlify**
1. Drag the `public/` folder onto app.netlify.com/drop (or connect the repo).
2. If you connect the repo set *Publish directory* to `public` and leave the
   build command empty.
3. Open the `*.netlify.app` URL on both iPads.

**Cloudflare Pages**
1. Workers & Pages, Create, Pages, connect the repo (or Direct Upload of `public/`).
2. Framework preset *None*, build command empty, output directory `public`.
3. Open the `*.pages.dev` URL on both iPads.

Try it locally without any account (serves the static files only, the iPads
connect directly):

```bash
python3 -m http.server 8128 --directory public
```

Then open `http://<this computer's IP>:8128` on the iPads. Service workers
and "Add to Home Screen" offline caching need https (or localhost), which the
hosts above provide.

On each iPad, Share, Add to Home Screen gives a full-screen app. A service
worker keeps the files so it also opens with no connection (you still need
internet to find the other iPad).

### Optional: the Node server (a LAN without internet)

```bash
npm install
npm start          # PORT=3500 npm start to change the port
```

The terminal prints URLs such as `http://192.168.x.x:3000` and
`http://<hostname>.local:3000`. Open one on each iPad (same Wi-Fi as the
computer). When the page comes from this server, *Connection: Auto* picks
**This server** (a WebSocket relay on the computer), so nothing needs the
internet. (The *Tables near you* list uses the same internet-based discovery
as the direct connection, so on an offline LAN type the code or scan the QR
code instead.)

**Connection setting** (Two iPads screen): *Auto* uses the server when the page
was served by one (it answers `/healthz`), otherwise the direct connection.
*Direct* forces WebRTC; *This server* forces the WebSocket relay. The waiting
screen shows which one is active. Both iPads must use the same kind (the QR
code carries it).

**Two iPads**

1. On the first iPad: *Two iPads* → pick a mode → *Host a table*. It shows a
   4-letter code and a QR code.
2. On the second iPad: open *Two iPads* then *Join a table*. The host's table
   appears under *Tables near you* (same Wi-Fi); tap *Join*. Or scan the QR
   code (it opens the page and joins), or type the 4-letter code.
3. Lay the iPads flat, top edge touching top edge, each player at the bottom of
   their own iPad.
4. **Line up the seam** (host only). Before the match a slim bar at the bottom
   of the host iPad shows *Seam gap* with − / + buttons, and a ring is drawn
   across both screens. Nudge the gap until the ring looks like one circle
   spanning the bezels, then tap *Done*. The value is remembered.
5. **Get ready.** Each player presses a finger down on their own half. The
   countdown starts once both iPads are ready. Grab your mallet. First to 5, 7
   or 11 wins.
6. **After the match** the host gets *Rematch* and *Change mode* (the table
   stays paired; pick new options and start again). The guest can tap *Ask for
   a rematch*. Tapping the rink also starts a rematch.

**One iPad**: *Solo vs bot* (four bot levels) or *Pass & play* (one finger per
half). Tap *Start*, then press down to start: one press against the bot, one
press on each half in pass & play.

To try it on one Mac, open the URL in two browser tabs: host in one, join in
the other.

## What is in the box

- **Modes**: Classic, Bumpers (brass posts to bank off), Ice (almost no
  friction), Heavy (a slow steel puck), Mines (touch one and the puck blasts
  off; it re-arms after a few seconds).
- **Comeback goals** (on by default): the player who is behind gets a narrower
  goal mouth, so no lead is safe.
- **Bot** with Easy, Medium, Hard and Impossible levels. Hard and above predict
  where the puck will cross their line; Impossible also predicts rail bounces.
- **Looks**: glowing rails and goals, puck trail, 3D mallets, sparks on hits,
  confetti that spills across the seam on goals, screen shake, animated
  countdown and score pops.
- **Sound**: synthesized with Web Audio, no files. Hits, rail ticks, bumper
  dings, mine booms, goal horn, countdown beeps, win and lose jingles. Toggle
  it in the lobby or the pause menu.
- **Pause menu** (the small button top-left, it fades while you play): the
  table code, Resume, Restart, Fullscreen, Sound, Quit.
- **Lobby**: animated background, a *How to play* sheet, a *Tables near you*
  list, a join code that uppercases itself and joins at 4 letters, and a
  friendly message when a code is wrong.
- **Reconnect**: if an iPad loses Wi-Fi or reloads, it rejoins the same table
  automatically. The host keeps the score while the other iPad is away.
- **Instant replay**: after every goal both iPads play the last two seconds
  back at half speed, letterboxed, before the serve.
- **Feel**: the guest iPad advances the puck between snapshots with the real
  physics, and predicts its own hits locally so a strike never waits for the
  round trip; the host confirms or corrects a moment later.
- **Latency readout** in the corner during two-iPad play, and a
  *Diagnostics* panel in the pause menu (fps, frame time, round trip, jitter,
  link type, dropped snapshots).
- **Home screen app**: manifest, icons and a service worker, so it installs
  like an app and opens offline.

## Host options

- **Seam gap**: millimetres of bezel between the two screens. Raise it if the
  puck seems to jump at the seam, lower it if it seems to pause. Default 16.
  Set it in the lobby, or live in the calibration bar before each new table's
  first match (the ring should line up across both screens).
- **First to**: 5, 7 or 11 goals.
- All choices are remembered on the device.

## How it works

```
public/main.js    Lobby, pairing, nearby tables, ready handshake, seam calibration,
                  post-match sheet, input, pause menu, the per-frame loop.
public/transport.js  host / join / send over WebRTC ('p2p') or the Node server
                  ('ws'), reconnect, round-trip time, nearby-table discovery.
public/vendor/    qrcode.js (join QR), trystero.js (WebRTC signaling over Nostr).
public/sim.js     Host-authoritative physics in one shared world space, modes,
                  comeback rule, event stream.
public/bot.js     The bot that drives the guest mallet in solo play.
public/view.js    Maps world <-> screen for each role and draws the rink, HUD.
public/fx.js      Particles, flashes, screen shake.
public/audio.js   Web Audio synth for every event.
public/sw.js      Service worker: offline / home-screen use, one cache generation.
public/net.js     Old WebSocket wrapper (now inlined in transport.js).
server.js         Optional self-host: pairing (4-letter codes), reconnect grace
                  period, WebSocket relay. Never sees game state. /healthz
                  reports open tables.
tools/            Icon generator and a headless sim smoke test.
```

**One world, two windows.** The rink is one coordinate space measured in CSS
pixels of the host screen: the guest's half is `y ∈ [0, H]`, a seam gap
`y ∈ [H, H+G]` stands in for the bezels, and the host's half is
`y ∈ [H+G, 2H+G]`. Each iPad renders only its own window of that space. The
guest is rotated 180° relative to the host, so its mapping flips both axes.
The puck "crosses the seam" because the world is continuous. On one iPad the
`solo` view shows the whole rink.

**Host authority.** The host iPad runs the simulation and streams a compact
snapshot (puck, mallets, score, phase, obstacles, goal widths, and the events
since the last snapshot) about 60 times a second. The guest sends its mallet
position in world coordinates and renders the latest snapshot, extrapolating
the puck along its velocity to hide the few milliseconds of network delay.
Effects and sounds on both iPads are driven by the same event stream.

**Ready, calibrate, rematch.** Every match (and every rematch) starts in the
sim's `ready` phase. The guest sends `{t:'ready'}` when its player presses
down; the host applies it with the host's own press. While the host's
calibration bar is open it also sends `{t:'calib', on:1|0}` so the guest draws
the ring, and each gap change re-sends `{t:'config'}` (the guest swaps its view
in place, no lobby). *Change mode* re-creates the sim on the host and re-sends
`config` over the same socket and table code.

**Transport.** `transport.js` gives main.js one small API (`host`, `join`,
`send`, `leave`, nearby tables) over two backends. *Direct* opens a WebRTC data
channel between the iPads; the two sides find each other in a Trystero room
named after the table code, signaled through public Nostr relays (internet
needed for that step only). *This server* relays the same messages through
`server.js` on a computer. Both report the round-trip time shown in the corner
and rejoin by themselves after a drop, so the game code above does not care
which one is in use.

**Nearby tables.** A hosting iPad announces `{code, mode}` into a discovery
room named after a hash of its public IP; iPads on the same Wi-Fi share that IP
and see the announcement under *Tables near you*. Announcing stops once the
guest joins or the host leaves.

**Updates and offline.** `sw.js` caches every app file as one generation, built
atomically, so an old `main.js` is never mixed with a newer `sim.js`. Pages and
scripts are fetched network-first; the cache is the offline fallback.

## Development

```bash
node tools/sim-smoke.mjs   # headless physics and bot checks for every mode
npm run icons              # regenerate the PNG icons from tools/make-icons.mjs
```

`public/dev/fx-test.html` exercises the renderer and the sounds with a fake
snapshot. In the browser console, `window.__dbg()` shows the live state.

## Not here yet

- Discovery that works without internet on a bare LAN (mDNS needs a native
  app; browsers cannot do it).
- A device catalog with real screen sizes, and an "arrange" step for mixed
  devices or more than two.
- More games on the same engine (hot potato, snake, pong).
