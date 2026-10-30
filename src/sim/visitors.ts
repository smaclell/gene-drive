import { clamp01, gaussian, pick, type Rng } from '../core/rng';
import type { FounderBias } from '../genetics/genome';

/**
 * Wild visitor gene pools. Each theme skews a few genes so visitors bring
 * fresh variety into the herd, often including hidden recessive alleles.
 */

export interface VisitorTheme {
  id: string;
  title: string;
  /** Shown when the visitor arrives: "A wild Marsh Pupo wandered in…". */
  flavour: string;
  bias: FounderBias;
}

const around = (centre: number, spread = 0.12) => (rng: Rng) => clamp01(centre + gaussian(rng) * spread);
const carrier = (highChance: number) => (rng: Rng) => (rng() < highChance ? 0.7 + rng() * 0.3 : rng() * 0.5);

export const VISITOR_THEMES: VisitorTheme[] = [
  {
    id: 'meadow',
    title: 'Meadow',
    flavour: 'smells of clover',
    bias: {},
  },
  {
    id: 'marsh',
    title: 'Marsh',
    flavour: 'is still dripping from the river',
    bias: { tailLength: around(0.8), spikes: around(0.75), legLength: around(0.2), hue: around(0.47, 0.05), bodyLength: around(0.7) },
  },
  {
    id: 'highland',
    title: 'Highland',
    flavour: 'came down from the hills',
    bias: { legLength: around(0.82), neckLength: around(0.8), girth: around(0.35), hue: around(0.09, 0.04), earType: around(0.7, 0.1) },
  },
  {
    id: 'burrow',
    title: 'Burrow',
    flavour: 'popped up out of the ground',
    bias: { footSize: around(0.85), snout: around(0.8), legLength: around(0.18), legGirth: around(0.8), girth: around(0.75), hue: around(0.06, 0.03), lightness: around(0.35) },
  },
  {
    id: 'sky',
    title: 'Sky',
    flavour: 'drifted in on the breeze',
    bias: { wings: carrier(0.75), girth: around(0.2), bodyLength: around(0.25), hue: around(0.58, 0.05), lightness: around(0.7) },
  },
  {
    id: 'glimmer',
    title: 'Glimmer',
    flavour: 'twinkles faintly in the shade',
    bias: { glow: carrier(0.75), lightness: around(0.3), saturation: around(0.75), hue: around(0.76, 0.06), pattern: around(0.5, 0.1), eyeCount: around(0.8, 0.1) },
  },
];

export const pickTheme = (rng: Rng) => pick(rng, VISITOR_THEMES);
