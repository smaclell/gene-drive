import * as THREE from 'three';

/**
 * Shared materials. Every creature uses the same few materials: colour, glow
 * and sheen are baked into vertex attributes, so hundreds of unique bodies cost
 * a handful of shaders.
 *
 * Vertex attributes every skin geometry must have:
 * - `color` (vec3): skin colour and pattern.
 * - `glow` (float): 0…1 night glow mask.
 * - `sheen` (float): 0…1 iridescence (colour shifts with viewing angle).
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
function withGlow(material: THREE.MeshToonMaterial): THREE.MeshToonMaterial {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.glowIntensity = glowUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nattribute float sheen;\nvarying float vGlow;\nvarying float vSheen;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;\nvSheen = sheen;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float glowIntensity;\nvarying float vGlow;\nvarying float vSheen;')
      .replace('return vec3( texture2D( gradientMap, coord ).r );', 'return texture2D( gradientMap, coord ).rgb;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        vec3 viewDir = normalize(vViewPosition);
        float facing = abs(dot(normal, viewDir));
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
        totalEmissiveRadiance += (vColor.rgb * 0.6 + 0.4) * vGlow * glowIntensity * 2.4;`,
      );
  };
  material.customProgramCacheKey = () => 'creature-glow';
  return material;
}

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
    eyeWhite: new THREE.MeshToonMaterial({ color: 0xfbf8f0, gradientMap }),
    pupil: new THREE.MeshBasicMaterial({ color: 0x1d1a24 }),
    shine: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  };
  return shared;
}
