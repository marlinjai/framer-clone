// src/lib/renderer/server/imageLoading.tsx
//
// Image loading for published pages (plan docs/plans/2026-10-23-published-site-essentials.md,
// decision 7): every image waits until it is needed, except the hero's.
//
//   - The HERO image is the first large `img` in the page's first section (the
//     root's first child). It gets `fetchPriority="high"` and is never lazy, so
//     the largest paint of the first screen starts at once. "Large" leaves out
//     logos and icons: an image whose own width or height is set below
//     SMALL_IMAGE_PX is skipped.
//   - When the first section has no such img but a photo background (the AI
//     generator's heroes usually are one, see src/lib/images/imageStyle.ts),
//     that photo is preloaded with high priority instead (HeroPreload, which
//     calls ReactDOM.preload during the server render, so the hint lands in
//     <head>). `fetchpriority` cannot apply to a CSS background.
//   - Every other img gets `loading="lazy"` and `decoding="async"`.
//   - A value the author set explicitly (`loading`, `decoding`,
//     `fetchPriority`) is kept.
//
// PURE over the hydrated ComponentNode tree (it returns a new tree), called by
// renderPublishedPage before the render walk.

import { preload } from 'react-dom';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { photoUrlOf } from '@/lib/images/imageStyle';

/** Below this many pixels on either side an image is a logo or an icon, not a hero. */
export const SMALL_IMAGE_PX = 160;

type Props = Record<string, unknown>;

function baseOf(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'base' in (value as Props)) {
    return (value as Props).base;
  }
  return value;
}

/** The pixel size a value states (`48`, `"48px"`), or null for anything else. */
function pixels(value: unknown): number | null {
  const v = baseOf(value);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/.exec(v);
    if (m) return Number(m[1]);
  }
  return null;
}

function isImg(node: ComponentNode): boolean {
  return node.type === 'img';
}

function isSmall(node: ComponentNode): boolean {
  const props = (node.props ?? {}) as Props;
  const style = (props.style ?? {}) as Props;
  const sizes = [props.width, props.height, style.width, style.height, style.maxWidth, style.maxHeight]
    .map(pixels)
    .filter((n): n is number => n !== null);
  return sizes.some((n) => n < SMALL_IMAGE_PX);
}

/** Depth-first, document order. */
function* walk(node: ComponentNode): Generator<ComponentNode> {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

function firstHeroImg(section: ComponentNode | undefined): ComponentNode | null {
  if (!section) return null;
  for (const node of walk(section)) if (isImg(node) && !isSmall(node)) return node;
  return null;
}

function firstPhotoBackground(section: ComponentNode | undefined): string | null {
  if (!section) return null;
  for (const node of walk(section)) {
    const style = ((node.props ?? {}) as Props).style as Props | undefined;
    const url = photoUrlOf(baseOf(style?.backgroundImage));
    if (url && /^(https?:)?\/\//.test(url)) return url;
    if (url && url.startsWith('/')) return url;
  }
  return null;
}

export interface ImageLoadingResult {
  root: ComponentNode;
  /** The hero's background photo to preload, when the hero has no img. */
  preloadUrl: string | null;
}

function withLoading(node: ComponentNode, hero: ComponentNode | null): ComponentNode {
  let next = node;
  if (isImg(node)) {
    const props = { ...((node.props ?? {}) as Props) };
    if (node === hero) {
      if (props.fetchPriority === undefined) props.fetchPriority = 'high';
      // Never lazy: an explicit lazy on the hero would delay the first paint.
      if (props.loading === 'lazy') delete props.loading;
    } else {
      if (props.loading === undefined) props.loading = 'lazy';
      if (props.decoding === undefined) props.decoding = 'async';
    }
    next = { ...node, props };
  }
  if (node.children && node.children.length > 0) {
    next = { ...next, children: node.children.map((c) => withLoading(c, hero)) };
  }
  return next;
}

/** Mark every img of a page for lazy or priority loading (see the file header). */
export function applyImageLoading(root: ComponentNode): ImageLoadingResult {
  const firstSection = root.children?.[0];
  const hero = firstHeroImg(firstSection);
  return {
    root: withLoading(root, hero),
    preloadUrl: hero ? null : firstPhotoBackground(firstSection),
  };
}

/** Emits a high-priority preload hint for the hero background photo (server render). */
export function HeroPreload({ url }: { url: string }) {
  preload(url, { as: 'image', fetchPriority: 'high' });
  return null;
}
