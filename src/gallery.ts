import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { mulberry32 } from './core/rng';
import { buildCreature, type CreatureRig } from './creature/build';
import { GAIT_CADENCE, animate, restPose, restRig } from './creature/motion';
import type { Skeleton } from './genetics/anatomy';
import { computeAbilities } from './genetics/abilities';
import { buildSkeleton } from './genetics/anatomy';
import { genomeSeed, randomGenome, type Genome } from './genetics/genome';
import { GENE_IDS, type GeneId } from './genetics/genes';
import { randomSprout } from './genetics/sprouts';
import { randomName } from './genetics/names';
import { GAIT_LABEL, planFromGenome, type BodyPlan } from './genetics/phenotype';
import { VISITOR_THEMES, themeBias } from './sim/visitors';

/**
 * Creature gallery: a grid of random creatures for tuning the generator.
 * URL params:
 *   seed=123 count=30 theme=sky       which creatures (R rerolls)
 *   set=horns:0.95,mouth:0.9          force genes on every creature (both alleles)
 *   sprouts=2                         give every creature this many random sprouts
 *   walk=1                            walk in place to check gaits (W toggles)
 *   face=1                            a close-up of every face, three-quarter view (F toggles)
 */

const params = new URLSearchParams(location.search);
let seed = Number(params.get('seed') ?? Math.floor(Math.random() * 1e6));
const count = Math.min(80, Number(params.get('count') ?? 30));
const theme = VISITOR_THEMES.find((t) => t.id === params.get('theme'));
const forced = (params.get('set') ?? '').split(',').map((kv) => kv.split(':')).filter(([k, v]) => GENE_IDS.includes(k as GeneId) && v !== undefined);
const sproutCount = params.has('sprouts') ? Number(params.get('sprouts')) : null;
let walking = params.get('walk') === '1';
let faces = params.get('face') === '1';
let shown: { rig: CreatureRig; plan: BodyPlan; skel: Skeleton; phase: number }[] = [];

function tweak(genome: Genome, rng: () => number): Genome {
  for (const [k, v] of forced) genome[k as GeneId] = [Number(v), Number(v)];
  if (sproutCount !== null) genome.sprouts = Array.from({ length: sproutCount }, () => randomSprout(rng));
  return genome;
}

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.append(renderer.domElement);
const labels = new CSS2DRenderer();
labels.setSize(innerWidth, innerHeight);
labels.domElement.style.cssText = 'position:fixed;inset:0;pointer-events:none';
document.body.append(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf3ecdc);
scene.add(new THREE.HemisphereLight(0xffffff, 0x9fbf7f, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(6, 10, 8);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshLambertMaterial({ color: 0xcfe3b0 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 300);
const controls = new OrbitControls(camera, renderer.domElement);
const zoo = new THREE.Group();
scene.add(zoo);

function populate() {
  zoo.traverse((o) => o instanceof CSS2DObject && o.element.remove());
  zoo.clear();
  shown = [];
  const rng = mulberry32(seed);
  const cols = Math.ceil(Math.sqrt(count * 1.4));
  const made = Array.from({ length: count }, () => {
    const genome = tweak(randomGenome(rng, theme ? themeBias(theme, rng) : {}), rng);
    const plan = planFromGenome(genome);
    return { genome, plan, skel: buildSkeleton(plan) };
  });
  const rows = Math.ceil(count / cols);
  const spacing = Math.max(5.5, ...made.map((m) => Math.max(m.skel.length, m.skel.reach) * 0.9));
  for (let i = 0; i < count; i++) {
    const { genome, plan, skel } = made[i];
    const a = computeAbilities(plan, skel);
    const rig = buildCreature(plan, skel, genomeSeed(genome));
    restRig(rig, plan, skel);
    shown.push({ rig, plan, skel, phase: 0 });
    rig.root.position.set((i % cols - (cols - 1) / 2) * spacing, 0, (Math.floor(i / cols) - (rows - 1) / 2) * spacing);
    rig.root.rotation.y = -0.5;
    const el = document.createElement('div');
    el.className = 'tag';
    const best = (Object.entries(a) as [string, number][]).sort((x, y) => y[1] - x[1])[0];
    el.textContent = `${randomName(rng)} · ${GAIT_LABEL[plan.gait].noun.toLowerCase()} · ${best[0]} ${Math.round(best[1] * 100)}`;
    const tag = new CSS2DObject(el);
    tag.position.set(0, -0.25, 0);
    rig.root.add(tag);
    zoo.add(rig.root);
  }
  // Frame the whole grid: back off by whichever is bigger, its width or its depth.
  const span = Math.max(cols, rows * 1.3) * spacing;
  camera.position.set(0, span * 0.52, span * 0.78);
  controls.target.set(0, 0.8, 0);
  document.getElementById('info')!.textContent = `seed ${seed}${theme ? ` · ${theme.title}` : ''} · R to reroll · W to walk`;
}

populate();
addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') {
    seed = Math.floor(Math.random() * 1e6);
    populate();
  }
  if (e.key === 'w' || e.key === 'W') walking = !walking;
  if (e.key === 'f' || e.key === 'F') faces = !faces;
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labels.setSize(innerWidth, innerHeight);
});
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const time = now / 1000;
  for (const c of shown) {
    if (!walking) {
      restRig(c.rig, c.plan, c.skel, time);
      continue;
    }
    // Treadmill: advance the gait as if walking at about one stride a second.
    c.phase += dt * Math.PI * 1.6 * GAIT_CADENCE[c.plan.gait];
    animate(c.rig, c.plan, c.skel, {
      time, phase: c.phase, moving: 1, swimming: false, flying: false, pose: restPose(), lookYaw: 0, happy: false, digging: false, foraging: false, blink: false, action: null,
    });
  }
  if (faces) renderFaces();
  else {
    controls.update();
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.render(scene, camera);
  }
  labels.domElement.style.display = faces ? 'none' : '';
  if (!faces) labels.render(scene, camera);
});

/** One cell per creature, each looking at its face from a little to one side. */
const faceCamera = new THREE.PerspectiveCamera(32, 1, 0.02, 60);
function renderFaces() {
  const cols = Math.ceil(Math.sqrt((shown.length * innerWidth) / innerHeight));
  const rows = Math.ceil(shown.length / cols);
  const w = innerWidth / cols;
  const h = innerHeight / rows;
  renderer.setScissorTest(true);
  shown.forEach((c, i) => {
    const x = (i % cols) * w;
    const y = innerHeight - (Math.floor(i / cols) + 1) * h;
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    const head = c.rig.head.getWorldPosition(new THREE.Vector3());
    const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(c.rig.root.quaternion);
    const view = forward.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.55).setY(0.12).normalize();
    const distance = c.skel.head.radius * 7 + 0.3;
    // Clip anything nearer than the face, such as a neighbour in the grid.
    faceCamera.near = Math.max(0.02, distance - c.skel.head.radius * 4);
    faceCamera.aspect = w / h;
    faceCamera.updateProjectionMatrix();
    faceCamera.position.copy(head).addScaledVector(view, distance);
    faceCamera.lookAt(head);
    renderer.render(scene, faceCamera);
  });
  renderer.setScissorTest(false);
}
