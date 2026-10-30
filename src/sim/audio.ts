/**
 * The shared sound engine. One AudioContext feeds four buses, each with its
 * own volume and a send to a soft reverb, then a gentle limiter and the
 * master mute:
 *
 *   sound ─► bus ─┬────────────────► mix ─► limiter ─► trim ─► master ─► speakers
 *                 └─► send ─► reverb ─┘
 *
 * Nothing is built until a user gesture calls `unlock()`, and without WebAudio
 * (Node tests, old browsers) every method is a quiet no-op. While muted or in a
 * hidden tab the context is suspended, so sound costs no CPU at all.
 *
 * Also home to the small instruments everything shares: noise hits, tones and
 * a kalimba-like pluck. No samples anywhere: noise and the reverb's impulse
 * are generated when the context is made.
 */

export type SoundGroup = 'ambience' | 'music' | 'creatures' | 'chimes';
export type Volumes = Record<SoundGroup, number>;

export const SOUND_GROUPS: Record<SoundGroup, { label: string; icon: string; blurb: string }> = {
  ambience: { label: 'Ambience', icon: '🌾', blurb: 'Breeze, birdsong, crickets and the pond' },
  music: { label: 'Music', icon: '🎵', blurb: 'A soft tune now and then' },
  creatures: { label: 'Creatures', icon: '🐾', blurb: 'Calls, footsteps, splashes and rustles' },
  chimes: { label: 'Chimes', icon: '🔔', blurb: 'Hatching, discoveries, visitors and buttons' },
};

export const SOUND_GROUP_IDS = Object.keys(SOUND_GROUPS) as SoundGroup[];

/** Slider position (0–1) at which a bus plays at its designed level. */
export const DEFAULT_VOLUME = 0.7;
export const DEFAULT_VOLUMES: Volumes = { ambience: DEFAULT_VOLUME, music: DEFAULT_VOLUME, creatures: DEFAULT_VOLUME, chimes: DEFAULT_VOLUME };

/** Slider to gain: squared so the slider feels even. The default is unity; full is about +6 dB. */
export const volumeGain = (v: number) => (Math.min(1, Math.max(0, v)) / DEFAULT_VOLUME) ** 2;

/** Volumes from a saved setting, filling in anything missing or broken. */
export function reviveVolumes(raw: unknown): Volumes {
  const saved = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<SoundGroup, unknown>>;
  const out = { ...DEFAULT_VOLUMES };
  for (const id of SOUND_GROUP_IDS) {
    const v = saved[id];
    if (typeof v === 'number' && Number.isFinite(v)) out[id] = Math.min(1, Math.max(0, v));
  }
  return out;
}

export interface At {
  x: number;
  z: number;
}

/** Where the player is listening from: the camera's focus, its turn and its zoom. */
export interface Listener extends At {
  yaw: number;
  distance: number;
}

/** How much of each bus goes to the reverb. */
const SENDS: Volumes = { ambience: 0.2, music: 0.42, creatures: 0.12, chimes: 0.3 };
/** How far zooming out counts as moving away, when fading world sounds. */
const ZOOM_WEIGHT = 0.3;
/** One-shot sounds allowed to overlap before new ones are dropped. */
const MAX_ONE_SHOTS = 40;
/**
 * The compressor adds automatic makeup gain (part of the WebAudio spec);
 * this cancels it so quiet sounds pass at unity. Measured in Chromium.
 */
const LIMITER_TRIM = 0.6;

export class AudioEngine {
  ctx: BaseAudioContext | null = null;
  readonly listener: Listener = { x: 0, z: 2, yaw: 0.6, distance: 34 };
  /** A few seconds of white and pink noise for everything that hisses, splashes or rustles. */
  white: AudioBuffer | null = null;
  pink: AudioBuffer | null = null;
  private master: GainNode | null = null;
  private readonly buses = new Map<SoundGroup, { gain: GainNode; send: GainNode }>();
  private volumes: Volumes = { ...DEFAULT_VOLUMES };
  private mute = false;
  private hidden = false;
  private offline = false;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private oneShots: number[] = [];

  /** Browsers only allow audio after a user gesture; call this from one. */
  unlock() {
    if (this.ctx) {
      this.wake();
      return;
    }
    if (typeof window === 'undefined') return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.attach(new Ctor());
    } catch {
      this.ctx = null;
      return;
    }
    if (this.mute) this.sleep();
    else this.wake();
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden;
      if (this.hidden) this.sleep();
      else this.wake();
    });
  }

  /** Build the mixer on a context. Public so an OfflineAudioContext can be used to measure levels. */
  attach(ctx: BaseAudioContext, offline = false) {
    this.ctx = ctx;
    this.offline = offline;
    this.white = noiseBuffer(ctx, false);
    this.pink = noiseBuffer(ctx, true);

    const master = ctx.createGain();
    master.gain.value = this.mute ? 0 : 1;
    master.connect(ctx.destination);
    const trim = ctx.createGain();
    trim.gain.value = LIMITER_TRIM;
    trim.connect(master);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 3;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(trim);
    const mix = ctx.createGain();
    mix.connect(limiter);
    const reverb = ctx.createConvolver();
    reverb.normalize = false;
    reverb.buffer = impulse(ctx, 2.2);
    reverb.connect(mix);

    this.buses.clear();
    for (const id of SOUND_GROUP_IDS) {
      const gain = ctx.createGain();
      gain.gain.value = volumeGain(this.volumes[id]);
      gain.connect(mix);
      const send = ctx.createGain();
      send.gain.value = SENDS[id];
      gain.connect(send);
      send.connect(reverb);
      this.buses.set(id, { gain, send });
    }
    this.master = master;
  }

  /** True when sound is actually playing (unlocked, not muted, not suspended). */
  get running(): boolean {
    const ctx = this.ctx;
    return !!ctx && !this.mute && (this.offline || ctx.state === 'running');
  }

  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  get muted(): boolean {
    return this.mute;
  }

  /** Whether a group can be heard at all, so schedulers can skip their work. */
  audible(group: SoundGroup): boolean {
    return this.running && this.volumes[group] > 0.001;
  }

  bus(group: SoundGroup): AudioNode | null {
    return this.buses.get(group)?.gain ?? null;
  }

  setMuted(muted: boolean) {
    if (muted === this.mute) return;
    this.mute = muted;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const g = this.master.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(g.value, ctx.currentTime);
    g.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.08);
    if (muted) {
      // Let the fade finish, then stop the clock.
      this.sleepTimer ??= setTimeout(() => {
        this.sleepTimer = null;
        if (this.mute) this.sleep();
      }, 600);
    } else {
      this.wake();
    }
  }

  setVolume(group: SoundGroup, v: number) {
    this.volumes[group] = Math.min(1, Math.max(0, v));
    const bus = this.buses.get(group);
    if (bus && this.ctx) bus.gain.gain.setTargetAtTime(volumeGain(v), this.ctx.currentTime, 0.05);
  }

  /** Change how much of a bus goes to the reverb, gliding over `seconds`. */
  setSend(group: SoundGroup, level: number, seconds = 4) {
    const bus = this.buses.get(group);
    if (bus && this.ctx) bus.send.gain.setTargetAtTime(level, this.ctx.currentTime, seconds / 3);
  }

  /** 0–1 loudness for a sound at a ground point, falling off over `range` metres (zooming out counts). */
  fade(at: At, range: number): number {
    const l = this.listener;
    const d = Math.hypot(at.x - l.x, at.z - l.z, l.distance * ZOOM_WEIGHT);
    const k = Math.max(0, 1 - d / range);
    return k * k;
  }

  /** Stereo position (-1 left … 1 right) of a ground point as the camera sees it. */
  pan(at: At): number {
    const l = this.listener;
    const dx = at.x - l.x;
    const dz = at.z - l.z;
    const side = dx * Math.cos(l.yaw) - dz * Math.sin(l.yaw);
    return Math.max(-1, Math.min(1, side / (Math.hypot(dx, dz) + l.distance * ZOOM_WEIGHT + 2))) * 0.8;
  }

  /**
   * An input for one short sound: a gain (faded by distance when `at` is
   * given, never below `floor`) and a panner (toward `at`, or by `pan`), on a
   * bus. Null when the sound would be too quiet, or too many are playing.
   */
  spot(group: SoundGroup, at: At | null, o: { range?: number; level?: number; floor?: number; dur?: number; pan?: number } = {}): GainNode | null {
    const ctx = this.ctx;
    const bus = this.buses.get(group);
    if (!ctx || !bus || !this.audible(group)) return null;
    const floor = o.floor ?? 0;
    const fade = at ? floor + (1 - floor) * this.fade(at, o.range ?? 30) : 1;
    if (fade < 0.03 || !this.claim(o.dur ?? 1)) return null;
    const out = ctx.createGain();
    out.gain.value = (o.level ?? 1) * fade;
    if ((at || o.pan) && ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = at ? this.pan(at) : o.pan ?? 0;
      out.connect(pan);
      pan.connect(bus.gain);
    } else {
      out.connect(bus.gain);
    }
    return out;
  }

  /** Reserve a one-shot slot for `seconds`; false when the budget is full. */
  private claim(seconds: number): boolean {
    const now = this.now;
    if (this.oneShots.length >= MAX_ONE_SHOTS) this.oneShots = this.oneShots.filter((end) => end > now);
    if (this.oneShots.length >= MAX_ONE_SHOTS) return false;
    this.oneShots.push(now + seconds);
    return true;
  }

  /** Resume the clock, unless muted or hidden. */
  private wake() {
    const ctx = this.ctx as AudioContext | null;
    if (!ctx || this.offline || this.mute || this.hidden) return;
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  private sleep() {
    const ctx = this.ctx as AudioContext | null;
    if (!ctx || this.offline || ctx.state !== 'running') return;
    ctx.suspend().catch(() => {});
  }
}

// ---- Generated buffers -------------------------------------------------

/** Seconds of looping noise. Pink (Paul Kellet's filter) is softer, for wind and water. */
function noiseBuffer(ctx: BaseAudioContext, pink: boolean, seconds = 4): AudioBuffer {
  const rate = ctx.sampleRate;
  const n = Math.floor(rate * seconds);
  const overlap = Math.floor(rate * 0.05);
  const raw = new Float32Array(n + overlap);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < raw.length; i++) {
    const w = Math.random() * 2 - 1;
    if (!pink) {
      raw[i] = w;
      continue;
    }
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.2;
    b6 = w * 0.115926;
  }
  const buffer = ctx.createBuffer(1, n, rate);
  const data = buffer.getChannelData(0);
  data.set(raw.subarray(0, n));
  // Cross-fade the overrun into the start so the loop has no seam.
  for (let i = 0; i < overlap; i++) {
    const k = i / overlap;
    data[i] = raw[i] * k + raw[n + i] * (1 - k);
  }
  return buffer;
}

/** A soft outdoor-ish reverb tail: stereo noise that decays and darkens, normalised to unit energy. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const n = Math.floor(rate * seconds);
  const pre = Math.floor(rate * 0.015);
  const buffer = ctx.createBuffer(2, n, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buffer.getChannelData(ch);
    let lp = 0;
    let energy = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / rate;
      lp += (0.07 + 0.6 * Math.exp(-t * 2.5)) * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp((-6.9 * t) / seconds);
      energy += d[i] * d[i];
    }
    const scale = 1 / Math.sqrt(energy || 1);
    for (let i = pre; i < n; i++) d[i] *= scale;
  }
  return buffer;
}

// ---- Shared instruments ------------------------------------------------

export const mtof = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** Quick rise to `peak`, then an exponential fall that is all but silent by `at + dur`. */
export function pluckEnvelope(p: AudioParam, at: number, attack: number, dur: number, peak: number) {
  p.setValueAtTime(0, at);
  p.linearRampToValueAtTime(peak, at + attack);
  p.setTargetAtTime(0, at + attack, Math.max(0.004, (dur - attack) / 5));
}

export interface NoiseHit {
  at: number;
  dur: number;
  gain: number;
  freq: number;
  /** Sweep the filter to here over the sound. */
  freqEnd?: number;
  type?: BiquadFilterType;
  q?: number;
  attack?: number;
  pink?: boolean;
}

/** A burst of filtered noise: the base of footsteps, splashes, scuffs and rustles. */
export function noiseHit(e: AudioEngine, out: AudioNode, o: NoiseHit) {
  const ctx = e.ctx;
  const buffer = o.pink ? e.pink : e.white;
  if (!ctx || !buffer) return;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = o.type ?? 'bandpass';
  filter.Q.value = o.q ?? 1;
  filter.frequency.setValueAtTime(o.freq, o.at);
  if (o.freqEnd) filter.frequency.exponentialRampToValueAtTime(o.freqEnd, o.at + o.dur);
  const env = ctx.createGain();
  pluckEnvelope(env.gain, o.at, o.attack ?? 0.004, o.dur, o.gain);
  src.connect(filter);
  filter.connect(env);
  env.connect(out);
  src.start(o.at, Math.random() * Math.max(0, buffer.duration - o.dur - 0.2));
  src.stop(o.at + o.dur + 0.05);
}

export interface Tone {
  at: number;
  dur: number;
  gain: number;
  freq: number;
  /** Glide to here over `glide` seconds (default: the whole sound). */
  freqEnd?: number;
  glide?: number;
  type?: OscillatorType;
  attack?: number;
}

/** One oscillator note with a pluck envelope. */
export function tone(e: AudioEngine, out: AudioNode, o: Tone) {
  const ctx = e.ctx;
  if (!ctx) return;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, o.at);
  if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, o.at + (o.glide ?? o.dur));
  const env = ctx.createGain();
  pluckEnvelope(env.gain, o.at, o.attack ?? 0.005, o.dur, o.gain);
  osc.connect(env);
  env.connect(out);
  osc.start(o.at);
  osc.stop(o.at + o.dur + 0.05);
}

/** A soft kalimba-like pluck: a ringing sine, a little octave body and a brief inharmonic tine. */
export function pluck(e: AudioEngine, out: AudioNode, freq: number, at: number, vel: number, ring = 1.6) {
  tone(e, out, { at, dur: ring, freq, gain: vel, attack: 0.004 });
  tone(e, out, { at, dur: ring * 0.3, freq: freq * 2, gain: vel * 0.14, attack: 0.003 });
  if (freq * 6.27 < 12000) tone(e, out, { at, dur: 0.1, freq: freq * 6.27, gain: vel * 0.06, attack: 0.002 });
}
