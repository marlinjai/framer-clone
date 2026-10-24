// src/lib/legal/publishCheck.ts
//
// What the publish flow warns about before a site goes live (plan
// docs/plans/2026-10-23-published-site-essentials.md, decision 5): a site
// that carries business data but has no Impressum (German law requires one
// for a business site), and legal pages that still hold [placeholders]. A
// warning, never a gate: the owner can publish anyway. PURE.

import type { BusinessInfo } from '@/lib/site/siteSettings';
import { LEGAL_KINDS, findLegalPage, type LegalKind, type LegalPageLike } from './legalPages';
import { findPlaceholders } from './templates';

interface NodeLike {
  props?: { children?: unknown } | null;
  children?: NodeLike[] | null;
}

export interface PublishCheckPage extends LegalPageLike {
  id: string;
  metadata: { legalTemplate?: string; title: string };
  /** The page's component tree (snapshot or instance with props and children). */
  tree: NodeLike | null | undefined;
}

export interface LegalPlaceholderIssue {
  kind: LegalKind;
  pageId: string;
  title: string;
  count: number;
}

export interface PublishCheck {
  /** Business data is filled in but no Impressum page exists. */
  missingImpressum: boolean;
  /** Legal pages that still contain [placeholders]. */
  placeholders: LegalPlaceholderIssue[];
}

/** True when the owner has entered any business data (the site is a business site). */
export function hasBusinessData(b: BusinessInfo): boolean {
  return Boolean(
    b.legalName || b.street || b.city || b.phone || b.email || b.vatId || b.registerEntry || b.managingDirectors.length > 0,
  );
}

function countPlaceholders(root: NodeLike | null | undefined): number {
  let count = 0;
  const stack: NodeLike[] = root ? [root] : [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const text = node.props?.children;
    if (typeof text === 'string') count += findPlaceholders(text).length;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return count;
}

export function checkBeforePublish(business: BusinessInfo, pages: PublishCheckPage[]): PublishCheck {
  const placeholders: LegalPlaceholderIssue[] = [];
  for (const kind of LEGAL_KINDS) {
    const page = findLegalPage(pages, kind);
    // Only pages made from the template: an owner's own page is theirs to word.
    if (!page || page.metadata.legalTemplate !== kind) continue;
    const count = countPlaceholders(page.tree);
    if (count > 0) placeholders.push({ kind, pageId: page.id, title: page.metadata.title, count });
  }
  return {
    missingImpressum: hasBusinessData(business) && !findLegalPage(pages, 'impressum'),
    placeholders,
  };
}

/** True when there is something to warn about. */
export function hasPublishIssues(check: PublishCheck): boolean {
  return check.missingImpressum || check.placeholders.length > 0;
}
