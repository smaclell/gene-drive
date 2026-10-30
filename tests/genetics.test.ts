import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { computeAbilities } from '../src/genetics/abilities';
import { buildSkeleton } from '../src/genetics/anatomy';
import { DISCOVERIES } from '../src/genetics/discoveries';
import { GENES, GENE_IDS } from '../src/genetics/genes';
import { breed, express, expressGene, homozygousGenome, randomGenome, reviveGenome, type Genome } from '../src/genetics/genome';
import { childName, randomName } from '../src/genetics/names';
import { describePlan, planFromGenome } from '../src/genetics/phenotype';
import { hatchReport } from '../src/genetics/report';

const withGene = (base: Genome, id: keyof Genome, pair: [number, number]): Genome => ({ ...base, [id]: pair });

describe('expression', () => {
  it('blends, dominates and recedes', () => {
    expect(expressGene(GENES.girth, [0.2, 0.6])).toBeCloseTo(0.4);
    expect(expressGene(GENES.eyeCount, [0.2, 0.6])).toBe(0.6);
    expect(expressGene(GENES.wings, [0.2, 0.9])).toBe(0.2);
  });

  it('averages hue around the colour wheel', () => {
    const h = expressGene(GENES.hue, [0.95, 0.05]);
    expect(Math.min(h, 1 - h)).toBeLessThan(0.01);
  });
});

describe('breeding', () => {
  it('is deterministic for a seed and keeps alleles in range', () => {
    const a = randomGenome(mulberry32(1));
    const b = randomGenome(mulberry32(2));
    const c1 = breed(a, b, mulberry32(3));
    const c2 = breed(a, b, mulberry32(3));
    expect(c1).toEqual(c2);
    for (const id of GENE_IDS) {
      for (const v of c1.genome[id]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('takes one allele from each parent when mutation is off', () => {
    const a = randomGenome(mulberry32(10));
    const b = randomGenome(mulberry32(11));
    const { genome, mutations } = breed(a, b, mulberry32(12), { mutationBoost: 0 });
    expect(mutations).toHaveLength(0);
    for (const id of GENE_IDS) {
      expect(a[id]).toContain(genome[id][0]);
      expect(b[id]).toContain(genome[id][1]);
    }
  });

  it('lets two wingless carriers have winged babies', () => {
    const base = homozygousGenome(express(randomGenome(mulberry32(5))));
    const carrier = withGene(base, 'wings', [0.9, 0.1]);
    expect(planFromGenome(carrier).wingSpan).toBe(0);
    const rng = mulberry32(99);
    let winged = 0;
    for (let i = 0; i < 400; i++) {
      if (planFromGenome(breed(carrier, carrier, rng, { mutationBoost: 0 }).genome).wingSpan > 0) winged++;
    }
    // Mendel says one in four.
    expect(winged / 400).toBeGreaterThan(0.18);
    expect(winged / 400).toBeLessThan(0.32);
  });

  it('records mutations', () => {
    const a = randomGenome(mulberry32(20));
    const { mutations } = breed(a, a, mulberry32(21), { mutationBoost: 20 });
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.some((m) => m.big)).toBe(true);
  });
});

describe('save data', () => {
  it('round-trips and repairs broken genomes', () => {
    const g = randomGenome(mulberry32(30));
    expect(reviveGenome(JSON.parse(JSON.stringify(g)), mulberry32(1))).toEqual(g);
    const broken = { ...JSON.parse(JSON.stringify(g)), girth: 'nope' } as unknown;
    const repaired = reviveGenome(broken, mulberry32(1));
    expect(repaired.girth).toHaveLength(2);
    expect(repaired.hue).toEqual(g.hue);
  });
});

describe('bodies and abilities', () => {
  it('produces sane bodies across many random genomes', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 300; i++) {
      const plan = planFromGenome(randomGenome(rng));
      const s = buildSkeleton(plan);
      expect(s.legs).toHaveLength(plan.legPairs * 2);
      for (const leg of s.legs) expect(leg.length).toBeGreaterThan(0);
      expect(s.reach).toBeGreaterThan(0);
      const a = computeAbilities(plan, s);
      for (const v of Object.values(a)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(describePlan(plan)).toMatch(/^A .+\.$/);
    }
  });

  it('gives longer necks more reach', () => {
    const base = express(randomGenome(mulberry32(7)));
    const short = planFromGenome(homozygousGenome({ ...base, neckLength: 0.1 }));
    const tall = planFromGenome(homozygousGenome({ ...base, neckLength: 0.95 }));
    const reach = (p: typeof short) => computeAbilities(p, buildSkeleton(p)).reach;
    expect(reach(tall)).toBeGreaterThan(reach(short));
  });

  it('only lets big wings on light bodies fly', () => {
    const base = express(randomGenome(mulberry32(8)));
    const light = planFromGenome(homozygousGenome({ ...base, wings: 1, girth: 0.1, bodyLength: 0.1 }));
    const heavy = planFromGenome(homozygousGenome({ ...base, wings: 0.62, girth: 1, bodyLength: 1 }));
    expect(computeAbilities(light, buildSkeleton(light)).fly).toBeGreaterThan(computeAbilities(heavy, buildSkeleton(heavy)).fly);
  });

  it('has unique discovery ids and gene unlocks that exist', () => {
    const ids = DISCOVERIES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of GENE_IDS) {
      const unlock = (GENES[id] as { unlockedBy?: string }).unlockedBy;
      if (unlock) expect(ids).toContain(unlock);
    }
  });
});

describe('names', () => {
  it('makes short pronounceable names', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 50; i++) {
      const n = randomName(rng);
      expect(n).toMatch(/^[A-Z][a-z]+$/);
      expect(childName(rng, n, randomName(rng))).toMatch(/^[A-Z][a-z]{2,9}$/);
    }
  });
});

describe('hatch report', () => {
  it('calls out traits neither parent had', () => {
    const base = express(randomGenome(mulberry32(50)));
    const parent = homozygousGenome({ ...base, wings: 0.1, neckLength: 0.4 });
    const child = homozygousGenome({ ...base, wings: 1, neckLength: 0.9 });
    const view = (g: Genome) => ({ plan: planFromGenome(g), expressed: express(g) });
    const report = hatchReport(view(child), [view(parent), view(parent)], []);
    expect(report.surprises).toContain('wings');
    expect(report.beyond).toContain(GENES.neckLength.high);
  });
});
