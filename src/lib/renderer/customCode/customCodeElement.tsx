// src/lib/renderer/customCode/customCodeElement.tsx
//
// A sandboxed custom code block (src/lib/customCode/customCode.ts) as React
// elements, for every surface. Plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// "Per surface", and decisions D36 onward.
//
//   - 'editor' and 'preview' (the canvas in Select and Interact, and the preview
//     over the editor): a striped tile at the box's size saying the code does not
//     run here, with the title, a badge and a link to the standalone preview.
//     Both run on the signed-in editor's origin, so custom code never runs there,
//     and no frame is ever drawn, not even a sandboxed one.
//   - 'standalone' (the preview route /projects/<id>/preview) and 'published': the
//     box with its children, which are the fallback. A block of a valid hash
//     carries `data-fc-custom-code` with the first characters of its hash, so a
//     report can be traced. The frame itself is drawn by the island of slice C3;
//     until then, and for a proposal or an invalid value at any time, the
//     fallback is what shows.
//
// `customCode` never reaches the DOM on any surface: the element is drawn from
// the parsed value, and the prop is taken off the box's attributes here even
// where the render gate already dropped it.
//
// PURE apart from one context read (CustomCodeSurfaceContext, by the component
// the editor surfaces mount): no MST, no window, no 'use client', no server-only.

import React from 'react';
import { isVoidTag } from '@/lib/drag/voidTags';
import type { ForeignContent } from '@/lib/renderer/blockedNodes';
import {
  CUSTOM_CODE_ATTR,
  customCodeTrace,
  parseCustomCode,
  withoutCustomCodeProp,
  type CustomCodeParse,
} from '@/lib/customCode/customCode';

export type CustomCodeSurface = 'editor' | 'preview' | 'standalone' | 'published';

/** What the tile says. */
export const CUSTOM_CODE_TILE_TEXT = 'Custom code, not run here';
export const CUSTOM_CODE_PREVIEW_LINK_TEXT = 'Open the preview to run it';

const BADGE: Record<'block' | 'proposal' | 'draft' | 'invalid', string> = {
  block: 'Custom code',
  proposal: 'Proposed, not active',
  // `customCode: null`: a block added in the editor whose code was never saved (decision D102).
  draft: 'No code saved yet',
  invalid: 'Not a valid block, shows its fallback',
};

/** The label over a block's fallback while the editor shows it instead of the tile (decision D110). */
export const CUSTOM_CODE_FALLBACK_LABEL = 'Fallback, shown while the code cannot run';

const FALLBACK_LABEL_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 4,
  zIndex: 1,
  padding: '2px 8px',
  borderRadius: 999,
  background: '#111827',
  color: '#ffffff',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontSize: 11,
  fontWeight: 600,
  pointerEvents: 'none',
};

const TILE_STYLE: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  height: '100%',
  minHeight: 120,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: 16,
  overflow: 'hidden',
  background: 'repeating-linear-gradient(135deg, #f3f4f6 0, #f3f4f6 10px, #e5e7eb 10px, #e5e7eb 20px)',
  border: '1px dashed #6b7280',
  color: '#111827',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontSize: 13,
  lineHeight: 1.4,
  textAlign: 'center',
};

const BADGE_STYLE: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 999,
  background: '#111827',
  color: '#ffffff',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.2,
};

const LINK_STYLE: React.CSSProperties = {
  color: 'inherit',
  fontWeight: 600,
  textDecoration: 'underline',
};

export interface CustomCodeElementInput {
  /** The box's tag; a void tag draws a `div`, since a block holds children. */
  tag: string;
  /** The box's attributes, already through the render gate. */
  domProps: Record<string, unknown>;
  /** The stored `props.customCode`, as stored. */
  config: unknown;
  /** The node's children: the fallback. */
  children?: React.ReactNode;
  key?: React.Key;
  /** The editor surfaces' link to the standalone preview. */
  previewHref?: string | null;
  /**
   * What the block stands in for the HTML parser (blockedNodes.ts): inside `svg` an
   * HTML element is drawn as SVG and shows nothing, so the tile gets a foreignObject
   * there; inside `math` it is its label as text. On the published page and the
   * standalone preview it picks the box of a void tag (customCodeBoxTag).
   */
  foreign?: ForeignContent;
  /** The tag of the element the block stands in, when known: it decides the box of a void tag (customCodeBoxTag). */
  parentTag?: string | null;
  /**
   * Set when the block sits inside a link, a button, a label or a summary: the tile then
   * leaves its link out, since a link inside another control does not follow in every
   * browser and assistive technology meets nested interactive content. The editor surfaces only.
   */
  insideControl?: boolean;
  /**
   * The canvas only: draw the box with its children, the fallback, instead of the tile, so
   * the author can edit the fallback where it shows (decision D110). Editor state, never stored.
   */
  showFallback?: boolean;
}

function tileOf(parsed: CustomCodeParse, previewHref: string | null, config: unknown): React.ReactElement {
  const kind = parsed.ok ? parsed.value.kind : config === null ? 'draft' : 'invalid';
  return (
    <div data-fc-custom-code-tile="" style={TILE_STYLE}>
      <span data-fc-custom-code-badge="" style={BADGE_STYLE}>{BADGE[kind]}</span>
      <strong style={{ fontSize: 14 }}>{CUSTOM_CODE_TILE_TEXT}</strong>
      {parsed.ok ? <span data-fc-custom-code-title="">{parsed.value.title}</span> : null}
      {previewHref ? (
        <a data-fc-custom-code-preview="" href={previewHref} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
          {CUSTOM_CODE_PREVIEW_LINK_TEXT}
        </a>
      ) : null}
    </div>
  );
}

/**
 * The stored tags the tile may be drawn in: plain HTML containers that may hold a
 * `div`, a link and a badge. Any other tag (a link or a button, which would nest
 * the tile's link inside another control; an SVG element, inside which HTML is not
 * drawn; a paragraph, a list or a table row) draws the tile in a `div`. A block
 * standing inside `svg` or `math` is drawn as the `foreign` input says.
 */
const TILE_HOST_TAGS: ReadonlySet<string> = new Set(['div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'figure', 'blockquote', 'li', 'dd', 'td', 'th']);

/**
 * Parents that hold only their own kinds of children (a table's structure, a select,
 * an option group, an option): the browser's parser moves any box out of them or drops
 * it, so a void-tag block there is not drawn at all.
 */
const NO_BOX_PARENTS: ReadonlySet<string> = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup', 'select', 'optgroup', 'option', 'datalist', 'html', 'head', 'frameset']);

/**
 * The tag a block's box is drawn in on the published page and the standalone preview
 * (decision D96): its own, unless that is a void tag, which cannot hold the fallback.
 * Then a container the parser leaves where it stands: a `g` inside `svg`, an `mrow`
 * inside `math`, and a `span` anywhere in HTML, since a `span` never closes an open
 * paragraph however deep inside it the block sits (a `div` would, and the page would
 * no longer match what hydration draws); null (draw nothing) under a parent that holds
 * only its own kinds of children, out of which the parser would move any box.
 */
export function customCodeBoxTag(tag: string, foreign: ForeignContent = false, parentTag: string | null = null): string | null {
  if (!isVoidTag(tag)) return tag;
  if (foreign === 'svg') return 'g';
  if (foreign === 'math') return 'mrow';
  if (parentTag && NO_BOX_PARENTS.has(parentTag.toLowerCase())) return null;
  return 'span';
}

/** Attributes any element may carry; the rest belonged to the stored tag a box replaces. */
const GLOBAL_PROPS: ReadonlySet<string> = new Set(['id', 'className', 'style', 'title', 'lang', 'dir', 'role', 'hidden', 'tabIndex', 'translate', 'inert']);

/** A replaced tag's props without what only that tag understood (an `img`'s `fetchPriority`, an `input`'s `type`). */
export function globalPropsOnly(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).filter(([name]) => GLOBAL_PROPS.has(name) || name.startsWith('data-') || name.startsWith('aria-')));
}

/** A block on a surface. Never a frame: the frame belongs to the published island (slice C3). */
export function createCustomCodeElement(surface: CustomCodeSurface, input: CustomCodeElementInput): React.ReactElement | null {
  const parsed = parseCustomCode(input.config);
  const boxTag = customCodeBoxTag(input.tag, input.foreign, input.parentTag);
  const tag = boxTag ?? 'div';
  // A copy: the caller's object is never changed.
  const domProps: Record<string, unknown> = { ...withoutCustomCodeProp(input.domProps) };
  delete domProps.children;
  if (surface === 'editor' || surface === 'preview') {
    const style = { ...((domProps.style as React.CSSProperties | undefined) ?? {}), position: 'relative' as const };
    const label = parsed.ok ? `${CUSTOM_CODE_TILE_TEXT}: ${parsed.value.title}` : CUSTOM_CODE_TILE_TEXT;
    // React draws every child of `math` as MathML, so there the tile is its label as text.
    if (input.foreign === 'math') return React.createElement('mtext', { ...domProps, key: input.key, role: 'group', 'aria-label': label }, label);
    if (input.foreign === 'svg') {
      // The tile's HTML lives in a foreignObject, whose content React draws as HTML
      // again; the block's own attributes stay on the group outside it.
      const tile = React.createElement('div', { role: 'group', 'aria-label': label, style: { position: 'relative' } }, tileOf(parsed, input.insideControl ? null : input.previewHref ?? null, input.config));
      return React.createElement(
        'g',
        { ...domProps, key: input.key },
        React.createElement('foreignObject', { x: 0, y: 0, width: '100%', height: '100%', style: { overflow: 'visible' } }, tile),
      );
    }
    const host = TILE_HOST_TAGS.has(tag) ? tag : 'div';
    // A control's own attributes mean nothing on the div that replaces it.
    if (host !== tag) for (const name of ['href', 'target', 'rel', 'download', 'type', 'disabled', 'form', 'name', 'value']) delete domProps[name];
    if (surface === 'editor' && input.showFallback) {
      // The fallback in place of the tile, under a label that says so; still never a frame.
      return React.createElement(
        host,
        { ...domProps, key: input.key, style, 'data-fc-custom-code-fallback': '' },
        React.createElement('span', { key: 'fc-fallback-label', 'data-fc-custom-code-badge': '', style: FALLBACK_LABEL_STYLE }, CUSTOM_CODE_FALLBACK_LABEL),
        input.children,
      );
    }
    // A group, so its label is allowed (ARIA 1.2 names no plain div).
    return React.createElement(host, { ...domProps, key: input.key, style, role: 'group', 'aria-label': label }, tileOf(parsed, input.insideControl ? null : input.previewHref ?? null, input.config));
  }
  // A void tag under a parent that holds only its own kinds of children: no box at all.
  if (boxTag === null) return null;
  const trace = parsed.ok && parsed.value.kind === 'block' ? { [CUSTOM_CODE_ATTR]: customCodeTrace(parsed.value.sha256) } : {};
  const own = tag === input.tag ? domProps : globalPropsOnly(domProps);
  return React.createElement(tag, { ...own, key: input.key, ...trace }, input.children);
}
// ci-replay touch
