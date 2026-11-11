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
