import * as THREE from 'three';

/**
 * Shared materials. Every creature uses the same few materials: colour and glow
 * are baked into vertex attributes, so hundreds of unique bodies cost one shader.
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

/** Adds the per-vertex `glow` attribute as emissive light, scaled by `glowUniform`. */
function withGlow(material: THREE.MeshToonMaterial): THREE.MeshToonMaterial {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.glowIntensity = glowUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float glowIntensity;\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += (vColor.rgb * 0.6 + 0.4) * vGlow * glowIntensity * 2.4;');
  };
  material.customProgramCacheKey = () => 'creature-glow';
  return material;
}

let shared: CreatureMaterials | null = null;

export interface CreatureMaterials {
  skin: THREE.MeshToonMaterial;
  wing: THREE.MeshToonMaterial;
  eyeWhite: THREE.MeshToonMaterial;
  pupil: THREE.MeshBasicMaterial;
  shine: THREE.MeshBasicMaterial;
}

export function creatureMaterials(): CreatureMaterials {
  if (shared) return shared;
  const gradientMap = toonGradient();
  shared = {
    skin: withGlow(new THREE.MeshToonMaterial({ vertexColors: true, gradientMap })),
    wing: withGlow(new THREE.MeshToonMaterial({ vertexColors: true, gradientMap, side: THREE.DoubleSide, transparent: true, opacity: 0.88 })),
    eyeWhite: new THREE.MeshToonMaterial({ color: 0xfbf8f0, gradientMap }),
    pupil: new THREE.MeshBasicMaterial({ color: 0x1d1a24 }),
    shine: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  };
  return shared;
}
