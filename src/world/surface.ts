import * as THREE from 'three';
import { fbm2, noise2 } from '../core/noise';
import { randRange, smoothstep, type Rng } from '../core/rng';
import { COTTAGE, FENCE_RADIUS, GATE_ANGLE, POND, SOIL, WATER_LEVEL, WORLD_SIZE, inSoil, pondDistance, terrainHeight } from './layout';

/**
 * The ground the ranch stands on: terrain, grass and the pond surface.
 *
 * - The terrain is smooth-shaded and coloured at two scales, with a worn path from the
 *   cottage to the gate. Grass tufts take their colour from the ground under them, so
 *   they blend in at the root and catch the light at the tip.
 * - Grass sways in a wind that rolls across the meadow in waves (`windUniform`).
 * - Soft cloud shadows drift over the meadow by day (`CLOUD_GLSL`, on terrain and grass).
 * - The pond knows its own depth per vertex: pale and clear in the shallows, deep blue in
 *   the middle, with a foam line where it meets the shore and ripples that catch the sun.
 */

/** Seconds of wind and drifting clouds; the world's update advances it. */
export const windUniform = { value: 0 };
/** 1 by day … 0 at night: cloud shadows only show in sunlight. */
export const daylightUniform = { value: 1 };

const DOOR = { x: COTTAGE.x, z: COTTAGE.z + COTTAGE.d / 2 + 0.6 };
const GATE = { x: Math.cos(GATE_ANGLE) * FENCE_RADIUS, z: Math.sin(GATE_ANGLE) * FENCE_RADIUS };

/** How far a point is from the wandering path between the cottage door and the gate. */
function pathDistance(x: number, z: number): number {
  const dx = GATE.x - DOOR.x;
  const dz = GATE.z - DOOR.z;
  const len2 = dx * dx + dz * dz;
  const t = Math.max(0, Math.min(1, ((x - DOOR.x) * dx + (z - DOOR.z) * dz) / len2));
  // The path meanders a little, as paths worn by feet do.
  const bend = Math.sin(t * Math.PI * 2.2) * 2.2 * Math.sin(t * Math.PI);
  const len = Math.sqrt(len2);
  const px = DOOR.x + dx * t - (dz / len) * bend;
  const pz = DOOR.z + dz * t + (dx / len) * bend;
  return Math.hypot(x - px, z - pz);
}

const GRASS_A = new THREE.Color(0x8cc56a);
const GRASS_B = new THREE.Color(0x6aa957);
const MEADOW = new THREE.Color(0xb9d97a);
const CLOVER = new THREE.Color(0x5f9f58);
const HILL = new THREE.Color(0x7aa35a);
const PATH = new THREE.Color(0xc9b48a);
const SAND = new THREE.Color(0xe8d7a6);
const WET_SAND = new THREE.Color(0xb59f74);
const SOIL_LIGHT = new THREE.Color(0x8a5a3c);
const SOIL_DARK = new THREE.Color(0x6b432c);

/** The colour of the ground at a point (before lighting). Grass uses it too. */
export function groundColour(x: number, z: number, out: THREE.Color): THREE.Color {
  const h = terrainHeight(x, z);
  out.copy(GRASS_A).lerp(GRASS_B, fbm2(x * 0.08, z * 0.08, 3, 3));
  // Sunny meadow patches and darker clover, at two scales, so the ground never looks tiled.
  out.lerp(MEADOW, smoothstep(0.6, 0.78, noise2(x * 0.05 + 9, z * 0.05, 4)) * 0.7);
  out.lerp(CLOVER, smoothstep(0.62, 0.8, noise2(x * 0.19 + 2, z * 0.19 - 5, 6)) * 0.45);
  out.lerp(HILL, smoothstep(2, 8, h));
  const worn = smoothstep(1.5, 0.6, pathDistance(x, z) + (noise2(x * 0.7, z * 0.7, 8) - 0.5) * 0.8);
  out.lerp(PATH, worn * 0.85);
  const shore = pondDistance(x, z);
  if (shore < 1.45) out.lerp(SAND, smoothstep(1.45, 1.2, shore));
  if (shore < 1.4 && h < WATER_LEVEL - 0.1) out.copy(WET_SAND);
  if (inSoil(x, z)) out.copy(Math.sin((z - SOIL.z) * 3.6) > 0 ? SOIL_LIGHT : SOIL_DARK);
  return out;
}

/** Whether grass grows here: not in the pond, the soil patch, on the path or by the door. */
export function grassy(x: number, z: number): boolean {
  if (pondDistance(x, z) < 1.3 || inSoil(x, z)) return false;
  if (pathDistance(x, z) < 1.1) return false;
  return Math.abs(x - COTTAGE.x) > COTTAGE.w / 2 + 0.6 || Math.abs(z - COTTAGE.z) > COTTAGE.d / 2 + 0.6;
}

/** Big, soft, slowly drifting cloud shadows, in world xz. `cloudShade(xz)` is 1 in sun, lower in shade. */
const CLOUD_GLSL = /* glsl */ `
  uniform float windTime;
  uniform float daylight;
  float cloudHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float cloudNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(cloudHash(i), cloudHash(i + vec2(1, 0)), u.x), mix(cloudHash(i + vec2(0, 1)), cloudHash(i + vec2(1, 1)), u.x), u.y);
  }
  float cloudShade(vec2 xz) {
    vec2 p = xz * 0.022 + windTime * vec2(0.014, 0.006);
    float n = 0.6 * cloudNoise(p) + 0.3 * cloudNoise(p * 2.1 + 4.0) + 0.1 * cloudNoise(p * 4.3 + 9.0);
    return 1.0 - 0.2 * smoothstep(0.5, 0.68, n) * daylight;
  }
`;

/** Adds cloud shadows to a Lambert material's diffuse colour, using the world position. */
function withClouds(material: THREE.MeshLambertMaterial, extraVertex = '', extraKey = '') {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.windTime = windUniform;
    shader.uniforms.daylight = daylightUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCloudXZ;\nuniform float windTime;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 cloudWorld = modelMatrix * vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
        cloudWorld = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
        #endif
        vCloudXZ = cloudWorld.xz;`);
    if (extraVertex) {
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', extraVertex);
      // Both faces of a blade light like the ground: no flipping the normal on the back face.
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vCloudXZ;\n${CLOUD_GLSL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= cloudShade(vCloudXZ);');
  };
  material.customProgramCacheKey = () => `clouds-${extraKey}`;
  return material;
}

export function buildTerrain(): THREE.Mesh {
  const segments = 190;
  const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, terrainHeight(x, z));
    groundColour(x, z, c);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, withClouds(new THREE.MeshLambertMaterial({ vertexColors: true }), '', 'terrain'));
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

/** One tuft: a few curved blades fanning out, darker at the root and paler at the tip. */
function tuftGeometry(rng: Rng): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const index: number[] = [];
  const blades = 5;
  for (let b = 0; b < blades; b++) {
    const yaw = (b / blades) * Math.PI * 2 + randRange(rng, -0.4, 0.4);
    const lean = randRange(rng, 0.15, 0.45);
    const height = randRange(rng, 0.22, 0.42);
    const width = randRange(rng, 0.035, 0.05);
    const out = randRange(rng, 0.02, 0.06);
    const dx = Math.cos(yaw);
    const dz = Math.sin(yaw);
    const base = pos.length / 3;
    // Three rows up the blade (two quads), then the tip.
    for (let row = 0; row < 3; row++) {
      const t = row / 3;
      const w = width * (1 - t * 0.75);
      const reach = out + lean * height * t * t;
      const cx = dx * reach;
      const cz = dz * reach;
      pos.push(cx - dz * w, height * t, cz + dx * w, cx + dz * w, height * t, cz - dx * w);
      const shade = 0.62 + 0.45 * t;
      col.push(shade, shade, shade, shade, shade, shade);
    }
    pos.push(dx * (out + lean * height), height, dz * (out + lean * height));
    col.push(1.12, 1.15, 1.02);
    for (let row = 0; row < 2; row++) {
      const a = base + row * 2;
      index.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    index.push(base + 4, base + 5, base + 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // Blades light like the ground they grow from, so tufts melt into the meadow.
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(index);
  return geo;
}

/** Wind: blades bend more toward the tip, in waves that roll across the meadow. */
const SWAY_VERTEX = /* glsl */ `
  vec4 mvPosition = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  #endif
  float bendAt = max(0.0, transformed.y) * max(0.0, transformed.y) * 6.0;
  vec3 root = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float gust = sin(windTime * 1.3 + root.x * 0.16 + root.z * 0.09) * 0.6 + sin(windTime * 2.9 + root.x * 0.7 - root.z * 0.4) * 0.25 + 0.35;
  mvPosition.x += gust * bendAt * 0.05;
  mvPosition.z += gust * bendAt * 0.022;
  mvPosition.y -= abs(gust) * bendAt * 0.012;
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;
`;

export function buildGrass(rng: Rng): THREE.InstancedMesh {
  const count = 7000;
  const geo = tuftGeometry(rng);
  const material = withClouds(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), SWAY_VERTEX, 'grass');
  const grass = new THREE.InstancedMesh(geo, material, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  const e = new THREE.Euler();
  let placed = 0;
  for (let tries = 0; placed < count && tries < count * 4; tries++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * (FENCE_RADIUS + 14);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (!grassy(x, z)) continue;
    // Clumps: grass grows thicker in some places than others.
    if (noise2(x * 0.12, z * 0.12, 11) < rng() * 0.75) continue;
    q.setFromEuler(e.set(randRange(rng, -0.12, 0.12), rng() * 6.3, randRange(rng, -0.12, 0.12)));
    const s = randRange(rng, 0.7, 1.35) * (pondDistance(x, z) < 1.7 ? 1.4 : 1);
    m.compose(new THREE.Vector3(x, terrainHeight(x, z) - 0.02, z), q, new THREE.Vector3(s, s * randRange(rng, 0.8, 1.3), s));
    grass.setMatrixAt(placed, m);
    groundColour(x, z, c).offsetHSL(randRange(rng, -0.015, 0.015), 0.05, randRange(rng, -0.03, 0.03));
    grass.setColorAt(placed, c);
    placed++;
  }
  grass.count = placed;
  grass.receiveShadow = true;
  grass.frustumCulled = false;
  return grass;
}

/** The pond surface: a grid over the bowl that knows how deep the water is at each vertex. */
export function buildWater(): THREE.Mesh {
  const size = POND.r * 2.8;
  const geo = new THREE.PlaneGeometry(size, size, 72, 72);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  const depth = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) depth[i] = WATER_LEVEL - terrainHeight(POND.x + pos.getX(i), POND.z + pos.getZ(i));
  geo.setAttribute('depth', new THREE.BufferAttribute(depth, 1));
  const mat = new THREE.MeshPhongMaterial({ color: 0x5cb8d6, transparent: true, opacity: 0.85, shininess: 120, specular: 0xffffff, depthWrite: false });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.windTime = windUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float depth;\nvarying float vDepth;\nvarying vec2 vWaterXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDepth = depth;\nvWaterXZ = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float windTime;
        varying float vDepth;
        varying vec2 vWaterXZ;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // Clear and pale in the shallows, deep blue in the middle.
        float deep = smoothstep(0.0, 1.1, vDepth);
        diffuseColor.rgb = mix(vec3(0.55, 0.86, 0.84), vec3(0.18, 0.5, 0.68), deep);
        diffuseColor.a = mix(0.35, 0.9, smoothstep(0.0, 0.5, vDepth));
        // A soft foam line that laps at the shore.
        float lap = sin(windTime * 1.4 + length(vWaterXZ) * 1.3) * 0.025;
        float foam = smoothstep(0.1 + lap, 0.03 + lap, vDepth) * smoothstep(-0.03, 0.02, vDepth);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.97, 0.98, 0.95), foam * 0.85);
        diffuseColor.a = max(diffuseColor.a, foam * 0.9);
        if (vDepth < -0.02) discard;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // Ripples: a few crossing waves tilt the normal so the sun glints off them.
        vec2 w = vWaterXZ;
        vec2 slope = vec2(
          cos(w.x * 2.1 + windTime * 1.7) * 0.6 + cos((w.x + w.y) * 3.3 - windTime * 2.3) * 0.4,
          cos(w.y * 2.6 - windTime * 1.3) * 0.6 + cos((w.x - w.y) * 2.9 + windTime * 2.1) * 0.4) * 0.07;
        normal = normalize(normal + (viewMatrix * vec4(slope.x, 0.0, slope.y, 0.0)).xyz);`);
  };
  mat.customProgramCacheKey = () => 'pond';
  const water = new THREE.Mesh(geo, mat);
  water.position.set(POND.x, WATER_LEVEL, POND.z);
  water.receiveShadow = true;
  water.renderOrder = 1;
  return water;
}
