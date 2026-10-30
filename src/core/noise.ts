/** Smooth value noise. Good enough for terrain and creature patterns, and dependency free. */

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** 3D value noise in [0, 1]. */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const tx = fade(x - xi);
  const ty = fade(y - yi);
  const tz = fade(z - zi);
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  const x00 = mix(c(0, 0, 0), c(1, 0, 0), tx);
  const x10 = mix(c(0, 1, 0), c(1, 1, 0), tx);
  const x01 = mix(c(0, 0, 1), c(1, 0, 1), tx);
  const x11 = mix(c(0, 1, 1), c(1, 1, 1), tx);
  return mix(mix(x00, x10, ty), mix(x01, x11, ty), tz);
}

/** 2D value noise in [0, 1]. */
export const noise2 = (x: number, y: number, seed = 0) => noise3(x, y, 0.5, seed);

/** Fractal (octave-summed) 2D noise in [0, 1]. */
export function fbm2(x: number, y: number, octaves = 4, seed = 0): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq, seed + i * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/**
 * 2D cellular (Worley) noise: distances to the nearest and second-nearest
 * jittered grid point. `f2 - f1` is near 0 on cell borders (turtle-shell seams).
 */
export function cells2(x: number, y: number, seed = 0): { f1: number; f2: number } {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = Infinity;
  let f2 = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx + hash3(xi + dx, yi + dy, 1, seed);
      const cy = yi + dy + hash3(xi + dx, yi + dy, 2, seed);
      const d = Math.hypot(x - cx, y - cy);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return { f1, f2 };
}
