import { clamp01, lerp } from '../core/rng';
import type { BodyPlan } from './phenotype';
import type { Sprout } from './sprouts';

/**
 * Skeleton layout: where every body part sits, in creature-local space and in
 * real metres (the plan's `size` is applied here).
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
  /** Hip height above the ground: how far the leg must reach. */
  length: number;
  radius: number;
  side: 1 | -1;
  pair: number;
}

/** Where one sprout grows. Build attaches it to `part` so it moves with that part. */
export interface SproutLayout {
  sprout: Sprout;
  part: 'body' | 'neck' | 'head' | 'tail';
  at: V3;
  /** Unit vector it grows along at the base. */
  dir: V3;
  length: number;
  radius: number;
}

export interface Skeleton {
  /** The plan's size multiplier; shape-unit plan values times this give metres. */
  scale: number;
  spine: V3[];
  radii: number[];
  /** Top of the back (body or shell) above each spine sample, for fins and fluff. */
  backTop: number[];
  /** Cross-section width and height relative to the radius. */
  widthScale: number;
  heightScale: number;
  neck: V3[];
  neckRadii: number[];
  head: { center: V3; radius: number };
  tail: V3[];
  tailRadii: number[];
  legs: LegLayout[];
  /** Legless creatures with tentacle genes walk on these instead. */
  tentacles: LegLayout[];
  spikes: { at: V3; height: number }[];
  shell: { center: V3; rx: number; ry: number; rz: number } | null;
  sprouts: SproutLayout[];
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

/** Body radius along the spine in metres, t = 0 at the tail end and 1 at the chest. */
export function bodyRadiusAt(p: BodyPlan, t: number): number {
  const envelope = Math.pow(Math.max(0, Math.sin(Math.PI * t)), 0.5);
  const taper = 1 + 0.55 * p.taper * (t - 0.5) * 2;
  const segment = 1 - p.lumps + p.lumps * (0.5 - 0.5 * Math.cos(2 * Math.PI * p.segments * t));
  return p.girth * p.size * envelope * taper * segment;
}

/** Tail centre line, relative to the tail base, in the xy plane. Never dips below `floor`. */
function tailPath(p: BodyPlan, TL: number, floor: number): V3[] {
  const pt = (dx: number, dy: number) => v(-dx, Math.max(floor, dy));
  switch (p.tailShape) {
    case 'whip': {
      const L = TL * 1.3;
      return [v(0, 0), pt(L * 0.25, L * 0.14), pt(L * 0.5, L * 0.06), pt(L * 0.75, L * 0.12), pt(L, L * 0.02)];
    }
    case 'curl': {
      // Back, then up and over in a tightening spiral, like a pig's tail.
      const L = Math.max(0.25, TL * 0.8);
      const r0 = L * 0.32;
      const cx = -L * 0.38;
      const cy = Math.max(floor, -L * 0.05) + r0;
      const pts = [v(0, 0)];
      for (let i = 0; i <= 8; i++) {
        const a = (i / 8) * Math.PI * 1.65;
        const r = r0 * (1 - 0.5 * (i / 8));
        const th = -Math.PI / 2 - a;
        pts.push(v(cx + Math.cos(th) * r, cy + Math.sin(th) * r));
      }
      return pts;
    }
    case 'fan':
      return [v(0, 0), pt(TL * 0.35, TL * 0.1), pt(TL * 0.7, TL * 0.08), pt(TL, TL * 0.04)];
    default:
      return [v(0, 0), pt(TL * 0.35, TL * 0.16), pt(TL * 0.7, TL * 0.12), pt(TL, -TL * 0.04)];
  }
}

export function buildSkeleton(p: BodyPlan): Skeleton {
  const k = p.size;
  const L = p.bodyLength * k;
  const G = p.girth * k;
  const w = p.bodyWidth;
  const hs = p.bodyTall;
  const hasLegs = p.legPairs > 0;
  const octopus = !hasLegs && p.legStyle === 'tentacles';
  const tentacleLength = (0.3 + p.legLength * 0.4) * k;
  const bodyHeight = hasLegs ? p.legLength * k + G * 0.7 * hs : G * 0.82 * hs + (octopus ? tentacleLength * 0.75 : 0);

  const spineY = (t: number) => bodyHeight + p.arch * Math.sin(Math.PI * t) * L * 0.22;
  const spineAt = (t: number) => v((t - 0.5) * L, spineY(t));
  const radiusAt = (t: number) => bodyRadiusAt(p, t);

  const spine: V3[] = [];
  const radii: number[] = [];
  for (let i = 0; i < SPINE_SAMPLES; i++) {
    const t = i / (SPINE_SAMPLES - 1);
    spine.push(spineAt(t));
    radii.push(radiusAt(t));
  }

  // Shell: a dome over the middle of the back.
  let shell: Skeleton['shell'] = null;
  if (p.shell) {
    const mid = spineAt(0.5);
    const r = radiusAt(0.5);
    shell = { center: v(mid.x, mid.y - r * hs * 0.2), rx: L * 0.42, ry: r * hs * 1.35, rz: r * w * 1.22 };
  }
  const backTop = spine.map((s, i) => {
    let top = s.y + radii[i] * hs;
    if (shell) {
      const dx = (s.x - shell.center.x) / shell.rx;
      if (Math.abs(dx) < 1) top = Math.max(top, shell.center.y + shell.ry * Math.sqrt(1 - dx * dx));
    }
    return top;
  });
  const backAt = (t: number) => backTop[Math.round(t * (SPINE_SAMPLES - 1))];

  // Neck: rises more steeply the longer it is (giraffe vs. dachshund).
  const shoulderT = 0.86;
  const shoulder = spineAt(shoulderT);
  const neckLen = (p.neckLength + p.girth * 0.45) * k;
  const angle = lerp(0.15, 1.2, clamp01(p.neckLength / 2));
  const dir = v(Math.cos(angle), Math.sin(angle));
  const neckEnd = v(shoulder.x + dir.x * neckLen, shoulder.y + dir.y * neckLen);
  const neckMid = v(shoulder.x + dir.x * neckLen * 0.5 - dir.y * neckLen * 0.06, shoulder.y + dir.y * neckLen * 0.5 + dir.x * neckLen * 0.08);
  const headSize = p.headSize * k;
  const neckStartR = Math.min(radiusAt(shoulderT) * 0.85, G * 0.6);
  const neckEndR = Math.min(neckStartR, headSize * 0.55);
  const neck = [shoulder, neckMid, neckEnd];
  const neckRadii = [neckStartR, lerp(neckStartR, neckEndR, 0.6), neckEndR];

  const head = { center: v(neckEnd.x + headSize * (0.35 + Math.max(0, p.headStretch) * 0.15), neckEnd.y + headSize * 0.1), radius: headSize };

  // Tail: lifts, then droops (or whips, curls…). Never dips below the grass.
  const tailBase = spineAt(0.07);
  const TL = p.tailLength * k;
  const tail = tailPath(p, TL, 0.12 - tailBase.y).map((q) => v(tailBase.x + q.x, tailBase.y + q.y));
  const tailStartR = G * 0.42 * (p.tailShape === 'whip' ? 0.75 : 1);
  const tipR = p.tailShape === 'whip' ? 0.015 : 0.035 * k;
  const tailRadii = tail.map((_, i) => lerp(tailStartR, tipR, Math.pow(i / (tail.length - 1), 0.8)));

  const legs: LegLayout[] = [];
  const legTs = p.legPairs === 1 ? [0.5] : Array.from({ length: p.legPairs }, (_, i) => lerp(0.22, 0.8, i / Math.max(1, p.legPairs - 1)));
  const hipOut = p.legStyle === 'splayed' ? 0.85 : 0.62;
  legTs.forEach((t, pair) => {
    const s = spineAt(t);
    const r = radiusAt(t);
    const hipY = s.y - r * hs * 0.5;
    for (const side of [1, -1] as const) {
      legs.push({ hip: v(s.x, hipY, side * r * w * 0.92 * hipOut), length: hipY, radius: p.legGirth * k, side, pair });
    }
  });

  // An octopus skirt: four tentacles a side under the front of the body.
  const tentacles: LegLayout[] = [];
  if (octopus) {
    for (let i = 0; i < 4; i++) {
      const t = lerp(0.3, 0.85, i / 3);
      const s = spineAt(t);
      const r = radiusAt(t);
      const hipY = s.y - r * hs * 0.6;
      for (const side of [1, -1] as const) {
        tentacles.push({ hip: v(s.x, hipY, side * r * w * 0.5), length: hipY, radius: Math.max(0.05, p.legGirth * 1.1) * k, side, pair: i });
      }
    }
  }

  const spikes: Skeleton['spikes'] = [];
  if (p.spikes > 0) {
    for (let i = 0; i < p.segments; i++) {
      const t = lerp(0.14, 0.86, (i + 0.5) / p.segments);
      spikes.push({ at: v(spineAt(t).x, backAt(t) - radiusAt(t) * hs * 0.1), height: p.spikes * G * 0.9 });
    }
  }

  const wingT = 0.66;
  const wingRoot = p.wingSpan > 0 ? v(spineAt(wingT).x, backAt(wingT) - radiusAt(wingT) * hs * 0.25) : null;

  const reach = head.center.y + headSize * 0.6;
  const shellMass = shell ? L * G * G * 0.5 : 0;
  const mass = L * G * G * 1.6 * w * hs + Math.pow(headSize, 3) * 2 + p.legPairs * p.legLength * p.legGirth * 0.6 * k * k * k + shellMass;
  const tailReach = p.tailShape === 'curl' ? TL * 0.5 : p.tailShape === 'whip' ? TL * 1.2 : TL * 0.9;
  const length = L + tailReach + neckLen * Math.cos(angle) + headSize * 1.5;

  const skel: Skeleton = {
    scale: k, spine, radii, backTop, widthScale: w, heightScale: hs, neck, neckRadii, head, tail, tailRadii, legs, tentacles,
    spikes, shell, sprouts: [], wingRoot, reach, mass, length, bodyHeight,
  };
  skel.sprouts = layoutSprouts(p, skel);
  return skel;
}

/** Point, tangent and radius at `t` along a polyline with per-point radii. */
function along(points: V3[], radii: number[], t: number) {
  const f = clamp01(t) * (points.length - 1);
  const i = Math.min(points.length - 2, Math.floor(f));
  const a = points[i];
  const b = points[i + 1];
  const tx = b.x - a.x;
  const ty = b.y - a.y;
  const len = Math.hypot(tx, ty) || 1;
  return { at: v(lerp(a.x, b.x, f - i), lerp(a.y, b.y, f - i)), tx: tx / len, ty: ty / len, r: lerp(radii[i], radii[i + 1], f - i) };
}

function layoutSprouts(p: BodyPlan, s: Skeleton): SproutLayout[] {
  const out: SproutLayout[] = [];
  const minR = 0.025 * s.scale;
  for (const sprout of p.sprouts) {
    const sides: (1 | -1)[] = sprout.mirrored ? [1, -1] : [1];
    const ca = Math.cos(sprout.around);
    const sa = Math.sin(sprout.around);
    for (let r = 0; r < sprout.repeat; r++) {
      const spread = (r - (sprout.repeat - 1) / 2) * 0.12;
      for (const side of sides) {
        const z = sprout.mirrored ? side * sa : 0;
        const y = sprout.mirrored ? ca : sprout.around > Math.PI / 2 ? -1 : 1;
        let at: V3;
        let dir: V3;
        let base: number;
        let part: SproutLayout['part'] = 'body';
        if (sprout.site === 'head') {
          part = 'head';
          const fx = lerp(-0.8, 0.8, clamp01(sprout.u + spread));
          const n = Math.hypot(fx, y, z) || 1;
          dir = v(fx / n, y / n, z / n);
          const hr = s.head.radius;
          at = v(s.head.center.x + dir.x * hr * 0.9, s.head.center.y + dir.y * hr * 0.9, dir.z * hr * 0.9);
          base = hr * 0.5;
        } else {
          const line = sprout.site === 'neck' ? along(s.neck, s.neckRadii, sprout.u + spread)
            : sprout.site === 'tail' ? along(s.tail, s.tailRadii, lerp(0.25, 1, clamp01(sprout.u + spread)))
            : along(s.spine, s.radii, lerp(0.12, 0.9, clamp01(sprout.u + spread)));
          part = sprout.site === 'back' ? 'body' : sprout.site;
          // "Up" is perpendicular to the line in the xy plane.
          const ux = -line.ty;
          const uy = line.tx;
          const width = sprout.site === 'back' ? s.widthScale : 1;
          const height = sprout.site === 'back' ? s.heightScale : 1;
          dir = v(ux * y, uy * y, z);
          const n = Math.hypot(dir.x, dir.y, dir.z) || 1;
          dir = v(dir.x / n, dir.y / n, dir.z / n);
          at = v(line.at.x + ux * y * line.r * height * 0.9, line.at.y + uy * y * line.r * height * 0.9, z * line.r * width * 0.9);
          base = line.r;
        }
        out.push({ sprout, part, at, dir, length: sprout.length * s.scale, radius: Math.max(minR, sprout.thickness * base) });
      }
    }
  }
  return out;
}
