import type { Rng } from '../core/rng';
import { mtof, pluck, type AudioEngine } from './audio';

/**
 * Gentle generative music: short pieces of slow pad chords under a sparse
 * kalimba melody, with long rests between them so the meadow gets its quiet
 * too. The melody only ever plays D major pentatonic, so nothing clashes; at
 * night the same notes sit over minor chords, lower, slower and wetter.
 *
 * `composePiece` is pure and seeded (and unit tested); `Music` plays pieces
 * on the audio clock with a short look-ahead.
 */

export type MusicMood = 'day' | 'night';

/** D major pentatonic (D E F♯ A B), as pitch classes. */
export const SCALE_CLASSES = [2, 4, 6, 9, 11];

interface Chord {
  /** Pad voicing as MIDI notes. */
  pad: number[];
  bass: number;
  /** Pitch classes the melody likes to land on at the start of the chord. */
  home: number[];
}

const CHORDS: Record<string, Chord> = {
  Dmaj7: { pad: [50, 57, 61, 66], bass: 50, home: [2, 6, 9] },
  Bm7: { pad: [47, 54, 57, 62], bass: 47, home: [11, 2, 6] },
  Gmaj7: { pad: [55, 59, 62, 66], bass: 43, home: [11, 2, 6] },
  Asus: { pad: [57, 62, 64, 71], bass: 45, home: [9, 4, 2] },
  Em7: { pad: [52, 55, 59, 62], bass: 40, home: [4, 11, 2] },
  'D/F#': { pad: [54, 57, 62, 64], bass: 42, home: [6, 9, 2] },
  // Night voicings sit lower and closer.
  Bm9: { pad: [47, 54, 57, 61], bass: 47, home: [11, 2, 6] },
  Gmaj9: { pad: [50, 54, 55, 59], bass: 43, home: [11, 2, 9] },
  Em9: { pad: [52, 55, 59, 66], bass: 40, home: [4, 11, 6] },
  'F#m7': { pad: [54, 57, 61, 64], bass: 42, home: [6, 9, 4] },
  Asus2: { pad: [57, 59, 64], bass: 45, home: [9, 11, 4] },
};

const PROGRESSIONS: Record<MusicMood, string[][]> = {
  day: [
    ['Dmaj7', 'Bm7', 'Gmaj7', 'Asus'],
    ['Gmaj7', 'D/F#', 'Em7', 'Asus'],
    ['Dmaj7', 'Gmaj7', 'Bm7', 'Asus'],
    ['Gmaj7', 'Asus', 'Dmaj7', 'Bm7'],
  ],
  night: [
    ['Bm9', 'Gmaj9', 'Em9', 'F#m7'],
    ['Em9', 'Bm9', 'Gmaj9', 'Asus2'],
    ['Bm9', 'Em9', 'Bm9', 'Gmaj9'],
  ],
};

/** Melody rhythms for one chord, in beats from its start. */
const CELLS: Record<MusicMood, number[][]> = {
  day: [[0, 1, 2], [0, 1.5, 3, 4], [0, 0.5, 1, 2, 4], [2, 3, 4, 6], [0, 2, 3, 3.5, 4], [0, 3, 4], [1, 1.5, 2, 4, 5]],
  night: [[0, 2], [0, 3, 4], [1, 2, 4], [0, 1.5, 3], [2, 4]],
};

/** Melody steps along the scale, weighted toward small ones. */
const STEPS: [number, number][] = [[-3, 0.4], [-2, 1], [-1, 3], [0, 0.6], [1, 3], [2, 1], [3, 0.4]];

const MOODS: Record<MusicMood, { bpm: [number, number]; range: [number, number]; tonic: number; rest: number; passes: [number, number] }> = {
  day: { bpm: [68, 76], range: [69, 88], tonic: 2, rest: 0.15, passes: [2, 2] },
  night: { bpm: [52, 58], range: [62, 79], tonic: 11, rest: 0.3, passes: [1, 2] },
};

export const BEATS_PER_CHORD = 8;

export interface PieceNote {
  part: 'melody' | 'pad' | 'bass';
  beat: number;
  /** How long it is meant to last, in beats. */
  beats: number;
  /** One note for melody and bass, the whole voicing for a pad. */
  midi: number[];
  vel: number;
}

export interface Piece {
  mood: MusicMood;
  bpm: number;
  /** Total length in beats, including the last chord's ring-out. */
  beats: number;
  notes: PieceNote[];
}

/** Every MIDI note of the scale between lo and hi. */
export function scaleNotes(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (SCALE_CLASSES.includes(m % 12)) out.push(m);
  return out;
}

/** One short piece: a progression played once or twice, with a melody that returns to its motifs. */
export function composePiece(rng: Rng, mood: MusicMood): Piece {
  const m = MOODS[mood];
  const pick = <T>(list: readonly T[]) => list[Math.floor(rng() * list.length)];
  const bpm = Math.round(m.bpm[0] + rng() * (m.bpm[1] - m.bpm[0]));
  const progression = pick(PROGRESSIONS[mood]);
  const passes = m.passes[0] + Math.floor(rng() * (m.passes[1] - m.passes[0] + 1));
  const chords = Array.from({ length: passes }, () => progression).flat().map((id) => CHORDS[id]);
  const scale = scaleNotes(m.range[0], m.range[1]);
  const notes: PieceNote[] = [];
  let idx = Math.floor(scale.length / 2);
  let motif: { rhythm: number[]; steps: number[] } | null = null;

  const nearest = (from: number, classes: number[]) => {
    for (let d = 0; d < scale.length; d++) {
      for (const i of [from - d, from + d]) if (i >= 0 && i < scale.length && classes.includes(scale[i] % 12)) return i;
    }
    return from;
  };
  const step = () => {
    let r = rng() * STEPS.reduce((s, [, w]) => s + w, 0);
    for (const [s, w] of STEPS) if ((r -= w) <= 0) return s;
    return 0;
  };

  chords.forEach((chord, c) => {
    const at = c * BEATS_PER_CHORD;
    const last = c === chords.length - 1;
    notes.push({ part: 'pad', beat: at, beats: BEATS_PER_CHORD + (last ? 4 : 0), midi: chord.pad, vel: 1 });
    notes.push({ part: 'bass', beat: at, beats: BEATS_PER_CHORD, midi: [chord.bass], vel: 1 });
    // The first chord is an intro more often than not.
    if (!last && rng() < (c === 0 ? 0.55 : m.rest)) return;

    const reuse = motif && rng() < 0.45;
    const rhythm = reuse ? motif!.rhythm : pick(CELLS[mood]);
    const steps = reuse ? motif!.steps : rhythm.map(() => step());
    motif = { rhythm, steps };
    idx = nearest(idx, chord.home);
    rhythm.forEach((beat, i) => {
      if (i > 0) {
        // Bounce off the ends of the range rather than piling up there.
        const s = idx + steps[i] < 1 || idx + steps[i] > scale.length - 2 ? -steps[i] : steps[i];
        idx = Math.max(0, Math.min(scale.length - 1, idx + s));
      }
      const next = rhythm[i + 1] ?? beat + 2;
      notes.push({ part: 'melody', beat: at + beat, beats: next - beat, midi: [scale[idx]], vel: i === 0 ? 0.9 : 0.6 + rng() * 0.25 });
    });
    if (last) {
      // End on the home note, held.
      const end = Math.max(rhythm[rhythm.length - 1] + 1.5, 5);
      idx = nearest(idx, [m.tonic]);
      notes.push({ part: 'melody', beat: at + end, beats: 4, midi: [scale[idx]], vel: 0.8 });
    }
  });
  notes.sort((a, b) => a.beat - b.beat);
  return { mood, bpm, beats: chords.length * BEATS_PER_CHORD + 4, notes };
}

// ---- Playback ----------------------------------------------------------

/** Seconds of notes scheduled ahead of the clock. */
const LOOKAHEAD = 0.5;
/** Peak level of each part on the Music bus, before the volume slider. */
const LEVEL = { melody: 0.022, pad: 0.0022, bass: 0.007 };
/** Seconds of quiet between pieces. */
const REST: Record<MusicMood, [number, number]> = { day: [25, 60], night: [35, 80] };
/** How much of the music goes to the reverb. */
const WET: Record<MusicMood, number> = { day: 0.42, night: 0.6 };

export class Music {
  private piece: Piece | null = null;
  private start = 0;
  private cursor = 0;
  private nextAt = -1;
  private melodyOut: BiquadFilterNode | null = null;

  constructor(private readonly engine: AudioEngine, private readonly rng: Rng = Math.random) {}

  /** Call every frame; `sunHeight` (1 noon, -1 midnight) picks the mood of the next piece. */
  update(sunHeight: number) {
    const e = this.engine;
    if (!e.audible('music')) {
      // Off or muted: let the current piece go; a new one starts a little after it comes back.
      this.piece = null;
      this.nextAt = -1;
      return;
    }
    const now = e.now;
    if (this.nextAt < 0) this.nextAt = now + 6 + this.rng() * 6;
    if (!this.piece) {
      if (now < this.nextAt) return;
      this.begin(sunHeight < 0.02 ? 'night' : 'day', now + 0.2);
    }
    const piece = this.piece!;
    const beat = 60 / piece.bpm;
    while (this.cursor < piece.notes.length) {
      const n = piece.notes[this.cursor];
      const t = this.start + n.beat * beat;
      if (t > now + LOOKAHEAD) break;
      this.cursor++;
      // Notes missed while the page stalled are skipped, not crammed in.
      if (t > now - 0.05) this.play(n, t, beat, piece.mood);
    }
    if (this.cursor >= piece.notes.length && now > this.start + piece.beats * beat) {
      this.piece = null;
      const [lo, hi] = REST[piece.mood];
      this.nextAt = now + lo + this.rng() * (hi - lo);
    }
  }

  private begin(mood: MusicMood, at: number) {
    this.piece = composePiece(this.rng, mood);
    this.start = at;
    this.cursor = 0;
    this.engine.setSend('music', WET[mood]);
  }

  private play(n: PieceNote, t: number, beat: number, mood: MusicMood) {
    const e = this.engine;
    const ctx = e.ctx;
    const bus = e.bus('music');
    if (!ctx || !bus) return;
    const dur = n.beats * beat;
    if (n.part === 'melody') {
      if (this.melodyOut?.context !== ctx) {
        // Takes the edge off the tine.
        this.melodyOut = ctx.createBiquadFilter();
        this.melodyOut.type = 'lowpass';
        this.melodyOut.frequency.value = 5200;
        this.melodyOut.connect(bus);
      }
      const ring = Math.min(3, Math.max(1.3, dur * 1.6)) * (mood === 'night' ? 1.3 : 1);
      const humanise = this.rng() * 0.012;
      pluck(e, this.melodyOut, mtof(n.midi[0]), t + humanise, LEVEL.melody * n.vel * (mood === 'night' ? 0.85 : 1), ring);
    } else if (n.part === 'pad') {
      this.pad(ctx, bus, n.midi, t, dur, mood);
    } else {
      this.bass(ctx, bus, n.midi[0], t, dur);
    }
  }

  /** Slow-breathing chord: two detuned triangles per note through one soft low-pass. */
  private pad(ctx: BaseAudioContext, bus: AudioNode, midi: number[], t: number, dur: number, mood: MusicMood) {
    const attack = Math.min(2.5, dur / 2);
    const release = 3.5;
    const end = t + dur + release;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.4;
    const open = mood === 'night' ? 620 : 900;
    filter.frequency.setValueAtTime(open * 0.6, t);
    filter.frequency.linearRampToValueAtTime(open, t + dur * 0.5);
    filter.frequency.linearRampToValueAtTime(open * 0.6, end);
    filter.connect(bus);
    for (const m of midi) {
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(LEVEL.pad, t + attack);
      env.gain.setValueAtTime(LEVEL.pad, t + dur);
      env.gain.linearRampToValueAtTime(0, end);
      env.connect(filter);
      for (const cents of [-7, 7]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = mtof(m);
        osc.detune.value = cents;
        osc.connect(env);
        osc.start(t);
        osc.stop(end + 0.05);
      }
    }
  }

  /** A warm low note: a sine with a little octave so small speakers still hint at it. */
  private bass(ctx: BaseAudioContext, bus: AudioNode, midi: number, t: number, dur: number) {
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(LEVEL.bass, t + 0.15);
    env.gain.setTargetAtTime(0, t + 0.15, dur / 3);
    env.connect(bus);
    for (const [ratio, level] of [[1, 1], [2, 0.3]]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = mtof(midi) * ratio;
      g.gain.value = level;
      osc.connect(g);
      g.connect(env);
      osc.start(t);
      osc.stop(t + dur + 1);
    }
  }
}
