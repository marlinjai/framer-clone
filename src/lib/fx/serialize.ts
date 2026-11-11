/**
 * Scene serialization (Phase 1).
 *
 * The contract every later phase and every reused site depends on. A scene
 * file is plain JSON, version-stamped, that round-trips through the engine
 * without changing the rendered result.
 *
 * Shape (`version: 1`):
 *
 * ```json
 * {
 *   "version": 1,
 *   "id": "lumitra-hero-v7",
 *   "size": { "mode": "fill" },
 *   "background": "#08080b",
 *   "fps": 60,
 *   "dpr": [1, 1.75],
 *   "layers": [
 *     {
 *       "id": "noise",
 *       "type": "noiseFill",
 *       "name": "Noise Field",
 *       "visible": true,
 *       "blend": "add",
 *       "params": { "color": "#b89cff", "scale": 2.4, "speed": 1, "intensity": 0.22 },
 *       "animate": { ... },        // optional
 *       "interactivity": { ... }   // optional
 *     }
 *   ]
 * }
 * ```
 *
 * Why values-only for `params`: each layer's `ParamSchema` carries presentation
 * metadata (min/max/step/options) that already lives on the registry default.
 * Storing only the values keeps scene files compact and human-editable, and
 * lets registry tuning (e.g. raising a slider's max) flow into existing files
 * without re-saving them. Round-trip is lossless w.r.t. the rendered scene,
 * which is the spec's definition (section 5: "the panel writes a reusable
 * scene file").
 */

import { getLayerSchema } from "./registry";
import type {
  AnimateSpec,
  BlendMode,
  InteractivitySpec,
  Layer,
  ParamSchema,
  ParamsSchema,
  SceneConfig,
} from "./types";
import { SCENE_SCHEMA_VERSION } from "./types";

/** A raw param value as it lives in JSON. */
type SerializedParamValue = number | string | boolean | [number, number];

export interface SerializedLayer {
  id: string;
  type: string;
  name: string;
  visible: boolean;
  blend: BlendMode;
  params: Record<string, SerializedParamValue>;
  animate?: Record<string, AnimateSpec>;
  interactivity?: InteractivitySpec;
}

export interface SerializedScene {
  version: number;
  id: string;
  size: SceneConfig["size"];
  background: string;
  fps: SceneConfig["fps"];
  dpr: [number, number];
  layers: SerializedLayer[];
}

/** True if `x` looks like a `[number, number]` tuple. */
function isVec2(x: unknown): x is [number, number] {
  return (
    Array.isArray(x) &&
    x.length === 2 &&
    typeof x[0] === "number" &&
    typeof x[1] === "number"
  );
}

/**
 * Reduce a live param to a JSON-plain primitive by its declared type. This is a
 * hard guarantee, not a convenience: if a non-plain value ever reaches a param
 * (e.g. an object leva handed back), emitting it verbatim would make the
 * autosave `JSON.stringify` throw "Converting circular structure to JSON" and
 * take the whole editor down. Coercing here means serialization can never throw
 * on a polluted config; a wrong-typed value degrades to a safe default instead.
 */
function serializeParamValue(s: ParamSchema): SerializedParamValue {
  switch (s.type) {
    case "number":
      return typeof s.value === "number" && Number.isFinite(s.value) ? s.value : 0;
    case "bool":
      return typeof s.value === "boolean" ? s.value : false;
    case "color":
      return typeof s.value === "string" ? s.value : "#000000";
    case "select":
    case "string":
      return typeof s.value === "string" ? s.value : "";
    case "vec2":
      return Array.isArray(s.value) &&
        typeof s.value[0] === "number" &&
        typeof s.value[1] === "number"
        ? [s.value[0], s.value[1]]
        : [0, 0];
  }
}

function serializeParams(params: ParamsSchema): Record<string, SerializedParamValue> {
  const out: Record<string, SerializedParamValue> = {};
  for (const [k, s] of Object.entries(params)) {
    out[k] = serializeParamValue(s);
  }
  return out;
}

function serializeLayer(layer: Layer): SerializedLayer {
  const params = serializeParams(layer.params);
  const out: SerializedLayer = {
    id: layer.id,
    type: layer.type,
    name: layer.name,
    visible: layer.visible,
    blend: layer.blend,
    params,
  };
  if (layer.animate) out.animate = layer.animate;
  if (layer.interactivity) out.interactivity = layer.interactivity;
  return out;
}

export function serializeScene(config: SceneConfig): SerializedScene {
  return {
    version: SCENE_SCHEMA_VERSION,
    id: config.id,
    size: config.size,
    background: config.background,
    fps: config.fps,
    dpr: [config.dpr[0], config.dpr[1]],
    layers: config.layers.map(serializeLayer),
  };
}

/** Pretty-printed JSON suitable for export/clipboard/file. */
export function sceneToJSON(config: SceneConfig): string {
  return JSON.stringify(serializeScene(config), null, 2);
}

/**
 * Apply a serialized param value over a default `ParamSchema`, preserving the
 * schema's bounds/options/step. Unknown or wrongly-typed values fall back to
 * the default to keep the engine resilient against hand-edited files.
 */
function applyParamValue(schema: ParamSchema, raw: unknown): ParamSchema {
  switch (schema.type) {
    case "number":
      return typeof raw === "number" ? { ...schema, value: raw } : schema;
    case "color":
      return typeof raw === "string" ? { ...schema, value: raw } : schema;
    case "select":
      return typeof raw === "string" && schema.options.includes(raw)
        ? { ...schema, value: raw }
        : schema;
    case "bool":
      return typeof raw === "boolean" ? { ...schema, value: raw } : schema;
    case "string":
      return typeof raw === "string" ? { ...schema, value: raw } : schema;
    case "vec2":
      return isVec2(raw) ? { ...schema, value: raw } : schema;
  }
}

function deserializeParams(
  defaults: ParamsSchema,
  raw: Record<string, unknown> | undefined,
): ParamsSchema {
  const out: ParamsSchema = {};
  for (const [k, schema] of Object.entries(defaults)) {
    const v = raw?.[k];
    out[k] = v === undefined ? schema : applyParamValue(schema, v);
  }
  return out;
}

function isValidBlend(v: unknown): v is BlendMode {
  return (
    v === "normal" ||
    v === "screen" ||
    v === "multiply" ||
    v === "add" ||
    v === "overlay"
  );
}

/** Keep only well-formed `{ speed, drift, phase }` entries; drop the rest. */
function sanitizeAnimate(raw: unknown): Record<string, AnimateSpec> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, AnimateSpec> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    if (
      typeof o.speed === "number" &&
      typeof o.drift === "number" &&
      typeof o.phase === "number"
    ) {
      out[k] = { speed: o.speed, drift: o.drift, phase: o.phase };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate the interactivity quad; return undefined if it isn't well-formed. */
function sanitizeInteractivity(raw: unknown): InteractivitySpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const axes = o.axes;
  if (
    typeof o.trackMouse !== "number" ||
    typeof o.momentum !== "number" ||
    typeof o.spring !== "number" ||
    (axes !== "x" && axes !== "y" && axes !== "both")
  ) {
    return undefined;
  }
  return {
    trackMouse: o.trackMouse,
    momentum: o.momentum,
    spring: o.spring,
    axes,
  };
}

/**
 * Build a runtime `Layer` from a serialized one, coercing values over the
 * registry defaults. Exported so the unified-schema boundary adapter
 * (`./unified`) reuses the exact same per-layer coercion FX uses for its flat
 * loader, guaranteeing the two paths produce identical layers.
 */
export function deserializeLayer(raw: SerializedLayer): Layer | null {
  const def = getLayerSchema(raw.type);
  if (!def) {
    // Unknown layer type: skip rather than throw, so a scene authored against
    // a newer registry still partially loads in an older client.
    if (typeof console !== "undefined") {
      console.warn(`[lumitra-fx] dropping unknown layer type "${raw.type}"`);
    }
    return null;
  }
  const params = deserializeParams(def.defaultParams, raw.params);
  const layer: Layer = {
    id: raw.id,
    type: raw.type,
    name: raw.name ?? raw.id,
    visible: raw.visible ?? true,
    blend: isValidBlend(raw.blend) ? raw.blend : "normal",
    params,
  };
  const animate = sanitizeAnimate(raw.animate);
  if (animate) layer.animate = animate;
  const interactivity = sanitizeInteractivity(raw.interactivity);
  if (interactivity) layer.interactivity = interactivity;
  return layer;
}

/**
 * Load a JSON scene (already-parsed object or a JSON string) into a runtime
 * `SceneConfig`. Throws if `data` isn't a plausible scene; per-layer issues
 * downgrade to a warning so a single bad layer can't bring the page down.
 */
export function deserializeScene(data: unknown): SceneConfig {
  const obj = typeof data === "string" ? (JSON.parse(data) as unknown) : data;
  if (!obj || typeof obj !== "object") {
    throw new Error("[lumitra-fx] scene JSON must be an object");
  }
  const o = obj as Partial<SerializedScene>;
  if (typeof o.id !== "string") {
    throw new Error("[lumitra-fx] scene JSON missing `id`");
  }
  if (!Array.isArray(o.layers)) {
    throw new Error("[lumitra-fx] scene JSON missing `layers`");
  }
  if (o.version != null && o.version !== SCENE_SCHEMA_VERSION) {
    // Phase 1 only knows version 1. Future phases add migrations here.
    throw new Error(
      `[lumitra-fx] unsupported scene schema version ${o.version}; expected ${SCENE_SCHEMA_VERSION}`,
    );
  }
  const layers: Layer[] = [];
  for (const rawLayer of o.layers) {
    const layer = deserializeLayer(rawLayer as SerializedLayer);
    if (layer) layers.push(layer);
  }
  const dpr: [number, number] = isVec2(o.dpr) ? o.dpr : [1, 1.75];
  return {
    version: SCENE_SCHEMA_VERSION,
    id: o.id,
    size: o.size ?? { mode: "fill" },
    background: typeof o.background === "string" ? o.background : "#000000",
    fps: (o.fps as SceneConfig["fps"]) ?? 60,
    dpr,
    layers,
  };
}
