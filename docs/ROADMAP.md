# Gene Drive — Roadmap

Status of the game and the queue of ideas. Update this file when you finish or
start something, so the next session knows where things stand.
See [`DESIGN.md`](DESIGN.md) for the vision and reasoning.

## ✅ Milestone 1: playable breeding ranch (done)

- [x] Diploid genome (~30 genes), expression modes, crossover, drift and jump mutations
- [x] Genome → body plan → skeleton → procedural three.js meshes (no assets)
- [x] Patterns (spots, patches, stripes, belly shading) and night glow baked into vertex attributes
- [x] Abilities from body shape: reach, dig, swim, fly, charm, speed
- [x] Procedural meadow: terrain, pond, soil patch, fruit trees at three heights, flowers, cottage, fence
- [x] Day/night cycle with stars and glowing creatures
- [x] Creature behaviour: wander, idle, forage, dig, swim, fly/pollinate, nap, visit friends, babies follow parents
- [x] Procedural animation: gaits for 0–4 leg pairs, wings, tail wag, blinking, head look, nap pose
- [x] Breeding with a produce cost, eggs, hatching, growth, hatch report ("Surprise: wings!")
- [x] Wild visitors from themed gene pools (Meadow, Marsh, Highland, Burrow, Sky, Glimmer)
- [x] Journal of 16 discoveries; discoveries unlock Lab sliders (wings, glow)
- [x] Creature Lab with live preview (homozygous, true-breeding designs)
- [x] HUD: resources, creature panel with abilities and allele view, herd list, toasts, help
- [x] Autosave to localStorage
- [x] Creature gallery page (`gallery.html`) for tuning the generator
- [x] GitHub Pages deploy workflow and PR CI

## 🎯 Milestone 2: more distinct creatures (next, pending a choice)

Today, creatures vary most in colour, pattern, leg count, proportions and ears.
These additions would make silhouettes and personalities read differently at a
glance. They are ordered by impact for effort.

**Silhouette**
1. **Overall size gene**: tiny to huge. The single biggest at-a-glance difference; also feeds reach and mass.
2. **Tail types**: whip, club, fan, curl, double tail (dominant/recessive mix).
3. **Head shapes**: round, long (horse), flat (frog), crested; plus jaws, beaks and tusks.
4. **Fluff/mane**: fur tufts along the spine or neck, or a neck frill.
5. **Horn styles**: branching antlers (procedural L-system), curled ram horns, a single unicorn horn.
6. **Body cross-section**: flat (turtle, ray) vs tall and narrow; optional shell dome.
7. **Leg styles**: backward-bending (digitigrade) knees, splayed insect legs, tentacles for legless creatures.
8. **Skin finishes**: gradients, eye-spots, iridescence, translucent jelly.

**Personality and movement**
9. **Gaits** chosen by genes: hop, waddle, slither, prance, scuttle.
10. **Voice**: procedural chirps (WebAudio), with pitch tied to size.
11. **Quirks**: favourite food or nap spot, signature idle (stretch, chase tail, spin).
12. **Signature moves** tied to abilities: sky-necks shake trees, diggers leave burrows.

## 🌱 Later ideas

- Produce recipes: specific mixes for breeding, the Lab or treats that boost mutation
- Gene linkage on chromosomes, so traits travel together
- Family tree viewer and lineage stats
- Ranch upgrades: bigger fence, more ponds, greenhouse, mutation garden
- Creature jobs that combine abilities (a winged digger?)
- Seasons and weather that shift which abilities shine
- Photo mode and sharing a creature as a code (genome string)
- Biomes beyond the meadow, reached through the gate

## Known rough edges

- Creatures walk through trees and the cottage (no obstacle avoidance yet).
- Long tails can clip into the ground on very low bodies.
- Wings fold upright at rest and can read as ears from some angles.
- Balance numbers (costs, timings, yields) are first guesses.
