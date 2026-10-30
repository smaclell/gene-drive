# Gene Drive — Design

> A cozy 3D creature ranch where every animal is grown from a genome, bodies decide
> what creatures can do, and new forms arise through breeding and mutation.

This is a living document. It records the decisions made so far and the reasoning
behind them, so future sessions (human or AI) can extend the game without
re-deriving the vision. See [`ROADMAP.md`](ROADMAP.md) for what is built and what
is next.

## Inspiration and pitch

The creature creator in *Spore* was the best part of that game: you made a body,
and the body came alive. Gene Drive keeps that magic but moves it into a gentle
farming loop. You **rarely design creatures directly**. Instead you breed them,
watch mutations arise, and discover strange new forms over generations.

Chosen direction: a blend of three of the original concepts:

| Concept | What we take from it |
|---|---|
| **Gene Garden** (breeding ranch) | Diploid genomes, crossover, mutation, generations, lineage |
| **Workshop Farm** (bodies decide jobs) | Morphology → abilities → what the creature does on the ranch |
| **Sanctuary** (wild visitors) | Wild creatures wander in, bringing fresh and exotic genes |

### Concepts considered (October 2026)

1. **Gene Garden:** breeding ranch; villagers request traits; generational drift.
2. **Hatchery:** eggs incubated in different habitats hatch differently; the farm shapes evolution.
3. **Workshop Farm:** build creatures from parts; the body decides farm jobs.
4. **Sanctuary:** build habitats; wild procedural creatures visit, settle and interbreed.

Chosen: 1 + 3, with visitors from 4 for genetic diversity. Rendering is 3D
(three.js) for interactivity. Villager requests (from 1) and habitat-driven
hatching (from 2) remain good candidates for later.

## Audience and tone

- **Teenage complexity, fairly avid gamers.** Real genetic mechanics (dominant and
  recessive alleles, hidden carriers, mutation) are exposed. A curious player
  can read a genome and plan a breeding programme.
- **Cozy.** Nothing can fail, and no creature dies. An odd baby is a new friend,
  not a wasted turn. Gentle day/night cycle, soft colours, no timers that punish.

## Pillars

1. **Every creature is unique, and you can read why.** Bodies come entirely from
   the genome. No hand-authored models, so nothing is a reskin.
2. **Form follows function.** Long necks reach high fruit, big feet dig,
   tails and fins swim, wings fly. A mutation that changes shape changes what
   the creature *does*. That is what makes breeding meaningful.
3. **Discovery over design.** The creature lab exists, but rare traits (wings,
   glow) are locked until you breed them into existence. Creation is a reward for
   discovery.
4. **Simple systems, emergent variety.** Each system stays small: about 50 fixed
   genes plus a short list of composable sprouts, a handful of activities, four
   produce types. The variety comes from how they combine, and extreme values are
   allowed to look truly odd.
5. **Personality you can see and hear.** Gait, voice and a signature quirk come
   from genes too, so two creatures with similar bodies still feel different.

## Core loop

```
 creatures roam & work ──► produce (fruit, roots, nectar, shells)
        ▲                              │
        │                              ▼
  babies hatch ◄── eggs ◄── breed two creatures (costs a picnic of produce)
        │
        └─► new traits recorded in the Journal ─► unlock Lab sliders
                                                   │
   wild visitors arrive (charm helps) ─► welcome ─► new genes enter the herd
```

## Genetics

- **Genome = 48 named genes + a list of sprouts.** Each fixed gene is a pair of
  alleles (diploid), with each allele a float in `[0, 1]`. Definitions live in
  `src/genetics/genes.ts`. Sprouts are described below.
- **Expression modes** decide how the two alleles combine:
  - `blend`: average (size, length, most continuous traits)
  - `circular`: circular mean (hue, so red × red never becomes cyan)
  - `dominant`: max (high values win: pattern type, eye count, ear type)
  - `recessive`: min (trait only shows when *both* alleles are high: wings, glow,
    shell, twin tails, a second head)
- **Inheritance:** each parent passes one random allele per gene (Mendelian,
  independent assortment). Two carriers of wings can therefore have a winged
  child even though neither parent has wings.
- **Mutation:** each allele has a small chance to *drift* (Gaussian nudge) and a
  rare chance to *jump* to a random value (a "big mutation"). Mutations are
  reported to the player when an egg hatches.
- **Lab creatures are homozygous** (both alleles equal), so they breed true.
  Wild visitors are heterozygous and often carry hidden recessives.
- **Style genes use cut points, not even splits.** Dominant style genes (horns,
  mouth, tail shape, fluff, leg style, finish) have founders that are mostly low,
  so plain is common and fancy styles are rare finds.

### Sprouts: genes that grow and shrink

The fixed genes describe one body plan with set features. Sprouts add
**composable parts**: each sprout gene describes one spline-tube appendage
(where it grows, which way, length, thickness, curl, wiggle, tip, how many in a
row, and colour). Tips can be a bulb, claw, leaf, eye or puff.

- The list has a variable length (0–6). It is the only part of the genome that
  can grow or shrink.
- Each sprout is a dominant locus. A single copy (`dose` 1) passes to a baby
  half the time; a double copy (`dose` 2, e.g. Lab designs or two parents with
  the same sprout) always passes.
- Breeding can **copy** a sprout to a new spot, **lose** one, or rarely **invent**
  a brand-new one. These show up as mutations in the hatch report.
- Sprouts nudge abilities a little by tip: claws dig, leaves swim, bulbs, eyes
  and puffs charm.

### Size

`size` scales the whole skeleton (0.45× to 2.1×). Lengths in the body plan are
"shape units"; the skeleton applies size, so abilities that are about physics
follow it: reach grows with size, and flight gets harder (lift grows with span²,
mass with size³). Tiny creatures are also more charming.

## From genome to body

`genome → BodyPlan (phenotype) → Skeleton (anatomy) → meshes`

- `phenotype.ts` turns expressed gene values into real units: segment count, leg
  pairs (0–4), neck length, ear type, colours and so on.
- `anatomy.ts` lays out the skeleton in metres: spine curve, radius profile and
  cross-section, leg attach points, neck and head position, tail path, shell,
  tentacle skirt and sprout sites. It is pure math, so the same layout drives both
  the meshes and the ability scores.
- `creature/build.ts` builds three.js meshes from the skeleton: custom tubes and
  3D spline tubes for body, neck, tail, legs and sprouts, plus head, mouth, eyes,
  ears, horns, fluff, fins or sail, shell, wings and tail tips. Patterns, finishes
  (gradient, eye-spots), glow masks and iridescence are painted as vertex
  attributes, so a few shared toon materials serve every creature.
- `creature/motion.ts` animates the rig. Each gait returns body bob, roll, pitch,
  spine waves and an abstract swing and lift per leg; leg-style adapters turn
  those into joint rotations, so every gait works on every kind of leg. Spine
  waves bend the torso mesh and carry legs, fins and sprouts with it.

## Abilities (form follows function)

Computed in `src/genetics/abilities.ts` from the plan and skeleton. Strong
abilities unlock **signature moves**: sky-necks shake whole trees, great diggers
leave burrows (and nap in them), strong swimmers dive for extra shells, fast
creatures do zoomies, and strong fliers loop the loop.

| Ability | Driven by | On the ranch |
|---|---|---|
| Reach | head height (legs + neck + arch) | Picks fruit; taller trees need taller creatures |
| Dig | foot size, leg girth, snout, short legs | Digs roots in the soil patch |
| Swim | tail length, fins/spikes, short or no legs | Gathers shells in the pond |
| Fly | wing span vs body mass | Flies to flowers, gathers nectar, makes them bloom |
| Charm | big eyes, big head, tiny size, tufts, fluff, finishes | Visitors come a little more often |
| Speed | leg length × energy, gait, tail, shell | Moves faster |
| Glow | recessive glow gene | Lights up at night |

## Ranch systems

- **World:** a procedural meadow (value-noise terrain), a pond, a tilled soil
  patch, bushes and trees with fruit at different heights, flower patches, a
  cottage and a fence ring. Day/night cycle about 6 minutes long.
- **Behaviour:** a small task machine per creature (wander, idle, forage, dig,
  swim, fly, nap, follow-a-friend, quirk, zoomies). Task choice is weighted by
  abilities and temperament genes (energy, sociability, curiosity). Each creature
  has a signature quirk, a favourite food (sometimes a bonus when it gathers it)
  and a favourite nap spot near that food.
- **Voices:** short procedural WebAudio calls. Bigger creatures sound deeper.
  Quiet, distance-faded and rate-limited; a mute button sits in the top bar.
- **Breeding:** select a creature, choose *Breed*, then pick a partner from the
  list in the panel (or click one in the meadow). The list shows each partner's
  baby odds, sampled by breeding the pair a few hundred times in memory. It costs
  a small picnic of produce. An egg appears, wobbles and hatches into a baby that
  grows up in under two minutes.
- **Wild visitors:** every few minutes a wild creature wanders in, drawn from a
  themed gene pool (Meadow, Marsh, Highland, Burrow, Sky, Glimmer, Reef, Grove,
  Dune, Curio). Curios push random genes to extremes. Welcome it with produce or
  let it wander off. How often they come is a setting in Help.
- **Camera:** map-style. Drag pans the ground, right-drag turns, the wheel zooms
  and tilts. Moving the camera yourself always ends follow mode.
- **Journal:** a codex of discovered traits (legless, eight legs, cyclops,
  wings, glow…). Some discoveries unlock Lab sliders.
- **Lab:** a Spore-style creator with sliders over designable genes and a live
  preview. Costs produce (the first design is free).
- **Persistence:** autosaves to `localStorage`.

## Art direction

- Soft toon shading (three-step gradient), low-poly flat-shaded terrain.
- Everything is procedural: no image or model assets. Anything that must be
  authored (palettes, name syllables, visitor themes) lives in code next to the
  system that uses it.
- Emoji floating labels for feedback (🍎 +1, 💤, ❤️, ✨).

## Open questions

- Should produce have recipes (specific mixes for breeding or lab), or stay a
  single "picnic" pool?
- Should genes be linked on chromosomes, so traits travel together?
- Biomes or expansion areas beyond the starting meadow?
- Creature "jobs" that combine abilities (a winged digger?) and ranch upgrades.
- How far should sprouts go? Today they are cosmetic with small ability nudges.
  They could become real tools (grabbing, spotting, swimming) or even replace
  some fixed genes, making more of the body composable.
