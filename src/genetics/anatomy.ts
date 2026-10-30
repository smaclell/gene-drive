import { clamp01, lerp } from '../core/rng';
import type { BodyPlan } from './phenotype';

/**
 * Skeleton layout: where every body part sits, in creature-local space.
 * +x is forward, +y is up, z is the creature's left/right. The origin is on the
 * ground under the middle of the body.
 *
 * This is pure math so meshes (`creature/build.ts`) and ability scores
 * (`abilities.ts`) agree exactly: a long neck that *looks* tall *is* tall.
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface LegLayout {
  hip: V3;
  length: number;
  radius: number;
  side: 1 | -1;
  pair: number;
}

export interface Skeleton {
  spine: V3[];
  radii: number[];
  /** Cross-section width relative to height. */
  widthScale: number;
  neck: V3[];
  neckRadii: number[];
  head: { center: V3; radius: number };
  tail: V3[];
  tailRadii: number[];
  legs: LegLayout[];
  spikes: { at: V3; height: number }[];
  wingRoot: V3 | null;
  /** Highest point the mouth can reach when stretching, in metres. */
  reach: number;
  mass: number;
  /** Nose-to-tail length, used for spacing and camera framing. */
  length: number;
  /** Height of the body's centre line above the ground. */
  bodyHeight: number;
}

export const SPINE_SAMPLES = 40;

const v = (x: number, y: number, z = 0): V3 => ({ x, y, z });

/** Body radius along the spine, t = 0 at the tail end and 1 at the chest. */
export function bodyRadiusAt(p: BodyPlan, t: number): number {
  const envelope = Math.pow(Math.max(0, Math.sin(Math.PI * t)), 0.5);
  const taper = 1 + 0.35 * p.taper * (t - 0.5) * 2;
  const segment = 0.88 + 0.12 * (0.5 - 0.5 * Math.cos(2 * Math.PI * p.segments * t));
  return p.girth * envelope * taper * segment;
}

export function buildSkeleton(p: BodyPlan): Skeleton {
  const L = p.bodyLength;
  const hasLegs = p.legPairs > 0;
  const bodyHeight = hasLegs ? p.legLength + p.girth * 0.7 : p.girth * 0.82;

  const spineY = (t: number) => bodyHeight + p.arch * Math.sin(Math.PI * t) * L * 0.22;
  const spineAt = (t: number) => v((t - 0.5) * L, spineY(t));

  const spine: V3[] = [];
  const radii: number[] = [];
  for (let i = 0; i < SPINE_SAMPLES; i++) {
    const t = i / (SPINE_SAMPLES - 1);
    spine.push(spineAt(t));
    radii.push(bodyRadiusAt(p, t));
  }

  // Neck: rises more steeply the longer it is (giraffe vs. dachshund).
  const shoulderT = 0.86;
  const shoulder = spineAt(shoulderT);
  const neckLen = p.neckLength + p.girth * 0.45;
  const angle = lerp(0.15, 1.15, clamp01(p.neckLength / 1.9));
  const dir = v(Math.cos(angle), Math.sin(angle));
  const neckEnd = v(shoulder.x + dir.x * neckLen, shoulder.y + dir.y * neckLen);
  const neckMid = v(shoulder.x + dir.x * neckLen * 0.5 - dir.y * neckLen * 0.06, shoulder.y + dir.y * neckLen * 0.5 + dir.x * neckLen * 0.08);
  const neckStartR = Math.min(bodyRadiusAt(p, shoulderT) * 0.85, p.girth * 0.6);
  const neckEndR = Math.min(neckStartR, p.headSize * 0.55);
  const neck = [shoulder, neckMid, neckEnd];
  const neckRadii = [neckStartR, lerp(neckStartR, neckEndR, 0.6), neckEndR];

  const head = { center: v(neckEnd.x + p.headSize * 0.35, neckEnd.y + p.headSize * 0.1), radius: p.headSize };

  // Tail: lifts, then droops. Never dips below the grass.
  const tailT = 0.07;
  const tailBase = spineAt(tailT);
  const TL = p.tailLength;
  const tailPoint = (dx: number, dy: number) => v(tailBase.x - dx, Math.max(0.12, tailBase.y + dy));
  const tail = [tailBase, tailPoint(TL * 0.35, TL * 0.16), tailPoint(TL * 0.7, TL * 0.12), tailPoint(TL, -TL * 0.04)];
  const tailStartR = p.girth * 0.42;
  const tailRadii = [tailStartR, tailStartR * 0.7, tailStartR * 0.45, 0.035];

  const legs: LegLayout[] = [];
  const legTs = p.legPairs === 1 ? [0.5] : Array.from({ length: p.legPairs }, (_, i) => lerp(0.22, 0.8, i / Math.max(1, p.legPairs - 1)));
  const widthScale = 0.92;
  legTs.forEach((t, pair) => {
    const s = spineAt(t);
    const r = bodyRadiusAt(p, t);
    const hipY = s.y - r * 0.5;
    for (const side of [1, -1] as const) {
      legs.push({ hip: v(s.x, hipY, side * r * widthScale * 0.62), length: hipY, radius: p.legGirth, side, pair });
    }
  });

  const spikes: Skeleton['spikes'] = [];
  if (p.spikes > 0) {
    for (let i = 0; i < p.segments; i++) {
      const t = lerp(0.14, 0.86, (i + 0.5) / p.segments);
      const s = spineAt(t);
      spikes.push({ at: v(s.x, s.y + bodyRadiusAt(p, t) * 0.9), height: p.spikes * p.girth * 0.9 });
    }
  }

  const wingT = 0.66;
  const wingRoot = p.wingSpan > 0 ? v(spineAt(wingT).x, spineAt(wingT).y + bodyRadiusAt(p, wingT) * 0.75) : null;

  const reach = head.center.y + p.headSize * 0.6;
  const mass = L * p.girth * p.girth * 1.6 + Math.pow(p.headSize, 3) * 2 + p.legPairs * p.legLength * p.legGirth * 0.6;
  const length = L + TL * 0.9 + neckLen * Math.cos(angle) + p.headSize * 1.5;

  return { spine, radii, widthScale, neck, neckRadii, head, tail, tailRadii, legs, spikes, wingRoot, reach, mass, length, bodyHeight };
}
