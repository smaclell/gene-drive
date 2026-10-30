import { clamp01 } from '../core/rng';
import type { Skeleton } from './anatomy';
import type { BodyPlan, Gait } from './phenotype';

/**
 * Form follows function: abilities are read off the body, never rolled.
 * Scores are in [0, 1]. Behaviour and ranch rewards read these.
 */

export type AbilityId = 'reach' | 'dig' | 'swim' | 'fly' | 'charm' | 'speed';

export interface AbilityInfo {
  label: string;
  icon: string;
  blurb: string;
}

export const ABILITIES: Record<AbilityId, AbilityInfo> = {
  reach: { label: 'Reach', icon: '🍎', blurb: 'Picks fruit. Taller creatures reach higher branches.' },
  dig: { label: 'Dig', icon: '🥕', blurb: 'Digs roots in the soil patch. Big feet and snouts help.' },
  swim: { label: 'Swim', icon: '🐚', blurb: 'Finds shells in the pond. Long tails and fins help.' },
  fly: { label: 'Fly', icon: '🍯', blurb: 'Needs wings big enough for its body. Gathers nectar.' },
  charm: { label: 'Charm', icon: '💖', blurb: 'Big eyes and round faces draw in wild visitors.' },
  speed: { label: 'Speed', icon: '💨', blurb: 'Long legs and lots of energy.' },
};

export const ABILITY_IDS = Object.keys(ABILITIES) as AbilityId[];

export type Abilities = Record<AbilityId, number>;

/** Below this, wings are just for show: the creature flutters but cannot take off. */
export const FLIGHT_THRESHOLD = 0.3;

export const GAIT_SPEED: Record<Gait, number> = {
  walk: 0, hop: 0.08, waddle: -0.1, prance: 0.08, scuttle: 0.1, bound: 0.12, slither: 0.04, inch: -0.08, bounce: 0.02, creep: -0.04,
};

export function computeAbilities(p: BodyPlan, s: Skeleton): Abilities {
  const hasLegs = p.legPairs > 0;
  // Each sprout tip nudges one ability a little.
  const tips = (tip: string) => Math.min(0.15, p.sprouts.filter((s) => s.tip === tip).length * 0.05);
  const shortLegs = hasLegs ? clamp01(1 - (p.legLength - 0.22) / 1.2) : 1;
  const flat = clamp01((p.bodyWidth - 0.95) / 0.55);
  const tiny = clamp01((1 - p.size) / 0.45);
  const big = clamp01((p.size - 1) / 0.7);

  // Reach is in real metres, so size matters most here.
  const reach = clamp01((s.reach - 0.7) / 4.6);

  const dig = clamp01(
    (hasLegs
      ? 0.45 * clamp01((p.footSize - 0.6) / 1.1) + 0.2 * clamp01((p.legGirth - 0.05) / 0.15) + 0.2 * clamp01(p.snout / 0.65) + 0.15 * shortLegs + 0.05 * (p.legPairs - 1)
      : 0.15 + 0.3 * clamp01(p.snout / 0.65))
    + (p.mouth === 'tusks' ? 0.15 : p.mouth === 'jaws' ? 0.06 : 0)
    + (p.tailShape === 'club' ? 0.05 : 0) + (p.snout > 0.75 && p.mouth === 'plain' ? 0.06 : 0)
    + 0.08 * big + tips('claw'),
  );

  const swim = clamp01(
    0.35 * clamp01(p.tailLength / 2.2) + 0.25 * clamp01(p.spikes / 1.3) + 0.25 * shortLegs + (hasLegs ? 0 : 0.2) + 0.1 * clamp01(p.bodyLength / 3.2)
    + (p.tailShape === 'fan' ? 0.18 : 0) + (p.twinTail ? 0.06 : 0) + 0.1 * flat + (p.shell ? 0.08 : 0) + (p.legStyle === 'tentacles' ? 0.15 : 0) + tips('leaf'),
  );

  // Lift scales with span squared; mass scales with volume. Both in real units, so tiny fliers win.
  const span = p.wingSpan * p.size;
  const fly = span > 0 ? clamp01((span * span) / (s.mass * 9 + 1.2) - 0.05) : 0;

  const headRatio = p.headSize / Math.max(0.3, p.girth);
  const earBonus = p.earType === 'round' || p.earType === 'long' ? 0.12 : p.earType === 'antennae' || p.earType === 'frills' ? 0.06 : 0;
  const finishBonus = p.finish === 'iridescent' ? 0.08 : p.finish === 'jelly' ? 0.06 : p.finish === 'eyespots' ? 0.04 : 0;
  const fluffBonus = p.fluff === 'none' ? 0 : p.fluff === 'tufts' || p.fluff === 'mane' ? 0.08 : 0.05;
  const charm = clamp01(
    0.35 * clamp01((p.eyeSize - 0.12) / 0.3) + 0.25 * clamp01((headRatio - 0.4) / 1.2) + earBonus + (p.tailTuft ? 0.12 : 0) + (p.glow ? 0.1 : 0)
    + 0.08 * (p.pattern === 'spots' ? 1 : 0) + 0.15 * tiny + finishBonus + fluffBonus + (p.tailShape === 'curl' ? 0.08 : 0) + (p.horns === 'unicorn' ? 0.06 : 0) + (p.twinHead ? 0.1 : 0) + (p.eyeStalks > 0 ? 0.05 : 0)
    + tips('bulb') + tips('eye') + tips('puff'),
  );

  const legReach = p.legLength * p.size;
  const speed = clamp01(
    (hasLegs ? 0.15 + 0.55 * clamp01((legReach - 0.22) / 1.48) : 0.08) + 0.3 * p.energy + GAIT_SPEED[p.gait]
    + (p.tailShape === 'whip' ? 0.05 : 0) - (p.shell ? 0.12 : 0),
  );

  return { reach, dig, swim, fly, charm, speed };
}

export const canFly = (a: Abilities) => a.fly >= FLIGHT_THRESHOLD;

/** 0–5 stars for display. */
export const stars = (score: number) => Math.round(score * 5);
