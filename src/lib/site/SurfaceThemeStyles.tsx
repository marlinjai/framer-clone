// src/lib/site/SurfaceThemeStyles.tsx
//
// The site's theme on an editor surface (surfaceTheme.ts), one <style> element on the
// canvas and one in the preview. It renders beside the page base and before the rule
// sheet, as the published page has the base, then the theme, then the page's own
// sheet, so a page's `:root` rule still beats the theme. Not beside a node, for the
// reason in CanvasRuleStyles.tsx. An observer: a token edit replaces Site settings,
// which re-renders it, and every frame repaints with no reload.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import type { PageBase } from './pageBase';
import type { SiteTheme } from './theme';
import { surfaceThemeSheet } from './surfaceTheme';

export interface SurfaceThemeStylesProps {
  theme: SiteTheme | undefined;
  base: PageBase;
}

export const SurfaceThemeStyles = observer(({ theme, base }: SurfaceThemeStylesProps) => {
  const css = theme ? surfaceThemeSheet(theme, base) : '';
  if (!css) return null;
  // The grammar admits no `<`, so this never happens; if a later change broke that, the
  // sheet goes rather than the element it stands in.
  if (css.includes('<')) {
    console.error('[theme] the surface theme sheet held a <, so it is left out.');
    return null;
  }
  // themeCss checks every id, kind and value again at emission, and the ground is constant text.
  return <style data-fc-theme-sheet="surface" dangerouslySetInnerHTML={{ __html: css }} />;
});

SurfaceThemeStyles.displayName = 'SurfaceThemeStyles';
