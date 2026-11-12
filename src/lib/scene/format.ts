// src/lib/scene/format.ts
//
// The stored 3D scene (docs/plans/2026-11-02-3d-scene-primitive.md, slice S1) and the
// one trust boundary for it: `props.scene` of a node marked `data-scene="three"`.
// Everything that reads a stored 3D scene (renderers, runtime, panel, generator,
// site operations) goes through parseScene and nothing else.
//
// "3D scene" here is the three.js primitive. It is not an FX scene (visual effects,
// src/lib/fxScene); see marker.ts for the vocabulary.
//
// The contract of parseScene:
//   - STRICT SHAPE. A wrong type, an unknown key, a bad name, a count over its cap,
//     a missing required field, a reference to something that is not there, an
//     `ease-in`, a `loop`: refused, with the path of the first problems found. The
//     scene is not repaired into something else.
//   - CLAMPED NUMBERS. A finite number outside its documented range is pulled to
//     the nearest end and reported as a warning (an exposure of 9 becomes 1.5). A
//     number that is not finite (NaN, Infinity, a string) is refused.
//   - NOTHING TRUSTED IS COPIED. The result is built from the known fields only, so
//     no key of the input survives by accident. A colour is `#rgb` or `#rrggbb`,
//     never a CSS expression; an id is a short name from a safe alphabet; a model or
//     image is a sha256 in lower-case hex, never an address.
//   - MARKERS ARE NAMES. A timeline marker emits `custom:<name>` into page behaviour,
//     so the name is a short lower-case word and nothing that could address a scope.
//   - ANCHORS. A key pinned to a page node (`{ anchor }`) is checked against the node
//     ids the caller passes in `known.anchors` and dropped with a warning when its
//     node is gone (a track keeps its other keys; a camera that would end up with no
//     key is refused). Without `known.anchors` the anchors are kept as written.
//   - UNKNOWN HASHES. With `known.models` / `known.images` (the site's library) an
//     asset or image that is not in it is refused. Without them only the shape is
//     checked, which is what a pure client of the format can do.
//
// PURE: no React, no DOM, no network, no three.js. Importable anywhere.

import { SCENE_PROP } from './marker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The sha256 of a site image, in lower-case hex. */
export type ImageRef = string;
export type Vec3 = [number, number, number];

export const ENVIRONMENTS = ['studio', 'hall', 'overcast', 'sunset', 'night'] as const;
export type EnvironmentName = (typeof ENVIRONMENTS)[number];
export const LIGHT_PRESETS = ['three-point', 'top', 'rim', 'none'] as const;
export type LightPreset = (typeof LIGHT_PRESETS)[number];
export const QUALITIES = ['auto', 'low', 'medium', 'high'] as const;
export type Quality = (typeof QUALITIES)[number];
export const INTROS = ['none', 'drive-in', 'lights-up'] as const;
export type Intro = (typeof INTROS)[number];
/** No `ease-in`: an entrance never starts slow. */
export const EASES = ['linear', 'smooth', 'out'] as const;
export type Ease = (typeof EASES)[number];
export const FRAMINGS = ['fixed', 'fit-width'] as const;
export type Framing = (typeof FRAMINGS)[number];
export const ROLES = ['paint', 'glass', 'wheels', 'emissive'] as const;
export type RoleName = (typeof ROLES)[number];
/** The curated effect presets (the plan's presets table). Parameters stay numbers with a clamp. */
export const EFFECT_PRESETS = [
  'dirt-wash', 'foam-film', 'wet-shine', 'wash-foam', 'water-jets', 'mist', 'dust', 'sparks-off',
  'wheels-roll', 'brushes-hug', 'paint-sweep', 'exit-daylight',
] as const;
export type EffectPreset = (typeof EFFECT_PRESETS)[number];

export interface SceneModel {
  id: string;
  /** The sha256 of a model in this site's library, never an address. */
  asset: string;
  position?: Vec3;
  rotation?: Vec3;
  scale?: number;
  clip?: string;
}

export interface SceneVariant { id: string; label: string; model: string }

export interface RoleBinding {
  paint?: string[];
  glass?: string[];
  wheels?: string[];
  emissive?: string[];
  dirtMask?: ImageRef;
}

export type CameraAt = number | { anchor: string };
export interface CameraKey { at: CameraAt; position: Vec3; target: Vec3; fov?: number; ease?: Ease }
export interface CameraTrack {
  keys: CameraKey[];
  follow?: string;
  framing?: Framing;
  phone?: { offsetY?: number; fov?: number };
}

export type TimelineDrive =
  | { scroll: { section: string } }
  | { time: { seconds: number } }
  | { state: { id: string } }
  | { still: true };

export interface TrackKey { at: CameraAt; value: number }
export interface Track { target: string; keys: TrackKey[]; ease?: Ease }
export interface TimelineMarker { at: number; emit: string }
export interface Timeline { drive: TimelineDrive; tracks: Track[]; markers?: TimelineMarker[] }

export interface EffectInstance { id: string; preset: EffectPreset; on: string; params?: Record<string, number> }

export type SceneBackground = { color: string } | { transparent: true } | { fade: [string, string] };

export interface StoredScene {
  version: 1;
  poster: ImageRef;
  title?: string;
  models: SceneModel[];
  variants?: SceneVariant[];
  roles?: Record<string, RoleBinding>;
  environment: { preset: EnvironmentName; exposure?: number };
  lights?: LightPreset;
  background?: SceneBackground;
  camera: CameraTrack;
  timeline: Timeline;
  effects?: EffectInstance[];
  quality?: Quality;
  calm?: { at: number } | 'poster';
  intro?: Intro;
  /** The visitor drags to rotate. A `still` drive only. */
  orbit?: boolean;
}

/** What the caller knows about the site, so references can be checked. All optional. */
export interface SceneKnown {
  /** sha256 of every model in the site's library. */
  models?: ReadonlySet<string>;
  /** sha256 of every site image. */
  images?: ReadonlySet<string>;
  /** Ids of the page nodes an `anchor` may name. */
  anchors?: ReadonlySet<string>;
}

export type SceneParse =
  | { ok: true; scene: StoredScene; warnings: string[] }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const SCENE_LIMITS = {
  models: 8,
  variants: 8,
  effects: 6,
  cameraKeys: 24,
  tracks: 32,
  trackKeys: 64,
  markers: 16,
  roleNames: 64,
  effectParams: 8,
  /** Longest id, name or anchor. */
  nameLength: 80,
  titleLength: 200,
  labelLength: 80,
  /** A model's bounding box is at most 1,000 units on a side, so a placement past it is nonsense. */
  coordinate: 1000,
  scale: [0.001, 1000] as const,
  fov: [10, 120] as const,
  exposure: [0.5, 1.5] as const,
  intensity: [0, 3] as const,
  seconds: [0.1, 120] as const,
  offsetY: [-1, 1] as const,
  /** Targets a track may drive: `model:<id>.<prop>`, `effect:<id>.<prop>`, `light:<name>.intensity`. */
  modelProps: ['x', 'y', 'z', 'rx', 'ry', 'rz', 'scale'],
  effectProps: ['amount', 'start', 'end'],
  lights: ['key', 'fill', 'rim', 'ambient'],
} as const;

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** A page node or section id, or a state id: no quotes, brackets or spaces, so it can never break out of a selector. */
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const MARKER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_ERRORS = 20;

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

class Reader {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];

  constructor(readonly known: SceneKnown) {}

  fail(path: string, message: string): undefined {
    if (this.errors.length < MAX_ERRORS) this.errors.push(`${path}: ${message}`);
    return undefined;
  }

  warn(path: string, message: string): void {
    if (this.warnings.length < MAX_ERRORS) this.warnings.push(`${path}: ${message}`);
  }

  /** An object with only the allowed keys. */
  obj(v: unknown, path: string, allowed: readonly string[]): Rec | undefined {
    if (!isRec(v)) return this.fail(path, 'must be an object');
    let clean = true;
    for (const key of Object.keys(v)) {
      if (allowed.includes(key)) continue;
      clean = false;
      this.fail(`${path}.${key}`, key === 'loop' ? 'loop is not offered: a scene plays once and stops' : 'is not part of the 3D scene format');
    }
    return clean ? v : undefined;
  }

  /** A list within its cap. */
  list(v: unknown, path: string, max: number, min = 0): unknown[] | undefined {
    if (!Array.isArray(v)) return this.fail(path, 'must be a list');
    if (v.length > max) return this.fail(path, `has ${v.length} entries, at most ${max} are allowed`);
    if (v.length < min) return this.fail(path, `needs at least ${min} ${min === 1 ? 'entry' : 'entries'}`);
    return v;
  }

  /** A finite number, clamped into [lo, hi] with a warning when it was outside. */
  num(v: unknown, path: string, [lo, hi]: readonly [number, number]): number | undefined {
    if (typeof v !== 'number' || !Number.isFinite(v)) return this.fail(path, 'must be a finite number');
    if (v < lo || v > hi) {
      const clamped = Math.min(hi, Math.max(lo, v));
      this.warn(path, `${v} is outside ${lo} to ${hi}, using ${clamped}`);
      return clamped;
    }
    return v;
  }

  unit(v: unknown, path: string): number | undefined {
    return this.num(v, path, [0, 1]);
  }

  /** A short name from the safe alphabet (ids). */
  id(v: unknown, path: string): string | undefined {
    if (typeof v !== 'string' || !ID.test(v)) return this.fail(path, 'must be a short name of letters, digits, hyphen and underscore (at most 40)');
    return v;
  }

  /** A page node id, section id or state id. */
  nodeId(v: unknown, path: string): string | undefined {
    if (typeof v !== 'string' || !NODE_ID.test(v)) return this.fail(path, 'must be a node id of letters, digits, hyphen, underscore, dot and colon (at most 80)');
    return v;
  }

  /** Free text of bounded length without control characters. */
  text(v: unknown, path: string, max: number, nonEmpty = true): string | undefined {
    if (typeof v !== 'string') return this.fail(path, 'must be text');
    if (CONTROL.test(v)) return this.fail(path, 'must not contain control characters');
    if (v.length > max) return this.fail(path, `is ${v.length} characters, at most ${max} are allowed`);
    if (nonEmpty && v.trim() === '') return this.fail(path, 'must not be empty');
    return v;
  }

  oneOf<T extends string>(v: unknown, path: string, values: readonly T[]): T | undefined {
    if (typeof v === 'string' && (values as readonly string[]).includes(v)) return v as T;
    return this.fail(path, `must be one of ${values.join(', ')}`);
  }

  ease(v: unknown, path: string): Ease | undefined {
    if (typeof v === 'string' && /^ease-?in/i.test(v)) return this.fail(path, 'ease-in is not offered: an entrance never starts slow');
    return this.oneOf(v, path, EASES);
  }

  colour(v: unknown, path: string): string | undefined {
    if (typeof v !== 'string' || !COLOUR.test(v)) return this.fail(path, 'must be a colour written #rgb or #rrggbb');
    return v.toLowerCase();
  }

  hash(v: unknown, path: string, kind: 'model' | 'image'): string | undefined {
    if (typeof v !== 'string' || !SHA256.test(v)) return this.fail(path, `must be the sha256 of a ${kind} in the site's library (64 lower-case hex digits), never an address`);
    const library = kind === 'model' ? this.known.models : this.known.images;
    if (library && !library.has(v)) return this.fail(path, `is not a ${kind} in this site's library`);
    return v;
  }

  vec3(v: unknown, path: string): Vec3 | undefined {
    const items = this.list(v, path, 3, 3);
    if (!items) return undefined;
    const out = items.map((n, i) => this.num(n, `${path}[${i}]`, [-SCENE_LIMITS.coordinate, SCENE_LIMITS.coordinate]));
    return out.every((n) => n !== undefined) ? (out as Vec3) : undefined;
  }

  /** A position on the timeline: 0 to 1, or a page node's id. Undefined with no error when the anchor is gone. */
  at(v: unknown, path: string): CameraAt | undefined | 'dropped' {
    if (isRec(v)) {
      const o = this.obj(v, path, ['anchor']);
      if (!o) return undefined;
      const anchor = this.nodeId(o.anchor, `${path}.anchor`);
      if (anchor === undefined) return undefined;
      if (this.known.anchors && !this.known.anchors.has(anchor)) {
        this.warn(path, `the node ${JSON.stringify(anchor)} is not on the page, so this key is dropped`);
        return 'dropped';
      }
      return { anchor };
    }
    return this.unit(v, path);
  }
}

/** Numbers named `at` must not run backwards (anchors are placed at run time and are left out of the check). */
function checkOrder(r: Reader, keys: { at: CameraAt }[], path: string): void {
  let last = -1;
  keys.forEach((k, i) => {
    if (typeof k.at !== 'number') return;
    if (k.at < last) r.fail(`${path}[${i}].at`, `${k.at} comes before the key before it (${last}); keys run from 0 to 1`);
    last = k.at;
  });
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function readModels(r: Reader, v: unknown): SceneModel[] | undefined {
  const items = r.list(v, 'scene.models', SCENE_LIMITS.models, 1);
  if (!items) return undefined;
  const ids = new Set<string>();
  const out: SceneModel[] = [];
  items.forEach((raw, i) => {
    const path = `scene.models[${i}]`;
    const o = r.obj(raw, path, ['id', 'asset', 'position', 'rotation', 'scale', 'clip']);
    if (!o) return;
    const id = r.id(o.id, `${path}.id`);
    const asset = r.hash(o.asset, `${path}.asset`, 'model');
    if (id !== undefined) {
      if (ids.has(id)) r.fail(`${path}.id`, `${id} is used twice`);
      ids.add(id);
    }
    const m: SceneModel = { id: id ?? '', asset: asset ?? '' };
    let ok = id !== undefined && asset !== undefined;
    if (o.position !== undefined) { const p = r.vec3(o.position, `${path}.position`); if (p) m.position = p; else ok = false; }
    if (o.rotation !== undefined) { const p = r.vec3(o.rotation, `${path}.rotation`); if (p) m.rotation = p; else ok = false; }
    if (o.scale !== undefined) { const s = r.num(o.scale, `${path}.scale`, SCENE_LIMITS.scale); if (s !== undefined) m.scale = s; else ok = false; }
    if (o.clip !== undefined) { const c = r.text(o.clip, `${path}.clip`, SCENE_LIMITS.nameLength); if (c !== undefined) m.clip = c; else ok = false; }
    if (ok) out.push(m);
  });
  return out;
}

function readVariants(r: Reader, v: unknown, modelIds: ReadonlySet<string>): SceneVariant[] | undefined {
  const items = r.list(v, 'scene.variants', SCENE_LIMITS.variants);
  if (!items) return undefined;
  const ids = new Set<string>();
  const out: SceneVariant[] = [];
  items.forEach((raw, i) => {
    const path = `scene.variants[${i}]`;
    const o = r.obj(raw, path, ['id', 'label', 'model']);
    if (!o) return;
    const id = r.id(o.id, `${path}.id`);
    const label = r.text(o.label, `${path}.label`, SCENE_LIMITS.labelLength);
    const model = r.id(o.model, `${path}.model`);
    if (id !== undefined) {
      if (ids.has(id)) r.fail(`${path}.id`, `${id} is used twice`);
      ids.add(id);
    }
    if (model !== undefined && !modelIds.has(model)) r.fail(`${path}.model`, `${model} is not one of the scene's models`);
    if (id !== undefined && label !== undefined && model !== undefined && modelIds.has(model)) out.push({ id, label, model });
  });
  return out;
}

function readRoles(r: Reader, v: unknown, modelIds: ReadonlySet<string>): Record<string, RoleBinding> | undefined {
  if (!isRec(v)) return r.fail('scene.roles', 'must be an object of model id to roles');
  const out: Record<string, RoleBinding> = {};
  for (const [model, raw] of Object.entries(v)) {
    const path = `scene.roles.${model}`;
    if (!modelIds.has(model)) { r.fail(path, `${model} is not one of the scene's models`); continue; }
    const o = r.obj(raw, path, [...ROLES, 'dirtMask']);
    if (!o) continue;
    const binding: RoleBinding = {};
    for (const role of ROLES) {
      if (o[role] === undefined) continue;
      const names = r.list(o[role], `${path}.${role}`, SCENE_LIMITS.roleNames);
      if (!names) continue;
      const clean = names.map((n, i) => r.text(n, `${path}.${role}[${i}]`, SCENE_LIMITS.nameLength));
      if (clean.every((n) => n !== undefined)) binding[role] = clean as string[];
    }
    if (o.dirtMask !== undefined) {
      const mask = r.hash(o.dirtMask, `${path}.dirtMask`, 'image');
      if (mask !== undefined) binding.dirtMask = mask;
    }
    out[model] = binding;
  }
  return out;
}

function readEnvironment(r: Reader, v: unknown): StoredScene['environment'] | undefined {
  const o = r.obj(v, 'scene.environment', ['preset', 'exposure']);
  if (!o) return undefined;
  const preset = r.oneOf(o.preset, 'scene.environment.preset', ENVIRONMENTS);
  const exposure = o.exposure === undefined ? undefined : r.num(o.exposure, 'scene.environment.exposure', SCENE_LIMITS.exposure);
  if (preset === undefined || (o.exposure !== undefined && exposure === undefined)) return undefined;
  return exposure === undefined ? { preset } : { preset, exposure };
}

function readBackground(r: Reader, v: unknown): SceneBackground | undefined {
  const o = r.obj(v, 'scene.background', ['color', 'transparent', 'fade']);
  if (!o) return undefined;
  const set = ['color', 'transparent', 'fade'].filter((k) => o[k] !== undefined);
  if (set.length !== 1) return r.fail('scene.background', 'must hold exactly one of color, transparent or fade');
  if (o.color !== undefined) { const c = r.colour(o.color, 'scene.background.color'); return c === undefined ? undefined : { color: c }; }
  if (o.transparent !== undefined) return o.transparent === true ? { transparent: true } : r.fail('scene.background.transparent', 'must be true');
  const pair = r.list(o.fade, 'scene.background.fade', 2, 2);
  if (!pair) return undefined;
  const [a, b] = pair.map((c, i) => r.colour(c, `scene.background.fade[${i}]`));
  return a === undefined || b === undefined ? undefined : { fade: [a, b] };
}

function readCamera(r: Reader, v: unknown, modelIds: ReadonlySet<string>): CameraTrack | undefined {
  const o = r.obj(v, 'scene.camera', ['keys', 'follow', 'framing', 'phone']);
  if (!o) return undefined;
  const raw = r.list(o.keys, 'scene.camera.keys', SCENE_LIMITS.cameraKeys, 1);
  const keys: CameraKey[] = [];
  let ok = raw !== undefined;
  (raw ?? []).forEach((item, i) => {
    const path = `scene.camera.keys[${i}]`;
    const k = r.obj(item, path, ['at', 'position', 'target', 'fov', 'ease']);
    if (!k) { ok = false; return; }
    const at = r.at(k.at, `${path}.at`);
    const position = r.vec3(k.position, `${path}.position`);
    const target = r.vec3(k.target, `${path}.target`);
    const fov = k.fov === undefined ? undefined : r.num(k.fov, `${path}.fov`, SCENE_LIMITS.fov);
    const ease = k.ease === undefined ? undefined : r.ease(k.ease, `${path}.ease`);
    if (at === undefined || !position || !target || (k.fov !== undefined && fov === undefined) || (k.ease !== undefined && ease === undefined)) { ok = false; return; }
    if (at === 'dropped') return;
    keys.push({ at, position, target, ...(fov !== undefined ? { fov } : {}), ...(ease ? { ease } : {}) });
  });
  if (raw && ok && keys.length === 0) r.fail('scene.camera.keys', 'every key was pinned to a node that is not on the page; the camera needs at least one key');
  checkOrder(r, keys, 'scene.camera.keys');
  const camera: CameraTrack = { keys };
  if (o.follow !== undefined) {
    const f = r.id(o.follow, 'scene.camera.follow');
    if (f !== undefined && !modelIds.has(f)) r.fail('scene.camera.follow', `${f} is not one of the scene's models`);
    else if (f !== undefined) camera.follow = f;
  }
  if (o.framing !== undefined) { const f = r.oneOf(o.framing, 'scene.camera.framing', FRAMINGS); if (f) camera.framing = f; }
  if (o.phone !== undefined) {
    const p = r.obj(o.phone, 'scene.camera.phone', ['offsetY', 'fov']);
    if (p) {
      const phone: NonNullable<CameraTrack['phone']> = {};
      if (p.offsetY !== undefined) { const n = r.num(p.offsetY, 'scene.camera.phone.offsetY', SCENE_LIMITS.offsetY); if (n !== undefined) phone.offsetY = n; }
      if (p.fov !== undefined) { const n = r.num(p.fov, 'scene.camera.phone.fov', SCENE_LIMITS.fov); if (n !== undefined) phone.fov = n; }
      camera.phone = phone;
    }
  }
  return r.errors.length ? undefined : camera;
}

function readDrive(r: Reader, v: unknown): TimelineDrive | undefined {
  const o = r.obj(v, 'scene.timeline.drive', ['scroll', 'time', 'state', 'still']);
  if (!o) return undefined;
  const set = ['scroll', 'time', 'state', 'still'].filter((k) => o[k] !== undefined);
  if (set.length !== 1) return r.fail('scene.timeline.drive', 'must hold exactly one of scroll, time, state or still');
  if (o.scroll !== undefined) {
    const s = r.obj(o.scroll, 'scene.timeline.drive.scroll', ['section']);
    const section = s && r.nodeId(s.section, 'scene.timeline.drive.scroll.section');
    return section === undefined ? undefined : { scroll: { section } };
  }
  if (o.time !== undefined) {
    const t = r.obj(o.time, 'scene.timeline.drive.time', ['seconds']);
    const seconds = t && r.num(t.seconds, 'scene.timeline.drive.time.seconds', SCENE_LIMITS.seconds);
    return seconds === undefined ? undefined : { time: { seconds } };
  }
  if (o.state !== undefined) {
    const s = r.obj(o.state, 'scene.timeline.drive.state', ['id']);
    const id = s && r.nodeId(s.id, 'scene.timeline.drive.state.id');
    return id === undefined ? undefined : { state: { id } };
  }
  return o.still === true ? { still: true } : r.fail('scene.timeline.drive.still', 'must be true');
}

function readTarget(r: Reader, v: unknown, path: string, modelIds: ReadonlySet<string>, effectIds: ReadonlySet<string>): string | undefined {
  const text = r.text(v, path, SCENE_LIMITS.nameLength);
  if (text === undefined) return undefined;
  const m = /^(model|effect|light):([A-Za-z0-9_-]+)\.([a-z]+)$/.exec(text);
  if (!m) return r.fail(path, 'must be model:<id>.<x|y|z|rx|ry|rz|scale>, effect:<id>.<amount|start|end> or light:<key|fill|rim|ambient>.intensity');
  const [, kind, name, prop] = m;
  if (kind === 'model') {
    if (!modelIds.has(name)) return r.fail(path, `${name} is not one of the scene's models`);
    if (!(SCENE_LIMITS.modelProps as readonly string[]).includes(prop)) return r.fail(path, `a model has no ${prop}; use x, y, z, rx, ry, rz or scale`);
  } else if (kind === 'effect') {
    if (!effectIds.has(name)) return r.fail(path, `${name} is not one of the scene's effects`);
    if (!(SCENE_LIMITS.effectProps as readonly string[]).includes(prop)) return r.fail(path, `an effect has no ${prop}; use amount, start or end`);
  } else {
    if (!(SCENE_LIMITS.lights as readonly string[]).includes(name)) return r.fail(path, `${name} is not a light; use key, fill, rim or ambient`);
    if (prop !== 'intensity') return r.fail(path, 'a light is driven through intensity only');
  }
  return text;
}

/** The range a track's value is clamped to, by what it drives. */
function valueRange(target: string): readonly [number, number] {
  const c = SCENE_LIMITS.coordinate;
  if (/^light:[A-Za-z0-9_-]+\.intensity$/.test(target)) return SCENE_LIMITS.intensity;
  if (/^effect:[A-Za-z0-9_-]+\.(amount|start|end)$/.test(target)) return [0, 1];
  if (/^model:[A-Za-z0-9_-]+\.scale$/.test(target)) return SCENE_LIMITS.scale;
  return [-c, c];
}

function readTimeline(r: Reader, v: unknown, modelIds: ReadonlySet<string>, effectIds: ReadonlySet<string>): Timeline | undefined {
  const o = r.obj(v, 'scene.timeline', ['drive', 'tracks', 'markers']);
  if (!o) return undefined;
  const drive = readDrive(r, o.drive);
  const rawTracks = r.list(o.tracks, 'scene.timeline.tracks', SCENE_LIMITS.tracks);
  const tracks: Track[] = [];
  (rawTracks ?? []).forEach((item, i) => {
    const path = `scene.timeline.tracks[${i}]`;
    const t = r.obj(item, path, ['target', 'keys', 'ease']);
    if (!t) return;
    const target = readTarget(r, t.target, `${path}.target`, modelIds, effectIds);
    const ease = t.ease === undefined ? undefined : r.ease(t.ease, `${path}.ease`);
    const rawKeys = r.list(t.keys, `${path}.keys`, SCENE_LIMITS.trackKeys, 1);
    const keys: TrackKey[] = [];
    (rawKeys ?? []).forEach((kr, j) => {
      const kp = `${path}.keys[${j}]`;
      const k = r.obj(kr, kp, ['at', 'value']);
      if (!k) return;
      const at = r.at(k.at, `${kp}.at`);
      const value = r.num(k.value, `${kp}.value`, valueRange(typeof t.target === 'string' ? t.target : ''));
      if (at === undefined || at === 'dropped' || value === undefined) return;
      keys.push({ at, value });
    });
    checkOrder(r, keys, `${path}.keys`);
    if (rawKeys && keys.length === 0 && rawKeys.length > 0) r.fail(`${path}.keys`, 'every key was pinned to a node that is not on the page; the track needs at least one key');
    if (target !== undefined && (t.ease === undefined || ease !== undefined)) tracks.push({ target, keys, ...(ease ? { ease } : {}) });
  });
  let markers: TimelineMarker[] | undefined;
  if (o.markers !== undefined) {
    const raw = r.list(o.markers, 'scene.timeline.markers', SCENE_LIMITS.markers);
    markers = [];
    (raw ?? []).forEach((item, i) => {
      const path = `scene.timeline.markers[${i}]`;
      const m = r.obj(item, path, ['at', 'emit']);
      if (!m) return;
      const at = r.unit(m.at, `${path}.at`);
      const emit = typeof m.emit === 'string' && MARKER_NAME.test(m.emit) ? m.emit : r.fail(`${path}.emit`, 'must be a short lower-case name (letters, digits, hyphen), fired as custom:<name>');
      if (at !== undefined && emit !== undefined) markers!.push({ at, emit });
    });
  }
  if (drive === undefined) return undefined;
  return { drive, tracks, ...(markers ? { markers } : {}) };
}

/** Parameters clamp by name where the plan names a range, else to the coordinate range. */
const PARAM_RANGES: ReadonlyMap<string, readonly [number, number]> = new Map<string, readonly [number, number]>(Object.entries({
  amount: [0, 1], strength: [0, 1], density: [0, 1], start: [0, 1], end: [0, 1],
  speed: [0, 2], intensity: [0, 3], clearcoat: [0, 1],
} as Record<string, readonly [number, number]>));

function readEffects(r: Reader, v: unknown, modelIds: ReadonlySet<string>): EffectInstance[] | undefined {
  const items = r.list(v, 'scene.effects', SCENE_LIMITS.effects);
  if (!items) return undefined;
  const ids = new Set<string>();
  const out: EffectInstance[] = [];
  items.forEach((raw, i) => {
    const path = `scene.effects[${i}]`;
    const o = r.obj(raw, path, ['id', 'preset', 'on', 'params']);
    if (!o) return;
    const id = r.id(o.id, `${path}.id`);
    const preset = r.oneOf(o.preset, `${path}.preset`, EFFECT_PRESETS);
    const on = r.id(o.on, `${path}.on`);
    if (id !== undefined) {
      if (ids.has(id)) r.fail(`${path}.id`, `${id} is used twice`);
      ids.add(id);
    }
    if (on !== undefined && !modelIds.has(on) && !(ROLES as readonly string[]).includes(on)) r.fail(`${path}.on`, `${on} is neither one of the scene's models nor a role (${ROLES.join(', ')})`);
    let params: Record<string, number> | undefined;
    if (o.params !== undefined) {
      if (!isRec(o.params)) r.fail(`${path}.params`, 'must be an object of numbers');
      else if (Object.keys(o.params).length > SCENE_LIMITS.effectParams) r.fail(`${path}.params`, `has more than ${SCENE_LIMITS.effectParams} parameters`);
      else {
        params = {};
        for (const [name, value] of Object.entries(o.params)) {
          if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(name)) { r.fail(`${path}.params.${name}`, 'is not a parameter name'); continue; }
          const n = r.num(value, `${path}.params.${name}`, PARAM_RANGES.get(name) ?? [-SCENE_LIMITS.coordinate, SCENE_LIMITS.coordinate]);
          if (n !== undefined) params[name] = n;
        }
      }
    }
    if (id !== undefined && preset !== undefined && on !== undefined) out.push({ id, preset, on, ...(params ? { params } : {}) });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const TOP_KEYS = [
  'version', 'poster', 'title', 'models', 'variants', 'roles', 'environment', 'lights', 'background',
  'camera', 'timeline', 'effects', 'quality', 'calm', 'intro', 'orbit',
] as const;

/**
 * Read a stored 3D scene (the value of `props.scene`). Refuses what is malformed,
 * clamps what is out of range, builds the result from known fields only. See the
 * header for the full contract.
 */
export function parseScene(input: unknown, known: SceneKnown = {}): SceneParse {
  const r = new Reader(known);
  const o = r.obj(input, SCENE_PROP, TOP_KEYS);
  if (!o) return { ok: false, errors: r.errors };

  if (o.version !== 1) r.fail('scene.version', 'must be 1');
  const poster = o.poster === undefined ? r.fail('scene.poster', 'is required: a site image shown first and whenever the scene cannot be') : r.hash(o.poster, 'scene.poster', 'image');
  const title = o.title === undefined ? undefined : r.text(o.title, 'scene.title', SCENE_LIMITS.titleLength);
  const models = readModels(r, o.models);
  const modelIds: ReadonlySet<string> = new Set((models ?? []).map((m) => m.id));
  const variants = o.variants === undefined ? undefined : readVariants(r, o.variants, modelIds);
  const roles = o.roles === undefined ? undefined : readRoles(r, o.roles, modelIds);
  const environment = o.environment === undefined ? r.fail('scene.environment', 'is required') : readEnvironment(r, o.environment);
  const lights = o.lights === undefined ? undefined : r.oneOf(o.lights, 'scene.lights', LIGHT_PRESETS);
  const background = o.background === undefined ? undefined : readBackground(r, o.background);
  const camera = o.camera === undefined ? r.fail('scene.camera', 'is required') : readCamera(r, o.camera, modelIds);
  const effects = o.effects === undefined ? undefined : readEffects(r, o.effects, modelIds);
  const effectIds: ReadonlySet<string> = new Set((effects ?? []).map((e) => e.id));
  const timeline = o.timeline === undefined ? r.fail('scene.timeline', 'is required') : readTimeline(r, o.timeline, modelIds, effectIds);
  const quality = o.quality === undefined ? undefined : r.oneOf(o.quality, 'scene.quality', QUALITIES);
  const intro = o.intro === undefined ? undefined : r.oneOf(o.intro, 'scene.intro', INTROS);
  let calm: StoredScene['calm'];
  if (o.calm !== undefined) {
    if (o.calm === 'poster') calm = 'poster';
    else {
      const c = r.obj(o.calm, 'scene.calm', ['at']);
      const at = c && r.unit(c.at, 'scene.calm.at');
      if (at !== undefined) calm = { at };
      else if (!c) r.fail('scene.calm', "must be 'poster' or { at: 0 to 1 }");
    }
  }
  let orbit: boolean | undefined;
  if (o.orbit !== undefined) {
    if (typeof o.orbit !== 'boolean') r.fail('scene.orbit', 'must be true or false');
    else if (o.orbit && timeline && !('still' in timeline.drive)) r.fail('scene.orbit', 'is for a still scene only: dragging and scrolling fight for the same gesture');
    else orbit = o.orbit;
  }

  if (timeline && 'still' in timeline.drive && !r.errors.length) {
    if (camera && camera.keys.length > 1) r.fail('scene.camera.keys', 'a still scene has one camera key, no motion');
    if (timeline.tracks.length > 0) r.fail('scene.timeline.tracks', 'a still scene has no tracks, no motion');
  }

  if (r.errors.length || !poster || !models || !environment || !camera || !timeline) {
    return { ok: false, errors: r.errors.length ? r.errors : ['scene: could not be read'] };
  }
  const scene: StoredScene = {
    version: 1,
    poster,
    ...(title !== undefined ? { title } : {}),
    models,
    ...(variants ? { variants } : {}),
    ...(roles ? { roles } : {}),
    environment,
    ...(lights ? { lights } : {}),
    ...(background ? { background } : {}),
    camera,
    timeline,
    ...(effects ? { effects } : {}),
    ...(quality ? { quality } : {}),
    ...(calm !== undefined ? { calm } : {}),
    ...(intro ? { intro } : {}),
    ...(orbit !== undefined ? { orbit } : {}),
  };
  return { ok: true, scene, warnings: r.warnings };
}
