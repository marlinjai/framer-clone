/**
 * U1 boundary adapter: accept a unified scene blob (the
 * `@marlinjai/studio-scene-core` schema, a tree rooted at an `fx.stack` node)
 * and convert it DOWN into FX's internal `SceneConfig`, so the rendered pixels
 * are byte-identical to what FX renders today.
 *
 * This is a BRIDGE, not a rewrite. The FX render path (`LumitraScene`,
 * `serialize`) does not change; FX only gains the ability to read the unified
 * schema. The adapter lives at the boundary, so the scene graph FX renders is
 * bit-for-bit what it renders from a flat `SceneConfig`.
 *
 * Why scene-core's `runMigrations` (the U0 migration framework) and NOT its
 * `deserializeScene`:
 *   scene-core's `deserializeScene` rebuilds every node against its own
 *   render-free `NodeDefinitionRegistry` and, per that registry's legality
 *   rules, STRIPS `blend` from post nodes (`allowsBlend: false`). FX is the
 *   render authority and keeps post blend (v7's god rays render `screen`, bloom
 *   `add`). To preserve every authored value verbatim we run scene-core's pure
 *   `runMigrations` (a v1 flat blob -> v2 `{root}`, a no-op on a v2 blob or a
 *   live `Scene`), then funnel each `fx.stack` child through FX's OWN per-layer
 *   coercion (`deserializeLayer`). Both the flat loader and this adapter thus
 *   share one coercion, so the result is identical. The equivalence oracle
 *   (`src/__tests__/unified.equivalence.test.ts`) is the machine proof.
 *
 * Importing this module imports `@marlinjai/studio-scene-core`, which registers
 * the `fx.*` node definitions as a side effect (mirroring FX's builtins).
 */

import { runMigrations } from "@marlinjai/studio-scene-core";

import { deserializeLayer, type SerializedLayer } from "./serialize";
import type { AnimateSpec, Layer, SceneConfig } from "./types";
import { SCENE_SCHEMA_VERSION } from "./types";

/** True if `x` looks like a `[number, number]` tuple. */
function isVec2(x: unknown): x is [number, number] {
  return (
    Array.isArray(x) &&
    x.length === 2 &&
    typeof x[0] === "number" &&
    typeof x[1] === "number"
  );
}

/** Strip the unified `fx.` prefix to FX's un-prefixed local registry key. */
function toLocalType(type: string): string {
  return type.startsWith("fx.") ? type.slice("fx.".length) : type;
}

/**
 * Unwrap scene-core's `animate` map back to FX's flat `{ speed, drift, phase }`
 * shape. Oscillator bindings map straight across; `keyframes` bindings have no
 * FX runtime yet, so they are dropped with a warning (not a crash), mirroring
 * FX's drop-unknown resilience.
 */
function unwrapAnimate(
  raw: unknown,
  nodeId: string,
): Record<string, AnimateSpec> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, AnimateSpec> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const spec = value as Record<string, unknown>;
    if (
      spec.mode === "oscillator" &&
      typeof spec.speed === "number" &&
      typeof spec.drift === "number" &&
      typeof spec.phase === "number"
    ) {
      out[key] = { speed: spec.speed, drift: spec.drift, phase: spec.phase };
    } else if (spec.mode === "keyframes" && typeof console !== "undefined") {
      console.warn(
        `[lumitra-fx] dropping keyframes animation on "${nodeId}.${key}" (no FX runtime yet)`,
      );
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Map one migrated unified node down to FX's `SerializedLayer` shape (the input
 * FX's own loader consumes). Values are copied verbatim; `deserializeLayer`
 * then re-validates and coerces them over the registry defaults, exactly as the
 * flat loader does. Returns null for a structurally-broken node.
 */
function toSerializedLayer(node: Record<string, unknown>): SerializedLayer | null {
  if (typeof node.type !== "string" || typeof node.id !== "string") return null;
  const raw: Record<string, unknown> = {
    id: node.id,
    type: toLocalType(node.type),
    name: typeof node.name === "string" ? node.name : node.id,
    visible: node.visible,
    blend: node.blend,
    params:
      node.params && typeof node.params === "object" ? node.params : {},
  };
  const animate = unwrapAnimate(node.animate, node.id);
  if (animate) raw.animate = animate;
  if (node.interactivity != null) raw.interactivity = node.interactivity;
  // `deserializeLayer` re-validates every field (visible -> true, blend ->
  // isValidBlend or "normal", animate/interactivity sanitized), so a loose
  // boundary cast here is safe and mirrors FX's own `rawLayer as SerializedLayer`.
  return raw as unknown as SerializedLayer;
}

/**
 * Adapt a unified scene blob into FX's `SceneConfig`.
 *
 * Accepts a legacy v1 FX blob, a v2 `{ root }` blob, or a live `Scene`
 * (scene-core's migration framework normalizes all three). Walks the
 * `fx.stack` children back-to-front (their array order is the FX layer order),
 * maps each to an FX `Layer`, lifts the `canvas` knobs to the top level, and
 * stamps FX's `SCENE_SCHEMA_VERSION`.
 */
export function sceneConfigFromUnified(data: unknown): SceneConfig {
  const parsed = typeof data === "string" ? (JSON.parse(data) as unknown) : data;
  const migrated = runMigrations(parsed) as Record<string, unknown>;

  const root =
    migrated.root && typeof migrated.root === "object"
      ? (migrated.root as Record<string, unknown>)
      : undefined;
  const children =
    root && Array.isArray(root.children) ? (root.children as unknown[]) : [];

  const layers: Layer[] = [];
  for (const child of children) {
    if (!child || typeof child !== "object") continue;
    const serialized = toSerializedLayer(child as Record<string, unknown>);
    if (!serialized) continue;
    // Drops unknown layer types with a warning (FX resilience).
    const layer = deserializeLayer(serialized);
    if (layer) layers.push(layer);
  }

  const canvas =
    migrated.canvas && typeof migrated.canvas === "object"
      ? (migrated.canvas as Record<string, unknown>)
      : {};
  const dpr: [number, number] = isVec2(canvas.dpr)
    ? [canvas.dpr[0], canvas.dpr[1]]
    : [1, 1.75];
  const fps: SceneConfig["fps"] =
    canvas.fps === 30 || canvas.fps === 60 || canvas.fps === 120
      ? canvas.fps
      : 60;

  return {
    version: SCENE_SCHEMA_VERSION,
    id: typeof migrated.id === "string" ? migrated.id : "scene",
    size: (canvas.size as SceneConfig["size"]) ?? { mode: "fill" },
    background:
      typeof canvas.background === "string" ? canvas.background : "#000000",
    fps,
    dpr,
    layers,
  };
}
