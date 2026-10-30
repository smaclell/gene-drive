import * as THREE from 'three';
import type { SkinTexture } from '../genetics/phenotype';

/**
 * Shared materials. Every creature uses the same few materials: colour, glow
 * and sheen are baked into vertex attributes, so hundreds of unique bodies cost
 * a handful of shaders.
 *
 * Vertex attributes every skin geometry must have:
 * - `color` (vec3): skin colour and pattern.
 * - `glow` (float): 0…1 night glow mask.
 * - `sheen` (float): 0…1 iridescence (colour shifts with viewing angle).
 * - `paintDelta` (vec3) and `mark` (float): the pattern. `color` is the skin without it,
 *   `paintDelta` what it adds, and `mark` a signed field (positive inside a marking) that
 *   the fragment shader thresholds per pixel, so spots and stripes have crisp edges even
 *   on a coarse mesh. Missing, they read as zero: no pattern.
 *
 * The skin mesh itself also has `grain` (float, per metre): the frequency of its fine
 * surface texture, drawn in the shader as bumps (see `skinMaterial`).
 */

/** 0 by day, up to 1 at night. Drives the glow of every glowing creature at once. */
export const glowUniform = { value: 0 };

let toonRamp: THREE.DataTexture | null = null;

/** Three-step light ramp for the soft toon look. */
export function toonGradient(): THREE.DataTexture {
  if (toonRamp) return toonRamp;
  const steps = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
  toonRamp = new THREE.DataTexture(steps, 3, 1, THREE.RGBAFormat);
  toonRamp.minFilter = THREE.NearestFilter;
  toonRamp.magFilter = THREE.NearestFilter;
  toonRamp.generateMipmaps = false;
  toonRamp.needsUpdate = true;
  return toonRamp;
}

let skinRampTexture: THREE.DataTexture | null = null;

/**
 * The creatures' own light ramp: soft steps rather than hard bands, shadows tinted
 * violet and lights a little warm, so bodies look round and painted rather than flat.
 * RGB, unlike the world's grey ramp; `withGlow` teaches the shader to read all three channels.
 */
export function skinRamp(): THREE.DataTexture {
  if (skinRampTexture) return skinRampTexture;
  const n = 64;
  const data = new Uint8Array(n * 4);
  const shadow = [0.34, 0.31, 0.5];
  const mid = [0.74, 0.72, 0.8];
  const light = [1, 0.98, 0.94];
  const step = (a: number, b: number, t: number) => {
    const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return x * x * (3 - 2 * x);
  };
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const a = step(0.32, 0.46, t);
    const b = step(0.58, 0.7, t);
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(255 * (shadow[c] + (mid[c] - shadow[c]) * a + (light[c] - mid[c]) * b));
    data[i * 4 + 3] = 255;
  }
  skinRampTexture = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  skinRampTexture.minFilter = THREE.LinearFilter;
  skinRampTexture.magFilter = THREE.LinearFilter;
  skinRampTexture.generateMipmaps = false;
  skinRampTexture.needsUpdate = true;
  return skinRampTexture;
}

/**
 * Adds the per-vertex `glow` (emissive at night) and `sheen` (iridescence) attributes,
 * the tinted ramp, a soft rim light so creatures stand out from the grass, and a
 * little gloss, like a vinyl toy.
 */
function withGlow(material: THREE.MeshToonMaterial, texture?: SkinTexture): THREE.MeshToonMaterial {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.glowIntensity = glowUniform;
    if (texture) shader.defines = { ...shader.defines, GRAIN: GRAIN_KIND[texture] };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float glow;
        attribute float sheen;
        attribute vec3 paintDelta;
        attribute float mark;
        varying float vGlow;
        varying float vSheen;
        varying vec3 vPaintDelta;
        varying float vMark;
        #ifdef GRAIN
        attribute float grain;
        varying vec3 vGrainPos;
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vGlow = glow;
        vSheen = sheen;
        vPaintDelta = paintDelta;
        vMark = mark;
        #ifdef GRAIN
        vGrainPos = position * grain;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float glowIntensity;
        varying float vGlow;
        varying float vSheen;
        varying vec3 vPaintDelta;
        varying float vMark;
        #ifdef GRAIN
        varying vec3 vGrainPos;
        ${GRAIN_GLSL}
        #endif`)
      .replace('return vec3( texture2D( gradientMap, coord ).r );', 'return texture2D( gradientMap, coord ).rgb;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float markEdge = max(fwidth(vMark), 1e-4) * 0.7;
        diffuseColor.rgb += vPaintDelta * smoothstep(-markEdge, markEdge, vMark);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        // Rim light and shimmer follow the smooth body; only gloss and shading see the bumps.
        vec3 smoothNormal = normal;
        #ifdef GRAIN
        float grainShade = grainSurface(vGrainPos, -vViewPosition, normal);
        diffuseColor.rgb *= grainShade;
        #endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec3 viewDir = normalize(vViewPosition);
        float facing = abs(dot(smoothNormal, viewDir));
        if (vSheen > 0.0) {
          vec3 rainbow = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + facing * 1.6));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.45 + rainbow * 0.65, vSheen * (0.3 + 0.7 * (1.0 - facing)));
        }
        float day = 1.0 - glowIntensity * 0.7;
        float rim = pow(1.0 - facing, 3.0);
        totalEmissiveRadiance += (diffuseColor.rgb * 0.45 + vec3(0.3, 0.29, 0.26)) * rim * 0.5 * day;
        vec3 halfway = normalize(normalize(vec3(-0.35, 0.75, 0.55)) + viewDir);
        float gloss = pow(max(dot(normal, halfway), 0.0), 28.0);
        totalEmissiveRadiance += vec3(1.0, 0.98, 0.92) * gloss * (0.12 + vSheen * 0.25) * day;
        totalEmissiveRadiance += (vColor.rgb * 0.6 + 0.4) * vGlow * glowIntensity * 2.4;
        #if defined(GRAIN) && GRAIN == 1
        // Velvet catches the light at its edges.
        totalEmissiveRadiance += diffuseColor.rgb * pow(1.0 - facing, 1.6) * 0.32 * day;
        #endif`,
      );
  };
  material.customProgramCacheKey = () => `creature-glow-${texture ?? 'plain'}`;
  return material;
}

const GRAIN_KIND: Record<SkinTexture, number> = { smooth: 0, velvet: 1, scales: 2, pebbles: 3 };

/** Texture frequency per metre on a size-1 creature (see `grainFor`). */
const GRAIN_FREQUENCY: Record<SkinTexture, number> = { smooth: 2.2, velvet: 38, scales: 10, pebbles: 6.5 };

/** The `grain` attribute value for a creature's skin: fewer, bigger features on bigger creatures, but not proportionally. */
export const grainFor = (texture: SkinTexture, size: number) => GRAIN_FREQUENCY[texture] / Math.pow(size, 0.65);

/**
 * Fine surface detail, evaluated per pixel in the skin's rest pose (so it sticks to the
 * body as it bends). Each kind is a height field: it tilts the normal (bump mapping without
 * UVs, after Mikkelsen) and darkens its own crevices. It fades out where it would be finer
 * than a pixel or two, so it never shimmers in the distance.
 */
const GRAIN_GLSL = /* glsl */ `
  vec3 grainHash(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453);
  }
  float grainNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(grainHash(i).x, grainHash(i + vec3(1, 0, 0)).x, u.x), mix(grainHash(i + vec3(0, 1, 0)).x, grainHash(i + vec3(1, 1, 0)).x, u.x), u.y),
      mix(mix(grainHash(i + vec3(0, 0, 1)).x, grainHash(i + vec3(1, 0, 1)).x, u.x), mix(grainHash(i + vec3(0, 1, 1)).x, grainHash(i + vec3(1, 1, 1)).x, u.x), u.y),
      u.z);
  }
  // Distance to the nearest and second-nearest cell point, and the nearest cell's random id.
  vec3 grainCells(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    float f1 = 8.0;
    float f2 = 8.0;
    float id = 0.0;
    for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec3 g = vec3(float(x), float(y), float(z));
      vec3 h = grainHash(i + g);
      vec3 d = g + h * 0.85 + 0.075 - f;
      float dd = dot(d, d);
      if (dd < f1) { f2 = f1; f1 = dd; id = h.z; }
      else if (dd < f2) { f2 = dd; }
    }
    return vec3(sqrt(f1), sqrt(f2), id);
  }
  // Height in 0..1 and how dark the lowest parts get.
  vec2 grainHeight(vec3 p) {
    #if GRAIN == 1
      return vec2(0.55 * grainNoise(p) + 0.45 * grainNoise(p * 2.7 + 3.1), 0.86);
    #elif GRAIN == 2
      vec3 c = grainCells(p);
      return vec2(smoothstep(0.0, 0.22, c.y - c.x) * (1.0 - 0.45 * c.x) * (0.85 + 0.15 * c.z), 0.72);
    #elif GRAIN == 3
      vec3 c = grainCells(p);
      float r = 0.28 + 0.22 * c.z;
      return vec2(0.25 * grainNoise(p * 3.0) + 0.75 * smoothstep(r, r * 0.25, c.x), 0.8);
    #else
      return vec2(0.6 * grainNoise(p) + 0.4 * grainNoise(p * 2.3 + 7.0), 0.9);
    #endif
  }
  // Tilts \`n\` by the height field and returns the colour multiplier for this pixel.
  float grainSurface(vec3 p, vec3 surf, inout vec3 n) {
    // Derivatives first, outside any branch: they are undefined in divergent control flow.
    vec3 dp = fwidth(p);
    vec3 sx = dFdx(surf);
    vec3 sy = dFdy(surf);
    vec2 h = grainHeight(p);
    vec2 dh = vec2(dFdx(h.x), dFdy(h.x));
    float fade = 1.0 - smoothstep(0.1, 0.28, max(dp.x, max(dp.y, dp.z)));
    #if GRAIN > 0
    // Bumps are a fixed fraction of a feature deep, in view units.
    float depth = 0.25 * length(fwidth(surf)) / max(length(dp), 1e-5) * fade;
    vec3 r1 = cross(sy, n);
    vec3 r2 = cross(n, sx);
    float det = dot(sx, r1);
    vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2) * depth;
    n = normalize(abs(det) * n - grad);
    #endif
    return mix(1.0, mix(h.y, 1.04, h.x), fade);
  }
`;

/**
 * Inverted-hull outline: back faces pushed out along the normal by a few pixels
 * (thinner far away), coloured a dark shade of the skin underneath.
 */
function inkOutline(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      vec3 inkNormal = normalize(normalMatrix * objectNormal);
      vec2 inkDir = normalize(inkNormal.xy + 1e-5);
      float inkPx = 0.0032 * clamp(14.0 / gl_Position.w, 0.35, 1.0);
      gl_Position.xy += inkDir * vec2(projectionMatrix[1][1] / projectionMatrix[0][0], 1.0) * inkPx * gl_Position.w;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vec3(0.32, 0.28, 0.4);');
  };
  material.customProgramCacheKey = () => 'creature-ink';
  return material;
}

let shared: CreatureMaterials | null = null;

export interface CreatureMaterials {
  /** For rigblocks; the skin mesh itself uses `skinMaterial`, which adds its texture. */
  skin: THREE.MeshToonMaterial;
  /** Thin double-sided parts: frills, sails, tail fans. */
  membrane: THREE.MeshToonMaterial;
  wing: THREE.MeshToonMaterial;
  /** See-through skin for the jelly finish. */
  jelly: THREE.MeshToonMaterial;
  jellyMembrane: THREE.MeshToonMaterial;
  /** Drawn behind the skin, pushed out along normals: a soft ink line in a darker shade of the skin. */
  outline: THREE.MeshBasicMaterial;
  eyeWhite: THREE.MeshToonMaterial;
  pupil: THREE.MeshBasicMaterial;
  shine: THREE.MeshBasicMaterial;
}

export function creatureMaterials(): CreatureMaterials {
  if (shared) return shared;
  const gradientMap = skinRamp();
  const toon = (extra: THREE.MeshToonMaterialParameters = {}) => withGlow(new THREE.MeshToonMaterial({ vertexColors: true, gradientMap, ...extra }));
  shared = {
    skin: toon(),
    membrane: toon({ side: THREE.DoubleSide }),
    wing: toon({ side: THREE.DoubleSide, transparent: true, opacity: 0.88 }),
    jelly: toon({ transparent: true, opacity: 0.62 }),
    jellyMembrane: toon({ side: THREE.DoubleSide, transparent: true, opacity: 0.55 }),
    outline: inkOutline(),
    // Eye whites stay bright in shade, or they look grubby.
    eyeWhite: new THREE.MeshToonMaterial({ color: 0xfbf8f0, gradientMap, emissive: 0x3a3836 }),
    pupil: new THREE.MeshBasicMaterial({ color: 0x1d1a24 }),
    shine: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  };
  return shared;
}

const textured = new Map<string, THREE.MeshToonMaterial>();

/** The material for a creature's skin mesh: the shared look plus its fine texture. */
export function skinMaterial(texture: SkinTexture, jelly: boolean): THREE.MeshToonMaterial {
  const key = `${texture}-${jelly}`;
  let material = textured.get(key);
  if (!material) {
    const opts: THREE.MeshToonMaterialParameters = jelly ? { transparent: true, opacity: 0.62 } : {};
    material = withGlow(new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: skinRamp(), ...opts }), texture);
    textured.set(key, material);
  }
  return material;
}
