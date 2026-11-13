/**
 * Which effects apply to one content layer only (`Layer.target`), as a pure rule.
 *
 * Shared by the strict reader (./format) and the engine's own loader
 * (./serialize), so a preset and a stored scene settle targets the same way.
 *
 * RENDER-FREE: no React, no three.js.
 */

import { getLayerSchema } from "./registry";
import type { Layer } from "./types";

/** Distinct content layers that may have effects of their own (each costs render targets). */
export const MAX_TARGETED_LAYERS = 4;

/** The parameter through which a post pass names the content layer it reads (god rays). */
const SOURCE_PARAM = "sourceLayerId";

function sourceOf(layer: Layer): string | null {
  const source = layer.params[SOURCE_PARAM];
  return source && source.type === "select" ? source.value : null;
}

/**
 * Settle every `target`: it is kept only when it names a content layer of the
 * scene and the effect can use it, else it is dropped (the effect then applies
 * to the whole scene) and a note says why. Mutates `layers`.
 *
 * Refused targets: on a content layer; on an effect that already names its own
 * layer (god rays); naming a missing layer, an effect or the effect itself;
 * naming a layer some god rays read (its object must stay in the main picture);
 * and a fifth distinct targeted layer.
 */
export function settleTargets(layers: Layer[], limit: number = MAX_TARGETED_LAYERS): string[] {
  const notes: string[] = [];
  const byId = new Map<string, Layer>();
  for (const layer of layers) if (!byId.has(layer.id)) byId.set(layer.id, layer);
  const read = new Set<string>();
  for (const layer of layers) {
    const source = sourceOf(layer);
    if (source !== null) read.add(source);
  }
  const used = new Set<string>();
  for (const layer of layers) {
    if (layer.target === undefined) continue;
    const target = layer.target;
    const drop = (why: string) => {
      notes.push(`Layer "${layer.name}" applied to "${String(target).slice(0, 40)}", ${why}, so it applies to the whole scene.`);
      delete layer.target;
    };
    const owner = getLayerSchema(layer.type);
    const named = typeof target === "string" ? byId.get(target) : undefined;
    if (owner?.kind !== "post") drop("but only an effect can apply to a layer");
    else if (sourceOf(layer) !== null) drop("but this effect reads its own layer");
    else if (typeof target !== "string" || named === undefined) drop("which is not a layer of this scene");
    else if (named === layer) drop("which is the effect itself");
    else if (getLayerSchema(named.type)?.kind !== "content") drop("which is not a content layer");
    else if (read.has(named.id)) drop("which a god rays layer reads");
    else if (!used.has(named.id) && used.size >= limit) drop(`because a scene can scope effects to at most ${limit} layers`);
    else used.add(named.id);
  }
  return notes;
}
