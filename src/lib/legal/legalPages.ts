// src/lib/legal/legalPages.ts
//
// The legal pages a published site offers (plan
// docs/plans/2026-10-23-published-site-essentials.md, decision 5): which kinds
// exist, their stable slugs and link labels per language, and how to tell
// whether a project already has one. PURE: shared by ProjectModel, the Site
// settings dialog, the publish warning, the page generator's footer rule, the
// published renderer (the consent banner's privacy link) and the tests.
//
// The language is the site language (Site settings), read by its language part
// ("de-AT" is German). German gets the German slugs; every other language gets
// the English ones, because the templates exist in German and English only.

export const LEGAL_KINDS = ['impressum', 'privacy', 'terms'] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];

export type LegalLanguage = 'de' | 'en';

/** The template language for a BCP 47 tag: German for `de*`, English otherwise. */
export function legalLanguage(tag: string): LegalLanguage {
  return tag.split('-')[0].toLowerCase() === 'de' ? 'de' : 'en';
}

/** Stable slugs, one per kind and language. */
export const LEGAL_SLUGS: Record<LegalLanguage, Record<LegalKind, string>> = {
  de: { impressum: 'impressum', privacy: 'datenschutz', terms: 'agb' },
  en: { impressum: 'imprint', privacy: 'privacy', terms: 'terms' },
};

/** Page titles (and footer link labels). */
export const LEGAL_TITLES: Record<LegalLanguage, Record<LegalKind, string>> = {
  de: { impressum: 'Impressum', privacy: 'Datenschutzerklärung', terms: 'AGB' },
  en: { impressum: 'Imprint', privacy: 'Privacy policy', terms: 'Terms and conditions' },
};

/** Short footer link labels. */
export const LEGAL_LINK_LABELS: Record<LegalLanguage, Record<LegalKind, string>> = {
  de: { impressum: 'Impressum', privacy: 'Datenschutz', terms: 'AGB' },
  en: { impressum: 'Imprint', privacy: 'Privacy', terms: 'Terms' },
};

/**
 * The fragment a "Cookie settings" footer link points at. The published
 * consent runtime (src/lib/consent/consent.ts) opens the banner for any link
 * to it; on a site where nothing needs consent such links are hidden.
 */
export const COOKIE_SETTINGS_HASH = '#cookie-settings';

export const COOKIE_SETTINGS_LABELS: Record<LegalLanguage, string> = {
  de: 'Cookie-Einstellungen',
  en: 'Cookie settings',
};

/** Every slug any language uses for `kind` (a project may have switched language). */
export function slugsForKind(kind: LegalKind): string[] {
  return [LEGAL_SLUGS.de[kind], LEGAL_SLUGS.en[kind]];
}

/** The minimal page shape the helpers below read (MST page or snapshot). */
export interface LegalPageLike {
  id?: string;
  slug: string;
  metadata?: { legalTemplate?: string; title?: string } | null;
}

/**
 * The project's page of this kind: the page created from the template
 * (metadata.legalTemplate), else a page at one of the kind's stable slugs (an
 * owner who built their own /impressum has one too).
 */
export function findLegalPage<T extends LegalPageLike>(pages: Iterable<T>, kind: LegalKind): T | undefined {
  const list = Array.from(pages);
  const marked = list.find((p) => p.metadata?.legalTemplate === kind);
  if (marked) return marked;
  const slugs = slugsForKind(kind);
  return list.find((p) => slugs.includes(p.slug));
}

/** True when a valid legal kind. */
export function isLegalKind(value: unknown): value is LegalKind {
  return typeof value === 'string' && (LEGAL_KINDS as readonly string[]).includes(value);
}
