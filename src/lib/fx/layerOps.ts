/**
 * Layer-list operations the editor calls through.
 *
 * All four operations (add / remove / move / toggle) are pure functions over
 * `SceneConfig.layers`: they return a new layers array (or a new SceneConfig)
 * so React's referential equality picks up the change and so the autosave /
 * serialize path round-trips without surprises.
 *
 * `instantiateLayer` is the only function that needs to mint params; it deep-
 * clones each schema entry so subsequent slider edits don't bleed back into the
 * registry's default. The rest mutate at the `Layer` granularity only.
 */

import { getLayerSchema, listLayerSchemas } from "./registry";
import { SETTING_GROUPS } from "./schemas";
import type { Layer, ParamSchema, ParamsSchema, SceneConfig } from "./types";

/** Defensive deep-clone for a `ParamSchema` entry. Vec2 has a tuple value. */
function cloneParamSchema(s: ParamSchema): ParamSchema {
  if (s.type === "vec2") return { ...s, value: [s.value[0], s.value[1]] };
  return { ...s };
}

function cloneParams(params: ParamsSchema): ParamsSchema {
  const out: ParamsSchema = {};
  for (const [k, s] of Object.entries(params)) out[k] = cloneParamSchema(s);
  return out;
}

/** Generate a unique layer id by suffixing `-1`, `-2`, ... until clear. */
function uniqueLayerId(existing: Layer[], base: string): string {
  const used = new Set(existing.map((l) => l.id));
  if (!used.has(base)) return base;
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  // Fallback to a random suffix; extremely unlikely to trip but keeps the
  // function total.
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Mint a new Layer of the given registered `type`. The returned layer has the
 * registry's default params (deep-cloned), a unique id within `existing`,
 * `visible: true`, and a `normal` blend mode. Returns `null` if the type isn't
 * registered (caller can flash an error).
 */
export function instantiateLayer(type: string, existing: Layer[]): Layer | null {
  const def = getLayerSchema(type);
  if (!def) return null;
  const id = uniqueLayerId(existing, type);
  return {
    id,
    type,
    name: def.label ?? type,
    visible: true,
    blend: "normal",
    params: cloneParams(def.defaultParams),
  };
}

/**
 * Move a layer up or down by one slot. `direction: -1` moves toward the start
 * (rendered earlier, "further back"), `+1` toward the end.
 *
 * The renderer treats `SceneConfig.layers` as back -> front for content and
 * top -> bottom of composer pass order for post. So in the editor's list (which
 * mirrors back -> front), pressing "up" should move the layer toward the
 * later/foreground side; we expose `delta` so the panel keeps that semantic
 * inverted at the call site and this function stays pure.
 */
export function moveLayer(layers: Layer[], id: string, delta: number): Layer[] {
  const idx = layers.findIndex((l) => l.id === id);
  if (idx < 0) return layers;
  const target = idx + delta;
  if (target < 0 || target >= layers.length) return layers;
  const next = layers.slice();
  const [item] = next.splice(idx, 1);
  next.splice(target, 0, item);
  return next;
}

/**
 * The set of layers a layer moves among: content layers among content layers; effects that apply
 * to the whole scene among themselves; effects that apply to one content layer among the effects
 * of THAT layer (its siblings). Moving across sets would change nothing on screen. `null` for an
 * unregistered type.
 */
function groupOf(layer: Layer): string | null {
  const kind = getLayerSchema(layer.type)?.kind;
  if (!kind) return null;
  return kind === "content" ? "content" : `post:${layer.target ?? ""}`;
}

/**
 * The kinds whose component reads a layer's `interactivity` (track mouse, momentum, spring,
 * axes). The text layers and the distortion pass follow the pointer through their own
 * `parallax` / strength settings instead and ignore it. A test reads the layer sources and
 * fails when this list drifts from them.
 */
const POINTER_KINDS: ReadonlySet<string> = new Set(["noiseFill", "shape", "image", "gradient"]);

/**
 * What a layer of this kind does with its pointer BEFORE it has pointer settings of its own, as
 * the values a first edit starts from (so changing one value never silently changes the rest):
 *  - the noise field follows the pointer in a plain way of its own when it has none: a first-order
 *    lerp, `mouse += (pointer - mouse) * 0.04` (layers/noiseFill.tsx). The engine's pointer
 *    smoothing is a second-order spring, which at momentum 0 and spring 0.04 would overshoot and
 *    wobble. Momentum 1 (damping 0.15) with spring 0.225 puts its dominant eigenvalue at the lerp's
 *    0.96 with no overshoot: the same trajectory within 0.3% (pinned by a side-by-side test in
 *    src/lib/fx/__tests__/interactivityReduce.test.tsx);
 *  - shape, image and gradient stand still: track mouse 0, but with the soft spring and momentum
 *    the gold preset uses, so raising Track mouse alone makes the layer move (the engine's
 *    smoothing is driven by the spring: a spring of 0 never moves).
 */
export function pointerBaseOf(type: string): { trackMouse: number; momentum: number; spring: number; axes: "x" | "y" | "both" } {
  if (type === "noiseFill") return { trackMouse: 1, momentum: 1, spring: 0.225, axes: "both" };
  return { trackMouse: 0, momentum: 0.85, spring: 0.05, axes: "both" };
}

/** Whether a layer of this kind reads its pointer settings, so the panel may offer them. */
export function layerReadsPointer(type: string): boolean {
  return POINTER_KINDS.has(type);
}

/**
 * The presentation group of one setting in the properties panel ("Text", "Type", "Layout",
 * "Motion", ...), or `null` for the default group. A map by kind and key, never part of a
 * layer's schema or of the stored scene: grouping cannot change what is serialized or drawn.
 */
export function settingGroupOf(type: string, key: string): string | null {
  return SETTING_GROUPS[type]?.[key] ?? null;
}

export type MoveResult = { ok: true; layers: Layer[] } | { ok: false; reason: string };

/**
 * Move a layer to a place WITHIN ITS GROUP. `toIndex` counts inside the layer's own group, back
 * to front, so `0` is the back of its group and `size - 1` the front. A group is: the content
 * layers among themselves, the scene's effects among themselves, or the effects of one content
 * layer among themselves (see `groupOf`).
 *
 * A layer is never moved across groups: where an effect sits among the content layers in
 * the stored array changes nothing on screen (effects run after all content, in their own
 * order), and an effect of one layer has no place among the scene's effects, so allowing it
 * would only mislead. The slots of the other groups stay exactly where they are in the array.
 *
 * Refused, with a reason a person can act on, when the layer is unknown, when `toIndex`
 * is outside the group or is where the layer already is.
 */
export function moveLayerTo(layers: Layer[], id: string, toIndex: number): MoveResult {
  const layer = layers.find((l) => l.id === id);
  if (!layer) return { ok: false, reason: "That layer is no longer in the scene." };
  const group = groupOf(layer);
  const slots: number[] = [];
  layers.forEach((l, i) => {
    if (groupOf(l) === group) slots.push(i);
  });
  const members = slots.map((i) => layers[i]);
  const from = members.findIndex((l) => l.id === id);
  if (!Number.isInteger(toIndex)) return { ok: false, reason: `${layer.name} cannot be moved to that place.` };
  if (toIndex < 0 || toIndex >= members.length) {
    const edge = toIndex < 0 ? "back" : "front";
    return { ok: false, reason: `${layer.name} is already at the ${edge} of its group.` };
  }
  if (toIndex === from) return { ok: false, reason: `${layer.name} is already there.` };
  const [item] = members.splice(from, 1);
  members.splice(toIndex, 0, item);
  const next = layers.slice();
  slots.forEach((slot, i) => {
    next[slot] = members[i];
  });
  return { ok: true, layers: next };
}

/** The place of a layer inside its own group, back to front, with the size of the group. `null` when the layer is unknown. */
export function placeInGroup(layers: Layer[], id: string): { index: number; size: number } | null {
  const layer = layers.find((l) => l.id === id);
  if (!layer) return null;
  const group = groupOf(layer);
  const members = layers.filter((l) => groupOf(l) === group);
  return { index: members.findIndex((l) => l.id === id), size: members.length };
}

export type DuplicateResult = { ok: true; layers: Layer[]; layerId: string } | { ok: false; reason: string };

/**
 * Copy a layer: a new id, the name followed by " copy", every setting copied (never
 * shared with the original), placed directly in front of it in the stored order, so
 * in the same group. Refused when the scene already holds `max` layers.
 */
export function duplicateLayer(layers: Layer[], id: string, max: number, maxName = 80): DuplicateResult {
  const index = layers.findIndex((l) => l.id === id);
  if (index < 0) return { ok: false, reason: "That layer is no longer in the scene." };
  if (layers.length >= max) return { ok: false, reason: `A scene can hold at most ${max} layers. Remove one first.` };
  const source = layers[index];
  const layerId = uniqueLayerId(layers, source.type);
  const copy: Layer = {
    ...source,
    id: layerId,
    name: `${source.name} copy`.slice(0, maxName),
    params: cloneParams(source.params),
    ...(source.interactivity ? { interactivity: { ...source.interactivity } } : {}),
    ...(source.animate ? { animate: JSON.parse(JSON.stringify(source.animate)) } : {}),
  };
  const next = layers.slice();
  next.splice(index + 1, 0, copy);
  return { ok: true, layers: next, layerId };
}

export function removeLayer(layers: Layer[], id: string): Layer[] {
  return layers.filter((l) => l.id !== id);
}

export function toggleLayer(layers: Layer[], id: string): Layer[] {
  return layers.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l));
}

export function appendLayer(layers: Layer[], layer: Layer): Layer[] {
  return [...layers, layer];
}

/** All registered types, sorted by `kind` then `label`, for the add picker. */
export function listAddableTypes(): { type: string; label: string; kind: "content" | "post" }[] {
  return listLayerSchemas()
    .map((d) => ({ type: d.type, label: d.label ?? d.type, kind: d.kind }))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "content" ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
}

/** Replace `layers` on `config`, leaving everything else identical. */
export function withLayers(config: SceneConfig, layers: Layer[]): SceneConfig {
  return { ...config, layers };
}
