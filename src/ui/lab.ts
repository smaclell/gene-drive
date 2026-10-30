import * as THREE from 'three';
import { mulberry32 } from '../core/rng';
import { buildCreature, type CreatureRig } from '../creature/build';
import { ABILITIES, ABILITY_IDS, computeAbilities, stars } from '../genetics/abilities';
import { buildSkeleton } from '../genetics/anatomy';
import { discoveryById } from '../genetics/discoveries';
import { GENES, GENE_IDS, GROUP_LABELS, type GeneGroup, type GeneId } from '../genetics/genes';
import { express, genomeSeed, homozygousGenome, randomGenome, type Expressed } from '../genetics/genome';
import { randomName } from '../genetics/names';
import { describePlan, planFromExpressed } from '../genetics/phenotype';
import type { Creature } from '../sim/creature';
import { LAB_COST, type Ranch } from '../sim/ranch';
import { clear, h } from './dom';

/**
 * The Lab: a Spore-style creator. Sliders set both alleles of a gene, so Lab
 * creatures breed true. Rare traits stay locked until discovered by breeding.
 */
export class Lab {
  private readonly overlay: HTMLElement;
  private readonly canvasBox = h('div', { class: 'lab-preview' });
  private readonly sliders = h('div', { class: 'lab-sliders' });
  private readonly info = h('div', { class: 'lab-info' });
  private readonly nameInput = h('input', { class: 'name-input', maxlength: 16, 'aria-label': 'Name', spellcheck: false });
  private readonly growBtn = h('button', { class: 'primary' });
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  private readonly turntable = new THREE.Group();
  private rig: CreatureRig | null = null;
  private values: Expressed = express(randomGenome(Math.random));
  private dirty = true;
  private open = false;
  private frame = 0;
  private spin = 0;

  constructor(parent: HTMLElement, private readonly ranch: Ranch, private readonly onClose: () => void) {
    this.overlay = h('div', { class: 'lab-overlay', hidden: true });
    this.nameInput.addEventListener('keydown', (e) => e.stopPropagation());
    this.growBtn.addEventListener('click', () => this.grow());
    const card = h('div', { class: 'lab-card' },
      h('div', { class: 'panel-head' },
        h('h2', {}, '🧪 Creature Lab'),
        h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: () => this.close() }, '✕'),
      ),
      h('div', { class: 'lab-body' },
        h('div', { class: 'lab-left' }, this.canvasBox, this.info),
        h('div', { class: 'lab-right' },
          h('div', { class: 'lab-tools' },
            h('button', { class: 'chip-btn', onclick: () => this.randomise() }, '🎲 Randomise'),
            h('button', { class: 'chip-btn', onclick: () => this.mutateAll() }, '🧬 Nudge'),
          ),
          this.sliders,
          h('div', { class: 'lab-footer' }, this.nameInput, this.growBtn),
        ),
      ),
    );
    this.overlay.append(card);
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    parent.append(this.overlay);

    this.scene.background = new THREE.Color(0xf3ecdc);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9fbf7f, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(4, 8, 6);
    this.scene.add(sun);
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.4, 0.25, 48), new THREE.MeshLambertMaterial({ color: 0xd9ccb0 }));
    pedestal.position.y = -0.125;
    this.scene.add(pedestal, this.turntable);
  }

  get isOpen() {
    return this.open;
  }

  /** Open the Lab, optionally starting from an existing creature's look. */
  show(from?: Creature | null) {
    this.values = from ? { ...from.expressed } : express(randomGenome(Math.random));
    this.nameInput.value = randomName(Math.random);
    this.applyLocks();
    this.open = true;
    this.overlay.hidden = false;
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.canvasBox.append(this.renderer.domElement);
    }
    this.buildSliders();
    this.dirty = true;
    this.loop();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.overlay.hidden = true;
    cancelAnimationFrame(this.frame);
    this.onClose();
  }

  private locked(id: GeneId): string | null {
    const unlock = (GENES[id] as { unlockedBy?: string }).unlockedBy;
    if (!unlock || this.ranch.journal.has(unlock)) return null;
    return discoveryById(unlock)?.title ?? unlock;
  }

  /** Locked genes are pinned low so their trait stays off. */
  private applyLocks() {
    for (const id of GENE_IDS) if (this.locked(id)) this.values[id] = Math.min(this.values[id], 0.2);
  }

  private buildSliders() {
    clear(this.sliders);
    const groups = new Map<GeneGroup, GeneId[]>();
    for (const id of GENE_IDS) {
      if (!GENES[id].designable) continue;
      const g = GENES[id].group;
      groups.set(g, [...(groups.get(g) ?? []), id]);
    }
    for (const [group, ids] of groups) {
      const section = h('fieldset', {}, h('legend', {}, GROUP_LABELS[group]));
      for (const id of ids) {
        const lock = this.locked(id);
        const input = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: this.values[id], disabled: !!lock, 'aria-label': GENES[id].label });
        input.addEventListener('input', () => {
          this.values[id] = Number(input.value);
          this.dirty = true;
        });
        section.append(
          h('label', { class: `slider ${lock ? 'locked' : ''}`, title: lock ? `Discover “${lock}” to unlock` : `${GENES[id].low} ↔ ${GENES[id].high}` },
            h('span', {}, GENES[id].label, lock ? ' 🔒' : ''),
            input,
          ),
        );
      }
      this.sliders.append(section);
    }
  }

  private randomise() {
    this.values = express(randomGenome(Math.random));
    this.applyLocks();
    this.buildSliders();
    this.dirty = true;
  }

  private mutateAll() {
    const rng = mulberry32(Math.floor(Math.random() * 1e9));
    for (const id of GENE_IDS) {
      if (!GENES[id].designable || this.locked(id)) continue;
      this.values[id] = Math.min(1, Math.max(0, this.values[id] + (rng() - 0.5) * 0.2));
    }
    this.buildSliders();
    this.dirty = true;
  }

  private grow() {
    const err = this.ranch.growFromLab(homozygousGenome({ ...this.values }), this.nameInput.value.trim());
    if (err) {
      this.growBtn.textContent = err;
      setTimeout(() => this.updateGrowButton(), 2000);
      return;
    }
    this.close();
  }

  private updateGrowButton() {
    const cost = this.ranch.labCost;
    this.growBtn.textContent = cost === 0 ? '🌱 Grow it (first one is free)' : `🌱 Grow it (${cost} produce)`;
    this.growBtn.disabled = this.ranch.produceTotal < cost;
    this.growBtn.title = cost ? `Costs ${LAB_COST} produce. You have ${this.ranch.produceTotal}.` : '';
  }

  private rebuild() {
    this.dirty = false;
    if (this.rig) {
      this.rig.root.removeFromParent();
      this.rig.dispose();
    }
    const plan = planFromExpressed(this.values);
    const skel = buildSkeleton(plan);
    const abilities = computeAbilities(plan, skel);
    this.rig = buildCreature(plan, skel, genomeSeed(homozygousGenome(this.values)));
    // Rest pose: wings folded up.
    for (const w of this.rig.wings) w.pivot.rotation.x = -w.side * 1.1;
    this.rig.root.position.x = -(skel.head.center.x + skel.tail[skel.tail.length - 1].x) / 2;
    this.turntable.add(this.rig.root);
    const size = Math.max(skel.length, skel.reach + 0.5);
    this.camera.position.set(0, size * 0.55 + 0.6, size * 1.55 + 2);
    this.camera.lookAt(0, skel.reach * 0.45, 0);

    clear(this.info);
    this.info.append(h('p', { class: 'describe' }, describePlan(plan)));
    const list = h('div', { class: 'abilities' });
    for (const id of ABILITY_IDS) {
      const n = stars(abilities[id]);
      list.append(h('div', { class: 'ability' },
        h('span', { class: 'ability-label' }, `${ABILITIES[id].icon} ${ABILITIES[id].label}`),
        h('span', { class: 'bar' }, h('span', { class: 'fill', style: `width:${Math.round(abilities[id] * 100)}%` })),
        h('span', { class: 'stars' }, '★'.repeat(n) + '☆'.repeat(5 - n)),
      ));
    }
    this.info.append(list);
    this.updateGrowButton();
  }

  private loop = () => {
    if (!this.open || !this.renderer) return;
    this.frame = requestAnimationFrame(this.loop);
    const box = this.canvasBox.getBoundingClientRect();
    const w = Math.max(1, Math.floor(box.width));
    const hgt = Math.max(1, Math.floor(box.height));
    const canvas = this.renderer.domElement;
    if (canvas.width !== Math.floor(w * this.renderer.getPixelRatio()) || canvas.height !== Math.floor(hgt * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, hgt, false);
      this.camera.aspect = w / hgt;
      this.camera.updateProjectionMatrix();
    }
    if (this.dirty) this.rebuild();
    this.spin += 0.006;
    this.turntable.rotation.y = this.spin;
    this.renderer.render(this.scene, this.camera);
  };
}
