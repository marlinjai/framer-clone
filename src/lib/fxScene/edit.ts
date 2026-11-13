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
  FX_START_MODES,
  PRESETS,
  appendLayer,
  duplicateLayer,
  getLayerSchema,
  instantiateLayer,
  moveLayer,
  moveLayerTo,
  placeInGroup,
  removeLayer,
  sceneToJSON,
  toggleLayer,
  type BlendMode,
  type FxCalm,
  type FxStart,
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
function change(current: unknown, apply: (fx: ParsedFx) => ParsedFx | string): FxEdit {
  const read = parseFxProp(current);
  if (!read.ok) return read;
  const next = apply(read.fx);
  return typeof next === 'string' ? { ok: false, message: next } : finish(next, read.notes);
}

const withScene = (fx: ParsedFx, scene: SceneConfig): ParsedFx => ({ ...fx, scene });
const withLayers = (fx: ParsedFx, layers: Layer[]): ParsedFx => withScene(fx, { ...fx.scene, layers });
const NO_LAYER = 'That layer is no longer in the scene.';

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
    const next = { ...layer, params: { ...layer.params, [key]: { ...schema, value } as ParamSchema } };
    return withLayers(fx, fx.scene.layers.map((l) => (l === layer ? next : l)));
  });
}

/** Add a layer of a built-in type at the front (the end of the list), with its default settings. */
export function addFxLayer(current: unknown, type: string): FxEdit & { layerId?: string } {
  let layerId: string | undefined;
  const edit = change(current, (fx) => {
    if (fx.scene.layers.length >= FX_LIMITS.layers) return `A scene can hold at most ${FX_LIMITS.layers} layers. Remove one first.`;
    const layer = instantiateLayer(type, fx.scene.layers);
    if (!layer) return `"${type}" is not a kind of layer.`;
    layerId = layer.id;
    return withLayers(fx, appendLayer(fx.scene.layers, layer));
  });
  return edit.ok ? { ...edit, layerId } : edit;
}

export function removeFxLayer(current: unknown, layerId: string): FxEdit {
  return change(current, (fx) => (fx.scene.layers.some((l) => l.id === layerId) ? withLayers(fx, removeLayer(fx.scene.layers, layerId)) : NO_LAYER));
}

/** Move a layer one place: `-1` toward the back (drawn earlier), `1` toward the front. At either end nothing changes. */
export function moveFxLayer(current: unknown, layerId: string, delta: -1 | 1): FxEdit {
  return change(current, (fx) => (fx.scene.layers.some((l) => l.id === layerId) ? withLayers(fx, moveLayer(fx.scene.layers, layerId, delta)) : NO_LAYER));
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
    const replacement: Layer = { ...fresh, visible: layer.visible, blend: layer.blend };
    return withLayers(fx, fx.scene.layers.map((l) => (l === layer ? replacement : l)));
  });
  return edit.ok ? { ...edit, layerId: nextId } : edit;
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
