/**
 * The stored form of an FX scene, and the one place it is read.
 *
 * A host stores a scene as plain data (in Lumitra Sites: the `fx` prop of a box
 * marked `data-fx="scene"`):
 *
 *   { version: 1, scene: <what serializeScene writes>, start, calm }
 *
 * Nothing stored is trusted. `parseFx` and `parseFxScene` REBUILD the scene
 * field by field from the layer schemas (./schemas): a field they do not know
 * is not carried over, a value outside its schema is clamped or replaced by the
 * default, and each such change is reported as a note. Three things are refused
 * outright, with a message a person can act on, because repairing them silently
 * would change what the author meant: a version this code does not read, more
 * layers than a scene may hold, and an image layer whose address the host does
 * not allow.
 *
 * Why not the engine's own `deserializeScene`: it is the loader for scenes the
 * engine's authors wrote. It passes `background` through as a string (it is
 * written into CSS, where `url(...)` would fetch any address), does not clamp
 * numbers to their ranges, keeps ids and names as they come, and throws. On the
 * scenes it was written for (the lumitra.co hero, the presets) both give the
 * same scene, which the tests assert.
 *
 * RENDER-FREE: no React, no three.js. This file is the engine's second public
 * entry (`@/lib/fx/format`), for code that must read or edit a scene without
 * loading the renderer: a server, a properties panel, a validator.
 */

import { getLayerSchema } from "./registry";
import { serializeScene, type SerializedScene } from "./serialize";
import { MAX_TARGETED_LAYERS, settleTargets } from "./targets";
import {
  SCENE_SCHEMA_VERSION,
  type BlendMode,
  type InteractivitySpec,
  type Layer,
  type ParamSchema,
  type ParamsSchema,
  type SceneConfig,
} from "./types";

export { getLayerSchema, listLayerSchemas } from "./registry";
export { deserializeScene, sceneToJSON, serializeScene, type SerializedScene } from "./serialize";
export {
  appendLayer,
  duplicateLayer,
  instantiateLayer,
  listAddableTypes,
  moveLayer,
  moveLayerTo,
  placeInGroup,
  removeLayer,
  toggleLayer,
  withLayers,
} from "./layerOps";
export { PRESETS, findPreset, type PresetMeta } from "./presets";
export { SCENE_SCHEMA_VERSION } from "./types";
export type {
  BlendMode,
  InteractivitySpec,
  Layer,
  LayerKind,
  LayerSchemaDefinition,
  ParamSchema,
  ParamsSchema,
  SceneConfig,
} from "./types";

/** The version of the stored envelope (`fx.version`). */
export const FX_VERSION = 1;

/**
 * When the scene starts drawing: `settled` after the page's `load` event plus
 * 1.5 seconds (what lumitra.co does), `visible` when the box comes within one
 * viewport height, `immediate` as soon as the page runs.
 */
export const FX_START_MODES = ["settled", "visible", "immediate"] as const;
export type FxStart = (typeof FX_START_MODES)[number];
export const FX_DEFAULT_START: FxStart = "settled";

/**
 * What a visitor who asked for reduced motion gets: `background` (the box's
 * own CSS background, nothing drawn) or `frame` (one static frame).
 */
export const FX_CALM_MODES = ["background", "frame"] as const;
export type FxCalm = (typeof FX_CALM_MODES)[number];
export const FX_DEFAULT_CALM: FxCalm = "background";

export const FX_LIMITS = {
  /** Layers in one scene. The largest scene lumitra-web ever shipped has 9. */
  layers: 16,
  /** Characters of one text parameter (a text layer's headline, tagline). */
  text: 200,
  /** Characters of a layer's display name. */
  name: 80,
  /** Characters of a scene or layer id. */
  id: 64,
  /** Content layers that may have effects of their own (each costs render targets). */
  targetedLayers: MAX_TARGETED_LAYERS,
} as const;

/** The pixel ratio range a scene may ask for (the engine's own invariant). */
export const FX_DPR_RANGE: readonly [number, number] = [1, 1.75];

/** The stored envelope. `scene` holds values only, exactly what `serializeScene` writes. */
export interface StoredFx {
  version: typeof FX_VERSION;
  scene: SerializedScene;
  start: FxStart;
  calm: FxCalm;
}

export interface ParsedFx {
  scene: SceneConfig;
  start: FxStart;
  calm: FxCalm;
}

export interface FxParseOptions {
  /**
   * The host's rule for an image layer's address. Called with every non-empty
   * address; anything it does not accept refuses the scene. Without it NO
   * address is accepted, so a caller that forgets the rule fails closed.
   */
  isAllowedImageSrc?: (src: string) => boolean;
}

export type FxSceneResult =
  | { ok: true; scene: SceneConfig; notes: string[] }
  | { ok: false; message: string };

export type FxResult = { ok: true; fx: ParsedFx; notes: string[] } | { ok: false; message: string };

const DEFAULT_BACKGROUND = "#000000";
const DEFAULT_SCENE_ID = "scene";
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// rgb(), rgba(), hsl(), hsla() holding numbers, percent signs and separators
// only: no nested function, no address.
const FUNCTION_COLOR = /^(?:rgb|hsl)a?\(\s*[0-9.+-]+(?:deg|%)?(?:\s*[,/\s]\s*[0-9.+-]+%?){2,3}\s*\)$/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** True for a colour this format accepts: a hex colour or a numeric rgb()/hsl() form. */
export function isFxColor(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  return HEX_COLOR.test(value) || FUNCTION_COLOR.test(value);
}

function isBlend(v: unknown): v is BlendMode {
  return v === "normal" || v === "screen" || v === "multiply" || v === "add" || v === "overlay";
}

function isValidId(v: unknown): v is string {
  return typeof v === "string" && v.length <= FX_LIMITS.id && ID.test(v);
}

/** `base`, or `base-1`, `base-2`, ... until it is not in `used`. */
function uniqueId(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let i = 1; ; i++) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, FX_LIMITS.id - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** A short, quoted form of a stored value for a message (never the whole thing). */
function quote(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return `"${text.length > 40 ? `${text.slice(0, 40)}...` : text}"`;
}

interface ParamContext {
  layerLabel: string;
  layerType: string;
  key: string;
  notes: string[];
  options: FxParseOptions;
}

type ParamOutcome = { ok: true; schema: ParamSchema } | { ok: false; message: string };

/** One parameter: the stored value laid over its schema, inside the schema's bounds. */
function parseParam(schema: ParamSchema, raw: unknown, ctx: ParamContext): ParamOutcome {
  const where = `${ctx.layerLabel}, ${schema.label ?? ctx.key}`;
  const fallback = (): ParamOutcome => {
    ctx.notes.push(`${where}: ${quote(raw)} is not a valid value, so the default is used.`);
    return { ok: true, schema };
  };
  if (raw === undefined) return { ok: true, schema };

  switch (schema.type) {
    case "number": {
      if (!isFiniteNumber(raw)) return fallback();
      const value = clamp(raw, schema.min, schema.max);
      if (value !== raw) ctx.notes.push(`${where}: ${raw} is outside ${schema.min} to ${schema.max} and was set to ${value}.`);
      return { ok: true, schema: { ...schema, value } };
    }
    case "color":
      return isFxColor(raw) ? { ok: true, schema: { ...schema, value: raw } } : fallback();
    case "select":
      return typeof raw === "string" && schema.options.includes(raw) ? { ok: true, schema: { ...schema, value: raw } } : fallback();
    case "bool":
      return typeof raw === "boolean" ? { ok: true, schema: { ...schema, value: raw } } : fallback();
    case "string": {
      if (typeof raw !== "string") return fallback();
      if (isImageAddress(ctx.layerType, ctx.key)) {
        if (raw === "") return { ok: true, schema: { ...schema, value: "" } };
        if (ctx.options.isAllowedImageSrc?.(raw) !== true) {
          return {
            ok: false,
            message: `${ctx.layerLabel} uses an image address that is not allowed here (${quote(raw)}). An image layer can only show an image uploaded to this site.`,
          };
        }
        return { ok: true, schema: { ...schema, value: raw } };
      }
      if (raw.length > FX_LIMITS.text) {
        ctx.notes.push(`${where}: the text was longer than ${FX_LIMITS.text} characters and was cut.`);
        return { ok: true, schema: { ...schema, value: raw.slice(0, FX_LIMITS.text) } };
      }
      return { ok: true, schema: { ...schema, value: raw } };
    }
    case "vec2": {
      if (!Array.isArray(raw) || raw.length !== 2 || !isFiniteNumber(raw[0]) || !isFiniteNumber(raw[1])) return fallback();
      const value: [number, number] = [
        clamp(raw[0], schema.min?.[0] ?? -Infinity, schema.max?.[0] ?? Infinity),
        clamp(raw[1], schema.min?.[1] ?? -Infinity, schema.max?.[1] ?? Infinity),
      ];
      if (value[0] !== raw[0] || value[1] !== raw[1]) ctx.notes.push(`${where}: the value was outside its range and was moved inside it.`);
      return { ok: true, schema: { ...schema, value } };
    }
  }
}

/** The one parameter that names an address: an image layer's `src`. */
function isImageAddress(layerType: string, key: string): boolean {
  return layerType === "image" && key === "src";
}

/** The parameter through which a post pass names the content layer it reads. */
export const FX_SOURCE_LAYER_PARAM = "sourceLayerId";

function parseInteractivity(raw: unknown): InteractivitySpec | undefined {
  if (!isRecord(raw)) return undefined;
  const { trackMouse, momentum, spring, axes } = raw;
  if (!isFiniteNumber(trackMouse) || !isFiniteNumber(momentum) || !isFiniteNumber(spring)) return undefined;
  if (axes !== "x" && axes !== "y" && axes !== "both") return undefined;
  return { trackMouse: clamp(trackMouse, 0, 1), momentum: clamp(momentum, 0, 1), spring: clamp(spring, 0, 1), axes };
}

type LayerOutcome = { ok: true; layer: Layer | null } | { ok: false; message: string };

function parseLayer(raw: unknown, index: number, usedIds: Set<string>, notes: string[], options: FxParseOptions): LayerOutcome {
  const position = `Layer ${index + 1}`;
  if (!isRecord(raw) || typeof raw.type !== "string") {
    notes.push(`${position} is not a layer and was left out.`);
    return { ok: true, layer: null };
  }
  const def = getLayerSchema(raw.type);
  if (!def) {
    notes.push(`${position} has the unknown type ${quote(raw.type)} and was left out.`);
    return { ok: true, layer: null };
  }

  let id: string;
  if (isValidId(raw.id) && !usedIds.has(raw.id)) {
    id = raw.id;
  } else {
    id = uniqueId(isValidId(raw.id) ? raw.id : def.type, usedIds);
    notes.push(
      isValidId(raw.id)
        ? `${position} had the same id as an earlier layer (${quote(raw.id)}) and is now ${quote(id)}.`
        : `${position} had no usable id and is now ${quote(id)}.`,
    );
  }

  const storedName = typeof raw.name === "string" ? raw.name.trim().slice(0, FX_LIMITS.name) : "";
  const name = storedName || def.label || def.type;
  const layerLabel = `Layer "${name}"`;

  const rawParams = isRecord(raw.params) ? raw.params : {};
  const params: ParamsSchema = {};
  for (const [key, schema] of Object.entries(def.defaultParams)) {
    // Which layer a post pass reads is settled once every layer is known.
    if (key === FX_SOURCE_LAYER_PARAM && schema.type === "select") {
      const stored = rawParams[key];
      params[key] = typeof stored === "string" ? { ...schema, value: stored } : schema;
      continue;
    }
    const outcome = parseParam(schema, rawParams[key], { layerLabel, layerType: def.type, key, notes, options });
    if (!outcome.ok) return outcome;
    params[key] = outcome.schema;
  }

  const layer: Layer = {
    id,
    type: def.type,
    name,
    visible: typeof raw.visible === "boolean" ? raw.visible : true,
    blend: isBlend(raw.blend) ? raw.blend : "normal",
    params,
  };
  if (raw.blend !== undefined && !isBlend(raw.blend)) notes.push(`${layerLabel}: the blend mode ${quote(raw.blend)} is unknown, so "normal" is used.`);
  if (isRecord(raw.animate) && Object.keys(raw.animate).length > 0) {
    // The engine has the hook (resolveAnimatedNumber) but no layer calls it, so a
    // stored `animate` would do nothing. Left out, and said so, until it does.
    notes.push(`${layerLabel}: per-parameter animation is not supported and was left out.`);
  }
  if (typeof raw.target === "string") layer.target = raw.target;
  else if (raw.target !== undefined) notes.push(`${layerLabel}: the layer it applies to (${quote(raw.target)}) is not valid, so it applies to the whole scene.`);
  const interactivity = parseInteractivity(raw.interactivity);
  if (interactivity) layer.interactivity = interactivity;
  else if (raw.interactivity !== undefined) notes.push(`${layerLabel}: the pointer settings were not valid and were left out.`);

  usedIds.add(id);
  return { ok: true, layer };
}

/**
 * Settle every post pass's source: it must name a content layer of this scene.
 * The choices offered are the scene's content layers. A pass that names none of
 * them falls back to the first content layer, or to the schema's default when
 * the scene has no content layer (the renderer then skips that pass). Either
 * way the stored text itself is never kept unless it names a layer.
 */
function settleSources(layers: Layer[], notes: string[]): void {
  const contentIds = layers.filter((l) => getLayerSchema(l.type)?.kind === "content").map((l) => l.id);
  for (const layer of layers) {
    const schema = layer.params[FX_SOURCE_LAYER_PARAM];
    if (!schema || schema.type !== "select") continue;
    if (contentIds.length === 0) {
      const fallback = getLayerSchema(layer.type)?.defaultParams[FX_SOURCE_LAYER_PARAM];
      if (fallback) layer.params[FX_SOURCE_LAYER_PARAM] = fallback;
      continue;
    }
    if (contentIds.includes(schema.value)) {
      layer.params[FX_SOURCE_LAYER_PARAM] = { ...schema, options: contentIds };
      continue;
    }
    notes.push(`Layer "${layer.name}" read from a layer that is not in this scene (${quote(schema.value)}) and now reads from ${quote(contentIds[0])}.`);
    layer.params[FX_SOURCE_LAYER_PARAM] = { ...schema, value: contentIds[0], options: contentIds };
  }
}

/**
 * Read a stored scene (the object `serializeScene` writes). Rebuilds it from
 * the layer schemas; see the file header for what is repaired and what is
 * refused.
 */
export function parseFxScene(raw: unknown, options: FxParseOptions = {}): FxSceneResult {
  if (!isRecord(raw)) return { ok: false, message: "This FX scene is empty or not a scene." };
  if (raw.version != null && raw.version !== SCENE_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `This FX scene was saved in scene format ${quote(raw.version)}; this version of Lumitra reads format ${SCENE_SCHEMA_VERSION}.`,
    };
  }
  if (!Array.isArray(raw.layers)) return { ok: false, message: "This FX scene has no list of layers." };
  if (raw.layers.length > FX_LIMITS.layers) {
    return {
      ok: false,
      message: `This FX scene has ${raw.layers.length} layers; a scene can hold at most ${FX_LIMITS.layers}. Remove layers and try again.`,
    };
  }

  const notes: string[] = [];

  let id = DEFAULT_SCENE_ID;
  if (isValidId(raw.id)) id = raw.id;
  else if (raw.id !== undefined) notes.push(`The scene id ${quote(raw.id)} is not usable, so "${DEFAULT_SCENE_ID}" is used.`);

  let background = DEFAULT_BACKGROUND;
  if (isFxColor(raw.background)) background = raw.background;
  else if (raw.background !== undefined) notes.push(`The scene background ${quote(raw.background)} is not a colour, so black is used.`);

  const fps: SceneConfig["fps"] = raw.fps === 30 || raw.fps === 60 || raw.fps === 120 ? raw.fps : 60;
  if (raw.fps !== undefined && raw.fps !== fps) notes.push(`The frame rate ${quote(raw.fps)} is not 30, 60 or 120, so 60 is used.`);

  let dpr: [number, number] = [FX_DPR_RANGE[0], FX_DPR_RANGE[1]];
  if (Array.isArray(raw.dpr) && raw.dpr.length === 2 && isFiniteNumber(raw.dpr[0]) && isFiniteNumber(raw.dpr[1])) {
    const low = clamp(raw.dpr[0], FX_DPR_RANGE[0], FX_DPR_RANGE[1]);
    const high = clamp(raw.dpr[1], low, FX_DPR_RANGE[1]);
    dpr = [low, high];
    if (low !== raw.dpr[0] || high !== raw.dpr[1]) notes.push(`The pixel ratio range was outside ${FX_DPR_RANGE[0]} to ${FX_DPR_RANGE[1]} and was moved inside it.`);
  } else if (raw.dpr !== undefined) {
    notes.push(`The pixel ratio range was not valid, so ${FX_DPR_RANGE[0]} to ${FX_DPR_RANGE[1]} is used.`);
  }

  // The box the scene sits in gives it its size; a stored fixed size is not read.
  if (isRecord(raw.size) && raw.size.mode !== undefined && raw.size.mode !== "fill") {
    notes.push("The scene's fixed size is not used: the scene fills its box.");
  }

  const usedIds = new Set<string>();
  const layers: Layer[] = [];
  for (let i = 0; i < raw.layers.length; i++) {
    const outcome = parseLayer(raw.layers[i], i, usedIds, notes, options);
    if (!outcome.ok) return outcome;
    if (outcome.layer) layers.push(outcome.layer);
  }
  settleSources(layers, notes);
  notes.push(...settleTargets(layers));

  return {
    ok: true,
    scene: { version: SCENE_SCHEMA_VERSION, id, size: { mode: "fill" }, background, fps, dpr, layers },
    notes,
  };
}

/** Read the stored envelope: `{ version, scene, start, calm }`. */
export function parseFx(raw: unknown, options: FxParseOptions = {}): FxResult {
  if (!isRecord(raw)) return { ok: false, message: "This box has no FX scene." };
  if (raw.version !== FX_VERSION) {
    return {
      ok: false,
      message:
        raw.version === undefined
          ? "This FX scene has no format version."
          : `This FX scene was saved in format ${quote(raw.version)}; this version of Lumitra reads format ${FX_VERSION}.`,
    };
  }
  const scene = parseFxScene(raw.scene, options);
  if (!scene.ok) return scene;
  const notes = scene.notes;

  let start = FX_DEFAULT_START;
  if ((FX_START_MODES as readonly unknown[]).includes(raw.start)) start = raw.start as FxStart;
  else if (raw.start !== undefined) notes.push(`The start setting ${quote(raw.start)} is unknown, so "${FX_DEFAULT_START}" is used.`);

  let calm = FX_DEFAULT_CALM;
  if ((FX_CALM_MODES as readonly unknown[]).includes(raw.calm)) calm = raw.calm as FxCalm;
  else if (raw.calm !== undefined) notes.push(`The reduced motion setting ${quote(raw.calm)} is unknown, so "${FX_DEFAULT_CALM}" is used.`);

  return { ok: true, fx: { scene: scene.scene, start, calm }, notes };
}

/** The envelope to store for a parsed scene: values only. */
export function toStoredFx(fx: ParsedFx): StoredFx {
  return { version: FX_VERSION, scene: serializeScene(fx.scene), start: fx.start, calm: fx.calm };
}

/** Every non-empty image address a parsed scene names (for a host's "is it stored" check). */
export function fxImageAddresses(scene: SceneConfig): string[] {
  const out: string[] = [];
  for (const layer of scene.layers) {
    for (const [key, schema] of Object.entries(layer.params)) {
      if (isImageAddress(layer.type, key) && schema.type === "string" && schema.value !== "") out.push(schema.value);
    }
  }
  return out;
}
