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

  // Minimum spacing between two sounds of the same kind, in seconds.
  const SPACING = { hit: 0.03, wall: 0.04, bumper: 0.05, mine: 0.1, goal: 0.5, countdown: 0.3, serve: 0.3, over: 1 };

  function play(ev, snap) {
    const kind = ev.k;
    const gap = SPACING[kind];
    if (gap == null) return;
    const t = ctx.currentTime + 0.005;
    const last = lastPlayed[kind];
    if (last !== undefined && t - last < gap) return;
    // Voice cap: cheap sounds are dropped first.
    const cheap = kind === 'wall' || kind === 'serve';
    if (voices >= MAX_VOICES || (cheap && voices >= MAX_VOICES - 6)) return;
    lastPlayed[kind] = t;
    const s = ev.s == null ? 0.6 : Math.min(1, Math.max(0, ev.s));
    let dur = 0.3;
    switch (kind) {
      case 'hit': hit(t, s); dur = 0.25; break;
      case 'wall': wall(t, s); dur = 0.1; break;
      case 'bumper': bumper(t, s); dur = 0.7; break;
      case 'mine': mine(t); dur = 0.9; break;
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
