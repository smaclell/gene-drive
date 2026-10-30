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

## ✅ Milestone 2: more distinct, odder creatures (done)

**Silhouette and composable parts**
- [x] Size gene (0.45–2.1×): scales the whole skeleton, so reach and mass follow; tiny creatures fly and charm better
- [x] Wider ranges on existing genes (legs, necks, heads, girth, arch, taper) for truly odd shapes
- [x] Lumpiness: smooth bodies to caterpillar strings of beads
- [x] Body cross-section (flat as a ray … tall and narrow) and a recessive shell dome with plates
- [x] Tail shapes: whip, curl, club, fan; recessive twin tails
- [x] Head shapes (frog-flat … horse-long), mouths (beak, jaws, tusks), trunks at very long snouts
- [x] Horns: spiral unicorn horn, curled ram horns, branching antlers; axolotl frills replace the old ear horns
- [x] Fluff: back tufts, mane, neck frill, head crest; tall back fins join into a sail
- [x] Eye stalks; a recessive second head
- [x] Leg styles: backward (digitigrade) knees, splayed beetle legs, tentacles; legless + tentacles walk on a skirt of them
- [x] Skin finishes: two-tone gradient, eye-spots, iridescent sheen (shader), see-through jelly
- [x] **Sprouts**: a variable-length list of spline-tube parts (tendrils, stalks, spines) with tips
      (bulb, claw, leaf, eye, puff). Breeding can copy, lose or invent sprouts, so the genome grows and shrinks.

**Personality and movement**
- [x] Ten gaits chosen by gene and body: trot, hop, waddle, prance, scuttle, bound, slither, inch, bounce, creep
- [x] Spine bending (slither S-waves, inchworm humps, bounding flex) that carries legs and fins along
- [x] Voice: procedural WebAudio calls (honk, coo, chirp, trill); pitch follows size; mute button
- [x] Quirks: signature idles (stretch, chase tail, twirl, dance, roll over, sing), favourite food and nap spot
- [x] Signature moves: sky-necks shake trees, great diggers leave burrows and nap in them, swimmers dive for
      shells, speedsters do zoomies, strong fliers loop the loop

**Quality of life**
- [x] Visitors come less often (about every 2½–4 minutes) and stay longer; Help has a Never/Rarely/Sometimes/Often setting
- [x] Breeding picker in the creature panel, with baby odds ("wings 25%", "4 legs 52%") for each partner
- [x] Cheaper picnics, shorter rests, quicker hatching and growing, herd cap 30; herd list picks partners too
- [x] Map-style camera: drag pans, right-drag/Q/E turns, wheel/pinch zooms, WASD pans, Home recentres
- [x] Click a creature to say hi (it answers and shows off its quirk); toasts with "Take a look"
- [x] Journal in sections, with 58 entries including one per gait
- [x] Lab: partly locked sliders, sprout tools, gait preview
- [x] Gallery: `set=`, `sprouts=` and `walk=1` for tuning

## ✅ Milestone 3: awesome creatures (done)

**Spore-style bodies**
- [x] Metaball skin: torso, neck, head, snout, tail, legs, feet, arms and hands are blobs melted together
      (smooth-min distance field, surface nets) into one `SkinnedMesh` bound to bones; joints never show
- [x] Rigblocks (eyes, ears, horns, beaks, fins, wings, shells, sprouts) ride on bones
- [x] Bones everywhere: spine bones for bending, three-bone tail chains (wags curve), neck and head bones
- [x] Layered paint: base, coat over the back, detail pattern, pale belly, darker hands and feet, cross-faded at joins;
      cellular spots and giraffe patches; stripes that taper toward the belly and ring the tail
- [x] Palettes with real value contrast, lifted yellows, fewer grass-green creatures, contrasting irises
- [x] Look: soft violet-tinted light ramp, rim light, gloss, ink outline; eyes with irises, lids and a smile

**More kinds of body**
- [x] Arms (0–2 pairs) with paws, talons or pincers; they swing, reach for fruit, dig, wave, dance and snip
- [x] Posture gene: leaning or upright bipeds, sloped backs, rearing legless bodies
- [x] Roll gait (round bodies and shells tuck in and tumble) and float gait (tentacled drifters)
- [x] Rebalanced leg pairs: fewer quadrupeds, more bipeds and six-legged creatures
- [x] Journal: Arms, Four arms, Talons, Pincers, Upright, Rearing, Roller, Floater; Lab locks four arms and pincers
- [x] Visitors: Reef carries pincers, Burrow carries talons, Sky visitors stand upright, Dune visitors roll

## 🎯 Next (pending a choice)

1. **Sprouts that do things:** sprouts that grab fruit, eye-sprouts that spot visitors early, leaf sprouts that photosynthesise.
2. **Lab sprout editor:** pick a sprout and drag its site, curl and length, rather than reroll.
3. **Family tree viewer**, so lineages of odd traits are easy to follow.
4. **Produce recipes:** treats that raise the sprout or mutation rate for one picnic.
5. **Hands that hold things:** carry fruit back, hug friends, or (pincers) trim flowers.
6. **Skin performance:** build the skin in a worker or cache it, so big herds load instantly.

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

- Building a creature's skin takes about 80 ms, so a full herd of 30 adds a couple of seconds to loading
  and the Lab redraws a little slowly while dragging.
- Patterns are painted per vertex, so very small spots or thin stripes are soft rather than crisp.
- Arms can pass through the body or each other in some poses (no collision).
- The ink outline and rim light only cover the skin, not rigblocks such as horns and ears.
- Changing leg pair cut points and palettes changed how some existing saved creatures look (genomes are unchanged).
- Creatures walk through trees and the cottage (no obstacle avoidance yet).
- Legs do not plant on slopes (no IK); on hills, feet can float or sink a little.
- Very large or extreme creatures can overlap neighbours; personal space uses a rough radius.
- Second heads and twin tails share one neck/tail animation, offset only by yaw.
- Jelly creatures are transparent, so their parts can sort oddly from some angles.
- Balance numbers (costs, timings, yields) are still first guesses; produce piles up quickly with a big herd.
