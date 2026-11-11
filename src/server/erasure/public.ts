import 'server-only';

// src/server/erasure/public.ts
//
// A company erasure in Prisma's `public` schema (plan docs/plans/2026-11-05-company-erasure-consumer.md):
// the company's sites with everything hanging off them, and the rows keyed by its workspaces.
//
// Which sites: `company_id` = the company, OR a workspace auth-brain names for the company. `company_id` is
// NULL on a site created before that column and not opened since, so the workspaces are what finds those.
// NEVER by `tenant_group_id`: a tenant group (organisation) holds several companies.
//
// Which workspaces: the ones auth-brain names, widened by the workspaces the company's sites carry. A
// workspace belongs to exactly one company in auth-brain, so a row keyed by one of them is the company's.
//
// Files: every file of a site lives in this database (site_images.content holds the bytes, the published
// copies are site_revisions rows), so deleting the rows deletes the files. CMS file cells (dt_files) are
// references to an address the editor was given (`file_url`), not bytes stored here; the rows go.

import { Prisma, type PrismaClient } from '@prisma/client';
import { forgetSiteDocuments } from '@/server/sites/liveDocumentCache';
import { endLiveGenerationOfSite } from '@/server/sites/liveGeneration';

/** What an erasure found to delete, kept on the ledger row so a retry still knows it once the rows are gone. */
export interface ErasureScope {
  siteIds: string[];
  workspaceIds: string[];
  subdomains: string[];
  hostnames: string[];
}

export const EMPTY_SCOPE: ErasureScope = { siteIds: [], workspaceIds: [], subdomains: [], hostnames: [] };

const uniq = (values: Iterable<string | null | undefined>) =>
  [...new Set([...values].filter((v): v is string => typeof v === 'string' && v.length > 0))].sort();

/** Union of two scopes. */
export function mergeScope(a: ErasureScope, b: ErasureScope): ErasureScope {
  return {
    siteIds: uniq([...a.siteIds, ...b.siteIds]),
    workspaceIds: uniq([...a.workspaceIds, ...b.workspaceIds]),
    subdomains: uniq([...a.subdomains, ...b.subdomains]),
    hostnames: uniq([...a.hostnames, ...b.hostnames]),
  };
}

/** Read a stored scope; anything unexpected reads as empty. */
export function parseScope(value: unknown): ErasureScope {
  const list = (v: unknown) => (Array.isArray(v) ? uniq(v.filter((x): x is string => typeof x === 'string')) : []);
  const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return { siteIds: list(o.siteIds), workspaceIds: list(o.workspaceIds), subdomains: list(o.subdomains), hostnames: list(o.hostnames) };
}

/** Find the company's sites, their workspaces, subdomains and custom hostnames. */
export async function findErasureScope(
  prisma: PrismaClient | Prisma.TransactionClient,
  companyId: string,
  workspaceIds: readonly string[],
): Promise<ErasureScope> {
  const sites = await prisma.site.findMany({
    where: { OR: [{ companyId }, ...(workspaceIds.length > 0 ? [{ workspaceId: { in: [...workspaceIds] } }] : [])] },
    select: { id: true, workspaceId: true },
  });
  const siteIds = sites.map((s) => s.id);
  const domains =
    siteIds.length === 0
      ? []
      : await prisma.siteDomain.findMany({
          where: { siteId: { in: siteIds } },
          select: { subdomain: true, hostname: true, customHostname: true },
        });
  return {
    siteIds: uniq(siteIds),
    workspaceIds: uniq([...workspaceIds, ...sites.map((s) => s.workspaceId)]),
    subdomains: uniq(domains.map((d) => d.subdomain)),
    hostnames: uniq(domains.flatMap((d) => [d.hostname, d.customHostname])),
  };
}

export interface PublicErasureResult {
  sites: number;
  siteErasures: number;
  siteOperationAudits: number;
  agentRuns: number;
  cmsTables: number;
  cmsRows: number;
}

/** Each committed batch can use the same budget as the owner's site erasure. */
export const PUBLIC_ERASURE_TRANSACTION = { maxWait: 5_000, timeout: 120_000 } as const;
const PUBLIC_BATCH_SIZE = 500;

/** Delete public rows in committed batches, persisting newly discovered hosts before their rows go. */
export async function eraseCompanyPublic(
  prisma: PrismaClient, initialScope: ErasureScope, eventId: string,
): Promise<{ scope: ErasureScope; rows: PublicErasureResult } | null> {
  let scope = initialScope;
  const rows: PublicErasureResult = { sites: 0, siteErasures: 0, siteOperationAudits: 0, agentRuns: 0, cmsTables: 0, cmsRows: 0 };
  for (;;) {
    const batch = await prisma.$transaction(async (tx) => {
      // Serialize scope changes with other deliveries and the final completion write. Re-read after
      // taking the lock, so a late worker cannot restore hostnames on a completed ledger row.
      await tx.$queryRaw`SELECT event_id FROM public.erasure_events WHERE event_id = ${eventId} FOR UPDATE`;
      const event = await tx.erasureEvent.findUniqueOrThrow({ where: { id: eventId } });
      if (event.processedAt) return null;
      let current = mergeScope(parseScope(event.scope), scope);
      const { siteIds, workspaceIds } = current;
      // Main sites first: a site branch goes with its main by the cascade, so its row is never locked before its
      // main's (every other path locks main, then the branch) and its record never outlives its row between
      // batches. A branch is taken on its own only if no main of the scope is left, which the foreign key rules out.
      const mainsToDelete = await tx.site.findMany({
        where: { id: { in: siteIds }, branchOfSiteId: null }, select: { id: true }, take: 25, orderBy: { id: 'asc' },
      });
      const sitesToDelete = mainsToDelete.length > 0
        ? mainsToDelete
        : await tx.site.findMany({ where: { id: { in: siteIds } }, select: { id: true }, take: 25, orderBy: { id: 'asc' } });
      const ids = sitesToDelete.map((site) => site.id);
      if (ids.length) {
        // Domain inserts hold a foreign-key lock on the site. Wait for those writers, then read their
        // committed hosts. New inserts block here and fail once the site deletion commits.
        await tx.$queryRaw`SELECT id FROM public.sites WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
        const domains = await tx.siteDomain.findMany({
          where: { siteId: { in: ids } }, select: { subdomain: true, hostname: true, customHostname: true },
        });
        current = mergeScope(current, {
          ...EMPTY_SCOPE,
          subdomains: uniq(domains.map((domain) => domain.subdomain)),
          hostnames: uniq(domains.flatMap((domain) => [domain.hostname, domain.customHostname])),
        });
      }
      await tx.erasureEvent.updateMany({ where: { id: eventId, processedAt: null }, data: { scope: { ...current } } });

      const auditWhere = { OR: [{ siteId: { in: siteIds } }, { workspaceId: { in: workspaceIds } }] };
      const eraseIds = (await tx.siteErasure.findMany({ where: auditWhere, select: { id: true }, take: PUBLIC_BATCH_SIZE })).map((r) => r.id);
      const siteErasures = await tx.siteErasure.deleteMany({ where: { id: { in: eraseIds } } });
      const auditIds = (await tx.siteOperationAudit.findMany({ where: auditWhere, select: { id: true }, take: PUBLIC_BATCH_SIZE })).map((r) => r.id);
      const siteOperationAudits = await tx.siteOperationAudit.deleteMany({ where: { id: { in: auditIds } } });
      const runIds = (await tx.agentRun.findMany({ where: { workspaceId: { in: workspaceIds } }, select: { id: true }, take: PUBLIC_BATCH_SIZE })).map((r) => r.id);
      const agentRuns = await tx.agentRun.deleteMany({ where: { id: { in: runIds } } });

      // One collection and a bounded set of rows per commit; a retry keeps the work already done.
      const tables = await tx.dtTable.findMany({ where: { workspaceId: { in: workspaceIds } }, select: { id: true }, take: 1 });
      const tableIds = tables.map((t) => t.id);
      const columnIds = (await tx.dtColumn.findMany({ where: { tableId: { in: tableIds } }, select: { id: true } })).map((c) => c.id);
      const rowIds = (await tx.dtRow.findMany({ where: { tableId: { in: tableIds } }, select: { id: true }, take: PUBLIC_BATCH_SIZE })).map((r) => r.id);
      await tx.dtRowSelectValue.deleteMany({ where: { rowId: { in: rowIds } } });
      await tx.dtRelation.deleteMany({ where: { OR: [{ sourceRowId: { in: rowIds } }, { targetRowId: { in: rowIds } }] } });
      await tx.dtFile.deleteMany({ where: { rowId: { in: rowIds } } });
      const cmsRows = await tx.dtRow.deleteMany({ where: { id: { in: rowIds } } });
      let cmsTables = 0;
      if (rowIds.length < PUBLIC_BATCH_SIZE) {
        // Also remove cells pointing at these columns from rows outside the deleted collection.
        await tx.dtRowSelectValue.deleteMany({ where: { columnId: { in: columnIds } } });
        await tx.dtRelation.deleteMany({ where: { sourceColumnId: { in: columnIds } } });
        await tx.dtFile.deleteMany({ where: { columnId: { in: columnIds } } });
        await tx.selectOption.deleteMany({ where: { columnId: { in: columnIds } } });
        cmsTables = (await tx.dtTable.deleteMany({ where: { id: { in: tableIds } } })).count;
      }

      // A main site's branches cascade with it (docs/plans/2026-11-10-site-branches.md) even when they sort into
      // a later batch: named here, so this process forgets their content too.
      const cascadedBranches = await tx.site.findMany({ where: { branchOfSiteId: { in: ids } }, select: { id: true } });
      // Pages, revisions, image bytes, domains, experiments, report counts and branches cascade.
      const sites = await tx.site.deleteMany({ where: { id: { in: ids } } });
      return {
        scope: current,
        deletedSiteIds: [...new Set([...ids, ...cascadedBranches.map((b) => b.id)])],
        rows: { sites: sites.count, siteErasures: siteErasures.count, siteOperationAudits: siteOperationAudits.count,
          agentRuns: agentRuns.count, cmsTables, cmsRows: cmsRows.count },
      };
    }, PUBLIC_ERASURE_TRANSACTION);
    if (!batch) return null;
    // After the commit: what this process still holds of the erased sites' content goes too (the
    // document route's kept copies and a running generation's draft), not only what the database held.
    for (const siteId of batch.deletedSiteIds) {
      forgetSiteDocuments(siteId);
      endLiveGenerationOfSite(siteId, 'site_changed');
    }
    scope = batch.scope;
    for (const key of Object.keys(rows) as (keyof PublicErasureResult)[]) rows[key] += batch.rows[key];
    if (Object.values(batch.rows).every((count) => count === 0)) return { scope, rows };
  }
}
