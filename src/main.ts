import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Creature } from './sim/creature';
import { Ranch } from './sim/ranch';
import { Hud, type GameApi } from './ui/hud';
import { Lab } from './ui/lab';
import './ui/style.css';
import { terrainHeight } from './world/layout';
import { buildWorld } from './world/scenery';
import { createSky } from './world/sky';

/** Boot: renderer, camera, world, ranch, UI and the main loop. */

const app = document.getElementById('app')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.append(renderer.domElement);

const labels = new CSS2DRenderer();
labels.setSize(window.innerWidth, window.innerHeight);
labels.domElement.className = 'labels';
app.append(labels.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(16, 15, 24);

const hemi = new THREE.HemisphereLight(0xffffff, 0x6b8f4e, 1.3);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -42, right: 42, top: 42, bottom: -42, near: 1, far: 220 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

const world = buildWorld(1);
scene.add(world.group);
const sky = createSky(scene, sun, hemi);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 3;
controls.maxDistance = 80;
controls.maxPolarAngle = 1.42;
controls.screenSpacePanning = false;

const ranch = new Ranch(scene, world);

// ---- Game state shared with the UI ----------------------------------

let selected: Creature | null = null;
let breedingFrom: Creature | null = null;
let follow = false;
let speed = 1;

const game: GameApi = {
  ranch,
  sky,
  selected: () => selected,
  select: (c, focus = false) => {
    selected = c;
    if (focus && c) follow = true;
    if (!c) follow = false;
    hud.refresh();
  },
  breedingFrom: () => breedingFrom,
  startBreeding: () => {
    if (!selected || selected.wild) return;
    breedingFrom = selected;
    hud.refresh();
  },
  cancelBreeding: () => {
    breedingFrom = null;
    hud.refresh();
  },
  following: () => follow,
  setFollow: (on) => {
    follow = on && !!selected;
  },
  speed: () => speed,
  setSpeed: (s) => {
    speed = s;
  },
  openLab: () => {
    breedingFrom = null;
    lab.show(selected && !selected.wild ? selected : null);
  },
};

const hud = new Hud(app, game);
const lab = new Lab(app, ranch, () => hud.refresh());
ranch.onHatch = (c) => {
  if (!selected) game.select(c, true);
};
ranch.start();

// ---- Picking ---------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt: { x: number; y: number } | null = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return;
  downAt = null;
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(ranch.creatures.map((c) => c.rig.root), true);
  const picked = ranch.find(hits[0]?.object.userData.creatureId as string | undefined) ?? null;

  if (breedingFrom) {
    if (picked && picked !== breedingFrom) {
      const err = ranch.breed(breedingFrom, picked);
      if (err) hud.flash(err);
      breedingFrom = null;
      hud.refresh();
    } else if (!picked) {
      game.cancelBreeding();
    }
    return;
  }
  game.select(picked);
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === 'Escape') {
    if (lab.isOpen) lab.close();
    else if (breedingFrom) game.cancelBreeding();
    else game.select(null);
  } else if (lab.isOpen) {
    return;
  } else if (e.key === 'b' || e.key === 'B') {
    game.startBreeding();
  } else if (e.key === 'f' || e.key === 'F') {
    game.setFollow(!follow);
  } else if (e.key === 'h' || e.key === 'H') {
    hud.toggleDrawer('herd');
  } else if (e.key === 'j' || e.key === 'J') {
    hud.toggleDrawer('journal');
  } else if (e.key === 'l' || e.key === 'L') {
    game.openLab();
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labels.setSize(window.innerWidth, window.innerHeight);
});

const saveNow = () => ranch.save();
window.addEventListener('beforeunload', saveNow);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveNow();
});

// ---- Main loop -------------------------------------------------------

const timer = new THREE.Timer();
timer.connect(document);
const followTarget = new THREE.Vector3();
const delta = new THREE.Vector3();

function placeRing(ring: THREE.Mesh, c: Creature | null) {
  ring.visible = !!c && !c.gone;
  if (!c || c.gone) return;
  ring.position.set(c.x, terrainHeight(c.x, c.z) + 0.06, c.z);
  ring.scale.setScalar(c.radius * 1.4 + 0.3);
}

function frame() {
  requestAnimationFrame(frame);
  timer.update();
  const realDt = Math.min(timer.getDelta(), 0.1);
  const dt = lab.isOpen ? 0 : realDt * speed;

  if (selected?.gone) game.select(null);
  if (breedingFrom?.gone) breedingFrom = null;

  sky.update(ranch.time);
  ranch.update(dt, sky.isNight());

  if (follow && selected) {
    followTarget.set(selected.x, selected.position.y + selected.skeleton.bodyHeight * selected.growth, selected.z);
    delta.copy(followTarget).sub(controls.target).multiplyScalar(Math.min(1, realDt * 3));
    controls.target.add(delta);
    camera.position.add(delta);
  }
  // Keep the camera over the meadow.
  const t = controls.target;
  const d = Math.hypot(t.x, t.z);
  if (d > 45) {
    delta.set((t.x / d) * 45 - t.x, 0, (t.z / d) * 45 - t.z);
    t.add(delta);
    camera.position.add(delta);
  }
  controls.update();

  placeRing(ranch.effects.ring, selected);
  placeRing(ranch.effects.partnerRing, breedingFrom && breedingFrom !== selected ? breedingFrom : null);

  hud.tick(realDt);
  if (!lab.isOpen) {
    renderer.render(scene, camera);
    labels.render(scene, camera);
  }
}
frame();

// Handy for tinkering from the browser console.
(window as unknown as { geneDrive: unknown }).geneDrive = { ranch, game, scene, camera };
