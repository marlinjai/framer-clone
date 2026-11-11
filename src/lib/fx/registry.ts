/**
 * Node registry. Adding a new effect = one `registerNode` call.
 *
 * The registry is the engine's only extensibility seam: every later phase
 * (Phase 1 vignette/grain/distortion, Phase 2 image/shape/gradient, Phase 3
 * bokeh/pixelate/fluid) drops in here without touching `LumitraScene`.
 *
 * U1 note: this FX-local registry is the *render* authority. It carries the
 * React `Component` that scene-core's `NodeDefinitionRegistry` deliberately
 * omits, and keys by FX's un-prefixed local type (`godRays`, not `fx.godRays`).
 * The two coexist by design: scene-core is the render-free schema/legality
 * authority; FX-local is the render authority. They are NOT merged.
 * `registerNode` is the primitive; `registerLayer` is a backwards-compatible
 * alias so existing callers keep working.
 */

import type { LayerDefinition, ParamsSchema } from "./types";

type AnyLayerDefinition = LayerDefinition<ParamsSchema>;

const registry = new Map<string, AnyLayerDefinition>();

export function registerNode<P extends ParamsSchema>(def: LayerDefinition<P>): void {
  // Heterogeneous registry: each definition is internally typed in its own P,
  // stored under the wider ParamsSchema bound. Cast is safe because callers
  // only look up by `type` and consume via ParamValues<P>.
  registry.set(def.type, def as unknown as AnyLayerDefinition);
}

/** Backwards-compatible alias for {@link registerNode}. */
export const registerLayer = registerNode;

export function getLayerDefinition(type: string): AnyLayerDefinition | undefined {
  return registry.get(type);
}

export function listLayerDefinitions(): AnyLayerDefinition[] {
  return Array.from(registry.values());
}
