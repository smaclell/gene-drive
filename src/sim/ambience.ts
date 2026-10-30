import { smoothstep, type Rng } from '../core/rng';
import { POND } from '../world/layout';
import { tone, type AudioEngine, type At } from './audio';

/**
 * The meadow's sound bed, following the day/night cycle. A few long-lived
 * nodes carry the beds: a stereo breeze with slow gusts and a hiss of leaves,
 * water lapping that swells as the camera nears the pond, and night crickets
 * gated into chirps. Birds by day, frogs and an owl by night and droplets by
 * the pond are short one-shots on the audio clock. Day and night crossfade
 * through dusk, so nothing switches abruptly.
 */

/** Level of each layer on the Ambience bus at full strength, before the volume slider. */
const LEVEL = { breeze: 0.065, leaves: 0.017, water: 0.14, crickets: 0.009, birds: 0.016, frogs: 0.048, owl: 0.015, drip: 0.016 };

type Song = 'whistle' | 'trill' | 'warble' | 'coo' | 'owl';
/** One note of a call: [start, length, from Hz, to Hz, loudness]. */
type Note = [number, number, number, number, number];

interface Bird {
  song: Song;
  freq: number;
  pan: number;
  level: number;
  weight: number;
}

interface Gust {
  swell: GainNode;
  band: BiquadFilterNode;
  next: number;
}

interface Cricket {
  gate: GainNode;
  next: number;
  period: number;
  pulses: number;
  /** Chirps left before it pauses. */
  left: number;
}

export class Ambience {
  private built = false;
  /** 1 in daylight, 0 at night, eased. */
  private day = 1;
  /** 1 at the pond's edge, 0 far away. */
  private pondNear = 0;
  private mixIn = 0;
  private gusts: Gust[] = [];
  private cricketVoices: Cricket[] = [];
  private birds: Bird[] = [];
  private nodes: {
    breeze: GainNode; leaves: GainNode; leafSwell: GainNode; water: GainNode; waterPan: StereoPannerNode | null;
    lap: GainNode; lapBand: BiquadFilterNode; crickets: GainNode;
  } | null = null;
  private next = { lap: 0, bird: 0, frog: 0, owl: 0, drip: 0 };

  constructor(private readonly engine: AudioEngine, private readonly rng: Rng = Math.random) {}

  /** Call every frame with real seconds and the sun's height (1 noon, -1 midnight). */
  update(dt: number, sunHeight: number) {
    const e = this.engine;
    if (!e.audible('ambience')) return;
    const daylight = smoothstep(-0.12, 0.2, sunHeight);
    if (!this.built) this.build(daylight);
    this.day += (daylight - this.day) * Math.min(1, dt * 0.5);
    const now = e.now;
    this.mixIn -= dt;
    if (this.mixIn <= 0) {
      this.mixIn = 0.25;
      this.mix(now);
    }
    this.scheduleGusts(now);
    this.scheduleWater(now);
    this.scheduleCrickets(now);
    this.scheduleWildlife(now);
  }

  private build(daylight: number) {
    const e = this.engine;
    const ctx = e.ctx;
    const bus = e.bus('ambience');
    if (!ctx || !bus || !e.pink || !e.white) return;
    this.built = true;
    this.day = daylight;
    const now = ctx.currentTime;
    const r = this.rng;
    const loop = (buffer: AudioBuffer, offset: number) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.start(now, offset);
      return src;
    };
    const gain = (value: number, to: AudioNode) => {
      const g = ctx.createGain();
      g.gain.value = value;
      g.connect(to);
      return g;
    };
    const filter = (type: BiquadFilterType, freq: number, q: number, to: AudioNode) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      f.connect(to);
      return f;
    };
    /** A panner into `to`, or `to` itself where panning is missing. */
    const panTo = (pan: number, to: AudioNode): AudioNode => {
      if (!ctx.createStereoPanner) return to;
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(to);
      return p;
    };

    // Breeze: two bands of pink noise panned apart, each gusting on its own.
    const breeze = gain(0, bus);
    const air = filter('lowpass', 1400, 0.5, breeze);
    [[-0.6, 0], [0.6, 2]].forEach(([side, offset]) => {
      const swell = gain(0.5, panTo(side, air));
      const band = filter('bandpass', 400, 0.7, swell);
      loop(e.pink!, offset).connect(band);
      this.gusts.push({ swell, band, next: now + r() * 2 });
    });

    // Leaves: a soft high hiss that rises with the gusts.
    const leaves = gain(0, bus);
    const leafSwell = gain(0.2, leaves);
    loop(e.white, 1).connect(filter('bandpass', 5200, 0.6, leafSwell));

    // Water: a low lapping band that sits toward the pond.
    const waterPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    waterPan?.connect(bus);
    const water = gain(0, waterPan ?? bus);
    const lap = gain(0.2, water);
    const lapBand = filter('bandpass', 480, 0.9, lap);
    loop(e.pink, 3).connect(filter('lowpass', 1100, 0.5, lapBand));

    // Crickets: steady high tones, gated into chirps by the scheduler.
    const crickets = gain(0, bus);
    for (const [freq, pan, period, pulses] of [[4600, -0.45, 0.62, 3], [4950, 0.4, 0.78, 4], [4300, 0.05, 0.7, 3]]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq * (0.97 + r() * 0.06);
      const gate = gain(0, panTo(pan, crickets));
      osc.connect(gate);
      osc.start(now);
      this.cricketVoices.push({ gate, next: now + r(), period, pulses, left: 8 });
    }

    // A few resident birds, so the same voices answer each other all day.
    this.birds = [
      { song: 'whistle', freq: 3500 + r() * 600, pan: -0.5 + r() * 0.3, level: 0.8, weight: 1 },
      { song: 'warble', freq: 2700 + r() * 600, pan: 0.2 + r() * 0.4, level: 0.8, weight: 1 },
      { song: 'trill', freq: 4000 + r() * 700, pan: -0.3 + r() * 0.6, level: 0.6, weight: 0.7 },
      // Low notes sound quieter, so the dove sings a little louder.
      { song: 'coo', freq: 540 + r() * 80, pan: r() * 1.2 - 0.6, level: 1.8, weight: 0.45 },
    ];
    this.nodes = { breeze, leaves, leafSwell, water, waterPan, lap, lapBand, crickets };
    this.next = { lap: now, bird: now + 2 + r() * 4, frog: now + 3 + r() * 5, owl: now + 20 + r() * 30, drip: now + 2 };
  }

  /** Ease each bed toward its level for the time of day and where the camera is. */
  private mix(now: number) {
    const n = this.nodes;
    if (!n) return;
    const l = this.engine.listener;
    const edge = Math.max(0, Math.hypot(l.x - POND.x, l.z - POND.z) - POND.r);
    const near = Math.max(0, 1 - Math.hypot(edge, l.distance * 0.3) / 26);
    this.pondNear = near * near;
    const set = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, 0.6);
    set(n.breeze.gain, LEVEL.breeze * (0.6 + 0.4 * this.day));
    set(n.leaves.gain, LEVEL.leaves * (0.5 + 0.5 * this.day));
    set(n.water.gain, LEVEL.water * (0.1 + 0.9 * this.pondNear));
    if (n.waterPan) set(n.waterPan.pan, this.engine.pan(POND) * (1 - this.pondNear));
    set(n.crickets.gain, LEVEL.crickets * this.crickets);
  }

  private get crickets() {
    return smoothstep(0.35, 0.9, 1 - this.day);
  }

  private scheduleGusts(now: number) {
    const leafSwell = this.nodes?.leafSwell;
    for (const g of this.gusts) {
      if (g.next > now + 0.2) continue;
      const t = Math.max(g.next, now);
      const strength = 0.3 + 0.7 * this.rng() ** 2;
      const glide = 1 + this.rng() * 2;
      g.swell.gain.setTargetAtTime(strength, t, glide);
      g.band.frequency.setTargetAtTime(220 + 520 * strength * (0.7 + 0.3 * this.rng()), t, glide);
      if (g === this.gusts[0]) leafSwell?.gain.setTargetAtTime(0.08 + strength * strength, t, glide * 0.7);
      g.next = t + 2.5 + this.rng() * 5;
    }
  }

  private scheduleWater(now: number) {
    const n = this.nodes;
    if (!n) return;
    if (this.next.lap <= now + 0.2) {
      const t = Math.max(this.next.lap, now);
      n.lap.gain.setTargetAtTime(0.55 + 0.45 * this.rng(), t, 0.2);
      n.lap.gain.setTargetAtTime(0.15, t + 0.5 + this.rng() * 0.4, 0.55);
      n.lapBand.frequency.setTargetAtTime(330 + this.rng() * 330, t, 0.3);
      this.next.lap = t + 1.5 + this.rng() * 1.8;
    }
    if (now >= this.next.drip) {
      this.next.drip = now + 1.2 + this.rng() * 4;
      if (this.pondNear < 0.1) return;
      const a = this.rng() * Math.PI * 2;
      const r = this.rng() * POND.r * 0.7;
      const at = { x: POND.x + Math.cos(a) * r, z: POND.z + Math.sin(a) * r };
      const out = this.engine.spot('ambience', at, { range: 30, level: LEVEL.drip, dur: 0.2 });
      const f = 900 + this.rng() * 700;
      if (out) tone(this.engine, out, { at: now + 0.02, dur: 0.09, freq: f, freqEnd: f * 2.2, glide: 0.04, gain: 1, attack: 0.002 });
    }
  }

  private scheduleCrickets(now: number) {
    const on = this.crickets > 0.01;
    for (const c of this.cricketVoices) {
      if (!on) {
        c.next = Math.max(c.next, now);
        continue;
      }
      while (c.next < now + 0.3) {
        const t = Math.max(c.next, now + 0.01);
        chirp(c.gate.gain, t, c.pulses);
        c.next = t + c.period * (0.94 + this.rng() * 0.12);
        if (--c.left <= 0) {
          // Crickets pause now and then, which keeps the chorus from droning.
          c.left = 6 + Math.floor(this.rng() * 16);
          c.next += 1.5 + this.rng() * 5;
        }
      }
    }
  }

  private scheduleWildlife(now: number) {
    const r = this.rng;
    const night = 1 - this.day;
    if (now >= this.next.bird) {
      this.next.bird = now + (3 + r() * 9) / (0.35 + 0.65 * this.day);
      if (this.day > 0.2) {
        const bird = this.pickBird();
        this.sing(bird.song, bird.freq, now + 0.05, { pan: bird.pan, level: LEVEL.birds * bird.level * this.day });
        // Sometimes another answers.
        const other = this.pickBird();
        if (other !== bird && r() < 0.3) this.sing(other.song, other.freq, now + 1.6 + r() * 1.5, { pan: other.pan, level: LEVEL.birds * other.level * this.day });
      }
    }
    if (now >= this.next.owl) {
      this.next.owl = now + 30 + r() * 50;
      if (night > 0.7) this.sing('owl', 340 + r() * 60, now + 0.05, { pan: r() * 1.4 - 0.7, level: LEVEL.owl * night });
    }
    if (now >= this.next.frog) {
      this.next.frog = now + 3 + r() * 8;
      if (night > 0.4) {
        const a = r() * Math.PI * 2;
        const at = { x: POND.x + Math.cos(a) * POND.r, z: POND.z + Math.sin(a) * POND.r };
        this.frog(at, now + 0.05, LEVEL.frogs * night);
        if (r() < 0.4) this.frog({ x: POND.x - Math.cos(a) * POND.r, z: POND.z - Math.sin(a) * POND.r }, now + 0.6 + r() * 0.8, LEVEL.frogs * night * 0.7);
      }
    }
  }

  private pickBird(): Bird {
    let roll = this.rng() * this.birds.reduce((s, b) => s + b.weight, 0);
    for (const b of this.birds) if ((roll -= b.weight) <= 0) return b;
    return this.birds[0];
  }

  /** A bird or owl call: one sine, its pitch and loudness drawn note by note. */
  private sing(song: Song, freq: number, at: number, o: { pan: number; level: number }) {
    const e = this.engine;
    const ctx = e.ctx;
    const notes = songNotes(song, freq, this.rng);
    const end = notes.reduce((m, [s, len]) => Math.max(m, s + len), 0);
    const out = e.spot('ambience', null, { pan: o.pan, level: o.level, dur: end + (at - e.now) });
    if (!ctx || !out) return;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    env.gain.value = 0;
    const attack = song === 'coo' || song === 'owl' ? 0.08 : 0.012;
    for (const [start, len, f0, f1, amp] of notes) {
      const t = at + start;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f1, t + len);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(amp, t + Math.min(attack, len / 3));
      env.gain.linearRampToValueAtTime(0, t + len);
    }
    osc.connect(env);
    env.connect(out);
    osc.start(at);
    osc.stop(at + end + 0.05);
  }

  /** A frog by the pond: a low buzzy "rib-bit", or the high peep of a tiny one. */
  private frog(at: At, t: number, level: number) {
    const e = this.engine;
    const ctx = e.ctx;
    const out = e.spot('ambience', at, { range: 45, floor: 0.15, level, dur: 0.5 + (t - e.now) });
    if (!ctx || !out) return;
    if (this.rng() < 0.35) {
      const f = 2500 + this.rng() * 500;
      tone(e, out, { at: t, dur: 0.16, freq: f, freqEnd: f * 1.18, gain: 0.35, attack: 0.04 });
      tone(e, out, { at: t + 0.45, dur: 0.16, freq: f, freqEnd: f * 1.18, gain: 0.3, attack: 0.04 });
      return;
    }
    const f = 130 + this.rng() * 70;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.linearRampToValueAtTime(f * 0.92, t + 0.12);
    osc.frequency.setValueAtTime(f * 1.06, t + 0.16);
    osc.frequency.linearRampToValueAtTime(f * 0.9, t + 0.3);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = f * 4.5;
    band.Q.value = 2.5;
    const env = ctx.createGain();
    env.gain.value = 0;
    // "rib" then "bit": quick buzzy pulses.
    [0, 0.032, 0.064, 0.16, 0.192, 0.224, 0.256].forEach((p, i) => chirpPulse(env.gain, t + p, 0.026, i < 3 ? 0.8 : 1));
    osc.connect(band);
    band.connect(env);
    env.connect(out);
    osc.start(t);
    osc.stop(t + 0.35);
  }
}

/** One soft-edged pulse on a gate. */
function chirpPulse(p: AudioParam, t: number, len: number, peak = 1) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + 0.005);
  p.setValueAtTime(peak, t + len - 0.006);
  p.linearRampToValueAtTime(0, t + len);
}

/** A cricket chirp: a few quick pulses. */
function chirp(p: AudioParam, t: number, pulses: number) {
  for (let i = 0; i < pulses; i++) chirpPulse(p, t + i * 0.027, 0.017);
}

function songNotes(song: Song, f: number, r: Rng): Note[] {
  switch (song) {
    case 'whistle': {
      // "fee-bee", sometimes "fee-bee-bee".
      const notes: Note[] = [[0, 0.3, f, f * 0.99, 1], [0.4, 0.32, f * 0.84, f * 0.83, 0.8]];
      if (r() < 0.4) notes.push([0.8, 0.3, f * 0.84, f * 0.83, 0.65]);
      return notes;
    }
    case 'trill': {
      const n = 7 + Math.floor(r() * 6);
      return Array.from({ length: n }, (_, i) => [i * 0.075, 0.05, f * 0.9, f * 1.12, Math.sin((Math.PI * (i + 0.5)) / n) ** 0.5] as Note);
    }
    case 'warble': {
      const notes: Note[] = [];
      let t = 0;
      let from = f;
      const n = 4 + Math.floor(r() * 4);
      for (let i = 0; i < n; i++) {
        const len = 0.07 + r() * 0.08;
        const to = f * (0.8 + r() * 0.5);
        notes.push([t, len, from, to, 0.6 + r() * 0.4]);
        from = to * (0.9 + r() * 0.2);
        t += len + 0.03 + r() * 0.06;
      }
      return notes;
    }
    case 'coo':
      // A dove: "coo-OO, coo, coo".
      return [[0, 0.3, f * 0.92, f * 1.04, 0.7], [0.4, 0.55, f * 1.1, f * 0.95, 1], [1.12, 0.42, f, f * 0.93, 0.75], [1.66, 0.42, f, f * 0.93, 0.6]];
    case 'owl':
      return [[0, 0.4, f * 1.02, f * 0.96, 1], [0.75, 0.22, f, f * 0.97, 0.75], [1.05, 0.55, f * 1.02, f * 0.94, 0.9]];
  }
}
