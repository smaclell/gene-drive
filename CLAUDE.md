# CLAUDE.md

Orientation for AI sessions (and humans) working on Gene Drive, a cozy 3D
creature ranch where every creature is grown from a genome.

- Vision and reasoning: [`docs/DESIGN.md`](docs/DESIGN.md)
- What's done and what's next: [`docs/ROADMAP.md`](docs/ROADMAP.md). Update it when you finish work.

This file is meant to be enough to start working **without reading the whole
codebase**. Find the task in "Where to change things", open only the files it
names, and read their header comments first.

## Workflow

- **No pull requests for now.** Commit and push straight to `main` (the owner asked for this).
- Before pushing: `npm test` and `npm run build` (which typechecks).
- For anything visual, check it in the gallery or the game (see "Debugging").

## Commands

```bash
npm install
npm run dev        # Vite dev server (game at /, creature gallery at /gallery.html)
npm test           # Vitest: genetics, anatomy, abilities, sprouts, odds, names, reports, sound
npm run typecheck
npm run build      # Typecheck and production build to dist/
```

Deployment: `.github/workflows/pages.yml` builds and publishes `dist/` to GitHub
Pages on every push to `main`. `.github/workflows/ci.yml` runs tests and a build
on pull requests.

## Data flow

```
Genome ─ 56 fixed genes (allele pairs) + sprouts (variable-length list)
  │ express()                       genetics/genome.ts
  ▼
BodyPlan ─ shape units, discrete styles, gait, voice, quirk   genetics/phenotype.ts
  │ buildSkeleton()                 genetics/anatomy.ts  (applies size → metres)
  ▼
Skeleton ─ positions in metres ──► computeAbilities()   genetics/abilities.ts
  │ buildCreature()                 creature/build.ts: bones + skin blobs + rigid parts
  │ buildSkin()                     creature/skin.ts: blobs → one smooth SkinnedMesh
  ▼
CreatureRig ─ bones + meshes ──► animate() each frame  creature/motion.ts
```

Like Spore, a body is **skin plus rigblocks**. The skin (torso, neck, head,
snout, tail, legs, arms, feet, hands) is a set of blobs melted together by a
smooth-min distance field and meshed with surface nets into one `SkinnedMesh`,
weighted to a bone hierarchy. Eyes, ears, horns, beaks, fins, wings, shells and
sprouts are ordinary meshes parented to those bones.

Meshes and abilities read the same skeleton, so what a creature looks like is
what it can do. `sim/creature.ts` decides *what* a creature does; `motion.ts`
decides *how it looks* doing it.

## Code map

```
src/
  core/        rng.ts (seeded PRNG + math), noise.ts (value + cellular noise)        — no three.js
  genetics/                                                                           — no three.js, unit tested
    genes.ts        GENES catalogue: expression mode, founder distribution, Lab lock
    genome.ts       Genome type, express, breed (Mendel + mutation), save revival
    sprouts.ts      variable-length "sprout" genes: inherit, copy, lose, invent, describe
    phenotype.ts    BodyPlan: genes → shape units and styles; gaitFor(); describePlan()
    anatomy.ts      Skeleton: spine (with posture tilt), back normals, neck, head, tail path, legs, arms,
                    tentacles, shell, sprout sites
    abilities.ts    reach/dig/swim/fly/charm/speed from plan + skeleton
    discoveries.ts  Journal entries (sections, tests); some unlock Lab sliders
    report.ts       hatch report, trait words, offspringOdds() for the breeding picker
    names.ts
  creature/
    build.ts        skeleton → bones, skin blobs and rigid parts. Paint layers, helpers, one builder
                    per part, then buildCreature() (meshes the skin, binds it, wires spine bending)
    skin.ts         metaball skin: SDF blobs, smooth union, surface nets, bone weights, paint coords, baked AO
    motion.ts       gaits (incl. roll, float), leg-style adapters, arms, tail chains, quirks, wings, blinking
    materials.ts    shared creature materials: tinted soft ramp, rim light, gloss, glow, sheen, ink outline,
                    crisp pattern edges (per-pixel `mark`), skin textures as shader bumps (`skinMaterial`)
  world/       layout.ts (terrain height, landmarks), surface.ts (terrain colour, swaying grass, pond shader,
               cloud shadows), scenery.ts (trees, fruit, flowers, burrows, cottage, fence), sky.ts
  sim/
    creature.ts     one creature: task machine (forage, dig, swim, fly, nap, quirk, zoom…), signature moves
    ranch.ts        herd, eggs, breeding, visitors, settings, saves; the UI talks to this
    visitors.ts     themed gene pools (Meadow … Curio)
    voice.ts        creature calls; pitch from size, timbre from the voice gene
    audio.ts        sound engine: one AudioContext, a bus per group (ambience, music, creatures, chimes), reverb,
                    limiter, master mute, distance fade and pan; shared noise, tone and pluck instruments
    sound.ts        owns the engine, voices, sfx, ambience and music; main calls `update()` once a frame
    ambience.ts     day/night bed: breeze, leaves, pond water by distance, birds, crickets, frogs, owl
    music.ts        generative pentatonic pieces with long rests (pure, tested `composePiece`) and playback
    sfx.ts          creature sounds (steps by gait, splashes, digging, rustles…) and chimes (hatch, discovery, UI)
    effects.ts      emotes, particles, water ripples, selection rings
  ui/          hud.ts (top bar, creature panel, partner picker, drawers, toasts), lab.ts,
               camera.ts (map-style camera), dom.ts, style.css
  main.ts      renderer, camera, picking, keyboard, main loop
  gallery.ts   grid of creatures for tuning (see Debugging)
```

## Units (the most common source of bugs)

- `BodyPlan` lengths are **shape units** for a size-1 creature. `plan.size` (0.45–2.1) scales everything.
- `Skeleton` is in **metres**: `buildSkeleton` multiplies by size. `skel.scale === plan.size`.
- In `build.ts`, a plan length used directly must be multiplied by `skel.scale` (`ctx.k`).
- Abilities: reach and flight use real units (so size matters), the rest mostly use shape.
- Thresholds in `describePlan` and discoveries use shape units, so they mean the same at any size.

## Where to change things

- **Add a fixed gene:** add it to `GENES` in `genetics/genes.ts` (pick an expression; give rare styles a
  `founder` that is mostly low), read it in `phenotype.ts`, then use it in `anatomy.ts` / `build.ts` /
  `abilities.ts`. Add a word to `traitsOf()` in `report.ts` if it is a discrete trait (and to `DISCRETE` there).
  Old saves keep working because `reviveGenome` fills missing genes. Add a test.
- **Add a body part:** write a `buildX(ctx, …)` function in `build.ts` beside the others and call it from
  `buildCreature`. Decide whether it is **skin** or a **rigblock**:
  - Skin: create bones with `addBone()` (rest rotation 0 unless it is a base yaw), then add blobs with
    `capsule()` / `blobEllipsoid()` in creature space (`at(bone, x, y, z)` converts). A blob's `chain` lists
    the bones it bends with, `u0`/`u1` place it along them, `blend` is how softly it melts in, and `region`
    picks the paint rules. Bones must exist before `buildSkin` runs at the end of `buildCreature`.
  - Rigblock: build a geometry, `paint()` it (or set `color`, `glow` and `sheen` yourself), wrap it with
    `ctx.mesh()` so it is disposed, and add it to a bone.
  Parts that move get a field on `CreatureRig`, which `motion.ts` animates.
- **Add a gait:** add it to `Gait` and `GAIT_LABEL` in `phenotype.ts`, list it in `gaitFor()` for the bodies
  that allow it, add a case to `gaitFrame()` and `GAIT_CADENCE` in `motion.ts`, speed in `GAIT_SPEED`
  (`abilities.ts`), and a Journal entry. Check it with `gallery.html?walk=1`.
- **Add a sprout tip or site:** `sprouts.ts` (expression and words), `layoutSprouts()` in `anatomy.ts`
  (where it attaches), `buildSprout()` in `build.ts` (the mesh).
- **Add a quirk or signature move:** `Quirk`/`QUIRK_LABEL` in `phenotype.ts` or `ActionKind` in `motion.ts`;
  the pose in `animate()`; when it triggers in `sim/creature.ts` (`chooseTask`, `perform`, `finish`).
- **Add a discovery:** add it to `DISCOVERIES` with a section; gate a Lab slider with `unlockedBy`
  (and optionally `lockedMax` to lock only the top of the range). Never rename an id: they are saved.
- **Add a visitor theme:** `VISITOR_THEMES` in `sim/visitors.ts`. A function bias rolls a new bias per visitor.
- **Tune balance:** costs and timers are constants at the top of `sim/ranch.ts` and `sim/creature.ts`.
- **Add a sound:** a creature sound is an entry in `CREATURE` in `sim/sfx.ts` plus `ctx.sound(this, kind)` at the
  event in `sim/creature.ts`; an event or UI sound is an entry in `CHIME`, played with `ranch.sound.sfx.chime()`.
  Rate-limit it (`gap`) and keep it soft: levels are set by measuring offline renders (see Debugging).

## Conventions

- **Everything is procedural.** No image, model or sound assets. Authored data
  (palettes, syllables, themes, phrases) lives in code beside the system that uses it.
- **Keep `core/` and `genetics/` free of three.js** so they stay fast to test in Node.
- Colour, glow and sheen live in vertex attributes (`color`, `glow`, `sheen`, plus the pattern's
  `paintDelta` and `mark`); every creature geometry gets them from `setSkinAttributes` in `build.ts`,
  because creatures share a few materials. Only the skin mesh has `grain` (its texture frequency).
- Skin build time is the main cost of making a creature (≈80 ms): grid spacing is chosen in
  `buildCreature` from the creature's size. Blobs thinner than a cell are thickened, not dropped.
- Arms never touch the ground (anatomy shortens or raises them), so they can swing, reach and wave freely.
- Behaviour uses `Math.random`. Genetics takes an explicit `Rng` so it is reproducible.
- Cozy tone: no failure states, no deaths, gentle copy. UK/Canadian spelling in
  player-facing text ("colour").

## Debugging and verification

- `window.geneDrive` exposes `{ ranch, game, scene, camera }` in the browser console, e.g.
  `geneDrive.ranch.spawnVisitor()`, `geneDrive.ranch.resources.fruit += 50`,
  `geneDrive.ranch.journal.add('sprouted')`, `geneDrive.game.meet(geneDrive.ranch.creatures[0])`.
- To exercise behaviour fast, call `geneDrive.ranch.update(0.05, false)` in a loop from the console.
- Sound lives in `geneDrive.ranch.sound` (`engine`, `voices`, `sfx`). It starts on the first click or key press.
  To check levels without ears, attach an `AudioEngine` to an `OfflineAudioContext` with `engine.attach(ctx, true)`,
  drive `Ambience`/`Music` from `ctx.suspend(t)` callbacks, render and measure peaks. Targets at default volume:
  ambience bed peaks near -27 dBFS (short-term RMS under -35), music near -26, chimes -24 to -40, creature sounds
  -29 to -40 up close, voices about -17 when poked.
- The save lives in `localStorage` under `gene-drive-save-v1` and settings under
  `gene-drive-settings-v1`; "Start a new ranch" in Help resets the save only.
- **Gallery** (`/gallery.html`): `?seed=&count=&theme=` picks creatures; `set=horns:0.95,legPairs:0.05`
  (handy: `set=arms:0.95,legPairs:0.25,posture:0.9` upright four-armed bipeds;
  `set=girth:0.9,bodyLength:0.15,gait:0.99` rollers; `set=legPairs:0.02,legStyle:0.95,gait:0.99` floaters;
  `set=posture:0.97,legPairs:0.55,arms:0.8` centaurs; `set=waist:0.97,taper:0.1,legPairs:0.8` insects;
  `set=neckLength:0.02` sunk heads; `set=belly:1` pot bellies; `set=texture:0.7` scales; `theme=hive`, `theme=bog`)
  forces genes on all of them; `sprouts=3` adds random sprouts; `walk=1` (or W) walks them in place
  to check gaits. R rerolls.
- Headless screenshots work with the preinstalled Playwright Chromium using
  `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`, against
  `npx vite` or `npx vite preview`. Take several frames a few hundred ms apart to judge a gait.
