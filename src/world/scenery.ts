import * as THREE from 'three';
import { fbm2, noise2 } from '../core/noise';
import { mulberry32, randRange, smoothstep, type Rng } from '../core/rng';
import { toonGradient } from '../creature/materials';
import {
  COTTAGE, FENCE_RADIUS, GATE_ANGLE, POND, RANCH_RADIUS, SOIL, WATER_LEVEL, WORLD_SIZE,
  inSoil, pondDistance, randomLandPoint, terrainHeight, type Point,
} from './layout';

/**
 * The procedural meadow: terrain, pond, soil, trees with fruit, flowers,
 * cottage and fence. Fruit and flowers are the "work sites" creatures use.
 */

export type TreeKind = 'bush' | 'apple' | 'tall';

export interface Fruit {
  mesh: THREE.Mesh;
  /** Height above the ground at the tree's base. */
  height: number;
  ripe: boolean;
  regrowAt: number;
}

export interface Tree {
  kind: TreeKind;
  group: THREE.Group;
  /** 0 still … 1 shaking hard (a sky-neck is shaking it). Decays on its own. */
  shake: number;
  x: number;
  z: number;
  /** How far from the trunk a creature stands to pick fruit. */
  standOff: number;
  fruits: Fruit[];
}

export interface FlowerPatch {
  x: number;
  z: number;
  /** 0 closed bud … 1 full bloom. Pollinators raise it; it fades slowly. */
  bloom: number;
  busyUntil: number;
  instances: number[];
  baseScale: number[];
}

/** A hole a great digger left in the soil. Diggers like to nap in them. */
export interface Burrow {
  x: number;
  z: number;
  mesh: THREE.Group;
  /** Fades away after this time. */
  until: number;
}

export interface World {
  group: THREE.Group;
  trees: Tree[];
  flowers: FlowerPatch[];
  burrows: Burrow[];
  water: THREE.Mesh;
  update: (time: number, dt: number) => void;
  addBurrow: (x: number, z: number, time: number) => void;
}

const BURROW_SECONDS = 300;
const MAX_BURROWS = 6;

const FRUIT_REGROW_SECONDS = 50;

function lambert(color: THREE.ColorRepresentation, flat = true) {
  return new THREE.MeshLambertMaterial({ color, flatShading: flat });
}

function toon(color: THREE.ColorRepresentation) {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonGradient() });
}

function buildTerrain(): THREE.Mesh {
  const segments = 170;
  const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const grassA = new THREE.Color(0x8cc56a);
  const grassB = new THREE.Color(0x6fae5a);
  const meadow = new THREE.Color(0xb7d77a);
  const sand = new THREE.Color(0xe8d7a6);
  const wetSand = new THREE.Color(0xb59f74);
  const soil = new THREE.Color(0x8a5a3c);
  const soilDark = new THREE.Color(0x6b432c);
  const hill = new THREE.Color(0x7fa65a);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);
    c.copy(grassA).lerp(grassB, fbm2(x * 0.08, z * 0.08, 3, 3));
    c.lerp(meadow, smoothstep(0.62, 0.78, noise2(x * 0.05 + 9, z * 0.05, 4)) * 0.7);
    c.lerp(hill, smoothstep(2, 8, h));
    const shore = pondDistance(x, z);
    if (shore < 1.45) c.lerp(sand, smoothstep(1.45, 1.2, shore));
    if (shore < 1.4 && h < WATER_LEVEL - 0.1) c.copy(wetSand);
    if (inSoil(x, z)) c.copy(Math.sin((z - SOIL.z) * 3.6) > 0 ? soil : soilDark);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

function buildWater(): THREE.Mesh {
  const geo = new THREE.CircleGeometry(POND.r * 1.35, 48);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshPhongMaterial({ color: 0x5cb8d6, transparent: true, opacity: 0.78, shininess: 90, specular: 0xffffff });
  const water = new THREE.Mesh(geo, mat);
  water.position.set(POND.x, WATER_LEVEL, POND.z);
  water.receiveShadow = true;
  return water;
}

const FRUIT_STYLE: Record<TreeKind, { color: number; size: number }> = {
  bush: { color: 0x7b4bb8, size: 0.11 },
  apple: { color: 0xe0483e, size: 0.16 },
  tall: { color: 0xf2c14e, size: 0.18 },
};

function buildTree(kind: TreeKind, p: Point, rng: Rng, withFruit: boolean): { group: THREE.Group; tree: Tree } {
  const group = new THREE.Group();
  const ground = terrainHeight(p.x, p.z);
  group.position.set(p.x, ground, p.z);
  const trunkColor = 0x8b6345;
  const leafColors = [0x5d9c4c, 0x6fb35a, 0x4f8a45, 0x7cbf5f];
  const leaf = lambert(leafColors[Math.floor(rng() * leafColors.length)]);

  let canopyY: number;
  let canopyR: number;
  if (kind === 'bush') {
    canopyY = 0.6;
    canopyR = randRange(rng, 0.7, 0.95);
  } else {
    const trunkH = kind === 'apple' ? randRange(rng, 1.4, 1.9) : randRange(rng, 3.0, 3.6);
    canopyR = kind === 'apple' ? randRange(rng, 1.3, 1.6) : randRange(rng, 1.3, 1.7);
    canopyY = trunkH + canopyR * 0.7;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.28, trunkH + canopyR * 0.5, 7), lambert(trunkColor));
    trunk.position.y = (trunkH + canopyR * 0.5) / 2;
    trunk.castShadow = true;
    group.add(trunk);
  }

  const blobs = kind === 'bush' ? 3 : 4;
  for (let i = 0; i < blobs; i++) {
    const r = canopyR * randRange(rng, 0.6, 0.85);
    const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), leaf);
    const a = (i / blobs) * Math.PI * 2 + rng();
    blob.position.set(Math.cos(a) * canopyR * 0.4, canopyY + randRange(rng, -0.15, 0.25) * canopyR, Math.sin(a) * canopyR * 0.4);
    blob.castShadow = true;
    blob.receiveShadow = true;
    group.add(blob);
  }

  const fruits: Fruit[] = [];
  if (withFruit) {
    const style = FRUIT_STYLE[kind];
    const fruitMat = toon(style.color);
    const geo = new THREE.SphereGeometry(style.size, 10, 8);
    const count = kind === 'bush' ? 6 : 7;
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      // Lower half of the canopy, on the outside where a creature can get at it.
      const elev = kind === 'bush' ? randRange(rng, -0.3, 0.6) : randRange(rng, -0.65, 0.25);
      const r = canopyR * 1.02;
      const mesh = new THREE.Mesh(geo, fruitMat);
      mesh.position.set(Math.cos(a) * r * Math.cos(elev), canopyY + Math.sin(elev) * r, Math.sin(a) * r * Math.cos(elev));
      mesh.castShadow = true;
      group.add(mesh);
      fruits.push({ mesh, height: mesh.position.y, ripe: true, regrowAt: 0 });
    }
  }

  return { group, tree: { kind, group, shake: 0, x: p.x, z: p.z, standOff: canopyR * 0.9 + 0.4, fruits } };
}

function buildFlowers(rng: Rng, spots: Point[]): { meshes: THREE.Object3D[]; patches: FlowerPatch[]; heads: THREE.InstancedMesh } {
  const perPatch = 9;
  const total = spots.length * perPatch;
  const stemGeo = new THREE.CylinderGeometry(0.02, 0.025, 1, 5);
  stemGeo.translate(0, 0.5, 0);
  const stems = new THREE.InstancedMesh(stemGeo, lambert(0x4f8f3e), total);
  const heads = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.13, 0), toon(0xffffff), total);
  const palette = [0xf7a6c4, 0xfde68a, 0xc4b5fd, 0xfda4af, 0xffffff, 0x93c5fd, 0xfdba74];
  const m = new THREE.Matrix4();
  const patches: FlowerPatch[] = [];
  let idx = 0;
  for (const spot of spots) {
    const patch: FlowerPatch = { x: spot.x, z: spot.z, bloom: 0.3, busyUntil: 0, instances: [], baseScale: [] };
    const colour = new THREE.Color(palette[Math.floor(rng() * palette.length)]);
    for (let i = 0; i < perPatch; i++) {
      const x = spot.x + randRange(rng, -1.1, 1.1);
      const z = spot.z + randRange(rng, -1.1, 1.1);
      const y = terrainHeight(x, z);
      const h = randRange(rng, 0.35, 0.7);
      m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(1, h, 1));
      stems.setMatrixAt(idx, m);
      m.makeTranslation(x, y + h, z);
      heads.setMatrixAt(idx, m);
      heads.setColorAt(idx, colour.clone().offsetHSL(randRange(rng, -0.03, 0.03), 0, randRange(rng, -0.05, 0.05)));
      patch.instances.push(idx);
      patch.baseScale.push(h);
      idx++;
    }
    patches.push(patch);
  }
  stems.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
  return { meshes: [stems, heads], patches, heads };
}

function buildGrass(rng: Rng): THREE.InstancedMesh {
  const count = 1600;
  const geo = new THREE.ConeGeometry(0.07, 0.42, 3);
  geo.translate(0, 0.2, 0);
  const grass = new THREE.InstancedMesh(geo, lambert(0x6aa84f), count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  let placed = 0;
  for (let tries = 0; placed < count && tries < count * 4; tries++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * (FENCE_RADIUS + 12);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = terrainHeight(x, z);
    if (pondDistance(x, z) < 1.3 || inSoil(x, z)) continue;
    q.setFromEuler(new THREE.Euler(randRange(rng, -0.25, 0.25), rng() * 6, randRange(rng, -0.25, 0.25)));
    const s = randRange(rng, 0.6, 1.4);
    m.compose(new THREE.Vector3(x, h, z), q, new THREE.Vector3(s, s, s));
    grass.setMatrixAt(placed, m);
    grass.setColorAt(placed, new THREE.Color().setHSL(randRange(rng, 0.24, 0.3), 0.45, randRange(rng, 0.38, 0.52)));
    placed++;
  }
  grass.count = placed;
  return grass;
}

function buildFence(): THREE.Group {
  const group = new THREE.Group();
  const posts = 72;
  const wood = lambert(0xc49a6c);
  const postGeo = new THREE.BoxGeometry(0.18, 1.1, 0.18);
  const postMesh = new THREE.InstancedMesh(postGeo, wood, posts);
  const railMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.1, 0.08), wood, posts * 2);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  let rails = 0;
  let placedPosts = 0;
  const gateHalfWidth = 0.09;
  for (let i = 0; i < posts; i++) {
    const a = (i / posts) * Math.PI * 2;
    const next = ((i + 1) / posts) * Math.PI * 2;
    const p = (ang: number) => new THREE.Vector3(Math.cos(ang) * FENCE_RADIUS, 0, Math.sin(ang) * FENCE_RADIUS);
    const pa = p(a);
    pa.y = terrainHeight(pa.x, pa.z) + 0.5;
    const nearGate = (ang: number) => Math.abs(Math.atan2(Math.sin(ang - GATE_ANGLE), Math.cos(ang - GATE_ANGLE))) < gateHalfWidth;
    m.makeTranslation(pa.x, pa.y, pa.z);
    postMesh.setMatrixAt(placedPosts++, m);
    if (nearGate(a) || nearGate(next)) continue;
    const pb = p(next);
    pb.y = terrainHeight(pb.x, pb.z) + 0.5;
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    const len = pa.distanceTo(pb);
    q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), pb.clone().sub(pa).normalize());
    for (const dy of [0.15, -0.2]) {
      m.compose(mid.clone().setY(mid.y + dy), q, new THREE.Vector3(len, 1, 1));
      railMesh.setMatrixAt(rails++, m);
    }
  }
  postMesh.count = placedPosts;
  railMesh.count = rails;
  postMesh.castShadow = true;
  group.add(postMesh, railMesh);
  return group;
}

function buildCottage(): THREE.Group {
  const g = new THREE.Group();
  const y = terrainHeight(COTTAGE.x, COTTAGE.z);
  g.position.set(COTTAGE.x, y, COTTAGE.z);
  const walls = new THREE.Mesh(new THREE.BoxGeometry(COTTAGE.w, 2.6, COTTAGE.d), lambert(0xf3e3c3));
  walls.position.y = 1.3;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(COTTAGE.w * 0.78, 2.2, 4), lambert(0xc0605a));
  roof.position.y = 3.7;
  roof.rotation.y = Math.PI / 4;
  roof.scale.set(1, 1, COTTAGE.d / COTTAGE.w);
  const door = new THREE.Mesh(new THREE.BoxGeometry(1, 1.6, 0.1), lambert(0x8b5a3c));
  door.position.set(0.8, 0.8, COTTAGE.d / 2 + 0.03);
  const windowMat = new THREE.MeshLambertMaterial({ color: 0xffe8a3, emissive: 0x6b5520 });
  const win = new THREE.Mesh(new THREE.BoxGeometry(1, 0.8, 0.1), windowMat);
  win.position.set(-1.4, 1.5, COTTAGE.d / 2 + 0.03);
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.4, 0.6), lambert(0x9a8c80));
  chimney.position.set(-1.6, 4, -0.6);
  for (const part of [walls, roof, door, win, chimney]) {
    part.castShadow = true;
    part.receiveShadow = true;
    g.add(part);
  }
  g.userData.windowMat = windowMat;
  return g;
}

function buildRocks(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const mat = lambert(0xa8a29e);
  for (let i = 0; i < 14; i++) {
    const p = i < 6 ? { x: POND.x + Math.cos(i) * POND.r * 1.05, z: POND.z + Math.sin(i) * POND.r * 1.05 } : randomLandPoint(rng);
    const s = randRange(rng, 0.25, 0.7);
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), mat);
    rock.position.set(p.x, terrainHeight(p.x, p.z) + s * 0.3, p.z);
    rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    rock.scale.y = 0.6;
    rock.castShadow = true;
    g.add(rock);
  }
  return g;
}

export function buildWorld(seed = 1): World {
  const rng = mulberry32(seed);
  const group = new THREE.Group();
  group.add(buildTerrain());
  const water = buildWater();
  group.add(water);
  group.add(buildFence());
  const cottage = buildCottage();
  group.add(cottage);
  group.add(buildGrass(rng));
  group.add(buildRocks(rng));

  // Fruit trees, spaced apart, inside the fence.
  const trees: Tree[] = [];
  const taken: Point[] = [];
  const spaced = (minGap: number, maxRadius = RANCH_RADIUS - 3) => {
    for (let i = 0; i < 60; i++) {
      const p = randomLandPoint(rng, undefined, 0, maxRadius);
      if (taken.every((t) => Math.hypot(t.x - p.x, t.z - p.z) > minGap) && Math.hypot(p.x, p.z) > 4 && !inSoil(p.x, p.z)) {
        taken.push(p);
        return p;
      }
    }
    return randomLandPoint(rng);
  };
  const plan: [TreeKind, number][] = [['bush', 9], ['apple', 8], ['tall', 5]];
  for (const [kind, count] of plan) {
    for (let i = 0; i < count; i++) {
      const built = buildTree(kind, spaced(5.5), rng, true);
      group.add(built.group);
      trees.push(built.tree);
    }
  }
  // Scenery trees on the hills, no fruit.
  for (let i = 0; i < 70; i++) {
    const a = rng() * Math.PI * 2;
    const r = randRange(rng, FENCE_RADIUS + 4, WORLD_SIZE * 0.47);
    const p = { x: Math.cos(a) * r, z: Math.sin(a) * r };
    if (Math.abs(Math.atan2(Math.sin(a - GATE_ANGLE), Math.cos(a - GATE_ANGLE))) < 0.12 && r < FENCE_RADIUS + 14) continue;
    group.add(buildTree(rng() < 0.3 ? 'bush' : rng() < 0.6 ? 'apple' : 'tall', p, rng, false).group);
  }

  const flowerSpots = Array.from({ length: 11 }, () => spaced(4));
  const flowers = buildFlowers(rng, flowerSpots);
  group.add(...flowers.meshes);

  const m = new THREE.Matrix4();
  const tmp = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const windowMat = cottage.userData.windowMat as THREE.MeshLambertMaterial;

  const burrows: Burrow[] = [];
  const holeMat = lambert(0x3b2a20);
  const dirtMat = lambert(0x7a4e32);
  const addBurrow = (x: number, z: number, time: number) => {
    if (burrows.some((b) => Math.hypot(b.x - x, b.z - z) < 1.2)) return;
    if (burrows.length >= MAX_BURROWS) {
      const old = burrows.shift()!;
      group.remove(old.mesh);
    }
    const mesh = new THREE.Group();
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.42, 14), holeMat);
    hole.rotation.x = -Math.PI / 2;
    hole.position.y = 0.04;
    const mound = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.13, 6, 14), dirtMat);
    mound.rotation.x = -Math.PI / 2;
    mound.scale.z = 0.6;
    mound.castShadow = true;
    mesh.add(hole, mound);
    mesh.position.set(x, terrainHeight(x, z), z);
    mesh.scale.setScalar(0.01);
    group.add(mesh);
    burrows.push({ x, z, mesh, until: time + BURROW_SECONDS });
  };

  const update = (time: number, dt: number) => {
    for (let i = burrows.length - 1; i >= 0; i--) {
      const b = burrows[i];
      const s = Math.min(1, (b.until - time) / 10);
      b.mesh.scale.setScalar(THREE.MathUtils.lerp(b.mesh.scale.x, Math.max(0, s), Math.min(1, dt * 3)));
      if (time > b.until) {
        group.remove(b.mesh);
        burrows.splice(i, 1);
      }
    }
    for (const tree of trees) {
      if (tree.shake > 0.001) {
        tree.shake = Math.max(0, tree.shake - dt * 0.7);
        tree.group.rotation.set(Math.sin(time * 23) * 0.05 * tree.shake, 0, Math.cos(time * 19) * 0.05 * tree.shake);
      }
      for (const fruit of tree.fruits) {
        if (!fruit.ripe && time >= fruit.regrowAt) fruit.ripe = true;
        const target = fruit.ripe ? 1 : 0;
        const s = THREE.MathUtils.lerp(fruit.mesh.scale.x, target, Math.min(1, dt * 2));
        fruit.mesh.scale.setScalar(s);
        fruit.mesh.visible = s > 0.02;
      }
    }
    let dirty = false;
    for (const patch of flowers.patches) {
      const before = patch.bloom;
      patch.bloom = Math.max(0.3, patch.bloom - dt * 0.006);
      if (Math.abs(before - patch.bloom) > 1e-5 || patch.bloom > 0.3) dirty = true;
    }
    if (dirty) {
      for (const patch of flowers.patches) {
        const s = 0.55 + patch.bloom * 1.1;
        patch.instances.forEach((idx, i) => {
          flowers.heads.getMatrixAt(idx, m);
          m.decompose(tmp, q, new THREE.Vector3());
          tmp.y = terrainHeight(tmp.x, tmp.z) + patch.baseScale[i] + Math.sin(time * 1.5 + idx) * 0.015;
          m.compose(tmp, q, new THREE.Vector3(s, s, s));
          flowers.heads.setMatrixAt(idx, m);
        });
      }
      flowers.heads.instanceMatrix.needsUpdate = true;
    }
    (water.material as THREE.MeshPhongMaterial).opacity = 0.75 + Math.sin(time * 0.8) * 0.03;
    windowMat.emissiveIntensity = 1;
  };

  return { group, trees, flowers: flowers.patches, burrows, water, update, addBurrow };
}

export function pickFruit(fruit: Fruit, time: number) {
  fruit.ripe = false;
  fruit.regrowAt = time + FRUIT_REGROW_SECONDS;
}

/** Height of the lowest ripe fruit on a tree, or Infinity if bare. */
export function lowestRipeFruit(tree: Tree): Fruit | null {
  let best: Fruit | null = null;
  for (const f of tree.fruits) if (f.ripe && (!best || f.height < best.height)) best = f;
  return best;
}
