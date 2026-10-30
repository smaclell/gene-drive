import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng';
import { DEFAULT_VOLUME, DEFAULT_VOLUMES, SOUND_GROUP_IDS, mtof, reviveVolumes, volumeGain } from '../src/sim/audio';
import { BEATS_PER_CHORD, SCALE_CLASSES, composePiece, scaleNotes } from '../src/sim/music';
import { Sound } from '../src/sim/sound';

/** Sound runs in browsers only; here we check the pure parts and that nothing throws without WebAudio. */
describe('sound settings', () => {
  it('fills in missing or broken volumes from old saves', () => {
    expect(reviveVolumes(undefined)).toEqual(DEFAULT_VOLUMES);
    expect(reviveVolumes({ music: 0 })).toEqual({ ...DEFAULT_VOLUMES, music: 0 });
    const odd = reviveVolumes({ ambience: 3, chimes: -1, creatures: 'loud', music: Number.NaN });
    expect(odd.ambience).toBe(1);
    expect(odd.chimes).toBe(0);
    expect(odd.creatures).toBe(DEFAULT_VOLUME);
    expect(odd.music).toBe(DEFAULT_VOLUME);
  });

  it('maps the default slider to unity gain and zero to silence', () => {
    expect(volumeGain(DEFAULT_VOLUME)).toBeCloseTo(1);
    expect(volumeGain(0)).toBe(0);
    expect(volumeGain(1)).toBeGreaterThan(1.9);
    expect(volumeGain(1)).toBeLessThan(2.2);
    expect(mtof(69)).toBeCloseTo(440);
  });
});

describe('music', () => {
  it('only plays pentatonic melody notes, in range, over whole chords', () => {
    for (let seed = 0; seed < 40; seed++) {
      for (const mood of ['day', 'night'] as const) {
        const piece = composePiece(mulberry32(seed), mood);
        const melody = piece.notes.filter((n) => n.part === 'melody');
        const pads = piece.notes.filter((n) => n.part === 'pad');
        expect(melody.length).toBeGreaterThan(0);
        expect(pads.length * BEATS_PER_CHORD + 4).toBe(piece.beats);
        for (const n of melody) {
          expect(SCALE_CLASSES).toContain(n.midi[0] % 12);
          expect(n.beat).toBeLessThanOrEqual(piece.beats);
        }
        const notes = melody.map((n) => n.midi[0]);
        if (mood === 'day') expect(Math.min(...notes)).toBeGreaterThanOrEqual(69);
        else expect(Math.max(...notes)).toBeLessThanOrEqual(79);
        // Sorted, so the player can schedule it front to back.
        for (let i = 1; i < piece.notes.length; i++) expect(piece.notes[i].beat).toBeGreaterThanOrEqual(piece.notes[i - 1].beat);
      }
    }
  });

  it('is slower at night and reproducible from a seed', () => {
    const day = composePiece(mulberry32(5), 'day');
    const night = composePiece(mulberry32(5), 'night');
    expect(night.bpm).toBeLessThan(day.bpm);
    expect(composePiece(mulberry32(5), 'day')).toEqual(day);
  });

  it('lists scale notes', () => {
    expect(scaleNotes(60, 72)).toEqual([62, 64, 66, 69, 71]);
  });
});

describe('without WebAudio', () => {
  it('does nothing, quietly', () => {
    const sound = new Sound();
    const plan = { voice: { timbre: 'coo', pitch: 400 } } as never;
    expect(() => {
      sound.voices.unlock();
      sound.voices.muted = true;
      sound.voices.muted = false;
      sound.voices.call(plan, 'hello', { x: 0, z: 0 }, true);
      sound.update(0.016, 0.5, { focus: { x: 1, z: 2 }, yaw: 0, distance: 20 });
      sound.sfx.creature('step', { x: 0, z: 0 }, 1, 'walk');
      sound.sfx.chime('discovery');
      for (const id of SOUND_GROUP_IDS) sound.setVolume(id, 0.3);
    }).not.toThrow();
    expect(sound.voices.listener.x).toBe(1);
    expect(sound.engine.running).toBe(false);
  });
});
