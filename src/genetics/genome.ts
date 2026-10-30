import { clamp01, gaussian, wrap01, type Rng } from '../core/rng';
import { GENES, GENE_IDS, type GeneDef, type GeneId } from './genes';

/** Two alleles per gene: one from each parent. */
export type AllelePair = [number, number];
export type Genome = Record<GeneId, AllelePair>;
/** The single value per gene that the body actually uses. */
export type Expressed = Record<GeneId, number>;

export interface Mutation {
  gene: GeneId;
  from: number;
  to: number;
  /** A jump to a random value rather than a small drift. */
  big: boolean;
}

export interface BreedOptions {
  /** Chance per allele of a small drift. */
  driftRate?: number;
  /** Chance per allele of a jump to a random value. */
  jumpRate?: number;
  /** Multiplies both rates; hook for future mutation boosters. */
  mutationBoost?: number;
}

export const DEFAULT_DRIFT_RATE = 0.07;
export const DEFAULT_JUMP_RATE = 0.012;

const defaultFounder = (rng: Rng) => clamp01(0.5 + gaussian(rng) * 0.27);

export function expressGene(def: GeneDef, [a, b]: AllelePair): number {
  switch (def.expression) {
    case 'blend':
      return (a + b) / 2;
    case 'dominant':
      return Math.max(a, b);
    case 'recessive':
      return Math.min(a, b);
    case 'circular': {
      // Average on the colour wheel so 0.95 and 0.05 give 0.0, not 0.5.
      const x = Math.cos(a * 2 * Math.PI) + Math.cos(b * 2 * Math.PI);
      const y = Math.sin(a * 2 * Math.PI) + Math.sin(b * 2 * Math.PI);
      if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return a;
      return wrap01(Math.atan2(y, x) / (2 * Math.PI));
    }
  }
}

export function express(genome: Genome): Expressed {
  const out = {} as Expressed;
  for (const id of GENE_IDS) out[id] = expressGene(GENES[id], genome[id]);
  return out;
}

export type FounderBias = Partial<Record<GeneId, (rng: Rng) => number>>;

/** A brand-new creature with no parents. `bias` lets themed visitors skew genes. */
export function randomGenome(rng: Rng, bias: FounderBias = {}): Genome {
  const genome = {} as Genome;
  for (const id of GENE_IDS) {
    const gen = bias[id] ?? (GENES[id] as GeneDef).founder ?? defaultFounder;
    genome[id] = [clamp01(gen(rng)), clamp01(gen(rng))];
  }
  return genome;
}

/** A true-breeding genome where both alleles equal the given values (the Lab uses this). */
export function homozygousGenome(values: Expressed): Genome {
  const genome = {} as Genome;
  for (const id of GENE_IDS) genome[id] = [values[id], values[id]];
  return genome;
}

function mutateAllele(
  gene: GeneId,
  value: number,
  rng: Rng,
  driftRate: number,
  jumpRate: number,
  log: Mutation[],
): number {
  const roll = rng();
  if (roll < jumpRate) {
    const to = rng();
    log.push({ gene, from: value, to, big: true });
    return to;
  }
  if (roll < jumpRate + driftRate) {
    const to = GENES[gene].expression === 'circular'
      ? wrap01(value + gaussian(rng) * 0.08)
      : clamp01(value + gaussian(rng) * 0.12);
    log.push({ gene, from: value, to, big: false });
    return to;
  }
  return value;
}

/** Mendelian inheritance: one random allele from each parent, then mutation. */
export function breed(
  mother: Genome,
  father: Genome,
  rng: Rng,
  options: BreedOptions = {},
): { genome: Genome; mutations: Mutation[] } {
  const boost = options.mutationBoost ?? 1;
  const driftRate = (options.driftRate ?? DEFAULT_DRIFT_RATE) * boost;
  const jumpRate = (options.jumpRate ?? DEFAULT_JUMP_RATE) * boost;
  const mutations: Mutation[] = [];
  const genome = {} as Genome;
  for (const id of GENE_IDS) {
    const fromMother = mother[id][rng() < 0.5 ? 0 : 1];
    const fromFather = father[id][rng() < 0.5 ? 0 : 1];
    genome[id] = [
      mutateAllele(id, fromMother, rng, driftRate, jumpRate, mutations),
      mutateAllele(id, fromFather, rng, driftRate, jumpRate, mutations),
    ];
  }
  return { genome, mutations };
}

/**
 * Restore a genome from saved data. Missing or malformed genes get fresh founder
 * alleles, so old saves keep working when genes are added.
 */
export function reviveGenome(data: unknown, rng: Rng): Genome {
  const fresh = randomGenome(rng);
  if (!data || typeof data !== 'object') return fresh;
  const raw = data as Record<string, unknown>;
  for (const id of GENE_IDS) {
    const pair = raw[id];
    if (Array.isArray(pair) && pair.length === 2 && pair.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      fresh[id] = [clamp01(pair[0]), clamp01(pair[1])];
    }
  }
  return fresh;
}

/** Stable seed for per-creature cosmetic randomness (pattern offsets and so on). */
export function genomeSeed(genome: Genome): number {
  let h = 2166136261;
  for (const id of GENE_IDS) {
    for (const v of genome[id]) {
      h ^= Math.floor(v * 65535);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}
