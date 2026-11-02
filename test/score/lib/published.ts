// A tree through the real published path: the same two steps
// renderPublishedPage runs after hydrating, applyResponsiveStyles then
// renderComponentNode. Left out on purpose, because no probe uses them:
// hydrateBindings, applyEffects, the sticky bar's hoisting, the consent and font
// wrappers. None of the code under test is copied. The document around the output
// is a real page's: the built base sheet, and the site layout's own style.
//
// A placement needs all of it, because inputs resolve in hydration, so
// `renderThroughPublishedPage` takes a stored tree through
// snapshotToComponentNode and renderPublishedPage, with a CMS fake for its rows.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import type { BehaviourProgram } from '@/lib/behaviour/program';
import { applyResponsiveStyles } from '@/lib/renderer/server/applyResponsiveStyles';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { BREAKPOINTS } from './breakpoints';
import type { ComponentDefinitions } from '@/lib/components/definition';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { DEFAULT_PAGE_BASE, pageBaseSheet, type PageBase } from '@/lib/site/pageBase';
import { snapshotToComponentNode } from '@/lib/renderer/server/snapshotToComponentNode';
import SiteLayout from '@/app/(site)/layout';
import type { PageSnapshotOut } from '@/models/PageModel';
import type { CmsReadRepository } from '@/server/cms';
import { DEFAULT_LANGUAGE, isLanguageTag } from '@/lib/site/siteSettings';
import { readPublishedBase } from './publishedBase';

export { BREAKPOINTS } from './breakpoints';

export interface PublishedOutput {
  html: string;
  css: string;
  /** The program the page runs, where the whole published path made one. */
  behaviour?: BehaviourProgram | null;
}

export function renderPublished(root: ComponentNode, breakpoints: readonly BreakpointRef[] = BREAKPOINTS): PublishedOutput {
  const { root: rewritten, css } = applyResponsiveStyles(root, breakpoints);
  const html = renderToStaticMarkup(React.createElement(React.Fragment, null, renderComponentNode(rewritten)));
  return { html, css };
}

/** A definition's frames: the three default widths, under ids of its own, as in a real project. */
export function viewportCanvasNodes(prefix: string): Record<string, unknown> {
  return Object.fromEntries(
    BREAKPOINTS.map((b) => [
      `${prefix}-${b.id}`,
      { id: `${prefix}-${b.id}`, canvasNodeType: 'viewport', breakpointId: `${prefix}-${b.id}`, breakpointMinWidth: b.minWidth },
    ]),
  );
}

/** Every collection read gives these rows, in order. */
export function fakeCmsRepo(rows: readonly Record<string, unknown>[] = []): CmsReadRepository {
  const stored = rows.map((values, index) => ({ id: `row-${index}`, values }));
  return {
    listRows: async () => ({ rows: stored }),
    getRow: async (_collection: string, id: string) => stored.find((row) => row.id === id) ?? null,
  } as unknown as CmsReadRepository;
}

export interface PublishedPageInput {
  /** The stored `appComponentTree`. */
  tree: unknown;
  definitions: ComponentDefinitions;
  rows?: readonly Record<string, unknown>[];
}

/** A stored tree through the whole published path. `css` is empty: the stylesheet is in `html`, where the route puts it. */
export async function renderThroughPublishedPage({ tree, definitions, rows }: PublishedPageInput): Promise<PublishedOutput> {
  const canvasNodes = Object.fromEntries(
    BREAKPOINTS.map((b) => [b.id, { canvasNodeType: 'viewport', breakpointId: b.id, breakpointMinWidth: b.minWidth }]),
  );
  const adapted = snapshotToComponentNode({ slug: '', appComponentTree: tree, canvasNodes } as unknown as PageSnapshotOut, definitions);
  if (!adapted.root) throw new Error('renderThroughPublishedPage: the tree has no root');
  const { body, behaviour } = await renderPublishedPage({
    root: adapted.root,
    budget: adapted.budget,
    pageParams: {},
    cmsRepo: fakeCmsRepo(rows),
    breakpoints: adapted.breakpoints,
  });
  return { html: renderToStaticMarkup(React.createElement(React.Fragment, null, body)), css: '', behaviour };
}

/** `<html lang>` as the root layout writes it: the site's language setting, refused when it is not a language tag. */
function langAttribute(lang: string): string {
  if (!isLanguageTag(lang)) throw new Error(`not a language tag: ${JSON.stringify(lang)}`);
  return lang;
}

const pageBase = (() => {
  const built = new Map<string, string[]>();
  return (lang: string) => {
    const known = built.get(lang);
    if (known) return known;
    const { css, meta } = readPublishedBase();
    if (/<\/style/i.test(css)) throw new Error('the published base sheet would close its own style element');
    const head = `<!doctype html><html lang="${langAttribute(lang)}" class="${meta.htmlClass}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style data-fc-published-base="">${css}</style></head>`;
    const body = `<body class="${meta.bodyClass}">${renderToStaticMarkup(React.createElement(SiteLayout, null, null))}`;
    built.set(lang, [head, body]);
    return [head, body];
  };
})();

/**
 * A complete page for Chromium, as a visitor gets it: the root layout's sheets in the
 * head (inline, because `page.setContent` has no origin to load a link from), its
 * classes on html and body, and the site layout's style, then the sheet of the site's
 * page base and the page's own sheet, in the body, where the published route puts them.
 * `lang` is the site's language setting, which the root layout writes on html.
 */
export function publishedDocument({ html, css }: PublishedOutput, base: PageBase = DEFAULT_PAGE_BASE, lang: string = DEFAULT_LANGUAGE): string {
  const [head, body] = pageBase(lang);
  const baseCss = pageBaseSheet(base);
  return `${head}${body}${baseCss ? `<style data-fc-page-base="">${baseCss}</style>` : ''}${css ? `<style data-fc-responsive="">${css}</style>` : ''}${html}</body></html>`;
}

/**
 * The same output with no page base, which no visitor ever gets. It exists for one
 * question only: when a check fails on the real page, would it pass without the base?
 */
export function bareDocument({ html, css }: PublishedOutput, lang: string = DEFAULT_LANGUAGE): string {
  return `<!doctype html><html lang="${langAttribute(lang)}"><head><meta charset="utf-8"><style>${css}</style></head><body style="margin:0">${html}</body></html>`;
}
