import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { computeAbilities } from '../src/genetics/abilities';
import { buildSkeleton } from '../src/genetics/anatomy';
import { DISCOVERIES } from '../src/genetics/discoveries';
import { GENES, GENE_IDS } from '../src/genetics/genes';
import { breed, express, expressGene, homozygousGenome, randomGenome, reviveGenome, type Genome } from '../src/genetics/genome';
import { childName, randomName } from '../src/genetics/names';
import { GAIT_LABEL, describePlan, gaitFor, isUpright, planFromExpressed, planFromGenome, type Gait } from '../src/genetics/phenotype';
import { hatchReport, offspringOdds, traitsOf } from '../src/genetics/report';
import { MAX_SPROUTS, describeSprout, inheritSprouts, randomSprout, reviveSprouts } from '../src/genetics/sprouts';
import { VISITOR_THEMES, themeBias } from '../src/sim/visitors';

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

describe('milestone 2 bodies', () => {
  const base = () => express(randomGenome(mulberry32(60)));

  it('scales the whole skeleton with size', () => {
    const e = base();
    const small = planFromExpressed({ ...e, size: 0 });
    const big = planFromExpressed({ ...e, size: 1 });
    const s = buildSkeleton(small);
    const b = buildSkeleton(big);
    const ratio = big.size / small.size;
    expect(b.length / s.length).toBeCloseTo(ratio, 1);
    expect(b.mass / s.mass / ratio ** 3).toBeCloseTo(1, 2);
    expect(computeAbilities(big, b).reach).toBeGreaterThanOrEqual(computeAbilities(small, s).reach);
  });

  it('lets tiny creatures fly where huge ones cannot', () => {
    const e = { ...base(), wings: 0.8, girth: 0.6, bodyLength: 0.6 };
    const tiny = planFromExpressed({ ...e, size: 0.05 });
    const huge = planFromExpressed({ ...e, size: 0.95 });
    expect(computeAbilities(tiny, buildSkeleton(tiny)).fly).toBeGreaterThan(computeAbilities(huge, buildSkeleton(huge)).fly);
  });

  it('only picks gaits the body allows', () => {
    for (let g = 0; g <= 1; g += 0.05) {
      expect(['inch', 'slither', 'bounce']).toContain(gaitFor(g, 0, 'straight', 3));
      expect(['creep', 'float']).toContain(gaitFor(g, 0, 'tentacles', 2));
      expect(['waddle', 'walk', 'prance', 'hop', 'roll']).toContain(gaitFor(g, 1, 'straight', 1.2, true));
      expect(['waddle', 'walk', 'prance', 'hop']).toContain(gaitFor(g, 1, 'straight', 2));
      expect(['walk', 'scuttle']).toContain(gaitFor(g, 4, 'splayed', 2));
    }
  });

  it('can reach every gait from random founders', () => {
    const rng = mulberry32(61);
    const seen = new Set<Gait>();
    for (let i = 0; i < 4000 && seen.size < Object.keys(GAIT_LABEL).length; i++) {
      seen.add(planFromGenome(randomGenome(rng, themeBias(VISITOR_THEMES[i % VISITOR_THEMES.length], rng))).gait);
    }
    expect([...seen].sort()).toEqual(Object.keys(GAIT_LABEL).sort());
  });

  it('keeps every tail above the grass', () => {
    const rng = mulberry32(62);
    for (let i = 0; i < 400; i++) {
      const s = buildSkeleton(planFromGenome(randomGenome(rng)));
      for (const p of s.tail) expect(p.y).toBeGreaterThan(0.1);
      expect(s.tailRadii).toHaveLength(s.tail.length);
    }
  });

  it('treats shell, twin tails and second heads as recessive', () => {
    const g = homozygousGenome(base());
    for (const gene of ['shell', 'twinTail', 'twinHead'] as const) {
      const carrier = withGene(g, gene, [0.95, 0.1]);
      const both = withGene(g, gene, [0.95, 0.95]);
      const key = gene === 'shell' ? 'shell' : gene;
      expect(planFromGenome(carrier)[key]).toBe(false);
      expect(planFromGenome(both)[key]).toBe(true);
    }
  });

  it('builds legless tentacled bodies on a skirt of tentacles', () => {
    const p = planFromExpressed({ ...base(), legPairs: 0, legStyle: 1 });
    const s = buildSkeleton(p);
    expect(p.legPairs).toBe(0);
    expect(s.legs).toHaveLength(0);
    expect(s.tentacles.length).toBeGreaterThan(0);
    expect(describePlan(p)).toContain('tentacle');
  });

  it('describes how a creature moves', () => {
    const p = planFromGenome(randomGenome(mulberry32(63)));
    expect(describePlan(p)).toContain(GAIT_LABEL[p.gait].verb);
  });

  it('pushes Curio visitors to extremes', () => {
    const rng = mulberry32(64);
    let extremes = 0;
    for (let i = 0; i < 40; i++) {
      const e = express(randomGenome(rng, themeBias(VISITOR_THEMES.find((t) => t.id === 'curio')!, rng)));
      extremes += GENE_IDS.filter((id) => GENES[id].expression === 'blend' && (e[id] < 0.1 || e[id] > 0.9)).length;
    }
    expect(extremes / 40).toBeGreaterThan(4);
  });
});

describe('offspring odds', () => {
  it('predicts recessive surprises from two carriers', () => {
    const g = homozygousGenome(express(randomGenome(mulberry32(70))));
    const carrier = withGene(withGene(g, 'wings', [0.95, 0.1]), 'glow', [0.1, 0.1]);
    const odds = offspringOdds(carrier, carrier, 600);
    const wings = odds.find((o) => o.category === 'wings')!;
    const chance = wings.outcomes.find((o) => o.value === 'wings')?.chance ?? 0;
    expect(chance).toBeGreaterThan(0.18);
    expect(chance).toBeLessThan(0.32);
    expect(offspringOdds(carrier, carrier, 600)).toEqual(odds);
    for (const o of odds) expect(o.outcomes.reduce((sum, x) => sum + x.chance, 0)).toBeCloseTo(1);
  });
});

describe('sprouts', () => {
  const none = { drift: 0, duplicate: 0, lose: 0, invent: 0 };

  it('always passes a double-dose sprout and pairs matching ones', () => {
    const g = randomSprout(mulberry32(80), 2);
    for (let i = 0; i < 20; i++) {
      const { sprouts } = inheritSprouts([g], [], mulberry32(81 + i), none);
      expect(sprouts).toHaveLength(1);
    }
    const single = { ...g, dose: 1 as const };
    let paired = 0;
    for (let i = 0; i < 200; i++) {
      const { sprouts } = inheritSprouts([single], [single], mulberry32(200 + i), none);
      expect(sprouts.length).toBeLessThanOrEqual(1);
      if (sprouts[0]?.dose === 2) paired++;
    }
    // Both parents pass it a quarter of the time.
    expect(paired / 200).toBeGreaterThan(0.15);
    expect(paired / 200).toBeLessThan(0.35);
  });

  it('lets the sprout list grow and shrink', () => {
    const rng = mulberry32(90);
    const parent = [randomSprout(rng, 2), randomSprout(rng, 2)];
    const counts = new Set<number>();
    for (let i = 0; i < 300; i++) counts.add(inheritSprouts(parent, parent, rng, { drift: 0.1, duplicate: 0.3, lose: 0.3, invent: 0.2 }).sprouts.length);
    expect(Math.min(...counts)).toBeLessThan(2);
    expect(Math.max(...counts)).toBeGreaterThan(2);
    for (const n of counts) expect(n).toBeLessThanOrEqual(MAX_SPROUTS);
  });

  it('logs sprout changes as mutations', () => {
    const a = { ...randomGenome(mulberry32(91)), sprouts: [randomSprout(mulberry32(92), 2)] };
    let logged = 0;
    for (let i = 0; i < 50; i++) logged += breed(a, a, mulberry32(300 + i), { mutationBoost: 8 }).mutations.filter((m) => m.gene === 'sprouts').length;
    expect(logged).toBeGreaterThan(0);
  });

  it('survives saving, and old saves without sprouts load with none', () => {
    const g = { ...randomGenome(mulberry32(93)), sprouts: [randomSprout(mulberry32(94))] };
    expect(reviveGenome(JSON.parse(JSON.stringify(g)), mulberry32(1))).toEqual(g);
    const old = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
    delete old.sprouts;
    expect(reviveGenome(old, mulberry32(1)).sprouts).toEqual([]);
    expect(reviveSprouts([{ site: 'x' }, null, 3])).toEqual([]);
  });

  it('lays out every sprout on the body with a real size', () => {
    const rng = mulberry32(95);
    for (let i = 0; i < 100; i++) {
      const genome = { ...randomGenome(rng), sprouts: [randomSprout(rng), randomSprout(rng)] };
      const plan = planFromGenome(genome);
      const s = buildSkeleton(plan);
      const expected = plan.sprouts.reduce((n, sp) => n + sp.repeat * (sp.mirrored ? 2 : 1), 0);
      expect(s.sprouts).toHaveLength(expected);
      for (const l of s.sprouts) {
        expect(l.length).toBeGreaterThan(0);
        expect(Math.hypot(l.dir.x, l.dir.y, l.dir.z)).toBeCloseTo(1);
      }
      expect(describeSprout(plan.sprouts[0])).toMatch(/ on its /);
    }
  });
});

describe('milestone 3 bodies', () => {
  const base = () => express(randomGenome(mulberry32(70)));

  it('hangs arms from the chest with hands clear of the ground', () => {
    const rng = mulberry32(71);
    for (let i = 0; i < 200; i++) {
      const e = { ...express(randomGenome(rng)), arms: 0.95 };
      const p = planFromExpressed(e);
      const s = buildSkeleton(p);
      expect(p.armPairs).toBe(2);
      expect(s.arms).toHaveLength(4);
      for (const a of s.arms) {
        expect(Math.hypot(a.dir.x, a.dir.y, a.dir.z)).toBeCloseTo(1);
        expect(a.shoulder.y + a.dir.y * a.length).toBeGreaterThan(0);
      }
      expect(traitsOf(p).arms).toMatch(/^4 arms with /);
    }
  });

  it('lets arms reach fruit the head cannot', () => {
    const e = { ...base(), legPairs: 0.3, posture: 0.9, neckLength: 0.1, armLength: 1 };
    const without = buildSkeleton(planFromExpressed({ ...e, arms: 0 }));
    const withArms = buildSkeleton(planFromExpressed({ ...e, arms: 0.7 }));
    expect(withArms.reach).toBeGreaterThan(without.reach);
  });

  it('stands bipeds up with the posture gene', () => {
    const e = { ...base(), legPairs: 0.3, arch: 0.5 };
    const low = planFromExpressed({ ...e, posture: 0.1 });
    const tall = planFromExpressed({ ...e, posture: 0.95 });
    expect(isUpright(tall)).toBe(true);
    expect(isUpright(low)).toBe(false);
    const s = buildSkeleton(tall);
    const chest = s.spine[s.spine.length - 1];
    expect(chest.y - s.spine[0].y).toBeGreaterThan(Math.abs(chest.x - s.spine[0].x));
    // Hips stay under the body and the underside clears the grass.
    for (const leg of s.legs) expect(leg.length).toBeGreaterThan(0);
    expect(s.sitDrop).toBeGreaterThanOrEqual(0);
    expect(describePlan(tall)).toContain('upright');
  });

  it('only lets round bodies and shells roll', () => {
    for (let g = 0; g <= 1; g += 0.05) {
      expect(gaitFor(g, 2, 'straight', 3, false)).not.toBe('roll');
      expect(['creep', 'float']).toContain(gaitFor(g, 0, 'tentacles', 1, true));
    }
    expect(gaitFor(0.99, 2, 'straight', 1, true)).toBe('roll');
  });

  it('keeps pattern colours clearly lighter or darker than the body', () => {
    const rng = mulberry32(72);
    for (let i = 0; i < 300; i++) {
      const { body, accent, belly } = planFromGenome(randomGenome(rng)).colour;
      expect(Math.abs(body.l - accent.l)).toBeGreaterThan(0.12);
      expect(belly.l).toBeGreaterThan(body.l);
    }
  });
});
