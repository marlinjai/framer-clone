// The @font-face rules for the library families a page uses, as one <style>
// element, for the editor canvas and the preview (both render into the editor
// document, no iframe, so one element covers every frame). An observer: it
// re-renders when a node's props are replaced (an edit, an undo, a generation),
// and React leaves the element alone while the text stays the same.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { collectPageFonts, fontFaceCss, type FontScanNode } from './registry';
import { themeFontFamilies, type SiteTheme } from '@/lib/site/theme';

export interface PageFontFacesProps {
  /** The trees to scan: the page's app tree, plus floating elements on the canvas. */
  roots: readonly (FontScanNode | null | undefined)[];
  /**
   * The site's theme: the families of its font tokens are declared too, since no scan
   * finds a family behind a reference (docs/plans/2026-11-02-theme-and-head.md, slice T3).
   */
  theme?: SiteTheme;
}

const PageFontFaces = observer(({ roots, theme }: PageFontFacesProps) => {
  const ids = collectPageFonts(roots).ids;
  const fromTheme = theme ? themeFontFamilies(theme).filter((id) => !ids.includes(id)) : [];
  const css = fontFaceCss([...ids, ...fromTheme]);
  if (!css) return null;
  // The text comes only from the registry (never from page data).
  return <style data-fc-fonts="" dangerouslySetInnerHTML={{ __html: css }} />;
});

PageFontFaces.displayName = 'PageFontFaces';
export default PageFontFaces;
