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

/** Adds the per-vertex `glow` (emissive at night) and `sheen` (iridescence) attributes. */
function withGlow(material: THREE.MeshToonMaterial): THREE.MeshToonMaterial {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.glowIntensity = glowUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nattribute float sheen;\nvarying float vGlow;\nvarying float vSheen;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;\nvSheen = sheen;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float glowIntensity;\nvarying float vGlow;\nvarying float vSheen;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (vSheen > 0.0) {
          float facing = abs(dot(normal, normalize(vViewPosition)));
          vec3 rainbow = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + facing * 1.6));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.45 + rainbow * 0.65, vSheen * (0.3 + 0.7 * (1.0 - facing)));
        }
        totalEmissiveRadiance += (vColor.rgb * 0.6 + 0.4) * vGlow * glowIntensity * 2.4;`,
      );
  };
  material.customProgramCacheKey = () => 'creature-glow';
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
  eyeWhite: THREE.MeshToonMaterial;
  pupil: THREE.MeshBasicMaterial;
  shine: THREE.MeshBasicMaterial;
}

export function creatureMaterials(): CreatureMaterials {
  if (shared) return shared;
  const gradientMap = toonGradient();
  const toon = (extra: THREE.MeshToonMaterialParameters = {}) => withGlow(new THREE.MeshToonMaterial({ vertexColors: true, gradientMap, ...extra }));
  shared = {
    skin: toon(),
    membrane: toon({ side: THREE.DoubleSide }),
    wing: toon({ side: THREE.DoubleSide, transparent: true, opacity: 0.88 }),
    jelly: toon({ transparent: true, opacity: 0.62 }),
    jellyMembrane: toon({ side: THREE.DoubleSide, transparent: true, opacity: 0.55 }),
    eyeWhite: new THREE.MeshToonMaterial({ color: 0xfbf8f0, gradientMap }),
    pupil: new THREE.MeshBasicMaterial({ color: 0x1d1a24 }),
    shine: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  };
  return shared;
}
