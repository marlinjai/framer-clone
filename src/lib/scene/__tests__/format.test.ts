// parseScene: the one trust boundary for a stored 3D scene (not an FX scene).
// Each clamp and each refusal of docs/plans/2026-11-02-3d-scene-primitive.md, slice S1.

import { describe, expect, it } from 'vitest';
import { parseScene, SCENE_LIMITS, type StoredScene } from '../format';
import { isScene3d } from '../marker';

/* eslint-disable @typescript-eslint/no-explicit-any -- stored scenes are mutated loosely on purpose */
type Rec = Record<string, any>;
const H = (c: string) => c.repeat(64);
const POSTER = H('a');
const TRUCK = H('b');
const BUS = H('c');

/** A small scene that parses, as a plain object (what is stored). */
const valid = (): Rec => ({
  version: 1,
  poster: POSTER,
  models: [{ id: 'truck', asset: TRUCK, position: [0, 0, 0], scale: 1 }],
  environment: { preset: 'hall', exposure: 1 },
  camera: { keys: [{ at: 0, position: [0, 2, 6], target: [0, 1, 0], fov: 40, ease: 'out' }, { at: 1, position: [3, 2, 4], target: [0, 1, 0] }] },
  timeline: { drive: { scroll: { section: 'hall' } }, tracks: [{ target: 'model:truck.x', keys: [{ at: 0, value: -6 }, { at: 0.5, value: 0 }], ease: 'smooth' }] },
});

const ok = (input: unknown, known = {}) => {
  const r = parseScene(input, known);
  if (!r.ok) throw new Error(`expected a scene, got: ${r.errors.join('; ')}`);
  return r;
};
const refusal = (input: unknown, known = {}) => {
  const r = parseScene(input, known);
  if (r.ok) throw new Error('expected a refusal');
  return r.errors.join('\n');
};
const mutate = (fn: (s: Rec) => void) => { const s = valid(); fn(s); return s; };

describe('parseScene: a valid scene', () => {
  it('reads it back unchanged and with no warnings', () => {
    const r = ok(valid());
    expect(r.scene).toEqual(valid());
    expect(r.warnings).toEqual([]);
  });

  it('is stable: reading what it returns gives the same scene again', () => {
    const first = ok(mutate((s) => { s.title = 'A truck'; s.lights = 'three-point'; s.quality = 'high'; s.calm = { at: 0.5 }; s.intro = 'none'; })).scene;
    expect(ok(first).scene).toEqual(first);
  });

  it('builds the result from known fields only: nothing of the input leaks through by reference', () => {
    const input = valid();
    const { scene } = ok(input);
    input.models[0].id = 'changed';
    expect(scene.models[0].id).toBe('truck');
  });

  it('accepts a full scene using every optional part', () => {
    const r = ok({
      ...valid(),
      title: 'Truck wash',
      variants: [{ id: 'truck', label: 'Truck', model: 'truck' }, { id: 'bus', label: 'Bus', model: 'bus' }],
      models: [{ id: 'truck', asset: TRUCK, rotation: [0, 1, 0], clip: 'Drive' }, { id: 'bus', asset: BUS }],
      roles: { truck: { paint: ['Body'], glass: ['Glass'], wheels: ['Wheel_FL'], emissive: ['Lamp'], dirtMask: POSTER } },
      lights: 'rim',
      background: { fade: ['#000', '#112233'] },
      effects: [{ id: 'dirt', preset: 'dirt-wash', on: 'paint', params: { strength: 0.8, start: 0.1, end: 0.6 } }],
      timeline: { drive: { still: true }, tracks: [], markers: [{ at: 0.8, emit: 'shine' }] },
      orbit: true,
      calm: 'poster',
      intro: 'drive-in',
    });
    expect(r.warnings).toEqual([]);
    expect(r.scene.effects?.[0].preset).toBe('dirt-wash');
  });
});

describe('parseScene: clamps (the number is pulled in and reported, never refused)', () => {
  it.each<[string, (s: Rec) => void, (s: StoredScene) => unknown, number]>([
    ['exposure above range', (s) => { s.environment.exposure = 9; }, (s) => s.environment.exposure, 1.5],
    ['exposure below range', (s) => { s.environment.exposure = 0; }, (s) => s.environment.exposure, 0.5],
    ['fov above range', (s) => { s.camera.keys[0].fov = 500; }, (s) => s.camera.keys[0].fov, 120],
    ['fov below range', (s) => { s.camera.keys[0].fov = 1; }, (s) => s.camera.keys[0].fov, 10],
    ['scale above range', (s) => { s.models[0].scale = 1e9; }, (s) => s.models[0].scale, 1000],
    ['position beyond the 1000 unit box', (s) => { s.models[0].position = [5000, 0, -5000]; }, (s) => s.models[0].position, [1000, 0, -1000] as never],
    ['a key position past 0 to 1', (s) => { s.timeline.tracks[0].keys[1].at = 3; }, (s) => s.timeline.tracks[0].keys[1].at, 1],
    ['a time drive of 0 seconds', (s) => { s.timeline.drive = { time: { seconds: 0 } }; }, (s) => (s.timeline.drive as unknown as { time: { seconds: number } }).time.seconds, 0.1],
    ['a time drive of an hour', (s) => { s.timeline.drive = { time: { seconds: 3600 } }; }, (s) => (s.timeline.drive as unknown as { time: { seconds: number } }).time.seconds, 120],
    ['calm at past 1', (s) => { s.calm = { at: 2 }; }, (s) => (s.calm as { at: number }).at, 1],
    ['phone offset past 1', (s) => { s.camera.phone = { offsetY: 4 }; }, (s) => s.camera.phone?.offsetY, 1],
    ['effect strength past 1', (s) => { s.effects = [{ id: 'f', preset: 'foam-film', on: 'paint', params: { strength: 7 } }]; }, (s) => s.effects?.[0].params?.strength, 1],
    ['effect speed past 2', (s) => { s.effects = [{ id: 'w', preset: 'wheels-roll', on: 'wheels', params: { speed: 9 } }]; }, (s) => s.effects?.[0].params?.speed, 2],
    ['effect intensity past 3', (s) => { s.effects = [{ id: 'p', preset: 'paint-sweep', on: 'paint', params: { intensity: 50 } }]; }, (s) => s.effects?.[0].params?.intensity, 3],
  ])('%s', (_name, change, read, expected) => {
    const r = ok(mutate(change));
    expect(read(r.scene)).toEqual(expected);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('refuses a number that is not finite instead of clamping it', () => {
    for (const bad of [NaN, Infinity, -Infinity, '1', null]) {
      expect(refusal(mutate((s) => { s.environment.exposure = bad; }))).toMatch(/exposure: must be a finite number/);
    }
  });
});

describe('parseScene: refusals', () => {
  it('refuses a scene that is not an object', () => {
    for (const bad of [null, undefined, 'x', 3, [], [valid()]]) expect(refusal(bad)).toMatch(/must be an object/);
  });

  it('refuses another version', () => {
    expect(refusal(mutate((s) => { s.version = 2; }))).toMatch(/version: must be 1/);
    expect(refusal(mutate((s) => { delete s.version; }))).toMatch(/version/);
  });

  it('refuses a missing poster, a poster that is an address, and a poster that is not a hash', () => {
    expect(refusal(mutate((s) => { delete s.poster; }))).toMatch(/poster: is required/);
    expect(refusal(mutate((s) => { s.poster = 'https://example.com/p.png'; }))).toMatch(/poster: must be the sha256/);
    expect(refusal(mutate((s) => { s.poster = H('A'); }))).toMatch(/poster: must be the sha256/);
    expect(refusal(mutate((s) => { s.poster = 'a'.repeat(63); }))).toMatch(/poster: must be the sha256/);
  });

  it('refuses a model asset that is an address or path rather than a hash', () => {
    for (const asset of ['/models/truck.glb', 'https://cdn.example/t.glb', 'data:model/gltf-binary;base64,AAAA', '../x']) {
      expect(refusal(mutate((s) => { s.models[0].asset = asset; }))).toMatch(/models\[0\]\.asset: must be the sha256 of a model/);
    }
  });

  it('refuses an unknown model hash and an unknown poster hash when the library is given', () => {
    const known = { models: new Set([BUS]), images: new Set([POSTER]) };
    expect(refusal(valid(), known)).toMatch(/models\[0\]\.asset: is not a model in this site's library/);
    expect(parseScene(valid(), { models: new Set([TRUCK]), images: new Set([POSTER]) }).ok).toBe(true);
    expect(refusal(valid(), { models: new Set([TRUCK]), images: new Set([BUS]) })).toMatch(/poster: is not a image|poster: is not a .*image/);
  });

  it('refuses an unknown dirt mask hash when the library is given', () => {
    const s = mutate((x) => { x.roles = { truck: { dirtMask: H('d') } }; });
    expect(refusal(s, { models: new Set([TRUCK]), images: new Set([POSTER]) })).toMatch(/dirtMask: is not a image|dirtMask/);
  });

  it('refuses ease-in everywhere an ease is read', () => {
    for (const ease of ['ease-in', 'ease-in-out', 'easeIn']) {
      expect(refusal(mutate((s) => { s.camera.keys[0].ease = ease; }))).toMatch(/ease-in is not offered/);
      expect(refusal(mutate((s) => { s.timeline.tracks[0].ease = ease; }))).toMatch(/ease-in is not offered/);
    }
    expect(refusal(mutate((s) => { s.camera.keys[0].ease = 'bounce'; }))).toMatch(/must be one of linear, smooth, out/);
  });

  it('refuses a loop on the timeline, whatever its value', () => {
    for (const loop of [true, false]) {
      expect(refusal(mutate((s) => { s.timeline.drive = { time: { seconds: 4, loop } }; }))).toMatch(/loop is not offered/);
      expect(refusal(mutate((s) => { s.timeline.loop = loop; }))).toMatch(/loop is not offered/);
    }
  });

  it('refuses unknown keys at every level instead of carrying them', () => {
    expect(refusal(mutate((s) => { s.canvas = '<canvas>'; }))).toMatch(/scene\.canvas: is not part of the 3D scene format/);
    expect(refusal(mutate((s) => { s.models[0].src = 'x'; }))).toMatch(/models\[0\]\.src/);
    expect(refusal(mutate((s) => { s.camera.keys[0].lookAt = [0, 0, 0]; }))).toMatch(/lookAt/);
    expect(refusal(mutate((s) => { s.environment.map = 'https://x/y.hdr'; }))).toMatch(/environment\.map/);
  });

  it('refuses prototype-poisoning keys', () => {
    const poisoned = JSON.parse(JSON.stringify(valid()).replace('"version":1', '"version":1,"__proto__":{"x":1},"constructor":{}'));
    expect(refusal(poisoned)).toMatch(/not part of the 3D scene format/);
  });

  it('refuses scripts and markup anywhere a name or text is read', () => {
    expect(refusal(mutate((s) => { s.models[0].id = '<script>'; }))).toMatch(/models\[0\]\.id/);
    expect(refusal(mutate((s) => { s.title = 'ok\u0000bad'; }))).toMatch(/title: must not contain control characters/);
    expect(refusal(mutate((s) => { s.background = { color: 'url(javascript:alert(1))' }; }))).toMatch(/background\.color: must be a colour/);
    expect(refusal(mutate((s) => { s.background = { color: 'red' }; }))).toMatch(/must be a colour written #rgb/);
  });

  it('refuses over-long text', () => {
    expect(refusal(mutate((s) => { s.title = 'x'.repeat(SCENE_LIMITS.titleLength + 1); }))).toMatch(/title: is 201 characters/);
    expect(refusal(mutate((s) => { s.timeline.drive = { scroll: { section: 'x'.repeat(81) } }; }))).toMatch(/section/);
  });

  it('refuses each count over its cap, naming the cap, and never truncates', () => {
    const many = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));
    expect(refusal(mutate((s) => { s.models = many(9, (i) => ({ id: `m${i}`, asset: TRUCK })); }))).toMatch(/models: has 9 entries, at most 8/);
    expect(refusal(mutate((s) => { s.camera.keys = many(25, (i) => ({ at: i / 25, position: [0, 0, 1], target: [0, 0, 0] })); }))).toMatch(/camera\.keys: has 25 entries, at most 24/);
    expect(refusal(mutate((s) => { s.timeline.tracks = many(33, () => ({ target: 'model:truck.x', keys: [{ at: 0, value: 0 }] })); }))).toMatch(/tracks: has 33 entries, at most 32/);
    expect(refusal(mutate((s) => { s.effects = many(7, (i) => ({ id: `e${i}`, preset: 'mist', on: 'paint' })); }))).toMatch(/effects: has 7 entries, at most 6/);
    expect(refusal(mutate((s) => { s.timeline.markers = many(17, (i) => ({ at: 0.5, emit: `m${i}` })); }))).toMatch(/markers: has 17 entries, at most 16/);
    expect(refusal(mutate((s) => { s.models = []; }))).toMatch(/models: needs at least 1 entry/);
    expect(refusal(mutate((s) => { s.camera.keys = []; }))).toMatch(/camera\.keys: needs at least 1 entry/);
  });

  it('refuses a duplicate id and references to things that are not there', () => {
    expect(refusal(mutate((s) => { s.models.push({ id: 'truck', asset: BUS }); }))).toMatch(/truck is used twice/);
    expect(refusal(mutate((s) => { s.camera.follow = 'ghost'; }))).toMatch(/follow: ghost is not one of the scene's models/);
    expect(refusal(mutate((s) => { s.variants = [{ id: 'v', label: 'V', model: 'ghost' }]; }))).toMatch(/variants\[0\]\.model: ghost/);
    expect(refusal(mutate((s) => { s.roles = { ghost: { paint: ['Body'] } }; }))).toMatch(/roles\.ghost/);
    expect(refusal(mutate((s) => { s.effects = [{ id: 'e', preset: 'mist', on: 'ghost' }]; }))).toMatch(/effects\[0\]\.on: ghost/);
    expect(refusal(mutate((s) => { s.timeline.tracks[0].target = 'model:ghost.x'; }))).toMatch(/ghost is not one of the scene's models/);
    expect(refusal(mutate((s) => { s.timeline.tracks[0].target = 'effect:ghost.amount'; }))).toMatch(/ghost is not one of the scene's effects/);
  });

  it('refuses a track target outside the grammar', () => {
    for (const target of ['model:truck.opacity', 'light:sun.intensity', 'light:key.colour', 'document.cookie', 'model:truck', 'material:x.y']) {
      expect(refusal(mutate((s) => { s.timeline.tracks[0].target = target; }))).toMatch(/target/);
    }
    expect(ok(mutate((s) => { s.timeline.tracks[0].target = 'light:key.intensity'; })).scene.timeline.tracks[0].target).toBe('light:key.intensity');
  });

  it('refuses an effect preset that is not curated', () => {
    expect(refusal(mutate((s) => { s.effects = [{ id: 'e', preset: 'custom-shader', on: 'paint' }]; }))).toMatch(/effects\[0\]\.preset: must be one of dirt-wash/);
  });

  it('refuses a drive with none or several of scroll, time, state, still', () => {
    expect(refusal(mutate((s) => { s.timeline.drive = {}; }))).toMatch(/exactly one of scroll, time, state or still/);
    expect(refusal(mutate((s) => { s.timeline.drive = { still: true, scroll: { section: 'a' } }; }))).toMatch(/exactly one/);
    expect(refusal(mutate((s) => { s.timeline.drive = { still: false }; }))).toMatch(/still: must be true/);
  });

  it('refuses orbit on anything but a still scene', () => {
    expect(refusal(mutate((s) => { s.orbit = true; }))).toMatch(/orbit: is for a still scene only/);
    expect(ok(mutate((s) => { s.orbit = false; })).scene.orbit).toBe(false);
    expect(ok(mutate((s) => { s.timeline.drive = { still: true }; s.timeline.tracks = []; s.orbit = true; })).scene.orbit).toBe(true);
  });

  it('refuses marker names that could address something else than a custom event', () => {
    for (const emit of ['Shine', 'custom:shine', 'a b', '', '1x', 'x'.repeat(33), '__proto__']) {
      expect(refusal(mutate((s) => { s.timeline.markers = [{ at: 0.5, emit }]; }))).toMatch(/markers\[0\]\.emit/);
    }
    expect(ok(mutate((s) => { s.timeline.markers = [{ at: 0.5, emit: 'shine-point' }]; })).scene.timeline.markers).toEqual([{ at: 0.5, emit: 'shine-point' }]);
  });

  it('refuses keys that run backwards', () => {
    expect(refusal(mutate((s) => { s.camera.keys = [{ at: 0.8, position: [0, 0, 1], target: [0, 0, 0] }, { at: 0.2, position: [0, 0, 2], target: [0, 0, 0] }]; }))).toMatch(/comes before the key before it/);
  });

  it('refuses a background that is not exactly one of colour, transparent or fade', () => {
    expect(refusal(mutate((s) => { s.background = {}; }))).toMatch(/exactly one/);
    expect(refusal(mutate((s) => { s.background = { color: '#fff', transparent: true }; }))).toMatch(/exactly one/);
    expect(refusal(mutate((s) => { s.background = { transparent: false }; }))).toMatch(/must be true/);
    expect(refusal(mutate((s) => { s.background = { fade: ['#fff'] }; }))).toMatch(/needs at least 2|has 1/);
  });

  it('refuses a quality, intro, lights or environment outside the named values', () => {
    expect(refusal(mutate((s) => { s.quality = 'ultra'; }))).toMatch(/quality: must be one of auto, low, medium, high/);
    expect(refusal(mutate((s) => { s.intro = 'explode'; }))).toMatch(/intro: must be one of none, drive-in, lights-up/);
    expect(refusal(mutate((s) => { s.lights = 'sun'; }))).toMatch(/lights: must be one of/);
    expect(refusal(mutate((s) => { s.environment = { preset: 'https://hdr.example/x.hdr' }; }))).toMatch(/environment\.preset: must be one of studio, hall/);
    expect(refusal(mutate((s) => { s.environment = 'hall'; }))).toMatch(/environment: must be an object/);
    expect(refusal(mutate((s) => { delete s.environment; }))).toMatch(/environment: is required/);
  });

  it('reports several problems at once, with a path to each', () => {
    const errors = refusal(mutate((s) => { delete s.poster; s.quality = 'x'; s.camera.keys[0].ease = 'ease-in'; }));
    expect(errors.split('\n').length).toBeGreaterThanOrEqual(3);
  });
});

describe('parseScene: anchors', () => {
  const anchored = () => mutate((s) => {
    s.camera.keys = [{ at: 0, position: [0, 1, 5], target: [0, 1, 0] }, { at: { anchor: 'panel-two' }, position: [2, 1, 5], target: [0, 1, 0] }];
    s.timeline.tracks[0].keys = [{ at: 0, value: 0 }, { at: { anchor: 'panel-two' }, value: 3 }];
  });

  it('keeps an anchor as written when the caller does not know the page', () => {
    expect(ok(anchored()).scene.camera.keys[1].at).toEqual({ anchor: 'panel-two' });
  });

  it('keeps an anchor whose node is on the page', () => {
    const r = ok(anchored(), { anchors: new Set(['panel-two']) });
    expect(r.scene.camera.keys).toHaveLength(2);
    expect(r.warnings).toEqual([]);
  });

  it('drops a key whose node is gone, with a warning, and keeps the rest', () => {
    const r = ok(anchored(), { anchors: new Set(['other']) });
    expect(r.scene.camera.keys).toHaveLength(1);
    expect(r.scene.timeline.tracks[0].keys).toEqual([{ at: 0, value: 0 }]);
    expect(r.warnings.join('\n')).toMatch(/"panel-two" is not on the page/);
  });

  it('refuses a camera whose every key lost its node', () => {
    const s = anchored();
    s.camera.keys = [{ at: { anchor: 'gone' }, position: [0, 0, 1], target: [0, 0, 0] }];
    expect(refusal(s, { anchors: new Set() })).toMatch(/camera needs at least one key/);
  });

  it('refuses an anchor that is not exactly { anchor: text }', () => {
    const s = anchored();
    s.camera.keys[1].at = { anchor: 'a', extra: 1 };
    expect(refusal(s)).toMatch(/not part of the 3D scene format/);
    s.camera.keys[1].at = { anchor: '' };
    expect(refusal(s)).toMatch(/anchor: must not be empty/);
  });
});

describe('isScene3d', () => {
  it('marks a div with data-scene="three" and nothing else', () => {
    expect(isScene3d({ 'data-scene': 'three' })).toBe(true);
    expect(isScene3d({ 'data-scene': 'three' }, 'a')).toBe(false);
    expect(isScene3d({ 'data-scene': 'other' })).toBe(false);
    expect(isScene3d({ 'data-fx': 'scene' })).toBe(false);
    expect(isScene3d(null)).toBe(false);
    expect(isScene3d([])).toBe(false);
  });
});
