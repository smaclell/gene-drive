import * as THREE from 'three';
import { clamp, lerp, weightedPick } from '../core/rng';
import { buildCreature, type CreatureRig } from '../creature/build';
import { canFly, computeAbilities, type Abilities } from '../genetics/abilities';
import { buildSkeleton, type Skeleton } from '../genetics/anatomy';
import { express, genomeSeed, type Expressed, type Genome } from '../genetics/genome';
import { planFromExpressed, type BodyPlan } from '../genetics/phenotype';
import {
  RANCH_RADIUS, WATER_LEVEL, clampToRanch, gatePoint, isWater, randomLandPoint, randomPondPoint, randomSoilPoint,
  terrainHeight, type Point,
} from '../world/layout';
import { pickFruit, type FlowerPatch, type Tree } from '../world/scenery';
import type { Effects } from './effects';

/**
 * A living creature on the ranch: genome-derived body plus a small task
 * machine. Abilities and temperament genes weight which tasks it picks.
 */

export type Produce = 'fruit' | 'roots' | 'nectar' | 'shells';

export const PRODUCE: Record<Produce, { icon: string; label: string }> = {
  fruit: { icon: '🍎', label: 'Fruit' },
  roots: { icon: '🥕', label: 'Roots' },
  nectar: { icon: '🍯', label: 'Nectar' },
  shells: { icon: '🐚', label: 'Shells' },
};

export const PRODUCE_IDS = Object.keys(PRODUCE) as Produce[];

/** Seconds for a hatchling to reach full size. */
export const GROW_SECONDS = 150;
export const BABY_SCALE = 0.45;

export interface CreatureContext {
  time: number;
  trees: Tree[];
  flowers: FlowerPatch[];
  creatures: Creature[];
  isNight: boolean;
  effects: Effects;
  produce: (c: Creature, kind: Produce, amount: number) => void;
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

type TaskKind = 'idle' | 'wander' | 'forage' | 'dig' | 'swim' | 'fly' | 'nap' | 'visit' | 'follow' | 'court' | 'arrive' | 'leave';

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
  /** Extra hops (used by swimming). */
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
};

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
  private speed = 0;
  private walkPhase = rand() * 10;
  private altitude = 0;
  private y = 0;
  private blinkAt = rand() * 4;
  private lookYaw = 0;
  private lookAt = 0;
  private readonly pose = { drop: 0, pitch: 0, headPitch: 0, eyes: 1, fold: 0 };

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
    this.plan = planFromExpressed(this.expressed);
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

  update(dt: number, ctx: CreatureContext) {
    if (this.growth < 1) this.growth = Math.min(1, this.growth + (dt / GROW_SECONDS) * (1 - BABY_SCALE));
    if (this.wild && ctx.time > this.leaveAt && this.task?.kind !== 'leave') this.leave();
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
        desiredSpeed = this.maxSpeed() * (0.25 + 0.75 * Math.max(0, Math.cos(diff))) * takeoff * Math.min(1, dist / 1.2 + 0.3);
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

    // Move.
    const step = this.speed * dt;
    this.x += Math.cos(this.heading) * step;
    this.z -= Math.sin(this.heading) * step;
    this.walkPhase += (step / this.stride()) * Math.PI;

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

    this.altitude = lerp(this.altitude, task.kind === 'fly' ? 2.2 + this.skeleton.bodyHeight * 0.3 : 0, Math.min(1, dt * 1.2));
    this.syncRig(dt, ctx.time);
  }

  private maxSpeed() {
    const base = 0.7 + this.abilities.speed * 2.3;
    const flying = this.altitude > 1 ? 1.4 : 1;
    return base * (0.6 + 0.4 * this.growth) * flying;
  }

  private stride() {
    return Math.max(0.3, (this.plan.legPairs > 0 ? this.plan.legLength : 0.5) * 0.9) * this.growth;
  }

  private chooseTask(ctx: CreatureContext): Task {
    const t = (kind: TaskKind, target: Point | null, act: number, extra: Partial<Task> = {}): Task => ({ kind, target, act, elapsed: 0, arrived: false, ...extra });
    const here = { x: this.x, z: this.z };
    const p = this.plan;
    const a = this.abilities;
    const wanderTask = () => t('wander', randomLandPoint(rand, here, 4 + p.curiosity * 14), rr(0.5, 2));

    if (this.wild) {
      return weightedPick(rand, [
        { item: wanderTask(), weight: 1 },
        { item: t('idle', null, rr(2, 5)), weight: 0.8 },
      ])!;
    }

    if (!this.adult) {
      const parent = ctx.creatures.find((c) => this.parentIds?.includes(c.id) && !c.gone);
      return weightedPick(rand, [
        { item: parent ? t('follow', null, rr(1, 3), { friend: parent }) : wanderTask(), weight: 1.6 },
        { item: wanderTask(), weight: 0.6 },
        { item: t('idle', null, rr(1.5, 4)), weight: 0.6 },
        { item: t('nap', null, rr(6, 12)), weight: ctx.isNight ? 1.5 : 0.25 },
      ])!;
    }

    const options: { item: () => Task; weight: number }[] = [
      { item: wanderTask, weight: 0.8 + p.curiosity * 0.6 },
      { item: () => t('idle', null, rr(2, 5)), weight: 0.5 },
      { item: () => t('nap', null, ctx.isNight ? rr(14, 24) : rr(7, 12)), weight: (0.15 + (1 - p.energy) * 0.4) * (ctx.isNight ? 4 : 1) },
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
          const reach = this.reachHeight + 0.1;
          const fruit = task.tree.fruits.filter((f) => f.ripe && f.height <= reach).sort((x, y) => y.height - x.height)[0];
          if (fruit) {
            pickFruit(fruit, ctx.time);
            const at = new THREE.Vector3();
            fruit.mesh.getWorldPosition(at);
            fx.burst(at, (fruit.mesh.material as THREE.MeshToonMaterial).color.getHex(), 6, { speed: 0.8, up: 1.5 });
            ctx.produce(this, 'fruit', 1);
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
        }
        break;
      }
      case 'swim': {
        if ((task.laps ?? 0) > 0) {
          task.laps! -= 1;
          task.target = randomPondPoint(rand);
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
        }
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
        }
        break;
      }
      case 'visit': {
        if (task.friend) this.face(task.friend.x, task.friend.z, dt);
        if (!task.fired && task.friend) {
          task.fired = true;
          if (this.plan.sociability > 0.45) fx.emote('❤️', this.rig.emoteAnchor);
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
        if (found) ctx.produce(this, 'roots', found);
        else ctx.effects.emote('…', this.rig.emoteAnchor);
        break;
      }
      case 'swim': {
        if (rand() < 0.3 + 0.7 * a.swim) ctx.produce(this, 'shells', a.swim > 0.65 && rand() < 0.4 ? 2 : 1);
        break;
      }
      case 'fly': {
        if (task.flower) {
          task.flower.bloom = 1;
          ctx.effects.burst(new THREE.Vector3(task.flower.x, terrainHeight(task.flower.x, task.flower.z) + 0.8, task.flower.z), 0xfff1a8, 10, { speed: 1.2, up: 1.5, gravity: 1, life: 1.4, size: 0.7 });
        }
        ctx.produce(this, 'nectar', a.fly > 0.7 ? 2 : 1);
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

  /** Apply position, pose and procedural animation to the meshes. */
  private syncRig(dt: number, time = 0) {
    const rig = this.rig;
    const p = this.plan;
    const s = this.skeleton;
    const task = this.task;
    const acting = !!task?.arrived;
    const kind = task?.kind ?? 'idle';
    const moving = clamp(this.speed / 1.2, 0, 1);

    // Height: ground, water surface, or sky.
    const ground = terrainHeight(this.x, this.z);
    let baseY = ground;
    const inWater = isWater(this.x, this.z);
    if (inWater) baseY = Math.max(ground, WATER_LEVEL - s.bodyHeight * this.growth * 0.8);
    baseY += this.altitude;
    this.y = dt > 0 ? lerp(this.y, baseY, Math.min(1, dt * 8)) : baseY;

    rig.root.position.set(this.x, this.y, this.z);
    rig.root.rotation.y = this.heading;
    rig.scaler.scale.setScalar(this.growth);
    rig.head.scale.setScalar(1 + (1 - this.growth) * 0.6);

    // Pose targets.
    const target = { drop: 0, pitch: 0, headPitch: 0, eyes: 1, fold: 0 };
    if (acting && kind === 'forage') {
      target.pitch = 0.1;
      target.headPitch = 0.5;
    } else if (acting && kind === 'dig') {
      target.pitch = -0.2;
      target.headPitch = -0.55;
    } else if (acting && kind === 'nap') {
      target.drop = p.legPairs > 0 ? s.bodyHeight - p.girth * 0.8 : 0.05;
      target.headPitch = -0.25;
      target.eyes = 0.08;
      target.fold = 1;
    } else if (kind === 'fly' && this.altitude > 0.4) {
      target.pitch = acting ? 0.05 : -0.08;
    }
    const k = Math.min(1, dt * 4);
    for (const key of Object.keys(target) as (keyof typeof target)[]) this.pose[key] = lerp(this.pose[key], target[key], k);
    const pose = this.pose;

    // Look around when idle.
    if (time > this.lookAt) {
      this.lookAt = time + rr(1.5, 4);
      this.lookYaw = kind === 'idle' || kind === 'wander' ? rr(-0.6, 0.6) : 0;
    }

    const swimming = inWater && this.altitude < 0.3;
    const flying = this.altitude > 0.4;
    const gaitPhase = swimming ? time * 6 : this.walkPhase;
    const swing = (flying ? 0 : swimming ? 0.6 : 0.55 * moving) * (1 - pose.fold);
    const bob = swimming ? Math.sin(time * 2) * 0.04 : Math.abs(Math.sin(this.walkPhase)) * 0.05 * moving * (p.legPairs > 0 ? p.legLength : 0.4);
    const digJitter = acting && kind === 'dig' ? Math.sin(time * 30) * 0.03 : 0;

    rig.body.position.set(digJitter, -pose.drop + bob, 0);
    rig.body.rotation.z = pose.pitch + (flying ? Math.sin(time * 2) * 0.04 : 0);
    rig.body.rotation.x = Math.sin(this.walkPhase) * 0.03 * moving;
    rig.body.scale.set(1, 1 + Math.sin(time * 2.2) * 0.015, 1);

    if (p.legPairs === 0) {
      // Legless: wriggle along.
      rig.body.rotation.y = Math.sin(this.walkPhase * 0.8) * 0.14 * moving;
      rig.body.scale.x = 1 + Math.sin(this.walkPhase * 1.6) * 0.06 * moving;
    } else {
      rig.body.rotation.y = 0;
    }

    rig.head.rotation.z = pose.headPitch + (acting && kind === 'forage' ? Math.sin(time * 8) * 0.06 : 0);
    rig.head.rotation.y = lerp(rig.head.rotation.y, this.lookYaw, Math.min(1, dt * 2));

    const happy = kind === 'visit' || kind === 'court' || kind === 'follow';
    rig.tail.rotation.y = Math.sin(time * (happy ? 9 : 2.5) + this.walkPhase * 0.3) * (happy ? 0.45 : 0.18);
    rig.tail.rotation.z = Math.sin(time * 1.3) * 0.06;

    const frontHalf = Math.max(1, p.legPairs) / 2;
    for (const leg of rig.legs) {
      const offset = (leg.pair % 2 === 0 ? 0 : Math.PI) + (leg.side === 1 ? 0 : Math.PI);
      const ph = gaitPhase + offset;
      const fold = (leg.pair < frontHalf ? 1.35 : -1.35) * pose.fold;
      const dangle = flying ? -0.35 + Math.sin(time * 3 + leg.pair) * 0.08 : 0;
      leg.hip.rotation.z = Math.sin(ph) * swing + fold + dangle;
      leg.knee.rotation.z = -Math.max(0, Math.cos(ph)) * swing * 1.1 - (flying ? 0.5 : 0) - pose.fold * 0.2;
    }

    const flap = flying ? 0.25 + Math.sin(time * 14) * 0.8 : kind === 'fly' ? 0.6 + Math.sin(time * 9) * 0.5 : 1.15 + Math.sin(time * 1.3) * 0.06;
    for (const w of rig.wings) w.pivot.rotation.x = -w.side * flap;

    // Blink.
    if (time > this.blinkAt + 0.13) this.blinkAt = time + rr(2, 6);
    const blink = time > this.blinkAt ? 0.1 : 1;
    for (const eye of rig.eyes) eye.scale.y = Math.max(0.06, pose.eyes * blink);
  }

  dispose() {
    this.rig.root.removeFromParent();
    this.rig.dispose();
  }
}
