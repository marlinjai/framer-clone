// src/server/sites/cspReportStore.ts
//
// The counts behind the report-only policy of published pages. One row per site,
// directive and blocked host (the CspReportCount model): nothing about a visitor
// is ever written. Takes the Prisma client as an argument and has no `server-only`
// import, so the operator command (scripts/csp-report.ts) can run it under tsx.

import type { PrismaClient } from '@prisma/client';
import type { ReportedDirective } from '@/lib/site/cspReportOnly';

/** The one thing kept from a report (src/server/sites/cspReports.ts). */
export interface CspViolation {
  directive: ReportedDirective;
  blockedHost: string;
}

/**
 * Most rows kept per site, past which a new host counts as OTHER_BLOCKED_HOST.
 * Reports are unauthenticated, so anyone can invent hosts: this keeps the table
 * bounded, and capping per site keeps junk sent to one site out of the others'
 * numbers.
 */
export const MAX_ROWS_PER_SITE = 500;
export const OTHER_BLOCKED_HOST = '(other)';

/** Add one violation to its count. */
export async function recordCspViolation(
  prisma: PrismaClient,
  siteId: string,
  violation: CspViolation,
  now: Date,
): Promise<void> {
  const { directive, blockedHost } = violation;
  const bumped = await prisma.cspReportCount.updateMany({
    where: { siteId, directive, blockedHost },
    data: { count: { increment: 1 }, lastSeenAt: now },
  });
  if (bumped.count > 0) return;
  const rows = await prisma.cspReportCount.count({ where: { siteId } });
  const key = { siteId, directive, blockedHost: rows < MAX_ROWS_PER_SITE ? blockedHost : OTHER_BLOCKED_HOST };
  // An upsert, not a create: the `(other)` row usually exists, and two first
  // reports for one host can arrive together.
  await prisma.cspReportCount.upsert({
    where: { siteId_directive_blockedHost: key },
    create: { ...key, firstSeenAt: now, lastSeenAt: now },
    update: { count: { increment: 1 }, lastSeenAt: now },
  });
}

export interface CspReportSummaryRow {
  directive: string;
  blockedHost: string;
  count: number;
  lastSeenAt: Date;
  /** Which sites load it, most reports first. */
  sites: { siteId: string; name: string; count: number }[];
}

/** The count per directive and blocked host across all sites, highest first. */
export async function readCspReportSummary(prisma: PrismaClient): Promise<CspReportSummaryRow[]> {
  const rows = await prisma.cspReportCount.findMany({
    include: { site: { select: { name: true } } },
    orderBy: { count: 'desc' },
  });
  const summary = new Map<string, CspReportSummaryRow>();
  for (const row of rows) {
    const key = `${row.directive} ${row.blockedHost}`;
    const entry = summary.get(key) ?? {
      directive: row.directive,
      blockedHost: row.blockedHost,
      count: 0,
      lastSeenAt: row.lastSeenAt,
      sites: [],
    };
    entry.count += row.count;
    if (row.lastSeenAt > entry.lastSeenAt) entry.lastSeenAt = row.lastSeenAt;
    entry.sites.push({ siteId: row.siteId, name: row.site.name, count: row.count });
    summary.set(key, entry);
  }
  return [...summary.values()].sort((a, b) => b.count - a.count);
}

/** The summary as lines of text for the operator command. */
export function formatCspReportSummary(rows: CspReportSummaryRow[]): string[] {
  if (rows.length === 0) return ['No reports yet: nothing would have been blocked.'];
  return rows.map((row) => {
    const sites = row.sites.map((site) => `${site.name} (${site.count})`).join(', ');
    return `${row.count}\t${row.directive}\t${row.blockedHost}\tlast ${row.lastSeenAt.toISOString()}\t${sites}`;
  });
}
