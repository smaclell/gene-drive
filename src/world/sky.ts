import * as THREE from 'three';
import { clamp01, lerp, mulberry32, smoothstep } from '../core/rng';
import { glowUniform } from '../creature/materials';
import { daylightUniform } from './surface';

/**
 * Day/night cycle. One day lasts `DAY_SECONDS`; daylight takes most of it so
 * nights are short and cozy rather than a chore.
 */

export const DAY_SECONDS = 360;
const DAYLIGHT_SHARE = 0.72;

export interface Sky {
  update: (time: number) => void;
  /** 1 at noon, -1 at midnight. */
  sunHeight: () => number;
  isNight: () => boolean;
  phaseName: () => string;
  dayNumber: (time: number) => number;
}

const SKY_DAY = new THREE.Color(0xa8dcf0);
const SKY_DUSK = new THREE.Color(0xf6b59a);
const SKY_NIGHT = new THREE.Color(0x1c2448);
const SUN_DAY = new THREE.Color(0xfff4dc);
const SUN_DUSK = new THREE.Color(0xffb078);
const MOON = new THREE.Color(0x9fb4ff);

export function createSky(scene: THREE.Scene, sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight): Sky {
  const background = new THREE.Color();
  scene.background = background;
  scene.fog = new THREE.Fog(background, 70, 160);

  const rng = mulberry32(99);
  const starGeo = new THREE.BufferGeometry();
  const starPos: number[] = [];
  for (let i = 0; i < 700; i++) {
    const u = rng() * 2 - 1;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    if (u < 0.05) continue;
    starPos.push(Math.cos(a) * r * 220, u * 220, Math.sin(a) * r * 220);
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false });
  const stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  let height = 1;
  let phase = 0;

  /** Map wall-clock fraction of the day to the sun's angle, stretching daylight. */
  const sunAngle = (f: number) => (f < DAYLIGHT_SHARE ? (f / DAYLIGHT_SHARE) * Math.PI : Math.PI + ((f - DAYLIGHT_SHARE) / (1 - DAYLIGHT_SHARE)) * Math.PI);

  const update = (time: number) => {
    phase = (time / DAY_SECONDS) % 1;
    const angle = sunAngle(phase);
    height = Math.sin(angle);
    const day = smoothstep(-0.12, 0.25, height);
    const dusk = 1 - smoothstep(0.05, 0.4, Math.abs(height));

    background.copy(SKY_NIGHT).lerp(SKY_DAY, day).lerp(SKY_DUSK, dusk * 0.55);
    (scene.fog as THREE.Fog).color.copy(background);

    if (height > -0.05) {
      sun.position.set(Math.cos(angle) * 60, Math.max(8, height * 70), 25);
      sun.color.copy(SUN_DAY).lerp(SUN_DUSK, dusk);
      sun.intensity = lerp(0.35, 2.4, day);
    } else {
      // Moonlight from the opposite side.
      sun.position.set(-Math.cos(angle) * 60, 50, -20);
      sun.color.copy(MOON);
      sun.intensity = 0.45;
    }
    hemi.intensity = lerp(0.55, 1.35, day);
    hemi.color.copy(background).lerp(new THREE.Color(0xffffff), 0.5);
    starMat.opacity = clamp01(1 - day * 1.6);
    glowUniform.value = smoothstep(0.25, -0.15, height);
    daylightUniform.value = smoothstep(0.05, 0.35, height);
  };

  return {
    update,
    sunHeight: () => height,
    isNight: () => height < -0.02,
    phaseName: () => {
      if (height < -0.02) return 'Night';
      if (phase < DAYLIGHT_SHARE * 0.18) return 'Dawn';
      if (phase < DAYLIGHT_SHARE * 0.4) return 'Morning';
      if (phase < DAYLIGHT_SHARE * 0.62) return 'Afternoon';
      if (phase < DAYLIGHT_SHARE * 0.86) return 'Evening';
      return 'Dusk';
    },
    dayNumber: (time: number) => Math.floor(time / DAY_SECONDS) + 1,
  };
}
