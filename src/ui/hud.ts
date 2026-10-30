import { ABILITIES, ABILITY_IDS, FLIGHT_THRESHOLD, stars } from '../genetics/abilities';
import { DISCOVERIES } from '../genetics/discoveries';
import { GENES, GENE_IDS, GROUP_LABELS, RECESSIVE_THRESHOLD, type GeneGroup, type GeneId } from '../genetics/genes';
import { describePlan } from '../genetics/phenotype';
import type { Creature } from '../sim/creature';
import { PRODUCE, PRODUCE_IDS } from '../sim/creature';
import { HERD_CAP, WELCOME_COST, type Ranch, type Toast } from '../sim/ranch';
import { VISITOR_THEMES } from '../sim/visitors';
import type { Sky } from '../world/sky';
import { clear, h, hslCss } from './dom';

/** Everything the HUD needs from the game loop. */
export interface GameApi {
  ranch: Ranch;
  sky: Sky;
  selected: () => Creature | null;
  select: (c: Creature | null, focus?: boolean) => void;
  breedingFrom: () => Creature | null;
  startBreeding: () => void;
  cancelBreeding: () => void;
  following: () => boolean;
  setFollow: (on: boolean) => void;
  speed: () => number;
  setSpeed: (s: number) => void;
  openLab: () => void;
}

type Drawer = 'herd' | 'journal' | 'help' | null;

const ORIGIN_LABEL: Record<Creature['origin'], string> = {
  founder: 'Founder',
  bred: 'Bred',
  visitor: 'Visitor',
  lab: 'Lab-grown',
};

export class Hud {
  private readonly root: HTMLElement;
  private readonly clock = h('span', { class: 'clock' });
  private readonly resources = h('div', { class: 'resources' });
  private readonly herdCount = h('span', { class: 'herd-count' });
  private readonly panel = h('aside', { class: 'panel creature-panel', hidden: true });
  private readonly drawer = h('aside', { class: 'panel drawer', hidden: true });
  private readonly toasts = h('div', { class: 'toasts' });
  private readonly banner = h('div', { class: 'banner', hidden: true });
  private readonly speedBtn = h('button', { class: 'chip-btn', title: 'Game speed' });
  private panelFor: Creature | null = null;
  private panelDynamic: { status: HTMLElement; breed: HTMLElement; growth: HTMLElement; follow: HTMLButtonElement } | null = null;
  private drawerMode: Drawer = null;
  private tickTimer = 0;

  constructor(parent: HTMLElement, private readonly game: GameApi) {
    const btn = (label: string, title: string, onClick: () => void, cls = 'chip-btn') => h('button', { class: cls, title, onclick: onClick }, label);
    this.speedBtn.addEventListener('click', () => {
      const next = this.game.speed() === 1 ? 3 : 1;
      this.game.setSpeed(next);
      this.refreshTop();
    });
    const top = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, h('strong', {}, 'Gene Drive'), this.clock),
      this.resources,
      h(
        'nav',
        { class: 'top-actions' },
        this.herdCount,
        btn('🐾 Herd', 'Your herd (H)', () => this.toggleDrawer('herd')),
        btn('📖 Journal', 'Discoveries (J)', () => this.toggleDrawer('journal')),
        btn('🧪 Lab', 'Design a creature (L)', () => this.game.openLab()),
        this.speedBtn,
        btn('?', 'How to play', () => this.toggleDrawer('help')),
      ),
    );
    this.root = h('div', { class: 'hud' }, top, this.banner, this.drawer, this.panel, this.toasts);
    parent.append(this.root);

    game.ranch.onToast = (t) => this.toast(t);
    game.ranch.onChange = () => this.refresh();
    this.refresh();
  }

  // ---- Refresh -------------------------------------------------------

  refresh() {
    this.refreshTop();
    const sel = this.game.selected();
    if (sel !== this.panelFor || (sel && sel.wild !== (this.panel.dataset.wild === '1'))) this.renderPanel(sel);
    else if (sel) this.renderPanelName(sel);
    this.renderBanner();
    if (this.drawerMode) this.renderDrawer();
  }

  /** Called every frame; does cheap updates a few times a second. */
  tick(dt: number) {
    this.tickTimer += dt;
    if (this.tickTimer < 0.3) return;
    this.tickTimer = 0;
    const { sky, ranch } = this.game;
    this.clock.textContent = `Day ${sky.dayNumber(ranch.time)} · ${sky.phaseName()}`;
    const sel = this.game.selected();
    if (sel && this.panelDynamic) {
      this.panelDynamic.status.textContent = sel.status;
      this.panelDynamic.growth.textContent = sel.adult ? '' : `Growing up… ${Math.round(((sel.growth - 0.45) / 0.55) * 100)}%`;
      const wait = Math.ceil(sel.breedReadyAt - ranch.time);
      this.panelDynamic.breed.textContent = sel.wild ? '' : !sel.adult ? 'Too young to breed' : wait > 0 ? `Resting · ready in ${wait}s` : 'Ready to breed';
      this.panelDynamic.follow.classList.toggle('on', this.game.following());
    }
    if (this.drawerMode === 'herd') this.renderDrawer();
  }

  private refreshTop() {
    const { ranch } = this.game;
    clear(this.resources);
    for (const id of PRODUCE_IDS) {
      this.resources.append(h('span', { class: 'res', title: PRODUCE[id].label }, `${PRODUCE[id].icon} ${ranch.resources[id]}`));
    }
    this.herdCount.textContent = `${ranch.herdSize}/${HERD_CAP}`;
    this.herdCount.title = 'Herd size (including eggs)';
    this.speedBtn.textContent = this.game.speed() === 1 ? '▶ 1×' : '⏩ 3×';
  }

  private renderBanner() {
    const from = this.game.breedingFrom();
    this.banner.hidden = !from;
    clear(this.banner);
    if (!from) return;
    this.banner.append(
      h('span', {}, `💕 Pick a partner for ${from.name} · picnic costs ${this.game.ranch.breedCost} produce`),
      h('button', { class: 'chip-btn', onclick: () => this.game.cancelBreeding() }, 'Cancel'),
    );
  }

  // ---- Creature panel ------------------------------------------------

  private renderPanelName(c: Creature) {
    const nameEl = this.panel.querySelector<HTMLInputElement>('.name-input');
    if (nameEl && document.activeElement !== nameEl) nameEl.value = c.name;
  }

  private renderPanel(c: Creature | null) {
    this.panelFor = c;
    clear(this.panel);
    this.panelDynamic = null;
    this.panel.hidden = !c;
    if (!c) return;
    this.panel.dataset.wild = c.wild ? '1' : '0';
    const { ranch } = this.game;
    const p = c.plan;

    const name = h('input', { class: 'name-input', value: c.name, maxlength: 16, 'aria-label': 'Name', spellcheck: false });
    name.addEventListener('change', () => ranch.rename(c, name.value));
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') name.blur();
      e.stopPropagation();
    });

    const status = h('span', { class: 'status' }, c.status);
    const breedState = h('span', { class: 'muted' });
    const growth = h('span', { class: 'muted' });
    const follow = h('button', { class: 'chip-btn', title: 'Camera follows (F)', onclick: () => this.game.setFollow(!this.game.following()) }, '🎥 Follow');

    const theme = c.theme ? VISITOR_THEMES.find((t) => t.id === c.theme)?.title : undefined;
    const lineage = c.parents ? `Child of ${c.parents[0]} × ${c.parents[1]}` : theme ? `${theme} stock` : ORIGIN_LABEL[c.origin];

    const actions = h('div', { class: 'actions' });
    if (c.wild) {
      actions.append(h('button', { class: 'primary', onclick: () => this.flash(ranch.welcome(c)) }, `🏡 Welcome (${WELCOME_COST})`));
    } else {
      actions.append(h('button', { class: 'primary', title: 'Breed (B)', onclick: () => this.game.startBreeding() }, '💕 Breed…'));
    }
    actions.append(follow);
    if (!c.wild) {
      actions.append(
        h('button', {
          class: 'chip-btn subtle',
          title: 'Release to the wild',
          onclick: () => {
            if (confirm(`Release ${c.name} back to the wild? This cannot be undone.`)) {
              ranch.release(c);
              this.game.select(null);
            }
          },
        }, 'Release'),
      );
    }

    const abilities = h('div', { class: 'abilities' });
    for (const id of ABILITY_IDS) {
      const info = ABILITIES[id];
      const score = c.abilities[id];
      const note = id === 'fly' && p.wingSpan > 0 && score < FLIGHT_THRESHOLD ? ' (too heavy to take off)' : '';
      abilities.append(
        h('div', { class: 'ability', title: info.blurb + note },
          h('span', { class: 'ability-label' }, `${info.icon} ${info.label}`),
          h('span', { class: 'bar' }, h('span', { class: 'fill', style: `width:${Math.round(score * 100)}%` })),
          h('span', { class: 'stars' }, '★'.repeat(stars(score)) + '☆'.repeat(5 - stars(score))),
        ),
      );
    }

    this.panel.append(
      h('div', { class: 'panel-head' },
        h('span', { class: 'swatch', style: `background:${hslCss(p.colour.body)};border-color:${hslCss(p.colour.accent)}` }),
        name,
        h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: () => this.game.select(null) }, '✕'),
      ),
      h('div', { class: 'meta' }, h('span', { class: 'tag' }, c.wild ? 'Wild visitor' : `Gen ${c.generation}`), h('span', {}, lineage)),
      h('div', { class: 'meta' }, status, growth, breedState),
      h('p', { class: 'describe' }, describePlan(p)),
      actions,
      h('h3', {}, 'Abilities'),
      abilities,
      this.genomeSection(c),
    );
    this.panelDynamic = { status, breed: breedState, growth, follow };
  }

  private genomeSection(c: Creature): HTMLElement {
    const details = h('details', { class: 'genome' });
    details.append(h('summary', {}, '🧬 Genome'));
    details.append(h('p', { class: 'muted small' }, 'Each gene has two alleles, one from each parent. The marker shows what the body expresses. A carrier hides a recessive trait that its children might show.'));
    const groups = new Map<GeneGroup, GeneId[]>();
    for (const id of GENE_IDS) {
      const g = GENES[id].group;
      groups.set(g, [...(groups.get(g) ?? []), id]);
    }
    for (const [group, ids] of groups) {
      details.append(h('h4', {}, GROUP_LABELS[group]));
      for (const id of ids) {
        const [a, b] = c.genome[id];
        const expressed = c.expressed[id];
        const def = GENES[id];
        const threshold = RECESSIVE_THRESHOLD[id];
        const carrier = threshold !== undefined && expressed < threshold && Math.max(a, b) >= threshold;
        details.append(
          h('div', { class: 'gene', title: `${def.label}: alleles ${a.toFixed(2)} / ${b.toFixed(2)} · ${def.expression}` },
            h('span', { class: 'gene-label' }, def.label, carrier ? h('span', { class: 'carrier' }, ' carrier') : null),
            h('span', { class: 'alleles' },
              h('span', { class: 'allele', style: `width:${a * 100}%` }),
              h('span', { class: 'allele b', style: `width:${b * 100}%` }),
              h('span', { class: 'expressed', style: `left:${expressed * 100}%` }),
            ),
            h('span', { class: 'mode' }, def.expression === 'dominant' ? 'dom' : def.expression === 'recessive' ? 'rec' : ''),
          ),
        );
      }
    }
    return details;
  }

  // ---- Drawers -------------------------------------------------------

  toggleDrawer(mode: Drawer) {
    this.drawerMode = this.drawerMode === mode ? null : mode;
    this.renderDrawer();
  }

  private renderDrawer() {
    clear(this.drawer);
    this.drawer.hidden = !this.drawerMode;
    if (!this.drawerMode) return;
    const close = h('button', { class: 'icon-btn', title: 'Close', onclick: () => this.toggleDrawer(null) }, '✕');
    if (this.drawerMode === 'herd') this.renderHerd(close);
    else if (this.drawerMode === 'journal') this.renderJournal(close);
    else this.renderHelp(close);
  }

  private renderHerd(close: HTMLElement) {
    const { ranch } = this.game;
    const sel = this.game.selected();
    const list = h('ul', { class: 'herd-list' });
    const sorted = [...ranch.creatures].sort((a, b) => Number(a.wild) - Number(b.wild) || b.generation - a.generation || a.name.localeCompare(b.name));
    for (const c of sorted) {
      list.append(
        h('li', { class: c === sel ? 'active' : '', onclick: () => this.game.select(c, true) },
          h('span', { class: 'swatch', style: `background:${hslCss(c.plan.colour.body)};border-color:${hslCss(c.plan.colour.accent)}` }),
          h('span', { class: 'herd-name' }, c.name, c.adult ? '' : ' 🍼', c.wild ? ' 🌿' : ''),
          h('span', { class: 'muted small' }, c.wild ? 'visitor' : `G${c.generation} · ${c.status}`),
        ),
      );
    }
    if (ranch.eggs.length) list.append(h('li', { class: 'muted' }, `🥚 ${ranch.eggs.length} egg${ranch.eggs.length > 1 ? 's' : ''} incubating`));
    this.drawer.append(h('div', { class: 'panel-head' }, h('h2', {}, '🐾 Herd'), close), list);
  }

  private renderJournal(close: HTMLElement) {
    const { ranch } = this.game;
    const found = DISCOVERIES.filter((d) => ranch.journal.has(d.id)).length;
    const grid = h('div', { class: 'journal' });
    for (const d of DISCOVERIES) {
      const has = ranch.journal.has(d.id);
      const unlocks = GENE_IDS.filter((id) => (GENES[id] as { unlockedBy?: string }).unlockedBy === d.id).map((id) => GENES[id].label);
      grid.append(
        h('div', { class: `entry ${has ? 'found' : ''}` },
          h('strong', {}, has ? d.title : '???'),
          h('span', { class: 'small muted' }, d.hint),
          unlocks.length ? h('span', { class: 'small unlock' }, `${has ? '🔓' : '🔒'} Lab: ${unlocks.join(', ')}`) : null,
        ),
      );
    }
    this.drawer.append(h('div', { class: 'panel-head' }, h('h2', {}, `📖 Journal · ${found}/${DISCOVERIES.length}`), close), grid);
  }

  private renderHelp(close: HTMLElement) {
    this.drawer.append(
      h('div', { class: 'panel-head' }, h('h2', {}, 'How to play'), close),
      h('div', { class: 'help' },
        h('p', {}, 'Every creature is grown from its genome. Its body decides what it can do: long necks reach high fruit, big feet dig, tails and fins swim, and wings that are big enough let it fly.'),
        h('ul', {},
          h('li', {}, 'Click a creature to see its abilities and genome.'),
          h('li', {}, 'Breed two adults with a picnic of produce. Babies mix both parents, and sometimes mutate.'),
          h('li', {}, 'Wings and glow are recessive. Two carriers can surprise you.'),
          h('li', {}, 'Wild visitors bring new genes. Welcome them before they wander off.'),
          h('li', {}, 'Fill the Journal to unlock Lab sliders for designing your own.'),
        ),
        h('p', { class: 'small muted' }, 'Drag to orbit · right-drag to pan · scroll to zoom · Esc deselects · B breed · F follow · H herd · J journal · L lab'),
        h('button', {
          class: 'chip-btn subtle',
          onclick: () => {
            if (confirm('Start a brand-new ranch? Your current herd will be lost.')) {
              this.game.select(null);
              this.game.ranch.reset();
            }
          },
        }, 'Start a new ranch'),
      ),
    );
  }

  // ---- Toasts --------------------------------------------------------

  toast(t: Toast) {
    const el = h('div', { class: 'toast' },
      t.icon ? h('span', { class: 'toast-icon' }, t.icon) : null,
      h('div', { class: 'toast-body' }, h('div', {}, t.text), t.detail ? h('div', { class: 'small muted' }, t.detail) : null),
    );
    const dismiss = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 300);
    };
    if (t.action) {
      const action = t.action;
      el.append(h('button', {
        class: 'primary small-btn',
        onclick: () => {
          action.run();
          dismiss();
        },
      }, action.label));
    }
    el.append(h('button', { class: 'icon-btn', title: 'Dismiss', onclick: dismiss }, '✕'));
    this.toasts.prepend(el);
    while (this.toasts.children.length > 5) this.toasts.lastElementChild?.remove();
    const life = t.life ?? 5;
    if (life > 0) setTimeout(dismiss, life * 1000);
  }

  /** Show an error string from a game action, if any. */
  flash(message: string | null) {
    if (message) this.toast({ icon: '💭', text: message, life: 4 });
  }

  get drawerOpen(): Drawer {
    return this.drawerMode;
  }
}
