import { mulberry32 } from '../core/rng';
import { GENES, GENE_IDS, type GeneId } from './genes';
import { breed, genomeSeed, type Expressed, type Genome, type Mutation } from './genome';
import { GAIT_LABEL, isCentaur, isUpright, planFromGenome, type BodyPlan } from './phenotype';

/**
 * Explains genetics in player terms:
 * - `hatchReport`: what is new in a newborn compared with both parents.
 * - `offspringOdds`: what two parents' babies might look like, by sampling.
 */

export interface HatchReport {
  /** Headline surprises: discrete traits neither parent had. */
  surprises: string[];
  /** Continuous traits pushed beyond both parents. */
  beyond: string[];
  /** Raw mutations, for the curious. */
  mutations: Mutation[];
}

const MARGIN = 0.07;

/** Trait categories worth calling out. An empty label means "nothing special". */
export const TRAIT_CATEGORIES = {
  size: 'Size',
  heads: 'Heads',
  legs: 'Legs',
  legStyle: 'Leg style',
  arms: 'Arms',
  stance: 'Stance',
  build: 'Build',
  neck: 'Neck',
  gait: 'Gait',
  eyes: 'Eyes',
  ears: 'Ears',
  horns: 'Horns',
  mouth: 'Mouth',
  head: 'Head',
  pattern: 'Pattern',
  finish: 'Finish',
  texture: 'Texture',
  tail: 'Tail',
  twin: 'Twin tails',
  fluff: 'Fluff',
  shell: 'Shell',
  wings: 'Wings',
  glow: 'Glow',
  tuft: 'Tail tuft',
  fins: 'Back fins',
  sprouts: 'Sprouts',
} as const;

export type TraitCategory = keyof typeof TRAIT_CATEGORIES;

/** How to say "nothing special" for a category, where an empty label would read badly. */
export const TRAIT_NONE: Partial<Record<TraitCategory, string>> = {
  size: 'medium build', legStyle: 'plain legs', arms: 'no arms', stance: 'low stance', horns: 'no horns', mouth: 'plain mouth', head: 'round face', finish: 'plain finish',
  tail: 'plain tail', fluff: 'no fluff', sprouts: 'no sprouts', build: 'plain build', neck: 'a neck', texture: 'smooth skin',
};

const TAIL_WORD = { plain: '', whip: 'a whip tail', curl: 'a curly tail', club: 'a club tail', fan: 'a fan tail' } as const;
const FLUFF_WORD = { none: '', tufts: 'fluffy tufts', mane: 'a mane', frill: 'a neck frill', crest: 'a crest' } as const;
const HORN_WORD = { none: '', unicorn: 'a unicorn horn', ram: 'curly horns', antlers: 'antlers' } as const;
const MOUTH_WORD = { plain: '', beak: 'a beak', jaws: 'big jaws', tusks: 'tusks' } as const;
const FINISH_WORD = { matte: '', gradient: 'two-tone skin', eyespots: 'eye-spots', iridescent: 'shimmering skin', jelly: 'jelly skin' } as const;
const TEXTURE_WORD = { smooth: '', velvet: 'velvety skin', scales: 'scales', pebbles: 'pebbly skin' } as const;
const LEG_WORD = { straight: '', digitigrade: 'backward knees', splayed: 'skitter legs', tentacles: 'tentacles' } as const;
const HAND_WORD = { paws: 'paws', claws: 'talons', pincers: 'pincers' } as const;

/** Discrete features of a body, in words. */
export function traitsOf(p: BodyPlan): Record<TraitCategory, string> {
  return {
    size: p.size < 0.65 ? 'a tiny build' : p.size > 1.5 ? 'a huge build' : '',
    heads: p.twinHead ? 'two heads' : '',
    legs: p.legPairs === 0 ? 'no legs' : `${p.legPairs * 2} legs`,
    legStyle: LEG_WORD[p.legStyle],
    arms: p.armPairs === 0 ? '' : `${p.armPairs * 2} arms with ${HAND_WORD[p.hands]}`,
    stance: isUpright(p) ? 'upright' : isCentaur(p) ? 'a centaur stance' : p.legPairs === 0 && p.tilt > 0.6 ? 'rearing up' : '',
    build: [p.waist > 0.35 ? 'a pinched waist' : '', p.belly > 0.6 ? 'a round belly' : ''].filter(Boolean).join(' and '),
    neck: p.headSink > 0.5 ? 'no neck' : '',
    gait: `${GAIT_LABEL[p.gait].noun.toLowerCase()} gait`,
    eyes: (p.eyeCount === 1 ? 'a single eye' : `${p.eyeCount} eyes`) + (p.eyeStalks > 0 ? ' on stalks' : ''),
    ears: p.earType === 'none' ? 'no ears' : p.earType === 'round' ? 'round ears' : p.earType === 'long' ? 'long ears' : p.earType,
    horns: HORN_WORD[p.horns],
    mouth: p.mouth === 'plain' && p.snout > 0.75 ? 'a trunk' : MOUTH_WORD[p.mouth],
    head: p.headShape === 'flat' ? 'a frog face' : p.headShape === 'long' ? 'a long face' : '',
    pattern: p.pattern === 'plain' ? 'plain skin' : p.pattern,
    finish: FINISH_WORD[p.finish],
    texture: TEXTURE_WORD[p.texture],
    tail: TAIL_WORD[p.tailShape],
    twin: p.twinTail ? 'twin tails' : '',
    fluff: FLUFF_WORD[p.fluff],
    shell: p.shell ? 'a shell' : '',
    wings: p.wingSpan > 0 ? 'wings' : '',
    glow: p.glow ? 'a glow' : '',
    tuft: p.tailTuft ? 'a tail tuft' : '',
    fins: p.spikes > 0 ? 'back fins' : '',
    sprouts: p.sprouts.length === 0 ? '' : p.sprouts.length === 1 ? '1 sprout' : `${p.sprouts.length} sprouts`,
  };
}

/** Genes that are reported as discrete traits rather than "beyond both parents". */
const DISCRETE = new Set<GeneId>([
  'hue', 'legPairs', 'eyeCount', 'earType', 'pattern', 'wings', 'glow', 'tailTuft', 'shell', 'twinTail', 'legStyle', 'mouth', 'horns', 'arms', 'hands',
  'tailShape', 'fluff', 'finish', 'gait', 'voice', 'quirk', 'favourite', 'twinHead', 'texture',
]);

export function hatchReport(
  child: { plan: BodyPlan; expressed: Expressed },
  parents: [{ plan: BodyPlan; expressed: Expressed }, { plan: BodyPlan; expressed: Expressed }],
  mutations: Mutation[],
): HatchReport {
  const surprises: string[] = [];
  const cf = traitsOf(child.plan);
  const pf = parents.map((p) => traitsOf(p.plan));
  for (const key of Object.keys(cf) as TraitCategory[]) {
    const value = cf[key];
    if (value && pf.every((f) => f[key] !== value)) surprises.push(value);
  }

  const beyond: string[] = [];
  for (const id of GENE_IDS) {
    if (DISCRETE.has(id)) continue;
    const c = child.expressed[id];
    const lo = Math.min(parents[0].expressed[id], parents[1].expressed[id]);
    const hi = Math.max(parents[0].expressed[id], parents[1].expressed[id]);
    if (c > hi + MARGIN) beyond.push(GENES[id].high);
    else if (c < lo - MARGIN) beyond.push(GENES[id].low);
  }
  return { surprises, beyond, mutations };
}

export interface TraitOdds {
  category: TraitCategory;
  label: string;
  /** Most likely first. An empty value means "none". */
  outcomes: { value: string; chance: number }[];
}

/**
 * Breed two genomes many times and tally the babies' traits. Seeded by the
 * parents, so the same pair always shows the same odds. Includes mutation, so
 * rare surprises show up as small chances.
 */
export function offspringOdds(a: Genome, b: Genome, samples = 300): TraitOdds[] {
  const rng = mulberry32((genomeSeed(a) ^ Math.imul(genomeSeed(b), 31)) >>> 0);
  const tallies = new Map<TraitCategory, Map<string, number>>();
  for (let i = 0; i < samples; i++) {
    const traits = traitsOf(planFromGenome(breed(a, b, rng).genome));
    for (const key of Object.keys(traits) as TraitCategory[]) {
      const tally = tallies.get(key) ?? new Map<string, number>();
      tally.set(traits[key], (tally.get(traits[key]) ?? 0) + 1);
      tallies.set(key, tally);
    }
  }
  return [...tallies].map(([category, tally]) => ({
    category,
    label: TRAIT_CATEGORIES[category],
    outcomes: [...tally].map(([value, n]) => ({ value, chance: n / samples })).sort((x, y) => y.chance - x.chance),
  }));
}
