// src/lib/site/siteSheets.tsx
//
// What the published `(site)` layout writes ahead of every page, apart from the route
// file so a test renders exactly what a visitor gets (a layout file may export only
// what Next reads from it). Contract: docs/plans/2026-11-02-theme-and-head.md,
// "Published page" and "Light and dark".

import React from 'react';
import type { Viewport } from 'next';
import { SYSTEM_FONT_STACK } from '@/lib/fonts/registry';
import { documentBackgroundColors, themeCss, type SiteTheme } from '@/lib/site/theme';

/**
 * What the browser paints before and around the page: `color-scheme` for a chosen mode,
 * and `theme-color` from the document background, one per scheme for `system`. Nothing
 * for a site with no choice, so its head is what it was before themes existed.
 */
export function themeViewport(theme: SiteTheme | undefined): Viewport {
  const mode = theme?.mode;
  if (mode !== 'system' && mode !== 'light' && mode !== 'dark') return {};
  const colors = documentBackgroundColors(theme);
  const themeColor =
    colors.length === 0
      ? undefined
      : mode === 'system'
        ? colors.map(({ scheme, color }) => ({ media: `(prefers-color-scheme: ${scheme})`, color }))
        : colors[0].color;
  return { colorScheme: mode === 'system' ? 'light dark' : mode, ...(themeColor ? { themeColor } : {}) };
}

/**
 * The sheets the layout writes ahead of every page: the base font, then the theme.
 * Synchronous and pure, so a test can render exactly what a visitor gets. The theme
 * sheet is themeCss text only, which never holds a `<` (theme.ts trusts nothing it reads).
 */
export function SiteSheets({ theme }: { theme?: SiteTheme }) {
  const css = theme ? themeCss(theme) : '';
  return (
    <>
      {/* The site sheet's reset puts Geist on <html> (Tailwind preflight).
          A published page that sets no font family of its own falls back to the
          system stack instead, never to a face the editor chrome happens to use.
          Constant text from the font registry, never site data. */}
      <style data-fc-site-base="" dangerouslySetInnerHTML={{ __html: `body{font-family:${SYSTEM_FONT_STACK}}` }} />
      {css ? <style data-fc-theme-sheet="" dangerouslySetInnerHTML={{ __html: css }} /> : null}
    </>
  );
}

