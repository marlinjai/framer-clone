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

import type { Prisma, PrismaClient } from '@prisma/client';

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
  prisma: PrismaClient,
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

/** Delete the company's public rows in one transaction. Idempotent. */
export async function eraseCompanyPublic(prisma: PrismaClient, scope: ErasureScope): Promise<PublicErasureResult> {
  const { siteIds, workspaceIds } = scope;
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const siteErasures = await tx.siteErasure.deleteMany({
      where: { OR: [{ siteId: { in: siteIds } }, { workspaceId: { in: workspaceIds } }] },
    });
    const siteOperationAudits = await tx.siteOperationAudit.deleteMany({
      where: { OR: [{ siteId: { in: siteIds } }, { workspaceId: { in: workspaceIds } }] },
    });
    // agent_changes cascade from agent_runs.
    const agentRuns = await tx.agentRun.deleteMany({ where: { workspaceId: { in: workspaceIds } } });

    // The CMS (dt_*): only dt_columns and dt_views cascade from dt_tables, so the rest is chased by id.
    const tables = await tx.dtTable.findMany({ where: { workspaceId: { in: workspaceIds } }, select: { id: true } });
    const tableIds = tables.map((t) => t.id);
    const columnIds = (await tx.dtColumn.findMany({ where: { tableId: { in: tableIds } }, select: { id: true } })).map((c) => c.id);
    const rowIds = (await tx.dtRow.findMany({ where: { tableId: { in: tableIds } }, select: { id: true } })).map((r) => r.id);
    await tx.dtRowSelectValue.deleteMany({ where: { OR: [{ rowId: { in: rowIds } }, { columnId: { in: columnIds } }] } });
    await tx.dtRelation.deleteMany({
      where: { OR: [{ sourceRowId: { in: rowIds } }, { targetRowId: { in: rowIds } }, { sourceColumnId: { in: columnIds } }] },
    });
    await tx.dtFile.deleteMany({ where: { OR: [{ rowId: { in: rowIds } }, { columnId: { in: columnIds } }] } });
    await tx.selectOption.deleteMany({ where: { columnId: { in: columnIds } } });
    const cmsRows = await tx.dtRow.deleteMany({ where: { tableId: { in: tableIds } } });
    const cmsTables = await tx.dtTable.deleteMany({ where: { id: { in: tableIds } } });

    // The sites: pages, revisions (the published copies), images (their bytes), domains, experiments and
    // report counts cascade. `sites.published_revision_id` is checked at the end of the statement, so the
    // cascade into the revisions passes.
    const sites = await tx.site.deleteMany({ where: { id: { in: siteIds } } });

    return {
      sites: sites.count,
      siteErasures: siteErasures.count,
      siteOperationAudits: siteOperationAudits.count,
      agentRuns: agentRuns.count,
      cmsTables: cmsTables.count,
      cmsRows: cmsRows.count,
    };
  });
}
