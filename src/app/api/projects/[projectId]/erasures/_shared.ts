// src/app/api/projects/[projectId]/erasures/_shared.ts
//
// What the two erase routes share: the guard (the company's owner, on top of the
// editor guard), the bounds of the searched value, and the answers. Plan:
// docs/plans/2026-11-01-immutable-published-copy.md, "Erasing personal data from
// the history".
//
// The searched value is personal data. It travels only in POST bodies, so it
// never lands in an address or an access log, and no answer or log line here
// ever carries it: an unexpected error is reported by its name only, since a
// database error's message can quote the data it was writing.

import { z } from 'zod';
import { jsonError } from '@/lib/api/respond';
import { authorizeDomainProject, type DomainProjectResult } from '@/server/domains/guard';
import { siteRepositoryErrorResponse, SiteRepositoryError } from '@/server/sites';
import { EraseQueryError, EraseShapeError, ERASE_LIMITS } from '@/server/sites/erase';
import {
  customHostCacheTag,
  revalidateCustomHostsForSiteId,
  revalidateSiteCache,
  resolveSubdomainForSiteId,
  siteCacheTag,
} from '@/server/sites/cachedResolver';
import { purgeCachedSiteFiles } from '@/server/sites/originCacheFiles';
import { forgetSite } from '@/lib/components/expandedPages';

/** The searched value, before trimming: the repository checks the real bounds. */
export const eraseValueSchema = z.string().max(ERASE_LIMITS.maxChars * 4);

export const searchBodySchema = z.object({
  value: eraseValueSchema,
  caseSensitive: z.boolean().optional(),
  /** Also inside longer words; whole words only by default. */
  insideWords: z.boolean().optional(),
});

const matchIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

export const eraseBodySchema = z.object({
  value: eraseValueSchema,
  caseSensitive: z.boolean().optional(),
  insideWords: z.boolean().optional(),
  /** What each match becomes: empty, or a placeholder such as `[entfernt]`. */
  replacement: z.string().max(ERASE_LIMITS.maxChars).default(''),
  /** The preview's token: a change since the search is refused. */
  token: matchIdSchema,
  /** The matches the owner saw and ticked: only these are rewritten, never more than a preview lists. */
  chosen: z.array(matchIdSchema).min(1).max(ERASE_LIMITS.listed),
});

/** The query a body names. */
export function queryOf(body: { value: string; caseSensitive?: boolean; insideWords?: boolean }) {
  return { value: body.value, caseSensitive: body.caseSensitive === true, insideWords: body.insideWords === true };
}

/** The owner of the site's company, through the editor guard (see guard.ts, step 5). */
export function authorizeEraser(req: Request, projectId: string): Promise<DomainProjectResult> {
  return authorizeDomainProject(req, projectId, 'eraseSiteData', undefined, { requireCompanyOwner: true });
}

/** The answer for a failure, without the searched value in it. */
export function eraseErrorResponse(err: unknown, code: string, message: string): Response {
  if (err instanceof EraseQueryError) return jsonError(err.code, err.message, 400);
  if (err instanceof SiteRepositoryError) return siteRepositoryErrorResponse(err);
  if (err instanceof EraseShapeError) {
    console.error('[erase] a rewrite would have changed a document; nothing was written');
    return jsonError('erase_refused', 'Erasing here would change the structure of a published version. Nothing was changed.', 500);
  }
  console.error(`[erase] ${code}: ${err instanceof Error ? err.name : 'unknown error'}`);
  return jsonError(code, message, 500);
}

/**
 * Refresh the published site after an erase, as rollback does: the subdomain (a
 * site never published has none, and gets none from here) and every custom
 * host. Then remove the old copies this container still holds: the expanded page
 * trees in memory, and the origin cache's files on disk, which a revalidation
 * only marks stale and which an offline site would keep until the next deploy.
 * Throws on failure, so the caller answers 500 and the owner retries. This
 * container only: see deploy/README.md, "Erasing personal data".
 */
export async function revalidateErasedSite(siteId: string): Promise<void> {
  const subdomain = await resolveSubdomainForSiteId(siteId);
  if (subdomain) revalidateSiteCache(subdomain);
  const hosts = await revalidateCustomHostsForSiteId(siteId);
  forgetSite(siteId);
  await purgeCachedSiteFiles([...(subdomain ? [siteCacheTag(subdomain)] : []), ...hosts.map(customHostCacheTag)]);
}
