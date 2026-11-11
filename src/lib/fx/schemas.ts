/**
 * The built-in layers as data: type, kind, label, the `heavy` mark and the
 * default parameters with their ranges. No React and no three.js, so the
 * scene loader, the format checks, the layer list operations and a properties
 * panel can read a layer's schema without loading the renderer.
 *
 * Each layer's component file (`layers/*.tsx`, `effects/*.tsx`) spreads its
 * schema from here and adds the component, so the two cannot drift.
 */

import type { LayerSchemaDefinition, ParamsSchema } from "./types";

// --- layers/text.tsx

/** The font names a text layer may pick; the component maps each to a CSS stack. */
export const FONT_OPTIONS = [
  "Helvetica Neue",
  "Arial",
  "Inter",
  "system-ui",
  "Georgia",
  "Times New Roman",
  "Courier New",
];

const TEXT_DEFAULT_PARAMS: ParamsSchema = {
  eyebrowText: { type: "string", value: "Introducing", label: "eyebrow" },
  headlineText: { type: "string", value: "Lumitra", label: "headline" },
  taglineText: {
    type: "string",
    value: "we bring your project to life",
    label: "tagline",
  },
  eyebrowFont: { type: "select", value: "Georgia", options: FONT_OPTIONS, label: "eyebrow font" },
  bodyFont: { type: "select", value: "Helvetica Neue", options: FONT_OPTIONS, label: "body font" },
  headlineWeight: {
    type: "select",
    value: "500",
    options: ["300", "400", "500", "600", "700", "800"],
    label: "headline weight",
  },
  eyebrowSize: { type: "number", value: 88, min: 30, max: 200, step: 2, label: "eyebrow size" },
  headlineSize: { type: "number", value: 300, min: 80, max: 480, step: 10, label: "headline size" },
  taglineSize: { type: "number", value: 60, min: 24, max: 160, step: 2, label: "tagline size" },
  color: { type: "color", value: "#dfe6ff" },
  width: { type: "number", value: 5, min: 2, max: 9, step: 0.1 },
  height: { type: "number", value: 2.5, min: 1, max: 5, step: 0.1 },
  reveal: { type: "number", value: 2, min: 0, max: 5, step: 0.1 },
  parallax: { type: "number", value: 0.16, min: 0, max: 0.6, step: 0.01 },
};

export const textSchema: LayerSchemaDefinition = {
  type: "text",
  kind: "content",
  label: "Text Lockup",
  defaultParams: TEXT_DEFAULT_PARAMS,
};

// --- layers/noiseFill.tsx

const NOISE_DEFAULT_PARAMS: ParamsSchema = {
  color: { type: "color", value: "#b89cff" },
  scale: { type: "number", value: 2.4, min: 0.5, max: 6, step: 0.1 },
  speed: { type: "number", value: 1, min: 0, max: 4, step: 0.1 },
  intensity: { type: "number", value: 0.22, min: 0, max: 1, step: 0.02 },
};

export const noiseFillSchema: LayerSchemaDefinition = {
  type: "noiseFill",
  kind: "content",
  label: "Noise Field",
  defaultParams: NOISE_DEFAULT_PARAMS,
};

// --- layers/image.tsx

const IMAGE_DEFAULT_PARAMS: ParamsSchema = {
  // The address of the texture. In lumitra-web this was a select over that
  // app's own demo files; here it is a string, empty by default, and which
  // addresses are accepted is the host's rule (see `parseFxScene` in
  // ./format: Lumitra Sites allows only a site's own uploaded images).
  src: { type: "string", value: "" },
  fit: { type: "select", value: "cover", options: ["cover", "contain"] },
  opacity: { type: "number", value: 0.85, min: 0, max: 1, step: 0.01 },
  displace: { type: "number", value: 0, min: 0, max: 0.2, step: 0.005 },
  scale: { type: "number", value: 1, min: 0.25, max: 2, step: 0.05 },
};

export const imageSchema: LayerSchemaDefinition = {
  type: "image",
  kind: "content",
  label: "Image",
  defaultParams: IMAGE_DEFAULT_PARAMS,
};

// --- layers/shape.tsx

const SHAPE_DEFAULT_PARAMS: ParamsSchema = {
  shape: { type: "select", value: "circle", options: ["circle", "roundedRect", "blob"] },
  position: { type: "vec2", value: [0, 0], min: [-1.6, -1], max: [1.6, 1], step: 0.01 },
  size: { type: "number", value: 0.6, min: 0.05, max: 2, step: 0.01 },
  aspect: { type: "number", value: 1, min: 0.2, max: 3, step: 0.01 },
  radius: { type: "number", value: 0.15, min: 0, max: 1, step: 0.01 },
  softness: { type: "number", value: 0.05, min: 0, max: 1, step: 0.005 },
  color: { type: "color", value: "#9fb6ff" },
  opacity: { type: "number", value: 0.7, min: 0, max: 1, step: 0.01 },
  wobble: { type: "number", value: 0.15, min: 0, max: 1, step: 0.01 },
};

export const shapeSchema: LayerSchemaDefinition = {
  type: "shape",
  kind: "content",
  label: "Shape (SDF)",
  defaultParams: SHAPE_DEFAULT_PARAMS,
};

// --- layers/gradient.tsx

const GRADIENT_DEFAULT_PARAMS: ParamsSchema = {
  colorA: { type: "color", value: "#7c5cff" },
  colorB: { type: "color", value: "#ff7eb6" },
  colorC: { type: "color", value: "#3ad6ff" },
  colorD: { type: "color", value: "#0a0a14" },
  speed: { type: "number", value: 0.6, min: 0, max: 4, step: 0.05 },
  scale: { type: "number", value: 1, min: 0.2, max: 2.5, step: 0.05 },
  falloff: { type: "number", value: 2.2, min: 0.5, max: 6, step: 0.1 },
  opacity: { type: "number", value: 1, min: 0, max: 1, step: 0.01 },
};

export const gradientSchema: LayerSchemaDefinition = {
  type: "gradient",
  kind: "content",
  label: "Gradient",
  defaultParams: GRADIENT_DEFAULT_PARAMS,
};

// --- effects/godRays.tsx

const GOD_RAYS_DEFAULT_PARAMS: ParamsSchema = {
  sourceLayerId: { type: "select", value: "text-lockup", options: ["text-lockup"] },
  density: { type: "number", value: 0.92, min: 0.8, max: 1, step: 0.005 },
  decay: { type: "number", value: 0.9, min: 0.8, max: 0.99, step: 0.005 },
  weight: { type: "number", value: 0.3, min: 0, max: 1, step: 0.01 },
  exposure: { type: "number", value: 0.18, min: 0, max: 0.6, step: 0.01 },
  samples: { type: "number", value: 60, min: 20, max: 120, step: 5 },
  clampMax: { type: "number", value: 0.9, min: 0.5, max: 1, step: 0.01 },
};

export const godRaysSchema: LayerSchemaDefinition = {
  type: "godRays",
  kind: "post",
  label: "God Rays",
  // Per-pixel radial sample loop; heaviest pass in the v1 set after Bloom.
  heavy: true,
  defaultParams: GOD_RAYS_DEFAULT_PARAMS,
};

// --- effects/bloom.tsx

const BLOOM_DEFAULT_PARAMS: ParamsSchema = {
  intensity: { type: "number", value: 0.7, min: 0, max: 3, step: 0.05 },
  threshold: { type: "number", value: 0.5, min: 0, max: 1, step: 0.01 },
  radius: { type: "number", value: 0.62, min: 0, max: 1, step: 0.02 },
};

export const bloomSchema: LayerSchemaDefinition = {
  type: "bloom",
  kind: "post",
  label: "Bloom",
  // Mipmap blur pyramid + multi-pass composite. The PerformanceMonitor
  // downshift drops this first on low-end devices.
  heavy: true,
  defaultParams: BLOOM_DEFAULT_PARAMS,
};

// --- effects/bokeh.tsx

const BOKEH_DEFAULT_PARAMS: ParamsSchema = {
  radius: { type: "number", value: 0.02, min: 0, max: 0.08, step: 0.001 },
  mixRadius: { type: "number", value: 0.35, min: 0, max: 1, step: 0.01 },
  easing: { type: "number", value: 0.15, min: 0, max: 0.6, step: 0.005 },
  focusPos: {
    type: "vec2",
    value: [0, 0],
    min: [-1, -1],
    max: [1, 1],
    step: 0.01,
  },
  invert: { type: "bool", value: false },
  reveal: { type: "number", value: 0, min: 0, max: 5, step: 0.05 },
};

export const bokehSchema: LayerSchemaDefinition = {
  type: "bokeh",
  kind: "post",
  label: "Bokeh / DoF",
  // 16-tap disc sample per pixel; significant on mobile, dropped on low-fps.
  heavy: true,
  defaultParams: BOKEH_DEFAULT_PARAMS,
};

// --- effects/chromaticAberration.tsx

const CHROMATIC_DEFAULT_PARAMS: ParamsSchema = {
  offset: {
    type: "vec2",
    value: [0.0007, 0.0004],
    min: [0, 0],
    max: [0.006, 0.006],
    step: 0.0001,
  },
};

export const chromaticAberrationSchema: LayerSchemaDefinition = {
  type: "chromaticAberration",
  kind: "post",
  label: "Chromatic Aberration",
  defaultParams: CHROMATIC_DEFAULT_PARAMS,
};

// --- effects/rgbShift.tsx

const RGB_SHIFT_DEFAULT_PARAMS: ParamsSchema = {
  amount: { type: "number", value: 0.003, min: 0, max: 0.05, step: 0.0001 },
  angle: { type: "number", value: 0, min: 0, max: Math.PI * 2, step: 0.01 },
};

export const rgbShiftSchema: LayerSchemaDefinition = {
  type: "rgbShift",
  kind: "post",
  label: "RGB Shift",
  defaultParams: RGB_SHIFT_DEFAULT_PARAMS,
};

// --- effects/distortion.tsx

const DISTORTION_DEFAULT_PARAMS: ParamsSchema = {
  type: { type: "select", value: "noise", options: ["noise", "ripple", "texture"] },
  strength: { type: "number", value: 0.01, min: 0, max: 0.2, step: 0.001 },
  scale: { type: "number", value: 3, min: 0.1, max: 20, step: 0.1 },
  // The top of the range was 4 in lumitra-web. Measured in a browser with a
  // black and white scene (test/behaviour/fx.spec.ts, "flash safety"), 4 gives
  // exactly three flashes a second in parts of the picture, the most WCAG
  // 2.3.1 allows; 3 keeps a margin under that limit.
  speed: { type: "number", value: 0.5, min: 0, max: 3, step: 0.05 },
  mouseInfluence: { type: "number", value: 0, min: 0, max: 1, step: 0.01 },
};

export const distortionSchema: LayerSchemaDefinition = {
  type: "distortion",
  kind: "post",
  label: "Distortion",
  defaultParams: DISTORTION_DEFAULT_PARAMS,
};

// --- effects/pixelate.tsx

const PIXELATE_DEFAULT_PARAMS: ParamsSchema = {
  granularity: { type: "number", value: 6, min: 1, max: 60, step: 1 },
};

export const pixelateSchema: LayerSchemaDefinition = {
  type: "pixelate",
  kind: "post",
  defaultParams: PIXELATE_DEFAULT_PARAMS,
};

// --- effects/halftone.tsx

const HALFTONE_DEFAULT_PARAMS: ParamsSchema = {
  angle: { type: "number", value: 1.57, min: 0, max: Math.PI * 2, step: 0.01 },
  scale: { type: "number", value: 1, min: 0.2, max: 5, step: 0.05 },
};

export const halftoneSchema: LayerSchemaDefinition = {
  type: "halftone",
  kind: "post",
  defaultParams: HALFTONE_DEFAULT_PARAMS,
};

// --- effects/vignette.tsx

const VIGNETTE_DEFAULT_PARAMS: ParamsSchema = {
  offset: { type: "number", value: 0.5, min: 0, max: 1, step: 0.01 },
  darkness: { type: "number", value: 0.5, min: 0, max: 1, step: 0.01 },
};

export const vignetteSchema: LayerSchemaDefinition = {
  type: "vignette",
  kind: "post",
  label: "Vignette",
  defaultParams: VIGNETTE_DEFAULT_PARAMS,
};

// --- effects/grain.tsx

const GRAIN_DEFAULT_PARAMS: ParamsSchema = {
  opacity: { type: "number", value: 0.25, min: 0, max: 1, step: 0.01 },
  premultiply: { type: "bool", value: false },
};

export const grainSchema: LayerSchemaDefinition = {
  type: "grain",
  kind: "post",
  label: "Grain",
  defaultParams: GRAIN_DEFAULT_PARAMS,
};

/** Every built-in layer schema, content layers first (the order of the add picker). */
export const LAYER_SCHEMAS: readonly LayerSchemaDefinition[] = [
  textSchema,
  noiseFillSchema,
  imageSchema,
  shapeSchema,
  gradientSchema,
  godRaysSchema,
  bloomSchema,
  bokehSchema,
  chromaticAberrationSchema,
  rgbShiftSchema,
  distortionSchema,
  pixelateSchema,
  halftoneSchema,
  vignetteSchema,
  grainSchema,
];
