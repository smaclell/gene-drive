import { Ambience } from './ambience';
import { AudioEngine, SOUND_GROUP_IDS, type SoundGroup, type Volumes } from './audio';
import { Music } from './music';
import { Sfx } from './sfx';
import { Voices } from './voice';

/**
 * Everything the ranch can hear, in one place: the shared engine plus
 * creature voices, effects, the ambience bed and the music. The ranch owns
 * one; the main loop calls `update` once a frame with the camera.
 */
export class Sound {
  readonly engine = new AudioEngine();
  readonly voices = new Voices(this.engine);
  readonly sfx = new Sfx(this.engine);
  private readonly ambience = new Ambience(this.engine);
  private readonly music = new Music(this.engine);

  /** `sunHeight` is 1 at noon and -1 at midnight; the camera is where the player listens from. */
  update(dt: number, sunHeight: number, camera: { focus: { x: number; z: number }; yaw: number; distance: number }) {
    const l = this.engine.listener;
    l.x = camera.focus.x;
    l.z = camera.focus.z;
    l.yaw = camera.yaw;
    l.distance = camera.distance;
    if (!this.engine.running) return;
    this.ambience.update(dt, sunHeight);
    this.music.update(sunHeight);
  }

  setVolume(group: SoundGroup, v: number) {
    this.engine.setVolume(group, v);
  }

  setVolumes(volumes: Volumes) {
    for (const id of SOUND_GROUP_IDS) this.engine.setVolume(id, volumes[id]);
  }
}
