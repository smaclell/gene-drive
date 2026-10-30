import { canFly, type Abilities } from './abilities';
import type { BodyPlan } from './phenotype';

/**
 * Journal entries: notable forms the player can discover by breeding or
 * welcoming visitors. Some unlock Lab sliders (see `unlockedBy` in genes.ts).
 */

export interface Discovery {
  id: string;
  title: string;
  hint: string;
  test: (p: BodyPlan, a: Abilities) => boolean;
}

export const DISCOVERIES: Discovery[] = [
  { id: 'legless', title: 'Legless', hint: 'Breed toward fewer and fewer legs.', test: (p) => p.legPairs === 0 },
  { id: 'biped', title: 'Strider', hint: 'Just one pair of legs.', test: (p) => p.legPairs === 1 },
  { id: 'centipede', title: 'Eight legs', hint: 'Keep adding leg pairs.', test: (p) => p.legPairs === 4 },
  { id: 'cyclops', title: 'Cyclops', hint: 'One big eye.', test: (p) => p.eyeCount === 1 },
  { id: 'many-eyes', title: 'Four eyes', hint: 'Extra eyes are dominant. Keep looking.', test: (p) => p.eyeCount === 4 },
  { id: 'giraffe', title: 'Sky-neck', hint: 'Reach the highest fruit.', test: (_p, a) => a.reach > 0.8 },
  { id: 'horns', title: 'Horned', hint: 'A fancy ear type.', test: (p) => p.earType === 'horns' },
  { id: 'antennae', title: 'Antennae', hint: 'The fanciest ear type.', test: (p) => p.earType === 'antennae' },
  { id: 'finned', title: 'Big fins', hint: 'Grow tall back fins.', test: (p) => p.spikes > 1 },
  { id: 'noodle', title: 'Noodle', hint: 'Very long and very slim.', test: (p) => p.bodyLength > 2.7 && p.girth < 0.4 },
  { id: 'chonk', title: 'Chonk', hint: 'As round as can be.', test: (p) => p.girth > 0.74 && p.bodyLength < 1.7 },
  { id: 'winged', title: 'Wings', hint: 'Wings are recessive: two carriers can surprise you.', test: (p) => p.wingSpan > 0 },
  { id: 'flyer', title: 'True flight', hint: 'Wings big enough to lift the body.', test: (p, a) => p.wingSpan > 0 && canFly(a) },
  { id: 'glow', title: 'Glow', hint: 'Recessive. Watch for it at night.', test: (p) => p.glow },
  { id: 'striped', title: 'Stripes', hint: 'A bold pattern.', test: (p) => p.pattern === 'stripes' },
  { id: 'charmer', title: 'Heart-stealer', hint: 'Huge eyes, round head, tufted tail…', test: (_p, a) => a.charm > 0.75 },
];

export function discoveriesFor(p: BodyPlan, a: Abilities): string[] {
  return DISCOVERIES.filter((d) => d.test(p, a)).map((d) => d.id);
}

export const discoveryById = (id: string) => DISCOVERIES.find((d) => d.id === id);
