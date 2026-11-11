/**
 * Which layers a scene draws right now, as a pure function of the scene.
 *
 * `LumitraScene` used to work this out inline, with one trap: a post pass that
 * reads a content layer (god rays read their "sun" through `sourceLayerId`)
 * held the WHOLE composer back until that layer was mounted. A pass whose
 * source is hidden, dropped by the performance step down or simply not in the
 * scene therefore switched off every other post pass too, for good. Here such a
 * pass is left out on its own; the composer waits only for sources that are
 * about to mount.
 *
 * RENDER-FREE: no React, no three.js.
 */

import { getLayerSchema } from "./registry";
import type { Layer } from "./types";

export interface PipelinePlan {
  /** Content layers to mount, back to front. */
  content: Layer[];
  /** Post passes to run, in composer order. */
  post: Layer[];
  /** False while a post pass waits for its source layer's object to mount. */
  postReady: boolean;
}

/** The id of the content layer a post pass reads, when it reads one. */
function sourceOf(layer: Layer): string | null {
  const source = layer.params.sourceLayerId;
  return source && source.type === "select" ? source.value : null;
}

/**
 * @param layers   the scene's layers, in stored order
 * @param perfLow  true once the frame rate step down happened: `heavy` layers are dropped
 * @param isMounted whether a content layer's object is registered yet
 */
export function planPipeline(layers: readonly Layer[], perfLow: boolean, isMounted: (layerId: string) => boolean): PipelinePlan {
  const live = layers.filter((layer) => {
    if (!layer.visible) return false;
    const schema = getLayerSchema(layer.type);
    return schema !== undefined && !(perfLow && schema.heavy);
  });
  const content = live.filter((layer) => getLayerSchema(layer.type)?.kind === "content");
  const contentIds = new Set(content.map((layer) => layer.id));
  const post = live.filter((layer) => {
    if (getLayerSchema(layer.type)?.kind !== "post") return false;
    const source = sourceOf(layer);
    return source === null || contentIds.has(source);
  });
  const postReady = post.every((layer) => {
    const source = sourceOf(layer);
    return source === null || isMounted(source);
  });
  return { content, post, postReady };
}
