import { clamp, clamp01, lerp, smoothstep } from '../core/rng';
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

/** An arm hangs from the chest. Arms never reach the ground, so they are free to wave, reach and grab. */
export interface ArmLayout {
  shoulder: V3;
  /** Unit vector the arm hangs along at rest. */
  dir: V3;
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
  /** Unit vector out of the back at each spine sample: perpendicular to the spine, in the xy plane. */
  up: V3[];
  /** Top of the back (body or shell) at each spine sample, for fins and fluff. */
  back: V3[];
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
  arms: ArmLayout[];
  spikes: { at: V3; dir: V3; height: number }[];
  /** A dome over the middle of the back; `tilt` follows the spine there. */
  shell: { center: V3; rx: number; ry: number; rz: number; tilt: number } | null;
  /** A round belly hanging under the middle of the torso, tipped like the spine there. */
  belly: { center: V3; rx: number; ry: number; rz: number; tilt: number } | null;
  sprouts: SproutLayout[];
  wingRoot: V3 | null;
  /** Highest point the mouth (or a hand) can reach when stretching, in metres. */
  reach: number;
  mass: number;
  /** Nose-to-tail length, used for spacing and camera framing. */
  length: number;
  /** Height of the body's centre line above the ground, at the middle of the spine. */
  bodyHeight: number;
  /** How far the body can drop to sit or nap with its underside on the ground. */
  sitDrop: number;
}

export const SPINE_SAMPLES = 40;

const v = (x: number, y: number, z = 0): V3 => ({ x, y, z });

/**
 * Where along the spine the waist pinches: toward the lighter end, so the heavy end swells
 * into an abdomen (heavy rear, like an ant) or a barrel chest (heavy front).
 */
export const waistAt = (p: BodyPlan) => 0.5 - 0.1 * p.taper;

/**
 * Body radius along the spine in metres, t = 0 at the tail end and 1 at the chest. Like the
 * metaballs along a Spore spine, each sample can swell or pinch: taper, lumps and the waist
 * all reshape the profile.
 */
export function bodyRadiusAt(p: BodyPlan, t: number): number {
  const envelope = Math.pow(Math.max(0, Math.sin(Math.PI * t)), 0.5);
  const taper = 1 + 0.55 * p.taper * (t - 0.5) * 2;
  const segment = 1 - p.lumps + p.lumps * (0.5 - 0.5 * Math.cos(2 * Math.PI * p.segments * t));
  const pinch = 1 - p.waist * Math.exp(-(((t - waistAt(p)) / 0.085) ** 2));
  return p.girth * p.size * envelope * taper * segment * pinch;
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
  const N = SPINE_SAMPLES;
  const hasLegs = p.legPairs > 0;
  const octopus = !hasLegs && p.legStyle === 'tentacles';
  const tentacleLength = (0.3 + p.legLength * 0.4) * k;

  // The spine is walked out from the tail end. Its angle is the arch's slope plus the
  // posture tilt: the whole body pitches up on legs, only the front rears up when legless.
  // A centaur's chest rears up from the middle, so the front half stands while the back half walks.
  const archSlope = (t: number) => Math.atan(p.arch * 0.22 * Math.PI * Math.cos(Math.PI * t));
  const tiltAt = (t: number) => (hasLegs ? p.tilt + p.rise * smoothstep(0.4, 0.72, t) : p.tilt * smoothstep(0.42, 0.95, t));
  const angles: number[] = [];
  const spine: V3[] = [];
  const step = L / (N - 1);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    angles.push(archSlope(t) + tiltAt(t));
    if (i === 0) spine.push(v(0, 0));
    else {
      const a = archSlope((i - 0.5) / (N - 1)) + tiltAt((i - 0.5) / (N - 1));
      spine.push(v(spine[i - 1].x + Math.cos(a) * step, spine[i - 1].y + Math.sin(a) * step));
    }
  }
  const radii = spine.map((_, i) => bodyRadiusAt(p, i / (N - 1)));
  const up = angles.map((a) => v(-Math.sin(a), Math.cos(a)));
  const idx = (t: number) => Math.round(clamp01(t) * (N - 1));

  // Upright bipeds balance over hips low on the body; everyone else turns about the middle.
  const uprightness = p.legPairs === 1 ? smoothstep(0.3, 1.2, p.tilt) : 0;
  const pivotT = lerp(0.5, 0.25, uprightness);
  const pivot = { ...spine[idx(pivotT)] };
  const startY = hasLegs ? p.legLength * k + G * 0.7 * hs : 0;
  for (const s of spine) {
    s.x -= pivot.x;
    s.y += startY - pivot.y;
  }

  // Legs spread along the body. Centaurs gather them under the back half; pinched bodies with a
  // heavy rear carry them on the front lobe, like an insect's thorax, and the abdomen rides behind.
  const rearing = smoothstep(0, 0.8, p.rise);
  const insect = p.waist > 0.25 && p.taper < 0.2 && rearing < 0.3;
  const legT0 = insect ? waistAt(p) + 0.1 : 0.22;
  const legT1 = insect ? Math.max(legT0 + 0.1, p.armPairs > 0 ? 0.78 : 0.9) : lerp(p.armPairs > 0 ? 0.68 : 0.8, 0.48, rearing);
  const legTs = p.legPairs === 1 ? [pivotT]
    : Array.from({ length: p.legPairs }, (_, i) => lerp(legT0, legT1, i / Math.max(1, p.legPairs - 1)));
  const hipOut = p.legStyle === 'splayed' ? 0.85 : 0.62;
  const hipAt = (t: number, sink: number) => {
    const i = idx(t);
    const r = radii[i] * hs * sink;
    return v(spine[i].x - up[i].x * r, spine[i].y - up[i].y * r);
  };

  // A round belly hangs under the middle of the torso.
  let belly: Skeleton['belly'] = null;
  if (p.belly > 0.02) {
    const bt = insect ? waistAt(p) * 0.55 : 0.46;
    const i = idx(bt);
    const r = radii[i];
    const drop = r * hs * (0.25 + 0.3 * p.belly);
    belly = {
      center: v(spine[i].x - up[i].x * drop, spine[i].y - up[i].y * drop),
      rx: Math.max(r, L * (0.16 + 0.12 * p.belly)), ry: r * hs * (0.7 + 0.35 * p.belly), rz: r * w * (0.85 + 0.35 * p.belly), tilt: angles[i],
    };
  }
  const bellyBottom = () => (belly ? belly.center.y - Math.hypot(belly.ry * Math.cos(belly.tilt), belly.rx * Math.sin(belly.tilt)) : Infinity);

  // Lift the body so its underside clears the grass and every hip has some leg below it.
  const bottoms = [...spine.map((s, i) => s.y - radii[i] * hs * Math.abs(up[i].y)), bellyBottom()];
  let lift = Math.max(0, (hasLegs ? 0.06 * k : 0.01 * k) - Math.min(...bottoms));
  if (hasLegs) for (const t of legTs) lift = Math.max(lift, 0.3 * p.legLength * k + 0.04 * k - hipAt(t, 0.5).y);
  if (octopus) lift += tentacleLength * 0.75;
  for (const s of spine) s.y += lift;
  if (belly) belly.center.y += lift;
  const minBottom = Math.min(...bottoms) + lift;

  const spineAt = (t: number) => spine[idx(t)];
  const radiusAt = (t: number) => radii[idx(t)];
  const upAt = (t: number) => up[idx(t)];

  // Shell: a dome over the middle of the back, tipped to follow the spine.
  let shell: Skeleton['shell'] = null;
  if (p.shell) {
    const mid = spineAt(0.5);
    const r = radiusAt(0.5);
    const n = upAt(0.5);
    shell = { center: v(mid.x - n.x * r * hs * 0.2, mid.y - n.y * r * hs * 0.2), rx: L * 0.42, ry: r * hs * 1.35, rz: r * w * 1.22, tilt: angles[idx(0.5)] };
  }
  const back = spine.map((s, i) => {
    let top = radii[i] * hs;
    if (shell) {
      const c = Math.cos(shell.tilt);
      const sn = Math.sin(shell.tilt);
      const along = ((s.x - shell.center.x) * c + (s.y - shell.center.y) * sn) / shell.rx;
      if (Math.abs(along) < 1) {
        const across = -(s.x - shell.center.x) * sn + (s.y - shell.center.y) * c;
        top = Math.max(top, shell.ry * Math.sqrt(1 - along * along) - across);
      }
    }
    return v(s.x + up[i].x * top, s.y + up[i].y * top);
  });
  const backAt = (t: number) => back[idx(t)];

  // Neck: rises more steeply the longer it is (giraffe vs. dachshund), and never leans
  // further forward than the chest it grows from, so upright bodies carry their heads on top.
  // A sunk head has next to no neck: it sits on the front of the body instead (see below).
  const shoulderT = 0.86;
  const shoulder = spineAt(shoulderT);
  const sink = p.headSink;
  const neckLen = Math.max(0.03 * k, (p.neckLength + p.girth * 0.45 * (1 - sink)) * k);
  const angle = Math.max(lerp(0.15, 1.2, clamp01(p.neckLength / 2)), angles[idx(shoulderT)] * 0.8);
  const dir = v(Math.cos(angle), Math.sin(angle));
  const neckEnd = v(shoulder.x + dir.x * neckLen, shoulder.y + dir.y * neckLen);
  const neckMid = v(shoulder.x + dir.x * neckLen * 0.5 - dir.y * neckLen * 0.06, shoulder.y + dir.y * neckLen * 0.5 + dir.x * neckLen * 0.08);
  const headSize = p.headSize * k;
  const neckStartR = Math.min(radiusAt(shoulderT) * 0.85, G * 0.6);
  const neckEndR = Math.min(neckStartR, headSize * 0.55);
  const neck = [shoulder, neckMid, neckEnd];
  const neckRadii = [neckStartR, lerp(neckStartR, neckEndR, 0.6), neckEndR];

  // A sunk head melts into the front of the body with most of its face showing, like a frog or a pufferfish.
  const onNeck = v(neckEnd.x + headSize * (0.35 + Math.max(0, p.headStretch) * 0.15), neckEnd.y + headSize * 0.1);
  // Half of it pokes out past the front of the body, however big the chest is.
  const tip = spine[N - 1];
  const fx = Math.cos(angles[N - 1]);
  const fy = Math.sin(angles[N - 1]);
  const front = Math.max(...spine.map((q, i) => (q.x - tip.x) * fx + (q.y - tip.y) * fy + radii[i] * Math.max(hs, w) * 0.9));
  const ahead = front - headSize * 0.45;
  const sunk = v(tip.x + fx * ahead + headSize * 0.1, tip.y + fy * ahead + headSize * 0.12);
  const head = { center: v(lerp(onNeck.x, sunk.x, sink), Math.max(headSize * 0.9, lerp(onNeck.y, sunk.y, sink))), radius: headSize };

  // Tail: lifts, then droops (or whips, curls…). Never dips below the grass.
  const tb = spineAt(0.07);
  const tailBase = v(tb.x, Math.max(tb.y, 0.13));
  const TL = p.tailLength * k;
  const tail = tailPath(p, TL, 0.12 - tailBase.y).map((q) => v(tailBase.x + q.x, tailBase.y + q.y));
  const tailStartR = G * 0.42 * (p.tailShape === 'whip' ? 0.75 : 1);
  const tipR = p.tailShape === 'whip' ? 0.015 : 0.035 * k;
  const tailRadii = tail.map((_, i) => lerp(tailStartR, tipR, Math.pow(i / (tail.length - 1), 0.8)));

  const legs: LegLayout[] = [];
  legTs.forEach((t, pair) => {
    const hip = hipAt(t, 0.5);
    const r = radiusAt(t);
    for (const side of [1, -1] as const) {
      legs.push({ hip: v(hip.x, hip.y, side * r * w * 0.92 * hipOut), length: hip.y, radius: p.legGirth * k, side, pair });
    }
  });

  // An octopus skirt: four tentacles a side under the front of the body.
  const tentacles: LegLayout[] = [];
  if (octopus) {
    for (let i = 0; i < 4; i++) {
      const t = lerp(0.3, 0.85, i / 3);
      const hip = hipAt(t, 0.6);
      const r = radiusAt(t);
      for (const side of [1, -1] as const) {
        tentacles.push({ hip: v(hip.x, hip.y, side * r * w * 0.5), length: hip.y, radius: Math.max(0.05, p.legGirth * 1.1) * k, side, pair: i });
      }
    }
  }

  // Arms hang from the chest, a little forward and out. Low bodies hold them forward
  // like a mantis, so hands stay off the ground.
  const arms: ArmLayout[] = [];
  const armR = (p.legGirth * 0.7 + 0.03) * k;
  for (let pair = 0; pair < p.armPairs; pair++) {
    const t = pair === 0 ? 0.82 : 0.66;
    const s = spineAt(t);
    const r = radiusAt(t);
    const n = upAt(t);
    const shoulderY = s.y + n.y * r * hs * 0.1;
    const room = shoulderY - armR * 1.6 - 0.05 * k;
    // Hang as steeply as the room allows; very low bodies get shorter arms held forward.
    const length = Math.min(p.armLength * k * 0.7, Math.max(p.armLength * k * 0.7 * 0.55, room / 0.3));
    const dy = -clamp(room / length, 0.3, 0.85);
    for (const side of [1, -1] as const) {
      const d = v(Math.sqrt(1 - dy * dy - 0.09), dy, side * 0.3);
      arms.push({ shoulder: v(s.x + n.x * r * hs * 0.1, shoulderY, side * r * w * 0.88), dir: d, length, radius: armR, side, pair });
    }
  }

  const spikes: Skeleton['spikes'] = [];
  if (p.spikes > 0) {
    for (let i = 0; i < p.segments; i++) {
      const t = lerp(0.14, 0.86, (i + 0.5) / p.segments);
      const b = backAt(t);
      const n = upAt(t);
      const sink = radiusAt(t) * hs * 0.1;
      spikes.push({ at: v(b.x - n.x * sink, b.y - n.y * sink), dir: n, height: p.spikes * G * 0.9 });
    }
  }

  const wingT = 0.66;
  const wb = backAt(wingT);
  const wn = upAt(wingT);
  const wingSink = radiusAt(wingT) * hs * 0.25;
  const wingRoot = p.wingSpan > 0 ? v(wb.x - wn.x * wingSink, wb.y - wn.y * wingSink) : null;

  const headReach = head.center.y + headSize * 0.6;
  const handReach = arms.length ? Math.max(...arms.map((a) => a.shoulder.y + a.length * 0.95)) : 0;
  const reach = Math.max(headReach, handReach);
  const shellMass = shell ? L * G * G * 0.5 : 0;
  const bellyMass = belly ? belly.rx * belly.ry * belly.rz * 2.5 : 0;
  const armMass = p.armPairs * p.armLength * 0.7 * Math.pow(p.legGirth * 0.7 + 0.03, 2) * 3 * k * k * k;
  const mass = L * G * G * 1.6 * w * hs + Math.pow(headSize, 3) * 2 + p.legPairs * p.legLength * p.legGirth * 0.6 * k * k * k + shellMass + armMass + bellyMass;
  const tailEnd = Math.min(...tail.map((q) => q.x), spine[0].x);
  const length = head.center.x + headSize * 1.3 - tailEnd;

  const skel: Skeleton = {
    scale: k, spine, radii, up, back, widthScale: w, heightScale: hs, neck, neckRadii, head, tail, tailRadii, legs, tentacles, arms,
    spikes, shell, belly, sprouts: [], wingRoot, reach, mass, length, bodyHeight: spineAt(0.5).y, sitDrop: Math.max(0, minBottom - 0.03 * k),
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
