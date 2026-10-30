import { GENES, GENE_IDS, type GeneId } from './genes';
import type { Expressed, Mutation } from './genome';
import type { BodyPlan } from './phenotype';

/**
 * Explains a newborn in player terms: what is new compared with both parents,
 * and which genes mutated. Shown when an egg hatches.
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

/** Discrete features worth calling out when they appear or change. */
function features(p: BodyPlan): Record<string, string> {
  return {
    legs: p.legPairs === 0 ? 'no legs' : `${p.legPairs * 2} legs`,
    eyes: p.eyeCount === 1 ? 'a single eye' : `${p.eyeCount} eyes`,
    ears: p.earType === 'none' ? 'no ears' : p.earType === 'round' ? 'round ears' : p.earType === 'long' ? 'long ears' : p.earType,
    pattern: p.pattern === 'plain' ? 'plain skin' : p.pattern,
    wings: p.wingSpan > 0 ? 'wings' : '',
    glow: p.glow ? 'a glow' : '',
    tuft: p.tailTuft ? 'a tail tuft' : '',
    fins: p.spikes > 0 ? 'back fins' : '',
  };
}

export function hatchReport(
  child: { plan: BodyPlan; expressed: Expressed },
  parents: [{ plan: BodyPlan; expressed: Expressed }, { plan: BodyPlan; expressed: Expressed }],
  mutations: Mutation[],
): HatchReport {
  const surprises: string[] = [];
  const cf = features(child.plan);
  const pf = parents.map((p) => features(p.plan));
  for (const key of Object.keys(cf)) {
    const value = cf[key];
    if (value && pf.every((f) => f[key] !== value)) surprises.push(value);
  }

  const beyond: string[] = [];
  const skip = new Set<GeneId>(['hue', 'legPairs', 'eyeCount', 'earType', 'pattern', 'wings', 'glow', 'tailTuft']);
  for (const id of GENE_IDS) {
    if (skip.has(id)) continue;
    const c = child.expressed[id];
    const lo = Math.min(parents[0].expressed[id], parents[1].expressed[id]);
    const hi = Math.max(parents[0].expressed[id], parents[1].expressed[id]);
    if (c > hi + MARGIN) beyond.push(GENES[id].high);
    else if (c < lo - MARGIN) beyond.push(GENES[id].low);
  }
  return { surprises, beyond, mutations };
}
