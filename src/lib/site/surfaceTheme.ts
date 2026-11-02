// src/lib/site/surfaceTheme.ts
//
// The site's theme on the two editor surfaces, the canvas and the preview (contract
// docs/plans/2026-11-02-theme-and-head.md, "Canvas and preview", slice T3). Both render
// into the editor's own document, so the theme never lands on `:root` here: themeCss's
// `surface` scope writes it on `[data-fc-theme]`, the attribute each frame's page box
// carries, and nothing outside a frame sees a value.
//
// What a frame carries (surfaceFrameAttributes):
//   - `data-fc-theme="frame"` on a box that stands for a page (a canvas frame's page box,
//     the preview's root), which takes the document block: background, text colour, font.
//   - `data-fc-theme="floating"` on a floating element, which takes the tokens and the
//     colour scheme and never a page background.
//   - `data-fc-theme-mode`, the scheme the frame shows (EditorUIStore.frameColorScheme).
//   - `class="dark"` only on a site that forces `dark`, as only its published page has it.
//
// The ground: what a page's own background is before the document block sets one. On
// the published page that is the `body` of the base sheet, which no frame has, so it is
// written here, before the theme's sheet and at the same specificity, so the document
// block still wins by coming later:
//   - base `reset`: the editor's base layer paints `body` with `--background` and
//     `--foreground`, which only `class="dark"` changes, so only a forced `dark` frame
//     needs them; every other frame already shows that white.
//   - base `browser`: that layer is rolled back, so the page shows the canvas colour of
//     its colour scheme, which is what `Canvas` is on the frame.
//
// PURE and client-safe.

import { themeCss, type ColorScheme, type SiteTheme } from './theme';
import type { PageBase } from './pageBase';

/** The attribute a frame's page box carries, and the floating element's. */
export const THEME_ATTRIBUTE = 'data-fc-theme';
export const THEME_MODE_ATTRIBUTE = 'data-fc-theme-mode';

/** A frame's ground before the document block: see the header. Constant text. */
function groundCss(base: PageBase): string {
  return base === 'browser'
    ? '[data-fc-theme=frame]{background-color:Canvas}'
    : '[data-fc-theme=frame]:where(.dark){background-color:var(--background);color:var(--foreground)}';
}

/**
 * The theme's sheet for both editor surfaces, or '' when the theme emits nothing (no
 * mode chosen, no token, no document value), so a site with no theme renders exactly
 * as it did before themes existed.
 */
export function surfaceThemeSheet(theme: SiteTheme, base: PageBase): string {
  const sheet = themeCss(theme, { scope: 'surface' });
  return sheet ? `${groundCss(base)}${sheet}` : '';
}

/** The attributes of a frame's page box (`frame`) or a floating element (`floating`). `class="dark"` is the caller's, from EditorUIStore.frameDarkClass. */
export function surfaceFrameAttributes(
  kind: 'frame' | 'floating',
  scheme: ColorScheme,
): { 'data-fc-theme': 'frame' | 'floating'; 'data-fc-theme-mode': ColorScheme } {
  return { [THEME_ATTRIBUTE]: kind, [THEME_MODE_ATTRIBUTE]: scheme } as { 'data-fc-theme': 'frame' | 'floating'; 'data-fc-theme-mode': ColorScheme };
}
