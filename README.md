# Two iPad Air Hockey

Air hockey across two iPads laid **top edge against top edge**, in the browser.
The puck slides off one screen and onto the other. No app, no account: both
iPads open a page served from your Mac on the same Wi-Fi. One iPad is enough
too: play against a bot, or two people on one iPad flat on the table.

Inspired by [bigboard.games](https://bigboard.games/), where phones pushed
together become one board.

## Run it

```bash
npm install
npm start
```

The terminal prints a URL such as `http://192.168.x.x:3000`. On each iPad open
it in Safari (same Wi-Fi as the Mac). For a full-screen feel use
Share → Add to Home Screen and launch it from there.

**Two iPads**

1. On the first iPad: *Two iPads* → pick a mode → *Host a table*. It shows a
   4-letter code and a QR code.
2. On the second iPad: scan the QR code (it opens the page and joins), or open
   the URL and tap *Join the open table*, or type the code.
3. Lay the iPads flat, top edge touching top edge, each player at the bottom of
   their own iPad. Grab your mallet. First to 5, 7 or 11 wins.

**One iPad**: *Solo vs bot* (four bot levels) or *Pass & play* (one finger per
half). Tap *Start*.

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
- **Pause menu** (the small button top-left): Resume, Restart, Fullscreen,
  Sound, Quit.
- **Reconnect**: if an iPad loses Wi-Fi or reloads, it rejoins the same table
  automatically. The host keeps the score while the other iPad is away.
- **Latency readout** in the corner during two-iPad play.
- **Home screen app**: manifest and icons, so it installs like an app.

## Host options

- **Seam gap**: millimetres of bezel between the two screens. Raise it if the
  puck seems to jump at the seam, lower it if it seems to pause. Default 16.
- **First to**: 5, 7 or 11 goals.
- All choices are remembered on the device.

## How it works

```
server.js         Pairing (4-letter codes), reconnect grace period, WebSocket relay.
                  Never sees game state. /healthz reports open tables.
public/main.js    Lobby, pairing, input, pause menu, the per-frame loop.
public/sim.js     Host-authoritative physics in one shared world space, modes,
                  comeback rule, event stream.
public/bot.js     The bot that drives the guest mallet in solo play.
public/view.js    Maps world <-> screen for each role and draws the rink, HUD.
public/fx.js      Particles, flashes, screen shake.
public/audio.js   Web Audio synth for every event.
public/net.js     WebSocket wrapper with automatic reconnect.
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

**Transport.** Plain WebSockets through the Mac acting as relay. On a local
network that is a couple of milliseconds. bigboard uses WebRTC data channels
with a relay fallback; that is the natural next step if you want the iPads to
talk directly or to play from anywhere.

## Development

```bash
node tools/sim-smoke.mjs   # headless physics and bot checks for every mode
npm run icons              # regenerate the PNG icons from tools/make-icons.mjs
```

`public/dev/fx-test.html` exercises the renderer and the sounds with a fake
snapshot. In the browser console, `window.__dbg()` shows the live state.

## Not here yet

- Automatic discovery of the other iPad without a code (bigboard matches
  devices by public IP).
- A device catalog with real screen sizes, and an "arrange" step for mixed
  devices or more than two.
- More games on the same engine (hot potato, snake, pong).
