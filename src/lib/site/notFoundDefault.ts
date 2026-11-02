// src/lib/site/notFoundDefault.ts
//
// The default 404 of a published site that has not designed its own 404 page
// (plan decision 3): copy in the site's language, the site's name, and the
// look of its home page (font, text and background colour, the first filled
// button's colour), so a miss still looks like the site. A button inside a
// reusable component counts, with a colour passed to it as an input. PURE, apart
// from the expansion memo.

import type { PublishedPageRow } from '@/server/sites/publicResolver';
import { literalPage, type ExpandableSite } from '@/lib/components/expandedPages';
import { colorText, composite, contrastRatio, parseColor } from '@/lib/ai/review/layoutAudit';
import { platformFontStack } from '@/lib/fonts/registry';

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

/**
 * The pair as CSS written from its parsed numbers, or null unless it can be shown to
 * read. It fails closed: a value with no colour to judge, such as var(), color-mix(),
 * currentColor, inherit or a gradient, is not legible, because what cannot be read
 * here can be anything in the browser. So is a see-through ground, because what is
 * behind it is not known. What comes back is the parse, never the stored text, so
 * nothing the parser and the browser read differently reaches the banner.
 */
function legiblePair(text: string, ground: string): { ink: string; on: string } | null {
  const on = parseColor(ground);
  const ink = parseColor(text);
  if (!on || !ink || on.a < 1 || ink.a === 0) return null;
  return contrastRatio(composite(ink, on), on) >= MIN_CONTRAST ? { ink: colorText(ink), on: colorText(on) } : null;
}

/**
 * The look as the banner writes it: each pair from its parsed numbers, or the neutral
 * pair when it cannot be shown to read, and the font as the registry writes it, or the
 * neutral stack when a family comes from outside it, whose glyphs could be empty. For
 * what has to stay readable whatever a site sets, which is the consent banner.
 */
export function legibleLook(look: SiteLook): SiteLook {
  const text = legiblePair(look.color, look.background);
  const button = legiblePair(look.accentText, look.accent);
  return {
    fontFamily: platformFontStack(look.fontFamily) ?? DEFAULT_LOOK.fontFamily,
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
 * The look of a site, read off its home page: the root's font and colours (or
 * the first section's background when the root has none), and the first
 * filled link or button as the accent. Anything missing keeps the default.
 */
export function siteLookFromPages(site: ExpandableSite & { pages: readonly PublishedPageRow[] }): SiteLook {
  const { pages } = site;
  const home =
    pages.find((p) => p.slug.split('/').filter(Boolean).length === 0) ?? pages[0];
  const root = (home ? literalPage(site, home).root : null) as NodeLike | null;
  if (!root) return DEFAULT_LOOK;
  const look: SiteLook = { ...DEFAULT_LOOK };
  const style = root.props?.style ?? {};
  look.fontFamily = baseValue(style.fontFamily) ?? look.fontFamily;
  look.color = baseValue(style.color) ?? look.color;
  const firstSection = root.children?.[0]?.props?.style ?? {};
  look.background =
    baseValue(style.backgroundColor) ?? baseValue(firstSection.backgroundColor) ?? look.background;
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
