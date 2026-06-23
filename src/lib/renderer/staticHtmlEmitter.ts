// src/lib/renderer/staticHtmlEmitter.ts
//
// Per-page static HTML emitter (the wave-1 `static-html-spike` API, built inline
// here as the substrate for the wave-2 publish pipeline). It walks a single
// page's app component tree, resolves props for ONE chosen breakpoint, and
// returns an HTML string via `react-dom/server`'s `renderToStaticMarkup` on
// `HeadlessPageRenderer`. No React ships in the output; this is the standard
// React way to serialize an MST-backed tree to a string while reusing the exact
// same render path the editor preview uses (so published output matches preview).
//
// The MST tree is touched READ-ONLY: emission is idempotent and side-effect-free
// against the project state.
//
// CSS handling (decision, see PR): the spike emits inline `style` attributes.
// The publish spec wants "no inline styles, a style.css per page". Rather than a
// full responsive CSS flattener (deferred: `static-html-css-flattener`), this
// module ships the SMALLEST thing that satisfies that: `flattenInlineStyles`
// hoists each unique inline `style="..."` into a generated class in a single
// stylesheet string. It does NOT synthesize media queries or per-breakpoint
// rules; one breakpoint is emitted per call (the published DOM is single-tree).

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PageModelType } from '@/models/PageModel';
import HeadlessPageRenderer from './HeadlessPageRenderer';

export interface EmitStaticHtmlOptions {
  // 'fragment' returns just the rendered body markup; 'minimal-html5' wraps it in
  // a full `<!DOCTYPE html>` document. Defaults to 'fragment' (the spike shape);
  // the publish pipeline uses 'minimal-html5' via `wrapDocument`.
  documentShell?: 'fragment' | 'minimal-html5';
  // Document `<title>` (minimal-html5 only). Defaults to the page title.
  title?: string;
  // Raw strings injected verbatim into `<head>` (minimal-html5 only): stylesheet
  // links, the analytics tracker snippet, a runtime-island script tag, etc.
  headTags?: string[];
  // When true (default), inline styles are hoisted into a returned stylesheet.
  // The fragment/document then carries `class` refs instead of `style` attrs.
  flattenStyles?: boolean;
}

/**
 * Render a page's app tree to a raw HTML body string at one breakpoint.
 * `breakpointId` selects which responsive value wins; pass the page's primary
 * (largest) breakpoint for the canonical desktop emit. Inline styles intact.
 */
export function renderPageMarkup(page: PageModelType, breakpointId: string): string {
  return renderToStaticMarkup(
    React.createElement(HeadlessPageRenderer, { page, breakpointId }),
  );
}

/**
 * The default breakpoint for a page: the primary (largest min-width) viewport,
 * mirroring `HeadlessPageRenderer`'s `primaryId`. Falls back to '' when a page
 * has no viewport nodes (the renderer returns null in that case anyway).
 */
export function primaryBreakpointId(page: PageModelType): string {
  return page.sortedViewportNodes[0]?.breakpointId ?? '';
}

/**
 * Hoist every unique inline `style="..."` into a generated CSS class. Returns the
 * rewritten HTML (now carrying `class="sN"`) and the stylesheet text. Empty style
 * attributes are dropped outright. Pre-existing `class` attributes are merged so a
 * styled-AND-classed element keeps both. HTML entities in style values
 * (`&quot;`, `&amp;`, ...) are decoded back to their literal CSS form.
 */
export function flattenInlineStyles(html: string): { html: string; css: string } {
  const classByDecl = new Map<string, string>();
  const rules: string[] = [];
  let counter = 0;

  const replaced = html.replace(/ style="([^"]*)"/g, (_match, raw: string) => {
    const decl = decodeEntities(raw).trim();
    if (!decl) return '';
    let cls = classByDecl.get(decl);
    if (!cls) {
      cls = `s${counter++}`;
      classByDecl.set(decl, cls);
      rules.push(`.${cls}{${decl}}`);
    }
    return ` class="${cls}"`;
  });

  return { html: mergeDuplicateClassAttrs(replaced), css: rules.join('\n') };
}

/**
 * Wrap a body fragment in a minimal HTML5 document. `headTags` are injected
 * verbatim (already-trusted server-built strings: stylesheet link, tracker
 * snippet, runtime island).
 */
export function wrapDocument(input: {
  bodyHtml: string;
  title?: string;
  headTags?: string[];
  lang?: string;
}): string {
  const head = [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(input.title ?? 'Untitled')}</title>`,
    ...(input.headTags ?? []),
  ].join('');
  return (
    `<!DOCTYPE html><html lang="${escapeAttr(input.lang ?? 'en')}">` +
    `<head>${head}</head><body>${input.bodyHtml}</body></html>`
  );
}

/**
 * Convenience single-call emit (the wave-1 spike API). Renders the page body,
 * optionally flattens inline styles (injecting an inline `<style>` tag in
 * document mode), and returns either the fragment or a full document. The
 * publish pipeline does NOT use this path (it needs the CSS as a separate file);
 * it composes `renderPageMarkup` + `flattenInlineStyles` + `wrapDocument`
 * directly. Kept for the spike's manual-smoke / single-page use.
 */
export function emitStaticHtmlForPage(
  page: PageModelType,
  breakpointId: string,
  options: EmitStaticHtmlOptions = {},
): string {
  const shell = options.documentShell ?? 'fragment';
  const flatten = options.flattenStyles ?? false;

  const raw = renderPageMarkup(page, breakpointId);
  const { html, css } = flatten
    ? flattenInlineStyles(raw)
    : { html: raw, css: '' };

  if (shell === 'fragment') return html;

  const headTags = [...(options.headTags ?? [])];
  if (flatten && css) headTags.unshift(`<style>${css}</style>`);
  return wrapDocument({
    bodyHtml: html,
    title: options.title ?? page.metadata.title,
    headTags,
  });
}

// =============================================================================
// helpers
// =============================================================================

/** Decode the small set of HTML entities React emits inside attribute values. */
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Merge repeated `class="..."` attributes that the style-hoist may have produced
 * on a single element (when a styled node already had a class). Runs until no
 * same-tag pair remains. `[^>]*?` keeps the match inside one tag.
 */
function mergeDuplicateClassAttrs(html: string): string {
  const dupe = /class="([^"]*)"([^>]*?)\sclass="([^"]*)"/;
  let out = html;
  while (dupe.test(out)) {
    out = out.replace(dupe, (_m, a: string, mid: string, b: string) => {
      const merged = `${a} ${b}`.trim();
      return `class="${merged}"${mid}`;
    });
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
