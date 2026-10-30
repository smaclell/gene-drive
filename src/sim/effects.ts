import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

/** Floating emoji labels, little particle bursts and the selection ring. */

interface Emote {
  obj: CSS2DObject;
  age: number;
  life: number;
  anchor: THREE.Object3D | null;
  rise: number;
}

interface Particle {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  age: number;
  life: number;
  gravity: number;
  spin: number;
}

export class Effects {
  private emotes: Emote[] = [];
  private particles: Particle[] = [];
  private readonly particleGeo = new THREE.IcosahedronGeometry(0.07, 0);
  private readonly materials = new Map<number, THREE.MeshLambertMaterial>();
  readonly ring: THREE.Mesh;
  readonly partnerRing: THREE.Mesh;

  constructor(private readonly scene: THREE.Scene) {
    const ringGeo = new THREE.RingGeometry(0.85, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xfff6c2, transparent: true, opacity: 0.85, depthWrite: false }));
    this.ring.visible = false;
    this.partnerRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xff9ec7, transparent: true, opacity: 0.85, depthWrite: false }));
    this.partnerRing.visible = false;
    scene.add(this.ring, this.partnerRing);
  }

  /** Show `text` above an object (it follows the object) or at a fixed point. */
  emote(text: string, at: THREE.Object3D | THREE.Vector3, opts: { life?: number; className?: string } = {}) {
    const el = document.createElement('div');
    el.className = `emote ${opts.className ?? ''}`;
    el.textContent = text;
    const obj = new CSS2DObject(el);
    const anchor = at instanceof THREE.Object3D ? at : null;
    if (anchor) anchor.add(obj);
    else {
      obj.position.copy(at as THREE.Vector3);
      this.scene.add(obj);
    }
    this.emotes.push({ obj, age: 0, life: opts.life ?? 1.8, anchor, rise: 0 });
  }

  burst(at: THREE.Vector3, color: number, count = 8, opts: { speed?: number; up?: number; gravity?: number; life?: number; size?: number } = {}) {
    let mat = this.materials.get(color);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.15 });
      this.materials.set(color, mat);
    }
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.copy(at);
      mesh.scale.setScalar((opts.size ?? 1) * (0.6 + Math.random() * 0.8));
      const a = Math.random() * Math.PI * 2;
      const speed = (opts.speed ?? 1.5) * (0.5 + Math.random());
      const velocity = new THREE.Vector3(Math.cos(a) * speed, (opts.up ?? 2.5) * (0.6 + Math.random() * 0.6), Math.sin(a) * speed);
      this.scene.add(mesh);
      this.particles.push({ mesh, velocity, age: 0, life: opts.life ?? 0.9, gravity: opts.gravity ?? 9, spin: Math.random() * 8 });
    }
  }

  update(dt: number) {
    for (let i = this.emotes.length - 1; i >= 0; i--) {
      const e = this.emotes[i];
      e.age += dt;
      e.rise += dt * 0.6;
      e.obj.position.y = e.anchor ? e.rise : e.obj.position.y + dt * 0.6;
      const t = e.age / e.life;
      e.obj.element.style.opacity = String(t < 0.15 ? t / 0.15 : t > 0.7 ? Math.max(0, (1 - t) / 0.3) : 1);
      if (e.age >= e.life) {
        e.obj.removeFromParent();
        e.obj.element.remove();
        this.emotes.splice(i, 1);
      }
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      p.velocity.y -= p.gravity * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.mesh.rotation.x += p.spin * dt;
      p.mesh.rotation.y += p.spin * dt;
      const fade = 1 - p.age / p.life;
      if (fade < 0.3) p.mesh.scale.multiplyScalar(0.9);
      if (p.age >= p.life) {
        this.scene.remove(p.mesh);
        this.particles.splice(i, 1);
      }
    }
  }

  /** Remove emotes attached to an object that is going away. */
  clearFor(anchor: THREE.Object3D) {
    this.emotes = this.emotes.filter((e) => {
      if (e.anchor !== anchor) return true;
      e.obj.removeFromParent();
      e.obj.element.remove();
      return false;
    });
  }
}
