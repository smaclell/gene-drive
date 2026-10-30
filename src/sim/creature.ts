import * as THREE from 'three';
import { clamp, lerp, weightedPick } from '../core/rng';
import { buildCreature, type CreatureRig } from '../creature/build';
import { GAIT_CADENCE, animate, gaitSurge, restPose, type ActionKind } from '../creature/motion';
import { canFly, computeAbilities, type Abilities } from '../genetics/abilities';
import { buildSkeleton, type Skeleton } from '../genetics/anatomy';
import { express, genomeSeed, type Expressed, type Genome } from '../genetics/genome';
import { QUIRK_LABEL, planFromExpressed, type BodyPlan, type Food, type Quirk } from '../genetics/phenotype';
import {
  POND, RANCH_RADIUS, WATER_LEVEL, clampToRanch, gatePoint, isWater, randomLandPoint, randomPondPoint, randomSoilPoint,
  terrainHeight, type Point,
} from '../world/layout';
import { pickFruit, type Burrow, type FlowerPatch, type Tree } from '../world/scenery';
import type { Effects } from './effects';
import type { CreatureSound } from './sfx';
import type { Mood } from './voice';

/**
 * A living creature on the ranch: genome-derived body plus a small task
 * machine. Abilities and temperament genes weight which tasks it picks; the
 * personality genes add a signature idle, a favourite food and a nap spot.
 * Posing the meshes is left to `creature/motion.ts`.
 */

export type Produce = Food;

export const PRODUCE: Record<Produce, { icon: string; label: string }> = {
  fruit: { icon: '🍎', label: 'Fruit' },
  roots: { icon: '🥕', label: 'Roots' },
  nectar: { icon: '🍯', label: 'Nectar' },
  shells: { icon: '🐚', label: 'Shells' },
};

export const PRODUCE_IDS = Object.keys(PRODUCE) as Produce[];

/** Seconds for a hatchling to reach full size. */
export const GROW_SECONDS = 100;
export const BABY_SCALE = 0.45;

/** Ability levels where signature moves kick in. */
const SHAKE_REACH = 0.75;
const BURROW_DIG = 0.7;
const DIVE_SWIM = 0.65;
const ZOOM_SPEED = 0.8;
const LOOP_FLY = 0.65;

export interface CreatureContext {
  time: number;
  trees: Tree[];
  flowers: FlowerPatch[];
  burrows: Burrow[];
  creatures: Creature[];
  isNight: boolean;
  effects: Effects;
  produce: (c: Creature, kind: Produce, amount: number) => void;
  addBurrow: (x: number, z: number) => void;
  call: (c: Creature, mood: Mood) => void;
  sound: (c: Creature, kind: CreatureSound) => void;
}

/** What gets saved. Everything else is rebuilt from the genome. */
export interface CreatureRecord {
  id: string;
  name: string;
  genome: Genome;
  generation: number;
  parents: [string, string] | null;
  parentIds?: [string, string] | null;
  x: number;
  z: number;
  growth: number;
  wild: boolean;
  theme?: string;
  origin: 'founder' | 'bred' | 'visitor' | 'lab';
}

type TaskKind = 'idle' | 'wander' | 'forage' | 'dig' | 'swim' | 'fly' | 'nap' | 'visit' | 'follow' | 'court' | 'arrive' | 'leave' | 'quirk' | 'zoom';

interface Task {
  kind: TaskKind;
  target: Point | null;
  /** Seconds spent acting once the target is reached. */
  act: number;
  elapsed: number;
  arrived: boolean;
  tree?: Tree;
  flower?: FlowerPatch;
  friend?: Creature;
  /** Napping inside a burrow. */
  burrow?: Burrow;
  /** Extra hops (swimming laps, zoomie waypoints). */
  laps?: number;
  /** One-shot flag for mid-task events. */
  fired?: boolean;
  tick?: number;
}

const STATUS: Record<TaskKind, string> = {
  idle: 'Daydreaming',
  wander: 'Wandering',
  forage: 'Foraging',
  dig: 'Digging',
  swim: 'Swimming',
  fly: 'Pollinating',
  nap: 'Napping',
  visit: 'Visiting a friend',
  follow: 'Tagging along',
  court: 'Courting',
  arrive: 'Arriving',
  leave: 'Heading home',
  quirk: 'Being silly',
  zoom: 'Doing zoomies',
};

const QUIRK_SECONDS: Record<Quirk, number> = { stretch: 2.6, chase: 3, twirl: 1.6, dance: 3.6, roll: 3, sing: 3.4 };
const QUIRK_EMOTE: Record<Quirk, string> = { stretch: '😌', chase: '🌀', twirl: '✨', dance: '🎶', roll: '🌼', sing: '🎵' };

const rand = Math.random;
const rr = (min: number, max: number) => min + (max - min) * rand();

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class Creature {
  readonly id: string;
  name: string;
  readonly genome: Genome;
  readonly expressed: Expressed;
  readonly plan: BodyPlan;
  readonly skeleton: Skeleton;
  readonly abilities: Abilities;
  readonly generation: number;
  readonly parents: [string, string] | null;
  readonly parentIds: [string, string] | null;
  readonly origin: CreatureRecord['origin'];
  readonly theme?: string;
  readonly rig: CreatureRig;

  x: number;
  z: number;
  heading = rand() * Math.PI * 2;
  growth: number;
  wild: boolean;
  /** Wild visitors head home after this time unless welcomed. */
  leaveAt = Infinity;
  breedReadyAt = 0;
  /** Set when the creature has walked off the map and should be removed. */
  gone = false;

  private task: Task | null = null;
  private action: { kind: ActionKind; start: number; length: number } | null = null;
  private speed = 0;
  private walkPhase = rand() * 10;
  private altitude = 0;
  /** In the pond (for splashes and paddling). */
  private wet = false;
  private y = 0;
  private time = 0;
  private blinkAt = rand() * 4;
  private lookYaw = 0;
  private lookAt = 0;
  private readonly pose = restPose();

  constructor(record: CreatureRecord) {
    this.id = record.id;
    this.name = record.name;
    this.genome = record.genome;
    this.generation = record.generation;
    this.parents = record.parents;
    this.parentIds = record.parentIds ?? null;
    this.origin = record.origin;
    this.theme = record.theme;
    this.x = record.x;
    this.z = record.z;
    this.growth = clamp(record.growth, BABY_SCALE, 1);
    this.wild = record.wild;
    this.expressed = express(this.genome);
    this.plan = planFromExpressed(this.expressed, this.genome.sprouts);
    this.skeleton = buildSkeleton(this.plan);
    this.abilities = computeAbilities(this.plan, this.skeleton);
    this.rig = buildCreature(this.plan, this.skeleton, genomeSeed(this.genome));
    this.rig.root.traverse((o) => (o.userData.creatureId = this.id));
    this.syncRig(0);
  }

  toRecord(): CreatureRecord {
    return {
      id: this.id, name: this.name, genome: this.genome, generation: this.generation, parents: this.parents,
      parentIds: this.parentIds, x: this.x, z: this.z, growth: this.growth, wild: this.wild, theme: this.theme, origin: this.origin,
    };
  }

  get adult() {
    return this.growth >= 1;
  }

  /** Rough footprint radius, for spacing. */
  get radius() {
    return Math.max(0.5, this.skeleton.length * 0.32) * this.growth;
  }

  get reachHeight() {
    return this.skeleton.reach * this.growth;
  }

  get position(): THREE.Vector3 {
    return this.rig.root.position;
  }

  get flies() {
    return canFly(this.abilities);
  }

  get status(): string {
    if (!this.task) return STATUS.idle;
    if ((this.task.kind === 'visit' || this.task.kind === 'follow') && this.task.friend) {
      return `${this.task.kind === 'visit' ? 'Visiting' : 'Following'} ${this.task.friend.name}`;
    }
    if (this.task.kind === 'quirk') return QUIRK_LABEL[this.plan.quirk].status;
    if (this.action?.kind === 'shake') return 'Shaking a tree';
    if (this.action?.kind === 'dive') return 'Diving for shells';
    if (this.task.kind === 'nap' && this.task.burrow) return 'Napping in a burrow';
    return STATUS[this.task.kind];
  }

  canBreed(time: number) {
    return this.adult && !this.wild && time >= this.breedReadyAt;
  }

  /** Walk to a spot and swoon a bit (used when laying an egg). */
  court(at: Point) {
    this.task = { kind: 'court', target: at, act: 2.5, elapsed: 0, arrived: false };
  }

  /** Head out through the gate: first to the gate, then beyond it. */
  leave() {
    this.task = { kind: 'leave', target: gatePoint(-2), act: 1, elapsed: 0, arrived: false, laps: 1 };
  }

  arrive() {
    this.task = { kind: 'arrive', target: randomLandPoint(rand, gatePoint(-8), 5), act: 1, elapsed: 0, arrived: false };
  }

  welcome() {
    this.wild = false;
    this.leaveAt = Infinity;
    this.task = null;
  }

  /** Show off its signature idle right now (when the player says hello). */
  showOff() {
    if (this.task?.kind === 'court' || this.task?.kind === 'leave' || this.altitude > 0.5) return;
    this.task = { kind: 'quirk', target: null, act: QUIRK_SECONDS[this.plan.quirk], elapsed: 0, arrived: true };
    this.action = { kind: this.plan.quirk, start: this.time, length: QUIRK_SECONDS[this.plan.quirk] };
  }

  private startAction(kind: ActionKind, length: number) {
    this.action = { kind, start: this.time, length };
  }

  /** Hand over produce; a favourite food is sometimes worth a bonus. */
  private gather(kind: Produce, amount: number, ctx: CreatureContext) {
    if (kind === this.plan.favourite && rand() < 0.3) {
      amount += 1;
      ctx.effects.emote('😋', this.rig.emoteAnchor, { life: 1.4 });
    }
    ctx.produce(this, kind, amount);
  }

  update(dt: number, ctx: CreatureContext) {
    this.time = ctx.time;
    if (this.growth < 1) this.growth = Math.min(1, this.growth + (dt / GROW_SECONDS) * (1 - BABY_SCALE));
    if (this.wild && ctx.time > this.leaveAt && this.task?.kind !== 'leave') this.leave();
    if (this.action && ctx.time > this.action.start + this.action.length) this.endAction(ctx);
    if (!this.task) this.task = this.chooseTask(ctx);
    const task = this.task;

    // Moving targets.
    if (task.friend && (task.kind === 'visit' || task.kind === 'follow')) {
      if (task.friend.gone) {
        this.task = null;
        return;
      }
      const f = task.friend;
      const away = Math.atan2(this.z - f.z, this.x - f.x);
      const gap = f.radius + this.radius + 0.3;
      task.target = { x: f.x + Math.cos(away) * gap, z: f.z + Math.sin(away) * gap };
    }

    let desiredSpeed = 0;
    if (task.target && !task.arrived) {
      const dx = task.target.x - this.x;
      const dz = task.target.z - this.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.45) {
        task.arrived = true;
      } else {
        const desired = Math.atan2(-dz, dx);
        const diff = wrapAngle(desired - this.heading);
        const turn = 2.6 * dt;
        this.heading = wrapAngle(this.heading + clamp(diff, -turn, turn));
        const takeoff = task.kind === 'fly' && this.altitude < 1 ? 0.25 : 1;
        const zoom = task.kind === 'zoom' ? 1.7 : 1;
        desiredSpeed = this.maxSpeed() * zoom * (0.25 + 0.75 * Math.max(0, Math.cos(diff))) * takeoff * Math.min(1, dist / 1.2 + 0.3);
        if (task.kind === 'fly' && !task.fired && this.abilities.fly >= LOOP_FLY && this.altitude > 1.8 && dist > 6 && rand() < dt * 0.5) {
          task.fired = true;
          this.startAction('loop', 1.4);
          ctx.sound(this, 'whoosh');
        }
      }
    } else if (!task.target) {
      task.arrived = true;
    }
    this.speed = lerp(this.speed, desiredSpeed, Math.min(1, dt * 4));

    if (task.arrived) {
      task.elapsed += dt;
      this.perform(task, dt, ctx);
      if (this.task === task && task.elapsed >= task.act) {
        this.finish(task, ctx);
        if (this.task === task) this.task = null;
      }
    }

    // Move. Some gaits travel in surges (an inchworm pulls, then rests).
    const flying = this.altitude > 0.4;
    const step = this.speed * dt * (flying ? 1 : gaitSurge(this.plan.gait, this.walkPhase));
    this.x += Math.cos(this.heading) * step;
    this.z -= Math.sin(this.heading) * step;
    const footfall = Math.floor(this.walkPhase / Math.PI);
    this.walkPhase += (step / this.stride()) * Math.PI * GAIT_CADENCE[this.plan.gait];
    if (Math.floor(this.walkPhase / Math.PI) !== footfall) ctx.sound(this, flying ? 'flap' : this.wet ? 'paddle' : 'step');

    // Personal space.
    if (this.altitude < 0.5) {
      for (const other of ctx.creatures) {
        if (other === this || other.altitude > 0.5) continue;
        const dx = this.x - other.x;
        const dz = this.z - other.z;
        const min = (this.radius + other.radius) * 0.75;
        const d = Math.hypot(dx, dz);
        if (d > 1e-4 && d < min) {
          const push = ((min - d) / d) * Math.min(1, dt * 3);
          this.x += dx * push * 0.5;
          this.z += dz * push * 0.5;
        }
      }
    }

    const roaming = task.kind === 'arrive' || task.kind === 'leave';
    if (!roaming) {
      const p = clampToRanch({ x: this.x, z: this.z }, RANCH_RADIUS);
      this.x = p.x;
      this.z = p.z;
    }

    const wet = this.altitude < 0.3 && isWater(this.x, this.z);
    if (wet && !this.wet) ctx.sound(this, 'splash');
    this.wet = wet;

    const loop = this.action?.kind === 'loop' ? Math.sin(Math.PI * this.actionProgress()) * 1.5 : 0;
    this.altitude = lerp(this.altitude, task.kind === 'fly' ? 2.2 + this.skeleton.bodyHeight * 0.3 + loop : 0, Math.min(1, dt * 1.2));
    this.syncRig(dt, ctx.time);
  }

  private actionProgress() {
    return this.action ? clamp((this.time - this.action.start) / this.action.length, 0, 1) : 0;
  }

  private endAction(ctx: CreatureContext) {
    if (this.action?.kind === 'dive') {
      // Pop back up with a splash, sometimes holding a shell.
      const at = new THREE.Vector3(this.x, WATER_LEVEL + 0.05, this.z);
      ctx.effects.burst(at, 0xd8f1ff, 12, { speed: 1.4, up: 3, life: 0.8 });
      ctx.effects.ripple(at, 2.2);
      ctx.sound(this, 'splash');
      if (rand() < 0.6) this.gather('shells', 1, ctx);
    }
    this.action = null;
  }

  private maxSpeed() {
    const base = 0.7 + this.abilities.speed * 2.3;
    const flying = this.altitude > 1 ? 1.4 : 1;
    return base * (0.6 + 0.4 * this.growth) * flying;
  }

  private stride() {
    const s = this.skeleton;
    const hip = s.legs[0]?.length ?? s.tentacles[0]?.length ?? 0.5 * s.scale;
    return Math.max(0.25 * s.scale, hip * 0.9) * this.growth;
  }

  /** A good place to nap: by its favourite food, or in a burrow if it is a digger. */
  private napSpot(ctx: CreatureContext): { at: Point; burrow?: Burrow } {
    const here = { x: this.x, z: this.z };
    const near = <T extends Point>(list: T[]) => list.reduce<T | null>((best, p) => (!best || Math.hypot(p.x - here.x, p.z - here.z) < Math.hypot(best.x - here.x, best.z - here.z) ? p : best), null);
    if (this.abilities.dig >= BURROW_DIG) {
      const b = near(ctx.burrows);
      if (b) return { at: { x: b.x, z: b.z }, burrow: b };
    }
    switch (this.plan.favourite) {
      case 'fruit': {
        const t = near(ctx.trees);
        if (t) {
          const a = rand() * Math.PI * 2;
          return { at: { x: t.x + Math.cos(a) * (t.standOff + 0.6), z: t.z + Math.sin(a) * (t.standOff + 0.6) } };
        }
        break;
      }
      case 'nectar': {
        const f = near(ctx.flowers);
        if (f) return { at: randomLandPoint(rand, f, 1.2) };
        break;
      }
      case 'shells': {
        const a = rand() * Math.PI * 2;
        return { at: randomLandPoint(rand, { x: POND.x + Math.cos(a) * POND.r * 1.5, z: POND.z + Math.sin(a) * POND.r * 1.5 }, 1) };
      }
      case 'roots':
        return { at: randomSoilPoint(rand) };
    }
    return { at: randomLandPoint(rand, here, 3) };
  }

  private chooseTask(ctx: CreatureContext): Task {
    const t = (kind: TaskKind, target: Point | null, act: number, extra: Partial<Task> = {}): Task => ({ kind, target, act, elapsed: 0, arrived: false, ...extra });
    const here = { x: this.x, z: this.z };
    const p = this.plan;
    const a = this.abilities;
    const wanderTask = () => t('wander', randomLandPoint(rand, here, 4 + p.curiosity * 14), rr(0.5, 2));
    const quirkTask = () => {
      this.startAction(p.quirk, QUIRK_SECONDS[p.quirk]);
      ctx.effects.emote(QUIRK_EMOTE[p.quirk], this.rig.emoteAnchor, { life: 1.6 });
      if (p.quirk === 'sing') ctx.call(this, 'song');
      return t('quirk', null, QUIRK_SECONDS[p.quirk]);
    };
    const napTask = (seconds: number) => {
      const spot = this.napSpot(ctx);
      return t('nap', spot.at, seconds, { burrow: spot.burrow });
    };

    if (this.wild) {
      return weightedPick(rand, [
        { item: wanderTask(), weight: 1 },
        { item: t('idle', null, rr(2, 5)), weight: 0.8 },
      ])!;
    }

    if (!this.adult) {
      const parent = ctx.creatures.find((c) => this.parentIds?.includes(c.id) && !c.gone);
      const pick = weightedPick<() => Task>(rand, [
        { item: () => (parent ? t('follow', null, rr(1, 3), { friend: parent }) : wanderTask()), weight: 1.6 },
        { item: wanderTask, weight: 0.6 },
        { item: () => t('idle', null, rr(1.5, 4)), weight: 0.6 },
        { item: quirkTask, weight: 0.25 },
        { item: () => t('nap', null, rr(6, 12)), weight: ctx.isNight ? 1.5 : 0.25 },
      ])!;
      return pick();
    }

    const options: { item: () => Task; weight: number }[] = [
      { item: wanderTask, weight: 0.8 + p.curiosity * 0.6 },
      { item: () => t('idle', null, rr(2, 5)), weight: 0.5 },
      { item: quirkTask, weight: 0.18 + p.energy * 0.12 },
      { item: () => napTask(ctx.isNight ? rr(14, 24) : rr(7, 12)), weight: (0.15 + (1 - p.energy) * 0.4) * (ctx.isNight ? 4 : 1) },
    ];

    // Forage: highest fruit we can reach, so tall creatures leave the low fruit for the little ones.
    let bestTree: Tree | null = null;
    let bestHeight = -1;
    const reach = this.reachHeight + 0.1;
    for (const tree of ctx.trees) {
      for (const f of tree.fruits) {
        if (!f.ripe || f.height > reach) continue;
        const score = f.height - Math.hypot(tree.x - this.x, tree.z - this.z) * 0.08 + rand() * 0.6;
        if (score > bestHeight) {
          bestHeight = score;
          bestTree = tree;
        }
      }
    }
    if (bestTree) {
      const tree = bestTree;
      options.push({
        item: () => {
          const away = Math.atan2(this.z - tree.z, this.x - tree.x) + rr(-0.6, 0.6);
          const stand = tree.standOff + this.skeleton.head.center.x * this.growth * 0.3;
          return t('forage', { x: tree.x + Math.cos(away) * stand, z: tree.z + Math.sin(away) * stand }, 2.2, { tree });
        },
        weight: 0.4 + a.reach * 1.4,
      });
    }

    options.push({ item: () => t('dig', randomSoilPoint(rand), 4.5, { tick: 0 }), weight: 0.1 + a.dig * 1.3 });
    options.push({ item: () => t('swim', randomPondPoint(rand), 1, { laps: 2 + Math.floor(rand() * 3) }), weight: 0.05 + a.swim * 1.3 });
    if (a.speed >= ZOOM_SPEED) {
      options.push({
        item: () => {
          ctx.effects.emote('💨', this.rig.emoteAnchor, { life: 1.2 });
          ctx.sound(this, 'whoosh');
          return t('zoom', randomLandPoint(rand, here, 10), 0.2, { laps: 3, tick: 0 });
        },
        weight: 0.15 + p.energy * 0.2,
      });
    }

    if (this.flies) {
      const free = ctx.flowers.filter((f) => f.busyUntil < ctx.time);
      if (free.length) {
        options.push({ item: () => t('fly', null, 3, { flower: free[Math.floor(rand() * free.length)] }), weight: 0.5 + a.fly * 1.6 });
      }
    }

    const friends = ctx.creatures.filter((c) => c !== this && !c.gone && c.altitude < 0.5);
    if (friends.length) {
      options.push({ item: () => t('visit', null, 2, { friend: friends[Math.floor(rand() * friends.length)] }), weight: p.sociability * 0.9 });
    }

    const task = weightedPick(rand, options)!();
    if (task.kind === 'fly' && task.flower) task.target = { x: task.flower.x, z: task.flower.z };
    return task;
  }

  /** Per-frame work while acting at the target. */
  private perform(task: Task, dt: number, ctx: CreatureContext) {
    const fx = ctx.effects;
    switch (task.kind) {
      case 'forage': {
        if (task.tree) this.face(task.tree.x, task.tree.z, dt);
        if (!task.fired && task.elapsed > 1.2 && task.tree) {
          task.fired = true;
          const tree = task.tree;
          const ripe = tree.fruits.filter((f) => f.ripe);
          // Signature move: a sky-neck shakes the whole tree and catches what falls.
          if (this.abilities.reach >= SHAKE_REACH && ripe.length >= 2 && rand() < 0.4) {
            tree.shake = 1;
            this.startAction('shake', 1.5);
            ctx.sound(this, 'shake');
            task.act = 3;
            const fallen = ripe.sort(() => rand() - 0.5).slice(0, 3);
            for (const fruit of fallen) {
              const at = new THREE.Vector3();
              fruit.mesh.getWorldPosition(at);
              fx.burst(at, (fruit.mesh.material as THREE.MeshToonMaterial).color.getHex(), 4, { speed: 1, up: 0.5 });
              pickFruit(fruit, ctx.time);
            }
            fx.burst(new THREE.Vector3(tree.x, terrainHeight(tree.x, tree.z) + 3, tree.z), 0x6fb35a, 14, { speed: 2, up: 1, gravity: 3, life: 1.4 });
            this.gather('fruit', fallen.length, ctx);
            break;
          }
          const reach = this.reachHeight + 0.1;
          const fruit = ripe.filter((f) => f.height <= reach).sort((x, y) => y.height - x.height)[0];
          if (fruit) {
            pickFruit(fruit, ctx.time);
            const at = new THREE.Vector3();
            fruit.mesh.getWorldPosition(at);
            fx.burst(at, (fruit.mesh.material as THREE.MeshToonMaterial).color.getHex(), 6, { speed: 0.8, up: 1.5 });
            ctx.sound(this, 'pluck');
            this.gather('fruit', 1, ctx);
          } else {
            fx.emote('❓', this.rig.emoteAnchor);
            task.elapsed = task.act;
          }
        }
        break;
      }
      case 'dig': {
        task.tick = (task.tick ?? 0) + dt;
        if (task.tick > 0.45) {
          task.tick = 0;
          const nose = new THREE.Vector3();
          this.rig.head.getWorldPosition(nose);
          nose.y = terrainHeight(nose.x, nose.z) + 0.1;
          fx.burst(nose, 0x7a4e32, 5, { speed: 1, up: 2.2, life: 0.6, size: 0.9 });
          ctx.sound(this, 'dig');
        }
        break;
      }
      case 'swim': {
        if ((task.laps ?? 0) > 0) {
          task.laps! -= 1;
          task.target = randomPondPoint(rand);
          task.arrived = false;
          task.elapsed = 0;
          // Signature move: strong swimmers dive for shells.
          if (this.abilities.swim >= DIVE_SWIM && !this.action && rand() < 0.35) {
            this.startAction('dive', 1.8);
            fx.ripple(new THREE.Vector3(this.x, WATER_LEVEL + 0.05, this.z), 1.6);
            ctx.sound(this, 'dive');
          }
        }
        break;
      }
      case 'zoom': {
        if ((task.laps ?? 0) > 0) {
          task.laps! -= 1;
          task.target = randomLandPoint(rand, { x: this.x, z: this.z }, 9);
          task.arrived = false;
          task.elapsed = 0;
        }
        break;
      }
      case 'fly': {
        if (!task.fired && task.flower) {
          task.fired = true;
          task.flower.busyUntil = ctx.time + 30;
        }
        break;
      }
      case 'nap': {
        task.tick = (task.tick ?? 0) + dt;
        if (task.tick > 3) {
          task.tick = 0;
          fx.emote('💤', this.rig.emoteAnchor, { life: 2.4 });
          ctx.sound(this, 'snore');
        }
        break;
      }
      case 'quirk': {
        // Spinning quirks turn the whole creature.
        if (this.plan.quirk === 'chase') this.heading = wrapAngle(this.heading + dt * 5);
        if (this.plan.quirk === 'twirl') this.heading = wrapAngle(this.heading + dt * ((Math.PI * 2) / QUIRK_SECONDS.twirl));
        break;
      }
      case 'leave': {
        if ((task.laps ?? 0) > 0) {
          task.laps! -= 1;
          task.target = gatePoint(12);
          task.arrived = false;
          task.elapsed = 0;
        } else {
          this.gone = true;
        }
        break;
      }
      case 'court': {
        if (!task.fired) {
          task.fired = true;
          fx.emote('💕', this.rig.emoteAnchor, { life: 2.2 });
          ctx.call(this, 'happy');
        }
        break;
      }
      case 'visit': {
        if (task.friend) this.face(task.friend.x, task.friend.z, dt);
        if (!task.fired && task.friend) {
          task.fired = true;
          if (this.plan.sociability > 0.45) {
            fx.emote('❤️', this.rig.emoteAnchor);
            ctx.call(this, 'hello');
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private finish(task: Task, ctx: CreatureContext) {
    const a = this.abilities;
    switch (task.kind) {
      case 'dig': {
        let found = rand() < 0.35 + 0.65 * a.dig ? 1 : 0;
        if (a.dig > 0.7 && rand() < 0.5) found++;
        if (found) this.gather('roots', found, ctx);
        else ctx.effects.emote('…', this.rig.emoteAnchor);
        // Signature move: great diggers leave a burrow to nap in later.
        if (a.dig >= BURROW_DIG && rand() < 0.45) ctx.addBurrow(this.x, this.z);
        break;
      }
      case 'swim': {
        if (rand() < 0.3 + 0.7 * a.swim) this.gather('shells', a.swim > 0.65 && rand() < 0.4 ? 2 : 1, ctx);
        break;
      }
      case 'fly': {
        if (task.flower) {
          task.flower.bloom = 1;
          ctx.effects.burst(new THREE.Vector3(task.flower.x, terrainHeight(task.flower.x, task.flower.z) + 0.8, task.flower.z), 0xfff1a8, 10, { speed: 1.2, up: 1.5, gravity: 1, life: 1.4, size: 0.7 });
          ctx.sound(this, 'bloom');
        }
        this.gather('nectar', a.fly > 0.7 ? 2 : 1, ctx);
        break;
      }
      default:
        break;
    }
  }

  private face(x: number, z: number, dt: number) {
    const desired = Math.atan2(-(z - this.z), x - this.x);
    const diff = wrapAngle(desired - this.heading);
    this.heading = wrapAngle(this.heading + clamp(diff, -2.5 * dt, 2.5 * dt));
  }

  /** Apply position and pose; `motion.ts` does the procedural animation. */
  private syncRig(dt: number, time = 0) {
    const rig = this.rig;
    const p = this.plan;
    const s = this.skeleton;
    const task = this.task;
    const acting = !!task?.arrived;
    const kind = task?.kind ?? 'idle';
    const progress = this.actionProgress();

    // Height: ground, water surface, burrow, or sky.
    const ground = terrainHeight(this.x, this.z);
    let baseY = ground;
    const inWater = isWater(this.x, this.z);
    if (inWater) baseY = Math.max(ground, WATER_LEVEL - s.bodyHeight * this.growth * 0.8);
    if (this.action?.kind === 'dive') baseY -= Math.sin(Math.PI * progress) * s.bodyHeight * this.growth * 1.6;
    if (acting && kind === 'nap' && task?.burrow) baseY -= s.bodyHeight * this.growth * 0.6;
    baseY += this.altitude;
    this.y = dt > 0 ? lerp(this.y, baseY, Math.min(1, dt * 8)) : baseY;

    rig.root.position.set(this.x, this.y, this.z);
    rig.root.rotation.y = this.heading;
    rig.scaler.scale.setScalar(this.growth);
    for (const h of rig.heads) h.scale.setScalar(1 + (1 - this.growth) * 0.6);

    // Pose targets, eased toward.
    const target = restPose();
    if (acting && kind === 'forage') {
      target.pitch = 0.1;
      target.headPitch = 0.5;
    } else if (acting && kind === 'dig') {
      target.pitch = -0.2;
      target.headPitch = -0.55;
    } else if (acting && kind === 'nap') {
      target.drop = s.sitDrop;
      target.headPitch = -0.25;
      target.eyes = 0.08;
      target.fold = 1;
    } else if (kind === 'fly' && this.altitude > 0.4) {
      target.pitch = acting ? 0.05 : -0.08;
    }
    target.wingOpen = kind === 'fly' ? 1 : 0;
    const k = Math.min(1, dt * 4);
    for (const key of Object.keys(target) as (keyof typeof target)[]) this.pose[key] = lerp(this.pose[key], target[key], k);

    // Look around when idle.
    if (time > this.lookAt) {
      this.lookAt = time + rr(1.5, 4);
      this.lookYaw = kind === 'idle' || kind === 'wander' ? rr(-0.6, 0.6) : 0;
    }
    if (time > this.blinkAt + 0.13) this.blinkAt = time + rr(2, 6);

    animate(rig, p, s, {
      time,
      phase: this.walkPhase,
      moving: clamp(this.speed / 1.2, 0, 1),
      swimming: inWater && this.altitude < 0.3,
      flying: this.altitude > 0.4,
      pose: this.pose,
      lookYaw: this.lookYaw,
      happy: kind === 'visit' || kind === 'court' || kind === 'follow',
      digging: acting && kind === 'dig',
      foraging: acting && kind === 'forage',
      blink: time > this.blinkAt,
      action: this.action ? { kind: this.action.kind, t: progress } : null,
    });
  }

  dispose() {
    this.rig.root.removeFromParent();
    this.rig.dispose();
  }
}
