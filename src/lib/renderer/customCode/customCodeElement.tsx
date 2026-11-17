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
import {
  CUSTOM_CODE_ATTR,
  customCodeTrace,
  parseCustomCode,
  withoutCustomCodeProp,
  type CustomCodeParse,
} from '@/lib/customCode/customCode';

export type CustomCodeSurface = 'editor' | 'preview' | 'standalone' | 'published';

/**
 * What the editor surfaces tell a block about where it is drawn. The default is
 * the safe one: a tile, without a link. The editor gives the link to the page's
 * standalone preview; only the standalone preview route says `standalone`.
 */
export interface CustomCodeSurfaceInfo {
  standalone: boolean;
  previewHref: string | null;
}

export const CustomCodeSurfaceContext = React.createContext<CustomCodeSurfaceInfo>({ standalone: false, previewHref: null });

/** What the tile says. */
export const CUSTOM_CODE_TILE_TEXT = 'Custom code, not run here';
export const CUSTOM_CODE_PREVIEW_LINK_TEXT = 'Open the preview to run it';

const BADGE: Record<'block' | 'proposal' | 'invalid', string> = {
  block: 'Custom code',
  proposal: 'Proposed, not active',
  invalid: 'Not a valid block, shows its fallback',
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
}

function tileOf(parsed: CustomCodeParse, previewHref: string | null): React.ReactElement {
  const kind = parsed.ok ? parsed.value.kind : 'invalid';
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
 * drawn; a paragraph or a list item of a table) draws the tile in a `div`.
 */
const TILE_HOST_TAGS: ReadonlySet<string> = new Set(['div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'figure', 'blockquote', 'li', 'dd']);

/** A block on a surface. Never a frame: the frame belongs to the published island (slice C3). */
export function createCustomCodeElement(surface: CustomCodeSurface, input: CustomCodeElementInput): React.ReactElement {
  const parsed = parseCustomCode(input.config);
  const tag = isVoidTag(input.tag) ? 'div' : input.tag;
  // A copy: the caller's object is never changed.
  const domProps: Record<string, unknown> = { ...withoutCustomCodeProp(input.domProps) };
  delete domProps.children;
  if (surface === 'editor' || surface === 'preview') {
    const style = { ...((domProps.style as React.CSSProperties | undefined) ?? {}), position: 'relative' as const };
    const label = parsed.ok ? `${CUSTOM_CODE_TILE_TEXT}: ${parsed.value.title}` : CUSTOM_CODE_TILE_TEXT;
    const host = TILE_HOST_TAGS.has(tag) ? tag : 'div';
    // A control's own attributes mean nothing on the div that replaces it.
    if (host !== tag) for (const name of ['href', 'target', 'rel', 'download', 'type', 'disabled', 'form', 'name', 'value']) delete domProps[name];
    // A group, so its label is allowed (ARIA 1.2 names no plain div).
    return React.createElement(host, { ...domProps, key: input.key, style, role: 'group', 'aria-label': label }, tileOf(parsed, input.previewHref ?? null));
  }
  const trace = parsed.ok && parsed.value.kind === 'block' ? { [CUSTOM_CODE_ATTR]: customCodeTrace(parsed.value.sha256) } : {};
  return React.createElement(tag, { ...domProps, key: input.key, ...trace }, input.children);
}

/**
 * A block on the editor's surfaces, as createComponentElement draws it: the canvas
 * is always the tile; the preview is the tile too, unless the standalone preview
 * route says otherwise through CustomCodeSurfaceContext.
 */
export function CustomCodeOnEditorSurface({ mode, ...input }: CustomCodeElementInput & { mode: 'editor' | 'preview' }): React.ReactElement {
  const info = React.useContext(CustomCodeSurfaceContext);
  const surface: CustomCodeSurface = mode === 'editor' ? 'editor' : info.standalone ? 'standalone' : 'preview';
  return createCustomCodeElement(surface, { ...input, previewHref: info.previewHref });
}
