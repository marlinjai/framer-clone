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
 * Most named hosts kept per site. Reports are unauthenticated, so anyone can
 * invent hosts: this keeps the table bounded, and capping per site keeps junk
 * sent to one site out of the others' numbers. At the cap a new host replaces the
 * site's lowest count, so a flood of one-off hosts only displaces itself and
 * cannot lock a real host out.
 */
export const MAX_ROWS_PER_SITE = 500;

/**
 * Where the count of a replaced row goes, so nothing is lost silently. A row here
 * means a site hit the cap, which is what `pnpm csp:report` warns about.
 */
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
  const named = { siteId, NOT: { blockedHost: OTHER_BLOCKED_HOST } };
  if ((await prisma.cspReportCount.count({ where: named })) >= MAX_ROWS_PER_SITE) {
    await replaceLowestRow(prisma, siteId, now);
  }
  // An upsert, not a create: two first reports for one host can arrive together.
  const key = { siteId, directive, blockedHost };
  await prisma.cspReportCount.upsert({
    where: { siteId_directive_blockedHost: key },
    create: { ...key, firstSeenAt: now, lastSeenAt: now },
    update: { count: { increment: 1 }, lastSeenAt: now },
  });
}

/** Move the site's lowest named row into OTHER_BLOCKED_HOST: on a tie, the one seen longest ago. */
async function replaceLowestRow(prisma: PrismaClient, siteId: string, now: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const lowest = await tx.cspReportCount.findFirst({
      where: { siteId, NOT: { blockedHost: OTHER_BLOCKED_HOST } },
      orderBy: [{ count: 'asc' }, { lastSeenAt: 'asc' }],
    });
    if (!lowest) return;
    const { directive, blockedHost, count } = lowest;
    // A second report at the cap may have taken this row first; count it once.
    const gone = await tx.cspReportCount.deleteMany({ where: { siteId, directive, blockedHost } });
    if (gone.count === 0) return;
    const other = { siteId, directive, blockedHost: OTHER_BLOCKED_HOST };
    await tx.cspReportCount.upsert({
      where: { siteId_directive_blockedHost: other },
      create: { ...other, count, firstSeenAt: now, lastSeenAt: now },
      update: { count: { increment: count }, lastSeenAt: now },
    });
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

/** Stored text made safe for a terminal: a site name is a tenant's, and a host comes from a report. */
const printable = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');

/** The summary as lines of text for the operator command. */
export function formatCspReportSummary(rows: CspReportSummaryRow[]): string[] {
  if (rows.length === 0) return ['No reports stored, which proves nothing.'];
  const capped = rows.filter((row) => row.blockedHost === OTHER_BLOCKED_HOST).flatMap((row) => row.sites);
  const warnings = [...new Set(capped.map((site) => printable(site.name)))].map(
    (name) => `Warning: ${name} reached the cap of ${MAX_ROWS_PER_SITE} hosts, so hosts were replaced and its list is incomplete.`,
  );
  const lines = rows.map((row) => {
    const sites = row.sites.map((site) => `${printable(site.name)} (${site.count})`).join(', ');
    return `${row.count}\t${printable(row.directive)}\t${printable(row.blockedHost)}\tlast ${row.lastSeenAt.toISOString()}\t${sites}`;
  });
  return ['Counts are leads and can be forged: check a host before acting on it.', ...warnings, ...lines];
}
