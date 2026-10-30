import { pick, type Rng } from '../core/rng';

/** Soft, two- or three-syllable names. Babies borrow a syllable from each parent. */

const STARTS = ['bo', 'mi', 'pu', 'ta', 'lu', 'ki', 'no', 'fe', 'zu', 'ri', 'mo', 'pa', 'su', 'wi', 'ga', 'do', 'ne', 'ju', 'ha', 'yo'];
const MIDDLES = ['ra', 'li', 'mu', 'po', 'ki', 'na', 'te', 'shi', 'ro', 'bi', 'lo', 'vi', 'ma', 'du', 'fi'];
const ENDS = ['n', 'by', 'kin', 'mo', 'pip', 'lo', 'ru', 'ni', 'ka', 'bun', 'sy', 'to', 'mi', 'zle', 'wick'];

const syllablesOf = (name: string) => name.toLowerCase().match(/[^aeiouy]*[aeiouy]+(?:n(?![aeiouy]))?/g) ?? [name.toLowerCase()];

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function randomName(rng: Rng): string {
  const parts = [pick(rng, STARTS)];
  if (rng() < 0.6) parts.push(pick(rng, MIDDLES));
  parts.push(pick(rng, ENDS));
  return capitalise(parts.join(''));
}

export function childName(rng: Rng, mother: string, father: string): string {
  const a = syllablesOf(mother);
  const b = syllablesOf(father);
  const first = rng() < 0.5 ? a[0] : b[0];
  const second = pick(rng, rng() < 0.5 ? a.slice(1).concat(b.slice(1)) : MIDDLES);
  const name = first + (second ?? '') + (rng() < 0.45 ? pick(rng, ENDS) : '');
  return capitalise(name.length < 3 ? name + pick(rng, ENDS) : name.slice(0, 10));
}
