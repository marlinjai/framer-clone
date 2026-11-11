/**
 * Layer registry, in two parts.
 *
 * Schemas (type, kind, label, `heavy`, default parameters) are render-free and
 * are seeded from ./schemas when this module loads, so the scene loader, the
 * format checks and the layer list operations work without React or three.js.
 *
 * Components are added by `registerNode`, which ./builtins calls for every
 * built-in layer; only the renderer (`LumitraScene`) needs them. This module
 * holds component references by type only, so importing it loads no renderer.
 *
 * U1 note: this FX-local registry is the *render* authority. It carries the
 * React `Component` that scene-core's `NodeDefinitionRegistry` deliberately
 * omits, and keys by FX's un-prefixed local type (`godRays`, not `fx.godRays`).
 * The two coexist by design: scene-core is the render-free schema/legality
 * authority; FX-local is the render authority. They are NOT merged.
 * `registerNode` is the primitive; `registerLayer` is an alias.
 */

import { LAYER_SCHEMAS } from "./schemas";
import type { LayerDefinition, LayerSchemaDefinition, ParamsSchema } from "./types";

type AnyLayerSchema = LayerSchemaDefinition<ParamsSchema>;
type AnyLayerDefinition = LayerDefinition<ParamsSchema>;

const schemas = new Map<string, AnyLayerSchema>(LAYER_SCHEMAS.map((schema) => [schema.type, schema]));
const definitions = new Map<string, AnyLayerDefinition>();

/** Register a layer: its schema and the component that draws it. */
export function registerNode<P extends ParamsSchema>(def: LayerDefinition<P>): void {
  // Heterogeneous registry: each definition is internally typed in its own P,
  // stored under the wider ParamsSchema bound. Cast is safe because callers
  // only look up by `type` and consume via ParamValues<P>.
  const wide = def as unknown as AnyLayerDefinition;
  schemas.set(def.type, {
    type: wide.type,
    kind: wide.kind,
    label: wide.label,
    heavy: wide.heavy,
    defaultParams: wide.defaultParams,
  });
  definitions.set(def.type, wide);
}

/** Alias for {@link registerNode}. */
export const registerLayer = registerNode;

/** A layer's schema, known without the renderer. */
export function getLayerSchema(type: string): AnyLayerSchema | undefined {
  return schemas.get(type);
}

/** Every layer schema, in registration order. */
export function listLayerSchemas(): AnyLayerSchema[] {
  return Array.from(schemas.values());
}

/** A layer with its component; undefined until ./builtins (or a caller) registered one. */
export function getLayerDefinition(type: string): AnyLayerDefinition | undefined {
  return definitions.get(type);
}

export function listLayerDefinitions(): AnyLayerDefinition[] {
  return Array.from(definitions.values());
}
