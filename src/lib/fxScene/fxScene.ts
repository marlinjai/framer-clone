// src/lib/fxScene/fxScene.ts
//
// The FX scene node (plan docs/plans/2026-11-08-lumitra-fx-in-sites.md): a box
// that draws a Lumitra FX scene (the WebGL effects engine in src/lib/fx: noise
// fields, gradients, god rays, bloom, grain) behind its children. Like the map
// embed it is an ordinary `div` with a marker and its settings as a prop:
//
//   { type: 'div', props: { 'data-fx': 'scene', fx: { version: 1, scene, start, calm }, style }, children }
//
// The box, its own CSS background and its children are what every renderer draws
// first and what a visitor keeps when the scene cannot be drawn (no JavaScript, no
// WebGL, reduced motion). `fx` never reaches the DOM.
//
// Nothing stored is trusted: `readFxScene` is the ONE way the app reads the prop.
// It goes through the engine's strict reader (src/lib/fx/format.ts), which
// rebuilds the scene field by field, and adds this app's own rule: an image layer
// may only show an image uploaded to the site (`/site-images/<sha256>.<ext>`,
// src/lib/site/siteImages.ts). A node whose `fx` is missing or refused is drawn as
// the plain box with its children.
//
// The word is "FX", never "Effects": that is the motion effects feature
// (`props.effects`, src/lib/effects).
//
// PURE: no React, no DOM, and no three.js (the engine's render-free entry). Shared
// by the save check, and later the island, the panel, the generator's validator
// and the agent's site operations. Code that needs only the marker's names (the
// renderers' prop gates, the bindings resolver) imports ./marker, which carries no
// engine code.

import { fxImageAddresses, parseFx, toStoredFx, type FxResult, type ParsedFx, type StoredFx } from '@/lib/fx/format';
import { isSiteImagePath } from '@/lib/site/siteImages';
import { FX_ATTR, FX_MARKER, FX_PROP, isFxScene } from './marker';

export { FX_ATTR, FX_MARKER, FX_PROP, isFxScene };

export type { FxResult, ParsedFx, StoredFx };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** This app's rule for an image layer's address: one of the site's own uploads, exactly. */
export function isAllowedFxImage(src: string): boolean {
  return isSiteImagePath(src);
}

/** Read a value as a stored `fx` prop, under this app's rules. */
export function parseFxProp(value: unknown): FxResult {
  return parseFx(value, { isAllowedImageSrc: isAllowedFxImage });
}

/**
 * The scene of an FX scene box, or why it has none. A node that is not an FX
 * scene box is refused too, so one call answers "is there a scene to draw".
 */
export function readFxScene(props: unknown, type: unknown = 'div'): FxResult {
  if (!isFxScene(props, type)) return { ok: false, message: 'This element is not an FX scene.' };
  return parseFxProp((props as Record<string, unknown>)[FX_PROP]);
}

/** The value to store in `fx` for a parsed scene. */
export function storedFxProp(fx: ParsedFx): StoredFx {
  return toStoredFx(fx);
}

/**
 * Every uploaded image the FX scenes of a stored document name, as site image
 * paths. `document` is anything stored as JSON that holds nodes (a page snapshot,
 * a tree, a list of trees): it is walked whole, so the answer does not depend on
 * where in it the nodes sit. Only scenes that read cleanly count; a refused scene
 * is never drawn, so it names nothing.
 */
export function fxSiteImagePaths(document: unknown): string[] {
  const found = new Set<string>();
  const seen = new Set<object>();
  const stack: unknown[] = [document];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    const record = value as Record<string, unknown>;
    if (isRecord(record.props) && isFxScene(record.props, record.type)) {
      const result = parseFxProp(record.props[FX_PROP]);
      if (result.ok) for (const src of fxImageAddresses(result.fx.scene)) found.add(src);
    }
    for (const [key, child] of Object.entries(record)) {
      // The scene itself holds no nodes.
      if (key === FX_PROP && record[FX_ATTR] === FX_MARKER) continue;
      stack.push(child);
    }
  }
  return [...found];
}
