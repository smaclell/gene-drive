import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { mulberry32 } from './core/rng';
import { buildCreature } from './creature/build';
import { computeAbilities } from './genetics/abilities';
import { buildSkeleton } from './genetics/anatomy';
import { genomeSeed, randomGenome } from './genetics/genome';
import { randomName } from './genetics/names';
import { planFromGenome } from './genetics/phenotype';
import { VISITOR_THEMES } from './sim/visitors';

/**
 * Creature gallery: a grid of random creatures for tuning the generator.
 * URL params: ?seed=123&count=30&theme=sky   (R or click rerolls)
 */

const params = new URLSearchParams(location.search);
let seed = Number(params.get('seed') ?? Math.floor(Math.random() * 1e6));
const count = Math.min(80, Number(params.get('count') ?? 30));
const theme = VISITOR_THEMES.find((t) => t.id === params.get('theme'));

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
  const rng = mulberry32(seed);
  const cols = Math.ceil(Math.sqrt(count * 1.4));
  const spacing = 5.5;
  for (let i = 0; i < count; i++) {
    const genome = randomGenome(rng, theme?.bias);
    const plan = planFromGenome(genome);
    const skel = buildSkeleton(plan);
    const a = computeAbilities(plan, skel);
    const rig = buildCreature(plan, skel, genomeSeed(genome));
    for (const w of rig.wings) w.pivot.rotation.x = -w.side * 1.1;
    rig.root.position.set((i % cols - (cols - 1) / 2) * spacing, 0, (Math.floor(i / cols) - (count / cols - 1) / 2) * spacing);
    rig.root.rotation.y = -0.5;
    const el = document.createElement('div');
    el.className = 'tag';
    const best = (Object.entries(a) as [string, number][]).sort((x, y) => y[1] - x[1])[0];
    el.textContent = `${randomName(rng)} · ${best[0]} ${Math.round(best[1] * 100)}`;
    const tag = new CSS2DObject(el);
    tag.position.set(0, -0.25, 0);
    rig.root.add(tag);
    zoo.add(rig.root);
  }
  const span = cols * spacing;
  camera.position.set(0, span * 0.5, span * 0.72);
  controls.target.set(0, 0.8, 0);
  document.getElementById('info')!.textContent = `seed ${seed}${theme ? ` · ${theme.title}` : ''} · R to reroll`;
}

populate();
addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') {
    seed = Math.floor(Math.random() * 1e6);
    populate();
  }
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labels.setSize(innerWidth, innerHeight);
});
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
  labels.render(scene, camera);
});
