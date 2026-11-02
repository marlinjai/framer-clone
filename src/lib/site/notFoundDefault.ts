// src/lib/site/notFoundDefault.ts
//
// The default 404 of a published site that has not designed its own 404 page
// (plan decision 3): copy in the site's language, the site's name, and the
// look of its home page (font, text and background colour, the first filled
// button's colour), so a miss still looks like the site. A button inside a
// reusable component counts, with a colour passed to it as an input. PURE, apart
// from the expansion memo.
//
// A site's theme (src/lib/site/theme.ts) comes first: its document block is the
// site's background, text colour and font, and a value may refer to one of its
// tokens. legibleLook reads those references through the theme, in every colour
// scheme the site can show, so a pair that reads keeps the site's look and flips with
// the page, and one that does not becomes the neutral pair as literals
// (docs/plans/2026-11-02-theme-and-head.md, "The consent banner and the default 404").

import type { PublishedPageRow } from '@/server/sites/publicResolver';
import { literalPage, type ExpandableSite } from '@/lib/components/expandedPages';
import { colorText, composite, contrastRatio } from '@/lib/ai/review/layoutAudit';
import { parseColor, type Rgba } from '@/lib/color/cssColor';
import { platformFontStack } from '@/lib/fonts/registry';
import { parseTokenReference, resolveTokenRefs, schemesInForce, type SiteTheme } from './theme';

export interface NotFoundCopy {
  eyebrow: string;
  heading: string;
  body: string;
  homeLink: string;
}

const COPY: Record<string, NotFoundCopy> = {
  en: {
    eyebrow: 'Error 404',
    heading: 'Page not found',
    body: 'The page you are looking for does not exist or has moved.',
    homeLink: 'Go to the homepage',
  },
  de: {
    eyebrow: 'Fehler 404',
    heading: 'Seite nicht gefunden',
    body: 'Die Seite, die Sie suchen, gibt es nicht oder sie ist umgezogen.',
    homeLink: 'Zur Startseite',
  },
  fr: {
    eyebrow: 'Erreur 404',
    heading: 'Page introuvable',
    body: "La page que vous cherchez n'existe pas ou a été déplacée.",
    homeLink: "Aller à l'accueil",
  },
  it: {
    eyebrow: 'Errore 404',
    heading: 'Pagina non trovata',
    body: 'La pagina che cerchi non esiste o è stata spostata.',
    homeLink: 'Vai alla home page',
  },
  es: {
    eyebrow: 'Error 404',
    heading: 'Página no encontrada',
    body: 'La página que buscas no existe o se ha movido.',
    homeLink: 'Ir a la página de inicio',
  },
  nl: {
    eyebrow: 'Fout 404',
    heading: 'Pagina niet gevonden',
    body: 'De pagina die u zoekt bestaat niet of is verplaatst.',
    homeLink: 'Naar de startpagina',
  },
};

/** The 404 copy for a BCP 47 tag (by its language part), English otherwise. */
export function notFoundCopy(language: string): NotFoundCopy {
  const lang = language.split('-')[0].toLowerCase();
  return COPY[lang] ?? COPY.en;
}

export interface SiteLook {
  fontFamily: string;
  color: string;
  background: string;
  accent: string;
  accentText: string;
}

export const DEFAULT_LOOK: SiteLook = {
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  color: '#111827',
  background: '#ffffff',
  accent: '#111827',
  accentText: '#ffffff',
};

/** WCAG 2.2 AA for body text. */
const MIN_CONTRAST = 4.5;

/** The pair's colours when it can be shown to read, or null. */
function readablePair(text: string, ground: string): { ink: Rgba; on: Rgba } | null {
  const on = parseColor(ground);
  const ink = parseColor(text);
  if (!on || !ink || on.a < 1 || ink.a === 0) return null;
  return contrastRatio(composite(ink, on), on) >= MIN_CONTRAST ? { ink, on } : null;
}

/**
 * The pair as the banner writes it, or null unless it can be shown to read in every
 * colour scheme the site can show. It fails closed: a value with no colour to judge,
 * such as var() of no token, color-mix(), currentColor, inherit or a gradient, is not
 * legible, because what cannot be read here can be anything in the browser. So is a
 * see-through ground, because what is behind it is not known.
 *
 * A side that is exactly a token reference stays that reference, so it flips with the
 * page, which is safe because it read in each scheme. Every other side is written from
 * its parsed numbers, never as stored text, so nothing the parser and the browser read
 * differently reaches the banner.
 */
function legiblePair(text: string, ground: string, theme: SiteTheme | undefined): { ink: string; on: string } | null {
  const schemes = schemesInForce(theme?.mode);
  let first: { ink: Rgba; on: Rgba } | null = null;
  for (const scheme of schemes) {
    const read = theme
      ? readablePair(resolveTokenRefs(text, theme, scheme), resolveTokenRefs(ground, theme, scheme))
      : readablePair(text, ground);
    if (!read) return null;
    first ??= read;
  }
  if (!first) return null;
  const side = (stored: string, parsed: Rgba) => (theme && parseTokenReference(stored) !== null ? stored : colorText(parsed));
  return { ink: side(text, first.ink), on: side(ground, first.on) };
}

/**
 * The look as the banner and the default 404 write it: each pair as legiblePair gives
 * it, or the neutral pair as literals on both sides when it cannot be shown to read, and
 * the font as the registry writes it, or the neutral stack when a family comes from
 * outside it, whose glyphs could be empty. A font token is read through the theme first,
 * so it counts as the registry stack it stands for. For what has to stay readable
 * whatever a site sets, which is the consent banner.
 */
export function legibleLook(look: SiteLook, theme?: SiteTheme): SiteLook {
  const text = legiblePair(look.color, look.background, theme);
  const button = legiblePair(look.accentText, look.accent, theme);
  // A font has one value in every scheme.
  const font = theme ? resolveTokenRefs(look.fontFamily, theme, 'light') : look.fontFamily;
  return {
    fontFamily: platformFontStack(font) ?? DEFAULT_LOOK.fontFamily,
    color: text?.ink ?? DEFAULT_LOOK.color,
    background: text?.on ?? DEFAULT_LOOK.background,
    accent: button?.on ?? DEFAULT_LOOK.accent,
    accentText: button?.ink ?? DEFAULT_LOOK.accentText,
  };
}

interface NodeLike {
  type?: unknown;
  props?: { style?: Record<string, unknown> };
  children?: NodeLike[];
}

/** A style value's base (responsive maps carry `base`); only safe CSS strings. */
function baseValue(value: unknown): string | null {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && typeof (value as Record<string, unknown>).base === 'string'
        ? ((value as Record<string, unknown>).base as string)
        : null;
  if (!raw) return null;
  // Inline style only, but stay conservative: no url(), no expressions.
  if (/[<>;{}]|url\(|expression\(/i.test(raw)) return null;
  return raw.trim() || null;
}

/** Breadth-first walk, bounded, so a huge page costs little. */
function* walk(root: NodeLike | undefined, limit = 400): Generator<NodeLike> {
  if (!root) return;
  const queue: NodeLike[] = [root];
  let seen = 0;
  while (queue.length > 0 && seen < limit) {
    const node = queue.shift()!;
    seen++;
    yield node;
    if (Array.isArray(node.children)) queue.push(...node.children);
  }
}

/**
 * The look of a site: its theme's document block first (background, text colour and
 * font, each a token reference), then its home page: the root's font and colours (or
 * the first section's background when the root has none), and the first filled link
 * or button as the accent. Anything missing keeps the default.
 */
export function siteLookFromPages(
  site: ExpandableSite & { pages: readonly PublishedPageRow[]; siteSettings?: { theme?: SiteTheme } },
): SiteLook {
  const { pages } = site;
  const document = site.siteSettings?.theme?.document ?? {};
  const fromTheme = {
    fontFamily: parseTokenReference(document.fontFamily) !== null ? document.fontFamily : undefined,
    color: parseTokenReference(document.color) !== null ? document.color : undefined,
    background: parseTokenReference(document.backgroundColor) !== null ? document.backgroundColor : undefined,
  };
  const home =
    pages.find((p) => p.slug.split('/').filter(Boolean).length === 0) ?? pages[0];
  const root = (home ? literalPage(site, home).root : null) as NodeLike | null;
  const look: SiteLook = {
    ...DEFAULT_LOOK,
    ...(fromTheme.fontFamily ? { fontFamily: fromTheme.fontFamily } : {}),
    ...(fromTheme.color ? { color: fromTheme.color } : {}),
    ...(fromTheme.background ? { background: fromTheme.background } : {}),
  };
  if (!root) return look;
  const style = root.props?.style ?? {};
  if (!fromTheme.fontFamily) look.fontFamily = baseValue(style.fontFamily) ?? look.fontFamily;
  if (!fromTheme.color) look.color = baseValue(style.color) ?? look.color;
  const firstSection = root.children?.[0]?.props?.style ?? {};
  if (!fromTheme.background) {
    look.background = baseValue(style.backgroundColor) ?? baseValue(firstSection.backgroundColor) ?? look.background;
  }
  for (const node of walk(root)) {
    if (node.type !== 'a' && node.type !== 'button') continue;
    const bg = baseValue(node.props?.style?.backgroundColor);
    if (!bg) continue;
    look.accent = bg;
    look.accentText = baseValue(node.props?.style?.color) ?? look.accentText;
    break;
  }
  return look;
}
