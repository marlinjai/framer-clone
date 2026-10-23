// The web-font part of a published page: the @font-face rules for the library
// families the page uses (src/lib/fonts/registry.ts), plus a preload of the
// display family's latin upright face so the first heading paints in its own
// face sooner. All files are served from the site's own origin (/fonts/...).
//
// The <style> renders in place at the start of the body, next to the
// responsive stylesheet. React 19 hoists the <link rel="preload"> into the
// head. crossOrigin is required on a font preload even for the same origin:
// font fetches are CORS-mode, and a preload without it is downloaded twice.

import React from 'react';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { collectPageFonts, fontFaceCss, getFontFamily, preloadFaceUrl } from '@/lib/fonts/registry';

export function publishedFontAssets(root: ComponentNode): React.ReactNode {
  const { ids, displayId } = collectPageFonts([root]);
  const css = fontFaceCss(ids);
  if (!css) return null;
  const display = displayId ? getFontFamily(displayId) : undefined;
  const preload = display ? preloadFaceUrl(display) : undefined;
  return (
    <>
      {preload ? <link rel="preload" href={preload} as="font" type="font/woff2" crossOrigin="anonymous" /> : null}
      {/* Registry text only, never page data, so it cannot close the element. */}
      <style data-fc-fonts="" dangerouslySetInnerHTML={{ __html: css }} />
    </>
  );
}
