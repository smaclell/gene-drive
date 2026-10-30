import * as THREE from 'three';

/**
 * A map-style camera that always looks at a focus point on the ground.
 * Simpler than an orbit camera: there is no free tilt to get lost in.
 *
 * - Drag (mouse or one finger): pan. The ground under the pointer follows it.
 * - Right-drag, Shift-drag or two-finger twist: rotate around the focus.
 * - Wheel or pinch: zoom. Tilt follows zoom: close up is side-on, far away looks down.
 * - WASD / arrow keys pan, Q / E rotate, + / - zoom, Home recentres.
 */

export interface CameraOptions {
  minDistance: number;
  maxDistance: number;
  /** The focus stays within this distance of the origin. */
  bounds: number;
  /** Ground height under a point, so the focus sits on the terrain. */
  groundAt: (x: number, z: number) => number;
}

const HOME = { x: 0, z: 2, yaw: 0.6, distance: 34 };

export class CameraRig {
  /** Point on the ground the camera looks at. */
  readonly focus = new THREE.Vector3(HOME.x, 0, HOME.z);
  yaw = HOME.yaw;
  distance = HOME.distance;
  /** Called when the player moves the camera themselves (so follow mode can stop). */
  onUserMove: () => void = () => {};

  private target = { x: HOME.x, z: HOME.z, yaw: HOME.yaw, distance: HOME.distance };
  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private grab: THREE.Vector3 | null = null;
  private rotating = false;
  private pinch: { dist: number; angle: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly dom: HTMLElement, private readonly opts: CameraOptions) {
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointercancel', this.onUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    this.apply();
  }

  /** Glide toward a point (used for follow mode and "take a look"). */
  lookAt(x: number, z: number, distance?: number) {
    this.target.x = x;
    this.target.z = z;
    if (distance !== undefined) this.target.distance = THREE.MathUtils.clamp(distance, this.opts.minDistance, this.opts.maxDistance);
  }

  home() {
    Object.assign(this.target, HOME);
    this.onUserMove();
  }

  update(dt: number) {
    // Keyboard: pan relative to the view, faster when zoomed out.
    const pan = this.distance * 0.9 * dt;
    let dx = 0;
    let dz = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) dz -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dz += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) dx += 1;
    if (dx || dz) {
      const c = Math.cos(this.yaw);
      const s = Math.sin(this.yaw);
      this.target.x += (dx * c + dz * s) * pan;
      this.target.z += (-dx * s + dz * c) * pan;
      this.onUserMove();
    }
    if (this.keys.has('q')) this.target.yaw += dt * 1.6;
    if (this.keys.has('e')) this.target.yaw -= dt * 1.6;
    if (this.keys.has('+') || this.keys.has('=')) this.zoomBy(Math.exp(-dt * 1.5));
    if (this.keys.has('-') || this.keys.has('_')) this.zoomBy(Math.exp(dt * 1.5));

    this.clampTarget();
    const k = 1 - Math.exp(-dt * 8);
    this.focus.x += (this.target.x - this.focus.x) * k;
    this.focus.z += (this.target.z - this.focus.z) * k;
    this.yaw += (this.target.yaw - this.yaw) * k;
    this.distance += (this.target.distance - this.distance) * k;
    this.apply();
  }

  private clampTarget() {
    const d = Math.hypot(this.target.x, this.target.z);
    if (d > this.opts.bounds) {
      this.target.x *= this.opts.bounds / d;
      this.target.z *= this.opts.bounds / d;
    }
    this.target.distance = THREE.MathUtils.clamp(this.target.distance, this.opts.minDistance, this.opts.maxDistance);
  }

  private apply() {
    const { minDistance, maxDistance, groundAt } = this.opts;
    const t = (this.distance - minDistance) / (maxDistance - minDistance);
    // Close up looks across the meadow; far away looks down on it.
    const pitch = THREE.MathUtils.lerp(0.28, 1.05, Math.pow(t, 0.7));
    this.focus.y = groundAt(this.focus.x, this.focus.z);
    const lift = THREE.MathUtils.lerp(1, 0, t);
    const look = new THREE.Vector3(this.focus.x, this.focus.y + lift, this.focus.z);
    this.camera.position.set(
      look.x + Math.sin(this.yaw) * Math.cos(pitch) * this.distance,
      look.y + Math.sin(pitch) * this.distance,
      look.z + Math.cos(this.yaw) * Math.cos(pitch) * this.distance,
    );
    this.camera.lookAt(look);
  }

  private zoomBy(f: number) {
    this.target.distance *= f;
  }

  /** Where a screen point hits the flat plane at the focus height. */
  private groundHit(x: number, y: number): THREE.Vector3 | null {
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.focus.y);
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  }

  private onDown = (e: PointerEvent) => {
    this.dom.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      this.grab = null;
      this.pinch = this.pinchState();
      return;
    }
    this.rotating = e.button === 2 || e.shiftKey;
    // Snap the target to where we are, so a drag starts from a still camera.
    Object.assign(this.target, { x: this.focus.x, z: this.focus.z, yaw: this.yaw });
    this.grab = this.rotating ? null : this.groundHit(e.clientX, e.clientY);
  };

  private onMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2 && this.pinch) {
      const now = this.pinchState();
      this.target.distance *= this.pinch.dist / Math.max(1, now.dist);
      this.target.yaw -= now.angle - this.pinch.angle;
      this.pinch = now;
      this.onUserMove();
      return;
    }
    if (this.rotating) {
      this.target.yaw -= (e.clientX - prev.x) * 0.008;
      this.yaw = this.target.yaw;
      this.onUserMove();
    } else if (this.grab) {
      const hit = this.groundHit(e.clientX, e.clientY);
      if (!hit) return;
      // Move the focus so the grabbed ground point stays under the pointer.
      this.target.x += this.grab.x - hit.x;
      this.target.z += this.grab.z - hit.z;
      this.clampTarget();
      this.focus.x = this.target.x;
      this.focus.z = this.target.z;
      this.apply();
      if (Math.hypot(e.clientX - prev.x, e.clientY - prev.y) > 0) this.onUserMove();
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      this.grab = null;
      this.rotating = false;
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoomBy(Math.exp(e.deltaY * 0.0012));
  };

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const key = e.key.toLowerCase();
    if (key === 'home') this.home();
    else this.keys.add(key);
  };

  private pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }
}
