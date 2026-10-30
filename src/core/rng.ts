/** Seeded randomness and small math helpers shared across the game. */

export type Rng = () => number;

/** Fast deterministic PRNG. Same seed, same sequence. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash, used to derive seeds from ids and names. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const randRange = (rng: Rng, min: number, max: number) => min + (max - min) * rng();

export const randInt = (rng: Rng, min: number, maxInclusive: number) =>
  Math.floor(randRange(rng, min, maxInclusive + 1));

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length];
}

export function weightedPick<T>(rng: Rng, items: readonly { item: T; weight: number }[]): T | null {
  const total = items.reduce((sum, i) => sum + Math.max(0, i.weight), 0);
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const { item, weight } of items) {
    roll -= Math.max(0, weight);
    if (roll <= 0) return item;
  }
  return items[items.length - 1].item;
}

/** Standard normal sample (Box–Muller). */
export function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
export const clamp01 = (v: number) => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Wrap a value into [0, 1). */
export const wrap01 = (v: number) => v - Math.floor(v);

/** Short unique id. Uses Math.random because ids need not be reproducible. */
export function makeId(prefix = 'c'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
