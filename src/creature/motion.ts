import type * as THREE from 'three';
import { smoothstep } from '../core/rng';
import type { Skeleton } from '../genetics/anatomy';
import type { BodyPlan, Gait, Quirk } from '../genetics/phenotype';
import type { ArmRig, CreatureRig, LegRig, Wave } from './build';

/**
 * Procedural animation for a creature rig. Pure presentation: the sim decides
 * where a creature is and what it is doing; this poses the meshes to match.
 *
 * Each gait is a small function returning a `GaitFrame` (body bob, roll,
 * spine waves and an abstract swing/lift per leg). Leg-style adapters turn
 * swing/lift into joint rotations, so any gait works on any kind of leg.
 * Arms are free (they never carry weight), so they swing, reach, wave and snip
 * according to what the creature is doing.
 */

/** Special one-off motions: signature idles (quirks) and signature moves. */
export type ActionKind = Quirk | 'shake' | 'dive' | 'loop' | 'zoom';

export interface Pose {
  /** Body lowered by this much (napping). */
  drop: number;
  pitch: number;
  headPitch: number;
  /** Eye openness, 1 open … 0 shut. */
  eyes: number;
  /** Legs folded for a nap. */
  fold: number;
  /** Wings spread (1) or folded along the back (0). */
  wingOpen: number;
}

export const restPose = (): Pose => ({ drop: 0, pitch: 0, headPitch: 0, eyes: 1, fold: 0, wingOpen: 0 });

export interface MotionState {
  time: number;
  /** Gait phase in radians; advances with distance travelled. */
  phase: number;
  /** 0 standing … 1 full speed. */
  moving: number;
  swimming: boolean;
  /** In the air. */
  flying: boolean;
  pose: Pose;
  lookYaw: number;
  /** Wagging-tail mood (visiting, courting). */
  happy: boolean;
  digging: boolean;
  foraging: boolean;
  blink: boolean;
  action: { kind: ActionKind; t: number } | null;
}

/** Steps per stride. Higher is quicker and shorter. */
export const GAIT_CADENCE: Record<Gait, number> = {
  walk: 1, hop: 0.55, waddle: 1.8, prance: 0.9, scuttle: 2.2, bound: 0.75, slither: 0.8, inch: 0.7, bounce: 0.6, creep: 1.2, roll: 0.9, float: 0.5,
};

/** Some gaits move in surges (inchworms pull, then rest). Multiplies speed. */
export function gaitSurge(gait: Gait, phase: number): number {
  if (gait === 'inch') return 0.35 + 1.3 * Math.max(0, Math.cos(phase));
  if (gait === 'hop' || gait === 'bounce') return 0.6 + 0.8 * Math.max(0, Math.sin(phase));
  return 1;
}

interface LegMove {
  /** Forward swing of the whole leg, radians. */
  swing: number;
  /** How much the leg is lifted / bent, 0 … ~1.3. */
  lift: number;
}

interface GaitFrame {
  bob: number;
  pitch: number;
  roll: number;
  yaw: number;
  /** Vertical squash (1 = none). */
  squash: number;
  /** Lengthwise stretch (1 = none). */
  stretch: number;
  bendY: Wave | null;
  bendZ: Wave | null;
  head: number;
  tailLift: number;
  tailYaw: number;
  /** 0 … 1: tucked into a ball and spinning forward (the roll gait). */
  tuck: number;
  /** Forward spin while rolling, radians. */
  spin: number;
  leg: (leg: LegRig) => LegMove;
}

const diagonal = (leg: LegRig) => (leg.pair % 2 === 0 ? 0 : Math.PI) + (leg.side === 1 ? 0 : Math.PI);

/** Body motion and leg swing for one gait at one instant. */
function gaitFrame(gait: Gait, ph: number, m: number, plan: BodyPlan, skel: Skeleton, time: number): GaitFrame {
  const H = skel.bodyHeight;
  const L = skel.spine[skel.spine.length - 1].x - skel.spine[0].x;
  const k = skel.scale;
  const pairs = Math.max(1, plan.legPairs);
  const f: GaitFrame = {
    bob: 0, pitch: 0, roll: 0, yaw: 0, squash: 1, stretch: 1, bendY: null, bendZ: null, head: 0, tailLift: 0, tailYaw: 0, tuck: 0, spin: 0, leg: () => ({ swing: 0, lift: 0 }),
  };
  switch (gait) {
    case 'walk':
      f.bob = Math.abs(Math.sin(ph)) * 0.05 * H * m;
      f.roll = Math.sin(ph) * 0.03 * m;
      f.leg = (leg) => {
        const p = ph + diagonal(leg);
        return { swing: Math.sin(p) * 0.55 * m, lift: Math.max(0, Math.cos(p)) * 0.6 * m };
      };
      break;
    case 'hop': {
      // All legs together; the body arcs through the air.
      const air = Math.max(0, Math.sin(ph));
      const land = Math.max(0, -Math.sin(ph));
      f.bob = Math.pow(air, 0.8) * (0.22 * H + 0.15 * k) * m;
      f.pitch = Math.cos(ph) * 0.2 * m;
      f.squash = 1 - 0.12 * land * m;
      f.tailLift = air * 0.3 * m;
      f.leg = (leg) => {
        const front = leg.pair >= pairs / 2 || pairs === 1;
        return { swing: (front ? 0.35 : -0.55) * air * m + 0.15 * land * m, lift: (air * 0.9 + land * 0.4) * m };
      };
      break;
    }
    case 'waddle':
      f.bob = Math.abs(Math.sin(ph)) * 0.03 * H * m;
      f.roll = Math.sin(ph) * 0.16 * m;
      f.yaw = Math.sin(ph) * 0.09 * m;
      f.tailYaw = -Math.sin(ph) * 0.4 * m;
      f.leg = (leg) => {
        const p = ph + (leg.side === 1 ? 0 : Math.PI);
        return { swing: Math.sin(p) * 0.28 * m, lift: Math.max(0, Math.cos(p)) * 0.35 * m };
      };
      break;
    case 'prance':
      f.bob = Math.pow(Math.abs(Math.sin(ph)), 0.6) * 0.1 * H * m;
      f.pitch = 0.06 * m;
      f.head = Math.sin(ph * 2) * 0.12 * m;
      f.tailLift = 0.35 * m;
      f.leg = (leg) => {
        const p = ph + diagonal(leg);
        return { swing: Math.sin(p) * 0.6 * m, lift: Math.pow(Math.max(0, Math.cos(p)), 0.7) * 1.3 * m };
      };
      break;
    case 'scuttle':
      // A ripple runs from back to front, many short quick steps, body low.
      f.bob = -0.08 * H * m + Math.abs(Math.sin(ph * 2)) * 0.015 * H;
      f.leg = (leg) => {
        const p = ph - leg.pair * (Math.PI / Math.max(2, pairs)) + (leg.side === 1 ? 0 : Math.PI);
        return { swing: Math.sin(p) * 0.32 * m, lift: Math.max(0, Math.cos(p)) * 0.5 * m };
      };
      break;
    case 'bound': {
      // Front pair together, back pair together, and the spine flexes like a spring.
      const flex = Math.sin(ph);
      f.bob = Math.max(0, flex) * 0.12 * H * m;
      f.pitch = Math.cos(ph) * 0.12 * m;
      f.bendY = { amp: flex * 0.06 * L * m, waves: 0.5, phase: 0 };
      f.leg = (leg) => {
        const p = ph + (leg.pair >= pairs / 2 ? 0 : Math.PI) + leg.side * 0.15;
        return { swing: Math.sin(p) * 0.7 * m, lift: Math.max(0, Math.cos(p)) * 0.7 * m };
      };
      break;
    }
    case 'slither':
      // A sideways S-wave travels from head to tail.
      f.bendZ = { amp: L * (0.04 + 0.09 * m), waves: 1.1, phase: ph * 2 };
      break;
    case 'inch': {
      // The middle humps up as the back end pulls in, then the front reaches on.
      const hump = 0.5 + 0.5 * Math.sin(ph);
      f.bendY = { amp: L * 0.14 * hump * m, waves: 0.5, phase: 0 };
      f.stretch = 1 - 0.16 * hump * m;
      break;
    }
    case 'bounce': {
      const air = Math.max(0, Math.sin(ph));
      const land = Math.max(0, -Math.sin(ph));
      f.bob = air * (0.4 * H + 0.2 * k) * m;
      f.squash = 1 + 0.14 * air * m - 0.22 * land * m;
      f.pitch = Math.cos(ph) * 0.1 * m;
      break;
    }
    case 'creep':
      f.bob = Math.abs(Math.sin(ph)) * 0.04 * H * m;
      f.roll = Math.sin(ph * 0.5) * 0.05 * m;
      f.leg = (leg) => {
        const p = ph - leg.pair * 0.9 + (leg.side === 1 ? 0 : Math.PI / 2);
        return { swing: Math.sin(p) * 0.4 * m, lift: Math.max(0, Math.cos(p)) * 0.6 * m };
      };
      break;
    case 'roll': {
      // Tuck everything in and tumble forward like a pill bug; unroll on stopping.
      f.tuck = smoothstep(0.2, 0.6, m);
      f.spin = -wrapPi(ph) * f.tuck;
      f.head = -0.5 * f.tuck;
      f.tailLift = 0.6 * f.tuck;
      if (f.tuck < 0.5) {
        f.leg = (leg) => {
          const p = ph + diagonal(leg);
          return { swing: Math.sin(p) * 0.4 * m, lift: Math.max(0, Math.cos(p)) * 0.5 * m };
        };
      }
      break;
    }
    case 'float': {
      // Hover and pulse like a jellyfish, tentacles trailing behind; even standing still it drifts.
      const pulse = Math.sin(ph * 1.2 + time * 1.4);
      f.bob = (0.3 * k + 0.12 * H) + pulse * 0.06 * (H + k);
      f.squash = 1 + pulse * 0.07;
      f.pitch = -0.08 * m;
      f.leg = () => ({ swing: -0.45 * m - pulse * 0.15, lift: 0.35 + 0.3 * Math.max(0, -pulse) });
      break;
    }
  }
  return f;
}

/** Wrap an angle into (-π, π]. */
function wrapPi(a: number): number {
  return a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
}

/** What the arms are busy with this frame. Each returns shoulder swing, shoulder spread, elbow bend. */
interface ArmPose {
  swing: number;
  spread: number;
  bend: number;
}

function armPose(arm: ArmRig, s: MotionState, ph: number, m: number, plan: BodyPlan): ArmPose {
  const { time, pose, action } = s;
  const side = arm.side;
  const offset = arm.pair * 0.6 + (side === 1 ? 0 : Math.PI);
  // Swing opposite the legs when walking, a gentle sway when standing.
  let p: ArmPose = {
    swing: -Math.sin(ph + offset) * (plan.legPairs === 1 ? 0.55 : 0.3) * m + Math.sin(time * 1.3 + offset) * 0.06,
    spread: 0.05,
    bend: 0.15 + Math.max(0, Math.cos(ph + offset)) * 0.3 * m,
  };
  if (s.flying || pose.fold > 0.5) p = { swing: -0.35, spread: 0, bend: 1.3 };
  else if (s.foraging) p = { swing: 1.9 + Math.sin(time * 6 + offset) * 0.25, spread: 0.1, bend: -0.2 + Math.sin(time * 6 + offset) * 0.3 };
  else if (s.digging) p = { swing: 0.5 + Math.sin(time * 12 + offset) * 0.6, spread: 0.15, bend: 0.6 };
  else if (s.happy && side === 1 && arm.pair === 0) p = { swing: 2.3, spread: 0.35, bend: 0.4 + Math.sin(time * 10) * 0.5 };
  if (action) {
    const env = Math.sin(Math.PI * Math.min(1, action.t));
    const blend = (to: ArmPose) => {
      p = { swing: p.swing + (to.swing - p.swing) * env, spread: p.spread + (to.spread - p.spread) * env, bend: p.bend + (to.bend - p.bend) * env };
    };
    switch (action.kind) {
      case 'dance': blend({ swing: 2.4 + Math.sin(time * 8 + offset) * 0.4, spread: 0.5, bend: 0.3 + Math.sin(time * 8) * 0.4 }); break;
      case 'stretch': blend({ swing: 2.7, spread: 0.2, bend: -0.1 }); break;
      case 'sing': blend({ swing: 1.2, spread: 0.9, bend: 0.1 }); break;
      case 'twirl': blend({ swing: 0.8, spread: 1.3, bend: 0 }); break;
      case 'shake': blend({ swing: 2.5, spread: 0.3, bend: 0.2 + Math.sin(time * 18) * 0.3 }); break;
      case 'zoom': blend({ swing: -0.6, spread: 0, bend: 0.8 }); break;
      default: break;
    }
  }
  return p;
}

/** Turn an abstract swing/lift into joint rotations for each leg style. */
function poseLeg(leg: LegRig, move: LegMove, fold: number, frontHalf: boolean, time: number, wave: number) {
  const { hip, joints, side } = leg;
  const [knee, hock] = joints;
  switch (leg.style) {
    case 'digitigrade':
      // Sitting folds onto the haunches: thigh back, knee forward, hock back.
      hip.rotation.z = move.swing + (frontHalf ? 0.9 : -0.9) * fold;
      knee.rotation.z = move.lift * 0.8 + 1.1 * fold;
      hock.rotation.z = -move.lift * 0.9 - 1.3 * fold;
      break;
    case 'splayed':
      // Sweep around the vertical axis and lift outward, like a beetle.
      hip.rotation.y = side * move.swing * 0.8;
      hip.rotation.x = -side * (move.lift * 0.45 + fold * 0.55);
      knee.rotation.x = side * fold * 0.6;
      break;
    case 'tentacles':
      hip.rotation.z = move.swing * 0.6;
      joints.forEach((j, i) => {
        j.rotation.z = Math.sin(wave - i * 0.9) * (0.15 + move.lift * 0.35);
        j.rotation.x = side * (Math.sin(time * 1.3 + i + leg.pair) * 0.08 + move.lift * 0.25 + fold * 0.5);
      });
      break;
    default:
      hip.rotation.z = move.swing + (frontHalf ? 1.35 : -1.35) * fold;
      knee.rotation.z = -move.lift - fold * 0.2;
  }
}

/** Wag style by tail shape: whips lash, clubs swing slowly, curls bounce. */
function tailWag(plan: BodyPlan, time: number, phase: number, happy: boolean) {
  const mood = happy ? 2.2 : 1;
  switch (plan.tailShape) {
    case 'whip':
      return { yaw: Math.sin(time * 4 * mood + phase * 0.3) * 0.35, lift: Math.sin(time * 2.7) * 0.08 };
    case 'club':
      return { yaw: Math.sin(time * 1.4 * mood) * (happy ? 0.4 : 0.22), lift: 0 };
    case 'curl':
      return { yaw: Math.sin(time * 2 * mood) * 0.12, lift: Math.abs(Math.sin(time * 5 * mood)) * 0.12 };
    case 'fan':
      return { yaw: Math.sin(time * 2 * mood) * 0.2, lift: Math.sin(time * 1.6) * 0.1 };
    default:
      return { yaw: Math.sin(time * (happy ? 9 : 2.5) + phase * 0.3) * (happy ? 0.45 : 0.18), lift: Math.sin(time * 1.3) * 0.06 };
  }
}

/** Pose every pivot of a rig for this frame. */
export function animate(rig: CreatureRig, plan: BodyPlan, skel: Skeleton, s: MotionState) {
  const { time, pose, action } = s;
  const H = skel.bodyHeight;
  const legless = rig.legs.length === 0;
  // Swimming paddles on a clock; flying holds the legs still.
  const phase = s.swimming ? time * 6 : s.phase;
  const m = s.flying ? 0 : s.swimming ? 0.6 : s.moving;
  const g = gaitFrame(s.swimming && plan.gait !== 'slither' ? 'walk' : plan.gait, phase, m, plan, skel, time);

  let bob = g.bob;
  let pitch = pose.pitch + g.pitch;
  let roll = g.roll;
  let yaw = g.yaw;
  let head = pose.headPitch + g.head;
  let headYaw = s.lookYaw;
  let eyes = pose.eyes;
  let tailBoost = s.happy ? 1 : 0;
  let legKick = 0;
  let squash = g.squash;

  // Signature idles and moves layer on top of the gait.
  if (action) {
    const env = Math.sin(Math.PI * Math.min(1, action.t));
    switch (action.kind) {
      case 'stretch':
        pitch -= 0.35 * env;
        tailBoost = 1;
        eyes = Math.min(eyes, 1 - 0.8 * env);
        break;
      case 'chase':
        headYaw = 0.9;
        tailBoost = 1;
        break;
      case 'twirl':
        bob += env * 0.25 * H;
        pitch += 0.2 * env;
        break;
      case 'dance':
        bob += Math.abs(Math.sin(time * 8)) * 0.12 * H * env;
        roll += Math.sin(time * 4) * 0.2 * env;
        yaw += Math.sin(time * 4) * 0.25 * env;
        head += Math.sin(time * 8) * 0.15 * env;
        tailBoost = 1;
        break;
      case 'roll': {
        const angle = Math.PI * smoothstep(0, 0.25, action.t) * (1 - smoothstep(0.75, 1, action.t));
        roll += angle;
        bob += H * (1 - Math.cos(angle));
        legKick = env;
        break;
      }
      case 'sing':
        head += 0.5 * env;
        pitch += 0.1 * env;
        eyes = Math.min(eyes, 1 - 0.6 * env);
        break;
      case 'shake':
        roll += Math.sin(time * 18) * 0.15 * env;
        head += 0.3 * env;
        break;
      case 'dive':
        pitch -= 0.7 * env;
        break;
      case 'loop':
        pitch += Math.PI * 2 * smoothstep(0.1, 0.9, action.t);
        break;
      case 'zoom':
        pitch -= 0.08 * env;
        tailBoost = 1;
        break;
    }
  }

  const digJitter = s.digging ? Math.sin(time * 30) * 0.03 : 0;
  // Rolling: sink to a ball resting on the ground and spin about its middle.
  const tuck = g.tuck;
  const fold = Math.max(pose.fold, tuck);
  const spinX = H * Math.sin(g.spin);
  const spinY = H * (1 - Math.cos(g.spin));
  rig.body.position.set(digJitter + spinX, -pose.drop - skel.sitDrop * tuck * 0.9 + bob + spinY, 0);
  rig.body.rotation.set(roll, yaw, pitch + g.spin + (s.flying ? Math.sin(time * 2) * 0.04 : 0));
  const breathe = 1 + Math.sin(time * 2.2) * 0.015;
  rig.body.scale.set(g.stretch, squash * breathe, 1 / Math.sqrt(squash));

  const slopes = rig.bend(g.bendY, g.bendZ);
  // Legless creatures without a spine wave still wriggle a little.
  if (legless && !g.bendZ && !g.bendY && plan.gait !== 'bounce') rig.body.rotation.y += Math.sin(phase * 0.8) * 0.14 * m;

  // A head sunk into the body only turns a little, or it would twist the chest with it.
  const headFree = 1 - 0.7 * plan.headSink;
  rig.heads.forEach((h, i) => {
    h.rotation.z = (head + slopes.headPitch + (s.foraging ? Math.sin(time * 8) * 0.06 : 0)) * headFree;
    // A second head has a mind of its own.
    const target = (i === 0 ? headYaw - slopes.headYaw * 0.6 : -headYaw * 0.6 + Math.sin(time * 0.7) * 0.4) * headFree;
    h.rotation.y += (target - h.rotation.y) * 0.08;
  });
  for (const n of rig.necks) n.rotation.y = n.userData.baseYaw + slopes.headYaw * 0.4;

  // Tails are a chain of bones: each one follows the last a moment later, so wags curve.
  const wag = tailWag(plan, time, phase, tailBoost > 0);
  for (const t of rig.tails) {
    t.rotation.y = t.userData.baseYaw + wag.yaw * 0.6 + g.tailYaw + slopes.tailYaw;
    t.rotation.z = wag.lift + g.tailLift * 0.6 + slopes.tailPitch + (action?.kind === 'stretch' ? 0.5 : 0);
    (t.userData.chain as THREE.Object3D[] | undefined)?.forEach((b, i) => {
      const late = tailWag(plan, time - 0.12 * (i + 1), phase - 0.4 * (i + 1), tailBoost > 0);
      b.rotation.y = late.yaw * 0.45;
      b.rotation.z = late.lift * 0.4 + g.tailLift * 0.4;
    });
  }
  for (const t of rig.trunks) {
    t.rotation.z = Math.sin(time * 1.1) * 0.12 + (s.foraging ? 0.6 : 0) + (action?.kind === 'sing' ? 0.9 : 0);
    t.rotation.y = Math.sin(time * 0.8) * 0.15;
  }
  for (const sp of rig.sprouts) {
    const sway = sp.userData.sway * (1 + m);
    sp.rotation.x = Math.sin(time * 1.7 + sp.userData.phase) * sway;
    sp.rotation.z = Math.cos(time * 1.3 + sp.userData.phase) * sway * 0.7 - bob * 0.3;
  }

  for (const arm of rig.arms) {
    const a = armPose(arm, s, phase, m, plan);
    const tucked = Math.max(tuck, legKick);
    arm.shoulder.rotation.set(-arm.side * a.spread * (1 - tucked), 0, a.swing * (1 - tucked) - 0.2 * tucked);
    arm.elbow.rotation.z = a.bend * (1 - tucked) + 1.4 * tucked;
    if (arm.snip) {
      // Pincers open and close now and then, and busily when there is work to do.
      const busy = s.foraging || s.digging || s.happy || !!action;
      const open = busy ? 0.5 + 0.5 * Math.sin(time * 9 + arm.side) : Math.pow(Math.max(0, Math.sin(time * 0.9 + arm.side * 2)), 12);
      arm.snip.rotation.z = -0.55 * open;
    }
  }

  const frontHalf = Math.max(1, plan.legPairs) / 2;
  for (const leg of rig.legs) {
    let move = g.leg(leg);
    if (s.flying) move = { swing: -0.35 + Math.sin(time * 3 + leg.pair) * 0.08, lift: 0.5 };
    if (legKick) move = { swing: Math.sin(time * 10 + leg.pair + leg.side) * 0.6 * legKick, lift: 0.4 * legKick };
    if (action?.kind === 'stretch') move = { swing: (leg.pair < frontHalf ? -0.5 : 0.8) * Math.sin(Math.PI * action.t), lift: 0 };
    poseLeg(leg, { swing: move.swing * (1 - fold), lift: move.lift * (1 - fold) }, fold, leg.pair < frontHalf, time, phase * 1.5 + time * 0.6);
  }

  // Wings fold back along the body at rest and spread to flap.
  const open = pose.wingOpen;
  const flap = s.flying ? 0.25 + Math.sin(time * 14) * 0.8 : 0.6 + Math.sin(time * 9) * 0.5;
  for (const w of rig.wings) {
    w.pivot.rotation.set(-w.side * (0.25 * (1 - open) + flap * open), -w.side * 1.3 * (1 - open), 0);
  }

  const lids = s.blink ? 0.1 : 1;
  for (const eye of rig.eyes) eye.scale.y = Math.max(0.06, eyes * lids);
}

/** A still pose for previews (Lab, gallery): wings folded, nothing moving. */
export function restRig(rig: CreatureRig, plan: BodyPlan, skel: Skeleton, time = 0) {
  animate(rig, plan, skel, {
    time, phase: 0, moving: 0, swimming: false, flying: false, pose: restPose(), lookYaw: 0, happy: false, digging: false, foraging: false, blink: false, action: null,
  });
}
