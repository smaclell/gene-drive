import { clamp01, gaussian, type Rng } from '../core/rng';

/**
 * Gene catalogue. Every creature trait traces back to one of these.
 *
 * Each gene holds two alleles in [0, 1]. `expression` decides how the pair
 * combines into the value the body actually uses (see `expressGene`).
 * Adding a gene: add it here, then read it in `phenotype.ts`.
 */

export type Expression = 'blend' | 'circular' | 'dominant' | 'recessive';

export type GeneGroup = 'body' | 'limbs' | 'head' | 'extras' | 'colour' | 'temperament';

export interface GeneDef {
  label: string;
  group: GeneGroup;
  expression: Expression;
  /** Words for a low and high expressed value, used when describing mutations. */
  low: string;
  high: string;
  /** Whether the Lab exposes this gene as a slider. */
  designable: boolean;
  /** Journal discovery that unlocks the Lab slider, if gated. */
  unlockedBy?: string;
  /** Allele generator for brand-new founder creatures. Defaults to a bell curve around 0.5. */
  founder?: (rng: Rng) => number;
}

/** Most founder alleles sit low, but some carry a high, hidden copy. */
const hiddenCarrier = (carrierChance: number) => (rng: Rng) =>
  rng() < carrierChance ? 0.55 + rng() * 0.45 : rng() * 0.5;

const uniform = (rng: Rng) => rng();

export const GENES = {
  // Body
  segments: { label: 'Segments', group: 'body', expression: 'blend', low: 'fewer segments', high: 'more segments', designable: true },
  bodyLength: { label: 'Body length', group: 'body', expression: 'blend', low: 'a shorter body', high: 'a longer body', designable: true },
  girth: { label: 'Girth', group: 'body', expression: 'blend', low: 'a slimmer body', high: 'a chunkier body', designable: true },
  taper: { label: 'Build', group: 'body', expression: 'blend', low: 'a heavy rear', high: 'a heavy chest', designable: true },
  arch: { label: 'Back arch', group: 'body', expression: 'blend', low: 'a sway back', high: 'an arched back', designable: true },
  // Limbs
  legPairs: { label: 'Leg pairs', group: 'limbs', expression: 'blend', low: 'fewer legs', high: 'more legs', designable: true, founder: uniform },
  legLength: { label: 'Leg length', group: 'limbs', expression: 'blend', low: 'stubbier legs', high: 'longer legs', designable: true },
  legGirth: { label: 'Leg girth', group: 'limbs', expression: 'blend', low: 'skinnier legs', high: 'sturdier legs', designable: true },
  footSize: { label: 'Foot size', group: 'limbs', expression: 'blend', low: 'dainty feet', high: 'big paws', designable: true },
  // Head
  neckLength: { label: 'Neck length', group: 'head', expression: 'blend', low: 'a shorter neck', high: 'a longer neck', designable: true, founder: uniform },
  headSize: { label: 'Head size', group: 'head', expression: 'blend', low: 'a smaller head', high: 'a bigger head', designable: true },
  snout: { label: 'Snout', group: 'head', expression: 'blend', low: 'a flatter face', high: 'a longer snout', designable: true },
  eyeCount: { label: 'Eyes', group: 'head', expression: 'dominant', low: 'fewer eyes', high: 'extra eyes', designable: true, founder: (rng) => clamp01(0.45 + gaussian(rng) * 0.18) },
  eyeSize: { label: 'Eye size', group: 'head', expression: 'blend', low: 'beady eyes', high: 'huge eyes', designable: true },
  earType: { label: 'Ear type', group: 'head', expression: 'dominant', low: 'plainer ears', high: 'fancier ears', designable: true, founder: (rng) => clamp01(0.35 + gaussian(rng) * 0.2) },
  earSize: { label: 'Ear size', group: 'head', expression: 'blend', low: 'smaller ears', high: 'bigger ears', designable: true },
  // Extras
  tailLength: { label: 'Tail length', group: 'extras', expression: 'blend', low: 'a shorter tail', high: 'a longer tail', designable: true },
  tailTuft: { label: 'Tail tuft', group: 'extras', expression: 'dominant', low: 'a bare tail', high: 'a tufted tail', designable: true, founder: hiddenCarrier(0.5) },
  spikes: { label: 'Back fins', group: 'extras', expression: 'blend', low: 'a smoother back', high: 'bigger back fins', designable: true, founder: (rng) => clamp01(0.3 + gaussian(rng) * 0.22) },
  wings: { label: 'Wings', group: 'extras', expression: 'recessive', low: 'smaller wings', high: 'bigger wings', designable: true, unlockedBy: 'winged', founder: hiddenCarrier(0.3) },
  // Colour
  hue: { label: 'Hue', group: 'colour', expression: 'circular', low: 'a cooler hue', high: 'a warmer hue', designable: true, founder: uniform },
  saturation: { label: 'Saturation', group: 'colour', expression: 'blend', low: 'softer colours', high: 'bolder colours', designable: true },
  lightness: { label: 'Lightness', group: 'colour', expression: 'blend', low: 'darker colouring', high: 'paler colouring', designable: true },
  accentShift: { label: 'Accent colour', group: 'colour', expression: 'blend', low: 'a matching accent', high: 'a contrasting accent', designable: true, founder: uniform },
  pattern: { label: 'Pattern', group: 'colour', expression: 'dominant', low: 'plainer markings', high: 'bolder markings', designable: true, founder: (rng) => clamp01(0.35 + gaussian(rng) * 0.22) },
  patternScale: { label: 'Pattern scale', group: 'colour', expression: 'blend', low: 'larger markings', high: 'finer markings', designable: true },
  glow: { label: 'Glow', group: 'colour', expression: 'recessive', low: 'a dimmer glow', high: 'a brighter glow', designable: true, unlockedBy: 'glow', founder: hiddenCarrier(0.22) },
  // Temperament
  energy: { label: 'Energy', group: 'temperament', expression: 'blend', low: 'a sleepier nature', high: 'a livelier nature', designable: false },
  sociability: { label: 'Sociability', group: 'temperament', expression: 'blend', low: 'a loner streak', high: 'a love of company', designable: false },
  curiosity: { label: 'Curiosity', group: 'temperament', expression: 'blend', low: 'a homebody streak', high: 'a roaming streak', designable: false },
} satisfies Record<string, GeneDef>;

export type GeneId = keyof typeof GENES;

export const GENE_IDS = Object.keys(GENES) as GeneId[];

export const GROUP_LABELS: Record<GeneGroup, string> = {
  body: 'Body',
  limbs: 'Limbs',
  head: 'Head',
  extras: 'Extras',
  colour: 'Colour',
  temperament: 'Temperament',
};

export function geneDef(id: GeneId): GeneDef {
  return GENES[id];
}

/** Value at which recessive traits (wings, glow) switch on. */
export const RECESSIVE_THRESHOLD: Partial<Record<GeneId, number>> = {
  wings: 0.6,
  glow: 0.65,
};
