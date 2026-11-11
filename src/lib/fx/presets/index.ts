/**
 * Preset gallery (Phase 3, spec section 5 "Later: presets gallery").
 *
 * A handful of named, serialized SceneConfigs the editor can drop onto the
 * canvas with one click. Each preset is a plain JSON file (the same format
 * Export writes) so the gallery doubles as a self-documenting set of
 * examples a future site can copy and tweak.
 *
 * Three opening presets, each highlighting a different headline effect:
 *
 *   - godrays-hero       the v7 hero (rays + bloom + chromatic + vignette)
 *   - noise-gradient     calm mesh gradient + noise field + grain
 *   - bokeh-focuspull    the Phase 3 depth showcase (animated radius -> 0)
 *
 * Adding a preset = drop a JSON file alongside this index and append an
 * entry. The runtime deserializes lazily (only the active preset is
 * rehydrated), so importing all presets up front is essentially free.
 */

import { deserializeScene } from "../serialize";
import type { SceneConfig } from "../types";

import godraysHero from "./preset-godrays-hero.json";
import noiseGradient from "./preset-noise-gradient.json";
import bokehFocuspull from "./preset-bokeh-focuspull.json";

export interface PresetMeta {
  /** Stable identifier the editor stores in localStorage / URL. */
  id: string;
  /** Display label in the preset picker. */
  label: string;
  /** One-line description shown under the picker. */
  blurb: string;
  /** Materialize the preset's SceneConfig. */
  load: () => SceneConfig;
}

export const PRESETS: PresetMeta[] = [
  {
    id: "godrays-hero",
    label: "God Rays Hero",
    blurb: "v7 lockup with volumetric rays, bloom, chromatic, vignette.",
    load: () => deserializeScene(godraysHero),
  },
  {
    id: "noise-gradient",
    label: "Noise Gradient",
    blurb: "Calm mesh gradient under a layered noise field; soft grain top.",
    load: () => deserializeScene(noiseGradient),
  },
  {
    id: "bokeh-focuspull",
    label: "Bokeh Focus-Pull",
    blurb: "Phase 3 depth showcase: animated radius high -> 0 on the lockup.",
    load: () => deserializeScene(bokehFocuspull),
  },
];

export function findPreset(id: string): PresetMeta | undefined {
  return PRESETS.find((p) => p.id === id);
}
