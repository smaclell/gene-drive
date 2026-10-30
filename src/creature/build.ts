import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cells2, cells3, noise3 } from '../core/noise';
import { clamp, clamp01, lerp, mulberry32, smoothstep, type Rng } from '../core/rng';
import type { ArmLayout, LegLayout, Skeleton, SproutLayout, V3 } from '../genetics/anatomy';
import type { BodyPlan, Hands, Hsl, LegStyle } from '../genetics/phenotype';
import { creatureMaterials, type CreatureMaterials } from './materials';
import { SKIN_REGIONS, buildSkin, type SkinBlob, type SkinRegion } from './skin';

/**
 * Turns a skeleton into three.js meshes. No assets: every part is generated
 * from the body plan. The returned rig exposes the bones that animation moves
 * (see `motion.ts`).
 *
 * Like Spore, the body is two kinds of thing:
 * - **Skin:** torso, neck, head, snout, tail, legs, arms, feet and hands are blobs
 *   (see `skin.ts`) melted into one smooth `SkinnedMesh`, bound to a bone hierarchy,
 *   so joints bend without seams.
 * - **Rigblocks:** eyes, ears, horns, beaks, fins, wings, shells and sprouts are
 *   separate meshes riding on those bones.
 *
 * Layout of this file: paint → geometry helpers → part builders (head, mouth,
 * eyes, ears, horns, fluff, tails, sprouts, legs, arms, back) → `buildCreature`,
 * which assembles them, meshes the skin and wires up spine bending.
 *
 * Everything is in skeleton units (real metres). Plan values that are lengths
 * must be multiplied by `skel.scale` before use.
 */

export interface LegRig {
  /** Swings the whole leg. */
  hip: THREE.Object3D;
  /** Bending joints below the hip: knee, then hock or further tentacle segments. */
  joints: THREE.Object3D[];
  side: 1 | -1;
  pair: number;
  length: number;
  style: LegStyle;
}

export interface ArmRig {
  shoulder: THREE.Object3D;
  elbow: THREE.Object3D;
  wrist: THREE.Object3D;
  side: 1 | -1;
  pair: number;
  hands: Hands;
  /** The moving half of a pincer. */
  snip: THREE.Object3D | null;
}

/** A travelling sine wave along the body, u = 0 at the tail end and 1 at the chest. */
export interface Wave {
  amp: number;
  waves: number;
  phase: number;
}

/** Slopes (radians) at the ends of a bent spine, so tails and heads can follow the curve. */
export interface BendSlopes {
  tailYaw: number;
  headYaw: number;
  tailPitch: number;
  headPitch: number;
}

export interface CreatureRig {
  root: THREE.Group;
  /** Scales with age (babies are small). */
  scaler: THREE.Group;
  /** Bobs, pitches and squashes as a whole. */
  body: THREE.Group;
  /** The first head; `heads` holds both when there are two. */
  head: THREE.Object3D;
  heads: THREE.Object3D[];
  /** Bones at the shoulder that carry each neck and head. */
  necks: THREE.Object3D[];
  /** Bones at the tail base (two for twin tails). `userData.chain` holds the bones further along. */
  tails: THREE.Object3D[];
  trunks: THREE.Group[];
  /** Pivots at the base of each sprout, so they can sway. */
  sprouts: THREE.Group[];
  legs: LegRig[];
  arms: ArmRig[];
  wings: { pivot: THREE.Group; side: 1 | -1 }[];
  eyes: THREE.Object3D[];
  /** Point above the head where emotes float. */
  emoteAnchor: THREE.Object3D;
  /** Bend the torso and everything attached to it. Pass nulls to straighten. */
  bend: (y: Wave | null, z: Wave | null) => BendSlopes;
  dispose: () => void;
}

const vec = (p: V3) => new THREE.Vector3(p.x, p.y, p.z);

const toColor = (c: Hsl) => new THREE.Color().setHSL(c.h, c.s, c.l, THREE.SRGBColorSpace);

const IVORY = new THREE.Color(0xf4ecda);
const DARK = new THREE.Color(0x231c2a);
const MOUTH = new THREE.Color(0x4a2433);

// ---- Paint ---------------------------------------------------------------

/**
 * Spore paints in three layers: a base colour, a coat over the back and a detail
 * pattern. Here: `body` is the base, `coat` darkens the back, `accent` is the
 * pattern, `belly` the pale underside and `points` the darker hands and feet.
 */
interface Palette {
  body: THREE.Color;
  coat: THREE.Color;
  accent: THREE.Color;
  belly: THREE.Color;
  points: THREE.Color;
  iris: THREE.Color;
  plan: BodyPlan;
  seed: number;
  /** Creature-space x where the two-tone gradient starts and ends. */
  gradient: [number, number];
  eyespots: { at: THREE.Vector3; r: number }[];
  /** Default iridescence for skin parts. */
  sheen: number;
}

interface PaintOptions {
  /** Where this geometry's origin sits in creature space, so patterns line up across parts. */
  offset?: THREE.Vector3;
  /** Paint a flat colour instead of the skin pattern. */
  solid?: THREE.Color;
  /** Force a glow amount for the whole part (e.g. antenna tips). */
  glow?: number;
  /** Override iridescence (horns and beaks stay matte). */
  sheen?: number;
}

/** Writes the `color`, `glow` and `sheen` attributes the shared material reads. */
function setSkinAttributes(geo: THREE.BufferGeometry, colors: Float32Array, glows: Float32Array, sheen: number) {
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('glow', new THREE.BufferAttribute(glows, 1));
  geo.setAttribute('sheen', new THREE.BufferAttribute(new Float32Array(glows.length).fill(sheen), 1));
}

/** Where on the body a point is, for painting. `back` is 1 on the spine, -1 on the belly. */
interface Spot {
  x: number;
  y: number;
  z: number;
  back: number;
  region: SkinRegion;
  u: number;
  along: number;
}

/** How much detail (pattern) colour shows at a spot, 0 … 1. */
function patternAt(pal: Palette, p: Spot): number {
  const { plan } = pal;
  const s = plan.patternScale / plan.size;
  const shift = (pal.seed % 1000) * 0.37;
  const { x, y, z, back, region, u } = p;
  const limb = region === 'leg' || region === 'arm' || region === 'foot' || region === 'hand';
  switch (plan.pattern) {
    case 'spots': {
      // Round spots of mixed sizes, fewer toward the belly.
      const f = s * 1.7;
      const c = cells3(x * f + shift, y * f, z * f, pal.seed);
      const r = 0.16 + 0.22 * c.id;
      return smoothstep(r + 0.1, r - 0.06, c.f1) * smoothstep(-0.6, -0.15, back);
    }
    case 'patches': {
      // Giraffe-like plates of colour with pale seams between them.
      const f = s * 0.85;
      const c = cells3(x * f + shift, y * f, z * f, pal.seed);
      return smoothstep(0.08, 0.24, c.f2 - c.f1) * smoothstep(-0.5, -0.05, back) * (0.85 + 0.15 * c.id);
    }
    case 'stripes': {
      // Bands across the body that taper to points toward the belly, rings on tails, bars on upper limbs.
      const wobble = (noise3(x * 2.5 + shift, y * 2.5, z * 2.5) - 0.5) * 0.9;
      const coord = region === 'head' || region === 'snout' ? x : p.along;
      const wave = Math.sin((coord * s * 2.2 + wobble) * Math.PI * 2);
      if (region === 'tail') return smoothstep(0.0, 0.4, wave) * smoothstep(0.05, 0.2, u);
      const threshold = lerp(0.92, 0.05, smoothstep(-0.45, 0.75, back));
      const bar = smoothstep(threshold - 0.08, threshold + 0.2, wave);
      return limb ? bar * smoothstep(0.65, 0.35, u) : bar;
    }
    case 'plain':
      // Glowing creatures get freckles, so they still sparkle at night.
      return plan.glow ? smoothstep(0.7, 0.76, noise3(x * 5 + shift, y * 5, z * 5)) : 0;
  }
}

/** Layered skin colour at one spot: base, coat, detail, belly, points, finish. Returns the glow. */
function skinColour(pal: Palette, p: Spot, out: THREE.Color): number {
  const { plan } = pal;
  const { back, region, u } = p;
  out.copy(pal.body);
  if (plan.finish === 'gradient') out.lerp(pal.accent, smoothstep(pal.gradient[0], pal.gradient[1], p.x) * 0.85);
  // Coat: the back is darker, so bodies read as round from above, like most animals.
  out.lerp(pal.coat, smoothstep(-0.05, 0.75, back) * 0.8);
  const detail = patternAt(pal, p);
  out.lerp(pal.accent, detail);
  const belly = region === 'leg' || region === 'arm' || region === 'foot' || region === 'hand' ? 0 : smoothstep(-0.2, -0.7, back);
  out.lerp(pal.belly, belly * (1 - detail * 0.7));
  // Points: darker hands and feet, and a darker tail tip.
  const points = region === 'foot' || region === 'hand' ? 0.75
    : region === 'leg' || region === 'arm' ? smoothstep(0.55, 0.95, u) * 0.7
    : region === 'tail' ? smoothstep(0.8, 1, u) * 0.45 : 0;
  out.lerp(pal.points, points);
  let glow = plan.glow ? detail : 0;
  for (const spot of pal.eyespots) {
    const d = Math.hypot(p.x - spot.at.x, p.y - spot.at.y, p.z - spot.at.z) / spot.r;
    if (d >= 1) continue;
    if (d < 0.34) out.copy(DARK);
    else if (d < 0.66) out.copy(IVORY).lerp(pal.accent, 0.25);
    else out.copy(pal.accent).multiplyScalar(0.55);
    glow = plan.glow && d >= 0.34 && d < 0.66 ? 1 : glow;
  }
  return glow;
}

/** Bake skin colour, pattern, finish and glow mask into a rigblock's vertex attributes. */
function paint(geo: THREE.BufferGeometry, pal: Palette, opts: PaintOptions = {}): THREE.BufferGeometry {
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const colors = new Float32Array(pos.count * 3);
  const glows = new Float32Array(pos.count);
  const offset = opts.offset ?? new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    let glow = 0;
    if (opts.solid) {
      c.copy(opts.solid);
    } else {
      const x = pos.getX(i) + offset.x;
      glow = skinColour(pal, { x, y: pos.getY(i) + offset.y, z: pos.getZ(i) + offset.z, back: nrm.getY(i), region: 'neck', u: 0.5, along: x }, c);
    }
    colors.set([c.r, c.g, c.b], i * 3);
    glows[i] = opts.glow ?? glow;
  }
  setSkinAttributes(geo, colors, glows, opts.sheen ?? pal.sheen);
  return geo;
}

/** Turtle-shell plates: cells with dark seams. */
function paintShell(geo: THREE.BufferGeometry, pal: Palette, sx: number, sz: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const glows = new Float32Array(pos.count);
  const plate = pal.accent.clone().lerp(pal.coat, 0.3);
  const rim = plate.clone().multiplyScalar(0.7);
  const seam = plate.clone().multiplyScalar(0.45);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const u = (pos.getX(i) / sx) * 2.4;
    const v = (pos.getZ(i) / sz) * 1.6;
    const { f1, f2 } = cells2(u + 10, v + 10, pal.seed);
    const edge = smoothstep(0.02, 0.12, f2 - f1);
    c.copy(rim).lerp(plate, smoothstep(0.75, 0, f1)).lerp(seam, 1 - edge);
    colors.set([c.r, c.g, c.b], i * 3);
    glows[i] = pal.plan.glow ? (1 - edge) * 0.9 : 0;
  }
  setSkinAttributes(geo, colors, glows, pal.sheen);
  return geo;
}

// ---- Geometry helpers ---------------------------------------------------------

/**
 * A tube along a planar (xy) path with varying radius and closed ends.
 * Vertices are shared around each ring, so there is no shading seam.
 */
function tube(points: V3[], radii: number[], samples: number, radial: number): THREE.BufferGeometry {
  return splineTube(points.map(vec), radii, samples, radial);
}

/**
 * A tube along any 3D spline, using Frenet frames so it can curl and twist
 * freely. Used for sprouts, trunks, horns and the mouth line.
 */
function splineTube(points: THREE.Vector3[], radii: number[], samples: number, radial: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);
  const frames = curve.computeFrenetFrames(samples - 1, false);
  const radiusAt = (u: number) => {
    const f = u * (radii.length - 1);
    const i = Math.min(radii.length - 2, Math.floor(f));
    return THREE.MathUtils.lerp(radii[i], radii[i + 1], f - i);
  };
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    const c = curve.getPointAt(u);
    const n = frames.normals[i];
    const b = frames.binormals[i];
    const r = Math.max(0.003, radiusAt(u));
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const cos = Math.cos(a) * r;
      const sin = Math.sin(a) * r;
      positions.push(c.x + n.x * cos + b.x * sin, c.y + n.y * cos + b.y * sin, c.z + n.z * cos + b.z * sin);
    }
  }
  for (let i = 0; i < samples - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      indices.push(a, a + radial, b, b, a + radial, b + radial);
    }
  }
  const start = curve.getPointAt(0);
  const end = curve.getPointAt(1);
  const startIdx = positions.length / 3;
  positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
  const last = (samples - 1) * radial;
  for (let j = 0; j < radial; j++) {
    indices.push(startIdx, j, (j + 1) % radial);
    indices.push(startIdx + 1, last + ((j + 1) % radial), last + j);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function ellipsoid(radius: number, sx = 1, sy = 1, sz = 1, detail = 16): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(radius, detail, Math.max(8, Math.round(detail * 0.7)));
  g.scale(sx, sy, sz);
  return g;
}

const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);

/** A tapered cylinder from `a` to `b` in any direction. */
function segment(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, radial = 8): THREE.BufferGeometry {
  const dir = b.clone().sub(a);
  const len = Math.max(1e-4, dir.length());
  const g = new THREE.CylinderGeometry(r1, r0, len, radial);
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

/** A ball joint, so chained segments look continuous. */
function joint(at: THREE.Vector3, r: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 8, 6);
  g.translate(at.x, at.y, at.z);
  return g;
}

/** A curved, pointed cone (talons, tusks, pincer fingers) growing along +y and bending toward +x. */
function talon(radius: number, length: number, curve: number, flat = 1): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(radius, length, 8, 6);
  g.translate(0, length / 2, 0);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / length;
    pos.setX(i, pos.getX(i) + curve * length * t * t);
    pos.setZ(i, pos.getZ(i) * flat);
  }
  g.computeVertexNormals();
  return g;
}

/** Scalloped fan of skin in the xy plane, coloured from body at the centre to accent at the edge. */
function fan(radius: number, start: number, sweep: number, spokes: number, pal: Palette): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(radius, spokes * 6, start, sweep);
  const pos = g.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const glows = new Float32Array(pos.count);
  const rib = pal.accent.clone().multiplyScalar(0.6);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    const along = ((Math.atan2(y, x) - start + Math.PI * 4) % (Math.PI * 2)) / sweep;
    const wave = Math.abs(Math.cos(along * spokes * Math.PI));
    if (r > 1e-6) {
      const f = 0.84 + 0.16 * wave;
      pos.setXY(i, x * f, y * f);
    }
    c.copy(pal.body).lerp(pal.accent, Math.min(1, (r / radius) * 1.1)).lerp(rib, Math.pow(wave, 8) * 0.5 * (r / radius));
    colors.set([c.r, c.g, c.b], i * 3);
    glows[i] = pal.plan.glow ? (r / radius) * 0.8 : 0;
  }
  g.computeVertexNormals();
  setSkinAttributes(g, colors, glows, pal.sheen);
  return g;
}

/** Leaf-shaped wing lying in the xz plane, extending toward +z (or -z). */
function wingGeometry(span: number, side: 1 | -1): THREE.BufferGeometry {
  const chord = span * 0.42;
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.bezierCurveTo(span * 0.3, chord * 0.25, span * 0.8, chord * 0.2, span, -chord * 0.1);
  shape.bezierCurveTo(span * 0.85, -chord * 0.7, span * 0.45, -chord * 1.05, span * 0.15, -chord * 0.7);
  shape.bezierCurveTo(span * 0.05, -chord * 0.5, 0, -chord * 0.3, 0, 0);
  const g = new THREE.ShapeGeometry(shape, 12);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    // Shape x (span) → z, shape y (chord) → x.
    pos.setXYZ(i, y, 0, x * side);
  }
  g.computeVertexNormals();
  return g;
}

// ---- Bones and blobs -----------------------------------------------------------

/** Shared state while one creature is being built. */
interface Ctx {
  plan: BodyPlan;
  skel: Skeleton;
  pal: Palette;
  mats: CreatureMaterials;
  skin: THREE.Material;
  membrane: THREE.Material;
  rng: Rng;
  seed: number;
  /** Plan lengths × this = metres. */
  k: number;
  mesh: (geo: THREE.BufferGeometry, material: THREE.Material, shadow?: boolean) => THREE.Mesh;
  eyes: THREE.Object3D[];
  trunks: THREE.Group[];
  /** Every bone the skin is bound to, in skinIndex order. */
  bones: THREE.Bone[];
  blobs: SkinBlob[];
}

/** A new bone at a local position under `parent`. */
function addBone(ctx: Ctx, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Bone {
  const b = new THREE.Bone();
  b.position.set(x, y, z);
  b.userData.index = ctx.bones.length;
  parent.add(b);
  ctx.bones.push(b);
  return b;
}

const boneIds = (...bones: THREE.Object3D[]) => bones.map((b) => b.userData.index as number);

/** A point in `o`'s local space, in creature space (the creature is built at the origin). */
function at(o: THREE.Object3D, x = 0, y = 0, z = 0): V3 {
  o.updateWorldMatrix(true, false);
  const p = o.localToWorld(new THREE.Vector3(x, y, z));
  return { x: p.x, y: p.y, z: p.z };
}

const atV = (o: THREE.Object3D, v: THREE.Vector3) => at(o, v.x, v.y, v.z);

/** A direction in `o`'s local space, turned into creature space. */
function dirOf(o: THREE.Object3D, v: THREE.Vector3): V3 {
  const d = v.clone().applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion())).normalize();
  return { x: d.x, y: d.y, z: d.z };
}

/** Add a tapered capsule to the skin. */
function capsule(ctx: Ctx, region: SkinRegion, a: V3, b: V3, ra: number, rb: number, chain: number[], u0: number, u1: number, length: number, blend: number, up?: V3) {
  ctx.blobs.push({ region, a, b, ra, rb, chain, u0, u1, length, blend, up });
}

/** Add an ellipsoid to the skin, centred at `c` with local radii and rotation. */
function blobEllipsoid(ctx: Ctx, region: SkinRegion, c: V3, radii: V3, rotation: THREE.Quaternion, chain: number[], blend: number, u0 = 0, u1 = 1, length = 1) {
  ctx.blobs.push({ region, a: c, b: c, ra: 0, rb: 0, radii, rotation, chain, u0, u1, length, blend });
}

// ---- Part builders -----------------------------------------------------------

/** Head proportions: wide and flat (frog) … round … long (horse). */
function headScale(plan: BodyPlan) {
  const long = Math.max(0, plan.headStretch);
  const flat = Math.max(0, -plan.headStretch);
  return { sx: 1.05 + 0.55 * long + 0.1 * flat, sy: 0.95 - 0.12 * long - 0.35 * flat, sz: 0.95 - 0.15 * long + 0.35 * flat, long, flat };
}

function buildHead(ctx: Ctx, head: THREE.Object3D, hr: number, world: THREE.Vector3) {
  const { plan, pal, skin, mesh } = ctx;
  const hs = headScale(plan);
  const q = head.getWorldQuaternion(new THREE.Quaternion());
  // A sunk head melts softly into the chest, so face and body read as one shape.
  blobEllipsoid(ctx, 'head', at(head), { x: hr * hs.sx, y: hr * hs.sy, z: hr * hs.sz }, q, boneIds(head), hr * (0.45 + 0.55 * plan.headSink), 0, 1, hr * 2);
  buildMouth(ctx, head, hr, world);
  buildEyes(ctx, head, hr, world);
  buildEars(ctx, head, hr);
  buildHorns(ctx, head, hr);
  if (plan.fluff === 'crest') buildCrest(ctx, head, hr);
  if (plan.fluff === 'tufts') {
    for (const side of [1, -1]) {
      const tuft = mesh(paint(new THREE.IcosahedronGeometry(hr * 0.24, 1), pal, { solid: pal.belly }), skin);
      tuft.position.set(-hr * 0.1, -hr * 0.25 * hs.sy, side * hr * 0.85 * hs.sz);
      head.add(tuft);
    }
  }
}

/** A smiling mouth line across the lower front of an ellipsoid (in head space). */
function smile(ctx: Ctx, head: THREE.Object3D, c: THREE.Vector3, r: THREE.Vector3, width: number, drop: number) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 8; i++) {
    const s = (i / 8) * 2 - 1;
    const yaw = s * width;
    const pitch = -drop + 0.16 * s * s;
    const d = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
    pts.push(new THREE.Vector3(c.x + d.x * r.x * 1.01, c.y + d.y * r.y * 1.01, c.z + d.z * r.z * 1.01));
  }
  const thick = Math.min(r.x, r.y) * 0.045;
  head.add(ctx.mesh(paint(splineTube(pts, [thick * 0.6, thick, thick, thick * 0.6], 16, 6), ctx.pal, { solid: MOUTH, sheen: 0 }), ctx.skin, false));
}

function buildMouth(ctx: Ctx, head: THREE.Object3D, hr: number, world: THREE.Vector3) {
  const { plan, pal, mats, skin, mesh } = ctx;
  const hs = headScale(plan);
  const front = hr * hs.sx;
  const sl = plan.snout;
  const headId = boneIds(head);
  const q = head.getWorldQuaternion(new THREE.Quaternion());

  if (plan.mouth === 'beak') {
    const bl = hr * (0.55 + sl * 1.2);
    const colour = new THREE.Color(0xf2b84b).lerp(pal.accent, 0.25);
    const upper = new THREE.ConeGeometry(hr * 0.36, bl, 14);
    upper.rotateZ(-Math.PI / 2);
    upper.scale(1, 0.72, 1);
    upper.translate(front * 0.82 + bl / 2, -hr * 0.1 * hs.sy, 0);
    const lower = new THREE.ConeGeometry(hr * 0.25, bl * 0.62, 12);
    lower.rotateZ(-Math.PI / 2);
    lower.scale(1, 0.55, 0.9);
    lower.translate(front * 0.8 + bl * 0.31, -hr * 0.32 * hs.sy, 0);
    head.add(mesh(paint(upper, pal, { solid: colour, sheen: 0 }), skin), mesh(paint(lower, pal, { solid: colour.clone().multiplyScalar(0.85), sheen: 0 }), skin));
    return;
  }

  if (plan.mouth === 'plain' && sl > 0.75) {
    // A trunk: forward, then drooping toward the ground (but never into it).
    const T = hr * (1.1 + (sl - 0.75) * 4);
    const room = (ctx.skel.head.center.y - hr * 0.2 * hs.sy - 0.08) / 0.95;
    const d = Math.max(0.1, Math.min(T * 0.95, room));
    const pivot = new THREE.Group();
    pivot.position.set(front * 0.8, -hr * 0.2 * hs.sy, 0);
    const pts = [[0, 0], [0.4 * T, -0.02 * T], [0.72 * T, -0.3 * d], [0.82 * T, -0.72 * d], [0.7 * T, -0.95 * d]].map(([x, y]) => ({ x, y, z: 0 }));
    pivot.add(mesh(paint(tube(pts, [hr * 0.36, hr * 0.28, hr * 0.21, hr * 0.16, hr * 0.13], 20, 12), pal, { offset: world.clone().add(pivot.position) }), skin));
    const tip = mesh(ellipsoid(hr * 0.1, 1, 0.6, 1, 10), mats.pupil, false);
    tip.position.set(pts[4].x, pts[4].y - hr * 0.05, 0);
    pivot.add(tip);
    head.add(pivot);
    ctx.trunks.push(pivot);
    smile(ctx, head, new THREE.Vector3(), new THREE.Vector3(hr * hs.sx, hr * hs.sy, hr * hs.sz), 0.5, 0.55);
    return;
  }

  // The snout is skin: it melts into the face.
  let tipX = front * 0.9;
  let mouthAt = new THREE.Vector3();
  let mouthR = new THREE.Vector3(hr * hs.sx, hr * hs.sy, hr * hs.sz);
  if (sl > 0.05) {
    const r = new THREE.Vector3(hr * 0.55 * (1 + sl * 2.2), hr * 0.55 * 0.8, hr * 0.55 * 0.9);
    const c = new THREE.Vector3(front * 0.52 + sl * hr * 0.6, -hr * 0.28 * hs.sy, 0);
    blobEllipsoid(ctx, 'snout', atV(head, c), r, q, headId, hr * 0.3, 0, 1, r.x * 2);
    tipX = c.x + r.x;
    const nose = mesh(ellipsoid(hr * 0.14, 1.2, 0.8, 1.3, 12), mats.pupil, false);
    nose.position.set(tipX - hr * 0.04, c.y + r.y * 0.45, 0);
    head.add(nose);
    if (sl > 0.25) {
      mouthAt = c;
      mouthR = r;
    }
  }

  if (plan.mouth === 'jaws') {
    const jl = 1 + sl * 1.6;
    const jawX = front * 0.42 + sl * hr * 0.45;
    blobEllipsoid(ctx, 'snout', at(head, jawX, -hr * 0.55 * hs.sy, 0), { x: hr * 0.42 * jl, y: hr * 0.42 * 0.45, z: hr * 0.42 * 0.85 }, q, headId, hr * 0.2);
    for (const side of [1, -1]) {
      const fang = new THREE.ConeGeometry(hr * 0.075, hr * 0.28, 6);
      fang.translate(jawX + hr * 0.42 * jl * 0.72, -hr * 0.34 * hs.sy, side * hr * 0.17);
      head.add(mesh(paint(fang, pal, { solid: IVORY, sheen: 0 }), skin, false));
    }
  } else {
    smile(ctx, head, mouthAt, mouthR, mouthAt.x ? 0.42 : 0.55, mouthAt.x ? 0.35 : 0.5);
  }

  if (plan.mouth === 'tusks') {
    for (const side of [1, -1]) {
      const len = hr * (0.85 + sl * 0.6);
      const tusk = mesh(paint(talon(hr * 0.11, len, 0.45), pal, { solid: IVORY, sheen: 0 }), skin);
      tusk.position.set(Math.min(tipX, front * 0.6 + sl * hr * 0.6), -hr * 0.42 * hs.sy, side * hr * 0.32);
      tusk.rotation.set(side * 0.3, 0, -0.25);
      head.add(tusk);
    }
  }
}

function buildEyes(ctx: Ctx, head: THREE.Object3D, hr: number, world: THREE.Vector3) {
  const { plan, pal, mats, skin, mesh } = ctx;
  const hs = headScale(plan);
  const eyeR = hr * plan.eyeSize;
  const stalk = plan.eyeStalks * hr;
  const spots: [number, number][] = (() => {
    switch (plan.eyeCount) {
      case 1: return [[0, 0.3]];
      case 2: return [[-0.42, 0.25], [0.42, 0.25]];
      case 3: return [[-0.45, 0.15], [0.45, 0.15], [0, 0.62]];
      default: return [[-0.4, 0.05], [0.4, 0.05], [-0.32, 0.55], [0.32, 0.55]];
    }
  })();
  const eyeScale = (plan.eyeCount === 1 ? 1.5 : plan.eyeCount >= 3 ? 0.8 : 1) * (stalk ? 1.15 : 1);
  // Frogs wear their eyes on top; long faces spread them to the sides.
  const lift = 0.45 * hs.flat + (stalk ? 0.4 : 0);
  // Sleepy creatures have heavier lids.
  const lid = lerp(0.8, 0.42, plan.energy);
  for (const [yaw0, pitch0] of spots) {
    const yaw = clamp(yaw0 * (1 + 0.6 * hs.long), -1.3, 1.3);
    const pitch = Math.min(1.25, pitch0 + lift);
    const dir = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
    const base = new THREE.Vector3(dir.x * hs.sx, dir.y * hs.sy, dir.z * hs.sz).multiplyScalar(hr * 0.88);
    let pos = base;
    let look = dir;
    if (stalk) {
      const up = dir.clone().add(new THREE.Vector3(0.15, 0.9, 0)).normalize();
      pos = base.clone().addScaledVector(up, stalk);
      head.add(ctx.mesh(paint(segment(base, pos, eyeR * 0.32, eyeR * 0.24, 8), pal, { offset: world }), skin));
      look = dir.clone().add(new THREE.Vector3(1.2, 0.1, 0)).normalize();
    }
    const r = eyeR * eyeScale;
    const eye = new THREE.Group();
    eye.position.copy(pos);
    // lookAt aims +z, and works in local space because the eye has no parent yet.
    eye.lookAt(pos.clone().addScaledVector(look, hr * 4));
    eye.add(mesh(ellipsoid(r, 1, 1, 0.8, 16), mats.eyeWhite, false));
    // A coloured iris, a big pupil and a highlight: the creature's face lives here.
    const iris = mesh(paint(ellipsoid(r * 0.66, 1, 1, 0.4, 14), pal, { solid: pal.iris, sheen: 0.4 }), skin, false);
    iris.position.z = r * 0.62;
    eye.add(iris);
    const pupil = mesh(ellipsoid(r * 0.38, 1, 1, 0.4, 12), mats.pupil, false);
    pupil.position.z = r * 0.76;
    eye.add(pupil);
    const shine = mesh(ellipsoid(r * 0.16, 1, 1, 0.6, 8), mats.shine, false);
    shine.position.set(r * 0.24, r * 0.28, r * 0.82);
    eye.add(shine);
    // An upper lid in the coat colour; it closes with the blink.
    const lidGeo = new THREE.SphereGeometry(r * 1.08, 16, 8, 0, Math.PI * 2, 0, lid);
    lidGeo.rotateX(-0.3);
    eye.add(mesh(paint(lidGeo, pal, { solid: pal.coat }), skin, false));
    head.add(eye);
    ctx.eyes.push(eye);
  }
}

function buildEars(ctx: Ctx, head: THREE.Object3D, hr: number) {
  const { plan, pal, skin, mesh } = ctx;
  const hs = headScale(plan);
  const es = plan.earSize * hr;
  const inner = pal.belly.clone().lerp(pal.accent, 0.35);
  for (const side of [1, -1] as const) {
    switch (plan.earType) {
      case 'round': {
        const ear = new THREE.Group();
        ear.add(mesh(paint(ellipsoid(es * 0.45, 0.42, 1, 1, 14), pal, { solid: pal.coat }), skin));
        const lining = mesh(paint(ellipsoid(es * 0.32, 0.3, 1, 1, 12), pal, { solid: inner }), skin, false);
        lining.position.x = es * 0.1;
        ear.add(lining);
        ear.position.set(-hr * 0.15 * hs.sx, hr * 0.78 * hs.sy, side * hr * 0.55 * hs.sz);
        ear.rotation.y = -side * 0.5;
        head.add(ear);
        break;
      }
      case 'long': {
        const g = new THREE.CapsuleGeometry(es * 0.2, es * 1.1, 4, 12);
        g.translate(0, es * 0.65, 0);
        g.scale(0.55, 1, 1);
        const ear = mesh(paint(g, pal, { solid: pal.coat }), skin);
        const lg = new THREE.CapsuleGeometry(es * 0.12, es * 0.85, 4, 10);
        lg.translate(0, es * 0.62, 0);
        lg.scale(0.3, 1, 1);
        const lining = mesh(paint(lg, pal, { solid: inner }), skin, false);
        lining.position.x = es * 0.07;
        ear.add(lining);
        ear.position.set(-hr * 0.25 * hs.sx, hr * 0.7 * hs.sy, side * hr * 0.4 * hs.sz);
        ear.rotation.set(side * -0.45, 0, 0.5);
        head.add(ear);
        break;
      }
      case 'frills': {
        // Axolotl gills: three feathery stalks a side, sweeping back.
        for (let i = 0; i < 3; i++) {
          const g = new THREE.CapsuleGeometry(es * 0.07, es * 0.8, 3, 8);
          g.translate(0, es * 0.47, 0);
          const frill = mesh(paint(g, pal, { solid: pal.accent, glow: plan.glow ? 0.9 : 0 }), skin);
          frill.position.set(-hr * 0.35 * hs.sx, hr * (0.05 + i * 0.22) * hs.sy, side * hr * 0.78 * hs.sz);
          frill.rotation.set(side * (0.9 - i * 0.15), 0, 1.25 - i * 0.35);
          head.add(frill);
          for (let j = 1; j <= 3; j++) {
            const bead = mesh(paint(new THREE.IcosahedronGeometry(es * 0.1, 1), pal, { solid: pal.accent.clone().lerp(IVORY, 0.3), glow: plan.glow ? 1 : 0 }), skin, false);
            bead.position.set(es * 0.08 * (j % 2 ? 1 : -1), es * 0.25 * j, 0);
            frill.add(bead);
          }
        }
        break;
      }
      case 'antennae': {
        const stalk = new THREE.CylinderGeometry(es * 0.03, es * 0.045, es * 1.2, 6);
        stalk.translate(0, es * 0.6, 0);
        const part = mesh(paint(stalk, pal, { solid: pal.coat }), skin, false);
        part.position.set(hr * 0.15 * hs.sx, hr * 0.8 * hs.sy, side * hr * 0.3 * hs.sz);
        part.rotation.set(side * -0.4, 0, -0.25);
        const bulb = mesh(paint(ellipsoid(es * 0.14), pal, { solid: pal.accent, glow: plan.glow ? 1 : 0.15 }), skin, false);
        bulb.position.y = es * 1.22;
        part.add(bulb);
        head.add(part);
        break;
      }
      case 'none':
        break;
    }
  }
}

function buildHorns(ctx: Ctx, head: THREE.Object3D, hr: number) {
  const { plan, pal, skin, mesh, seed } = ctx;
  const hs = headScale(plan);
  const glow = plan.glow ? 0.5 : 0;
  switch (plan.horns) {
    case 'unicorn': {
      const len = hr * (1.15 + plan.earSize * 0.35);
      const g = new THREE.ConeGeometry(hr * 0.15, len, 18, 12);
      g.translate(0, len / 2, 0);
      // Spiral grooves.
      const pos = g.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const f = 1 + 0.2 * Math.sin(Math.atan2(z, x) * 2 + (pos.getY(i) / len) * 22);
        pos.setX(i, x * f);
        pos.setZ(i, z * f);
      }
      g.computeVertexNormals();
      const horn = mesh(paint(g, pal, { solid: IVORY.clone().lerp(pal.accent, 0.15), sheen: 0.8, glow }), skin);
      horn.position.set(hr * 0.35 * hs.sx, hr * 0.8 * hs.sy, 0);
      horn.rotation.z = -0.55;
      head.add(horn);
      break;
    }
    case 'ram': {
      const R = hr * (0.42 + 0.2 * plan.earSize);
      const n = 16;
      const pts: V3[] = [];
      for (let i = 0; i <= n; i++) {
        const a = Math.PI / 2 + (i / n) * Math.PI * 1.75;
        const r = R * (1 - 0.55 * (i / n));
        pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r - R, z: 0 });
      }
      const radii = pts.map((_, i) => hr * (0.17 - 0.12 * (i / n)));
      for (const side of [1, -1] as const) {
        const horn = mesh(paint(tube(pts, radii, 40, 10), pal, { solid: new THREE.Color(0xd9c49a), sheen: 0, glow }), skin);
        horn.position.set(-hr * 0.05 * hs.sx, hr * 0.78 * hs.sy, side * hr * 0.5 * hs.sz);
        horn.rotation.set(-side * 0.75, side * 0.25, 0);
        head.add(horn);
      }
      break;
    }
    case 'antlers': {
      for (const side of [1, -1] as const) {
        // Same seed both sides, so the antlers mirror.
        const rng = mulberry32(seed ^ 0x5a17);
        const geos: THREE.BufferGeometry[] = [];
        const grow = (a: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number) => {
          const b = a.clone().addScaledVector(dir, len);
          geos.push(segment(a, b, r, r * 0.72, 6), joint(b, r * 0.72));
          if (depth <= 0) return;
          const jitter = () => (rng() - 0.5) * 0.3;
          const onward = dir.clone().add(new THREE.Vector3(-0.25 + jitter(), 0.15, side * (0.25 + jitter()))).normalize();
          const tine = dir.clone().add(new THREE.Vector3(0.75 + jitter(), 0.35, side * jitter() * 0.5)).normalize();
          grow(b, onward, len * 0.82, r * 0.72, depth - 1);
          grow(b, tine, len * (0.45 + rng() * 0.2), r * 0.6, depth - 2);
        };
        const start = new THREE.Vector3(-hr * 0.05 * hs.sx, hr * 0.8 * hs.sy, side * hr * 0.42 * hs.sz);
        grow(start, new THREE.Vector3(-0.2, 1, side * 0.5).normalize(), hr * (0.7 + plan.earSize * 0.25), hr * 0.1, 3);
        head.add(mesh(paint(mergeGeometries(geos), pal, { solid: new THREE.Color(0xc9a479), sheen: 0, glow }), skin));
        geos.forEach((g) => g.dispose());
      }
      break;
    }
    case 'none':
      break;
  }
}

function buildCrest(ctx: Ctx, head: THREE.Object3D, hr: number) {
  const { plan, pal, skin, mesh } = ctx;
  const hs = headScale(plan);
  for (let i = 0; i < 5; i++) {
    const len = hr * (0.55 + 0.14 * i);
    const g = new THREE.CapsuleGeometry(hr * 0.07, len, 3, 8);
    g.translate(0, len / 2, 0);
    g.scale(0.6, 1, 1);
    const tint = pal.accent.clone().lerp(IVORY, i * 0.08);
    const feather = mesh(paint(g, pal, { solid: tint, glow: plan.glow ? 0.7 : 0 }), skin);
    feather.position.set(hr * (0.3 - i * 0.16) * hs.sx, hr * (0.86 - i * 0.04) * hs.sy, 0);
    feather.rotation.z = 0.35 + i * 0.22;
    head.add(feather);
  }
}

/** Mane or frill on a neck, in the neck bone's space (origin at the shoulder). */
function buildNeckFluff(ctx: Ctx, pivot: THREE.Object3D, neck: V3[], radii: number[], hr: number, headAt: THREE.Vector3) {
  const { plan, pal, skin, membrane, mesh } = ctx;
  if (plan.fluff === 'mane') {
    const curve = new THREE.CatmullRomCurve3(neck.map(vec));
    const colour = pal.accent.clone().multiplyScalar(0.8);
    const n = 8;
    for (let i = 0; i < n; i++) {
      const u = 0.05 + (i / (n - 1)) * 0.95;
      const p = curve.getPoint(u);
      const t = curve.getTangent(u);
      const r = THREE.MathUtils.lerp(radii[0], radii[radii.length - 1], u);
      const puff = mesh(paint(ellipsoid(r * 0.75 + 0.04 * ctx.k, 1.6, 0.85, 0.6, 10), pal, { solid: colour, glow: plan.glow ? 0.6 : 0 }), skin);
      puff.position.set(p.x - t.y * r * 0.85, p.y + t.x * r * 0.85, 0);
      puff.rotation.z = Math.atan2(t.y, t.x) + 0.5;
      pivot.add(puff);
    }
    // Over the back of the head.
    const top = mesh(paint(ellipsoid(hr * 0.5, 1.5, 0.8, 0.8, 10), pal, { solid: colour }), skin);
    top.position.set(headAt.x - hr * 0.55, headAt.y + hr * 0.55, 0);
    top.rotation.z = 0.6;
    pivot.add(top);
  } else if (plan.fluff === 'frill') {
    const R = hr * (1.3 + 0.35 * Math.sqrt(plan.earSize));
    const gap = Math.PI * 0.75;
    const g = fan(R, -Math.PI / 2 + gap / 2, Math.PI * 2 - gap, 9, pal);
    g.rotateY(Math.PI / 2);
    const frill = mesh(g, membrane);
    frill.position.set(headAt.x - hr * 0.55, headAt.y, 0);
    frill.rotation.z = 0.25;
    pivot.add(frill);
  }
}

/** Tail(s): a chain of three bones each, skinned, with the shaped tip on the last. */
function buildTails(ctx: Ctx, body: THREE.Group): THREE.Object3D[] {
  const { plan, skel, pal, skin, membrane, mesh, rng, k } = ctx;
  const tb = vec(skel.tail[0]);
  const local = skel.tail.map((p) => new THREE.Vector3(p.x - tb.x, p.y - tb.y, 0));
  const curve = new THREE.CatmullRomCurve3(local, false, 'catmullrom', 0.5);
  const n = plan.tailShape === 'curl' ? 24 : 12;
  const pts = curve.getSpacedPoints(n);
  const length = curve.getLength();
  const radiusAt = (u: number) => {
    const f = u * (skel.tailRadii.length - 1);
    const i = Math.min(skel.tailRadii.length - 2, Math.floor(f));
    return lerp(skel.tailRadii[i], skel.tailRadii[i + 1], f - i);
  };
  const tip = pts[n];
  const G = plan.girth * k;
  const offsets = plan.twinTail ? [1, -1] : [0];
  const tails: THREE.Object3D[] = [];
  for (const o of offsets) {
    const base = addBone(ctx, body, tb.x, tb.y, o * skel.tailRadii[0] * 0.55);
    base.userData.baseYaw = o * 0.35;
    base.rotation.y = base.userData.baseYaw;
    const p1 = pts[Math.round(n / 3)];
    const p2 = pts[Math.round((2 * n) / 3)];
    const mid = addBone(ctx, base, p1.x, p1.y, 0);
    const end = addBone(ctx, mid, p2.x - p1.x, p2.y - p1.y, 0);
    base.userData.chain = [mid, end];
    const chain = boneIds(base, mid, end, end);
    const scale = plan.twinTail ? 0.75 : 1;
    for (let i = 0; i < n; i++) {
      const t = curve.getTangentAt(i / n);
      capsule(ctx, 'tail', atV(base, pts[i]), atV(base, pts[i + 1]), radiusAt(i / n) * scale, radiusAt((i + 1) / n) * scale, chain, i / n, (i + 1) / n, length,
        i === 0 ? G * 0.35 : skel.tailRadii[0] * 0.1, dirOf(base, new THREE.Vector3(-t.y, t.x, 0)));
    }

    // Tips hang off the last bone, in its space.
    const tipAt = tip.clone().sub(p2);
    if (plan.tailShape === 'club') {
      const r = G * 0.42;
      const ballAt = tipAt.clone().addScaledVector(curve.getTangentAt(1), r * 0.4);
      capsule(ctx, 'tail', atV(end, ballAt), atV(end, ballAt), r, r, chain, 1, 1, length, r * 0.6);
      for (let i = 0; i < 8; i++) {
        const dir = new THREE.Vector3(rng() - 0.6, rng() - 0.3, rng() - 0.5).normalize();
        const g = new THREE.ConeGeometry(r * 0.22, r * 0.7, 6);
        g.translate(0, r * 0.95, 0);
        g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir));
        const spike = mesh(paint(g, pal, { solid: IVORY, sheen: 0 }), skin, false);
        spike.position.copy(ballAt);
        end.add(spike);
      }
    } else if (plan.tailShape === 'fan') {
      const R = G * 0.9 + plan.tailLength * k * 0.25;
      const sweep = 1.9;
      const g = fan(R, Math.PI - sweep / 2, sweep, 7, pal);
      g.translate(tipAt.x + R * 0.1, tipAt.y, 0);
      end.add(mesh(g, membrane));
    } else if (plan.tailTuft) {
      const r = Math.max(0.12 * k, G * 0.42);
      const tuft = new THREE.Group();
      for (let i = 0; i < 5; i++) {
        const puff = mesh(paint(new THREE.IcosahedronGeometry(r * (0.55 + rng() * 0.25), 1), pal, { solid: pal.accent.clone().lerp(pal.belly, i * 0.08), glow: plan.glow ? 0.9 : 0 }), skin);
        puff.position.set((rng() - 0.6) * r * 0.9, (rng() - 0.4) * r * 0.7, (rng() - 0.5) * r * 0.8);
        tuft.add(puff);
      }
      tuft.position.copy(tipAt);
      end.add(tuft);
    }
    tails.push(base);
  }
  return tails;
}

/**
 * One sprout: a spline that grows out along `dir`, curls about a sideways axis
 * and wiggles, with an optional tip. Returned pivot sits at the attach point.
 */
function buildSprout(ctx: Ctx, layout: SproutLayout, origin: THREE.Vector3): THREE.Group {
  const { plan, pal, mats, skin, mesh, rng } = ctx;
  const sp = layout.sprout;
  const pivot = new THREE.Group();
  pivot.position.copy(vec(layout.at)).sub(origin);
  pivot.userData.phase = rng() * Math.PI * 2;
  pivot.userData.sway = 0.08 + sp.wiggle * 0.2;

  const dir = vec(layout.dir).normalize();
  const axis = (Math.abs(dir.y) > 0.7 ? dir.clone().cross(new THREE.Vector3(1, 0, 0)) : dir.clone().cross(UP)).normalize();
  const side = new THREE.Vector3().crossVectors(axis, dir).normalize();
  const steps = 10;
  const step = layout.length / (steps - 1);
  const points = [new THREE.Vector3()];
  const heading = dir.clone().applyAxisAngle(axis, -0.25);
  // Sprouts that reach the ground trail along it instead of poking through.
  const floor = 0.06 - layout.at.y;
  for (let i = 1; i < steps; i++) {
    const d = heading.clone().applyAxisAngle(axis, sp.curl * 2.4 * (i / (steps - 1)));
    const wiggle = side.clone().multiplyScalar(Math.sin(i * 1.7) * sp.wiggle * step * 0.9);
    const next = points[i - 1].clone().addScaledVector(d, step).add(wiggle);
    next.y = Math.max(floor, next.y);
    points.push(next);
  }
  const r = layout.radius;
  const tipR = sp.tip === 'none' ? r * 0.12 : r * 0.5;
  const tint = sp.tint === 'accent' ? pal.accent : sp.tint === 'belly' ? pal.belly : null;
  const offset = vec(layout.at);
  pivot.add(mesh(paint(splineTube(points, [r, r * 0.8, (r + tipR) / 2, tipR], 24, 10), pal, tint ? { solid: tint } : { offset }), skin));

  const end = points[steps - 1];
  const out = end.clone().sub(points[steps - 2]).normalize();
  const tipSize = Math.max(r * 1.5, 0.06 * ctx.k);
  const glow = plan.glow ? 1 : 0;
  switch (sp.tip) {
    case 'bulb': {
      const bulb = mesh(paint(ellipsoid(tipSize, 1, 1.15, 1, 12), pal, { solid: pal.accent.clone().lerp(IVORY, 0.35), glow: glow || 0.3 }), skin);
      bulb.position.copy(end).addScaledVector(out, tipSize * 0.6);
      pivot.add(bulb);
      break;
    }
    case 'claw': {
      const g = new THREE.ConeGeometry(tipSize * 0.5, tipSize * 2, 8);
      g.translate(0, tipSize, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, out.clone().applyAxisAngle(axis, 0.5)));
      g.translate(end.x, end.y, end.z);
      pivot.add(mesh(paint(g, pal, { solid: IVORY, sheen: 0 }), skin));
      break;
    }
    case 'leaf': {
      const g = ellipsoid(tipSize * 1.6, 0.25, 1, 0.55, 10);
      g.translate(0, tipSize * 1.5, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, out));
      g.translate(end.x, end.y, end.z);
      pivot.add(mesh(paint(g, pal, { solid: pal.accent, glow: glow * 0.6 }), ctx.membrane));
      break;
    }
    case 'eye': {
      // An eye on a stalk. It joins the others, so it blinks too.
      const eye = new THREE.Group();
      eye.position.copy(end).addScaledVector(out, tipSize * 0.5);
      eye.lookAt(eye.position.clone().add(out));
      eye.add(mesh(ellipsoid(tipSize, 1, 1, 0.8, 12), mats.eyeWhite, false));
      const iris = mesh(paint(ellipsoid(tipSize * 0.62, 1, 1, 0.4, 10), pal, { solid: pal.iris }), skin, false);
      iris.position.z = tipSize * 0.62;
      eye.add(iris);
      const pupil = mesh(ellipsoid(tipSize * 0.34, 1, 1, 0.4, 10), mats.pupil, false);
      pupil.position.z = tipSize * 0.76;
      eye.add(pupil);
      pivot.add(eye);
      ctx.eyes.push(eye);
      break;
    }
    case 'puff': {
      const puff = mesh(paint(new THREE.IcosahedronGeometry(tipSize * 1.3, 1), pal, { solid: pal.belly, glow: glow * 0.7 }), skin);
      puff.position.copy(end);
      puff.rotation.set(rng() * 3, rng() * 3, 0);
      pivot.add(puff);
      break;
    }
    case 'none':
      break;
  }
  return pivot;
}

/** Three little toe claws at the front of a big foot, in the foot bone's space. */
function toeClaws(ctx: Ctx, bone: THREE.Object3D, foot: THREE.Vector3, footR: number) {
  for (const z of [-0.55, 0, 0.55]) {
    const claw = ctx.mesh(paint(talon(footR * 0.18, footR * 0.55, 0.5), ctx.pal, { solid: IVORY, sheen: 0 }), ctx.skin, false);
    claw.position.set(foot.x + footR * 1.15, foot.y - footR * 0.2, foot.z + z * footR * 0.8);
    claw.rotation.z = -1.2;
    bone.add(claw);
  }
}

/** One leg, built to reach exactly from the hip to the ground in its rest pose. Skin blobs plus bones. */
function buildLeg(ctx: Ctx, body: THREE.Group, leg: LegLayout, style: LegStyle): LegRig {
  const { plan } = ctx;
  const H = leg.length;
  const r = leg.radius;
  const s = leg.side;
  const hip = addBone(ctx, body, leg.hip.x, leg.hip.y, leg.hip.z);
  const footR = r * plan.footSize * 1.3;
  const out = { x: 0, y: 0, z: s };
  const joints: THREE.Object3D[] = [];
  const bigFeet = plan.footSize > 1.5;

  switch (style) {
    case 'digitigrade': {
      // Thigh forward, shin back, long foot forward again: knees that bend backward.
      const knee = addBone(ctx, hip, 0.2 * H, -0.42 * H, 0);
      const hock = addBone(ctx, knee, -0.22 * H, -0.34 * H, 0);
      const chain = boneIds(hip, knee, hock);
      const toe = new THREE.Vector3(0.06 * H, -0.24 * H + footR * 0.4, 0);
      capsule(ctx, 'leg', at(hip, -0.02 * H, r * 0.5, 0), at(knee), r * 1.6, r * 0.95, chain, 0, 0.5, H, r * 1.1, out);
      capsule(ctx, 'leg', at(knee), at(hock), r * 0.9, r * 0.62, chain, 0.5, 1, H, r * 0.3, out);
      capsule(ctx, 'leg', at(hock), atV(hock, toe), r * 0.6, r * 0.5, boneIds(hock), 1, 1, H, r * 0.25, out);
      const foot = new THREE.Vector3(toe.x + footR * 0.3, toe.y, 0);
      blobEllipsoid(ctx, 'foot', atV(hock, foot), { x: footR * 1.2, y: footR * 0.47, z: footR * 0.85 }, new THREE.Quaternion(), boneIds(hock), r * 0.5);
      if (bigFeet) toeClaws(ctx, hock, foot, footR * 0.85);
      joints.push(knee, hock);
      break;
    }
    case 'splayed': {
      // Beetle legs: up and out to a high knee, then down to a pointed tip.
      const kneeAt = new THREE.Vector3(0, 0.22 * H, s * 0.5 * H);
      const knee = addBone(ctx, hip, kneeAt.x, kneeAt.y, kneeAt.z);
      const tipAt = new THREE.Vector3(0, -H + footR * 0.3, s * 0.85 * H).sub(kneeAt);
      const chain = boneIds(hip, knee, knee);
      capsule(ctx, 'leg', at(hip), at(knee), r * 1.3, r * 0.95, chain, 0, 0.5, H, r * 0.8, out);
      capsule(ctx, 'leg', at(knee), atV(knee, tipAt), r * 0.95, r * 0.45, chain, 0.5, 1, H, r * 0.4, out);
      const claw = new THREE.ConeGeometry(r * 0.5, footR * 1.4, 8);
      claw.rotateZ(Math.PI);
      claw.translate(tipAt.x, tipAt.y - footR * 0.3, tipAt.z);
      knee.add(ctx.mesh(paint(claw, ctx.pal, { solid: ctx.pal.points }), ctx.skin));
      joints.push(knee);
      break;
    }
    case 'tentacles': {
      // A chain of four segments; animation curls each joint in turn.
      const dirs = [[0.15, -1, 0.55], [0.08, -1, 0.25], [0, -1, 0.05], [-0.05, -0.3, 0.95]].map(([x, y, z]) => new THREE.Vector3(x, y, z * s).normalize());
      const len = H / dirs.reduce((sum, d) => sum + Math.abs(d.y), 0);
      const rs = [1.35, 1, 0.72, 0.48, 0.24].map((f) => Math.max(0.012, r * f));
      const bones: THREE.Object3D[] = [hip];
      dirs.forEach((d, i) => {
        if (i < dirs.length - 1) {
          const e = d.clone().multiplyScalar(len);
          const next = addBone(ctx, bones[i], e.x, e.y, e.z);
          bones.push(next);
          joints.push(next);
        }
      });
      const chain = boneIds(...bones, bones[bones.length - 1]);
      dirs.forEach((d, i) => {
        const from = bones[i];
        capsule(ctx, 'leg', at(from), atV(from, d.clone().multiplyScalar(len)), rs[i], rs[i + 1], chain, i / 4, (i + 1) / 4, H, i === 0 ? r * 1.2 : r * 0.2, out);
      });
      if (plan.glow) {
        const last = bones[bones.length - 1];
        const tip = ctx.mesh(paint(ellipsoid(rs[4] * 1.4), ctx.pal, { solid: ctx.pal.accent, glow: 0.9 }), ctx.skin, false);
        tip.position.copy(dirs[3].clone().multiplyScalar(len));
        last.add(tip);
      }
      break;
    }
    default: {
      const half = H / 2;
      const knee = addBone(ctx, hip, 0, -half, 0);
      const chain = boneIds(hip, knee, knee);
      capsule(ctx, 'leg', at(hip, 0, r * 0.4, 0), at(knee), r * 1.55, r * 0.95, chain, 0, 0.5, H, r * 1.1, out);
      capsule(ctx, 'leg', at(knee), at(knee, 0, -half + footR * 0.5, 0), r * 0.92, r * 0.78, chain, 0.5, 0.95, H, r * 0.3, out);
      const foot = new THREE.Vector3(footR * 0.35, -half + footR * 0.45, 0);
      blobEllipsoid(ctx, 'foot', atV(knee, foot), { x: footR * 1.35, y: footR * 0.55, z: footR * 0.95 }, new THREE.Quaternion(), boneIds(knee), r * 0.55);
      if (bigFeet) toeClaws(ctx, knee, foot, footR);
      joints.push(knee);
    }
  }
  return { hip, joints, side: leg.side, pair: leg.pair, length: H, style };
}

/**
 * One arm: shoulder, elbow and wrist bones with a skinned upper arm and forearm,
 * and a hand. Paws are soft mittens, claws are three talons, pincers snip.
 */
function buildArm(ctx: Ctx, body: THREE.Group, arm: ArmLayout, hands: Hands): ArmRig {
  const { pal, skin } = ctx;
  const r = arm.radius;
  const side = arm.side;
  const d = vec(arm.dir);
  const shoulder = addBone(ctx, body, arm.shoulder.x, arm.shoulder.y, arm.shoulder.z);
  const upper = d.clone().multiplyScalar(arm.length * 0.5);
  // Elbows bend a little forward at rest, like a T. rex holding its hands up.
  const fore = d.clone().add(new THREE.Vector3(0.55, 0.3, 0)).normalize();
  const elbow = addBone(ctx, shoulder, upper.x, upper.y, upper.z);
  const lower = fore.clone().multiplyScalar(arm.length * 0.5);
  const wrist = addBone(ctx, elbow, lower.x, lower.y, lower.z);
  const chain = boneIds(shoulder, elbow, wrist);
  const out = { x: 0, y: 0, z: side };
  capsule(ctx, 'arm', at(shoulder, -d.x * r, -d.y * r, -d.z * r), at(elbow), r * 1.4, r * 0.95, chain, 0, 0.5, arm.length, r * 0.9, out);
  capsule(ctx, 'arm', at(elbow), at(wrist), r * 0.95, r * 0.8, chain, 0.5, 1, arm.length, r * 0.3, out);

  const handR = r * 1.6;
  const q = new THREE.Quaternion().setFromUnitVectors(X, fore);
  const across = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const wristId = boneIds(wrist);
  let snip: THREE.Object3D | null = null;
  switch (hands) {
    case 'paws': {
      const palm = fore.clone().multiplyScalar(handR * 0.7);
      blobEllipsoid(ctx, 'hand', atV(wrist, palm), { x: handR * 0.95, y: handR * 0.7, z: handR * 0.9 }, q, wristId, r * 0.5);
      for (const f of [-1, 0, 1]) {
        const tip = palm.clone().addScaledVector(fore, handR * 0.85).addScaledVector(across, f * handR * 0.5);
        blobEllipsoid(ctx, 'hand', atV(wrist, tip), { x: handR * 0.38, y: handR * 0.32, z: handR * 0.32 }, q, wristId, handR * 0.15);
      }
      break;
    }
    case 'claws': {
      blobEllipsoid(ctx, 'hand', atV(wrist, fore.clone().multiplyScalar(handR * 0.4)), { x: handR * 0.75, y: handR * 0.6, z: handR * 0.7 }, q, wristId, r * 0.4);
      for (const f of [-1, 0, 1]) {
        const g = talon(handR * 0.2, handR * 1.4, -0.45);
        g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, fore.clone().add(new THREE.Vector3(0, -0.2, 0)).normalize()));
        const claw = ctx.mesh(paint(g, pal, { solid: IVORY, sheen: 0 }), skin, false);
        claw.position.copy(fore.clone().multiplyScalar(handR * 0.8).addScaledVector(across, f * handR * 0.42));
        wrist.add(claw);
      }
      break;
    }
    case 'pincers': {
      // A crab claw: a fat palm, a fixed finger and a moving one.
      const palmAt = fore.clone().multiplyScalar(handR * 0.9);
      blobEllipsoid(ctx, 'hand', atV(wrist, palmAt), { x: handR * 1.3, y: handR * 0.85, z: handR * 0.65 }, q, wristId, r * 0.5);
      const colour = pal.points.clone().lerp(pal.accent, 0.4);
      const holder = new THREE.Group();
      holder.position.copy(fore.clone().multiplyScalar(handR * 1.9));
      holder.quaternion.copy(q);
      wrist.add(holder);
      const fixed = talon(handR * 0.42, handR * 1.5, 0.35, 0.6);
      fixed.rotateZ(-Math.PI / 2);
      fixed.translate(0, handR * 0.25, 0);
      holder.add(ctx.mesh(paint(fixed, pal, { solid: colour, sheen: 0 }), skin));
      snip = new THREE.Group();
      snip.position.set(-handR * 0.3, -handR * 0.3, 0);
      const moving = talon(handR * 0.32, handR * 1.3, -0.35, 0.6);
      moving.rotateZ(-Math.PI / 2);
      snip.add(ctx.mesh(paint(moving, pal, { solid: colour.clone().multiplyScalar(0.9), sheen: 0 }), skin));
      holder.add(snip);
      break;
    }
  }
  return { shoulder, elbow, wrist, side, pair: arm.pair, hands, snip };
}

/** Fins or a sail along the back, tufts or a mane, and a shell. */
function buildBack(ctx: Ctx, body: THREE.Group) {
  const { plan, skel, pal, skin, membrane, mesh, rng } = ctx;
  const n = skel.spine.length;
  const sampleAt = (p: V3) => {
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.hypot(skel.spine[i].x - p.x, skel.spine[i].y - p.y) < Math.hypot(skel.spine[best].x - p.x, skel.spine[best].y - p.y)) best = i;
    return best;
  };

  if (skel.spikes.length && plan.spikes > 1.1) {
    // Fins so tall they join into a sail: a strip from the back out along the spine's normal.
    const height = skel.spikes[0].height;
    const i0 = Math.max(0, sampleAt(skel.spikes[0].at) - 2);
    const i1 = Math.min(n - 1, sampleAt(skel.spikes[skel.spikes.length - 1].at) + 1);
    const positions: number[] = [];
    const index: number[] = [];
    for (let i = i0; i <= i1; i++) {
      const u = (i - i0) / (i1 - i0);
      const b = skel.back[i];
      const up = skel.up[i];
      const sink = skel.radii[i] * 0.15;
      const scallop = 0.8 + 0.2 * Math.cos(2 * Math.PI * skel.spikes.length * (u - 0.5 / skel.spikes.length));
      const tall = height * Math.pow(Math.sin(Math.PI * u), 0.7) * scallop;
      positions.push(b.x - up.x * sink, b.y - up.y * sink, 0, b.x + up.x * tall, b.y + up.y * tall, 0);
      if (i > i0) {
        const a = (i - i0 - 1) * 2;
        index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(index);
    g.computeVertexNormals();
    body.add(mesh(paint(g, pal, { solid: pal.accent, glow: plan.glow ? 0.7 : 0 }), membrane));
    for (const spike of skel.spikes) {
      const i = sampleAt(spike.at);
      const u = (i - i0) / (i1 - i0);
      const tall = height * Math.pow(Math.sin(Math.PI * clamp(u, 0, 1)), 0.7);
      const rod = segment(vec(spike.at), vec(spike.at).addScaledVector(vec(spike.dir), tall), height * 0.05, height * 0.01, 6);
      body.add(mesh(paint(rod, pal, { solid: pal.accent.clone().multiplyScalar(0.6) }), skin, false));
    }
  } else {
    for (const spike of skel.spikes) {
      const g = new THREE.ConeGeometry(spike.height * 0.42, spike.height, 8);
      g.translate(0, spike.height / 2, 0);
      g.rotateZ(0.35);
      g.scale(1, 1, 0.45);
      const m = mesh(paint(g, pal, { solid: pal.accent, glow: plan.glow ? 0.8 : 0 }), skin);
      m.position.copy(vec(spike.at)).addScaledVector(vec(spike.dir), -spike.height * 0.15);
      m.rotation.z = Math.atan2(-spike.dir.x, spike.dir.y);
      body.add(m);
    }
  }

  if (plan.fluff === 'tufts' || plan.fluff === 'mane') {
    const count = plan.fluff === 'tufts' ? Math.max(4, plan.segments) : 4;
    const from = plan.fluff === 'tufts' ? 0.15 : 0.6;
    for (let i = 0; i < count; i++) {
      const t = from + ((i + 0.5) / count) * (0.88 - from);
      const idx = Math.round(t * (n - 1));
      const r = skel.radii[idx];
      const puff = mesh(paint(new THREE.IcosahedronGeometry(r * 0.32 + 0.03 * ctx.k, 1), pal, { solid: plan.fluff === 'tufts' ? pal.belly : pal.accent.clone().multiplyScalar(0.8) }), skin);
      puff.position.copy(vec(skel.back[idx])).addScaledVector(vec(skel.up[idx]), -r * 0.05);
      puff.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      body.add(puff);
    }
  }

  if (skel.shell) {
    const s = skel.shell;
    const g = new THREE.SphereGeometry(1, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    g.scale(s.rx, s.ry, s.rz);
    const shell = mesh(paintShell(g, pal, s.rx, s.rz), skin);
    shell.position.copy(vec(s.center));
    shell.rotation.z = s.tilt;
    body.add(shell);
  }
}

// ---- Assembly ----------------------------------------------------------------

/** Bones along the spine; bending moves these and the skin follows. */
const SPINE_BONES = 9;

/** Paint every skin vertex from its part, blending across joins. */
function paintSkin(geo: THREE.BufferGeometry, skin: ReturnType<typeof buildSkin>, pal: Palette) {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const colors = new Float32Array(pos.count * 3);
  const glows = new Float32Array(pos.count);
  const a = new THREE.Color();
  const b = new THREE.Color();
  // Which way is "back": around the body for long parts, the normal for blobs and limbs.
  const backOf = (region: SkinRegion, around: number, ny: number) =>
    region === 'torso' || region === 'neck' || region === 'tail' ? Math.cos(around) : region === 'head' || region === 'snout' ? ny : ny * 0.6 - 0.2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ny = nrm.getY(i);
    const region = SKIN_REGIONS[skin.region[i]];
    let glow = skinColour(pal, { x, y, z, back: backOf(region, skin.around[i], ny), region, u: skin.u[i], along: skin.along[i] }, a);
    const mix = skin.second.mix[i];
    if (mix > 0.02) {
      const r2 = SKIN_REGIONS[skin.second.region[i]];
      const g2 = skinColour(pal, { x, y, z, back: backOf(r2, skin.second.around[i], ny), region: r2, u: skin.second.u[i], along: skin.second.along[i] }, b);
      a.lerp(b, mix);
      glow = lerp(glow, g2, mix);
    }
    colors.set([a.r, a.g, a.b], i * 3);
    glows[i] = glow;
  }
  setSkinAttributes(geo, colors, glows, pal.sheen);
}

export function buildCreature(plan: BodyPlan, skel: Skeleton, seed: number): CreatureRig {
  const mats = creatureMaterials();
  const k = skel.scale;
  const n = skel.spine.length;
  const x0 = skel.spine[0].x;
  const L = Math.max(1e-3, skel.spine[n - 1].x - x0);

  // Eye-spots sit on the flanks, a few per side.
  const eyespots: Palette['eyespots'] = [];
  if (plan.finish === 'eyespots') {
    for (const t of plan.segments >= 5 ? [0.3, 0.5, 0.7] : [0.36, 0.62]) {
      const i = Math.round(t * (n - 1));
      const s = skel.spine[i];
      const r = skel.radii[i];
      const up = skel.up[i];
      for (const side of [1, -1]) eyespots.push({ at: new THREE.Vector3(s.x + up.x * r * 0.25, s.y + up.y * r * skel.heightScale * 0.25, side * r * skel.widthScale * 0.95), r: r * 0.5 });
    }
  }
  const body0 = toColor(plan.colour.body);
  const coat = toColor(plan.colour.coat);
  const pal: Palette = {
    body: body0,
    coat,
    accent: toColor(plan.colour.accent),
    belly: toColor(plan.colour.belly),
    points: coat.clone().multiplyScalar(0.7),
    iris: toColor(plan.colour.iris),
    plan,
    seed,
    gradient: [x0 + L * 0.75, x0 - L * 0.05],
    eyespots,
    sheen: plan.finish === 'iridescent' ? 1 : plan.finish === 'jelly' ? 0.35 : 0,
  };

  const geometries: THREE.BufferGeometry[] = [];
  const jelly = plan.finish === 'jelly';
  const ctx: Ctx = {
    plan,
    skel,
    pal,
    mats,
    skin: jelly ? mats.jelly : mats.skin,
    membrane: jelly ? mats.jellyMembrane : mats.membrane,
    rng: mulberry32(seed),
    seed,
    k,
    mesh: (geo, material, shadow = true) => {
      geometries.push(geo);
      const m = new THREE.Mesh(geo, material);
      m.castShadow = shadow;
      return m;
    },
    eyes: [],
    trunks: [],
    bones: [],
    blobs: [],
  };

  const root = new THREE.Group();
  const scaler = new THREE.Group();
  const body = new THREE.Group();
  root.add(scaler);
  scaler.add(body);

  // Torso: bones along the spine, and a chain of capsules with the body's cross-section.
  const spineBones: THREE.Bone[] = [];
  for (let j = 0; j < SPINE_BONES; j++) {
    const p = skel.spine[Math.round((j / (SPINE_BONES - 1)) * (n - 1))];
    spineBones.push(addBone(ctx, body, p.x, p.y, p.z));
  }
  const spineChain = boneIds(...spineBones);
  // Lumpy bodies need every spine sample; smooth ones are fine with half.
  const stride = plan.lumps > 0.2 && plan.segments > 4 ? 1 : 2;
  for (let i = 0; i < n - 1; i += stride) {
    const j = Math.min(n - 1, i + stride);
    capsule(ctx, 'torso', skel.spine[i], skel.spine[j], skel.radii[i], skel.radii[j], spineChain, i / (n - 1), j / (n - 1), L, 0.02 * k, skel.up[i]);
    const last = ctx.blobs[ctx.blobs.length - 1];
    last.stretchUp = skel.heightScale;
    last.stretchSide = skel.widthScale;
  }

  // A round belly: one soft ellipsoid under the middle, bending with the spine bones over it.
  if (skel.belly) {
    const b = skel.belly;
    let near = 0;
    for (let i = 1; i < n; i++) if (Math.hypot(skel.spine[i].x - b.center.x, skel.spine[i].y - b.center.y) < Math.hypot(skel.spine[near].x - b.center.x, skel.spine[near].y - b.center.y)) near = i;
    const t = near / (n - 1);
    const half = b.rx / L;
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), b.tilt);
    blobEllipsoid(ctx, 'torso', b.center, { x: b.rx, y: b.ry, z: b.rz }, rotation, spineChain, b.ry * 0.7, clamp01(t - half), clamp01(t + half), L);
  }

  buildBack(ctx, body);

  // Neck(s) and head(s), each on a bone at the shoulder.
  const G = plan.girth * k;
  const shoulder = vec(skel.neck[0]);
  const neckLocal = skel.neck.map((p) => ({ x: p.x - shoulder.x, y: p.y - shoulder.y, z: 0 }));
  const neckCurve = new THREE.CatmullRomCurve3(neckLocal.map(vec));
  const neckLength = neckCurve.getLength();
  const hc = vec(skel.head.center);
  const headLocal = hc.clone().sub(shoulder);
  const hr = skel.head.radius * (plan.twinHead ? 0.85 : 1);
  const necks: THREE.Object3D[] = [];
  const heads: THREE.Object3D[] = [];
  for (const yaw of plan.twinHead ? [0.42, -0.42] : [0]) {
    const pivot = addBone(ctx, body, shoulder.x, shoulder.y, shoulder.z);
    pivot.rotation.y = yaw;
    pivot.userData.baseYaw = yaw;
    const head = addBone(ctx, pivot, headLocal.x, headLocal.y, headLocal.z);
    const neckRadii = skel.neckRadii.map((r) => r * (plan.twinHead ? 0.8 : 1));
    const chain = boneIds(pivot, pivot, head);
    const steps = 6;
    for (let i = 0; i < steps; i++) {
      const u0 = i / steps;
      const u1 = (i + 1) / steps;
      const r = (u: number) => (u < 0.5 ? lerp(neckRadii[0], neckRadii[1], u * 2) : lerp(neckRadii[1], neckRadii[2], u * 2 - 1));
      const t = neckCurve.getTangentAt(u0);
      capsule(ctx, 'neck', atV(pivot, neckCurve.getPointAt(u0)), atV(pivot, neckCurve.getPointAt(u1)), r(u0), r(u1), chain, u0, u1, neckLength,
        i === 0 ? G * 0.4 : neckRadii[0] * 0.1, dirOf(pivot, new THREE.Vector3(-t.y, t.x, 0)));
    }
    buildHead(ctx, head, hr, hc);
    buildNeckFluff(ctx, pivot, neckLocal, neckRadii, hr, headLocal);
    necks.push(pivot);
    heads.push(head);
  }

  const tails = buildTails(ctx, body);

  // Sprouts ride on whichever part they grow from.
  const sprouts: THREE.Group[] = [];
  const tailBase = vec(skel.tail[0]);
  for (const layout of skel.sprouts) {
    if (layout.part === 'body') {
      const s = buildSprout(ctx, layout, new THREE.Vector3());
      body.add(s);
      sprouts.push(s);
    } else if (layout.part === 'tail') {
      for (const t of tails) {
        const s = buildSprout(ctx, layout, tailBase);
        t.add(s);
        sprouts.push(s);
      }
    } else {
      // Necks share the shoulder origin; heads sit at the head centre.
      for (let i = 0; i < necks.length; i++) {
        const s = buildSprout(ctx, layout, layout.part === 'neck' ? shoulder : hc);
        (layout.part === 'neck' ? necks[i] : heads[i]).add(s);
        sprouts.push(s);
      }
    }
  }

  const legs: LegRig[] = [];
  for (const leg of skel.legs) legs.push(buildLeg(ctx, body, leg, plan.legStyle));
  for (const leg of skel.tentacles) legs.push(buildLeg(ctx, body, leg, 'tentacles'));
  const arms = skel.arms.map((a) => buildArm(ctx, body, a, plan.hands));

  const wings: CreatureRig['wings'] = [];
  if (skel.wingRoot && plan.wingSpan > 0) {
    const wr = vec(skel.wingRoot);
    for (const side of [1, -1] as const) {
      const pivot = new THREE.Group();
      pivot.position.set(wr.x, wr.y, side * plan.girth * k * 0.35 * skel.widthScale);
      const colour = pal.accent.clone().lerp(new THREE.Color(0xffffff), 0.35);
      pivot.add(ctx.mesh(paint(wingGeometry(plan.wingSpan * k, side), pal, { solid: colour, glow: plan.glow ? 0.5 : 0 }), mats.wing));
      body.add(pivot);
      wings.push({ pivot, side });
    }
  }

  // Mesh the skin in the rest pose and bind it to the bones.
  root.updateMatrixWorld(true);
  const longest = Math.max(skel.length, skel.reach, L);
  const thinnest = Math.min(...ctx.blobs.filter((b) => !b.radii && b.region !== 'torso').map((b) => Math.min(b.ra, b.rb)), G);
  const cell = clamp(thinnest, longest / 66, longest / 46);
  const skinData = buildSkin(ctx.blobs, cell);
  paintSkin(skinData.geometry, skinData, pal);
  geometries.push(skinData.geometry);
  const skinMesh = new THREE.SkinnedMesh(skinData.geometry, ctx.skin);
  skinMesh.castShadow = true;
  body.add(skinMesh);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(ctx.bones);
  skinMesh.bind(skeleton);
  if (!jelly) {
    const ink = new THREE.SkinnedMesh(skinData.geometry, mats.outline);
    body.add(ink);
    ink.bind(skeleton, skinMesh.bindMatrix);
    ink.frustumCulled = false;
  }
  // Room for the pose to change without being culled.
  skinMesh.computeBoundingSphere();
  if (skinMesh.boundingSphere) skinMesh.boundingSphere.radius *= 1.35;

  const emoteAnchor = new THREE.Object3D();
  const extra = plan.horns === 'antlers' || plan.horns === 'unicorn' ? hr * 1.3 : plan.earType === 'none' ? 0 : plan.earSize * hr;
  emoteAnchor.position.set(hc.x, Math.max(hc.y, skel.reach) + hr + 0.5 + extra + plan.eyeStalks * hr * 0.6, 0);
  body.add(emoteAnchor);

  return {
    root,
    scaler,
    body,
    head: heads[0],
    heads,
    necks,
    tails,
    trunks: ctx.trunks,
    sprouts,
    legs,
    arms,
    wings,
    eyes: ctx.eyes,
    emoteAnchor,
    bend: makeBender(body, skinMesh, spineBones, x0, L),
    dispose: () => {
      geometries.forEach((g) => g.dispose());
      skeleton.dispose();
    },
  };
}

/**
 * Spine bending for slithering, inching and bounding: moves the spine bones (the
 * skin follows) and every part attached to the body along the same wave, so
 * legs, arms and fins ride along.
 */
function makeBender(body: THREE.Group, skin: THREE.Object3D, spine: THREE.Bone[], x0: number, L: number): CreatureRig['bend'] {
  const own = new Set<THREE.Object3D>([skin, ...spine, ...body.children.filter((o) => o instanceof THREE.SkinnedMesh)]);
  const parts = [...spine, ...body.children.filter((o) => !own.has(o))].map((o) => ({ o, base: o.position.clone(), u: (o.position.x - x0) / L }));
  const off = (w: Wave | null, u: number) => (w ? w.amp * Math.sin(2 * Math.PI * w.waves * u + w.phase) : 0);
  const slope = (w: Wave | null, u: number) => (w ? Math.atan((w.amp * 2 * Math.PI * w.waves * Math.cos(2 * Math.PI * w.waves * u + w.phase)) / L) : 0);
  let bent = false;
  return (y, z) => {
    if (!y && !z && !bent) return { tailYaw: 0, headYaw: 0, tailPitch: 0, headPitch: 0 };
    for (const p of parts) p.o.position.set(p.base.x, p.base.y + off(y, p.u), p.base.z + off(z, p.u));
    bent = !!(y || z);
    // Yaw follows the z-wave; pitch is negated because a rising curve toward the tail tips the tail up.
    return { tailYaw: -slope(z, 0), headYaw: -slope(z, 1), tailPitch: -slope(y, 0), headPitch: slope(y, 1) };
  };
}
