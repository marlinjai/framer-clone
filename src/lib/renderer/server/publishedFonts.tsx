// The web-font part of a published page: the @font-face rules for the library
// families the page uses (src/lib/fonts/registry.ts), plus a preload of the
// display family's latin upright face so the first heading paints in its own
// face sooner. All files are served from the site's own origin (/fonts/...).
//
// A family behind a theme font token is declared by the theme's own sheet, in the
// `(site)` layout, so it is not declared again here; the theme only lets a heading
// that reaches its family through a token, or through the document font, be preloaded.
//
// The <style> renders in place at the start of the body, next to the
// responsive stylesheet. React 19 hoists the <link rel="preload"> into the
// head. crossOrigin is required on a font preload even for the same origin:
// font fetches are CORS-mode, and a preload without it is downloaded twice.

import React from 'react';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { collectPageFonts, fontFaceCss, getFontFamily, libraryFamiliesIn, preloadFaceUrl } from '@/lib/fonts/registry';
import { emittedTheme, parseTokenReference, resolveTokenRefs, type SiteTheme } from '@/lib/site/theme';

export function publishedFontAssets(root: ComponentNode, theme?: SiteTheme): React.ReactNode {
  // A font has one value in every scheme.
  const held = theme ? emittedTheme(theme) : undefined;
  const resolve = held ? (value: string) => resolveTokenRefs(value, held, 'light') : undefined;
  const documentFont = held?.document.fontFamily;
  const inherited =
    resolve && documentFont && parseTokenReference(documentFont) !== null
      ? libraryFamiliesIn(resolve(documentFont))[0]?.id
      : undefined;
  const { ids, displayId } = collectPageFonts([root], { resolve, inherited });
  const css = fontFaceCss(ids);
  const display = displayId ? getFontFamily(displayId) : undefined;
  const preload = display ? preloadFaceUrl(display) : undefined;
  if (!css && !preload) return null;
  return (
    <>
      {preload ? <link rel="preload" href={preload} as="font" type="font/woff2" crossOrigin="anonymous" /> : null}
      {/* Registry text only, never page data, so it cannot close the element. */}
      {css ? <style data-fc-fonts="" dangerouslySetInnerHTML={{ __html: css }} /> : null}
    </>
  );
}
