/**
 * Register the built-in layers.
 *
 * v1 priority set (spec section 10 decision 4): GodRays, Bloom, Noise,
 * Chromatic, Vignette, Grain, Distortion, plus an RGB Shift companion to
 * ChromaticAberration. Phase 0 shipped the first five; Phase 1 added
 * Vignette, Grain, RGB Shift, and Distortion; Phase 2 added the Image,
 * Shape (SDF), and Gradient content layers; Phase 3 adds depth / finishing
 * effects: Bokeh / DoF (mix-radius mask), Pixelate, and Halftone / DotScreen.
 */

import { TextLayer } from "./layers/text";
import { NoiseFillLayer } from "./layers/noiseFill";
import { ImageLayer } from "./layers/image";
import { ShapeLayer } from "./layers/shape";
import { GradientLayer } from "./layers/gradient";
import { GodRaysLayer } from "./effects/godRays";
import { BloomLayer } from "./effects/bloom";
import { ChromaticAberrationLayer } from "./effects/chromaticAberration";
import { VignetteLayer } from "./effects/vignette";
import { GrainLayer } from "./effects/grain";
import { RGBShiftLayer } from "./effects/rgbShift";
import { DistortionLayer } from "./effects/distortion";
import { BokehLayer } from "./effects/bokeh";
import { PixelateLayer } from "./effects/pixelate";
import { HalftoneLayer } from "./effects/halftone";
import { registerNode } from "./registry";

// Content layers first, then post layers; registration order doesn't matter
// for the renderer (it walks SceneConfig.layers), but the "add layer" picker
// in the editor lists definitions in registration order, so grouping reads
// better there.
registerNode(TextLayer);
registerNode(NoiseFillLayer);
registerNode(ImageLayer);
registerNode(ShapeLayer);
registerNode(GradientLayer);
registerNode(GodRaysLayer);
registerNode(BloomLayer);
registerNode(BokehLayer);
registerNode(ChromaticAberrationLayer);
registerNode(RGBShiftLayer);
registerNode(DistortionLayer);
registerNode(PixelateLayer);
registerNode(HalftoneLayer);
registerNode(VignetteLayer);
registerNode(GrainLayer);
