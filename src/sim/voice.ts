import type { BodyPlan, Timbre } from '../genetics/phenotype';

/**
 * Procedural creature voices with WebAudio. No samples: each call is a few
 * oscillator notes. Pitch comes from the body (big creatures rumble, tiny ones
 * squeak) and timbre from the voice gene. Quiet by design, distance-faded,
 * and rate-limited so a busy herd never gets noisy.
 */

export type Mood = 'hello' | 'happy' | 'sleepy' | 'song' | 'surprise';

/** Notes for each mood as [semitones from base pitch, start time, length] in seconds. */
const PHRASES: Record<Mood, [number, number, number][]> = {
  hello: [[0, 0, 0.12], [4, 0.13, 0.14]],
  happy: [[0, 0, 0.09], [4, 0.1, 0.09], [7, 0.2, 0.16]],
  sleepy: [[0, 0, 0.35], [-5, 0.32, 0.45]],
  surprise: [[-3, 0, 0.06], [9, 0.07, 0.14]],
  // Song: a little pentatonic tune, rebuilt from the creature so each one has its own.
  song: [],
};

const PENTATONIC = [0, 2, 4, 7, 9, 12, 14];

export class Voices {
  muted = false;
  /** Where the listener is (the camera's focus), for distance fading. */
  readonly listener = { x: 0, z: 0 };
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private quietUntil = 0;

  /** Browsers only allow audio after a user gesture; call this from one. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.22;
    this.master.connect(this.ctx.destination);
  }

  /**
   * A creature makes a sound. `at` is its ground position; `loud` skips the
   * distance fade and the rate limit (for sounds the player asked for).
   */
  call(plan: BodyPlan, mood: Mood, at: { x: number; z: number } | null, loud = false) {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (!loud && now < this.quietUntil) return;
    const dist = at ? Math.hypot(at.x - this.listener.x, at.z - this.listener.z) : 0;
    const volume = loud ? 1 : Math.max(0, 1 - dist / 30) * 0.7;
    if (volume < 0.05) return;
    this.quietUntil = now + 0.6;

    const phrase = mood === 'song' ? songFor(plan) : PHRASES[mood];
    const out = ctx.createGain();
    out.gain.value = volume * (mood === 'sleepy' ? 0.6 : 1);
    out.connect(this.master);
    for (const [semi, start, len] of phrase) {
      note(ctx, out, plan.voice.timbre, plan.voice.pitch * Math.pow(2, semi / 12), now + start, len);
    }
  }
}

function songFor(plan: BodyPlan): [number, number, number][] {
  // Seeded by the pitch so a creature always hums its own tune.
  let seed = Math.floor(plan.voice.pitch * 1000) >>> 0;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: 6 }, (_, i) => [PENTATONIC[Math.floor(next() * PENTATONIC.length)] - 5, i * 0.2, 0.18] as [number, number, number]);
}

/** One note with an envelope, shaped by timbre. */
function note(ctx: AudioContext, out: AudioNode, timbre: Timbre, freq: number, at: number, len: number) {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(1, at + 0.015);
  env.gain.exponentialRampToValueAtTime(0.001, at + len);
  osc.connect(env);
  let tail: AudioNode = env;

  switch (timbre) {
    case 'honk': {
      // Buzzy and low-passed, with a little droop.
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq * 0.5, at);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.42, at + len);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = freq * 2.5;
      env.connect(lp);
      tail = lp;
      break;
    }
    case 'coo':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * 0.8, at);
      osc.frequency.linearRampToValueAtTime(freq * 0.72, at + len);
      break;
    case 'chirp':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, at);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.6, at + len * 0.8);
      break;
    case 'trill': {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq * 1.2, at);
      // Warble: a fast vibrato.
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 28;
      depth.gain.value = freq * 0.08;
      lfo.connect(depth);
      depth.connect(osc.frequency);
      lfo.start(at);
      lfo.stop(at + len + 0.05);
      break;
    }
  }
  tail.connect(out);
  osc.start(at);
  osc.stop(at + len + 0.05);
}
