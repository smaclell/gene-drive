import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Creature } from './sim/creature';
import { Ranch } from './sim/ranch';
import { CameraRig } from './ui/camera';
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

const view = new CameraRig(camera, renderer.domElement, { minDistance: 4, maxDistance: 70, bounds: 45, groundAt: terrainHeight });

const ranch = new Ranch(scene, world);

// ---- Game state shared with the UI ----------------------------------

let selected: Creature | null = null;
let breedingFrom: Creature | null = null;
let follow = false;
let speed = 1;
// Moving the camera yourself always wins over follow mode.
view.onUserMove = () => {
  follow = false;
};

/** Start a picnic between the breeding creature and `partner`. */
function breedWith(partner: Creature) {
  if (!breedingFrom) return;
  const err = ranch.breed(breedingFrom, partner);
  if (err) hud.flash(err);
  breedingFrom = null;
  hud.refresh();
}

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
  breedWith,
  cancelBreeding: () => {
    breedingFrom = null;
    hud.refresh();
  },
  following: () => follow,
  setFollow: (on) => {
    follow = on && !!selected;
  },
  meet: (c) => {
    game.select(c, true);
    view.lookAt(c.x, c.z, Math.max(9, c.skeleton.length * 3));
    ranch.poke(c);
  },
  home: () => view.home(),
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
ranch.onMeet = (c) => game.meet(c);
ranch.start();

// ---- Picking ---------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt: { x: number; y: number } | null = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
  // Browsers allow sound only after a gesture.
  ranch.voices.unlock();
});
window.addEventListener('keydown', () => ranch.voices.unlock(), { once: true });
// Buttons count as a gesture too, so the ranch can be heard from the first click anywhere.
window.addEventListener('pointerdown', () => ranch.voices.unlock(), { capture: true });

renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return;
  downAt = null;
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(ranch.creatures.map((c) => c.rig.root), true);
  const picked = ranch.find(hits[0]?.object.userData.creatureId as string | undefined) ?? null;

  if (breedingFrom) {
    if (picked && picked !== breedingFrom) breedWith(picked);
    else if (!picked) game.cancelBreeding();
    return;
  }
  if (picked) ranch.poke(picked);
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
  } else if (e.key === 'm' || e.key === 'M') {
    ranch.setMuted(!ranch.settings.muted);
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

  if (follow && selected) view.lookAt(selected.x, selected.z);
  view.update(realDt);
  ranch.sound.update(realDt, sky.sunHeight(), view);

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
