import { clamp01, gaussian, type Rng } from '../core/rng';

/**
 * Gene catalogue. Every creature trait traces back to one of these.
 *
 * Each gene holds two alleles in [0, 1]. `expression` decides how the pair
 * combines into the value the body actually uses (see `expressGene`).
 * Adding a gene: add it here, then read it in `phenotype.ts`.
 */

export type Expression = 'blend' | 'circular' | 'dominant' | 'recessive';

export type GeneGroup = 'body' | 'limbs' | 'head' | 'extras' | 'colour' | 'personality' | 'temperament';

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
  /** While still locked, the Lab slider stops here instead of being disabled (default: fully locked). */
  lockedMax?: number;
  /** Allele generator for brand-new founder creatures. Defaults to a bell curve around 0.5. */
  founder?: (rng: Rng) => number;
}

/** Most founder alleles sit low, but some carry a high, hidden copy. */
const hiddenCarrier = (carrierChance: number) => (rng: Rng) =>
  rng() < carrierChance ? 0.55 + rng() * 0.45 : rng() * 0.5;

const uniform = (rng: Rng) => rng();

/** Mostly low, with a tail of high values: for dominant style genes where fancy styles are rarer. */
const mostlyPlain = (centre: number, spread = 0.2) => (rng: Rng) => clamp01(centre + gaussian(rng) * spread);

export const GENES = {
  // Body
  size: { label: 'Size', group: 'body', expression: 'blend', low: 'a smaller build', high: 'a bigger build', designable: true },
  segments: { label: 'Segments', group: 'body', expression: 'blend', low: 'fewer segments', high: 'more segments', designable: true },
  lumps: { label: 'Lumpiness', group: 'body', expression: 'blend', low: 'a smoother body', high: 'a lumpier body', designable: true, founder: mostlyPlain(0.36, 0.26) },
  bodyLength: { label: 'Body length', group: 'body', expression: 'blend', low: 'a shorter body', high: 'a longer body', designable: true },
  girth: { label: 'Girth', group: 'body', expression: 'blend', low: 'a slimmer body', high: 'a chunkier body', designable: true },
  taper: { label: 'Build', group: 'body', expression: 'blend', low: 'a heavy rear', high: 'a heavy chest', designable: true },
  arch: { label: 'Back arch', group: 'body', expression: 'blend', low: 'a sway back', high: 'an arched back', designable: true },
  bodyShape: { label: 'Body shape', group: 'body', expression: 'blend', low: 'a flatter body', high: 'a taller body', designable: true },
  posture: { label: 'Posture', group: 'body', expression: 'blend', low: 'a lower stance', high: 'a more upright stance', designable: true },
  shell: { label: 'Shell', group: 'body', expression: 'recessive', low: 'a smaller shell', high: 'a bigger shell', designable: true, unlockedBy: 'shelled', founder: hiddenCarrier(0.2) },
  // Limbs
  legPairs: { label: 'Leg pairs', group: 'limbs', expression: 'blend', low: 'fewer legs', high: 'more legs', designable: true, founder: uniform },
  legLength: { label: 'Leg length', group: 'limbs', expression: 'blend', low: 'stubbier legs', high: 'longer legs', designable: true },
  legGirth: { label: 'Leg girth', group: 'limbs', expression: 'blend', low: 'skinnier legs', high: 'sturdier legs', designable: true },
  footSize: { label: 'Foot size', group: 'limbs', expression: 'blend', low: 'dainty feet', high: 'big paws', designable: true },
  legStyle: { label: 'Leg style', group: 'limbs', expression: 'dominant', low: 'plainer legs', high: 'stranger legs', designable: true, founder: mostlyPlain(0.3, 0.22) },
  arms: { label: 'Arms', group: 'limbs', expression: 'dominant', low: 'fewer arms', high: 'more arms', designable: true, unlockedBy: 'four-armed', lockedMax: 0.89, founder: mostlyPlain(0.36, 0.24) },
  armLength: { label: 'Arm length', group: 'limbs', expression: 'blend', low: 'shorter arms', high: 'longer arms', designable: true },
  hands: { label: 'Hands', group: 'limbs', expression: 'dominant', low: 'plainer hands', high: 'fancier hands', designable: true, unlockedBy: 'pincers', lockedMax: 0.74, founder: mostlyPlain(0.34, 0.24) },
  // Head
  neckLength: { label: 'Neck length', group: 'head', expression: 'blend', low: 'a shorter neck', high: 'a longer neck', designable: true, founder: uniform },
  headSize: { label: 'Head size', group: 'head', expression: 'blend', low: 'a smaller head', high: 'a bigger head', designable: true },
  headShape: { label: 'Head shape', group: 'head', expression: 'blend', low: 'a wider head', high: 'a longer head', designable: true },
  snout: { label: 'Snout', group: 'head', expression: 'blend', low: 'a flatter face', high: 'a longer snout', designable: true },
  mouth: { label: 'Mouth', group: 'head', expression: 'dominant', low: 'a plainer mouth', high: 'a fancier mouth', designable: true, founder: mostlyPlain(0.32, 0.22) },
  eyeCount: { label: 'Eyes', group: 'head', expression: 'dominant', low: 'fewer eyes', high: 'extra eyes', designable: true, founder: (rng) => clamp01(0.45 + gaussian(rng) * 0.18) },
  eyeSize: { label: 'Eye size', group: 'head', expression: 'blend', low: 'beady eyes', high: 'huge eyes', designable: true },
  eyeStalks: { label: 'Eye stalks', group: 'head', expression: 'blend', low: 'shorter eye stalks', high: 'longer eye stalks', designable: true, founder: mostlyPlain(0.34, 0.24) },
  twinHead: { label: 'Second head', group: 'head', expression: 'recessive', low: 'one head', high: 'two heads', designable: true, unlockedBy: 'two-headed', founder: hiddenCarrier(0.16) },
  earType: { label: 'Ear type', group: 'head', expression: 'dominant', low: 'plainer ears', high: 'fancier ears', designable: true, founder: (rng) => clamp01(0.35 + gaussian(rng) * 0.2) },
  earSize: { label: 'Ear size', group: 'head', expression: 'blend', low: 'smaller ears', high: 'bigger ears', designable: true },
  horns: { label: 'Horns', group: 'head', expression: 'dominant', low: 'humbler horns', high: 'grander horns', designable: true, founder: mostlyPlain(0.3, 0.22) },
  // Extras
  tailLength: { label: 'Tail length', group: 'extras', expression: 'blend', low: 'a shorter tail', high: 'a longer tail', designable: true },
  tailShape: { label: 'Tail shape', group: 'extras', expression: 'dominant', low: 'a plainer tail', high: 'a fancier tail', designable: true, founder: mostlyPlain(0.32, 0.24) },
  twinTail: { label: 'Twin tail', group: 'extras', expression: 'recessive', low: 'a single tail', high: 'twin tails', designable: true, unlockedBy: 'twin-tail', founder: hiddenCarrier(0.2) },
  tailTuft: { label: 'Tail tuft', group: 'extras', expression: 'dominant', low: 'a bare tail', high: 'a tufted tail', designable: true, founder: hiddenCarrier(0.5) },
  spikes: { label: 'Back fins', group: 'extras', expression: 'blend', low: 'a smoother back', high: 'bigger back fins', designable: true, founder: (rng) => clamp01(0.3 + gaussian(rng) * 0.22) },
  fluff: { label: 'Fluff', group: 'extras', expression: 'dominant', low: 'less fluff', high: 'more fluff', designable: true, founder: mostlyPlain(0.32, 0.24) },
  wings: { label: 'Wings', group: 'extras', expression: 'recessive', low: 'smaller wings', high: 'bigger wings', designable: true, unlockedBy: 'winged', founder: hiddenCarrier(0.3) },
  // Colour
  hue: { label: 'Hue', group: 'colour', expression: 'circular', low: 'a cooler hue', high: 'a warmer hue', designable: true, founder: uniform },
  saturation: { label: 'Saturation', group: 'colour', expression: 'blend', low: 'softer colours', high: 'bolder colours', designable: true },
  lightness: { label: 'Lightness', group: 'colour', expression: 'blend', low: 'darker colouring', high: 'paler colouring', designable: true },
  accentShift: { label: 'Accent colour', group: 'colour', expression: 'blend', low: 'a matching accent', high: 'a contrasting accent', designable: true, founder: uniform },
  pattern: { label: 'Pattern', group: 'colour', expression: 'dominant', low: 'plainer markings', high: 'bolder markings', designable: true, founder: (rng) => clamp01(0.35 + gaussian(rng) * 0.22) },
  patternScale: { label: 'Pattern scale', group: 'colour', expression: 'blend', low: 'larger markings', high: 'finer markings', designable: true },
  finish: { label: 'Skin finish', group: 'colour', expression: 'dominant', low: 'a simpler finish', high: 'a fancier finish', designable: true, unlockedBy: 'shimmer', lockedMax: 0.75, founder: mostlyPlain(0.28, 0.24) },
  glow: { label: 'Glow', group: 'colour', expression: 'recessive', low: 'a dimmer glow', high: 'a brighter glow', designable: true, unlockedBy: 'glow', founder: hiddenCarrier(0.22) },
  // Personality: how it moves, sounds and behaves. Designable, unlike temperament.
  gait: { label: 'Gait', group: 'personality', expression: 'blend', low: 'a steadier gait', high: 'a springier gait', designable: true, founder: uniform },
  voice: { label: 'Voice', group: 'personality', expression: 'blend', low: 'a lower voice', high: 'a higher voice', designable: true, founder: uniform },
  quirk: { label: 'Quirk', group: 'personality', expression: 'circular', low: 'a calmer habit', high: 'a sillier habit', designable: true, founder: uniform },
  favourite: { label: 'Favourite food', group: 'personality', expression: 'circular', low: 'different tastes', high: 'different tastes', designable: true, founder: uniform },
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
  personality: 'Personality',
  temperament: 'Temperament',
};

export function geneDef(id: GeneId): GeneDef {
  return GENES[id];
}

/** Value at which recessive traits (wings, glow, shell, twin tail) switch on. */
export const RECESSIVE_THRESHOLD: Partial<Record<GeneId, number>> = {
  wings: 0.6,
  glow: 0.65,
  shell: 0.62,
  twinTail: 0.62,
  twinHead: 0.64,
};
