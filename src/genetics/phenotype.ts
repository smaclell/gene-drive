import { clamp01, lerp, smoothstep, wrap01 } from '../core/rng';
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
/** What is on the end of the arms. */
export type Hands = 'paws' | 'claws' | 'pincers';
export type Finish = 'matte' | 'gradient' | 'eyespots' | 'iridescent' | 'jelly';
/** Fine surface detail, drawn in the shader: soft fuzz, overlapping scales or raised pebbles. */
export type SkinTexture = 'smooth' | 'velvet' | 'scales' | 'pebbles';
/** How a creature gets around. Picked by the gait gene from the gaits its body allows. */
export type Gait = 'walk' | 'hop' | 'waddle' | 'prance' | 'scuttle' | 'bound' | 'slither' | 'inch' | 'bounce' | 'creep' | 'roll' | 'float';
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
  /** How deeply the torso pinches into a front and a back lobe, like an ant: 0 … 0.75. */
  waist: number;
  /** A round belly hanging under the middle of the torso: 0 none … 1 very round. */
  belly: number;
  /** Cross-section: side-to-side and top-to-bottom stretch of the torso. */
  bodyWidth: number;
  bodyTall: number;
  /**
   * Torso pitch in radians, chest up. Bipeds stand from a forward lean (≈0.3) up to
   * upright (≈1.3); four or more legs only slope the back; legless bodies rear up at the front.
   */
  tilt: number;
  /**
   * Extra pitch in radians for the front half of a body on two or more leg pairs: the chest
   * rears up like a centaur's, and the legs gather under the back half.
   */
  rise: number;
  shell: boolean;
  legPairs: number;
  legLength: number;
  legGirth: number;
  footSize: number;
  legStyle: LegStyle;
  /** 0, 1 or 2 pairs of arms on the chest. Arms never touch the ground. */
  armPairs: number;
  armLength: number;
  hands: Hands;
  /** Neck length in shape units. 0 when the head is sunk into the body. */
  neckLength: number;
  /** 0 a head on a neck … 1 a head melted into the front of the body, like a frog or a pufferfish. */
  headSink: number;
  headSize: number;
  /** -1 wide and flat (frog) … 0 round … +1 long (horse). */
  headStretch: number;
  headShape: HeadShape;
  snout: number;
  /** -1 a pointed snout that hooks down (shrew, anteater) … +1 a blunt, bulbous one that turns up (pig, hippo). */
  muzzle: number;
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
  /**
   * Paint layers, after Spore's base / coat / detail: `body` is the base, `coat` darkens
   * the back, `accent` is the pattern (detail) colour, `belly` the pale underside.
   */
  colour: { body: Hsl; coat: Hsl; accent: Hsl; belly: Hsl; iris: Hsl };
  pattern: Pattern;
  patternScale: number;
  finish: Finish;
  texture: SkinTexture;
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
  if (v < 0.13) return 0;
  if (v < 0.4) return 1;
  if (v < 0.67) return 2;
  if (v < 0.87) return 3;
  return 4;
}

const HANDS: Hands[] = ['paws', 'claws', 'pincers'];

/**
 * Torso pitch from the posture gene; what it means depends on how many legs hold the body up.
 * On two or more pairs the low half of the gene slopes the back (rear high … shoulders high, like a hyena)
 * and the top of it rears the chest up instead (see `riseFrom`).
 */
function tiltFrom(posture: number, legPairs: number): number {
  if (legPairs === 1) return lerp(0.2, 1.3, smoothstep(0.2, 0.8, posture));
  if (legPairs === 0) return 1.2 * smoothstep(0.55, 0.92, posture);
  return lerp(-0.22, 0.34, smoothstep(0.08, 0.68, posture)) / (legPairs >= 3 ? 1.6 : 1);
}

/** Centaur fronts: only bodies with two or more leg pairs can rear up their chest and keep walking. */
const riseFrom = (posture: number, legPairs: number) => (legPairs >= 2 ? 1.25 * smoothstep(0.68, 0.95, posture) : 0);

const hsl = (h: number, s: number, l: number): Hsl => ({ h: wrap01(h), s: Math.min(0.92, Math.max(0, s)), l: Math.min(0.92, Math.max(0.12, l)) });

/**
 * A palette with real value contrast. Hue is free, but saturation and lightness
 * stay in a pleasant band, yellows are lifted (they look muddy when dark) and the
 * pattern colour is always clearly lighter or darker than the body.
 */
/** Grass greens (0.24–0.40 on the wheel) get half their share of the hue gene, so fewer creatures vanish into the meadow. */
function hueFrom(gene: number): number {
  const start = 0.24;
  const band = 0.16;
  const share = 0.08;
  const t = wrap01(gene - start);
  return wrap01(start + (t < share ? (t / share) * band : band + ((t - share) / (1 - share)) * (1 - band)));
}

function paletteFrom(e: Expressed): BodyPlan['colour'] {
  const hue = hueFrom(e.hue);
  const yellow = Math.max(0, 1 - Math.abs(wrap01(hue - 0.15 + 0.5) - 0.5) / 0.12);
  const bodyS = lerp(0.34, 0.8, e.saturation);
  const bodyL = lerp(0.4, 0.68, e.lightness) + 0.08 * yellow;
  const dark = bodyL > 0.52;
  // Most accents are a darker or lighter neighbour; some are a split or full complement.
  const a = e.accentShift;
  const accentHue = a < 0.55 ? hue + lerp(-0.07, 0.07, a / 0.55) : a < 0.82 ? hue + lerp(0.14, 0.24, (a - 0.55) / 0.27) : hue + lerp(0.44, 0.56, (a - 0.82) / 0.18);
  const contrast = a < 0.55 ? 0.24 : 0.2;
  const accent = hsl(accentHue, bodyS + (a < 0.55 ? 0.08 : 0.15), dark ? bodyL - contrast : bodyL + contrast);
  // The coat leans a little toward the accent and darkens the back, so bodies read as round.
  const coat = hsl(hue + (accentHue - hue) * 0.15, bodyS + 0.06, bodyL - 0.1);
  // Bellies are a warm cream tinted by the body.
  const toWarm = wrap01(0.1 - hue + 0.5) - 0.5;
  const belly = hsl(hue + toWarm * 0.45, 0.22 + bodyS * 0.3, Math.max(0.78, bodyL + 0.2));
  // Eyes contrast with the body: warm bodies get cool eyes and the other way round.
  const iris = hsl(hue + 0.5 + (a - 0.5) * 0.2, 0.72, 0.52);
  return { body: hsl(hue, bodyS, bodyL), coat, accent, belly, iris };
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
export function gaitFor(gene: number, legPairs: number, legStyle: LegStyle, bodyLength: number, round = false): Gait {
  let options: Gait[];
  if (legStyle === 'tentacles') options = legPairs === 0 ? ['creep', 'float'] : ['creep', 'float', 'waddle', 'hop'];
  else if (legPairs === 0) options = bodyLength < 1.6 ? ['inch', 'bounce', 'bounce'] : ['inch', 'slither', 'slither', 'bounce'];
  else if (legPairs === 1) options = ['waddle', 'walk', 'prance', 'hop'];
  else if (legPairs === 2) options = legStyle === 'splayed' ? ['waddle', 'walk', 'scuttle', 'hop'] : ['waddle', 'walk', 'bound', 'prance', 'hop'];
  else options = ['walk', 'scuttle', 'scuttle'];
  // Round, compact bodies (and shells) can tuck in and roll instead.
  if (round && legStyle !== 'tentacles') options = [...options, 'roll'];
  // A blend of two uniform alleles piles up in the middle; undo that so every gait is equally likely.
  const even = gene < 0.5 ? 2 * gene * gene : 1 - 2 * (1 - gene) * (1 - gene);
  return quantize(even, options);
}

export function planFromExpressed(e: Expressed, sprouts: SproutGene[] = []): BodyPlan {
  const wingsOn = e.wings >= (RECESSIVE_THRESHOLD.wings ?? 0.6);
  const legPairs = legPairsFrom(e.legPairs);
  const legStyle = bucket(e.legStyle, [0.45, 0.66, 0.84], ['straight', 'digitigrade', 'splayed', 'tentacles'] as const);
  // Bodies are rounder than they used to be: an everyday creature is a bean, not a sausage.
  const bodyLength = through(0.75, 1.7, 3.8, e.bodyLength);
  const headStretch = lerp(-1, 1, e.headShape);
  const girth = through(0.22, 0.56, 1, e.girth);
  const shell = e.shell >= (RECESSIVE_THRESHOLD.shell ?? 0.62);
  const round = shell || (bodyLength < 1.4 && girth > 0.62);
  // The bottom of the neck gene sinks the head into the chest instead.
  const neck = lerp(-0.55, 2.5, Math.pow(e.neckLength, 1.3));
  // Legs are sized against the body they carry, so big bodies stand on sturdy legs rather than stilts.
  // Pinched, insect-like bodies get slender legs.
  const waist = 0.75 * smoothstep(0.42, 0.92, e.waist);
  const legGirth = Math.max(0.035, (girth * through(0.17, 0.3, 0.5, e.legGirth) * (1 - 0.65 * waist)) / (1 + 0.12 * Math.max(0, legPairs - 1)));
  // Geometric, so the middle of the gene is a size-1 creature.
  const size = 0.45 * Math.pow(2.1 / 0.45, e.size);

  return {
    size,
    segments: Math.round(lerp(2, 9, e.segments)),
    lumps: through(0.04, 0.14, 0.6, e.lumps),
    bodyLength,
    girth,
    taper: lerp(-1, 1, e.taper),
    arch: through(-0.35, 0.15, 0.9, e.arch),
    waist,
    belly: smoothstep(0.45, 0.95, e.belly),
    bodyWidth: through(1.7, 0.95, 0.6, e.bodyShape),
    bodyTall: through(0.65, 1, 1.3, e.bodyShape),
    tilt: tiltFrom(e.posture, legPairs),
    rise: riseFrom(e.posture, legPairs),
    shell,
    legPairs,
    legLength: through(0.15, 0.72, 2.3, e.legLength),
    legGirth,
    footSize: through(0.5, 1.15, 2.2, e.footSize),
    legStyle,
    armPairs: e.arms < 0.6 ? 0 : e.arms < 0.9 ? 1 : 2,
    armLength: through(0.35, 0.75, 1.5, e.armLength),
    hands: bucket(e.hands, [0.52, 0.75], HANDS),
    neckLength: Math.max(0, neck),
    headSink: clamp01(-neck / 0.4),
    headSize: through(0.18, 0.47, 0.95, e.headSize),
    headStretch,
    headShape: headStretch < -0.4 ? 'flat' : headStretch > 0.4 ? 'long' : 'round',
    snout: through(0, 0.33, 1.1, e.snout),
    muzzle: lerp(-1, 1, e.muzzle),
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
    colour: paletteFrom(e),
    pattern: quantize(e.pattern, PATTERNS),
    patternScale: lerp(0.8, 3.2, e.patternScale),
    finish: bucket(e.finish, [0.5, 0.63, 0.76, 0.88], ['matte', 'gradient', 'eyespots', 'iridescent', 'jelly'] as const),
    texture: bucket(e.texture, [0.48, 0.63, 0.79], ['smooth', 'velvet', 'scales', 'pebbles'] as const),
    gait: gaitFor(e.gait, legPairs, legStyle, bodyLength, round),
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

/** A biped standing tall, like a penguin or a person, rather than leaning forward like a bird. */
export const isUpright = (p: BodyPlan) => p.legPairs === 1 && p.tilt > 0.9;

/** A body on two or more leg pairs with its chest reared up, like a centaur. */
export const isCentaur = (p: BodyPlan) => p.legPairs >= 2 && p.rise > 0.6;

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
  roll: { verb: 'tucks in and rolls', noun: 'Roll' },
  float: { verb: 'floats along', noun: 'Float' },
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
const TEXTURE_WORD: Record<SkinTexture, string> = { smooth: '', velvet: 'velvety', scales: 'scaly', pebbles: 'pebbly' };

/** A one-line, human description: "A tiny, beaked, 2-legged strider that hops, with spotted teal skin." */
export function describePlan(p: BodyPlan): string {
  const bits: string[] = [];
  if (p.size < 0.65) bits.push('tiny');
  if (p.size > 1.5) bits.push('huge');
  if (p.twinHead) bits.push('two-headed');
  if (p.shell) bits.push('shelled');
  if (p.eyeStalks > 0) bits.push('stalk-eyed');
  if (p.armPairs === 2) bits.push('four-armed');
  else if (p.armPairs === 1) bits.push(p.hands === 'pincers' ? 'pincered' : p.hands === 'claws' ? 'taloned' : 'two-armed');
  if (isUpright(p)) bits.push('upright');
  if (p.legPairs === 0 && p.tilt > 0.6) bits.push('rearing');
  if (p.headSink > 0.5) bits.push('neckless');
  if (p.waist > 0.35) bits.push('wasp-waisted');
  if (p.belly > 0.6) bits.push('pot-bellied');
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
  const shape = p.legPairs === 0 ? (tentacled ? 'squiggle' : p.tailLength > 1.2 ? 'noodle' : 'blob')
    : p.legPairs === 1 ? (isUpright(p) ? 'biped' : 'strider')
    : isCentaur(p) ? 'centaur' : p.waist > 0.35 && p.legPairs >= 3 ? 'bug' : 'critter';
  const adjectives = [...bits.slice(0, 2), legs].join(', ');
  const pattern = p.pattern === 'plain' ? '' : p.pattern === 'patches' ? 'patchy' : p.pattern === 'spots' ? 'spotted' : 'striped';
  const skin = [pattern, TEXTURE_WORD[p.texture], FINISH_WORD[p.finish]].filter(Boolean).join(', ');
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
