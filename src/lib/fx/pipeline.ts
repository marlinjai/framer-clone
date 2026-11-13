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

/** One content layer with effects of its own (`Layer.target`), see ./targets. */
export interface PipelineGroup {
  /** The content layer the effects apply to (visible, drawn). */
  target: Layer;
  /** The three.js layer channel its object is drawn on: 1 to 4 (the main picture is channel 0). */
  channel: number;
  /** Its effects, in stored order. */
  effects: Layer[];
}

export interface PipelinePlan {
  /** Content layers to mount, back to front. */
  content: Layer[];
  /** Post passes to run, in composer order. */
  post: Layer[];
  /** False while a post pass waits for its source layer's object to mount. */
  postReady: boolean;
  /**
   * Content layers drawn on their own and run through their own effects. Empty
   * for a scene without `target`; then `content`, `post` and `postReady` are
   * exactly what they were before targets existed.
   */
  groups: PipelineGroup[];
}

/** The id of the content layer a post pass reads, when it reads one. */
function sourceOf(layer: Layer): string | null {
  const source = layer.params.sourceLayerId;
  return source && source.type === "select" ? source.value : null;
}

/** Groups of the drawn content layers that have at least one drawn effect, in content order. */
function planGroups(live: readonly Layer[], content: readonly Layer[]): PipelineGroup[] {
  const groups: PipelineGroup[] = [];
  for (const target of content) {
    const effects = live.filter((layer) => layer.target === target.id && getLayerSchema(layer.type)?.kind === "post");
    if (effects.length > 0) groups.push({ target, channel: groups.length + 1, effects });
  }
  return groups;
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
  const groups = planGroups(live, content);
  const scoped = new Set(live.filter((layer) => layer.target !== undefined && getLayerSchema(layer.type)?.kind === "post"));
  const post = live.filter((layer) => {
    if (getLayerSchema(layer.type)?.kind !== "post") return false;
    // A targeted effect never runs on the whole scene: a hidden or undrawn
    // target leaves it out, a drawn one moves it into its group.
    if (scoped.has(layer)) return false;
    const source = sourceOf(layer);
    return source === null || contentIds.has(source);
  });
  const postReady = post.every((layer) => {
    const source = sourceOf(layer);
    return source === null || isMounted(source);
  });
  return { content, post, postReady, groups };
}
