import { fbm2 } from '../core/noise';
import { lerp, smoothstep, type Rng } from '../core/rng';

/**
 * Where things are on the ranch, plus the terrain height function.
 * Terrain is analytic (no lookup tables), so creatures can query any point.
 */

export const WORLD_SIZE = 150;
/** Creatures stay inside this radius; the fence sits just outside it. */
export const RANCH_RADIUS = 34;
export const FENCE_RADIUS = RANCH_RADIUS + 1.5;
/** Angle (radians) of the fence gate, where wild visitors arrive. */
export const GATE_ANGLE = 0;
export const WATER_LEVEL = -0.3;

export const POND = { x: 15, z: 10, r: 7.5 };
export const SOIL = { x: -14, z: 9, w: 10, d: 7 };
export const COTTAGE = { x: -5, z: -17, w: 6, d: 5 };

const TERRAIN_SEED = 7;

/** Meadow ground sits this far above the water so only the pond floods. */
const LAND_BASE = 0.8;

export function terrainHeight(x: number, z: number): number {
  const d = Math.hypot(x, z);
  const rolling = (fbm2(x * 0.035 + 3, z * 0.035 + 7, 4, TERRAIN_SEED) - 0.5) * 1.8;
  let h = LAND_BASE + rolling * (0.35 + 0.65 * smoothstep(6, 30, d));

  // Hills ring the ranch and close off the horizon.
  const hills = fbm2(x * 0.02, z * 0.02, 3, TERRAIN_SEED + 5);
  h += smoothstep(FENCE_RADIUS + 3, WORLD_SIZE * 0.5, d) * (6 + hills * 10);

  // The pond is a smooth bowl.
  const pd = Math.hypot(x - POND.x, z - POND.z) / POND.r;
  h = lerp(h, -1.6, smoothstep(1.3, 0.55, pd));

  // Flat pads for the soil patch and the cottage.
  const sk = rectMask(x, z, SOIL.x, SOIL.z, SOIL.w, SOIL.d, 1.5);
  h = lerp(h, LAND_BASE + 0.06 * Math.sin((z - SOIL.z) * 3.6), sk);
  const ck = rectMask(x, z, COTTAGE.x, COTTAGE.z, COTTAGE.w + 3, COTTAGE.d + 3, 2);
  h = lerp(h, LAND_BASE + 0.05, ck);
  return h;
}

/** 1 inside the rectangle, fading to 0 over `feather` units outside it. */
function rectMask(x: number, z: number, cx: number, cz: number, w: number, d: number, feather: number): number {
  const dx = Math.abs(x - cx) - w / 2;
  const dz = Math.abs(z - cz) - d / 2;
  return smoothstep(feather, 0, Math.max(dx, dz));
}

/** Distance from the pond centre in pond radii. */
export const pondDistance = (x: number, z: number) => Math.hypot(x - POND.x, z - POND.z) / POND.r;

export const isWater = (x: number, z: number) => pondDistance(x, z) < 1.4 && terrainHeight(x, z) < WATER_LEVEL;

export const inSoil = (x: number, z: number) => Math.abs(x - SOIL.x) < SOIL.w / 2 && Math.abs(z - SOIL.z) < SOIL.d / 2;

const inCottage = (x: number, z: number, pad = 1.5) =>
  Math.abs(x - COTTAGE.x) < COTTAGE.w / 2 + pad && Math.abs(z - COTTAGE.z) < COTTAGE.d / 2 + pad;

export interface Point {
  x: number;
  z: number;
}

/** A walkable spot: inside the fence, not in the pond, not inside the cottage. */
export function randomLandPoint(rng: Rng, near?: Point, radius = 10, maxRadius = RANCH_RADIUS - 1.5): Point {
  for (let i = 0; i < 40; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * (near ? radius : maxRadius);
    const x = (near?.x ?? 0) + Math.cos(a) * r;
    const z = (near?.z ?? 0) + Math.sin(a) * r;
    if (Math.hypot(x, z) > maxRadius) continue;
    if (pondDistance(x, z) < 1.25) continue;
    if (inCottage(x, z)) continue;
    return { x, z };
  }
  return { x: 0, z: 0 };
}

export function randomPondPoint(rng: Rng): Point {
  for (let i = 0; i < 30; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * POND.r * 0.75;
    const p = { x: POND.x + Math.cos(a) * r, z: POND.z + Math.sin(a) * r };
    if (isWater(p.x, p.z)) return p;
  }
  return { x: POND.x, z: POND.z };
}

export function randomSoilPoint(rng: Rng): Point {
  return { x: SOIL.x + (rng() - 0.5) * SOIL.w * 0.85, z: SOIL.z + (rng() - 0.5) * SOIL.d * 0.85 };
}

export const gatePoint = (outside: number): Point => ({
  x: Math.cos(GATE_ANGLE) * (FENCE_RADIUS + outside),
  z: Math.sin(GATE_ANGLE) * (FENCE_RADIUS + outside),
});

/** Keep a point inside the fence (used to stop creatures wandering out). */
export function clampToRanch(p: Point, max = RANCH_RADIUS): Point {
  const d = Math.hypot(p.x, p.z);
  if (d <= max) return p;
  return { x: (p.x / d) * max, z: (p.z / d) * max };
}
