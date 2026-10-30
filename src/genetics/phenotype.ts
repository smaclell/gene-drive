import { lerp, wrap01 } from '../core/rng';
import { RECESSIVE_THRESHOLD } from './genes';
import { express, type Expressed, type Genome } from './genome';
import { expressSprout, type Sprout, type SproutGene } from './sprouts';

/**
 * The phenotype: expressed genes converted to real-world units and discrete
 * choices. Everything that draws or simulates a creature reads this, never the raw genome.
 *
 * Lengths here are in "shape units" for a creature of size 1. `size` scales the
 * whole body; `buildSkeleton` applies it, so the skeleton is in real metres.
 */

export type EarType = 'none' | 'round' | 'long' | 'frills' | 'antennae';
export type Pattern = 'plain' | 'spots' | 'stripes' | 'patches';
export type HeadShape = 'flat' | 'round' | 'long';
export type Mouth = 'plain' | 'beak' | 'jaws' | 'tusks';
export type Horns = 'none' | 'unicorn' | 'ram' | 'antlers';
export type Fluff = 'none' | 'tufts' | 'mane' | 'frill' | 'crest';
export type TailShape = 'plain' | 'whip' | 'curl' | 'club' | 'fan';
export type LegStyle = 'straight' | 'digitigrade' | 'splayed' | 'tentacles';
export type Finish = 'matte' | 'gradient' | 'eyespots' | 'iridescent' | 'jelly';
/** How a creature gets around. Picked by the gait gene from the gaits its body allows. */
export type Gait = 'walk' | 'hop' | 'waddle' | 'prance' | 'scuttle' | 'bound' | 'slither' | 'inch' | 'bounce' | 'creep';
/** Signature idle, shown when a creature is content. */
export type Quirk = 'stretch' | 'chase' | 'twirl' | 'dance' | 'roll' | 'sing';
export type Timbre = 'honk' | 'coo' | 'chirp' | 'trill';
export type Food = 'fruit' | 'roots' | 'nectar' | 'shells';

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export interface BodyPlan {
  /** Overall scale: 0.45 (tiny) … 2.1 (huge). Applied by the skeleton. */
  size: number;
  segments: number;
  /** How deeply the body pinches between segments: 0.05 smooth … 0.6 a string of beads. */
  lumps: number;
  bodyLength: number;
  girth: number;
  /** -1 heavy rear … +1 heavy chest. */
  taper: number;
  arch: number;
  /** Cross-section: side-to-side and top-to-bottom stretch of the torso. */
  bodyWidth: number;
  bodyTall: number;
  shell: boolean;
  legPairs: number;
  legLength: number;
  legGirth: number;
  footSize: number;
  legStyle: LegStyle;
  neckLength: number;
  headSize: number;
  /** -1 wide and flat (frog) … 0 round … +1 long (horse). */
  headStretch: number;
  headShape: HeadShape;
  snout: number;
  mouth: Mouth;
  eyeCount: number;
  /** Eye radius as a fraction of head radius. */
  eyeSize: number;
  /** Eye stalk length as a fraction of head radius; 0 means eyes sit on the head. */
  eyeStalks: number;
  twinHead: boolean;
  earType: EarType;
  earSize: number;
  horns: Horns;
  tailLength: number;
  tailShape: TailShape;
  twinTail: boolean;
  tailTuft: boolean;
  /** Back fin height multiplier; 0 means none. */
  spikes: number;
  fluff: Fluff;
  /** Wing span; 0 means no wings. */
  wingSpan: number;
  glow: boolean;
  colour: { body: Hsl; accent: Hsl; belly: Hsl };
  pattern: Pattern;
  patternScale: number;
  finish: Finish;
  gait: Gait;
  voice: { timbre: Timbre; /** Base pitch in Hz: big creatures rumble, tiny ones squeak. */ pitch: number };
  quirk: Quirk;
  favourite: Food;
  /** Composable extra parts from the variable-length sprout genes. */
  sprouts: Sprout[];
  energy: number;
  sociability: number;
  curiosity: number;
}

const EAR_TYPES: EarType[] = ['none', 'round', 'long', 'frills', 'antennae'];
const PATTERNS: Pattern[] = ['plain', 'spots', 'patches', 'stripes'];
const QUIRKS: Quirk[] = ['stretch', 'chase', 'twirl', 'dance', 'roll', 'sing'];
const TIMBRES: Timbre[] = ['honk', 'coo', 'chirp', 'trill'];
export const FOODS: Food[] = ['fruit', 'roots', 'nectar', 'shells'];

function quantize<T>(value: number, options: readonly T[]): T {
  return options[Math.min(options.length - 1, Math.floor(value * options.length))];
}

/** Like `quantize`, but with hand-placed cut points so plain styles stay common. */
function bucket<T>(value: number, cuts: readonly number[], options: readonly T[]): T {
  let i = 0;
  while (i < cuts.length && value >= cuts[i]) i++;
  return options[i];
}

/** Lerp from `a` through `b` (at 0.5) to `c`, so the middle of a gene is the everyday look. */
const through = (a: number, b: number, c: number, t: number) => (t < 0.5 ? lerp(a, b, t * 2) : lerp(b, c, t * 2 - 1));

function legPairsFrom(v: number): number {
  if (v < 0.1) return 0;
  if (v < 0.3) return 1;
  if (v < 0.72) return 2;
  if (v < 0.9) return 3;
  return 4;
}

function eyeCountFrom(v: number): number {
  if (v < 0.18) return 1;
  if (v < 0.72) return 2;
  if (v < 0.9) return 3;
  return 4;
}

/**
 * The gait gene is a preference from "steady" (0) to "springy" (1). Each body
 * allows a different set of gaits, so the same gene hops on a biped and
 * bounces on a blob.
 */
export function gaitFor(gene: number, legPairs: number, legStyle: LegStyle, bodyLength: number): Gait {
  let options: Gait[];
  if (legStyle === 'tentacles') options = legPairs === 0 ? ['creep'] : ['creep', 'creep', 'waddle', 'hop'];
  else if (legPairs === 0) options = bodyLength < 1.6 ? ['inch', 'bounce', 'bounce'] : ['inch', 'slither', 'slither', 'bounce'];
  else if (legPairs === 1) options = ['waddle', 'walk', 'prance', 'hop'];
  else if (legPairs === 2) options = legStyle === 'splayed' ? ['waddle', 'walk', 'scuttle', 'hop'] : ['waddle', 'walk', 'bound', 'prance', 'hop'];
  else options = ['walk', 'scuttle', 'scuttle'];
  // A blend of two uniform alleles piles up in the middle; undo that so every gait is equally likely.
  const even = gene < 0.5 ? 2 * gene * gene : 1 - 2 * (1 - gene) * (1 - gene);
  return quantize(even, options);
}

export function planFromExpressed(e: Expressed, sprouts: SproutGene[] = []): BodyPlan {
  const hue = e.hue;
  // Accent is usually a near neighbour on the colour wheel, occasionally a bolder contrast.
  const accentOffset = e.accentShift < 0.72 ? lerp(-0.08, 0.12, e.accentShift / 0.72) : lerp(0.26, 0.42, (e.accentShift - 0.72) / 0.28);
  const bodyS = lerp(0.22, 0.72, e.saturation);
  const bodyL = lerp(0.36, 0.74, e.lightness);
  const wingsOn = e.wings >= (RECESSIVE_THRESHOLD.wings ?? 0.6);
  const legPairs = legPairsFrom(e.legPairs);
  const legStyle = bucket(e.legStyle, [0.45, 0.66, 0.84], ['straight', 'digitigrade', 'splayed', 'tentacles'] as const);
  const bodyLength = through(0.8, 2, 4, e.bodyLength);
  const headStretch = lerp(-1, 1, e.headShape);
  // Geometric, so the middle of the gene is a size-1 creature.
  const size = 0.45 * Math.pow(2.1 / 0.45, e.size);

  return {
    size,
    segments: Math.round(lerp(2, 9, e.segments)),
    lumps: through(0.04, 0.14, 0.6, e.lumps),
    bodyLength,
    girth: through(0.2, 0.52, 1, e.girth),
    taper: lerp(-1, 1, e.taper),
    arch: through(-0.35, 0.15, 0.9, e.arch),
    bodyWidth: through(1.7, 0.95, 0.6, e.bodyShape),
    bodyTall: through(0.65, 1, 1.3, e.bodyShape),
    shell: e.shell >= (RECESSIVE_THRESHOLD.shell ?? 0.62),
    legPairs,
    legLength: through(0.18, 0.9, 2.5, e.legLength),
    legGirth: through(0.035, 0.12, 0.26, e.legGirth),
    footSize: through(0.5, 1.15, 2.2, e.footSize),
    legStyle,
    neckLength: lerp(0.05, 2.6, Math.pow(e.neckLength, 1.4)),
    headSize: through(0.18, 0.47, 0.95, e.headSize),
    headStretch,
    headShape: headStretch < -0.4 ? 'flat' : headStretch > 0.4 ? 'long' : 'round',
    snout: through(0, 0.33, 1.1, e.snout),
    mouth: bucket(e.mouth, [0.5, 0.66, 0.82], ['plain', 'beak', 'jaws', 'tusks'] as const),
    eyeCount: eyeCountFrom(e.eyeCount),
    eyeSize: through(0.08, 0.27, 0.55, e.eyeSize),
    eyeStalks: e.eyeStalks < 0.6 ? 0 : lerp(0.5, 2.2, (e.eyeStalks - 0.6) / 0.4),
    twinHead: e.twinHead >= (RECESSIVE_THRESHOLD.twinHead ?? 0.64),
    earType: quantize(e.earType, EAR_TYPES),
    earSize: through(0.4, 1.05, 2.2, e.earSize),
    horns: bucket(e.horns, [0.55, 0.7, 0.84], ['none', 'unicorn', 'ram', 'antlers'] as const),
    tailLength: through(0.05, 1.1, 3, e.tailLength),
    tailShape: bucket(e.tailShape, [0.46, 0.6, 0.73, 0.86], ['plain', 'whip', 'curl', 'club', 'fan'] as const),
    twinTail: e.twinTail >= (RECESSIVE_THRESHOLD.twinTail ?? 0.62),
    tailTuft: e.tailTuft > 0.62,
    spikes: e.spikes < 0.3 ? 0 : lerp(0.25, 1.8, Math.pow((e.spikes - 0.3) / 0.7, 1.3)),
    fluff: bucket(e.fluff, [0.46, 0.6, 0.73, 0.86], ['none', 'tufts', 'mane', 'frill', 'crest'] as const),
    wingSpan: wingsOn ? lerp(0.9, 4, (e.wings - 0.6) / 0.4) : 0,
    glow: e.glow >= (RECESSIVE_THRESHOLD.glow ?? 0.65),
    colour: {
      body: { h: hue, s: bodyS, l: bodyL },
      accent: { h: wrap01(hue + accentOffset), s: Math.min(0.85, bodyS + 0.1), l: bodyL > 0.55 ? bodyL - 0.2 : bodyL + 0.16 },
      belly: { h: wrap01(hue + 0.03), s: bodyS * 0.45, l: Math.min(0.9, bodyL + 0.2) },
    },
    pattern: quantize(e.pattern, PATTERNS),
    patternScale: lerp(0.8, 3.2, e.patternScale),
    finish: bucket(e.finish, [0.5, 0.63, 0.76, 0.88], ['matte', 'gradient', 'eyespots', 'iridescent', 'jelly'] as const),
    gait: gaitFor(e.gait, legPairs, legStyle, bodyLength),
    voice: { timbre: quantize(e.voice, TIMBRES), pitch: 430 * lerp(0.75, 1.45, e.voice) / Math.pow(size, 0.8) },
    quirk: quantize(e.quirk, QUIRKS),
    favourite: quantize(e.favourite, FOODS),
    sprouts: sprouts.map(expressSprout),
    energy: e.energy,
    sociability: e.sociability,
    curiosity: e.curiosity,
  };
}

export const planFromGenome = (genome: Genome) => planFromExpressed(express(genome), genome.sprouts);

// ---- Words -------------------------------------------------------------

export const GAIT_LABEL: Record<Gait, { verb: string; noun: string }> = {
  walk: { verb: 'trots', noun: 'Trot' },
  hop: { verb: 'hops', noun: 'Hop' },
  waddle: { verb: 'waddles', noun: 'Waddle' },
  prance: { verb: 'prances', noun: 'Prance' },
  scuttle: { verb: 'scuttles', noun: 'Scuttle' },
  bound: { verb: 'bounds', noun: 'Bound' },
  slither: { verb: 'slithers', noun: 'Slither' },
  inch: { verb: 'inches along', noun: 'Inch' },
  bounce: { verb: 'bounces', noun: 'Bounce' },
  creep: { verb: 'creeps on its tentacles', noun: 'Creep' },
};

export const QUIRK_LABEL: Record<Quirk, { status: string; blurb: string }> = {
  stretch: { status: 'Having a big stretch', blurb: 'loves a good stretch' },
  chase: { status: 'Chasing its tail', blurb: 'chases its tail' },
  twirl: { status: 'Twirling', blurb: 'twirls when happy' },
  dance: { status: 'Dancing', blurb: 'dances for no reason' },
  roll: { status: 'Rolling in the grass', blurb: 'rolls in the grass' },
  sing: { status: 'Singing', blurb: 'sings to itself' },
};

export const TIMBRE_LABEL: Record<Timbre, string> = { honk: 'Honks', coo: 'Coos', chirp: 'Chirps', trill: 'Trills' };

/** Where a creature likes to nap, by favourite food. */
export const NAP_SPOT: Record<Food, string> = { fruit: 'under a tree', roots: 'by the soil patch', nectar: 'in the flowers', shells: 'by the pond' };

const FINISH_WORD: Record<Finish, string> = { matte: '', gradient: 'two-tone', eyespots: 'eye-spotted', iridescent: 'shimmering', jelly: 'jelly-like' };

/** A one-line, human description: "A tiny, beaked, 2-legged strider that hops, with spotted teal skin." */
export function describePlan(p: BodyPlan): string {
  const bits: string[] = [];
  if (p.size < 0.65) bits.push('tiny');
  if (p.size > 1.5) bits.push('huge');
  if (p.twinHead) bits.push('two-headed');
  if (p.shell) bits.push('shelled');
  if (p.eyeStalks > 0) bits.push('stalk-eyed');
  if (p.lumps > 0.35) bits.push('lumpy');
  if (p.snout > 0.75 && p.mouth === 'plain') bits.push('trunked');
  if (p.spikes > 1.1) bits.push('sail-backed');
  if (p.horns === 'unicorn') bits.push('one-horned');
  if (p.horns === 'ram') bits.push('curly-horned');
  if (p.horns === 'antlers') bits.push('antlered');
  if (p.mouth === 'beak') bits.push('beaked');
  if (p.mouth === 'tusks') bits.push('tusked');
  if (p.fluff === 'mane') bits.push('maned');
  if (p.fluff === 'frill') bits.push('frilled');
  if (p.fluff === 'crest') bits.push('crested');
  if (p.twinTail) bits.push('twin-tailed');
  else if (p.tailShape === 'fan') bits.push('fan-tailed');
  else if (p.tailShape === 'club') bits.push('club-tailed');
  if (p.neckLength > 1.4) bits.push('long-necked');
  if (p.legLength > 1.5 && p.legPairs > 0) bits.push('leggy');
  if (p.legLength < 0.35 && p.legPairs > 0) bits.push('stubby');
  if (p.headSize > 0.72) bits.push('big-headed');
  if (p.girth > 0.75) bits.push('chunky');
  if (p.girth < 0.32) bits.push('slender');
  if (p.bodyWidth > 1.35) bits.push('flat');
  if (p.arch > 0.6) bits.push('humpbacked');
  if (p.eyeCount === 1) bits.push('cyclopean');
  if (p.eyeCount >= 3) bits.push(`${p.eyeCount}-eyed`);
  if (p.wingSpan > 0) bits.push('winged');
  if (p.sprouts.length >= 3) bits.push('overgrown');
  else if (p.sprouts.length) bits.push('sprouting');

  const tentacled = p.legStyle === 'tentacles';
  const legs = p.legPairs === 0 ? (tentacled ? 'tentacled' : 'legless') : `${p.legPairs * 2}-${tentacled ? 'tentacled' : 'legged'}`;
  const shape = p.legPairs === 0 ? (tentacled ? 'squiggle' : p.tailLength > 1.2 ? 'noodle' : 'blob') : p.legPairs === 1 ? 'strider' : 'critter';
  const adjectives = [...bits.slice(0, 2), legs].join(', ');
  const pattern = p.pattern === 'plain' ? '' : p.pattern === 'patches' ? 'patchy' : p.pattern === 'spots' ? 'spotted' : 'striped';
  const skin = [pattern, FINISH_WORD[p.finish]].filter(Boolean).join(', ');
  const glow = p.glow ? ' It glows at night.' : '';
  return `A ${adjectives} ${shape} that ${GAIT_LABEL[p.gait].verb}, with ${skin ? `${skin} ` : ''}${hueName(p.colour.body)} skin.${glow}`;
}

export function hueName({ h, s, l }: Hsl): string {
  if (s < 0.3) return l > 0.6 ? 'pale grey' : 'slate';
  const names = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'jade', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'magenta', 'pink', 'rose'];
  const name = names[Math.floor(wrap01(h + 1 / 32) * names.length) % names.length];
  if (l < 0.42) return `deep ${name}`;
  if (l > 0.62) return `pale ${name}`;
  return name;
}
