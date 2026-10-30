import { mtof, noiseHit, pluck, tone, type AudioEngine, type At } from './audio';

/**
 * Short world and interface sounds, synthesised on the spot. Creature sounds
 * (footsteps shaped by gait and size, paddling, splashes, digging, wing
 * flutters, rustling trees, fruit, snores) fade with distance from the
 * camera's focus and pan with its angle, so you mostly hear the creatures
 * you are watching. Chimes (hatching, discoveries, picnics, visitors, the
 * Lab) and soft UI taps play on their own bus. Every kind is rate-limited and
 * the engine caps how many overlap, so a busy herd stays a gentle patter.
 */

export type CreatureSound = 'step' | 'paddle' | 'splash' | 'dive' | 'dig' | 'flap' | 'whoosh' | 'shake' | 'pluck' | 'snore' | 'bloom';
export type ChimeSound = 'hatch' | 'discovery' | 'picnic' | 'visitor' | 'welcome' | 'lab' | 'release' | 'click' | 'open' | 'close' | 'toast';

type Play = (e: AudioEngine, out: AudioNode, t: number, size: number, gait: string) => void;

interface Spec {
  /** Peak-ish level on the bus at full fade (size 1). */
  level: number;
  /** Seconds before another sound of this kind may play. */
  gap: number;
  /** How far away it can be heard, in metres (zooming out counts). */
  range: number;
  /** Seconds it lasts, for the overlap budget. */
  dur: number;
  play: Play;
}

/** How each gait sounds underfoot; anything not listed patters. */
const STEP_STYLE: Partial<Record<string, 'tick' | 'shuffle' | 'thump' | 'boing' | 'rumble' | 'none'>> = {
  scuttle: 'tick', creep: 'tick', slither: 'shuffle', inch: 'shuffle', hop: 'thump', bound: 'thump', bounce: 'boing', roll: 'rumble', float: 'none',
};

/** Bigger creatures sound lower: a pitch factor from size. */
const low = (size: number) => 1 / Math.sqrt(Math.max(0.2, size));

const CREATURE: Record<CreatureSound, Spec> = {
  step: {
    level: 0.075, gap: 0.07, range: 15, dur: 0.15,
    play: (e, out, t, size, gait) => {
      const k = low(size);
      switch (STEP_STYLE[gait]) {
        case 'tick':
          noiseHit(e, out, { at: t, dur: 0.035, type: 'bandpass', freq: 2400 * k, q: 1.6, gain: 0.6 });
          return;
        case 'shuffle':
          noiseHit(e, out, { at: t, dur: 0.22, attack: 0.07, type: 'bandpass', freq: 1500 * k, q: 0.8, gain: 0.6 });
          return;
        case 'rumble':
          noiseHit(e, out, { at: t, dur: 0.18, attack: 0.03, type: 'lowpass', freq: 260 * k, q: 0.7, gain: 0.9, pink: true });
          return;
        case 'thump':
        case 'boing':
          noiseHit(e, out, { at: t, dur: 0.09, type: 'lowpass', freq: 520 * k, q: 0.9, gain: 0.9 });
          tone(e, out, { at: t, dur: 0.12, freq: 130 * k, freqEnd: 60 * k, gain: 0.25 });
          if (STEP_STYLE[gait] === 'boing') tone(e, out, { at: t + 0.01, dur: 0.18, freq: 240 * k, freqEnd: 420 * k, glide: 0.12, gain: 0.18, type: 'triangle' });
          return;
        default:
          noiseHit(e, out, { at: t, dur: 0.06, type: 'lowpass', freq: 950 * k, q: 1.2, gain: 1 });
          if (size > 1.2) tone(e, out, { at: t, dur: 0.1, freq: 110 * k, freqEnd: 65 * k, gain: 0.15 });
      }
    },
  },
  paddle: {
    level: 0.065, gap: 0.12, range: 15, dur: 0.2,
    play: (e, out, t, size) => noiseHit(e, out, { at: t, dur: 0.18, attack: 0.04, type: 'bandpass', freq: 600 * low(size), freqEnd: 1000 * low(size), q: 1.4, gain: 1 }),
  },
  splash: {
    level: 0.085, gap: 0.2, range: 25, dur: 0.6,
    play: (e, out, t, size) => {
      const k = low(size);
      noiseHit(e, out, { at: t, dur: 0.35 + size * 0.1, type: 'bandpass', freq: 2400 * k, freqEnd: 500 * k, q: 0.8, gain: 1 });
      for (let i = 0; i < 3; i++) {
        const f = (1100 + Math.random() * 700) * k;
        tone(e, out, { at: t + 0.06 + Math.random() * 0.25, dur: 0.06, freq: f, freqEnd: f * 1.6, glide: 0.03, gain: 0.12, attack: 0.002 });
      }
    },
  },
  dive: {
    level: 0.1, gap: 0.3, range: 25, dur: 0.4,
    play: (e, out, t, size) => {
      const k = low(size);
      tone(e, out, { at: t, dur: 0.16, freq: 260 * k, freqEnd: 760 * k, glide: 0.12, gain: 0.3, attack: 0.01 });
      noiseHit(e, out, { at: t, dur: 0.22, type: 'bandpass', freq: 1500 * k, freqEnd: 600 * k, q: 0.9, gain: 0.6 });
    },
  },
  dig: {
    level: 0.06, gap: 0.12, range: 16, dur: 0.25,
    play: (e, out, t, size) => {
      const k = low(size);
      // Two quick scrapes and a soft thud of earth.
      noiseHit(e, out, { at: t, dur: 0.09, type: 'bandpass', freq: 1300 * k, freqEnd: 800 * k, q: 1.3, gain: 1 });
      noiseHit(e, out, { at: t + 0.09, dur: 0.08, type: 'bandpass', freq: 1000 * k, freqEnd: 650 * k, q: 1.3, gain: 0.7 });
      noiseHit(e, out, { at: t + 0.04, dur: 0.12, type: 'lowpass', freq: 300 * k, q: 0.7, gain: 0.9, pink: true });
    },
  },
  flap: {
    level: 0.075, gap: 0.15, range: 18, dur: 0.3,
    play: (e, out, t, size) => {
      const k = low(size);
      const beat = 0.07 / k;
      for (let i = 0; i < 2; i++) noiseHit(e, out, { at: t + i * beat, dur: 0.07, attack: 0.02, type: 'bandpass', freq: 750 * k, q: 1, gain: i ? 0.7 : 1 });
    },
  },
  whoosh: {
    level: 0.085, gap: 0.4, range: 20, dur: 0.5,
    play: (e, out, t, size) => noiseHit(e, out, { at: t, dur: 0.45, attack: 0.18, type: 'bandpass', freq: 500 * low(size), freqEnd: 1600 * low(size), q: 1.2, gain: 1, pink: true }),
  },
  shake: {
    level: 0.055, gap: 0.6, range: 28, dur: 1.6,
    play: (e, out, t) => {
      // Leaves shiver for a moment, then fruit plops down.
      for (let i = 0; i < 9; i++) noiseHit(e, out, { at: t + i * 0.11 + Math.random() * 0.04, dur: 0.16, attack: 0.03, type: 'bandpass', freq: 3000 + Math.random() * 2500, q: 0.7, gain: (1 - i / 10) * (0.6 + Math.random() * 0.4) });
      for (let i = 0; i < 3; i++) plop(e, out, t + 0.4 + i * 0.18 + Math.random() * 0.1);
    },
  },
  pluck: {
    level: 0.03, gap: 0.1, range: 18, dur: 0.15,
    play: (e, out, t) => tone(e, out, { at: t, dur: 0.07, freq: 520, freqEnd: 1050, glide: 0.03, gain: 1, attack: 0.003 }),
  },
  snore: {
    level: 0.045, gap: 1, range: 11, dur: 1.4,
    play: (e, out, t, size) => {
      const k = low(size);
      noiseHit(e, out, { at: t, dur: 0.9, attack: 0.55, type: 'bandpass', freq: 420 * k, q: 2.2, gain: 1, pink: true });
      tone(e, out, { at: t + 0.85, dur: 0.45, freq: 1000 * k, freqEnd: 760 * k, gain: 0.08, attack: 0.08 });
    },
  },
  bloom: {
    level: 0.028, gap: 0.4, range: 20, dur: 0.6,
    play: (e, out, t) => [93, 98, 102].forEach((m, i) => tone(e, out, { at: t + i * 0.07, dur: 0.25, freq: mtof(m), gain: 1 - i * 0.2, attack: 0.003 })),
  },
};

/** Chimes: notes are MIDI in D major pentatonic, to sit with the music. */
const CHIME: Record<ChimeSound, { level: number; gap: number; dur: number; play: (e: AudioEngine, out: AudioNode, t: number) => void }> = {
  hatch: {
    level: 0.036, gap: 0.3, dur: 1.4,
    play: (e, out, t) => {
      // Crick… crack… pop! and a little rising arpeggio.
      noiseHit(e, out, { at: t, dur: 0.02, type: 'highpass', freq: 2500, gain: 0.5 });
      noiseHit(e, out, { at: t + 0.14, dur: 0.025, type: 'highpass', freq: 2200, gain: 0.6 });
      tone(e, out, { at: t + 0.3, dur: 0.08, freq: 320, freqEnd: 900, glide: 0.05, gain: 0.5, attack: 0.003 });
      notes(e, out, t + 0.42, [74, 78, 81, 86], 0.08, 1.1);
    },
  },
  discovery: {
    level: 0.035, gap: 0.5, dur: 2.5,
    play: (e, out, t) => {
      // A warm swell under three bright bells.
      swell(e, out, t, [62, 69], 0.12, 1.8);
      notes(e, out, t + 0.05, [81, 86, 90], 0.15, 2);
    },
  },
  picnic: {
    level: 0.04, gap: 0.5, dur: 1.4,
    play: (e, out, t) => {
      [74, 78, 81, 78, 86].forEach((m, i) => {
        const at = t + [0, 0.11, 0.22, 0.33, 0.5][i];
        pluck(e, out, mtof(m), at, i === 4 ? 0.9 : 0.6, i === 4 ? 1.2 : 0.5);
        noiseHit(e, out, { at, dur: 0.04, type: 'highpass', freq: 6000, gain: 0.08 });
      });
    },
  },
  visitor: {
    level: 0.046, gap: 1, dur: 2.5,
    play: (e, out, t) => {
      // A gate bell: ding… dong.
      pluck(e, out, mtof(81), t, 0.9, 2.2);
      pluck(e, out, mtof(78), t + 0.38, 0.8, 2.6);
    },
  },
  welcome: {
    level: 0.032, gap: 0.5, dur: 1.2,
    play: (e, out, t) => notes(e, out, t, [78, 81, 86], 0.1, 1.1),
  },
  lab: {
    level: 0.022, gap: 0.5, dur: 1.4,
    play: (e, out, t) => notes(e, out, t, [74, 76, 78, 81, 83, 86], 0.05, 0.9),
  },
  release: {
    level: 0.025, gap: 0.5, dur: 1.4,
    play: (e, out, t) => notes(e, out, t, [81, 78, 74], 0.16, 1.2),
  },
  click: {
    level: 0.012, gap: 0.05, dur: 0.1,
    play: (e, out, t) => tone(e, out, { at: t, dur: 0.04, freq: 1500, freqEnd: 1000, gain: 1, attack: 0.002 }),
  },
  open: {
    level: 0.045, gap: 0.08, dur: 0.2,
    play: (e, out, t) => noiseHit(e, out, { at: t, dur: 0.13, attack: 0.05, type: 'bandpass', freq: 700, freqEnd: 2400, q: 1.5, gain: 1, pink: true }),
  },
  close: {
    level: 0.04, gap: 0.08, dur: 0.2,
    play: (e, out, t) => noiseHit(e, out, { at: t, dur: 0.13, attack: 0.04, type: 'bandpass', freq: 2200, freqEnd: 650, q: 1.5, gain: 1, pink: true }),
  },
  toast: {
    level: 0.0125, gap: 0.3, dur: 0.3,
    play: (e, out, t) => notes(e, out, t, [86, 93], 0.06, 0.35),
  },
};

export class Sfx {
  private readonly lastAt = new Map<string, number>();
  private lastChime = -1;

  constructor(private readonly engine: AudioEngine) {}

  /** A creature makes a sound where it stands. `size` is its full scale (plan size × growth). */
  creature(kind: CreatureSound, at: At, size: number, gait: string) {
    const e = this.engine;
    const spec = CREATURE[kind];
    if (!e.audible('creatures') || !this.free(kind, spec.gap)) return;
    if (kind === 'step' && STEP_STYLE[gait] === 'none') return;
    const out = e.spot('creatures', at, { range: spec.range, level: spec.level * Math.sqrt(Math.max(0.2, size)), dur: spec.dur });
    if (!out) return;
    this.lastAt.set(kind, e.now);
    spec.play(e, out, e.now + 0.01, size, gait);
  }

  /** An event or interface chime; `at` places it in the world but it never fades below half. */
  chime(kind: ChimeSound, at?: At) {
    const e = this.engine;
    const spec = CHIME[kind];
    if (!e.audible('chimes') || !this.free(kind, spec.gap)) return;
    // A toast that arrives with its own chime stays quiet.
    if (kind === 'toast' && e.now - this.lastChime < 0.6) return;
    const out = e.spot('chimes', at ?? null, { range: 40, floor: 0.5, level: spec.level, dur: spec.dur });
    if (!out) return;
    this.lastAt.set(kind, e.now);
    if (kind !== 'click' && kind !== 'open' && kind !== 'close') this.lastChime = e.now;
    spec.play(e, out, e.now + 0.01);
  }

  private free(kind: string, gap: number) {
    return this.engine.now - (this.lastAt.get(kind) ?? -Infinity) >= gap;
  }
}

/** Plucked notes in a row. */
function notes(e: AudioEngine, out: AudioNode, t: number, midi: number[], gap: number, ring: number) {
  midi.forEach((m, i) => pluck(e, out, mtof(m), t + i * gap, 0.85 - i * 0.05, ring));
}

/** A soft swelling chord under a chime. */
function swell(e: AudioEngine, out: AudioNode, t: number, midi: number[], gain: number, dur: number) {
  for (const m of midi) tone(e, out, { at: t, dur, freq: mtof(m), gain, attack: dur * 0.35, type: 'triangle' });
}

/** Fruit landing in the grass: a round little pitch drop and a dull thud. */
function plop(e: AudioEngine, out: AudioNode, t: number) {
  tone(e, out, { at: t, dur: 0.1, freq: 340, freqEnd: 120, gain: 0.7, attack: 0.003 });
  noiseHit(e, out, { at: t, dur: 0.06, type: 'lowpass', freq: 400, gain: 0.5, pink: true });
}
