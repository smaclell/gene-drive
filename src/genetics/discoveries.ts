import { canFly, type Abilities } from './abilities';
import type { BodyPlan, Gait } from './phenotype';

/**
 * Journal entries: notable forms the player can discover by breeding or
 * welcoming visitors. Some unlock Lab sliders (see `unlockedBy` in genes.ts).
 * Ids are saved, so never rename one; retire it instead.
 */

export type JournalSection = 'Body' | 'Head' | 'Tails & extras' | 'Skin' | 'Gaits' | 'Talents';

export const JOURNAL_SECTIONS: JournalSection[] = ['Body', 'Head', 'Tails & extras', 'Skin', 'Gaits', 'Talents'];

export interface Discovery {
  id: string;
  title: string;
  hint: string;
  section: JournalSection;
  test: (p: BodyPlan, a: Abilities) => boolean;
}

const gait = (id: string, g: Gait, title: string, hint: string): Discovery => ({ id, title, hint, section: 'Gaits', test: (p) => p.gait === g });

export const DISCOVERIES: Discovery[] = [
  // Body
  { id: 'legless', title: 'Legless', hint: 'Breed toward fewer and fewer legs.', section: 'Body', test: (p) => p.legPairs === 0 },
  { id: 'biped', title: 'Strider', hint: 'Just one pair of legs.', section: 'Body', test: (p) => p.legPairs === 1 },
  { id: 'centipede', title: 'Eight legs', hint: 'Keep adding leg pairs.', section: 'Body', test: (p) => p.legPairs === 4 },
  { id: 'noodle', title: 'Noodle', hint: 'Very long and very slim.', section: 'Body', test: (p) => p.bodyLength > 3 && p.girth < 0.38 },
  { id: 'chonk', title: 'Chonk', hint: 'As round as can be.', section: 'Body', test: (p) => p.girth > 0.8 && p.bodyLength < 1.7 },
  { id: 'tiny', title: 'Pipsqueak', hint: 'Breed small with small.', section: 'Body', test: (p) => p.size < 0.62 },
  { id: 'giant', title: 'Gentle giant', hint: 'Breed big with big.', section: 'Body', test: (p) => p.size > 1.6 },
  { id: 'caterpillar', title: 'Caterpillar', hint: 'A body like a string of beads.', section: 'Body', test: (p) => p.lumps > 0.4 && p.segments >= 5 },
  { id: 'humpback', title: 'Humpback', hint: 'Arch that back as high as it goes.', section: 'Body', test: (p) => p.arch > 0.7 },
  { id: 'pancake', title: 'Pancake', hint: 'A very flat body, like a ray.', section: 'Body', test: (p) => p.bodyWidth > 1.35 },
  { id: 'shelled', title: 'Shell', hint: 'Recessive. Look for it in Dune visitors.', section: 'Body', test: (p) => p.shell },
  { id: 'digitigrade', title: 'Backward knees', hint: 'A springier leg style.', section: 'Body', test: (p) => p.legPairs > 0 && p.legStyle === 'digitigrade' },
  { id: 'splayed', title: 'Skitter legs', hint: 'Legs that bend out to the side, like a beetle.', section: 'Body', test: (p) => p.legPairs > 0 && p.legStyle === 'splayed' },
  { id: 'tentacles', title: 'Tentacles', hint: 'The strangest leg style. Reef visitors carry it.', section: 'Body', test: (p) => p.legStyle === 'tentacles' },
  // Head
  { id: 'two-headed', title: 'Two heads', hint: 'Recessive, and very rare. Curio visitors sometimes carry it.', section: 'Head', test: (p) => p.twinHead },
  { id: 'eye-stalks', title: 'Eye stalks', hint: 'Eyes on stalks, like a snail.', section: 'Head', test: (p) => p.eyeStalks > 0 },
  { id: 'trunk', title: 'Trunk', hint: 'A snout so long it droops.', section: 'Head', test: (p) => p.snout > 0.75 && p.mouth === 'plain' },
  { id: 'big-head', title: 'Big head', hint: 'All head, hardly any body.', section: 'Head', test: (p) => p.headSize > 0.8 && p.girth < 0.45 },
  { id: 'cyclops', title: 'Cyclops', hint: 'One big eye.', section: 'Head', test: (p) => p.eyeCount === 1 },
  { id: 'many-eyes', title: 'Four eyes', hint: 'Extra eyes are dominant. Keep looking.', section: 'Head', test: (p) => p.eyeCount === 4 },
  { id: 'antennae', title: 'Antennae', hint: 'The fanciest ear type.', section: 'Head', test: (p) => p.earType === 'antennae' },
  { id: 'horns', title: 'Horned', hint: 'Horns come in three styles.', section: 'Head', test: (p) => p.horns !== 'none' },
  { id: 'unicorn', title: 'Unicorn', hint: 'A single spiral horn.', section: 'Head', test: (p) => p.horns === 'unicorn' },
  { id: 'antlers', title: 'Antlers', hint: 'The grandest horns. Grove visitors wear them.', section: 'Head', test: (p) => p.horns === 'antlers' },
  { id: 'beaked', title: 'Beak', hint: 'A fancier mouth.', section: 'Head', test: (p) => p.mouth === 'beak' },
  { id: 'tusked', title: 'Tusks', hint: 'The fanciest mouth. Great for digging.', section: 'Head', test: (p) => p.mouth === 'tusks' },
  { id: 'frog-face', title: 'Frog face', hint: 'A wide, flat head with eyes on top.', section: 'Head', test: (p) => p.headShape === 'flat' },
  // Tails & extras
  { id: 'sprouted', title: 'Sprouts', hint: 'A new part grows out of nowhere. Mutations can add them.', section: 'Tails & extras', test: (p) => p.sprouts.length > 0 },
  { id: 'overgrown', title: 'Overgrown', hint: 'Three or more sprouts. Sprouts can copy themselves.', section: 'Tails & extras', test: (p) => p.sprouts.length >= 3 },
  { id: 'eye-sprout', title: 'Watchful', hint: 'A sprout with an eye on the end.', section: 'Tails & extras', test: (p) => p.sprouts.some((s) => s.tip === 'eye') },
  { id: 'finned', title: 'Sail back', hint: 'Back fins so tall they join into a sail.', section: 'Tails & extras', test: (p) => p.spikes > 1.1 },
  { id: 'winged', title: 'Wings', hint: 'Wings are recessive: two carriers can surprise you.', section: 'Tails & extras', test: (p) => p.wingSpan > 0 },
  { id: 'twin-tail', title: 'Twin tails', hint: 'Recessive. Two carriers can surprise you.', section: 'Tails & extras', test: (p) => p.twinTail },
  { id: 'fan-tail', title: 'Fan tail', hint: 'A tail made for swimming.', section: 'Tails & extras', test: (p) => p.tailShape === 'fan' },
  { id: 'club-tail', title: 'Club tail', hint: 'A heavy knob on the end.', section: 'Tails & extras', test: (p) => p.tailShape === 'club' },
  { id: 'maned', title: 'Mane', hint: 'Fluff along the neck.', section: 'Tails & extras', test: (p) => p.fluff === 'mane' },
  { id: 'frilled', title: 'Neck frill', hint: 'A fan of skin behind the head.', section: 'Tails & extras', test: (p) => p.fluff === 'frill' },
  { id: 'crested', title: 'Crest', hint: 'The fanciest fluff: feathers on top.', section: 'Tails & extras', test: (p) => p.fluff === 'crest' },
  // Skin
  { id: 'striped', title: 'Stripes', hint: 'A bold pattern.', section: 'Skin', test: (p) => p.pattern === 'stripes' },
  { id: 'eyespots', title: 'Eye-spots', hint: 'Markings that stare back.', section: 'Skin', test: (p) => p.finish === 'eyespots' },
  { id: 'shimmer', title: 'Shimmer', hint: 'Skin that changes colour as it moves.', section: 'Skin', test: (p) => p.finish === 'iridescent' || p.finish === 'jelly' },
  { id: 'jelly', title: 'Jelly', hint: 'The rarest finish: see-through skin.', section: 'Skin', test: (p) => p.finish === 'jelly' },
  { id: 'glow', title: 'Glow', hint: 'Recessive. Watch for it at night.', section: 'Skin', test: (p) => p.glow },
  // Gaits
  gait('hopper', 'hop', 'Hopper', 'A springy gait on legs.'),
  gait('waddler', 'waddle', 'Waddler', 'A steady gait on legs.'),
  gait('prancer', 'prance', 'Prancer', 'A lively gait on one or two leg pairs.'),
  gait('bounder', 'bound', 'Bounder', 'Four legs, a springy back.'),
  gait('scuttler', 'scuttle', 'Scuttler', 'Lots of legs in a hurry.'),
  gait('slitherer', 'slither', 'Slitherer', 'A long, legless body.'),
  gait('inchworm', 'inch', 'Inchworm', 'A legless body with a steady gait.'),
  gait('bouncer', 'bounce', 'Bouncer', 'A short, legless body with a springy gait.'),
  gait('creeper', 'creep', 'Creeper', 'Walk on tentacles.'),
  // Talents
  { id: 'stilts', title: 'Stilts', hint: 'The longest legs on the ranch.', section: 'Talents', test: (p) => p.legPairs > 0 && p.legLength > 2 },
  { id: 'giraffe', title: 'Sky-neck', hint: 'Reach the highest fruit. Sky-necks can shake trees.', section: 'Talents', test: (_p, a) => a.reach > 0.8 },
  { id: 'flyer', title: 'True flight', hint: 'Wings big enough to lift the body.', section: 'Talents', test: (p, a) => p.wingSpan > 0 && canFly(a) },
  { id: 'charmer', title: 'Heart-stealer', hint: 'Huge eyes, round head, tufted tail…', section: 'Talents', test: (_p, a) => a.charm > 0.85 },
  { id: 'digger', title: 'Master digger', hint: 'Great diggers leave burrows to nap in.', section: 'Talents', test: (_p, a) => a.dig > 0.85 },
  { id: 'swimmer', title: 'Water baby', hint: 'Great swimmers dive for extra shells.', section: 'Talents', test: (_p, a) => a.swim > 0.8 },
];

export function discoveriesFor(p: BodyPlan, a: Abilities): string[] {
  return DISCOVERIES.filter((d) => d.test(p, a)).map((d) => d.id);
}

export const discoveryById = (id: string) => DISCOVERIES.find((d) => d.id === id);
