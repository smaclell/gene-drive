import { lerp, wrap01 } from '../core/rng';
import { RECESSIVE_THRESHOLD } from './genes';
import { express, type Expressed, type Genome } from './genome';

/**
 * The phenotype: expressed genes converted to real-world units and discrete
 * choices. Everything that draws or simulates a creature reads this, never the raw genome.
 */

export type EarType = 'none' | 'round' | 'long' | 'horns' | 'antennae';
export type Pattern = 'plain' | 'spots' | 'stripes' | 'patches';

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export interface BodyPlan {
  segments: number;
  bodyLength: number;
  girth: number;
  /** -1 heavy rear … +1 heavy chest. */
  taper: number;
  arch: number;
  legPairs: number;
  legLength: number;
  legGirth: number;
  footSize: number;
  neckLength: number;
  headSize: number;
  snout: number;
  eyeCount: number;
  /** Eye radius as a fraction of head radius. */
  eyeSize: number;
  earType: EarType;
  earSize: number;
  tailLength: number;
  tailTuft: boolean;
  /** Back fin height multiplier; 0 means none. */
  spikes: number;
  /** Wing span; 0 means no wings. */
  wingSpan: number;
  glow: boolean;
  colour: { body: Hsl; accent: Hsl; belly: Hsl };
  pattern: Pattern;
  patternScale: number;
  energy: number;
  sociability: number;
  curiosity: number;
}

const EAR_TYPES: EarType[] = ['none', 'round', 'long', 'horns', 'antennae'];
const PATTERNS: Pattern[] = ['plain', 'spots', 'patches', 'stripes'];

function quantize<T>(value: number, options: readonly T[]): T {
  return options[Math.min(options.length - 1, Math.floor(value * options.length))];
}

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

export function planFromExpressed(e: Expressed): BodyPlan {
  const hue = e.hue;
  // Accent is usually a near neighbour on the colour wheel, occasionally a bolder contrast.
  const accentOffset = e.accentShift < 0.72 ? lerp(-0.08, 0.12, e.accentShift / 0.72) : lerp(0.26, 0.42, (e.accentShift - 0.72) / 0.28);
  const bodyS = lerp(0.22, 0.72, e.saturation);
  const bodyL = lerp(0.36, 0.74, e.lightness);
  const wingsOn = e.wings >= (RECESSIVE_THRESHOLD.wings ?? 0.6);

  return {
    segments: Math.round(lerp(3, 7, e.segments)),
    bodyLength: lerp(1.1, 3.2, e.bodyLength),
    girth: lerp(0.28, 0.8, e.girth),
    taper: lerp(-1, 1, e.taper),
    arch: lerp(-0.25, 0.55, e.arch),
    legPairs: legPairsFrom(e.legPairs),
    legLength: lerp(0.22, 1.7, e.legLength),
    legGirth: lerp(0.05, 0.2, e.legGirth),
    footSize: lerp(0.6, 1.7, e.footSize),
    neckLength: lerp(0.05, 1.9, Math.pow(e.neckLength, 1.3)),
    headSize: lerp(0.26, 0.68, e.headSize),
    snout: lerp(0, 0.65, e.snout),
    eyeCount: eyeCountFrom(e.eyeCount),
    eyeSize: lerp(0.12, 0.42, e.eyeSize),
    earType: quantize(e.earType, EAR_TYPES),
    earSize: lerp(0.5, 1.6, e.earSize),
    tailLength: lerp(0.05, 2.2, e.tailLength),
    tailTuft: e.tailTuft > 0.62,
    spikes: e.spikes < 0.3 ? 0 : lerp(0.25, 1.3, (e.spikes - 0.3) / 0.7),
    wingSpan: wingsOn ? lerp(0.9, 3.4, (e.wings - 0.6) / 0.4) : 0,
    glow: e.glow >= (RECESSIVE_THRESHOLD.glow ?? 0.65),
    colour: {
      body: { h: hue, s: bodyS, l: bodyL },
      accent: { h: wrap01(hue + accentOffset), s: Math.min(0.85, bodyS + 0.1), l: bodyL > 0.55 ? bodyL - 0.2 : bodyL + 0.16 },
      belly: { h: wrap01(hue + 0.03), s: bodyS * 0.45, l: Math.min(0.9, bodyL + 0.2) },
    },
    pattern: quantize(e.pattern, PATTERNS),
    patternScale: lerp(0.8, 3.2, e.patternScale),
    energy: e.energy,
    sociability: e.sociability,
    curiosity: e.curiosity,
  };
}

export const planFromGenome = (genome: Genome) => planFromExpressed(express(genome));

/** A one-line, human description: "a long-necked, six-legged critter with spotted teal skin". */
export function describePlan(p: BodyPlan): string {
  const bits: string[] = [];
  if (p.neckLength > 1.2) bits.push('long-necked');
  if (p.legLength > 1.3 && p.legPairs > 0) bits.push('leggy');
  if (p.legLength < 0.4 && p.legPairs > 0) bits.push('stubby');
  if (p.girth > 0.68) bits.push('chunky');
  if (p.girth < 0.36) bits.push('slender');
  if (p.eyeCount === 1) bits.push('cyclopean');
  if (p.eyeCount >= 3) bits.push(`${p.eyeCount}-eyed`);
  if (p.wingSpan > 0) bits.push('winged');

  const legs = p.legPairs === 0 ? 'legless' : `${p.legPairs * 2}-legged`;
  const shape = p.legPairs === 0 ? (p.tailLength > 1.2 ? 'noodle' : 'blob') : p.legPairs === 1 ? 'strider' : 'critter';
  const adjectives = [...bits.slice(0, 2), legs].join(', ');
  const pattern = p.pattern === 'plain' ? '' : `${p.pattern === 'patches' ? 'patchy' : p.pattern === 'spots' ? 'spotted' : 'striped'} `;
  const glow = p.glow ? ' that glows at night' : '';
  return `A ${adjectives} ${shape} with ${pattern}${hueName(p.colour.body)} skin${glow}.`;
}

export function hueName({ h, s, l }: Hsl): string {
  if (s < 0.3) return l > 0.6 ? 'pale grey' : 'slate';
  const names = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'jade', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'magenta', 'pink', 'rose'];
  const name = names[Math.floor(wrap01(h + 1 / 32) * names.length) % names.length];
  if (l < 0.42) return `deep ${name}`;
  if (l > 0.62) return `pale ${name}`;
  return name;
}
