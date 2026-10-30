import { clamp01, gaussian, lerp, type Rng } from '../core/rng';

/**
 * Sprouts: composable extra parts (tendrils, stalks, feelers, eyes on stalks…)
 * described by a variable-length list of genes. Unlike the fixed gene catalogue,
 * this list grows and shrinks over generations: breeding can duplicate a sprout,
 * lose one, or very rarely invent a new one.
 *
 * Each sprout gene is a dominant "locus": one copy shows. `dose` 2 means both
 * chromosomes carry it, so it is always passed on (Lab designs breed true).
 */

export interface SproutGene {
  /** Where it grows: tail … back … neck … head. */
  site: number;
  /** Around the body: top … side … underneath. */
  around: number;
  length: number;
  thickness: number;
  /** 0.5 is straight; lower curls down and back, higher curls up and over. */
  curl: number;
  wiggle: number;
  tip: number;
  /** How many copies line up along the site. */
  repeat: number;
  tint: number;
  dose: 1 | 2;
}

export const SPROUT_FIELDS = ['site', 'around', 'length', 'thickness', 'curl', 'wiggle', 'tip', 'repeat', 'tint'] as const;
type SproutField = (typeof SPROUT_FIELDS)[number];

export const MAX_SPROUTS = 6;

export type SproutSite = 'tail' | 'back' | 'neck' | 'head';
export type SproutTip = 'none' | 'bulb' | 'claw' | 'leaf' | 'eye' | 'puff';
const TIPS: SproutTip[] = ['none', 'bulb', 'claw', 'leaf', 'eye', 'puff'];

/** An expressed sprout. Lengths are in shape units (the skeleton applies size). */
export interface Sprout {
  site: SproutSite;
  /** Position along the site, 0 … 1 (tail base → tip, rump → shoulder, shoulder → head). */
  u: number;
  /** Radians around the body: 0 on top, π/2 on the side, π underneath. */
  around: number;
  /** Side sprouts grow in mirrored pairs. */
  mirrored: boolean;
  length: number;
  /** Base radius as a fraction of the body girth. */
  thickness: number;
  curl: number;
  wiggle: number;
  tip: SproutTip;
  repeat: number;
  tint: 'body' | 'accent' | 'belly';
}

export function expressSprout(g: SproutGene): Sprout {
  const band = (lo: number, hi: number) => clamp01((g.site - lo) / (hi - lo));
  const site: SproutSite = g.site < 0.15 ? 'tail' : g.site < 0.7 ? 'back' : g.site < 0.85 ? 'neck' : 'head';
  const u = site === 'tail' ? band(0, 0.15) : site === 'back' ? band(0.15, 0.7) : site === 'neck' ? band(0.7, 0.85) : band(0.85, 1);
  const around = g.around * Math.PI;
  return {
    site,
    u,
    around,
    mirrored: around > 0.18 * Math.PI && around < 0.82 * Math.PI,
    length: lerp(0.15, 1.7, g.length),
    thickness: lerp(0.08, 0.45, g.thickness),
    curl: lerp(-1, 1, g.curl),
    wiggle: g.wiggle < 0.45 ? 0 : (g.wiggle - 0.45) / 0.55,
    tip: TIPS[Math.min(TIPS.length - 1, Math.floor(g.tip * TIPS.length))],
    repeat: 1 + Math.floor(Math.pow(g.repeat, 2) * 3.99),
    tint: g.tint < 0.4 ? 'body' : g.tint < 0.75 ? 'accent' : 'belly',
  };
}

export function randomSprout(rng: Rng, dose: 1 | 2 = 1): SproutGene {
  const g = { dose } as SproutGene;
  for (const f of SPROUT_FIELDS) g[f] = rng();
  return g;
}

/** Founders: most have none, some have one, a few have two. */
export function founderSprouts(rng: Rng, chance = 0.3): SproutGene[] {
  const out: SproutGene[] = [];
  while (out.length < 3 && rng() < chance * (out.length ? 0.5 : 1)) out.push(randomSprout(rng));
  return out;
}

const similar = (a: SproutGene, b: SproutGene) => SPROUT_FIELDS.every((f) => Math.abs(a[f] - b[f]) < 0.04);

export interface SproutRates {
  drift: number;
  /** Chance per baby that an inherited sprout is copied to a new spot. */
  duplicate: number;
  /** Chance per baby that an inherited sprout is lost. */
  lose: number;
  /** Chance per baby of a brand-new sprout. */
  invent: number;
}

export const DEFAULT_SPROUT_RATES: SproutRates = { drift: 0.07, duplicate: 0.05, lose: 0.03, invent: 0.02 };

export type SproutEvent = 'copied' | 'lost' | 'new';

/**
 * Pass sprouts to a baby. A dose-2 sprout always passes; a dose-1 sprout passes
 * half the time. Matching sprouts from both parents pair up as dose 2.
 */
export function inheritSprouts(mother: SproutGene[], father: SproutGene[], rng: Rng, rates: SproutRates): { sprouts: SproutGene[]; events: SproutEvent[] } {
  const passed = (list: SproutGene[]) => list.filter((g) => g.dose === 2 || rng() < 0.5).map((g) => ({ ...g, dose: 1 as const }));
  const fromMother = passed(mother);
  const fromFather = passed(father);
  const sprouts: SproutGene[] = [...fromMother];
  for (const g of fromFather) {
    const twin = sprouts.find((m) => m.dose === 1 && similar(m, g));
    if (twin) twin.dose = 2;
    else sprouts.push(g);
  }
  for (const g of sprouts) {
    for (const f of SPROUT_FIELDS) if (rng() < rates.drift) g[f] = clamp01(g[f] + gaussian(rng) * 0.1);
  }
  const events: SproutEvent[] = [];
  if (sprouts.length && sprouts.length < MAX_SPROUTS && rng() < rates.duplicate) {
    const copy: SproutGene = { ...sprouts[Math.floor(rng() * sprouts.length)], dose: 1 };
    copy.site = clamp01(copy.site + gaussian(rng) * 0.2);
    copy.around = clamp01(copy.around + gaussian(rng) * 0.25);
    sprouts.push(copy);
    events.push('copied');
  }
  if (sprouts.length && rng() < rates.lose) {
    sprouts.splice(Math.floor(rng() * sprouts.length), 1);
    events.push('lost');
  }
  if (sprouts.length < MAX_SPROUTS && rng() < rates.invent) {
    sprouts.push(randomSprout(rng));
    events.push('new');
  }
  return { sprouts: sprouts.slice(0, MAX_SPROUTS), events };
}

/** Restore sprouts from saved data, dropping anything malformed. */
export function reviveSprouts(data: unknown): SproutGene[] {
  if (!Array.isArray(data)) return [];
  const out: SproutGene[] = [];
  for (const raw of data.slice(0, MAX_SPROUTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (!SPROUT_FIELDS.every((f) => typeof r[f] === 'number' && Number.isFinite(r[f]))) continue;
    const g = { dose: r.dose === 2 ? 2 : 1 } as SproutGene;
    for (const f of SPROUT_FIELDS) g[f as SproutField] = clamp01(r[f] as number);
    out.push(g);
  }
  return out;
}

/** "a curly tendril with an eye on its back" */
export function describeSprout(s: Sprout): string {
  const count = s.repeat * (s.mirrored ? 2 : 1);
  const shape = s.wiggle > 0.4 ? 'wiggly' : Math.abs(s.curl) > 0.55 ? 'curly' : s.length > 1.2 ? 'long' : s.length < 0.4 ? 'little' : '';
  const noun = s.thickness > 0.32 ? 'stalk' : s.tip === 'none' ? 'spine' : 'tendril';
  const tip = (count > 1
    ? { none: '', bulb: ' with bulbs', claw: ' with claws', leaf: ' with leaves', eye: ' with eyes', puff: ' with puffs' }
    : { none: '', bulb: ' with a bulb', claw: ' with a claw', leaf: ' with a leaf', eye: ' with an eye', puff: ' with a puff' })[s.tip];
  const where = { tail: 'its tail', back: s.around > 0.8 * Math.PI ? 'its belly' : 'its back', neck: 'its neck', head: 'its head' }[s.site];
  const what = `${shape ? `${shape} ` : ''}${noun}${count > 1 ? 's' : ''}${tip}`;
  return `${count > 1 ? `${count} ` : 'a '}${what} on ${where}`;
}
