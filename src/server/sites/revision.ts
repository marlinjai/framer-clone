// src/server/sites/revision.ts
//
// The frozen document of one published revision (plan
// docs/plans/2026-11-01-immutable-published-copy.md). PURE: no Prisma, no
// `server-only`, so it is testable without a database and shared by the
// repository (write) and the public resolver (read).
//
// One rule: everything a visitor can read of a site comes from one of these.
// Identity and tenancy (site id, workspace, tenant group, company), the status
// and the domains are not in it: they are not content, and they stay live.

import type { PageSnapshotOut } from '@/models/PageModel';
import { parseSiteRedirects, type SiteRedirect } from '@/lib/pages/redirects';
import { normalizeSiteSettings, type SiteSettings } from '@/lib/site/siteSettings';
import { normalizeTheme } from '@/lib/site/theme';
import { checkBeforePublish, type PublishCheck, type PublishCheckPage } from '@/lib/legal/publishCheck';
import { parseComponents } from '@/lib/components/definition';

/**
 * The format of a revision document. A revision can stay live for as long as a
 * site goes unpublished, so a change to this document or to the page format must
 * either rewrite `site_revisions` or keep a reader for the old shape, and bump
 * this number (plan 2026-11-01-immutable-published-copy, "Format of a revision").
 */
export const REVISION_SCHEMA_VERSION = 1;

/** One frozen page: the same shape the public resolver hands to the router. */
export interface RevisionPage {
  pageId: string;
  slug: string;
  snapshot: PageSnapshotOut;
}

/** What `site_revisions.document` holds, as read. */
export interface SiteRevisionDocument {
  schemaVersion: typeof REVISION_SCHEMA_VERSION;
  name: string;
  analyticsProjectId: string | null;
  ingestionEndpoint: string | null;
  /** A SERVER-SIDE ref (Infisical path / pointer), NEVER the literal key. */
  apiKeyRef: string | null;
  lumitraEnabled: boolean;
  redirects: SiteRedirect[];
  siteSettings: SiteSettings;
  pages: RevisionPage[];
  /**
   * Reusable component definitions by id (reusable components contract,
   * decision 12): frozen beside `pages` so the two can never mix versions.
   * Opaque here; expansion reads it through its own parser.
   */
  components: Record<string, unknown>;
}

/** A revision document that cannot be read. */
export class MalformedRevisionError extends Error {
  constructor(detail: string) {
    super(`malformed site revision document: ${detail}`);
    this.name = 'MalformedRevisionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Read a stored document. Settings and redirects are normalized by their own
 * parsers, so a field added later needs no migration. A document without its
 * pages THROWS, as does a format this code cannot read: serving a site as empty,
 * or falling back to the working copy, would both hide the damage (and the second
 * would publish drafts). A page without a snapshot throws here, not later on one
 * page or in `locateForm`, which walks every page.
 */
export function parseRevisionDocument(raw: unknown): SiteRevisionDocument {
  if (!isRecord(raw)) throw new MalformedRevisionError('not an object');
  if (raw.schemaVersion !== REVISION_SCHEMA_VERSION) {
    throw new MalformedRevisionError(`unknown schema version ${String(raw.schemaVersion)}`);
  }
  if (!Array.isArray(raw.pages)) throw new MalformedRevisionError('no pages');
  const pages = raw.pages.map((page: unknown): RevisionPage => {
    if (!isRecord(page) || typeof page.pageId !== 'string' || typeof page.slug !== 'string') {
      throw new MalformedRevisionError('a page without an id or a slug');
    }
    if (!isRecord(page.snapshot)) throw new MalformedRevisionError(`page ${page.pageId} has no snapshot`);
    return { pageId: page.pageId, slug: page.slug, snapshot: page.snapshot as unknown as PageSnapshotOut };
  });
  return {
    schemaVersion: REVISION_SCHEMA_VERSION,
    name: typeof raw.name === 'string' ? raw.name : '',
    analyticsProjectId: stringOrNull(raw.analyticsProjectId),
    ingestionEndpoint: stringOrNull(raw.ingestionEndpoint),
    apiKeyRef: stringOrNull(raw.apiKeyRef),
    lumitraEnabled: raw.lumitraEnabled === true,
    redirects: parseSiteRedirects(raw.redirects),
    siteSettings: normalizeSiteSettings(raw.siteSettings),
    pages,
    components: isRecord(raw.components) ? raw.components : {},
  };
}

/**
 * The publish warnings for a frozen document (src/lib/legal/publishCheck.ts), so
 * making a version live warns about that version, not about the editor's draft.
 */
export function revisionPublishCheck(document: SiteRevisionDocument): PublishCheck {
  const pages = document.pages.map((page): PublishCheckPage => {
    const snapshot = page.snapshot as unknown as PublishCheckPage['snapshot'] & {
      metadata?: { title?: string; legalTemplate?: string };
    };
    return {
      id: page.pageId,
      slug: page.slug,
      metadata: { title: snapshot.metadata?.title ?? '', legalTemplate: snapshot.metadata?.legalTemplate },
      snapshot,
    };
  });
  // The frozen definitions, read as a visitor's render reads them: one that cannot
  // be read is reported, exactly as the editor's check reports it.
  const { definitions, refused } = parseComponents(document.components);
  return checkBeforePublish(document.siteSettings.business, pages, { definitions, refused }, normalizeTheme(document.siteSettings.theme));
}
