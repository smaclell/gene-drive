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

- **Genome = 56 named genes + a list of sprouts.** Each fixed gene is a pair of
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
  pairs (0–4), arm pairs (0–2), posture, neck length, ear type, a palette and so on.
- `anatomy.ts` lays out the skeleton in metres: a spine walked out from the tail
  (arch plus posture tilt), radius profile and cross-section, back normals, leg and
  arm attach points, neck and head position, tail path, shell, tentacle skirt and
  sprout sites. It is pure math, so the same layout drives both the meshes and the
  ability scores.
- `creature/build.ts` turns the skeleton into bones, **skin** and **rigblocks**
  (see "Bodies, after Spore" below). Patterns, finishes, glow masks and
  iridescence are painted as vertex attributes, so a few shared materials serve
  every creature.
- `creature/motion.ts` animates the bones. Each gait returns body bob, roll, pitch,
  spine waves, a roll-and-tuck amount and an abstract swing and lift per leg;
  leg-style adapters turn those into joint rotations, so every gait works on every
  kind of leg. Arms are posed from what the creature is doing (walking, foraging,
  digging, waving, dancing). Tails are bone chains, so wags curve.

### Bodies, after Spore

Spore's creature creator is the inspiration, and three of its ideas carry over:

1. **One continuous skin.** Spore wraps the spine and limbs in a single blobby
   surface. Here every soft part is a *blob* (a tapered capsule or an ellipsoid);
   blobs are joined with a smooth minimum of their distance fields, so a thigh
   swells into a haunch and a neck flows into a head. The field is meshed with
   surface nets, and each vertex is weighted to the bones of the blobs near it, so
   the whole body is one `SkinnedMesh` that bends at every joint.
2. **Rigblocks.** Eyes, ears, horns, beaks, fins, wings, shells and sprouts are
   separate parts riding on the bones, like Spore's parts snapped onto the skin.
3. **Layered paint.** Spore paints a base colour, a coat and a detail pattern.
   Here: a base, a darker coat over the back, a pattern colour (round cellular
   spots, giraffe patches with pale seams, or bands that taper toward the belly
   and become rings on tails), a pale belly and darker "points" on hands and feet.
   Paint follows the body: each skin vertex knows which part it is on, how far
   along it, and whether it faces up or down, and colours cross-fade where parts meet.
   Spore paints into an automatic UV map; with no UVs at all, each vertex here stores
   the colour without the pattern, what the pattern adds, and a signed "mark" field
   that the shader thresholds per pixel, so markings have crisp edges. A fourth,
   fine layer (velvet, scales or pebbles) is a height field evaluated in the shader
   in the skin's rest pose, used as a bump map. Creases darken by ambient occlusion
   read off the same distance field that built the skin.
4. **A spine of metaballs.** In Spore you grow or shrink each vertebra. Here the
   torso radius along the spine is a profile: taper, lumps and a waist pinch reshape
   it, a belly blob can hang under it, and the head is several blobs (cranium, cheeks,
   brows) with a snout built as a chain of tapered segments along a curve.

### Body plans

Four legs walking was the most common creature, so body plans now branch more:

- **Arms** (dominant, about 30% of founders): one or two pairs on the chest that
  never touch the ground. Hands are paws, talons (dig) or pincers (rarest, they
  snip). Arms raise *reach*, swing while walking, reach up when foraging, paddle
  when digging, wave when happy and dance.
- **Posture:** bipeds range from a forward lean (a bird or a T. rex) to upright
  (a penguin or a person); four-legged backs slope a little either way; legless
  bodies can rear up at the front like a cobra.
- **Roll:** round, compact bodies and shelled creatures may tuck in and roll.
- **Float:** tentacled creatures may hover and drift like jellyfish.
- Leg pair cut points were rebalanced, so bipeds and six-legged creatures are
  more common and quadrupeds are just under half.

Even so, herds read as horses and dogs: horizontal sausage bodies on thin legs with
a neck in front. So silhouettes now vary more (Milestone 5):

- **Rounder bodies, sturdier legs:** the everyday body is a bean rather than a
  sausage, and leg thickness is sized against the body it carries.
- **Waist:** pinches the torso into two lobes. With a heavy rear the legs gather on
  the front lobe, like an insect's thorax, and get slender (Hive visitors).
- **Belly:** a round belly under the middle: hippos, bears, penguins.
- **Sunk heads:** the bottom of the neck gene melts the head into the front of the
  body, face showing, like a frog or a pufferfish (Bog visitors).
- **Centaurs:** the top of the posture gene rears up the chest of a body on two or
  more leg pairs; the legs gather under the back half and the arms stay free.
- **Muzzle:** pointed snouts taper and hook down; blunt ones swell into a pig nose.

## Abilities (form follows function)

Computed in `src/genetics/abilities.ts` from the plan and skeleton. Strong
abilities unlock **signature moves**: sky-necks shake whole trees, great diggers
leave burrows (and nap in them), strong swimmers dive for extra shells, fast
creatures do zoomies, and strong fliers loop the loop.

| Ability | Driven by | On the ranch |
|---|---|---|
| Reach | head or hand height (legs + neck + arch + posture + arms) | Picks fruit; taller trees need taller creatures |
| Dig | foot size, leg girth, snout, short legs, talons or pincers | Digs roots in the soil patch |
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

- The world: soft toon shading (three-step grey ramp) on trees and props; smooth
  terrain coloured at two scales with a worn path; grass tufts tinted by the ground
  that sway in waves of wind; slow cloud shadows; a pond with clear shallows, a foam
  line and glinting ripples; soft-edged shadows.
- Creatures: smooth blobby skin with their own soft ramp (violet-tinted shadows,
  warm lights), a rim light so they stand out from the grass, a little gloss like a
  vinyl toy, and a thin ink outline in a darker shade of the skin.
- Colour: the hue gene is free, but saturation and lightness stay in a pleasant
  band, yellows are lifted, pattern colours always have clear value contrast with
  the body, and grass greens are half as common as other hues so creatures do not
  vanish into the meadow. Eyes have a coloured iris (darker at the rim) that contrasts
  with the body, two catchlights, a lid in the skin colour (heavier on sleepy
  creatures) and a smile. All eyes look at one point ahead of the face, so the gaze
  is friendly rather than wall-eyed.
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
