// A tree through the real published path: the same two steps
// renderPublishedPage runs after hydrating, applyResponsiveStyles then
// renderComponentNode. Left out on purpose, because no probe uses them:
// hydrateBindings, applyEffects, the sticky bar's hoisting, the consent and font
// wrappers. None of the code under test is copied.
//
// A placement needs all of it, because inputs resolve in hydration, so
// `renderThroughPublishedPage` takes a stored tree through
// snapshotToComponentNode and renderPublishedPage, with a CMS fake for its rows.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { applyResponsiveStyles } from '@/lib/renderer/server/applyResponsiveStyles';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';
import type { ComponentDefinitions } from '@/lib/components/definition';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { snapshotToComponentNode } from '@/lib/renderer/server/snapshotToComponentNode';
import type { PageSnapshotOut } from '@/models/PageModel';
import type { CmsReadRepository } from '@/server/cms';

/** The three breakpoints every page starts with (DEFAULT_VIEWPORTS), plus the frame width each is shown at. */
export const BREAKPOINTS: readonly (BreakpointRef & { label: string; width: number; height: number })[] =
  DEFAULT_VIEWPORTS.map((v) => ({
    id: v.label.toLowerCase(),
    minWidth: v.minWidth,
    label: v.label,
    width: v.width,
    height: v.height,
  }));

export interface PublishedOutput {
  html: string;
  css: string;
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
  const { body } = await renderPublishedPage({
    root: adapted.root,
    budget: adapted.budget,
    pageParams: {},
    cmsRepo: fakeCmsRepo(rows),
    breakpoints: adapted.breakpoints,
  });
  return { html: renderToStaticMarkup(React.createElement(React.Fragment, null, body)), css: '' };
}

/** A complete page for Chromium. The stylesheet sits where the published route puts it. */
export function publishedDocument({ html, css }: PublishedOutput): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body style="margin:0">${html}</body></html>`;
}
