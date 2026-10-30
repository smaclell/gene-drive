# CLAUDE.md

Orientation for AI sessions (and humans) working on Gene Drive, a cozy 3D
creature ranch where every creature is grown from a genome.

- Vision and reasoning: [`docs/DESIGN.md`](docs/DESIGN.md)
- What's done and what's next: [`docs/ROADMAP.md`](docs/ROADMAP.md). Update it when you finish work.

## Commands

```bash
npm install
npm run dev        # Vite dev server (game at /, creature gallery at /gallery.html)
npm test           # Vitest: genetics, anatomy, abilities, names, reports
npm run typecheck
npm run build      # Typecheck and production build to dist/
```

Deployment: `.github/workflows/pages.yml` builds and publishes `dist/` to GitHub
Pages on every push to `main`. `.github/workflows/ci.yml` runs tests and a build
on pull requests.

## Architecture

```
src/
  core/        rng.ts (seeded PRNG + math), noise.ts (value noise)      — no three.js
  genetics/    genes → genome → phenotype → anatomy → abilities           — no three.js, unit tested
               discoveries.ts (Journal), names.ts, report.ts (hatch report)
  creature/    build.ts (skeleton → meshes), materials.ts (shared toon + glow shader)
  world/       layout.ts (terrain height, landmarks), scenery.ts (meshes, fruit, flowers), sky.ts (day/night)
  sim/         creature.ts (behaviour + animation), ranch.ts (herd, eggs, visitors, saves),
               visitors.ts (themed gene pools), effects.ts (emotes, particles, rings)
  ui/          hud.ts, lab.ts, dom.ts, style.css
  main.ts      renderer, camera, picking, main loop
  gallery.ts   grid of random creatures for tuning (?seed=&count=&theme=)
```

Data flow for a creature: `Genome` (allele pairs) → `express()` → `BodyPlan`
(real units) → `buildSkeleton()` (positions) → `buildCreature()` (meshes) and
`computeAbilities()` (scores). Meshes and abilities read the same skeleton, so
what a creature looks like is what it can do.

## Conventions

- **Everything is procedural.** No image or model assets. Authored data
  (palettes, syllables, themes) lives in code beside the system that uses it.
- **Keep `core/` and `genetics/` free of three.js** so they stay fast to test in Node.
- **Adding a gene:** add it to `GENES` in `genetics/genes.ts`, read it in
  `phenotype.ts`, and use it in `anatomy.ts`/`build.ts`/`abilities.ts`. Old saves
  keep working because `reviveGenome` fills missing genes. Add a test.
- **Adding a discovery:** add it to `DISCOVERIES`; gate a Lab slider with `unlockedBy`.
- Colour and glow live in vertex attributes (`color`, `glow`); every creature
  geometry must have both, because all creatures share one material.
- Behaviour uses `Math.random`. Genetics takes an explicit `Rng` so it is reproducible.
- Cozy tone: no failure states, no deaths, gentle copy. UK/Canadian spelling in
  player-facing text ("colour").

## Debugging and verification

- `window.geneDrive` exposes `{ ranch, game, scene, camera }` in the browser console,
  e.g. `geneDrive.ranch.spawnVisitor()` or `geneDrive.ranch.resources.fruit += 50`.
- The save lives in `localStorage` under `gene-drive-save-v1`; "Start a new ranch" in Help resets it.
- Headless screenshots work with the preinstalled Playwright Chromium using
  `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`, against
  `npx vite preview`. Use the gallery page to check generator changes visually.
