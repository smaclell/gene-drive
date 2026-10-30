import { clamp01, gaussian, pick, type Rng } from '../core/rng';
import { GENES, GENE_IDS, type GeneId } from '../genetics/genes';
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
  /** Skews founder alleles. A function rolls a fresh bias for each visitor. */
  bias: FounderBias | ((rng: Rng) => FounderBias);
}

const around = (centre: number, spread = 0.12) => (rng: Rng) => clamp01(centre + gaussian(rng) * spread);
const carrier = (highChance: number) => (rng: Rng) => (rng() < highChance ? 0.7 + rng() * 0.3 : rng() * 0.5);

/** Continuous body genes a Curio can push to an extreme. */
const BODY_GENES = GENE_IDS.filter((id) => GENES[id].expression === 'blend' && GENES[id].group !== 'temperament' && GENES[id].group !== 'colour');

/** A Curio is odd in its own way: a handful of random body genes pushed to one end or the other. */
function curioBias(rng: Rng): FounderBias {
  const bias: FounderBias = { twinHead: carrier(0.45), eyeStalks: around(0.8, 0.12), lumps: around(0.75, 0.15) };
  const pool = [...BODY_GENES];
  for (let i = 0; i < 7 && pool.length; i++) {
    const id = pool.splice(Math.floor(rng() * pool.length), 1)[0] as GeneId;
    bias[id] = around(rng() < 0.5 ? 0.04 : 0.96, 0.04);
  }
  return bias;
}

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
    bias: { tailLength: around(0.8), spikes: around(0.8), legLength: around(0.2), hue: around(0.47, 0.05), bodyLength: around(0.7), tailShape: around(0.84, 0.1), headShape: around(0.15), bodyShape: around(0.3), gait: around(0.2) },
  },
  {
    id: 'highland',
    title: 'Highland',
    flavour: 'came down from the hills',
    bias: { legLength: around(0.82), neckLength: around(0.8), girth: around(0.35), hue: around(0.09, 0.04), earType: around(0.7, 0.1), horns: around(0.77, 0.06), fluff: around(0.66, 0.05), gait: around(0.72), size: around(0.7) },
  },
  {
    id: 'burrow',
    title: 'Burrow',
    flavour: 'popped up out of the ground',
    bias: { footSize: around(0.85), snout: around(0.8), legLength: around(0.18), legGirth: around(0.8), girth: around(0.75), hue: around(0.06, 0.03), lightness: around(0.35), mouth: around(0.88, 0.06), tailShape: around(0.79, 0.05), size: around(0.4) },
  },
  {
    id: 'sky',
    title: 'Sky',
    flavour: 'drifted in on the breeze',
    bias: { wings: carrier(0.75), girth: around(0.2), bodyLength: around(0.25), hue: around(0.58, 0.05), lightness: around(0.7), size: around(0.15), mouth: around(0.58, 0.05), fluff: around(0.88, 0.06), gait: around(0.85) },
  },
  {
    id: 'glimmer',
    title: 'Glimmer',
    flavour: 'twinkles faintly in the shade',
    bias: { glow: carrier(0.75), lightness: around(0.3), saturation: around(0.75), hue: around(0.76, 0.06), pattern: around(0.5, 0.1), eyeCount: around(0.8, 0.1), finish: around(0.8, 0.08) },
  },
  {
    id: 'reef',
    title: 'Reef',
    flavour: 'smells faintly of the sea',
    bias: { legPairs: around(0.05, 0.05), legStyle: around(0.88, 0.07), finish: around(0.9, 0.06), tailShape: around(0.92, 0.05), hue: around(0.93, 0.04), saturation: around(0.7), headShape: around(0.3), voice: around(0.8) },
  },
  {
    id: 'grove',
    title: 'Grove',
    flavour: 'stepped quietly out of the woods',
    bias: { horns: around(0.92, 0.05), legLength: around(0.72), neckLength: around(0.55), hue: around(0.08, 0.03), saturation: around(0.4), pattern: around(0.3, 0.05), patternScale: around(0.7), fluff: around(0.52, 0.04), headShape: around(0.8), gait: around(0.7), size: around(0.65) },
  },
  {
    id: 'dune',
    title: 'Dune',
    flavour: 'trundled in from the dunes',
    bias: { shell: carrier(0.8), legStyle: around(0.74, 0.05), legPairs: around(0.84, 0.05), bodyShape: around(0.15), legLength: around(0.25), hue: around(0.12, 0.03), lightness: around(0.6), gait: around(0.8), quirk: around(0.75, 0.05) },
  },
  {
    id: 'curio',
    title: 'Curio',
    flavour: 'looks like it wandered out of a dream',
    bias: curioBias,
  },
];

export const pickTheme = (rng: Rng) => pick(rng, VISITOR_THEMES);

export const themeBias = (theme: VisitorTheme, rng: Rng): FounderBias => (typeof theme.bias === 'function' ? theme.bias(rng) : theme.bias);
