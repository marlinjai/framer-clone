// A tree through the real published path: the same two steps
// renderPublishedPage runs after hydrating, applyResponsiveStyles then
// renderComponentNode. Left out on purpose, because no probe uses them:
// hydrateBindings, applyEffects, the sticky bar's hoisting, the consent and font
// wrappers. None of the code under test is copied.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { applyResponsiveStyles } from '@/lib/renderer/server/applyResponsiveStyles';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';

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

/** A complete page for Chromium. The stylesheet sits where the published route puts it. */
export function publishedDocument({ html, css }: PublishedOutput): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body style="margin:0">${html}</body></html>`;
}
