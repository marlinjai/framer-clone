// src/lib/behaviour/surfaceDom.ts
//
// How the editor's two renderers take what the behaviour pass wrote for a node
// (src/lib/behaviour/surfaceBehaviour.ts): ComponentRenderer on the canvas and
// HeadlessComponentRenderer in the preview. One context per surface, set where the
// surface's tree is drawn, and one merge, so the two cannot drift apart.
//
// The pass's output is the published page's own, so this adds nothing a visitor would
// not get: state attributes, bindings at the shown values, and the marks the runtime
// finds. The canvas leaves a text binding out. Its element is what a person types into,
// and committing the bound text would write state over the stored words.
'use client';

import React from 'react';
import type { NodeDom } from './surfaceBehaviour';

/** What the pass wrote, by node id, for the surface being drawn. Absent on a surface with no behaviour. */
export const SurfaceDomContext = React.createContext<ReadonlyMap<string, NodeDom> | null>(null);

/** The attributes and style with what the pass wrote for this node. Unchanged when it wrote nothing. */
export function withSurfaceDom(
  attributes: Record<string, unknown>,
  style: Record<string, unknown>,
  dom: NodeDom | undefined,
  surface: 'canvas' | 'preview',
): { attributes: Record<string, unknown>; style: Record<string, unknown> } {
  if (!dom) return { attributes, style };
  const merged: Record<string, unknown> = { ...attributes };
  for (const name of dom.removed) delete merged[name];
  for (const [name, value] of Object.entries(dom.attributes)) {
    if (surface === 'canvas' && (name === 'children' || name === 'suppressHydrationWarning')) continue;
    merged[name] = value;
  }
  return { attributes: merged, style: Object.keys(dom.style).length > 0 ? { ...style, ...dom.style } : style };
}

/**
 * One map for the surface, the same object while what it holds is the same. Every
 * node reads the context, so a new map on each edit would draw the whole page again,
 * and most edits change nothing the pass wrote.
 */
export function useStableSurfaceDom(maps: readonly ReadonlyMap<string, NodeDom>[]): ReadonlyMap<string, NodeDom> | null {
  const held = React.useRef<{ signature: string; map: ReadonlyMap<string, NodeDom> | null }>({ signature: '', map: null });
  const entries = maps.flatMap((map) => [...map]);
  const signature = entries.length > 0 ? JSON.stringify(entries) : '';
  if (held.current.signature !== signature) held.current = { signature, map: entries.length > 0 ? new Map(entries) : null };
  return held.current.map;
}
