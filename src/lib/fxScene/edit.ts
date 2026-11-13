// src/lib/fxScene/edit.ts
//
// Every change the editor makes to an FX scene (src/lib/fxScene/fxScene.ts), as pure
// functions from the stored `fx` prop to the next one. The properties panel, the
// palette and later the generator and the agent's site operations all go through
// here, so there is one implementation of each change.
//
// Each function reads the stored prop through the strict reader, changes the scene,
// and passes the result through the strict reader AGAIN before handing it back:
// what comes out is always something the reader accepts, with the reader's own
// repairs applied and reported. That second pass is what keeps the scene whole when
// a change has consequences elsewhere in it. Removing the layer that god rays read
// from, for instance, moves the god rays to another content layer, with a note.
//
// A change that cannot be made (an unknown layer, one layer too many, an image the
// site does not store) is refused with a message a person can act on, and the stored
// prop stays as it was.
//
// PURE: no React, no DOM, no three.js (the engine's render-free entry).

import {
  FX_CALM_MODES,
  FX_DEFAULT_CALM,
  FX_DEFAULT_START,
  FX_LIMITS,
  FX_SOURCE_LAYER_PARAM,
  FX_START_MODES,
  PRESETS,
  appendLayer,
  duplicateLayer,
  getLayerSchema,
  instantiateLayer,
  layerReadsPointer,
  moveLayerTo,
  placeInGroup,
  removeLayer,
  sceneToJSON,
  toggleLayer,
  type BlendMode,
  type FxCalm,
  type FxStart,
  type InteractivitySpec,
  type Layer,
  type ParamSchema,
  type ParsedFx,
  type SceneConfig,
  type StoredFx,
} from '@/lib/fx/format';
import { parseFxProp, storedFxProp } from './fxScene';

/** The outcome of one change: the prop to store and what the reader repaired, or why nothing changed. */
export type FxEdit = { ok: true; stored: StoredFx; fx: ParsedFx; notes: string[] } | { ok: false; message: string };

/** The preset a new FX scene box starts from: the lumitra.co hero. */
export const FX_DEFAULT_PRESET = 'gold-noise-gradient';

/**
 * The box's own CSS background for each preset: what a visitor sees until the scene
 * is drawn, and for good without JavaScript or WebGL or (by default) under reduced
 * motion. The gold one is lumitra.co's own painted background, from lumitra-web
 * `src/components/hub/HubHome.tsx` at commit 8a77254. The others are the scene's
 * background colour: honest, and never brighter than what the scene fades in over it.
 */
const PRESET_BACKGROUNDS: Readonly<Record<string, string>> = {
  'gold-noise-gradient':
    'radial-gradient(60% 50% at 20% 15%, rgba(201, 160, 74, 0.28), transparent 70%), radial-gradient(45% 40% at 85% 60%, rgba(107, 78, 20, 0.35), transparent 70%), #000000',
};

export interface FxPresetOption {
  id: string;
  label: string;
  blurb: string;
}

/** The presets a scene can start from, the default first. */
export function fxPresetOptions(): FxPresetOption[] {
  return PRESETS.map(({ id, label, blurb }) => ({ id, label, blurb }));
}

/** `earlier` are the repairs the first read of the stored prop reported: the edit saves them, so it reports them too. */
function finish(next: ParsedFx, earlier: readonly string[] = []): FxEdit {
  const stored = storedFxProp(next);
  const checked = parseFxProp(stored);
  if (!checked.ok) return checked;
  return { ok: true, stored: storedFxProp(checked.fx), fx: checked.fx, notes: [...new Set([...earlier, ...checked.notes])] };
}

/** Read `current`, apply `change` to the scene, and check the result. */
function change(current: unknown, apply: (fx: ParsedFx) => ParsedFx | string | { fx: ParsedFx; notes: string[] }): FxEdit {
  const read = parseFxProp(current);
  if (!read.ok) return read;
  const next = apply(read.fx);
  if (typeof next === 'string') return { ok: false, message: next };
  if ('scene' in next) return finish(next, read.notes);
  return finish(next.fx, [...read.notes, ...next.notes]);
}

const withScene = (fx: ParsedFx, scene: SceneConfig): ParsedFx => ({ ...fx, scene });
const withLayers = (fx: ParsedFx, layers: Layer[]): ParsedFx => withScene(fx, { ...fx.scene, layers });
const NO_LAYER = 'That layer is no longer in the scene.';

// --- effects that apply to one content layer (`Layer.target`) ----------------------------------
// The strict reader DROPS a target it cannot keep (the effect then applies to the whole scene) and
// says so in a note. These helpers make sure no edit of ours leads there silently: a change that
// would un-scope an effect either keeps the target right or is refused with a reason.

const isPost = (l: Layer): boolean => fxLayerKind(l.type) === 'post';
const isContent = (l: Layer): boolean => fxLayerKind(l.type) === 'content';
/** Whether this kind of layer names another layer it reads (god rays). */
const readsSource = (type: string): boolean => getLayerSchema(type)?.defaultParams[FX_SOURCE_LAYER_PARAM]?.type === 'select';
const sourceOf = (l: Layer): string | null => {
  const p = l.params[FX_SOURCE_LAYER_PARAM];
  return p && p.type === 'select' ? p.value : null;
};
const targetedIds = (layers: readonly Layer[]): Set<string> => new Set(layers.flatMap((l) => (l.target ? [l.target] : [])));
const withSource = (l: Layer, id: string): Layer => {
  const p = l.params[FX_SOURCE_LAYER_PARAM];
  return p && p.type === 'select' ? { ...l, params: { ...l.params, [FX_SOURCE_LAYER_PARAM]: { ...p, value: id } } } : l;
};
const withoutTarget = (l: Layer): Layer => {
  const { target: _target, ...rest } = l;
  void _target;
  return rest as Layer;
};

/**
 * Point every layer that reads `fromId` at `toId` instead. `toId === null` picks the first content
 * layer that has no effects of its own (an effect that reads a layer needs it in the main picture),
 * or leaves the readers alone when the scene has no other content layer (the reader repairs that
 * case), or returns the reason it cannot be done when every other content layer is scoped.
 */
function repointReaders(layers: Layer[], fromId: string, toId: string | null): { layers: Layer[]; notes: string[] } | string {
  const readers = layers.filter((l) => sourceOf(l) === fromId);
  if (readers.length === 0) return { layers, notes: [] };
  let replacement = toId;
  if (replacement === null) {
    const content = layers.filter((l) => isContent(l) && l.id !== fromId);
    if (content.length === 0) return { layers, notes: [] };
    const taken = targetedIds(layers);
    replacement = content.find((l) => !taken.has(l.id))?.id ?? null;
    if (replacement === null) {
      return `${readers[0].name} reads this layer, and every other layer of the scene has effects of its own, which ${readers[0].name} cannot read from. Move those effects to the whole scene first.`;
    }
  }
  const to = replacement;
  const name = layers.find((l) => l.id === to)?.name ?? to;
  return {
    layers: layers.map((l) => (sourceOf(l) === fromId ? withSource(l, to) : l)),
    notes: readers.map((r) => `${r.name} now reads from ${name}.`),
  };
}

/** The layer a new or retyped god rays should read: the first content layer with no effects of its own, or why there is none. `undefined` when the scene has no content layer at all. */
function sourceFor(layers: readonly Layer[], exceptId?: string): string | null | undefined {
  const content = layers.filter((l) => isContent(l) && l.id !== exceptId);
  if (content.length === 0) return undefined;
  const taken = targetedIds(layers);
  return content.find((l) => !taken.has(l.id))?.id ?? null;
}
const ALL_SCOPED = 'Every content layer of this scene has effects of its own, and this kind of layer reads a layer from the main picture. Move one layer\'s effects to the whole scene first.';


/** A new scene from a preset: the prop to store and the CSS background the box falls back to. */
export function fxFromPreset(presetId: string = FX_DEFAULT_PRESET): (FxEdit & { ok: true; background: string }) | { ok: false; message: string } {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return { ok: false, message: `There is no FX preset called "${presetId}".` };
  const scene = preset.load();
  const made = finish({ scene, start: FX_DEFAULT_START, calm: FX_DEFAULT_CALM });
  if (!made.ok) return made;
  return { ...made, background: PRESET_BACKGROUNDS[presetId] ?? made.fx.scene.background };
}

/** Replace the scene by a preset's, keeping when it starts and what reduced motion shows. */
export function applyFxPreset(current: unknown, presetId: string): FxEdit {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return { ok: false, message: `There is no FX preset called "${presetId}".` };
  const read = parseFxProp(current);
  // A box whose scene is missing or refused gets a fresh one: this is its way forward.
  const base: ParsedFx = read.ok ? read.fx : { scene: preset.load(), start: FX_DEFAULT_START, calm: FX_DEFAULT_CALM };
  return finish(withScene(base, preset.load()));
}

export function setFxStart(current: unknown, start: FxStart): FxEdit {
  if (!(FX_START_MODES as readonly string[]).includes(start)) return { ok: false, message: `"${start}" is not a way to start a scene.` };
  return change(current, (fx) => ({ ...fx, start }));
}

export function setFxCalm(current: unknown, calm: FxCalm): FxEdit {
  if (!(FX_CALM_MODES as readonly string[]).includes(calm)) return { ok: false, message: `"${calm}" is not a reduced motion setting.` };
  return change(current, (fx) => ({ ...fx, calm }));
}

/** The scene's own background colour (drawn behind its layers; not the box's CSS background). */
export function setFxBackground(current: unknown, background: string): FxEdit {
  return change(current, (fx) => withScene(fx, { ...fx.scene, background }));
}

/**
 * Set one parameter of one layer. The value is stored as given and the strict reader
 * decides: out of range is clamped, the wrong kind falls back to the default, each
 * with a note, and an image address the site does not store refuses the change.
 */
export function setFxParam(current: unknown, layerId: string, key: string, value: ParamSchema['value']): FxEdit {
  return change(current, (fx) => {
    const layer = fx.scene.layers.find((l) => l.id === layerId);
    if (!layer) return NO_LAYER;
    const schema = layer.params[key];
    if (!schema) return `This layer has no setting called "${key}".`;
    if (key === FX_SOURCE_LAYER_PARAM && typeof value === 'string' && targetedIds(fx.scene.layers).has(value)) {
      const name = fx.scene.layers.find((l) => l.id === value)?.name ?? value;
      return `${name} has effects of its own, so ${layer.name} cannot read it. Move those effects to the whole scene, or pick another layer.`;
    }
    const next = { ...layer, params: { ...layer.params, [key]: { ...schema, value } as ParamSchema } };
    return withLayers(fx, fx.scene.layers.map((l) => (l === layer ? next : l)));
  });
}

/** Add a layer of a built-in type at the front (the end of the list), with its default settings. */
export function addFxLayer(current: unknown, type: string): FxEdit & { layerId?: string } {
  let layerId: string | undefined;
  const edit = change(current, (fx) => {
    if (fx.scene.layers.length >= FX_LIMITS.layers) return `A scene can hold at most ${FX_LIMITS.layers} layers. Remove one first.`;
    let layer = instantiateLayer(type, fx.scene.layers);
    if (!layer) return `"${type}" is not a kind of layer.`;
    if (readsSource(layer.type)) {
      const source = sourceFor(fx.scene.layers);
      if (source === null) return ALL_SCOPED;
      if (source !== undefined) layer = withSource(layer, source);
    }
    layerId = layer.id;
    return withLayers(fx, appendLayer(fx.scene.layers, layer));
  });
  return edit.ok ? { ...edit, layerId } : edit;
}

/**
 * Remove a layer. The effects that applied only to it go with it (never silently to the whole
 * scene), and an effect that read it moves to another layer, or the removal is refused.
 */
export function removeFxLayer(current: unknown, layerId: string): FxEdit {
  return change(current, (fx) => {
    const layer = fx.scene.layers.find((l) => l.id === layerId);
    if (!layer) return NO_LAYER;
    let layers = removeLayer(fx.scene.layers, layerId);
    const notes: string[] = [];
    if (isContent(layer)) {
      const nested = layers.filter((l) => l.target === layerId);
      if (nested.length > 0) {
        layers = layers.filter((l) => l.target !== layerId);
        notes.push(`${nested.map((l) => l.name).join(', ')} applied only to ${layer.name} and ${nested.length === 1 ? 'was' : 'were'} removed with it.`);
      }
      const moved = repointReaders(layers, layerId, null);
      if (typeof moved === 'string') return moved;
      layers = moved.layers;
      notes.push(...moved.notes);
    }
    return { fx: withLayers(fx, layers), notes };
  });
}

/**
 * Move a layer by `delta` places WITHIN ITS GROUP (`1` toward the front, `-1` toward the back),
 * never across content and post: that would change nothing on screen. At the edge of the group
 * the change is refused with a reason and nothing is stored (`moveFxLayer` keeps its quiet no-op).
 */
export function moveFxLayerTo(current: unknown, layerId: string, toIndex: number): FxEdit {
  return change(current, (fx) => {
    const moved = moveLayerTo(fx.scene.layers, layerId, toIndex);
    return moved.ok ? withLayers(fx, moved.layers) : moved.reason;
  });
}

/** `moveFxLayerTo` by a step: one place toward the front (`1`) or the back (`-1`) of the layer's group. */
export function stepFxLayer(current: unknown, layerId: string, delta: -1 | 1): FxEdit {
  const read = parseFxProp(current);
  if (!read.ok) return read;
  const place = placeInGroup(read.fx.scene.layers, layerId);
  if (!place) return { ok: false, message: NO_LAYER };
  const target = place.index + delta;
  if (target < 0 || target >= place.size) {
    const name = read.fx.scene.layers.find((l) => l.id === layerId)?.name ?? 'This layer';
    return { ok: false, message: `${name} is already at the ${delta > 0 ? 'front' : 'back'} of its group.` };
  }
  return moveFxLayerTo(current, layerId, target);
}

/** Copy a layer with a new id, directly in front of the original. Refused past the scene's layer limit. Returns the copy's id. */
export function duplicateFxLayer(current: unknown, layerId: string): FxEdit & { layerId?: string } {
  let copyId: string | undefined;
  const edit = change(current, (fx) => {
    const copied = duplicateLayer(fx.scene.layers, layerId, FX_LIMITS.layers, FX_LIMITS.name);
    if (!copied.ok) return copied.reason;
    copyId = copied.layerId;
    return withLayers(fx, copied.layers);
  });
  return edit.ok ? { ...edit, layerId: copyId } : edit;
}

/** Show or hide a layer. */
export function toggleFxLayer(current: unknown, layerId: string): FxEdit {
  return change(current, (fx) => (fx.scene.layers.some((l) => l.id === layerId) ? withLayers(fx, toggleLayer(fx.scene.layers, layerId)) : NO_LAYER));
}

export function renameFxLayer(current: unknown, layerId: string, name: string): FxEdit {
  return change(current, (fx) => {
    if (!fx.scene.layers.some((l) => l.id === layerId)) return NO_LAYER;
    return withLayers(fx, fx.scene.layers.map((l) => (l.id === layerId ? { ...l, name } : l)));
  });
}

export function setFxLayerBlend(current: unknown, layerId: string, blend: BlendMode): FxEdit {
  return change(current, (fx) => {
    if (!fx.scene.layers.some((l) => l.id === layerId)) return NO_LAYER;
    return withLayers(fx, fx.scene.layers.map((l) => (l.id === layerId ? { ...l, blend } : l)));
  });
}

/**
 * Change what kind of layer one layer is. Its settings are the new kind's defaults (the
 * old kind's settings mean nothing to it), it keeps its place, visibility and blend mode,
 * and every other layer is untouched. Choosing the kind it already is changes nothing.
 */
export function setFxLayerType(current: unknown, layerId: string, type: string): FxEdit & { layerId?: string } {
  let nextId: string | undefined;
  const edit = change(current, (fx) => {
    const layer = fx.scene.layers.find((l) => l.id === layerId);
    if (!layer) return NO_LAYER;
    if (layer.type === type) {
      nextId = layer.id;
      return fx;
    }
    const others = fx.scene.layers.filter((l) => l !== layer);
    const fresh = instantiateLayer(type, others);
    if (!fresh) return `"${type}" is not a kind of layer.`;
    nextId = fresh.id;
    const becomesContent = fxLayerKind(type) === 'content';
    const notes: string[] = [];
    let replacement: Layer = { ...fresh, visible: layer.visible, blend: layer.blend };
    // The new layer has a new id: whatever pointed at the old one (effects scoped to it, a god rays reading it) follows or goes.
    let layers = fx.scene.layers;
    if (isContent(layer)) {
      const nested = layers.filter((l) => l.target === layer.id);
      if (becomesContent) layers = layers.map((l) => (l.target === layer.id ? { ...l, target: fresh.id } : l));
      else if (nested.length > 0) {
        layers = layers.filter((l) => l.target !== layer.id);
        notes.push(`${nested.map((l) => l.name).join(', ')} applied only to ${layer.name} and ${nested.length === 1 ? 'was' : 'were'} removed.`);
      }
    }
    // A post effect keeps what it applies to (the fresh layer has no target of its own); a kind that reads a layer cannot be scoped.
    if (isPost(layer) && layer.target && !becomesContent && !readsSource(type)) replacement = { ...replacement, target: layer.target };
    if (readsSource(type)) {
      const source = sourceFor(layers, layer.id);
      if (source === null) return ALL_SCOPED;
      if (source !== undefined) replacement = withSource(replacement, source);
    }
    const moved = isContent(layer) ? repointReaders(layers, layer.id, becomesContent ? fresh.id : null) : { layers, notes: [] as string[] };
    if (typeof moved === 'string') return moved;
    notes.push(...moved.notes);
    return { fx: withLayers(fx, moved.layers.map((l) => (l === layer ? replacement : l))), notes };
  });
  return edit.ok ? { ...edit, layerId: nextId } : edit;
}

/**
 * Make one effect apply to one content layer only (`targetId`) or to the whole scene (`null`).
 * Refused, with the reason and nothing stored: the layer is not an effect, it reads a layer of its
 * own (god rays), the target is not a content layer, some effect reads the target, or a fifth
 * layer would have effects of its own.
 */
export function setFxLayerTarget(current: unknown, layerId: string, targetId: string | null): FxEdit {
  return change(current, (fx) => {
    const layer = fx.scene.layers.find((l) => l.id === layerId);
    if (!layer) return NO_LAYER;
    if (!isPost(layer)) return `${layer.name} draws something itself. Only an effect can apply to one layer.`;
    if (readsSource(layer.type)) return `${layer.name} reads a layer of its own, so it cannot also apply to one layer. Pick the layer it reads under "Reads from".`;
    if (targetId === null) return withLayers(fx, fx.scene.layers.map((l) => (l === layer ? withoutTarget(l) : l)));
    const target = fx.scene.layers.find((l) => l.id === targetId);
    if (!target) return 'The layer this effect should apply to is no longer in the scene.';
    if (!isContent(target)) return `${target.name} is an effect, not a layer that draws. An effect can apply to a layer that draws.`;
    if (fx.scene.layers.some((l) => sourceOf(l) === targetId)) return `An effect reads ${target.name} from the main picture, so ${target.name} cannot have effects of its own.`;
    const others = targetedIds(fx.scene.layers.filter((l) => l !== layer));
    if (!others.has(targetId) && others.size >= FX_LIMITS.targetedLayers) {
      return `At most ${FX_LIMITS.targetedLayers} layers of a scene can have effects of their own. Move another layer's effects to the whole scene first.`;
    }
    return withLayers(fx, fx.scene.layers.map((l) => (l === layer ? { ...l, target: targetId } : l)));
  });
}

/** What a layer without pointer settings does: nothing (the engine's own default). */
const NO_POINTER: InteractivitySpec = { trackMouse: 0, momentum: 0, spring: 0, axes: 'both' };

/**
 * Change a layer's pointer settings (track mouse, momentum, spring, axes), or remove them with
 * `null`. Only for kinds that read them. The values go through the strict reader like every
 * other change, which holds each amount to 0..1; anything else (not a number, an unknown axis)
 * is refused here with a reason rather than left to be dropped.
 */
export function setFxLayerInteractivity(current: unknown, layerId: string, patch: Partial<InteractivitySpec> | null): FxEdit {
  return change(current, (fx) => {
    const layer = fx.scene.layers.find((l) => l.id === layerId);
    if (!layer) return NO_LAYER;
    if (!layerReadsPointer(layer.type)) return `${layer.name} does not react to the pointer.`;
    if (patch === null) return withLayers(fx, fx.scene.layers.map((l) => (l === layer ? ((): Layer => { const { interactivity: _i, ...rest } = l; void _i; return rest as Layer; })() : l)));
    for (const key of ['trackMouse', 'momentum', 'spring'] as const) {
      const v = patch[key];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) return `The pointer setting "${key}" must be a number.`;
    }
    if (patch.axes !== undefined && patch.axes !== 'x' && patch.axes !== 'y' && patch.axes !== 'both') return 'The pointer axes can be x, y or both.';
    const next: InteractivitySpec = { ...NO_POINTER, ...layer.interactivity, ...patch };
    return withLayers(fx, fx.scene.layers.map((l) => (l === layer ? { ...l, interactivity: next } : l)));
  });
}

/** The scene as text, for "Copy scene JSON": exactly what is stored under `fx.scene`. */
export function fxSceneJson(current: unknown): string | null {
  const read = parseFxProp(current);
  return read.ok ? sceneToJSON(read.fx.scene) : null;
}

/**
 * Replace the scene by one given as an already parsed JSON value in the engine's own
 * format (what "Copy scene JSON" writes, and what lumitra-web's tuning panel exports).
 * A scene in Lumitra Studio's format is converted first by the caller (the Studio
 * bridge lives in `@/lib/fx/unified`, loaded only when it is needed).
 */
export function importFxScene(current: unknown, scene: unknown): FxEdit {
  const read = parseFxProp(current);
  const settings = read.ok ? { start: read.fx.start, calm: read.fx.calm } : { start: FX_DEFAULT_START, calm: FX_DEFAULT_CALM };
  const checked = parseFxProp({ version: 1, scene, ...settings });
  if (!checked.ok) return checked;
  return { ok: true, stored: storedFxProp(checked.fx), fx: checked.fx, notes: checked.notes };
}

/** What kind a layer is, for the panel: content layers draw, post passes change what is drawn. */
export function fxLayerKind(type: string): 'content' | 'post' | null {
  return getLayerSchema(type)?.kind ?? null;
}
