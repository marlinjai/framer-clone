// src/lib/site/cardColors.ts
//
// The colours a project card on the home draws its small abstract page with
// (docs/plans/2026-11-23-sites-home-and-light-mode.md, "Project cards"): the
// site's own document background and text, plus one accent from its colour
// tokens, in the scheme its published page shows without a system setting.
// Nothing stores a preview image, and live frames would load a scene per card.
//
// Every value passes the theme's strict colour grammar (parseColorValue), so a
// stored value that is not a colour never reaches a style.

import {
  emittedTheme,
  liveTokens,
  parseColorValue,
  parseTokenReference,
  resolveTokenRefs,
  themeColorMode,
  type SiteTheme,
} from './theme';
import { cssColorToRgba, parseCssColor } from '@/lib/color/cssColor';

export interface SiteCardColors {
  background: string;
  text: string;
  /** A colour token the document styles do not already use, or null. */
  accent: string | null;
}

const FALLBACK = {
  light: { background: '#ffffff', text: '#111111' },
  dark: { background: '#111111', text: '#f5f5f5' },
} as const;

/** The card colours of a site, or null when its theme names no colour at all. */
export function siteCardColors(raw: SiteTheme | undefined): SiteCardColors | null {
  if (!raw) return null;
  const theme = emittedTheme(raw);
  const scheme = themeColorMode(theme) ?? 'light';
  const resolve = (reference: string | undefined): string | null =>
    parseTokenReference(reference) === null ? null : parseColorValue(resolveTokenRefs(reference as string, theme, scheme));
  const background = resolve(theme.document.backgroundColor);
  const text = resolve(theme.document.color);
  const used = new Set([parseTokenReference(theme.document.backgroundColor), parseTokenReference(theme.document.color)]);
  let accent: string | null = null;
  for (const token of liveTokens(theme)) {
    if (token.kind !== 'color' || used.has(token.id) || token.broken) continue;
    const value = parseColorValue(scheme === 'dark' ? (token.dark ?? token.light) : token.light);
    if (value !== null && value !== background && value !== text) {
      accent = value;
      break;
    }
  }
  if (background === null && text === null && accent === null) return null;
  const ground = background ?? FALLBACK[scheme].background;
  return {
    background: ground,
    // No text colour of its own: the fallback follows the drawn background, not the scheme, so a dark
    // background on a light (or system) site never gets dark text.
    text: text ?? FALLBACK[isDark(ground) ? 'dark' : 'light'].text,
    accent,
  };
}

/** True for a colour darker than mid grey (relative luminance under 0.18); false when it cannot be read. */
function isDark(value: string): boolean {
  const parsed = parseCssColor(value);
  const rgba = parsed ? cssColorToRgba(parsed) : undefined;
  if (!rgba) return false;
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgba.r) + 0.7152 * lin(rgba.g) + 0.0722 * lin(rgba.b) < 0.18;
}
