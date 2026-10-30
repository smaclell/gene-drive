import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { buildCreature } from '../src/creature/build';
import { buildSkin } from '../src/creature/skin';
import { buildSkeleton } from '../src/genetics/anatomy';
import { express, genomeSeed, randomGenome } from '../src/genetics/genome';
import { hasFishLips, planFromExpressed, planFromGenome, shownTeeth, shownTongue } from '../src/genetics/phenotype';
import { traitsOf } from '../src/genetics/report';

/** The metaball skin and the rig built on it. Slower than the genetics tests: these build real meshes. */
describe('skin', () => {
  it('melts two blobs into one closed surface with normals pointing out', () => {
    const skin = buildSkin([
      { region: 'torso', a: { x: -0.5, y: 0, z: 0 }, b: { x: 0.5, y: 0, z: 0 }, ra: 0.3, rb: 0.3, chain: [0, 1], u0: 0, u1: 1, length: 1, blend: 0.05 },
      { region: 'head', a: { x: 0.8, y: 0.2, z: 0 }, b: { x: 0.8, y: 0.2, z: 0 }, ra: 0.25, rb: 0.25, chain: [2], u0: 0, u1: 1, length: 0.5, blend: 0.15 },
    ], 0.05);
    const pos = skin.geometry.getAttribute('position');
    const nrm = skin.geometry.getAttribute('normal');
    expect(pos.count).toBeGreaterThan(200);
    let outward = 0;
    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      const centre = p.x > 0.6 ? new THREE.Vector3(0.8, 0.2, 0) : new THREE.Vector3(THREE.MathUtils.clamp(p.x, -0.5, 0.5), 0, 0);
      if (p.clone().sub(centre).dot(new THREE.Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i))) > 0) outward++;
    }
    expect(outward / pos.count).toBeGreaterThan(0.97);
    // Every triangle uses real vertices.
    const index = skin.geometry.getIndex()!;
    for (let i = 0; i < index.count; i++) expect(index.getX(i)).toBeLessThan(pos.count);
  });

  it('builds varied creatures with sane skin weights and paint', () => {
    const rng = mulberry32(80);
    const extremes = [{ arms: 0.95, legPairs: 0.3, posture: 0.95 }, { legPairs: 0, legStyle: 1 }, { legPairs: 1, legStyle: 0.75, lumps: 1, segments: 1 }, { twinHead: 1, twinTail: 1, size: 1 }, { size: 0 }];
    for (let i = 0; i < 10; i++) {
      const genome = randomGenome(rng);
      const plan = i < extremes.length ? planFromExpressed({ ...express(genome), ...extremes[i] }) : planFromGenome(genome);
      const rig = buildCreature(plan, buildSkeleton(plan), genomeSeed(genome));
      const skins: THREE.SkinnedMesh[] = [];
      rig.root.traverse((o) => o instanceof THREE.SkinnedMesh && skins.push(o));
      expect(skins.length).toBeGreaterThan(0);
      const geo = skins[0].geometry;
      const weights = geo.getAttribute('skinWeight');
      const bones = geo.getAttribute('skinIndex');
      const colour = geo.getAttribute('color');
      expect(weights.count).toBeGreaterThan(300);
      for (let v = 0; v < weights.count; v++) {
        const sum = weights.getX(v) + weights.getY(v) + weights.getZ(v) + weights.getW(v);
        expect(sum).toBeCloseTo(1, 3);
        expect(bones.getX(v)).toBeLessThan(skins[0].skeleton.bones.length);
        expect(Number.isFinite(colour.getX(v))).toBe(true);
      }
      expect(rig.arms).toHaveLength(plan.armPairs * 2);
      rig.dispose();
    }
  }, 30000);
});

describe('mouths', () => {
  const plan = (genes: Record<string, number>) => {
    const genome = randomGenome(mulberry32(5));
    for (const [k, v] of Object.entries(genes)) (genome as unknown as Record<string, [number, number]>)[k] = [v, v];
    return planFromGenome(genome);
  };

  it('shows teeth, tongues and fish lips only where there are lips', () => {
    const toothy = plan({ mouth: 0.2, snout: 0.4, teeth: 0.95, tongue: 0.95, lips: 0.4 });
    expect(shownTeeth(toothy)).toBe('toothy');
    expect(shownTongue(toothy)).toBe('forked');
    expect(traitsOf(toothy).teeth).toBe('a toothy grin');
    const beaked = plan({ mouth: 0.6, teeth: 0.95, tongue: 0.95, lips: 0.95 });
    expect(shownTeeth(beaked)).toBe('none');
    expect(shownTongue(beaked)).toBe('tucked');
    expect(hasFishLips(beaked)).toBe(false);
    const pouty = plan({ mouth: 0.2, snout: 0.4, lips: 0.95, teeth: 0.95 });
    expect(hasFishLips(pouty)).toBe(true);
    expect(shownTeeth(pouty)).toBe('none');
  });

  it('puts a mouth on the skin of a big round head', () => {
    const p = plan({ mouth: 0.2, snout: 0, headSize: 0.95, teeth: 0.9, tongue: 0.7, lips: 0.6 });
    const skel = buildSkeleton(p);
    const rig = buildCreature(p, skel, 5);
    rig.root.updateMatrixWorld(true);
    // Mouth parts hang off the head, below its centre and out in front of it.
    const head = rig.head.getWorldPosition(new THREE.Vector3());
    const r = skel.head.radius;
    let parts = 0;
    rig.head.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o === rig.head) return;
      const at = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()).sub(head);
      if (at.y < -r * 0.15 && at.x > r * 0.5 && Math.abs(at.z) < r * 0.9) parts++;
    });
    expect(parts).toBeGreaterThan(4);
    rig.dispose();
  });
});
