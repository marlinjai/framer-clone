// src/lib/ai/pageGen/promptSections/legalLinks.ts
//
// The page generator's footer rule for legal links (published site
// essentials, decisions 5 and 6, docs/plans/2026-10-23-published-site-essentials.md):
// every footer links the site's legal pages (Impressum, privacy policy,
// terms) that EXIST in the project, plus the "Cookie settings" link the
// consent banner reopens from (#cookie-settings; hidden on published sites
// where nothing needs consent). Links to legal pages that do not exist yet
// are never generated: a dead /impressum link is worse than none, and the
// publish flow already asks for a missing Impressum.
//
// Three parts, like siteContext.ts:
//   - legalLinksFromPages: the editor side, from the project's pages.
//   - LegalLinksSchema: the route's validation (an optional field of the
//     site context).
//   - legalLinksText: the prompt section (volatile part: it differs per
//     project and language).

import { z } from 'zod';
import {
  COOKIE_SETTINGS_HASH,
  COOKIE_SETTINGS_LABELS,
  LEGAL_KINDS,
  LEGAL_LINK_LABELS,
  findLegalPage,
  legalLanguage,
  type LegalPageLike,
} from '@/lib/legal/legalPages';

export interface LegalLink {
  href: string;
  label: string;
}

/** The request field: at most the three legal pages and the cookie link. */
export const LegalLinksSchema = z
  .array(
    z.strictObject({
      href: z.string().trim().regex(/^(\/[a-z0-9/-]{1,200}|#cookie-settings)$/, 'href must be a site path or #cookie-settings'),
      label: z.string().trim().min(1).max(60),
    }),
  )
  .max(4);

/** The footer links for this project: its existing legal pages, then cookie settings. */
export function legalLinksFromPages(pages: Iterable<LegalPageLike>, language: string): LegalLink[] {
  const list = Array.from(pages);
  const lang = legalLanguage(language);
  const links: LegalLink[] = [];
  for (const kind of LEGAL_KINDS) {
    const page = findLegalPage(list, kind);
    if (page && page.slug) links.push({ href: `/${page.slug}`, label: LEGAL_LINK_LABELS[lang][kind] });
  }
  links.push({ href: COOKIE_SETTINGS_HASH, label: COOKIE_SETTINGS_LABELS[lang] });
  return links;
}

/** The prompt section. Labels are data (they come from fixed tables, but stay delimited). */
export function legalLinksText(links: readonly LegalLink[]): string {
  const data = JSON.stringify(links).replace(/</g, '\\u003c');
  return [
    '## Footer legal links',
    '',
    'Whenever you build a footer, end it with a small row of plain text links (an "a" for each, small type,',
    'the footer\'s own text colour, underlined or clearly link-styled) for exactly these entries, with exactly',
    'these href values and labels, in this order:',
    '<legal_links>',
    data,
    '</legal_links>',
    'Do not invent other legal pages or link to legal pages not listed here. Keep the link with href',
    `"${COOKIE_SETTINGS_HASH}" exactly as given: it reopens the site's cookie settings.`,
  ].join('\n');
}
