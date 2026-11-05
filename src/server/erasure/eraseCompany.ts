import 'server-only';

// src/server/erasure/eraseCompany.ts
//
// One company erasure end to end (plan docs/plans/2026-11-05-company-erasure-consumer.md), as
// POST /api/internal/erasure runs it:
//
//   1. The ledger row (erasure_events, keyed by auth-brain's event id). Already processed: done, nothing is
//      deleted again. Otherwise the scope the first attempt found (sites, workspaces, subdomains, custom
//      hostnames) is merged with what is found now and stored BEFORE anything is deleted, so a retry after
//      a partial failure still knows the hosts to purge and the workspaces whose form submissions to delete
//      once the site rows are gone.
//   2. The public rows, in committed batches. The sites stop resolving. Commerce cleanup then drains
//      in-flight form writers; later writers re-check the deleted site under its form lock and are refused.
//   3. The cached copies this container holds (see deploy/README.md, "Erasing personal data: one
//      container only"): the resolver's cache by tag and its remembered misses, the expanded page trees in
//      memory, and the origin cache's files on disk. A second invalidation a few seconds later closes the
//      window in which a visitor request that read the site before the commit stores it after the first.
//   4. Every tenant schema, through the owner connection (commerce.ts).
//   5. The ledger row is marked processed, only now.
//
// Any failure throws; the route answers 5xx and auth-brain retries. Every step is idempotent.

import type { PrismaClient } from '@prisma/client';

import { getPrismaClient } from '@/server/db';
import {
  customHostCacheTag,
  revalidateCustomHostCache,
  revalidateSiteCache,
  siteCacheTag,
} from '@/server/sites/cachedResolver';
import { purgeCachedSiteFiles } from '@/server/sites/originCacheFiles';
import { forgetSite } from '@/lib/components/expandedPages';

import { eraseCompanyCommerce, type CommerceErasureResult, type CommerceErasureScope } from './commerce';
import type { CompanyErasure } from './payload';
import {
  eraseCompanyPublic,
  findErasureScope,
  mergeScope,
  parseScope,
  type ErasureScope,
  type PublicErasureResult,
  PUBLIC_ERASURE_TRANSACTION,
} from './public';

/** Delay of the second cache invalidation, as the project delete (DELETE /api/projects/<id>). */
export const LATE_INVALIDATION_MS = 5_000;

export interface EraseCompanyDeps {
  prisma: PrismaClient;
  /** Erases the tenant schemas (the owner connection in production). */
  eraseCommerce: (scope: CommerceErasureScope) => Promise<CommerceErasureResult>;
  /** Drops this container's cached copies of the erased sites. */
  purgeCaches: (scope: ErasureScope) => Promise<void>;
}

export type EraseCompanyOutcome =
  | { status: 'already_processed' }
  | { status: 'erased'; servedHere: boolean; scope: ErasureScope; publicRows: PublicErasureResult; commerce: CommerceErasureResult };

/** Invalidate every cached resolution and copy of the scope's sites in this container. Throws on failure. */
export async function purgeErasedSiteCaches(scope: ErasureScope): Promise<void> {
  for (const subdomain of scope.subdomains) revalidateSiteCache(subdomain);
  for (const hostname of scope.hostnames) revalidateCustomHostCache(hostname);
  for (const siteId of scope.siteIds) forgetSite(siteId);
  await purgeCachedSiteFiles([...scope.subdomains.map(siteCacheTag), ...scope.hostnames.map(customHostCacheTag)]);
}

export function productionDeps(): EraseCompanyDeps {
  return {
    prisma: getPrismaClient(),
    eraseCommerce: (scope) => {
      const ownerUrl = process.env.COMMERCE_OWNER_DATABASE_URL;
      if (!ownerUrl) throw new Error('COMMERCE_OWNER_DATABASE_URL is not set: the tenant schemas cannot be erased');
      return eraseCompanyCommerce(ownerUrl, scope);
    },
    purgeCaches: async (scope) => {
      await purgeErasedSiteCaches(scope);
      setTimeout(() => {
        purgeErasedSiteCaches(scope).catch((err) =>
          console.error(`[erasure] late cache invalidation failed: ${err instanceof Error ? err.name : 'unknown error'}`),
        );
      }, LATE_INVALIDATION_MS).unref?.();
    },
  };
}

/** Run one company erasure delivery. */
export async function eraseCompany(erasure: CompanyErasure, deps: EraseCompanyDeps = productionDeps()): Promise<EraseCompanyOutcome> {
  const { prisma } = deps;
  // Creating an empty row is safe under simultaneous first deliveries. The row lock below owns all
  // subsequent scope changes and verifies company identity before acknowledging a completed event.
  await prisma.erasureEvent.createMany({
    data: [{ id: erasure.eventId, kind: 'tenant.erased', tenantId: erasure.companyId }], skipDuplicates: true,
  });
  const prepared = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT event_id FROM public.erasure_events WHERE event_id = ${erasure.eventId} FOR UPDATE`;
    const existing = await tx.erasureEvent.findUniqueOrThrow({ where: { id: erasure.eventId } });
    if (existing.tenantId !== erasure.companyId) throw new Error('erasure event was received for another company');
    if (existing.processedAt) return null;
    const found = await findErasureScope(tx, erasure.companyId, erasure.workspaceIds);
    const scope = mergeScope(parseScope(existing.scope), found);
    const updated = await tx.erasureEvent.updateMany({
      where: { id: erasure.eventId, processedAt: null },
      data: { scope: { ...scope }, attempts: { increment: 1 } },
    });
    return updated.count ? scope : null;
  }, PUBLIC_ERASURE_TRANSACTION);
  if (!prepared) return { status: 'already_processed' };

  const erasedPublic = await eraseCompanyPublic(prisma, prepared, erasure.eventId);
  if (!erasedPublic) return { status: 'already_processed' };
  const { scope, rows: publicRows } = erasedPublic;
  await deps.purgeCaches(scope);
  const commerce = await deps.eraseCommerce({ companyId: erasure.companyId, workspaceIds: scope.workspaceIds, siteIds: scope.siteIds });

  await prisma.erasureEvent.updateMany({
    where: { id: erasure.eventId, processedAt: null },
    data: { processedAt: new Date(), scope: { siteIds: scope.siteIds, workspaceIds: scope.workspaceIds } },
  });
  const commerceRows = Object.values(commerce.deleted).reduce((a, b) => a + b, 0);
  // A company this app never served deletes nothing anywhere: still a success (auth-brain must not wedge).
  const servedHere = scope.siteIds.length > 0 || Object.values(publicRows).some((n) => n > 0) || commerceRows > 0;
  return { status: 'erased', servedHere, scope, publicRows, commerce };
}
