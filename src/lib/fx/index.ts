/**
 * Public surface of the Lumitra FX engine.
 *
 * Copied from lumitra-web `packages/fx` (package `@lumitra-web/fx` 0.4.0) at
 * commit 8a77254ee5d66f2c8b7e4005933290c6c0796393; that repository keeps a
 * frozen copy and the engine's history. Plan:
 * docs/plans/2026-11-08-lumitra-fx-in-sites.md.
 *
 * The rest of the app imports the engine only through this file, and the
 * engine imports nothing from the rest of `src/` (rule FX1 and FX2 of
 * `pnpm lint:guards`), so it stays extractable.
 *
 * Importing this module registers the built-in layers (side effect in
 * `./builtins`). New scenes should depend on this entry point so the
 * registry is populated before any LumitraScene mounts.
 *
 * Per spec section 6 (Package and API) the package exposes three surfaces:
 *
 *   - <LumitraScene config /> for React consumers
 *   - createScene(config) for vanilla / non-React hosts (see ./createScene)
 *   - registerNode(definition) (primary; registerLayer is a kept alias) to
 *     extend the layer registry
 *
 * The core types (`SceneConfig`, `Layer`, `ParamSchema`, ...) are re-exported
 * so every consumer authors against the same shape the editor reads/writes.
 *
 * U1 adds `sceneConfigFromUnified`: the boundary adapter that reads a unified
 * `@marlinjai/studio-scene-core` scene blob and converts it down into a
 * `SceneConfig` the render path already understands.
 */

import "./builtins";

export { LumitraScene, type SceneFailure } from "./LumitraScene";
export { createScene, type LumitraSceneHandle } from "./createScene";
export {
  registerNode,
  registerLayer,
  getLayerDefinition,
  getLayerSchema,
  listLayerDefinitions,
  listLayerSchemas,
} from "./registry";
export { sceneConfigFromUnified } from "./unified";
export { resolveAnimatedNumber } from "./animation";
export {
  deserializeScene,
  sceneToJSON,
  serializeScene,
  type SerializedScene,
} from "./serialize";
export {
  appendLayer,
  instantiateLayer,
  listAddableTypes,
  moveLayer,
  removeLayer,
  toggleLayer,
  withLayers,
} from "./layerOps";
export { PRESETS, findPreset, type PresetMeta } from "./presets";
export {
  DEFAULT_INTERACTIVITY,
  readInteractivity,
  useInteractivity,
  useInteractivitySpec,
  type InteractivityTarget,
} from "./interactivity";
export { SCENE_SCHEMA_VERSION } from "./types";
export type {
  AnimateSpec,
  BlendMode,
  InteractivitySpec,
  Layer,
  LayerComponentProps,
  LayerContext,
  LayerDefinition,
  LayerKind,
  LayerSchemaDefinition,
  ParamSchema,
  ParamValueOf,
  ParamValues,
  ParamsSchema,
  SceneConfig,
} from "./types";
