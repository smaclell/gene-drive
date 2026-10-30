import * as THREE from 'three';
import { noise3 } from '../core/noise';
import { makeId, mulberry32, type Rng } from '../core/rng';
import { creatureMaterials } from '../creature/materials';
import { discoveriesFor, discoveryById } from '../genetics/discoveries';
import { breed, express, randomGenome, reviveGenome, type Genome, type Mutation } from '../genetics/genome';
import { childName, randomName } from '../genetics/names';
import { planFromGenome } from '../genetics/phenotype';
import { hatchReport, type HatchReport } from '../genetics/report';
import { gatePoint, randomLandPoint, terrainHeight } from '../world/layout';
import type { World } from '../world/scenery';
import { reviveVolumes, type SoundGroup, type Volumes } from './audio';
import { BABY_SCALE, Creature, PRODUCE, PRODUCE_IDS, type CreatureRecord, type Produce } from './creature';
import { Effects } from './effects';
import type { CreatureSound } from './sfx';
import { Sound } from './sound';
import { VISITOR_THEMES, pickTheme, themeBias } from './visitors';
import type { Mood } from './voice';

/**
 * The ranch: owns the herd, eggs, produce, visitors and the Journal, and
 * persists them. UI talks to the game through this class.
 */

export const HERD_CAP = 30;
export const WELCOME_COST = 3;
export const LAB_COST = 15;
const HATCH_SECONDS = 10;
/** Seconds a parent rests after laying an egg. */
const BREED_COOLDOWN = 30;
/** Seconds a wild visitor waits to be welcomed. */
const VISITOR_STAY = 120;
/** Seconds between visitors at the default rate, before charm shortens it. */
const VISITOR_GAP: [number, number] = [150, 240];
const SAVE_KEY = 'gene-drive-save-v1';
/** Settings survive "Start a new ranch", so they live under their own key. */
const SETTINGS_KEY = 'gene-drive-settings-v1';

export type VisitorRate = 'often' | 'sometimes' | 'rarely' | 'off';

export const VISITOR_RATES: Record<VisitorRate, { label: string; factor: number }> = {
  often: { label: 'Often', factor: 0.5 },
  sometimes: { label: 'Sometimes', factor: 1 },
  rarely: { label: 'Rarely', factor: 2.5 },
  off: { label: 'Never', factor: Infinity },
};

export interface Settings {
  visitors: VisitorRate;
  /** Master mute (the 🔊 button). */
  muted: boolean;
  /** Volume of each sound group, 0–1. */
  volumes: Volumes;
}

export type Resources = Record<Produce, number>;

export interface ToastAction {
  label: string;
  run: () => void;
  /** Keep the toast open after the button is pressed. */
  keep?: boolean;
}

export interface Toast {
  text: string;
  detail?: string;
  icon?: string;
  action?: ToastAction;
  /** More buttons, shown after `action`. */
  actions?: ToastAction[];
  /** Seconds before it fades; 0 keeps it until dismissed. */
  life?: number;
  /** Closes the toast early once this returns true (e.g. the visitor left). */
  stale?: () => boolean;
}

interface Egg {
  id: string;
  mesh: THREE.Mesh;
  x: number;
  z: number;
  hatchAt: number;
  genome: Genome;
  mutations: Mutation[];
  parentIds: [string, string];
  parentNames: [string, string];
  parentGenomes: [Genome, Genome];
  name: string;
  generation: number;
}

interface SaveData {
  v: 1;
  time: number;
  resources: Resources;
  journal: string[];
  creatures: CreatureRecord[];
  eggs: { genome: Genome; mutations: Mutation[]; parentIds: [string, string]; parentNames: [string, string]; parentGenomes: [Genome, Genome]; x: number; z: number; hatchIn: number; name: string; generation: number }[];
  labFreeUsed: boolean;
  visitorIn: number;
}

export class Ranch {
  readonly creatures: Creature[] = [];
  readonly eggs: Egg[] = [];
  readonly effects: Effects;
  readonly journal = new Set<string>();
  resources: Resources = { fruit: 0, roots: 0, nectar: 0, shells: 0 };
  time = 75;
  labFreeUsed = false;
  isNight = false;
  settings: Settings = loadSettings();
  readonly sound = new Sound();
  readonly voices = this.sound.voices;
  /** Hooks the UI fills in. */
  onToast: (t: Toast) => void = () => {};
  onChange: () => void = () => {};
  onHatch: (c: Creature) => void = () => {};
  /** Ask the UI to select (and follow) a creature. */
  onMeet: (c: Creature) => void = () => {};

  private readonly rng: Rng = Math.random;
  private nextVisitorAt = 120;
  private readonly herdGroup = new THREE.Group();
  private readonly eggGeo = new THREE.SphereGeometry(0.32, 18, 14);
  private saveTimer = 0;

  constructor(private readonly scene: THREE.Scene, readonly world: World) {
    this.effects = new Effects(scene);
    scene.add(this.herdGroup);
    this.sound.setVolumes(this.settings.volumes);
    this.voices.muted = this.settings.muted;
  }

  // ---- Lifecycle -------------------------------------------------------

  start() {
    if (!this.load()) this.newGame();
    this.onChange();
  }

  newGame() {
    for (const c of [...this.creatures]) this.remove(c, false);
    for (const e of [...this.eggs]) this.removeEgg(e);
    this.journal.clear();
    this.resources = { fruit: 4, roots: 2, nectar: 0, shells: 1 };
    this.time = 75;
    this.labFreeUsed = false;
    this.nextVisitorAt = this.time + 120;
    const seed = Math.floor(Math.random() * 1e9);
    // Three familiar founders and one from further afield, so every ranch starts a little different.
    const far = ['burrow', 'sky', 'glimmer', 'reef', 'grove', 'dune', 'curio'];
    const themes = ['meadow', 'marsh', 'highland', far[Math.floor(Math.random() * far.length)]];
    themes.forEach((id, i) => {
      const theme = VISITOR_THEMES.find((t) => t.id === id)!;
      const rng = mulberry32(seed + i * 7919);
      const p = randomLandPoint(rng, { x: 0, z: 0 }, 9);
      this.add({ id: makeId(), name: randomName(rng), genome: randomGenome(rng, themeBias(theme, rng)), generation: 1, parents: null, x: p.x, z: p.z, growth: 1, wild: false, theme: theme.id, origin: 'founder' }, false);
    });
    this.save();
  }

  update(dt: number, isNight: boolean) {
    this.time += dt;
    this.isNight = isNight;
    this.world.update(this.time, dt);
    this.voices.muted = this.settings.muted;
    const ctx = {
      time: this.time,
      trees: this.world.trees,
      flowers: this.world.flowers,
      burrows: this.world.burrows,
      creatures: this.creatures,
      isNight,
      effects: this.effects,
      produce: (c: Creature, kind: Produce, amount: number) => this.produce(c, kind, amount),
      addBurrow: (x: number, z: number) => this.world.addBurrow(x, z, this.time),
      call: (c: Creature, mood: Mood) => this.voices.call(c.plan, mood, c),
      sound: (c: Creature, kind: CreatureSound) => this.sound.sfx.creature(kind, c, c.plan.size * c.growth, c.plan.gait),
    };
    for (const c of this.creatures) c.update(dt, ctx);
    for (const c of this.creatures.filter((c) => c.gone)) {
      this.remove(c);
      this.onToast({ icon: '👋', text: `${c.name} wandered back to the wild.`, life: 4 });
    }
    this.updateEggs();
    this.updateVisitors();
    this.effects.update(dt);

    this.saveTimer += dt;
    if (this.saveTimer > 15) {
      this.saveTimer = 0;
      this.save();
    }
  }

  // ---- Herd ------------------------------------------------------------

  get herd() {
    return this.creatures.filter((c) => !c.wild);
  }

  get herdSize() {
    return this.herd.length + this.eggs.length;
  }

  find(id: string | undefined): Creature | undefined {
    return id ? this.creatures.find((c) => c.id === id) : undefined;
  }

  private add(record: CreatureRecord, announce = true): Creature {
    const c = new Creature(record);
    this.creatures.push(c);
    this.herdGroup.add(c.rig.root);
    if (!c.wild) this.recordDiscoveries(c, announce);
    return c;
  }

  remove(c: Creature, notify = true) {
    const i = this.creatures.indexOf(c);
    if (i >= 0) this.creatures.splice(i, 1);
    c.gone = true;
    this.effects.clearFor(c.rig.emoteAnchor);
    c.dispose();
    if (notify) this.onChange();
  }

  release(c: Creature) {
    c.wild = true;
    c.leave();
    this.sound.sfx.chime('release', c);
    this.onToast({ icon: '🌿', text: `${c.name} is heading off to the wild.`, life: 4 });
    this.onChange();
  }

  /** The player says hello: the creature answers and shows off its quirk. */
  poke(c: Creature) {
    this.voices.call(c.plan, 'hello', c, true);
    if (!c.wild) c.showOff();
  }

  rename(c: Creature, name: string) {
    const clean = name.trim().slice(0, 16);
    if (clean) c.name = clean;
    this.onChange();
  }

  // ---- Produce ---------------------------------------------------------

  get produceTotal() {
    return PRODUCE_IDS.reduce((s, k) => s + this.resources[k], 0);
  }

  private produce(c: Creature, kind: Produce, amount: number) {
    this.resources[kind] += amount;
    this.effects.emote(`${PRODUCE[kind].icon}+${amount}`, c.rig.emoteAnchor, { className: 'emote-produce' });
    this.onChange();
  }

  /** Spend produce from the biggest piles first. */
  private spend(amount: number): boolean {
    if (this.produceTotal < amount) return false;
    for (let i = 0; i < amount; i++) {
      const biggest = PRODUCE_IDS.reduce((a, b) => (this.resources[b] > this.resources[a] ? b : a));
      this.resources[biggest]--;
    }
    return true;
  }

  // ---- Breeding --------------------------------------------------------

  get breedCost() {
    return 2 + Math.floor(this.herdSize / 5);
  }

  /** Why these two cannot breed right now, or null if they can. */
  breedBlocker(a: Creature, b: Creature): string | null {
    if (a === b) return 'Pick a different partner.';
    for (const c of [a, b]) {
      if (c.wild) return `${c.name} needs to be welcomed first.`;
      if (!c.adult) return `${c.name} is still growing up.`;
      if (!c.canBreed(this.time)) return `${c.name} is resting after the last egg.`;
    }
    if (this.herdSize >= HERD_CAP) return `The ranch is full (${HERD_CAP}). Release someone to make room.`;
    if (this.produceTotal < this.breedCost) return `A picnic costs ${this.breedCost} produce. You have ${this.produceTotal}.`;
    return null;
  }

  breed(a: Creature, b: Creature): string | null {
    const blocker = this.breedBlocker(a, b);
    if (blocker) return blocker;
    this.spend(this.breedCost);
    const rng = mulberry32(Math.floor(Math.random() * 1e9));
    const { genome, mutations } = breed(a.genome, b.genome, rng);
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const spot = randomLandPoint(rng, mid, 1.5);
    a.court({ x: spot.x + 1.2, z: spot.z });
    b.court({ x: spot.x - 1.2, z: spot.z });
    a.breedReadyAt = b.breedReadyAt = this.time + BREED_COOLDOWN;
    this.layEgg({
      genome,
      mutations,
      parentIds: [a.id, b.id],
      parentNames: [a.name, b.name],
      parentGenomes: [a.genome, b.genome],
      x: spot.x,
      z: spot.z,
      hatchIn: HATCH_SECONDS,
      name: childName(rng, a.name, b.name),
      generation: Math.max(a.generation, b.generation) + 1,
    });
    this.sound.sfx.chime('picnic', spot);
    this.onToast({ icon: '🥚', text: `${a.name} and ${b.name} had a picnic… and there's an egg!`, life: 5 });
    this.onChange();
    return null;
  }

  private layEgg(data: SaveData['eggs'][number]) {
    const geo = this.eggGeo.clone();
    geo.scale(1, 1.3, 1);
    const pos = geo.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const glow = new Float32Array(pos.count);
    const pa = planFromGenome(data.parentGenomes[0]).colour.body;
    const pb = planFromGenome(data.parentGenomes[1]).colour.accent;
    const shell = new THREE.Color().setHSL(pa.h, pa.s * 0.5, Math.min(0.85, pa.l + 0.25), THREE.SRGBColorSpace);
    const speck = new THREE.Color().setHSL(pb.h, pb.s, pb.l, THREE.SRGBColorSpace);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const n = noise3(pos.getX(i) * 14, pos.getY(i) * 14, pos.getZ(i) * 14);
      c.copy(shell).lerp(speck, n > 0.66 ? 1 : 0);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
    const mesh = new THREE.Mesh(geo, creatureMaterials().skin);
    mesh.castShadow = true;
    mesh.position.set(data.x, terrainHeight(data.x, data.z) + 0.4, data.z);
    this.scene.add(mesh);
    this.eggs.push({ id: makeId('egg'), mesh, ...data, hatchAt: this.time + data.hatchIn });
  }

  private removeEgg(egg: Egg) {
    this.eggs.splice(this.eggs.indexOf(egg), 1);
    this.scene.remove(egg.mesh);
    egg.mesh.geometry.dispose();
  }

  private updateEggs() {
    for (const egg of [...this.eggs]) {
      const left = egg.hatchAt - this.time;
      const wobble = left < 5 ? (5 - left) / 5 : 0.1;
      egg.mesh.rotation.z = Math.sin(this.time * (6 + wobble * 10)) * 0.12 * wobble;
      egg.mesh.rotation.x = Math.cos(this.time * 5) * 0.05 * wobble;
      egg.mesh.position.y = terrainHeight(egg.x, egg.z) + 0.4 + Math.max(0, Math.sin(this.time * 9)) * 0.06 * wobble;
      if (left <= 0) this.hatch(egg);
    }
  }

  private hatch(egg: Egg) {
    this.removeEgg(egg);
    const at = new THREE.Vector3(egg.x, terrainHeight(egg.x, egg.z) + 0.4, egg.z);
    this.effects.burst(at, 0xf6efe0, 14, { speed: 1.6, up: 3 });
    this.effects.emote('🐣', at.clone().setY(at.y + 1), { life: 2.5 });
    this.sound.sfx.chime('hatch', egg);
    const baby = this.add({
      id: makeId(), name: egg.name, genome: egg.genome, generation: egg.generation, parents: egg.parentNames, parentIds: egg.parentIds,
      x: egg.x, z: egg.z, growth: BABY_SCALE, wild: false, origin: 'bred',
    });
    const report = hatchReport(
      { plan: baby.plan, expressed: baby.expressed },
      [
        { plan: planFromGenome(egg.parentGenomes[0]), expressed: express(egg.parentGenomes[0]) },
        { plan: planFromGenome(egg.parentGenomes[1]), expressed: express(egg.parentGenomes[1]) },
      ],
      egg.mutations,
    );
    this.voices.call(baby.plan, 'surprise', baby);
    this.onToast({ icon: '🐣', text: `${baby.name} hatched!`, detail: describeReport(report), life: 10, action: { label: 'Say hi', run: () => this.onMeet(baby) } });
    this.onHatch(baby);
    this.onChange();
  }

  // ---- Visitors --------------------------------------------------------

  get visitor(): Creature | undefined {
    return this.creatures.find((c) => c.wild && !c.gone && c.leaveAt !== Infinity);
  }

  /** Seconds until the next visitor: slower by default, a little faster with a charming herd. */
  private visitorGap() {
    const charm = Math.min(6, this.herd.reduce((s, c) => s + c.abilities.charm, 0));
    const [lo, hi] = VISITOR_GAP;
    return ((lo + Math.random() * (hi - lo)) * VISITOR_RATES[this.settings.visitors].factor) / (1 + charm * 0.05);
  }

  private updateVisitors() {
    if (this.time < this.nextVisitorAt) return;
    this.nextVisitorAt = this.time + this.visitorGap();
    if (this.visitor || this.herdSize >= HERD_CAP) return;
    this.spawnVisitor();
  }

  // ---- Settings --------------------------------------------------------

  setVisitorRate(rate: VisitorRate) {
    this.settings.visitors = rate;
    this.nextVisitorAt = this.time + this.visitorGap();
    this.saveSettings();
    this.onChange();
  }

  setMuted(muted: boolean) {
    this.settings.muted = muted;
    this.voices.muted = muted;
    this.saveSettings();
    this.onChange();
  }

  /** Set one sound group's volume (0–1). No onChange: sliders call this while dragging. */
  setVolume(group: SoundGroup, volume: number) {
    this.settings.volumes[group] = volume;
    this.sound.setVolume(group, volume);
    this.saveSettings();
  }

  private saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // Storage can be unavailable; settings just won't stick.
    }
  }

  spawnVisitor() {
    const rng = mulberry32(Math.floor(Math.random() * 1e9));
    const theme = pickTheme(rng);
    const p = gatePoint(12);
    const c = this.add({ id: makeId(), name: randomName(rng), genome: randomGenome(rng, themeBias(theme, rng)), generation: 1, parents: null, x: p.x, z: p.z, growth: 1, wild: true, theme: theme.id, origin: 'visitor' });
    c.heading = Math.PI;
    c.leaveAt = this.time + VISITOR_STAY;
    c.arrive();
    this.sound.sfx.chime('visitor', p);
    this.voices.call(c.plan, 'hello', null);
    this.onToast({
      icon: '🌿',
      text: `A wild ${theme.title} visitor, ${c.name}, ${theme.flavour}.`,
      detail: `Welcome it for ${WELCOME_COST} produce, or let it wander off.`,
      actions: [
        { label: 'Take a look', run: () => this.onMeet(c), keep: true },
        { label: `Welcome (${WELCOME_COST})`, run: () => this.welcome(c) },
      ],
      stale: () => c.gone || !c.wild,
      life: VISITOR_STAY,
    });
    this.onChange();
  }

  welcome(c: Creature): string | null {
    if (!c.wild || c.gone) return null;
    if (this.herdSize >= HERD_CAP) return 'The ranch is full.';
    if (!this.spend(WELCOME_COST)) return `Welcoming costs ${WELCOME_COST} produce.`;
    c.welcome();
    this.effects.emote('💖', c.rig.emoteAnchor, { life: 2 });
    this.sound.sfx.chime('welcome', c);
    this.onToast({ icon: '🏡', text: `${c.name} joined the ranch!`, life: 4 });
    this.recordDiscoveries(c, true);
    this.onChange();
    return null;
  }

  // ---- Lab -------------------------------------------------------------

  get labCost() {
    return this.labFreeUsed ? LAB_COST : 0;
  }

  growFromLab(genome: Genome, name: string): string | null {
    if (this.herdSize >= HERD_CAP) return 'The ranch is full.';
    if (!this.spend(this.labCost)) return `Growing a design costs ${LAB_COST} produce.`;
    this.labFreeUsed = true;
    const p = randomLandPoint(this.rng, { x: -3, z: -10 }, 3);
    const c = this.add({ id: makeId(), name: name || randomName(this.rng), genome, generation: 1, parents: null, x: p.x, z: p.z, growth: BABY_SCALE, wild: false, origin: 'lab' });
    this.effects.burst(c.position.clone().setY(c.position.y + 0.5), 0xc4f1ff, 16, { speed: 1.5, up: 3, gravity: 3, life: 1.4 });
    this.sound.sfx.chime('lab', c);
    this.onToast({ icon: '🧪', text: `${c.name} sprouted from the Lab!`, life: 4 });
    this.onHatch(c);
    this.onChange();
    return null;
  }

  // ---- Journal ---------------------------------------------------------

  private recordDiscoveries(c: Creature, announce: boolean) {
    for (const id of discoveriesFor(c.plan, c.abilities)) {
      if (this.journal.has(id)) continue;
      this.journal.add(id);
      const d = discoveryById(id);
      if (!announce || !d) continue;
      this.sound.sfx.chime('discovery');
      this.onToast({ icon: '📖', text: `New discovery: ${d.title}!`, detail: `${c.name} is the first of its kind on your ranch.`, life: 6 });
    }
  }

  // ---- Persistence -----------------------------------------------------

  save() {
    const data: SaveData = {
      v: 1,
      time: this.time,
      resources: this.resources,
      journal: [...this.journal],
      creatures: this.creatures.filter((c) => !c.wild).map((c) => c.toRecord()),
      eggs: this.eggs.map((e) => ({
        genome: e.genome, mutations: e.mutations, parentIds: e.parentIds, parentNames: e.parentNames, parentGenomes: e.parentGenomes,
        x: e.x, z: e.z, hatchIn: Math.max(1, e.hatchAt - this.time), name: e.name, generation: e.generation,
      })),
      labFreeUsed: this.labFreeUsed,
      visitorIn: Math.max(30, Math.min(600, this.nextVisitorAt - this.time)),
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch {
      // Storage can be unavailable (private mode); the game still runs.
    }
  }

  private load(): boolean {
    let data: SaveData | null = null;
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      data = raw ? (JSON.parse(raw) as SaveData) : null;
    } catch {
      data = null;
    }
    if (!data || data.v !== 1 || !Array.isArray(data.creatures) || data.creatures.length === 0) return false;
    const rng = mulberry32(1);
    this.time = Number.isFinite(data.time) ? data.time : 30;
    for (const k of PRODUCE_IDS) this.resources[k] = Math.max(0, Math.floor(data.resources?.[k] ?? 0));
    for (const id of data.journal ?? []) this.journal.add(id);
    this.labFreeUsed = !!data.labFreeUsed;
    this.nextVisitorAt = this.time + (data.visitorIn ?? 120);
    for (const r of data.creatures) {
      this.add({ ...r, genome: reviveGenome(r.genome, rng), wild: false, origin: r.origin ?? 'founder' }, false);
    }
    for (const e of data.eggs ?? []) {
      this.layEgg({ ...e, genome: reviveGenome(e.genome, rng), parentGenomes: [reviveGenome(e.parentGenomes?.[0], rng), reviveGenome(e.parentGenomes?.[1], rng)] });
    }
    return true;
  }

  reset() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      // ignore
    }
    this.newGame();
    this.onChange();
  }
}

function loadSettings(): Settings {
  const fallback: Settings = { visitors: 'sometimes', muted: false, volumes: reviveVolumes(null) };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null;
    return {
      visitors: raw?.visitors && raw.visitors in VISITOR_RATES ? raw.visitors : fallback.visitors,
      muted: !!raw?.muted,
      volumes: reviveVolumes(raw?.volumes),
    };
  } catch {
    return fallback;
  }
}

export function describeReport(r: HatchReport): string {
  const parts: string[] = [];
  if (r.surprises.length) parts.push(`✨ Surprise: ${r.surprises.join(', ')}!`);
  if (r.beyond.length) parts.push(`Beyond both parents: ${r.beyond.slice(0, 3).join(', ')}.`);
  const big = r.mutations.filter((m) => m.big).length;
  if (r.mutations.length) parts.push(`${r.mutations.length} mutation${r.mutations.length === 1 ? '' : 's'}${big ? ` (${big} big)` : ''}.`);
  return parts.join(' ') || 'A perfect blend of both parents.';
}

