import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cells2, noise3 } from '../core/noise';
import { clamp, mulberry32, smoothstep, type Rng } from '../core/rng';
import type { LegLayout, Skeleton, SproutLayout, V3 } from '../genetics/anatomy';
import type { BodyPlan, Hsl, LegStyle } from '../genetics/phenotype';
import { creatureMaterials, type CreatureMaterials } from './materials';

/**
 * Turns a skeleton into three.js meshes. No assets: every part is generated
 * from the body plan. The returned rig exposes the pivots that animation moves
 * (see `motion.ts`).
 *
 * Layout of this file: helpers (paint, tube, segment, fan) → part builders
 * (head, mouth, eyes, ears, horns, fluff, tails, legs, back) → `buildCreature`,
 * which assembles them and wires up spine bending.
 *
 * Everything is in skeleton units (real metres). Plan values that are lengths
 * must be multiplied by `skel.scale` before use.
 */

export interface LegRig {
  /** Swings the whole leg. */
  hip: THREE.Group;
  /** Bending joints below the hip: knee, then hock or further tentacle segments. */
  joints: THREE.Group[];
  side: 1 | -1;
  pair: number;
  length: number;
  style: LegStyle;
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
  head: THREE.Group;
  heads: THREE.Group[];
  /** Pivots at the shoulder that carry each neck and head. */
  necks: THREE.Group[];
  /** Pivots at the tail base (two for twin tails). */
  tails: THREE.Group[];
  trunks: THREE.Group[];
  /** Pivots at the base of each sprout, so they can sway. */
  sprouts: THREE.Group[];
  legs: LegRig[];
  wings: { pivot: THREE.Group; side: 1 | -1 }[];
  eyes: THREE.Group[];
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

// ---- Paint ---------------------------------------------------------------

interface Palette {
  body: THREE.Color;
  accent: THREE.Color;
  belly: THREE.Color;
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

/** Bake skin colour, pattern, finish and glow mask into vertex attributes. */
function paint(geo: THREE.BufferGeometry, pal: Palette, opts: PaintOptions = {}): THREE.BufferGeometry {
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const colors = new Float32Array(pos.count * 3);
  const glows = new Float32Array(pos.count);
  const offset = opts.offset ?? new THREE.Vector3();
  const { plan } = pal;
  const s = plan.patternScale / plan.size;
  const seedShift = (pal.seed % 1000) * 0.37;
  const c = new THREE.Color();
  const base = new THREE.Color();
  const p = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    p.set(pos.getX(i) + offset.x, pos.getY(i) + offset.y, pos.getZ(i) + offset.z);
    const { x, y, z } = p;
    const ny = nrm.getY(i);
    let accent = 0;
    let glow = 0;
    if (opts.solid) {
      c.copy(opts.solid);
    } else {
      switch (plan.pattern) {
        case 'spots':
          accent = smoothstep(0.62, 0.7, noise3(x * s * 2.2 + seedShift, y * s * 2.2, z * s * 2.2));
          break;
        case 'patches':
          accent = smoothstep(0.52, 0.58, noise3(x * s * 0.8 + seedShift, y * s * 0.8, z * s * 0.8));
          break;
        case 'stripes': {
          const wobble = noise3(y * 2 + seedShift, z * 2, 0) * 0.6;
          accent = smoothstep(0.3, 0.5, Math.sin((x + wobble) * s * 5)) * smoothstep(-0.5, -0.1, ny);
          break;
        }
        case 'plain':
          if (plan.glow) accent = smoothstep(0.7, 0.76, noise3(x * 5 + seedShift, y * 5, z * 5));
          break;
      }
      base.copy(pal.body);
      if (plan.finish === 'gradient') base.lerp(pal.accent, smoothstep(pal.gradient[0], pal.gradient[1], x) * 0.85);
      c.copy(base).lerp(pal.accent, accent);
      c.lerp(pal.belly, smoothstep(-0.15, -0.75, ny) * (1 - accent * 0.6));
      glow = plan.glow ? accent : 0;
      for (const spot of pal.eyespots) {
        const d = p.distanceTo(spot.at) / spot.r;
        if (d >= 1) continue;
        if (d < 0.34) c.copy(DARK);
        else if (d < 0.66) c.copy(IVORY).lerp(pal.accent, 0.25);
        else c.copy(pal.accent).multiplyScalar(0.55);
        glow = plan.glow && d >= 0.34 && d < 0.66 ? 1 : glow;
      }
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
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
  const plate = pal.accent.clone().lerp(pal.body, 0.3);
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
function tube(points: V3[], radii: number[], samples: number, radial: number, widthScale = 1, heightScale = 1): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map(vec), false, 'catmullrom', 0.5);
  const radiusAt = (u: number) => {
    const f = u * (radii.length - 1);
    const i = Math.min(radii.length - 2, Math.floor(f));
    return THREE.MathUtils.lerp(radii[i], radii[i + 1], f - i);
  };
  const positions: number[] = [];
  const indices: number[] = [];
  const normal = new THREE.Vector3();
  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    const c = curve.getPoint(u);
    const t = curve.getTangent(u);
    normal.set(-t.y, t.x, 0).normalize();
    const r = Math.max(0.004, radiusAt(u));
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      positions.push(c.x + normal.x * Math.cos(a) * r * heightScale, c.y + normal.y * Math.cos(a) * r * heightScale, c.z + Math.sin(a) * r * widthScale);
    }
  }
  for (let i = 0; i < samples - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      indices.push(a, a + radial, b, b, a + radial, b + radial);
    }
  }
  // End caps.
  const start = curve.getPoint(0);
  const end = curve.getPoint(1);
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

/**
 * A tube along any 3D spline, using Frenet frames so it can curl and twist
 * freely. Used for sprouts; `tube` is cheaper for paths in the xy plane.
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

/** A tapered cylinder from `a` to `b` in any direction (for paths `tube` cannot do). */
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

// ---- Part builders -----------------------------------------------------------

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
  eyes: THREE.Group[];
  trunks: THREE.Group[];
}

/** Head proportions: wide and flat (frog) … round … long (horse). */
function headScale(plan: BodyPlan) {
  const long = Math.max(0, plan.headStretch);
  const flat = Math.max(0, -plan.headStretch);
  return { sx: 1.05 + 0.55 * long + 0.1 * flat, sy: 0.95 - 0.12 * long - 0.35 * flat, sz: 0.95 - 0.15 * long + 0.35 * flat, long, flat };
}

function buildHead(ctx: Ctx, head: THREE.Group, hr: number, world: THREE.Vector3) {
  const { plan, pal, skin, mesh } = ctx;
  const hs = headScale(plan);
  head.add(mesh(paint(ellipsoid(hr, hs.sx, hs.sy, hs.sz, 22), pal, { offset: world }), skin));
  buildMouth(ctx, head, hr, world);
  buildEyes(ctx, head, hr, world);
  buildEars(ctx, head, hr);
  buildHorns(ctx, head, hr);
  if (plan.fluff === 'crest') buildCrest(ctx, head, hr);
  if (plan.fluff === 'tufts') {
    for (const side of [1, -1]) {
      const tuft = mesh(paint(new THREE.IcosahedronGeometry(hr * 0.22, 0), pal, { solid: pal.belly }), skin);
      tuft.position.set(-hr * 0.1, -hr * 0.25 * hs.sy, side * hr * 0.85 * hs.sz);
      head.add(tuft);
    }
  }
}

function buildMouth(ctx: Ctx, head: THREE.Group, hr: number, world: THREE.Vector3) {
  const { plan, pal, mats, skin, mesh } = ctx;
  const hs = headScale(plan);
  const front = hr * hs.sx;
  const sl = plan.snout;

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
    pivot.add(mesh(paint(tube(pts, [hr * 0.34, hr * 0.27, hr * 0.2, hr * 0.15, hr * 0.12], 20, 12), pal, { offset: world.clone().add(pivot.position) }), skin));
    const tip = mesh(ellipsoid(hr * 0.1, 1, 0.6, 1, 10), mats.pupil, false);
    tip.position.set(pts[4].x, pts[4].y - hr * 0.05, 0);
    pivot.add(tip);
    head.add(pivot);
    ctx.trunks.push(pivot);
    return;
  }

  let tipX = front * 0.9;
  if (sl > 0.05) {
    const g = ellipsoid(hr * 0.55, 1 + sl * 2.2, 0.8, 0.9, 16);
    const at = new THREE.Vector3(front * 0.52 + sl * hr * 0.6, -hr * 0.28 * hs.sy, 0);
    g.translate(at.x, at.y, at.z);
    head.add(mesh(paint(g, pal, { offset: world }), skin));
    tipX = at.x + hr * 0.55 * (1 + sl * 2.2);
    const nose = mesh(ellipsoid(hr * 0.13, 1, 0.8, 1.2, 10), mats.pupil, false);
    nose.position.set(tipX - hr * 0.05, at.y + hr * 0.08, 0);
    head.add(nose);
  }

  if (plan.mouth === 'jaws') {
    const jl = 1 + sl * 1.6;
    const jawX = front * 0.42 + sl * hr * 0.45;
    const jaw = ellipsoid(hr * 0.42, jl, 0.45, 0.85, 14);
    jaw.translate(jawX, -hr * 0.55 * hs.sy, 0);
    head.add(mesh(paint(jaw, pal, { offset: world }), skin));
    for (const side of [1, -1]) {
      const fang = new THREE.ConeGeometry(hr * 0.07, hr * 0.26, 6);
      fang.translate(jawX + hr * 0.42 * jl * 0.72, -hr * 0.36 * hs.sy, side * hr * 0.16);
      head.add(mesh(paint(fang, pal, { solid: IVORY, sheen: 0 }), skin, false));
    }
  }

  if (plan.mouth === 'tusks') {
    for (const side of [1, -1]) {
      const len = hr * (0.85 + sl * 0.6);
      const g = new THREE.ConeGeometry(hr * 0.11, len, 10, 6);
      g.translate(0, len / 2, 0);
      // Curve forward along the length.
      const pos = g.getAttribute('position');
      for (let i = 0; i < pos.count; i++) pos.setX(i, pos.getX(i) + 0.45 * len * Math.pow(pos.getY(i) / len, 2));
      g.computeVertexNormals();
      const tusk = mesh(paint(g, pal, { solid: IVORY, sheen: 0 }), skin);
      tusk.position.set(Math.min(tipX, front * 0.6 + sl * hr * 0.6), -hr * 0.42 * hs.sy, side * hr * 0.32);
      tusk.rotation.set(side * 0.3, 0, -0.25);
      head.add(tusk);
    }
  }
}

function buildEyes(ctx: Ctx, head: THREE.Group, hr: number, world: THREE.Vector3) {
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
  for (const [yaw0, pitch0] of spots) {
    const yaw = clamp(yaw0 * (1 + 0.6 * hs.long), -1.3, 1.3);
    const pitch = Math.min(1.25, pitch0 + lift);
    const dir = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
    const base = new THREE.Vector3(dir.x * hs.sx, dir.y * hs.sy, dir.z * hs.sz).multiplyScalar(hr * 0.9);
    let at = base;
    let look = dir;
    if (stalk) {
      const up = dir.clone().add(new THREE.Vector3(0.15, 0.9, 0)).normalize();
      at = base.clone().addScaledVector(up, stalk);
      head.add(ctx.mesh(paint(segment(base, at, eyeR * 0.3, eyeR * 0.22, 8), pal, { offset: world }), skin));
      look = dir.clone().add(new THREE.Vector3(1.2, 0.1, 0)).normalize();
    }
    const r = eyeR * eyeScale;
    const eye = new THREE.Group();
    eye.position.copy(at);
    // lookAt aims +z, and works in local space because the eye has no parent yet.
    eye.lookAt(at.clone().addScaledVector(look, hr * 4));
    eye.add(mesh(ellipsoid(r, 1, 1, 0.75, 14), mats.eyeWhite, false));
    const pupil = mesh(ellipsoid(r * 0.55, 1, 1, 0.6, 12), mats.pupil, false);
    pupil.position.z = r * 0.5;
    eye.add(pupil);
    const shine = mesh(ellipsoid(r * 0.17, 1, 1, 1, 8), mats.shine, false);
    shine.position.set(r * 0.22, r * 0.25, r * 0.78);
    eye.add(shine);
    head.add(eye);
    ctx.eyes.push(eye);
  }
}

function buildEars(ctx: Ctx, head: THREE.Group, hr: number) {
  const { plan, pal, skin, mesh } = ctx;
  const hs = headScale(plan);
  const es = plan.earSize * hr;
  for (const side of [1, -1] as const) {
    switch (plan.earType) {
      case 'round': {
        const ear = mesh(paint(ellipsoid(es * 0.45, 0.5, 1, 1, 12), pal, { solid: pal.accent }), skin);
        ear.position.set(-hr * 0.15 * hs.sx, hr * 0.75 * hs.sy, side * hr * 0.55 * hs.sz);
        head.add(ear);
        break;
      }
      case 'long': {
        const g = new THREE.CapsuleGeometry(es * 0.18, es * 1.1, 4, 10);
        g.translate(0, es * 0.65, 0);
        g.scale(0.6, 1, 1);
        const ear = mesh(paint(g, pal, { solid: pal.accent }), skin);
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
            const bead = mesh(paint(new THREE.IcosahedronGeometry(es * 0.09, 0), pal, { solid: pal.accent.clone().lerp(IVORY, 0.3), glow: plan.glow ? 1 : 0 }), skin, false);
            bead.position.set(es * 0.08 * (j % 2 ? 1 : -1), es * 0.25 * j, 0);
            frill.add(bead);
          }
        }
        break;
      }
      case 'antennae': {
        const stalk = new THREE.CylinderGeometry(es * 0.03, es * 0.045, es * 1.2, 6);
        stalk.translate(0, es * 0.6, 0);
        const part = mesh(paint(stalk, pal, { solid: pal.body }), skin, false);
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

function buildHorns(ctx: Ctx, head: THREE.Group, hr: number) {
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

function buildCrest(ctx: Ctx, head: THREE.Group, hr: number) {
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

/** Mane or frill on a neck, in the neck pivot's space (origin at the shoulder). */
function buildNeckFluff(ctx: Ctx, pivot: THREE.Group, neck: V3[], radii: number[], hr: number, headAt: THREE.Vector3) {
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

/** Tail(s): pivots at the base with the shaped tip attached. */
function buildTails(ctx: Ctx, body: THREE.Group): THREE.Group[] {
  const { plan, skel, pal, skin, membrane, mesh, rng, k } = ctx;
  const tb = vec(skel.tail[0]);
  const local = skel.tail.map((p) => ({ x: p.x - tb.x, y: p.y - tb.y, z: 0 }));
  const tip = local[local.length - 1];
  const G = plan.girth * k;
  const offsets = plan.twinTail ? [1, -1] : [0];
  const tails: THREE.Group[] = [];
  for (const o of offsets) {
    const pivot = new THREE.Group();
    pivot.position.set(tb.x, tb.y, o * skel.tailRadii[0] * 0.55);
    pivot.userData.baseYaw = o * 0.35;
    pivot.rotation.y = pivot.userData.baseYaw;
    body.add(pivot);
    const radii = skel.tailRadii.map((r) => r * (plan.twinTail ? 0.75 : 1));
    pivot.add(mesh(paint(tube(local, radii, plan.tailShape === 'curl' ? 40 : 20, 10), pal, { offset: tb }), skin));

    if (plan.tailShape === 'club') {
      const r = G * 0.42;
      const ball = mesh(paint(new THREE.IcosahedronGeometry(r, 1), pal, { solid: pal.accent.clone().multiplyScalar(0.85) }), skin);
      ball.position.set(tip.x, tip.y, 0);
      pivot.add(ball);
      for (let i = 0; i < 8; i++) {
        const dir = new THREE.Vector3(rng() - 0.6, rng() - 0.3, rng() - 0.5).normalize();
        const g = new THREE.ConeGeometry(r * 0.22, r * 0.7, 6);
        g.translate(0, r * 0.95, 0);
        g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir));
        const spike = mesh(paint(g, pal, { solid: IVORY, sheen: 0 }), skin, false);
        spike.position.copy(ball.position);
        pivot.add(spike);
      }
    } else if (plan.tailShape === 'fan') {
      const R = G * 0.9 + plan.tailLength * k * 0.25;
      const sweep = 1.9;
      const g = fan(R, Math.PI - sweep / 2, sweep, 7, pal);
      g.translate(tip.x + R * 0.1, tip.y, 0);
      pivot.add(mesh(g, membrane));
    } else if (plan.tailTuft) {
      const tuft = mesh(paint(new THREE.IcosahedronGeometry(Math.max(0.12 * k, G * 0.42), 1), pal, { solid: pal.accent, glow: plan.glow ? 0.9 : 0 }), skin);
      tuft.position.set(tip.x, tip.y, 0);
      tuft.rotation.set(rng() * 3, rng() * 3, 0);
      pivot.add(tuft);
    }
    tails.push(pivot);
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
      const pupil = mesh(ellipsoid(tipSize * 0.55, 1, 1, 0.6, 10), mats.pupil, false);
      pupil.position.z = tipSize * 0.55;
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

/** One leg, built to reach exactly from the hip to the ground in its rest pose. */
function buildLeg(ctx: Ctx, leg: LegLayout, style: LegStyle): LegRig {
  const { plan, pal, skin, mesh } = ctx;
  const hip = new THREE.Group();
  hip.position.copy(vec(leg.hip));
  const H = leg.length;
  const r = leg.radius;
  const s = leg.side;
  const at = vec(leg.hip);
  const footR = r * plan.footSize * 1.3;
  const foot = (scale = 1) => mesh(paint(ellipsoid(footR * scale, 1.4, 0.55, 1, 12), pal, { solid: pal.accent }), skin);
  const p = (x: number, y: number, z = 0) => ({ x, y, z });
  const joints: THREE.Group[] = [];

  switch (style) {
    case 'digitigrade': {
      // Thigh forward, shin back, long foot forward again: knees that bend backward.
      const knee = new THREE.Group();
      const hock = new THREE.Group();
      knee.position.set(0.2 * H, -0.42 * H, 0);
      hock.position.set(-0.22 * H, -0.34 * H, 0);
      const toe = p(0.06 * H, -0.24 * H + footR * 0.4);
      hip.add(mesh(paint(tube([p(0, r * 0.5), p(0.11 * H, -0.2 * H), p(0.2 * H, -0.42 * H)], [r * 1.35, r * 1.15, r * 0.9], 8, 10), pal, { offset: at }), skin));
      knee.add(mesh(paint(tube([p(0, 0), p(-0.11 * H, -0.17 * H), p(-0.22 * H, -0.34 * H)], [r * 0.9, r * 0.72, r * 0.62], 8, 10), pal), skin));
      hock.add(mesh(paint(tube([p(0, 0), p(0.03 * H, -0.12 * H), toe], [r * 0.6, r * 0.52, r * 0.48], 8, 10), pal), skin));
      const f = foot(0.85);
      f.position.set(toe.x + footR * 0.3, toe.y, 0);
      hock.add(f);
      hip.add(knee);
      knee.add(hock);
      joints.push(knee, hock);
      break;
    }
    case 'splayed': {
      // Beetle legs: up and out to a high knee, then down to a pointed tip.
      const kneeAt = new THREE.Vector3(0, 0.22 * H, s * 0.5 * H);
      const tipAt = new THREE.Vector3(0, -H + footR * 0.3, s * 0.85 * H).sub(kneeAt);
      const knee = new THREE.Group();
      knee.position.copy(kneeAt);
      hip.add(mesh(paint(mergeGeometries([segment(new THREE.Vector3(), kneeAt, r * 1.2, r * 0.9), joint(kneeAt, r * 0.95)]), pal, { offset: at }), skin));
      knee.add(mesh(paint(segment(new THREE.Vector3(), tipAt, r * 0.9, r * 0.45), pal), skin));
      const claw = new THREE.ConeGeometry(r * 0.5, footR * 1.4, 8);
      claw.rotateZ(Math.PI);
      claw.translate(tipAt.x, tipAt.y - footR * 0.3, tipAt.z);
      knee.add(mesh(paint(claw, pal, { solid: pal.accent }), skin));
      hip.add(knee);
      joints.push(knee);
      break;
    }
    case 'tentacles': {
      // A chain of four segments; animation curls each joint in turn.
      const dirs = [[0.15, -1, 0.55], [0.08, -1, 0.25], [0, -1, 0.05], [-0.05, -0.3, 0.95]].map(([x, y, z]) => new THREE.Vector3(x, y, z * s).normalize());
      const len = H / dirs.reduce((sum, d) => sum + Math.abs(d.y), 0);
      const rs = [1.35, 1, 0.72, 0.48, 0.24].map((f) => Math.max(0.012, r * f));
      let parent = hip;
      dirs.forEach((d, i) => {
        const end = d.clone().multiplyScalar(len);
        const tipGlow = plan.glow && i === dirs.length - 1 ? 0.8 : undefined;
        parent.add(mesh(paint(mergeGeometries([segment(new THREE.Vector3(), end, rs[i], rs[i + 1], 10), joint(end, rs[i + 1])]), pal, { glow: tipGlow }), skin));
        if (i < dirs.length - 1) {
          const next = new THREE.Group();
          next.position.copy(end);
          parent.add(next);
          joints.push(next);
          parent = next;
        }
      });
      break;
    }
    default: {
      const half = H / 2;
      hip.add(mesh(paint(tube([p(0, r * 0.5), p(0.02, -half * 0.5), p(0, -half)], [r * 1.25, r * 1.1, r * 0.85], 8, 10), pal, { offset: at }), skin));
      const knee = new THREE.Group();
      knee.position.y = -half;
      hip.add(knee);
      knee.add(mesh(paint(tube([p(0, r * 0.3), p(-0.01, -half * 0.5), p(0, -half + r * 0.4)], [r * 0.9, r * 0.75, r * 0.7], 8, 10), pal), skin));
      const f = foot();
      f.position.set(footR * 0.35, -half + footR * 0.45, 0);
      knee.add(f);
      joints.push(knee);
    }
  }
  return { hip, joints, side: leg.side, pair: leg.pair, length: H, style };
}

/** Fins or a sail along the back, tufts or a mane, and a shell. */
function buildBack(ctx: Ctx, body: THREE.Group) {
  const { plan, skel, pal, skin, membrane, mesh, rng } = ctx;
  const n = skel.spine.length;
  const sampleAt = (x: number) => clamp(Math.round(((x - skel.spine[0].x) / (skel.spine[n - 1].x - skel.spine[0].x)) * (n - 1)), 0, n - 1);

  if (skel.spikes.length && plan.spikes > 1.1) {
    // Fins so tall they join into a sail.
    const height = skel.spikes[0].height;
    const x0 = skel.spikes[0].at.x - height * 0.25;
    const x1 = skel.spikes[skel.spikes.length - 1].at.x + height * 0.1;
    const shape = new THREE.Shape();
    const steps = 40;
    const top: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const x = x0 + (x1 - x0) * u;
      const base = skel.backTop[sampleAt(x)] - skel.radii[sampleAt(x)] * 0.15;
      if (i === 0) shape.moveTo(x, base);
      else shape.lineTo(x, base);
      const scallop = 0.8 + 0.2 * Math.cos(2 * Math.PI * skel.spikes.length * (u - 0.5 / skel.spikes.length));
      top.push([x, base + height * Math.pow(Math.sin(Math.PI * u), 0.7) * scallop]);
    }
    for (const [x, y] of top.reverse()) shape.lineTo(x, y);
    const g = new THREE.ShapeGeometry(shape);
    body.add(mesh(paint(g, pal, { solid: pal.accent, glow: plan.glow ? 0.7 : 0 }), membrane));
    for (const spike of skel.spikes) {
      const u = (spike.at.x - x0) / (x1 - x0);
      const tall = height * Math.pow(Math.sin(Math.PI * u), 0.7);
      const rod = new THREE.ConeGeometry(height * 0.05, tall, 6);
      rod.translate(spike.at.x, spike.at.y + tall / 2, 0);
      body.add(mesh(paint(rod, pal, { solid: pal.accent.clone().multiplyScalar(0.6) }), skin, false));
    }
  } else {
    for (const spike of skel.spikes) {
      const g = new THREE.ConeGeometry(spike.height * 0.42, spike.height, 8);
      g.translate(0, spike.height / 2, 0);
      g.rotateZ(0.35);
      g.scale(1, 1, 0.45);
      const m = mesh(paint(g, pal, { solid: pal.accent, glow: plan.glow ? 0.8 : 0 }), skin);
      m.position.copy(vec(spike.at)).y -= spike.height * 0.15;
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
      const puff = mesh(paint(new THREE.IcosahedronGeometry(r * 0.32 + 0.03 * ctx.k, 0), pal, { solid: plan.fluff === 'tufts' ? pal.belly : pal.accent.clone().multiplyScalar(0.8) }), skin);
      puff.position.set(skel.spine[idx].x, skel.backTop[idx] - r * 0.05, 0);
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
    body.add(shell);
  }
}

// ---- Assembly ----------------------------------------------------------------

export function buildCreature(plan: BodyPlan, skel: Skeleton, seed: number): CreatureRig {
  const mats = creatureMaterials();
  const k = skel.scale;
  const n = skel.spine.length;
  const x0 = skel.spine[0].x;
  const L = skel.spine[n - 1].x - x0;

  // Eye-spots sit on the flanks, a few per side.
  const eyespots: Palette['eyespots'] = [];
  if (plan.finish === 'eyespots') {
    for (const t of plan.segments >= 5 ? [0.3, 0.5, 0.7] : [0.36, 0.62]) {
      const i = Math.round(t * (n - 1));
      const s = skel.spine[i];
      const r = skel.radii[i];
      for (const side of [1, -1]) eyespots.push({ at: new THREE.Vector3(s.x, s.y + r * skel.heightScale * 0.25, side * r * skel.widthScale * 0.95), r: r * 0.5 });
    }
  }
  const pal: Palette = {
    body: toColor(plan.colour.body),
    accent: toColor(plan.colour.accent),
    belly: toColor(plan.colour.belly),
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
  };

  const root = new THREE.Group();
  const scaler = new THREE.Group();
  const body = new THREE.Group();
  root.add(scaler);
  scaler.add(body);

  const torsoGeo = paint(tube(skel.spine, skel.radii, 72, 20, skel.widthScale, skel.heightScale), pal);
  const torso = ctx.mesh(torsoGeo, ctx.skin);
  body.add(torso);

  buildBack(ctx, body);

  // Neck(s) and head(s), each on a pivot at the shoulder.
  const shoulder = vec(skel.neck[0]);
  const neckLocal = skel.neck.map((p) => ({ x: p.x - shoulder.x, y: p.y - shoulder.y, z: 0 }));
  const hc = vec(skel.head.center);
  const headLocal = hc.clone().sub(shoulder);
  const hr = skel.head.radius * (plan.twinHead ? 0.85 : 1);
  const necks: THREE.Group[] = [];
  const heads: THREE.Group[] = [];
  for (const yaw of plan.twinHead ? [0.42, -0.42] : [0]) {
    const pivot = new THREE.Group();
    pivot.position.copy(shoulder);
    pivot.rotation.y = yaw;
    pivot.userData.baseYaw = yaw;
    const neckRadii = skel.neckRadii.map((r) => r * (plan.twinHead ? 0.8 : 1));
    pivot.add(ctx.mesh(paint(tube(neckLocal, neckRadii, 14, 14), pal, { offset: shoulder }), ctx.skin));
    const head = new THREE.Group();
    head.position.copy(headLocal);
    pivot.add(head);
    buildHead(ctx, head, hr, hc);
    buildNeckFluff(ctx, pivot, neckLocal, neckRadii, hr, headLocal);
    body.add(pivot);
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
  for (const leg of skel.legs) legs.push(buildLeg(ctx, leg, plan.legStyle));
  for (const leg of skel.tentacles) legs.push(buildLeg(ctx, leg, 'tentacles'));
  for (const leg of legs) body.add(leg.hip);

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

  const emoteAnchor = new THREE.Object3D();
  const extra = plan.horns === 'antlers' || plan.horns === 'unicorn' ? hr * 1.3 : plan.earType === 'none' ? 0 : plan.earSize * hr;
  emoteAnchor.position.set(hc.x, hc.y + hr + 0.5 + extra + plan.eyeStalks * hr * 0.6, 0);
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
    wings,
    eyes: ctx.eyes,
    emoteAnchor,
    bend: makeBender(torsoGeo, body, torso, x0, L),
    dispose: () => geometries.forEach((g) => g.dispose()),
  };
}

/**
 * Spine bending for slithering and inching: moves torso vertices and every
 * part attached to the body along the same wave, so legs and fins ride along.
 */
function makeBender(geo: THREE.BufferGeometry, body: THREE.Group, torso: THREE.Mesh, x0: number, L: number): CreatureRig['bend'] {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const base = Float32Array.from(pos.array as Float32Array);
  const us = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) us[i] = (base[i * 3] - x0) / L;
  const parts = body.children.filter((o) => o !== torso).map((o) => ({ o, base: o.position.clone(), u: (o.position.x - x0) / L }));
  const off = (w: Wave | null, u: number) => (w ? w.amp * Math.sin(2 * Math.PI * w.waves * u + w.phase) : 0);
  const slope = (w: Wave | null, u: number) => (w ? Math.atan((w.amp * 2 * Math.PI * w.waves * Math.cos(2 * Math.PI * w.waves * u + w.phase)) / L) : 0);
  let bent = false;
  return (y, z) => {
    if (!y && !z && !bent) return { tailYaw: 0, headYaw: 0, tailPitch: 0, headPitch: 0 };
    const arr = pos.array as Float32Array;
    for (let i = 0; i < pos.count; i++) {
      arr[i * 3 + 1] = base[i * 3 + 1] + off(y, us[i]);
      arr[i * 3 + 2] = base[i * 3 + 2] + off(z, us[i]);
    }
    for (const p of parts) p.o.position.set(p.base.x, p.base.y + off(y, p.u), p.base.z + off(z, p.u));
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    bent = !!(y || z);
    // Yaw follows the z-wave; pitch is negated because a rising curve toward the tail tips the tail up.
    return { tailYaw: -slope(z, 0), headYaw: -slope(z, 1), tailPitch: -slope(y, 0), headPitch: slope(y, 1) };
  };
}
