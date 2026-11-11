"use client";

/**
 * Vanilla / non-React mount surface (spec section 6).
 *
 *   createScene(config): { mount(el), destroy(), setParam(layerId, key, value), toJSON() }
 *
 * The function returns a handle that wraps an internal `<LumitraScene>` tree
 * rendered via `react-dom/client`. Callers from a plain HTML page or a non-React
 * framework can drop a scene into a DOM element without learning the React
 * surface; the frame rate monitor and the effect pipeline run exactly as in
 * the React API.
 *
 * Why a thin wrapper over `<LumitraScene>` rather than re-implementing the
 * engine: the React tree is the engine. Duplicating it for non-React hosts
 * would mean two parallel implementations to keep in sync; instead we ship one
 * engine and pay one `createRoot` call for callers that don't want the React
 * mental model.
 *
 * `setParam(layerId, key, value)` updates one parameter and re-renders the
 * scene against a new config object (the layer and its parameter are copied,
 * never mutated, so React sees the change). It is a coarse "edit + redraw"
 * hook for programmatic adjustments, parameter sweeps and integration tests.
 */

import { createElement } from "react";
import type { Root } from "react-dom/client";

import { LumitraScene } from "./LumitraScene";
import { sceneToJSON } from "./serialize";
import type { ParamSchema, SceneConfig } from "./types";

export interface LumitraSceneHandle {
  /** Mount the scene into a host element. Idempotent: re-mounting moves it. */
  mount: (el: HTMLElement) => void;
  /** Tear down the React root and release the WebGL context. */
  destroy: () => void;
  /**
   * Update a single param's `value` on the layer with id `layerId`.
   * Re-renders the React tree against the mutated config. No-ops if the
   * layer or param is unknown.
   */
  setParam: (layerId: string, key: string, value: ParamSchema["value"]) => void;
  /** Serialize the current (possibly mutated) scene to JSON. */
  toJSON: () => string;
}

/**
 * A config with one parameter's `value` replaced, metadata (min, max, options)
 * preserved; `null` when the layer or the parameter is unknown. Copies the
 * path it changes: `<LumitraScene>` is controlled and memoizes on identity, so
 * a mutation in place would not be drawn.
 */
export function withParam(
  config: SceneConfig,
  layerId: string,
  key: string,
  value: ParamSchema["value"],
): SceneConfig | null {
  const layer = config.layers.find((l) => l.id === layerId);
  const schema = layer?.params[key];
  if (!layer || !schema) return null;
  // Cast: each ParamSchema variant's `value` type is enforced at the API
  // boundary by the public typings; here the union is written through with
  // whatever `value` the caller passed.
  const nextSchema = { ...schema, value } as ParamSchema;
  const nextLayer = { ...layer, params: { ...layer.params, [key]: nextSchema } };
  return { ...config, layers: config.layers.map((l) => (l === layer ? nextLayer : l)) };
}

export function createScene(initialConfig: SceneConfig): LumitraSceneHandle {
  // Deep-clone the seed so the handle's scene never aliases the caller's
  // object (a scene is plain JSON, so a JSON round trip copies all of it).
  let config: SceneConfig = JSON.parse(JSON.stringify(initialConfig)) as SceneConfig;

  let root: Root | null = null;
  let host: HTMLElement | null = null;

  const render = () => {
    if (!root) return;
    root.render(createElement(LumitraScene, { config }));
  };

  return {
    mount(el: HTMLElement) {
      if (typeof window === "undefined") {
        throw new Error("[lumitra-fx] createScene().mount() must run in a browser");
      }
      if (root && host === el) {
        // Same host: just rerender against the current config.
        render();
        return;
      }
      // Different host (or first mount): tear down any prior root and adopt
      // the new element.
      if (root) {
        root.unmount();
        root = null;
      }
      host = el;
      // Lazy-import react-dom/client so SSR builds that import the package
      // for types don't pay the cost (or fail) at module-eval time.
      void import("react-dom/client").then((mod) => {
        if (host !== el) return; // host was swapped during the dynamic import
        root = mod.createRoot(el);
        render();
      });
    },
    destroy() {
      if (root) {
        root.unmount();
        root = null;
      }
      host = null;
    },
    setParam(layerId, key, value) {
      const next = withParam(config, layerId, key, value);
      if (!next) return;
      config = next;
      render();
    },
    toJSON() {
      return sceneToJSON(config);
    },
  };
}
