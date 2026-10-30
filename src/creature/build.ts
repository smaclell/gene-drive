import * as THREE from 'three';
import { noise3 } from '../core/noise';
import { mulberry32, smoothstep } from '../core/rng';
import type { Skeleton, V3 } from '../genetics/anatomy';
import type { BodyPlan, Hsl } from '../genetics/phenotype';
import { creatureMaterials } from './materials';

/**
 * Turns a skeleton into three.js meshes. No assets: every part is generated
 * from the body plan. The returned rig exposes the pivots that animation moves.
 */

export interface LegRig {
  hip: THREE.Group;
  knee: THREE.Group;
  side: 1 | -1;
  pair: number;
  length: number;
}

export interface CreatureRig {
  root: THREE.Group;
  /** Scales with age (babies are small). */
  scaler: THREE.Group;
  /** Bobs, pitches and squashes as a whole. */
  body: THREE.Group;
  head: THREE.Group;
  tail: THREE.Group;
  legs: LegRig[];
  wings: { pivot: THREE.Group; side: 1 | -1 }[];
  eyes: THREE.Group[];
  /** Point above the head where emotes float. */
  emoteAnchor: THREE.Object3D;
  dispose: () => void;
}

const vec = (p: V3) => new THREE.Vector3(p.x, p.y, p.z);

const toColor = (c: Hsl) => new THREE.Color().setHSL(c.h, c.s, c.l, THREE.SRGBColorSpace);

interface Palette {
  body: THREE.Color;
  accent: THREE.Color;
  belly: THREE.Color;
  plan: BodyPlan;
  seed: number;
}

interface PaintOptions {
  /** Where this geometry's origin sits in creature space, so patterns line up across parts. */
  offset?: THREE.Vector3;
  /** Paint a flat colour instead of the skin pattern. */
  solid?: THREE.Color;
  /** Force a glow amount for the whole part (e.g. antenna tips). */
  glow?: number;
}

/** Bake skin colour and glow mask into vertex attributes. */
function paint(geo: THREE.BufferGeometry, pal: Palette, opts: PaintOptions = {}): THREE.BufferGeometry {
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const colors = new Float32Array(pos.count * 3);
  const glows = new Float32Array(pos.count);
  const offset = opts.offset ?? new THREE.Vector3();
  const { plan } = pal;
  const s = plan.patternScale;
  const seedShift = (pal.seed % 1000) * 0.37;
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + offset.x;
    const y = pos.getY(i) + offset.y;
    const z = pos.getZ(i) + offset.z;
    const ny = nrm.getY(i);
    let accent = 0;
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
      c.copy(pal.body).lerp(pal.accent, accent);
      c.lerp(pal.belly, smoothstep(-0.15, -0.75, ny) * (1 - accent * 0.6));
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
    glows[i] = opts.glow ?? (plan.glow ? accent : 0);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('glow', new THREE.BufferAttribute(glows, 1));
  return geo;
}

/**
 * A tube along a planar (xy) path with varying radius and closed ends.
 * Vertices are shared around each ring, so there is no shading seam.
 */
function tube(points: V3[], radii: number[], samples: number, radial: number, widthScale = 1): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map(vec), false, 'catmullrom', 0.5);
  const radiusAt = (u: number) => {
    const f = u * (radii.length - 1);
    const i = Math.min(radii.length - 2, Math.floor(f));
    return THREE.MathUtils.lerp(radii[i], radii[i + 1], f - i);
  };
  const positions: number[] = [];
  const indices: number[] = [];
  const binormal = new THREE.Vector3(0, 0, 1);
  const normal = new THREE.Vector3();
  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    const c = curve.getPoint(u);
    const t = curve.getTangent(u);
    normal.set(-t.y, t.x, 0).normalize();
    const r = Math.max(0.004, radiusAt(u));
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      positions.push(
        c.x + normal.x * Math.cos(a) * r,
        c.y + normal.y * Math.cos(a) * r,
        c.z + binormal.z * Math.sin(a) * r * widthScale,
      );
    }
  }
  for (let i = 0; i < samples - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c2 = a + radial;
      const d = b + radial;
      indices.push(a, c2, b, b, c2, d);
    }
  }
  // End caps.
  const start = curve.getPoint(0);
  const end = curve.getPoint(1);
  const startIdx = positions.length / 3;
  positions.push(start.x, start.y, start.z);
  const endIdx = startIdx + 1;
  positions.push(end.x, end.y, end.z);
  const last = (samples - 1) * radial;
  for (let j = 0; j < radial; j++) {
    indices.push(startIdx, j, (j + 1) % radial);
    indices.push(endIdx, last + ((j + 1) % radial), last + j);
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

export function buildCreature(plan: BodyPlan, skel: Skeleton, seed: number): CreatureRig {
  const mats = creatureMaterials();
  const rng = mulberry32(seed);
  const pal: Palette = { body: toColor(plan.colour.body), accent: toColor(plan.colour.accent), belly: toColor(plan.colour.belly), plan, seed };
  const geometries: THREE.BufferGeometry[] = [];
  const mesh = (geo: THREE.BufferGeometry, material: THREE.Material, shadow = true) => {
    geometries.push(geo);
    const m = new THREE.Mesh(geo, material);
    m.castShadow = shadow;
    return m;
  };

  const root = new THREE.Group();
  const scaler = new THREE.Group();
  const body = new THREE.Group();
  root.add(scaler);
  scaler.add(body);

  // Torso and neck.
  body.add(mesh(paint(tube(skel.spine, skel.radii, 48, 20, skel.widthScale), pal), mats.skin));
  body.add(mesh(paint(tube(skel.neck, skel.neckRadii, 12, 14), pal), mats.skin));

  // Back fins.
  for (const spike of skel.spikes) {
    const g = new THREE.ConeGeometry(spike.height * 0.42, spike.height, 8);
    g.translate(0, spike.height / 2, 0);
    g.rotateZ(0.35);
    g.scale(1, 1, 0.45);
    const m = mesh(paint(g, pal, { solid: pal.accent, glow: plan.glow ? 0.8 : 0 }), mats.skin);
    m.position.copy(vec(spike.at)).y -= spike.height * 0.15;
    body.add(m);
  }

  // Head.
  const head = new THREE.Group();
  const hc = vec(skel.head.center);
  const hr = skel.head.radius;
  head.position.copy(hc);
  body.add(head);
  head.add(mesh(paint(ellipsoid(hr, 1.05, 0.95, 0.95, 22), pal, { offset: hc }), mats.skin));

  if (plan.snout > 0.05) {
    const sl = plan.snout;
    const g = ellipsoid(hr * 0.55, 1 + sl * 2.2, 0.8, 0.9, 16);
    const at = new THREE.Vector3(hr * 0.55 + sl * hr * 0.6, -hr * 0.28, 0);
    g.translate(at.x, at.y, at.z);
    head.add(mesh(paint(g, pal, { offset: hc }), mats.skin));
    const nose = mesh(ellipsoid(hr * 0.13, 1, 0.8, 1.2, 10), mats.pupil, false);
    nose.position.set(at.x + hr * 0.55 * (1 + sl * 2.2) - hr * 0.05, at.y + hr * 0.08, 0);
    head.add(nose);
  }

  // Eyes, spread across the face.
  const eyes: THREE.Group[] = [];
  const eyeR = hr * plan.eyeSize;
  const eyeSpots: [number, number][] = (() => {
    switch (plan.eyeCount) {
      case 1: return [[0, 0.3]];
      case 2: return [[-0.42, 0.25], [0.42, 0.25]];
      case 3: return [[-0.45, 0.15], [0.45, 0.15], [0, 0.62]];
      default: return [[-0.4, 0.05], [0.4, 0.05], [-0.32, 0.55], [0.32, 0.55]];
    }
  })();
  const eyeScale = plan.eyeCount === 1 ? 1.5 : plan.eyeCount >= 3 ? 0.8 : 1;
  for (const [yaw, pitch] of eyeSpots) {
    const r = eyeR * eyeScale;
    const dir = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
    const eye = new THREE.Group();
    eye.position.copy(dir.clone().multiplyScalar(hr * 0.88));
    eye.lookAt(dir.clone().multiplyScalar(hr * 4));
    // lookAt aims +z, so build the eye along +z.
    eye.add(mesh(ellipsoid(r, 1, 1, 0.75, 14), mats.eyeWhite, false));
    const pupil = mesh(ellipsoid(r * 0.55, 1, 1, 0.6, 12), mats.pupil, false);
    pupil.position.z = r * 0.5;
    eye.add(pupil);
    const shine = mesh(ellipsoid(r * 0.17, 1, 1, 1, 8), mats.shine, false);
    shine.position.set(r * 0.22, r * 0.25, r * 0.78);
    eye.add(shine);
    head.add(eye);
    eyes.push(eye);
  }

  // Ears, horns or antennae.
  const es = plan.earSize * hr;
  for (const side of [1, -1] as const) {
    let part: THREE.Mesh | null = null;
    switch (plan.earType) {
      case 'round': {
        part = mesh(paint(ellipsoid(es * 0.45, 0.5, 1, 1, 12), pal, { solid: pal.accent }), mats.skin);
        part.position.set(-hr * 0.15, hr * 0.75, side * hr * 0.55);
        break;
      }
      case 'long': {
        const g = new THREE.CapsuleGeometry(es * 0.18, es * 1.1, 4, 10);
        g.translate(0, es * 0.65, 0);
        g.scale(0.6, 1, 1);
        part = mesh(paint(g, pal, { solid: pal.accent }), mats.skin);
        part.position.set(-hr * 0.25, hr * 0.7, side * hr * 0.4);
        part.rotation.set(side * -0.45, 0, 0.5);
        break;
      }
      case 'horns': {
        const g = new THREE.ConeGeometry(es * 0.16, es * 1.1, 10);
        g.translate(0, es * 0.55, 0);
        part = mesh(paint(g, pal, { solid: new THREE.Color(0xf1e6c8) }), mats.skin);
        part.position.set(hr * 0.1, hr * 0.75, side * hr * 0.45);
        part.rotation.set(side * -0.35, 0, 0.45);
        break;
      }
      case 'antennae': {
        const stalk = new THREE.CylinderGeometry(es * 0.03, es * 0.045, es * 1.2, 6);
        stalk.translate(0, es * 0.6, 0);
        part = mesh(paint(stalk, pal, { solid: pal.body }), mats.skin, false);
        part.position.set(hr * 0.15, hr * 0.8, side * hr * 0.3);
        part.rotation.set(side * -0.4, 0, -0.25);
        const bulb = mesh(paint(ellipsoid(es * 0.14), pal, { solid: pal.accent, glow: plan.glow ? 1 : 0.15 }), mats.skin, false);
        bulb.position.y = es * 1.22;
        part.add(bulb);
        break;
      }
      case 'none':
        break;
    }
    if (part) head.add(part);
  }

  // Tail, pivoting at its base so it can wag.
  const tail = new THREE.Group();
  const tb = vec(skel.tail[0]);
  tail.position.copy(tb);
  body.add(tail);
  const tailLocal = skel.tail.map((p) => ({ x: p.x - tb.x, y: p.y - tb.y, z: 0 }));
  tail.add(mesh(paint(tube(tailLocal, skel.tailRadii, 16, 10), pal, { offset: tb }), mats.skin));
  if (plan.tailTuft) {
    const tip = tailLocal[tailLocal.length - 1];
    const tuft = mesh(paint(new THREE.IcosahedronGeometry(Math.max(0.12, plan.girth * 0.42), 1), pal, { solid: pal.accent, glow: plan.glow ? 0.9 : 0 }), mats.skin);
    tuft.position.set(tip.x, tip.y, 0);
    tuft.rotation.set(rng() * 3, rng() * 3, 0);
    tail.add(tuft);
  }

  // Legs: hip → upper → knee → lower → foot. Each hangs straight down to the ground.
  const legs: LegRig[] = [];
  for (const leg of skel.legs) {
    const hip = new THREE.Group();
    hip.position.copy(vec(leg.hip));
    body.add(hip);
    const half = leg.length / 2;
    const r = leg.radius;
    const upper = tube([{ x: 0, y: r * 0.5, z: 0 }, { x: 0.02, y: -half * 0.5, z: 0 }, { x: 0, y: -half, z: 0 }], [r * 1.25, r * 1.1, r * 0.85], 8, 10);
    hip.add(mesh(paint(upper, pal, { offset: vec(leg.hip) }), mats.skin));
    const knee = new THREE.Group();
    knee.position.y = -half;
    hip.add(knee);
    const lower = tube([{ x: 0, y: r * 0.3, z: 0 }, { x: -0.01, y: -half * 0.5, z: 0 }, { x: 0, y: -half + r * 0.4, z: 0 }], [r * 0.9, r * 0.75, r * 0.7], 8, 10);
    knee.add(mesh(paint(lower, pal), mats.skin));
    const footR = r * plan.footSize * 1.3;
    const foot = mesh(paint(ellipsoid(footR, 1.4, 0.55, 1, 12), pal, { solid: pal.accent }), mats.skin);
    foot.position.set(footR * 0.35, -half + footR * 0.45, 0);
    knee.add(foot);
    legs.push({ hip, knee, side: leg.side, pair: leg.pair, length: leg.length });
  }

  // Wings.
  const wings: CreatureRig['wings'] = [];
  if (skel.wingRoot && plan.wingSpan > 0) {
    const wr = vec(skel.wingRoot);
    for (const side of [1, -1] as const) {
      const pivot = new THREE.Group();
      pivot.position.set(wr.x, wr.y, side * plan.girth * 0.35);
      const w = mesh(paint(wingGeometry(plan.wingSpan, side), pal, { solid: pal.accent.clone().lerp(new THREE.Color(0xffffff), 0.35), glow: plan.glow ? 0.5 : 0 }), mats.wing);
      pivot.add(w);
      body.add(pivot);
      wings.push({ pivot, side });
    }
  }

  const emoteAnchor = new THREE.Object3D();
  emoteAnchor.position.set(hc.x, hc.y + hr + 0.6 + (plan.earType === 'none' ? 0 : es), 0);
  body.add(emoteAnchor);

  return {
    root,
    scaler,
    body,
    head,
    tail,
    legs,
    wings,
    eyes,
    emoteAnchor,
    dispose: () => geometries.forEach((g) => g.dispose()),
  };
}
