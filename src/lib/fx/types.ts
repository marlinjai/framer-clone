/**
 * Core types for the Lumitra FX engine.
 *
 * A Scene is a `SceneConfig`: an ordered stack of `Layer`s plus global render
 * knobs. Each Layer has a typed `params` schema; that same schema feeds (a)
 * the runtime uniforms/props and (b) the live editor panel and (c) JSON
 * serialization. One source of truth, per spec section 3.
 */

import type { ComponentType } from "react";
import type { Object3D } from "three";

export type BlendMode = "normal" | "screen" | "multiply" | "add" | "overlay";

export type ParamSchema =
  | { type: "number"; value: number; min: number; max: number; step?: number; label?: string }
  | { type: "color"; value: string; label?: string }
  | { type: "select"; value: string; options: string[]; label?: string }
  | { type: "bool"; value: boolean; label?: string }
  | { type: "string"; value: string; label?: string }
  | {
      type: "vec2";
      value: [number, number];
      min?: [number, number];
      max?: [number, number];
      step?: number;
      label?: string;
    };

export type ParamValueOf<S extends ParamSchema> = S extends { type: "number" }
  ? number
  : S extends { type: "color" }
    ? string
    : S extends { type: "select" }
      ? string
      : S extends { type: "bool" }
        ? boolean
        : S extends { type: "string" }
          ? string
          : S extends { type: "vec2" }
            ? [number, number]
            : never;

export type ParamsSchema = Record<string, ParamSchema>;

export type ParamValues<P extends ParamsSchema> = {
  [K in keyof P]: ParamValueOf<P[K]>;
};

/** Per-param animation spec: value(t) = base + drift * noise(t * speed + phase). */
export interface AnimateSpec {
  speed: number;
  drift: number;
  phase: number;
}

/** Mouse/scroll interactivity knobs (Phase 2 fleshes this out). */
export interface InteractivitySpec {
  trackMouse: number;
  momentum: number;
  spring: number;
  axes: "x" | "y" | "both";
}

export interface Layer<P extends ParamsSchema = ParamsSchema> {
  id: string;
  type: string;
  name: string;
  visible: boolean;
  blend: BlendMode;
  params: P;
  animate?: Record<string, AnimateSpec>;
  interactivity?: InteractivitySpec;
}

export interface SceneConfig {
  /**
   * Serialization schema version. Bumped on a breaking change to the JSON
   * shape so older files can be migrated (or rejected) at import time. Phase 1
   * = `1`; the field is optional in TS so existing in-code configs keep
   * compiling without it, but serializers always write it.
   */
  version?: number;
  id: string;
  size: { mode: "fill" | "fixed"; width?: number; height?: number };
  background: string;
  fps: 30 | 60 | 120;
  dpr: [number, number];
  layers: Layer[];
}

/** Current canonical JSON schema version emitted by `serializeScene`. */
export const SCENE_SCHEMA_VERSION = 1;

export type LayerKind = "content" | "post";

/**
 * Per-scene runtime context handed to every layer component.
 *
 * - `registerObject` / `getObject`: lets content layers publish their root
 *   Object3D under their layer id so post layers (e.g. GodRays) can bind to
 *   them by `sourceLayerId`.
 * - `reduce`: prefers-reduced-motion is on; layers must render a static frame.
 */
export interface LayerContext {
  registerObject: (layerId: string, obj: Object3D | null) => void;
  getObject: (layerId: string) => Object3D | null;
  reduce: boolean;
}

export interface LayerComponentProps<P extends ParamsSchema = ParamsSchema> {
  layer: Layer<P>;
  values: ParamValues<P>;
  ctx: LayerContext;
}

export interface LayerDefinition<P extends ParamsSchema = ParamsSchema> {
  type: string;
  kind: LayerKind;
  /**
   * Human label used by the editor's "add layer" picker. Falls back to `type`
   * if omitted. The runtime never reads this; it's pure presentation.
   */
  label?: string;
  /**
   * Marks a layer whose per-frame cost is high (multi-tap blurs, mipmap
   * pyramids, big sample loops). The Phase 3 PerformanceMonitor downshift
   * drops these from the live pipeline when fps stays below the floor, so
   * the rest of the scene keeps running smoothly.
   */
  heavy?: boolean;
  defaultParams: P;
  Component: ComponentType<LayerComponentProps<P>>;
  /** Optional custom JSON encode; defaults to passing `params` through. */
  serialize?: (params: P) => unknown;
  /** Optional custom JSON decode; defaults to merging over `defaultParams`. */
  deserialize?: (raw: unknown) => P;
}
