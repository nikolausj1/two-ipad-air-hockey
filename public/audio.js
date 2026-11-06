// Synthesized sound effects (Web Audio only, no sample files).
//
//   const audio = createAudio();
//   button.onclick = () => audio.unlock();        // must run inside a user gesture on iOS
//   audio.onEvents(snap.ev, snap);                // once per distinct snapshot
//   audio.setMuted(true);
//
// Until unlock() has produced a running AudioContext, onEvents() does nothing.
// Nothing here ever throws: if Web Audio is missing, every call is a no-op.
//
// 'over' needs to know whether the local player won. Pass the snapshot as the
// second argument of onEvents (it carries .wn) and, once, call
// setPerspective('host' | 'guest' | 'solo'). Solo is treated as the host
// (the player at the bottom). Without that information a win jingle plays.

const MAX_VOICES = 18; // concurrent sound events (each is a few nodes)

export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let muted = false;
  let perspective = 'host';
  let voices = 0;
  const lastPlayed = {}; // kind -> ctx time, for de-duplication
  const MASTER_GAIN = 0.8;

  function unlock() {
    try {
      if (!ctx) {
        const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (!AC) return;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : MASTER_GAIN;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.knee.value = 12;
        comp.ratio.value = 6;
        comp.attack.value = 0.003;
        comp.release.value = 0.15;
        master.connect(comp);
        comp.connect(ctx.destination);
        // One second of white noise, reused by every noise burst.
        const len = ctx.sampleRate;
        noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        if (ctx.addEventListener) {
          ctx.addEventListener('statechange', () => {
            // iOS sets 'interrupted' after a phone call or Siri; try to come back.
            if (ctx && (ctx.state === 'interrupted' || ctx.state === 'suspended')) safeResume();
          });
        }
      }
      safeResume();
      // iOS: playing a (silent) buffer inside the gesture fully unlocks output.
      const b = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* audio is optional */
    }
  }

  function safeResume() {
    try {
      if (ctx && ctx.state !== 'running' && ctx.resume) {
        const p = ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  function setMuted(m) {
    muted = !!m;
    try {
      if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, ctx.currentTime, 0.02);
    } catch {
      /* ignore */
    }
  }

  function setPerspective(role) {
    perspective = role === 'guest' ? 'guest' : 'host';
  }

  // --- building blocks ------------------------------------------------------------

  function env(g, t, attack, peak, dur) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  function noise(t, dur, type, freq, q, gain, sweepTo) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    env(g, t, 0.002, gain, dur);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  function tone(t, type, freq, dur, gain, endFreq, attack, lp) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = ctx.createGain();
    env(g, t, attack || 0.004, gain, dur);
    let out = o;
    if (lp) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lp;
      o.connect(f);
      out = f;
    }
    out.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  // Sustained note with a soft release (horn, jingle).
  function note(t, type, freq, dur, gain, lp, detune) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (detune) o.detune.value = detune;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lp || 2200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.015);
    g.gain.setValueAtTime(gain, t + Math.max(0.02, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f);
    f.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  // --- sounds -----------------------------------------------------------------------

  function hit(t, s) {
    const v = 0.22 + 0.6 * s;
    noise(t, 0.045, 'bandpass', 1800 + s * 1600, 1.2, v * 0.8);
    tone(t, 'triangle', 420 + s * 520, 0.07, v * 0.7, 170, 0.002);
    tone(t, 'sine', 130 + s * 40, 0.1, v * 0.55 * (0.4 + s), 55, 0.002);
  }

  function wall(t, s) {
    const v = 0.1 + 0.18 * s;
    noise(t, 0.03, 'highpass', 3200, 0.7, v);
    tone(t, 'triangle', 780 + s * 300, 0.04, v * 0.6, 520, 0.002);
  }

  function bumper(t, s) {
    const v = 0.2 + 0.2 * s;
    tone(t, 'sine', 880, 0.55, v, null, 0.002);
    tone(t, 'sine', 2430, 0.35, v * 0.45, null, 0.002);
    tone(t, 'sine', 1320, 0.45, v * 0.3, null, 0.002);
    noise(t, 0.03, 'bandpass', 3500, 1.5, v * 0.5);
  }

  function mine(t) {
    tone(t, 'sine', 150, 0.75, 0.9, 32, 0.004);
    tone(t, 'sawtooth', 90, 0.5, 0.25, 30, 0.004, 400);
    noise(t, 0.6, 'lowpass', 1400, 0.8, 0.7, 120);
    noise(t + 0.02, 0.18, 'highpass', 2500, 0.6, 0.3);
  }

  // A bomb gets knocked by the puck: a dull low thud.
  function bombhit(t, s) {
    const v = 0.25 + 0.55 * s;
    tone(t, 'sine', 110, 0.12, v, 55, 0.002);
    noise(t, 0.08, 'lowpass', 600, 0.7, v * 0.45);
  }

  // A mallet touched an armed bomb: heavier than a mine, then a sad two-note "uh-oh".
  function bomb(t) {
    tone(t, 'sine', 120, 0.95, 0.95, 26, 0.004);
    tone(t, 'sine', 48, 0.7, 0.8, 28, 0.003); // sub thump
    tone(t, 'sawtooth', 70, 0.6, 0.25, 26, 0.004, 350);
    noise(t, 0.95, 'lowpass', 1200, 0.8, 0.75, 90);
    noise(t + 0.015, 0.22, 'highpass', 2200, 0.6, 0.32);
    note(t + 0.25, 'triangle', 330, 0.16, 0.24, 1600);
    note(t + 0.4, 'triangle', 262, 0.24, 0.24, 1400);
  }

  // The puck is about to jump: two tiny high blips.
  function glitchwarn(t) {
    tone(t, 'square', 1760, 0.025, 0.05, null, 0.002);
    tone(t + 0.06, 'square', 1760, 0.025, 0.05, null, 0.002);
  }

  // The puck jumped: a digital zap.
  function glitch(t) {
    tone(t, 'square', 900, 0.12, 0.16, 180, 0.002);
    noise(t, 0.05, 'highpass', 4000, 0.7, 0.2);
    tone(t, 'sine', 140, 0.04, 0.2, 70, 0.001);
  }

  function goal(t, scored) {
    // Two-tone horn. Scoring is bright and rising, conceding is lower and falling.
    const a = scored ? 349 : 311;
    const b = scored ? 523 : 233;
    note(t, 'sawtooth', a, 0.3, 0.2, 1800);
    note(t, 'sawtooth', a, 0.3, 0.2, 1800, 9);
    note(t + 0.3, 'sawtooth', b, 0.65, 0.22, 1800);
    note(t + 0.3, 'sawtooth', b, 0.65, 0.2, 1800, -9);
    note(t + 0.3, 'square', b / 2, 0.65, 0.08, 900);
    if (scored) noise(t + 0.3, 0.8, 'bandpass', 3000, 0.5, 0.1);
  }

  function countdown(t, left) {
    if (left <= 1) {
      tone(t, 'sine', 1320, 0.28, 0.32, null, 0.004);
      tone(t, 'triangle', 1980, 0.2, 0.1, null, 0.004);
    } else {
      tone(t, 'sine', 660, 0.13, 0.26, null, 0.004);
    }
  }

  function serve(t) {
    noise(t, 0.18, 'bandpass', 900, 1.0, 0.08, 3200);
  }

  function win(t) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < notes.length; i++) {
      const dur = i === notes.length - 1 ? 0.7 : 0.15;
      note(t + i * 0.14, 'triangle', notes[i], dur, 0.28, 3200);
      note(t + i * 0.14, 'sine', notes[i] * 2, dur, 0.08, 4000);
    }
  }

  function lose(t) {
    note(t, 'triangle', 392, 0.22, 0.26, 1600);
    note(t + 0.2, 'triangle', 311, 0.22, 0.26, 1500);
    note(t + 0.4, 'triangle', 233, 0.6, 0.26, 1200);
    tone(t + 0.4, 'sine', 116, 0.6, 0.2, 80, 0.01);
  }

  // --- battle sounds ---------------------------------------------------------------

  // An item box was collected: a bright three-note pickup chime.
  function box(t) {
    const f = [880, 1174.7, 1568];
    for (let i = 0; i < f.length; i++) {
      tone(t + i * 0.055, 'triangle', f[i], 0.2, 0.2, null, 0.003);
      tone(t + i * 0.055, 'sine', f[i] * 2, 0.16, 0.06, null, 0.003);
    }
    noise(t, 0.05, 'highpass', 5000, 0.7, 0.07);
  }

  // A box (re)appeared: one soft, quiet blip.
  function boxspawn(t) {
    tone(t, 'sine', 1318, 0.14, 0.05, 1760, 0.01);
  }

  // An item was fired: a click, then an accent per item.
  function use(t, item) {
    noise(t, 0.02, 'highpass', 3000, 0.8, 0.14);
    tone(t, 'square', 1500, 0.025, 0.07, 900, 0.001);
    switch (item) {
      case 'rocket':
        noise(t + 0.02, 0.28, 'bandpass', 500, 1.2, 0.12, 2200);
        tone(t + 0.02, 'sawtooth', 110, 0.26, 0.1, 340, 0.01, 900);
        break;
      case 'shield':
        note(t + 0.02, 'sine', 220, 0.55, 0.14, 700);
        note(t + 0.02, 'sine', 330, 0.55, 0.1, 700, 6);
        note(t + 0.02, 'triangle', 440, 0.5, 0.05, 900, -6);
        break;
      case 'ghost':
        tone(t + 0.02, 'sine', 1500, 0.55, 0.12, 420, 0.03);
        tone(t + 0.02, 'sine', 1508, 0.55, 0.08, 424, 0.03);
        noise(t + 0.02, 0.5, 'bandpass', 2800, 2, 0.05, 700);
        break;
      case 'shrink':
        tone(t + 0.02, 'square', 1900, 0.2, 0.09, 380, 0.004, 3200);
        tone(t + 0.14, 'square', 1300, 0.14, 0.06, 300, 0.004, 3200);
        break;
      case 'freeze': {
        const f = [2093, 2637, 3136];
        for (let i = 0; i < f.length; i++) tone(t + 0.02 + i * 0.05, 'sine', f[i], 0.5, 0.09, null, 0.004);
        noise(t + 0.02, 0.12, 'highpass', 6000, 0.7, 0.06);
        break;
      }
      case 'magnet':
        // humming wobble that pulls upwards
        tone(t + 0.02, 'sawtooth', 160, 0.32, 0.08, 330, 0.01, 700);
        tone(t + 0.02, 'sine', 320, 0.32, 0.1, 660, 0.01);
        tone(t + 0.02, 'sine', 324, 0.32, 0.06, 664, 0.01);
        break;
      case 'widegoal':
        // two notes stepping apart
        tone(t + 0.02, 'triangle', 523, 0.22, 0.12, 392, 0.004);
        tone(t + 0.02, 'triangle', 659, 0.22, 0.12, 880, 0.004);
        break;
      case 'goalie':
        // short whistle pair
        tone(t + 0.02, 'sine', 1568, 0.08, 0.12, null, 0.003);
        tone(t + 0.12, 'sine', 2093, 0.12, 0.12, null, 0.003);
        break;
      case 'giant':
        // deep swell
        tone(t + 0.02, 'sine', 70, 0.4, 0.3, 140, 0.03);
        tone(t + 0.02, 'square', 140, 0.35, 0.05, 280, 0.03, 600);
        break;
      case 'catch':
        // a soft cupped pop
        tone(t + 0.02, 'sine', 660, 0.1, 0.14, 990, 0.003);
        noise(t + 0.02, 0.06, 'bandpass', 900, 3, 0.08);
        break;
      case 'mirror':
        // shimmering up-and-down glass sweep
        tone(t + 0.02, 'sine', 1200, 0.18, 0.08, 2400, 0.004);
        tone(t + 0.2, 'sine', 2400, 0.22, 0.07, 1200, 0.004);
        noise(t + 0.02, 0.3, 'bandpass', 6000, 3, 0.04);
        break;
      case 'quake':
        // low rumble
        tone(t + 0.02, 'sawtooth', 48, 0.5, 0.18, 36, 0.02, 220);
        noise(t + 0.02, 0.5, 'lowpass', 260, 0.8, 0.3, 120);
        break;
      case 'decoys':
        // three quick blips fanning out
        tone(t + 0.02, 'square', 880, 0.05, 0.06, null, 0.002);
        tone(t + 0.07, 'square', 1046, 0.05, 0.06, null, 0.002);
        tone(t + 0.12, 'square', 1318, 0.05, 0.06, null, 0.002);
        break;
      case 'steal':
        // sly two-note slide down
        tone(t + 0.02, 'triangle', 988, 0.12, 0.12, 740, 0.003);
        tone(t + 0.13, 'triangle', 740, 0.16, 0.12, 494, 0.003);
        break;
      case 'tinypuck':
        // rapid falling chirp
        tone(t + 0.02, 'sine', 2600, 0.16, 0.1, 5200, 0.002);
        tone(t + 0.1, 'sine', 3400, 0.1, 0.06, 6000, 0.002);
        break;
      default:
        break;
    }
  }

  // The rocket hit: a whoosh that rises and then falls away, with a thump.
  function rocket(t) {
    noise(t, 0.5, 'bandpass', 400, 0.9, 0.34, 3200);
    noise(t + 0.2, 0.45, 'bandpass', 3200, 0.9, 0.2, 700);
    tone(t, 'sawtooth', 90, 0.4, 0.2, 420, 0.01, 1100);
    tone(t, 'sine', 140, 0.14, 0.4, 55, 0.003);
  }

  // The puck bounced off a shield: a metallic ping.
  function shieldhit(t, s) {
    const v = 0.12 + 0.16 * s;
    tone(t, 'sine', 1760, 0.4, v, null, 0.001);
    tone(t, 'sine', 1760 * 2.76, 0.28, v * 0.5, null, 0.001);
    tone(t, 'sine', 1760 * 5.4, 0.16, v * 0.3, null, 0.001);
    noise(t, 0.02, 'highpass', 5000, 0.7, v * 0.5);
  }

  // The frozen puck lets go: a dry crack and a few ticks.
  function thaw(t) {
    noise(t, 0.05, 'highpass', 3500, 0.7, 0.3);
    tone(t, 'square', 2400, 0.03, 0.09, 600, 0.001);
    tone(t + 0.045, 'square', 1800, 0.025, 0.06, 500, 0.001);
    tone(t + 0.09, 'square', 2900, 0.02, 0.05, 700, 0.001);
    tone(t + 0.02, 'sine', 3136, 0.3, 0.05, null, 0.004);
  }

  // The goalie blocked the puck: a firm glove smack.
  function goaliehit(t, s) {
    const v = 0.18 + 0.4 * s;
    noise(t, 0.05, 'bandpass', 1200, 1, v * 0.7);
    tone(t, 'triangle', 300 + s * 200, 0.08, v * 0.6, 150, 0.002);
  }

  // The puck was caught: a soft thump and a little rising lock tone.
  function catchSnd(t) {
    tone(t, 'sine', 180, 0.12, 0.35, 90, 0.002);
    tone(t + 0.03, 'triangle', 660, 0.12, 0.1, 990, 0.004);
  }

  // The caught puck was thrown: a whoosh scaled by speed.
  function fling(t, s) {
    noise(t, 0.18 + 0.1 * s, 'bandpass', 600, 1, 0.12 + 0.2 * s, 2800 + 1200 * s);
    tone(t, 'sine', 140, 0.08, 0.2 + 0.2 * s, 60, 0.002);
  }

  // Decoys spawn: a split shimmer.
  function decoys(t) {
    tone(t, 'sine', 1100, 0.25, 0.08, 700, 0.004);
    tone(t, 'sine', 1400, 0.25, 0.06, 1900, 0.004);
    noise(t, 0.08, 'highpass', 5000, 0.7, 0.05);
  }

  // An item was stolen: a quick snatch and a pickup ding.
  function steal(t, got) {
    noise(t, 0.08, 'bandpass', 2000, 1.5, 0.12, 5000);
    tone(t + 0.06, 'triangle', got ? 1318 : 988, 0.16, 0.14, null, 0.003);
  }

  // The magnet let go: a falling buzz.
  function magnetoff(t) {
    tone(t, 'sawtooth', 300, 0.18, 0.08, 120, 0.004, 900);
  }

  // Two pucks touched: a sharp plastic clack.
  function clack(t, s) {
    const v = 0.16 + 0.5 * s;
    noise(t, 0.03, 'bandpass', 2600, 1.5, v * 0.8);
    tone(t, 'triangle', 900 + s * 400, 0.04, v * 0.5, 500, 0.001);
  }

  // The hot potato blew: as big as a bomb, no sad tag.
  function potato(t) {
    tone(t, 'sine', 120, 0.9, 0.95, 26, 0.004);
    tone(t, 'sine', 48, 0.7, 0.8, 28, 0.003);
    tone(t, 'sawtooth', 70, 0.6, 0.25, 26, 0.004, 350);
    noise(t, 0.9, 'lowpass', 1300, 0.8, 0.75, 90);
    noise(t + 0.015, 0.22, 'highpass', 2200, 0.6, 0.32);
  }

  // The wind turns: an airy gust.
  function wind(t) {
    noise(t, 0.7, 'bandpass', 500, 0.8, 0.14, 1400);
    noise(t + 0.2, 0.5, 'bandpass', 1400, 0.8, 0.06, 500);
  }

  // The gravity well swallows the puck: a downward gulp.
  function swallow(t) {
    tone(t, 'sine', 600, 0.3, 0.25, 60, 0.004);
    noise(t, 0.25, 'lowpass', 1500, 1, 0.12, 200);
  }

  // The well spits the puck out: a rising pop.
  function spit(t) {
    tone(t, 'sine', 90, 0.18, 0.3, 600, 0.002);
    noise(t, 0.1, 'bandpass', 1500, 1, 0.16, 4000);
  }

  // Turbo: a zip whose pitch climbs with the multiplier.
  function turbo(t, s) {
    const f = 500 + 1100 * s;
    tone(t, 'sawtooth', f, 0.12, 0.06, f * 1.8, 0.003, 3000);
    tone(t, 'sine', f * 2, 0.1, 0.05, f * 3, 0.003);
  }

  // Minimum spacing between two sounds of the same kind, in seconds.
  const SPACING = { hit: 0.03, wall: 0.04, bumper: 0.05, mine: 0.1, bombhit: 0.05, bomb: 0.5, glitchwarn: 0.3, glitch: 0.3, goal: 0.5, countdown: 0.3, serve: 0.3, over: 1, box: 0.12, boxspawn: 0.3, use: 0.15, rocket: 0.4, shieldhit: 0.12, thaw: 0.3,
    goaliehit: 0.05, catch: 0.2, fling: 0.2, decoys: 0.3, steal: 0.3, magnetoff: 0.2, clack: 0.05, potato: 0.5, wind: 0.5, swallow: 0.3, spit: 0.3, turbo: 0.08 };

  function play(ev, snap) {
    const kind = ev.k;
    const gap = SPACING[kind];
    if (gap == null) return;
    const t = ctx.currentTime + 0.005;
    const last = lastPlayed[kind];
    if (last !== undefined && t - last < gap) return;
    // Voice cap: cheap sounds are dropped first.
    const cheap = kind === 'wall' || kind === 'serve' || kind === 'clack' || kind === 'turbo';
    if (voices >= MAX_VOICES || (cheap && voices >= MAX_VOICES - 6)) return;
    lastPlayed[kind] = t;
    const s = ev.s == null ? 0.6 : Math.min(1, Math.max(0, ev.s));
    let dur = 0.3;
    switch (kind) {
      case 'hit': hit(t, s); dur = 0.25; break;
      case 'wall': wall(t, s); dur = 0.1; break;
      case 'bumper': bumper(t, s); dur = 0.7; break;
      case 'mine': mine(t); dur = 0.9; break;
      case 'bombhit': bombhit(t, s); dur = 0.2; break;
      case 'bomb': bomb(t); dur = 1.1; break;
      case 'glitchwarn': glitchwarn(t); dur = 0.2; break;
      case 'glitch': glitch(t); dur = 0.25; break;
      case 'box': box(t); dur = 0.4; break;
      case 'boxspawn': boxspawn(t); dur = 0.2; break;
      case 'use': use(t, ev.item); dur = 0.7; break;
      case 'rocket': rocket(t); dur = 0.7; break;
      case 'shieldhit': shieldhit(t, s); dur = 0.5; break;
      case 'thaw': thaw(t); dur = 0.4; break;
      case 'goaliehit': goaliehit(t, s); dur = 0.15; break;
      case 'catch': catchSnd(t); dur = 0.2; break;
      case 'fling': fling(t, s); dur = 0.35; break;
      case 'decoys': decoys(t); dur = 0.3; break;
      case 'steal': steal(t, ev.got); dur = 0.3; break;
      case 'magnetoff': magnetoff(t); dur = 0.2; break;
      case 'clack': clack(t, s); dur = 0.1; break;
      case 'potato': potato(t); dur = 1; break;
      case 'wind': wind(t); dur = 0.75; break;
      case 'swallow': swallow(t); dur = 0.35; break;
      case 'spit': spit(t); dur = 0.25; break;
      case 'turbo': turbo(t, s); dur = 0.15; break;
      case 'goal': {
        const scored = ev.by ? ev.by === perspective || (ev.by === 'host' && perspective === 'solo') : true;
        goal(t, scored);
        dur = 1.3;
        break;
      }
      case 'countdown': countdown(t, ev.s == null ? 3 : ev.s); dur = 0.4; break;
      case 'serve': serve(t); dur = 0.3; break;
      case 'over': {
        const wn = (snap && snap.wn) || ev.by || null;
        if (wn && wn !== perspective) lose(t);
        else win(t);
        dur = 1.4;
        break;
      }
      default: return;
    }
    voices++;
    setTimeout(() => {
      voices = Math.max(0, voices - 1);
    }, dur * 1000);
  }

  function onEvents(evs, snap) {
    if (!ctx || !evs || !evs.length) return;
    try {
      if (ctx.state !== 'running') {
        safeResume();
        if (ctx.state !== 'running') return;
      }
      const n = Math.min(evs.length, 12);
      for (let i = 0; i < n; i++) if (evs[i]) play(evs[i], snap);
    } catch (e) {
      /* never let audio break the game loop */
      if (typeof console !== 'undefined') console.warn('audio:', e && e.message);
    }
  }

  return {
    unlock,
    onEvents,
    setMuted,
    setPerspective,
    get muted() {
      return muted;
    },
  };
}
