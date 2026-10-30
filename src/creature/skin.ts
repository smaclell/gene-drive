import * as THREE from 'three';
import type { V3 } from '../genetics/anatomy';

/**
 * Metaball skin, after the Spore creature creator: the torso, neck, head, tail and
 * limbs are blobs (tapered capsules and ellipsoids) that melt into each other through
 * a smooth union of their distance fields. The field is sampled on a grid and meshed
 * with surface nets, so the whole body is one smooth surface with no visible joints.
 *
 * Every vertex also gets:
 * - bone weights, from how close it is to each blob, so one `SkinnedMesh` bends at
 *   every joint (see `build.ts`);
 * - paint coordinates (which part it is on, how far along it, and which way it
 *   faces around it), so patterns can follow the body like Spore's coat and detail paint;
 * - ambient occlusion, read off the same distance field: creases, armpits and the
 *   joins between parts get a little darker, so the body reads as one soft solid.
 *
 * Everything is in creature space (metres), in the rest pose.
 */

export const SKIN_REGIONS = ['torso', 'neck', 'head', 'snout', 'tail', 'leg', 'foot', 'arm', 'hand'] as const;
export type SkinRegion = (typeof SKIN_REGIONS)[number];

export interface SkinBlob {
  region: SkinRegion;
  /** A tapered capsule from `a` (radius `ra`) to `b` (radius `rb`), or an ellipsoid centred on `a` when `radii` is set. */
  a: V3;
  b: V3;
  ra: number;
  rb: number;
  /** Ellipsoid radii along its local axes, and the rotation from local to creature space. */
  radii?: V3;
  rotation?: THREE.Quaternion;
  /** Which way is "up" (the back) around this part. Also stretches the capsule cross-section. */
  up?: V3;
  stretchUp?: number;
  stretchSide?: number;
  /** Bones along the part: u = 0 rides on the first, u = 1 on the last. */
  chain: number[];
  /** Part coordinate (0 … 1) at `a` and at `b`. */
  u0: number;
  u1: number;
  /** Length of the whole part in metres, so painted stripes keep real spacing. */
  length: number;
  /** How softly it melts into what is already there, in metres. */
  blend: number;
}

export interface SkinMesh {
  /** Has position, normal, skinIndex, skinWeight and an index. Paint adds colour, glow and sheen. */
  geometry: THREE.BufferGeometry;
  /** Per vertex: index into `SKIN_REGIONS`. */
  region: Uint8Array;
  /** Per vertex: how far along its part, 0 … 1. */
  u: Float32Array;
  /** Per vertex: distance along its part in metres. */
  along: Float32Array;
  /** Per vertex: angle around its part, 0 on top (the back), ±π underneath. */
  around: Float32Array;
  /** The same for the next-nearest part, and how much of it to mix in (0 … 0.5), so paint fades across joins. */
  second: { region: Uint8Array; u: Float32Array; along: Float32Array; around: Float32Array; mix: Float32Array };
  /** Per vertex: how open the surface is, 1 in the open … about 0.4 deep in a crease. */
  ao: Float32Array;
}

/** A blob with everything precomputed for fast distance queries. */
interface Compiled {
  blob: SkinBlob;
  region: number;
  ellipsoid: boolean;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  invLen2: number;
  ux: number; uy: number; uz: number;
  su: number; ss: number;
  /** Inverse rotation (creature → local) as a row-major 3×3, for ellipsoids. */
  m: number[];
  rx: number; ry: number; rz: number;
  min: [number, number, number];
  max: [number, number, number];
}

const FAR = 1e3;

/** Ambient occlusion probes: distance along the normal in grid cells, and weight. */
const AO_STEPS: [number, number][] = [[1, 0.35], [2, 0.35], [3.5, 0.3]];

function compile(blob: SkinBlob, region: number, pad: number): Compiled {
  const { a, b } = blob;
  const ellipsoid = !!blob.radii;
  let ux = 0;
  let uy = 1;
  let uz = 0;
  if (blob.up) {
    const n = Math.hypot(blob.up.x, blob.up.y, blob.up.z) || 1;
    ux = blob.up.x / n;
    uy = blob.up.y / n;
    uz = blob.up.z / n;
  }
  const c: Compiled = {
    blob, region, ellipsoid, ax: a.x, ay: a.y, az: a.z, bx: b.x - a.x, by: b.y - a.y, bz: b.z - a.z, invLen2: 0,
    ux, uy, uz, su: blob.stretchUp ?? 1, ss: blob.stretchSide ?? 1, m: [1, 0, 0, 0, 1, 0, 0, 0, 1], rx: 1, ry: 1, rz: 1,
    min: [0, 0, 0], max: [0, 0, 0],
  };
  const len2 = c.bx * c.bx + c.by * c.by + c.bz * c.bz;
  c.invLen2 = len2 > 1e-12 ? 1 / len2 : 0;
  let extent: number;
  if (ellipsoid) {
    const r = blob.radii!;
    c.rx = r.x;
    c.ry = r.y;
    c.rz = r.z;
    const inv = new THREE.Matrix4().makeRotationFromQuaternion(blob.rotation ?? new THREE.Quaternion()).transpose().elements;
    // Matrix4 elements are column-major; after the transpose, read them as rows of the inverse.
    c.m = [inv[0], inv[4], inv[8], inv[1], inv[5], inv[9], inv[2], inv[6], inv[10]];
    extent = Math.max(r.x, r.y, r.z);
    c.bx = c.by = c.bz = 0;
  } else {
    extent = Math.max(blob.ra, blob.rb) * Math.max(c.su, c.ss);
  }
  const e = extent + pad;
  c.min = [Math.min(a.x, a.x + c.bx) - e, Math.min(a.y, a.y + c.by) - e, Math.min(a.z, a.z + c.bz) - e];
  c.max = [Math.max(a.x, a.x + c.bx) + e, Math.max(a.y, a.y + c.by) + e, Math.max(a.z, a.z + c.bz) + e];
  return c;
}

/** Result slots for `probe`, reused to avoid allocations in hot loops. */
const hit = { d: 0, h: 0, around: 0 };

/** Signed distance from a point to one blob; also fills `hit` with the part coordinate and angle. */
function probe(c: Compiled, x: number, y: number, z: number, detail: boolean): number {
  const dx = x - c.ax;
  const dy = y - c.ay;
  const dz = z - c.az;
  if (c.ellipsoid) {
    const m = c.m;
    const lx = (m[0] * dx + m[1] * dy + m[2] * dz) / c.rx;
    const ly = (m[3] * dx + m[4] * dy + m[5] * dz) / c.ry;
    const lz = (m[6] * dx + m[7] * dy + m[8] * dz) / c.rz;
    const k0 = Math.sqrt(lx * lx + ly * ly + lz * lz);
    const ex = lx / c.rx;
    const ey = ly / c.ry;
    const ez = lz / c.rz;
    const k1 = Math.sqrt(ex * ex + ey * ey + ez * ez);
    const d = k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(c.rx, c.ry, c.rz);
    if (detail) {
      hit.h = Math.min(1, Math.max(0, 0.5 + lx * 0.5));
      hit.around = Math.atan2(lz, ly);
    }
    return d;
  }
  const h = Math.min(1, Math.max(0, (dx * c.bx + dy * c.by + dz * c.bz) * c.invLen2));
  const qx = dx - c.bx * h;
  const qy = dy - c.by * h;
  const qz = dz - c.bz * h;
  const r = c.blob.ra + (c.blob.rb - c.blob.ra) * h;
  const cu = qx * c.ux + qy * c.uy + qz * c.uz;
  let d: number;
  if (c.su === 1 && c.ss === 1) {
    d = Math.sqrt(qx * qx + qy * qy + qz * qz) - r;
  } else {
    const sx = qx - c.ux * cu;
    const sy = qy - c.uy * cu;
    const sz = qz - c.uz * cu;
    const a = cu / c.su;
    const b2 = (sx * sx + sy * sy + sz * sz) / (c.ss * c.ss);
    d = (Math.sqrt(a * a + b2) - r) * (c.su < c.ss ? c.su : c.ss);
  }
  if (detail) {
    hit.h = h;
    // "Side" is up × the part's direction, so the angle is 0 on the back and ±π underneath.
    const sx = c.uy * c.bz - c.uz * c.by;
    const sy = c.uz * c.bx - c.ux * c.bz;
    const sz = c.ux * c.by - c.uy * c.bx;
    const sn = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
    hit.around = Math.atan2((qx * sx + qy * sy + qz * sz) / sn, cu);
  }
  return d;
}

/** Polynomial smooth minimum: melts two distances together within `k` metres. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * The skin's distance field read straight off the blobs, before meshing (negative inside).
 * Lets rigblocks such as the mouth sit on the surface the blobs are going to make.
 */
export function skinField(blobs: SkinBlob[]): (x: number, y: number, z: number) => number {
  const compiled = blobs.map((b) => compile(b, SKIN_REGIONS.indexOf(b.region), b.blend));
  return (x, y, z) => {
    let f = FAR;
    for (const c of compiled) {
      if (x < c.min[0] || y < c.min[1] || z < c.min[2] || x > c.max[0] || y > c.max[1] || z > c.max[2]) continue;
      const d = probe(c, x, y, z, false);
      const k = c.blob.blend;
      f = f >= FAR ? d : k > 1e-6 ? smin(f, d, k) : Math.min(f, d);
    }
    return f;
  };
}

/**
 * Mesh a set of blobs. `cell` is the grid spacing in metres: smaller is smoother and slower.
 * Blobs thinner than about a cell are thickened so they never vanish.
 */
export function buildSkin(blobs: SkinBlob[], cell: number): SkinMesh {
  const h = cell;
  const minR = h * 0.85;
  const thick = blobs.map((b) => (b.radii ? b : { ...b, ra: Math.max(b.ra, minR), rb: Math.max(b.rb, minR) }));
  const compiled = thick.map((b) => compile(b, SKIN_REGIONS.indexOf(b.region), b.blend + h * 3));

  // Grid over everything, with a margin so gradients near the surface are always defined.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const c of compiled) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], c.min[a]);
      hi[a] = Math.max(hi[a], c.max[a]);
    }
  }
  const [ox, oy, oz] = [lo[0] - h, lo[1] - h, lo[2] - h];
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 3;
  const ny = Math.ceil((hi[1] - lo[1]) / h) + 3;
  const nz = Math.ceil((hi[2] - lo[2]) / h) + 3;
  const field = new Float32Array(nx * ny * nz).fill(FAR);
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);

  // Points already deep inside the body cannot change sign, so later blobs skip them.
  const deep = -3 * h;
  for (const c of compiled) {
    const k = c.blob.blend;
    const i0 = Math.max(0, Math.floor((c.min[0] - ox) / h));
    const i1 = Math.min(nx - 1, Math.ceil((c.max[0] - ox) / h));
    const j0 = Math.max(0, Math.floor((c.min[1] - oy) / h));
    const j1 = Math.min(ny - 1, Math.ceil((c.max[1] - oy) / h));
    const k0 = Math.max(0, Math.floor((c.min[2] - oz) / h));
    const k1 = Math.min(nz - 1, Math.ceil((c.max[2] - oz) / h));
    for (let kk = k0; kk <= k1; kk++) {
      const z = oz + kk * h;
      for (let j = j0; j <= j1; j++) {
        const y = oy + j * h;
        let idx = at(i0, j, kk);
        for (let i = i0; i <= i1; i++, idx++) {
          const f = field[idx];
          if (f < deep) continue;
          const d = probe(c, ox + i * h, y, z, false);
          field[idx] = f >= FAR ? d : k > 1e-6 ? smin(f, d, k) : Math.min(f, d);
        }
      }
    }
  }

  // Surface nets: one vertex per cell the surface passes through, at the mean of its edge crossings.
  const cx = nx - 1;
  const cy = ny - 1;
  const cellAt = (i: number, j: number, k: number) => i + cx * (j + cy * k);
  const cellVert = new Int32Array(cx * cy * (nz - 1)).fill(-1);
  const pos: number[] = [];
  const corner = new Float32Array(8);
  const EDGES: [number, number][] = [];
  for (let c = 0; c < 8; c++) for (const bit of [1, 2, 4]) if (!(c & bit)) EDGES.push([c, c | bit]);
  const offsets = [0, 1, nx, nx + 1, nx * ny, nx * ny + 1, nx * ny + nx, nx * ny + nx + 1];
  const skip = 2.5 * h;
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      let base = at(0, j, k);
      for (let i = 0; i < nx - 1; i++, base++) {
        // A corner further than a cell's diagonal from the surface means nothing crosses this cell.
        const f0 = field[base];
        if (f0 > skip || f0 < -skip) continue;
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = field[base + offsets[c]];
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a];
          const vb = corner[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += (a & 1) + ((b & 1) - (a & 1)) * t;
          sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
          sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
          n++;
        }
        cellVert[cellAt(i, j, k)] = pos.length / 3;
        pos.push(ox + (i + sx / n) * h, oy + (j + sy / n) * h, oz + (k + sz / n) * h);
      }
    }
  }

  // One quad per grid edge the surface crosses, joining the four cells around it.
  const index: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) index.push(a, c, b, a, d, c);
    else index.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const inside = field[at(i, j, k)] < 0;
        if (inside !== field[at(i + 1, j, k)] < 0) {
          quad(cellVert[cellAt(i, j - 1, k - 1)], cellVert[cellAt(i, j, k - 1)], cellVert[cellAt(i, j, k)], cellVert[cellAt(i, j - 1, k)], !inside);
        }
        if (inside !== field[at(i, j + 1, k)] < 0) {
          quad(cellVert[cellAt(i - 1, j, k - 1)], cellVert[cellAt(i - 1, j, k)], cellVert[cellAt(i, j, k)], cellVert[cellAt(i, j, k - 1)], !inside);
        }
        if (inside !== field[at(i, j, k + 1)] < 0) {
          quad(cellVert[cellAt(i - 1, j - 1, k)], cellVert[cellAt(i, j - 1, k)], cellVert[cellAt(i, j, k)], cellVert[cellAt(i - 1, j, k)], !inside);
        }
      }
    }
  }

  // Field value and gradient anywhere, by trilinear interpolation of the grid.
  const g = [0, 0, 0];
  const sample = (px: number, py: number, pz: number): number => {
    const fx = Math.min(nx - 3, Math.max(1, (px - ox) / h));
    const fy = Math.min(ny - 3, Math.max(1, (py - oy) / h));
    const fz = Math.min(nz - 3, Math.max(1, (pz - oz) / h));
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const k = Math.floor(fz);
    const tx = fx - i;
    const ty = fy - j;
    const tz = fz - k;
    let value = 0;
    g[0] = g[1] = g[2] = 0;
    for (let c = 0; c < 8; c++) {
      const di = c & 1;
      const dj = (c >> 1) & 1;
      const dk = (c >> 2) & 1;
      const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
      const ii = i + di;
      const jj = j + dj;
      const kk = k + dk;
      value += w * field[at(ii, jj, kk)];
      g[0] += w * (field[at(ii + 1, jj, kk)] - field[at(ii - 1, jj, kk)]);
      g[1] += w * (field[at(ii, jj + 1, kk)] - field[at(ii, jj - 1, kk)]);
      g[2] += w * (field[at(ii, jj, kk + 1)] - field[at(ii, jj, kk - 1)]);
    }
    return value;
  };

  const count = pos.length / 3;
  const normals = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    let px = pos[v * 3];
    let py = pos[v * 3 + 1];
    let pz = pos[v * 3 + 2];
    // Pull the vertex onto the surface, then take the field's gradient as a smooth normal.
    for (let step = 0; step < 2; step++) {
      const f = sample(px, py, pz);
      const len2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
      if (len2 < 1e-12) break;
      const s = Math.max(-0.5 * h, Math.min(0.5 * h, f / Math.sqrt(len2) * 2 * h)) / Math.sqrt(len2);
      px -= g[0] * s;
      py -= g[1] * s;
      pz -= g[2] * s;
    }
    sample(px, py, pz);
    const n = Math.hypot(g[0], g[1], g[2]) || 1;
    pos[v * 3] = px;
    pos[v * 3 + 1] = py;
    pos[v * 3 + 2] = pz;
    normals.set([g[0] / n, g[1] / n, g[2] / n], v * 3);
  }

  // Ambient occlusion: step out along the normal; wherever the field says another part is
  // closer than the distance travelled, something is crowding this spot.
  const ao = new Float32Array(count);
  for (let v = 0; v < count; v++) {
    let occluded = 0;
    for (const [steps, weight] of AO_STEPS) {
      const d = steps * h;
      const f = sample(pos[v * 3] + normals[v * 3] * d, pos[v * 3 + 1] + normals[v * 3 + 1] * d, pos[v * 3 + 2] + normals[v * 3 + 2] * d);
      occluded += weight * Math.max(0, d - f) / d;
    }
    ao[v] = 1 - Math.min(0.6, occluded * 0.9);
  }

  // Bone weights and paint coordinates from the blobs near each vertex.
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const region = new Uint8Array(count);
  const u = new Float32Array(count);
  const along = new Float32Array(count);
  const around = new Float32Array(count);
  const second = { region: new Uint8Array(count), u: new Float32Array(count), along: new Float32Array(count), around: new Float32Array(count), mix: new Float32Array(count) };
  const near: { c: Compiled; d: number; h: number; around: number }[] = [];
  const pool = compiled.map(() => ({ c: compiled[0], d: 0, h: 0, around: 0 }));
  const boneIds: number[] = [];
  const boneWs: number[] = [];
  const addWeight = (bone: number, w: number) => {
    const i = boneIds.indexOf(bone);
    if (i >= 0) boneWs[i] += w;
    else {
      boneIds.push(bone);
      boneWs.push(w);
    }
  };
  for (let v = 0; v < count; v++) {
    const px = pos[v * 3];
    const py = pos[v * 3 + 1];
    const pz = pos[v * 3 + 2];
    near.length = 0;
    let best = Infinity;
    for (const c of compiled) {
      if (px < c.min[0] || py < c.min[1] || pz < c.min[2] || px > c.max[0] || py > c.max[1] || pz > c.max[2]) continue;
      const d = probe(c, px, py, pz, false);
      const slot = pool[near.length];
      slot.c = c;
      slot.d = d;
      near.push(slot);
      if (d < best) best = d;
    }
    // Only blobs close to the nearest one matter; find where on them this vertex sits.
    let kept = 0;
    for (const n of near) {
      if (n.d - best > Math.max(n.c.blob.blend, h) * 1.2 && n.d !== best) continue;
      probe(n.c, px, py, pz, true);
      n.h = hit.h;
      n.around = hit.around;
      near[kept++] = n;
    }
    near.length = kept;
    boneIds.length = 0;
    boneWs.length = 0;
    let owner = near[0];
    let next: (typeof near)[number] | null = null;
    for (const n of near) if (n.d === best) owner = n;
    for (const n of near) if (n !== owner && n.c.region !== owner.c.region && (!next || n.d < next.d)) next = n;
    for (const n of near) {
      const width = Math.max(n.c.blob.blend, h) * 1.2;
      const t = 1 - (n.d - best) / width;
      if (t <= 0) continue;
      const w = t * t;
      const { chain, u0, u1 } = n.c.blob;
      const f = (u0 + (u1 - u0) * n.h) * (chain.length - 1);
      const i0 = Math.min(chain.length - 1, Math.floor(f));
      const i1 = Math.min(chain.length - 1, i0 + 1);
      const frac = f - i0;
      addWeight(chain[i0], w * (1 - frac));
      if (frac > 0) addWeight(chain[i1], w * frac);
    }
    // Keep the four strongest bones.
    let total = 0;
    for (let slot = 0; slot < 4 && boneIds.length; slot++) {
      let bi = 0;
      for (let i = 1; i < boneWs.length; i++) if (boneWs[i] > boneWs[bi]) bi = i;
      skinIndex[v * 4 + slot] = boneIds[bi];
      skinWeight[v * 4 + slot] = boneWs[bi];
      total += boneWs[bi];
      boneIds.splice(bi, 1);
      boneWs.splice(bi, 1);
    }
    if (total > 0) for (let slot = 0; slot < 4; slot++) skinWeight[v * 4 + slot] /= total;
    else skinWeight[v * 4] = 1;
    if (owner) {
      const b = owner.c.blob;
      region[v] = owner.c.region;
      u[v] = b.u0 + (b.u1 - b.u0) * owner.h;
      along[v] = u[v] * b.length;
      around[v] = owner.around;
    }
    if (next) {
      const b = next.c.blob;
      const width = Math.max(b.blend, owner.c.blob.blend, h);
      second.mix[v] = 0.5 * Math.max(0, 1 - (next.d - best) / width);
      second.region[v] = next.c.region;
      second.u[v] = b.u0 + (b.u1 - b.u0) * next.h;
      second.along[v] = second.u[v] * b.length;
      second.around[v] = next.around;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geometry.setIndex(index);
  return { geometry, region, u, along, around, second, ao };
}
