import 'server-only';

// src/server/customCode/takedown.ts
//
// The operator's takedown of sandboxed custom code (plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// "Abuse handling" steps 1 and 2, decisions D116 to D119). Called only by POST /api/internal/custom-code/block,
// after its operator token check. Four actions:
//
//   - block a hash: the takedown list (D32) gets the hash, every site's row of it gets `blocked_at`, and each
//     site whose row this newly blocked gets a `blob-block` audit line. The list is what decides: the box,
//     the published page and the guarded write all read it, so a row written after this commits (a write on
//     another site that read the list just before) is still refused service and refused writing again.
//     Rows a personal-data erase rewrote this code into (D115, found through the `blob-erase` lines) are
//     blocked too, on their own site, without listing their hash (D117: the erase never lists, B1).
//   - unblock a hash: the reverse, for a takedown made in error. The hash leaves the list, every row loses
//     `blocked_at`, and each site whose row this unblocked gets a `blob-unblock` line; rewritten rows are
//     unblocked too unless their own hash is taken down. A row the race above left unmarked is marked by
//     simply repeating the block.
//   - disable a site: `custom_code_enabled` goes false and a `disable` line records the operator's reason,
//     which the site's editors read (readCustomCodeStatus). Written on every call, also when the switch was
//     already off, because the reason is what the owner is told. It stands until an operator lifts it, whatever
//     the site's own people write meanwhile; while it stands, the site's own enable step (slice C7) must refuse
//     to switch the site on (readOperatorDisable is the one reading of "it stands").
//   - lift a site's disable: a `disable` line with `lifted: true`. The switch stays off; the site's admin may
//     switch it on again through the enable step, with its consent. The audit's actions are fixed by a CHECK,
//     and lifting is no `enable` (nothing is switched on), so it is written as a disable that says it lifts.
//
// Every action runs in one transaction. The sites concerned are locked FOR NO KEY UPDATE in id order before
// any row changes, the lock the guarded write takes and that a save, a publish and the erase conflict with,
// so pruning (which skips a blocked row) and a write of the same site never interleave with the takedown.
// A blob row only ever lives on a main site (a branch writes no code, D100), so only main rows are locked.
//
// Nothing here reads or returns code. The audit lines and the list hold the operator label (D34), the hash
// and the reason, which must name no person (the route says so; no constraint can hold it).

import type { PrismaClient, Prisma } from '@prisma/client';
import { getPrismaClient } from '@/server/db';

type Tx = Prisma.TransactionClient;

/** D34: `operator`, optionally `operator:<lower-case-words-joined-by-hyphens>`, at most 64 characters. */
export const OPERATOR_LABEL_PATTERN = /^operator(:[a-z]+(-[a-z]+)*)?$/;
export const OPERATOR_LABEL_MAX = 64;
export const TAKEDOWN_REASON_MAX = 500;

export interface TakedownActor {
  /** The operator label (D34), checked by the route. */
  label: string;
  /** Why, for the abuse record and, on a site disable, for the site's editors. Names no person. */
  reason: string;
}

export interface HashTakedownResult {
  sha256: string;
  /** False when the hash was already on the list (an unblock: was not on it); the call changed nothing there. */
  listChanged: boolean;
  /** The sites whose row of this hash this call blocked (or unblocked), in id order. */
  sites: string[];
  /**
   * Rows under another hash that a personal-data erase rewrote this code into (D115 carries a block to them), which
   * this call blocked (or unblocked) too, by site and hash.
   */
  derived: { siteId: string; sha256: string }[];
}

export type SiteDisableResult =
  | { ok: true; siteId: string; wasEnabled: boolean }
  | { ok: false; reason: 'not_found' | 'branch_site' };

export type SiteLiftResult =
  | { ok: true; siteId: string; lifted: boolean }
  | { ok: false; reason: 'not_found' | 'branch_site' };

const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/**
 * At most this many erase lines are walked from one hash (live or not: a chain passes through rows a later erase
 * deleted). Past it the takedown refuses as a whole rather than block or unblock part of a chain silently.
 */
const MAX_CHAIN_LINES = 256;

/** The erase chain from a hash is longer than a takedown follows; nothing was changed. */
export class DerivedChainTooLongError extends Error {
  constructor() {
    super(`more than ${MAX_CHAIN_LINES} personal-data erase lines descend from this hash`);
    this.name = 'DerivedChainTooLongError';
  }
}

interface LockedSite { id: string; workspace_id: string; tenant_group_id: string }

const pairKey = (siteId: string, sha256: string) => `${siteId}:${sha256}`;

/**
 * The rows a personal-data erase rewrote this hash into, followed through later erases ON THE SAME SITE (an erase
 * writes `blob-erase` on its own site under the new hash, with `detail.replaces` naming the old one, D115). The first
 * step may be on any site, because `replaces` is always a hash the erasing site itself held; every later step stays
 * on that site, so another site's identical code, and its own erases, are never reached (second review, R2-2). Only
 * rows that still exist are returned; rows a later erase deleted are walked through, not returned.
 */
async function derivedRows(tx: Tx, sha256: string): Promise<{ siteId: string; sha256: string }[]> {
  const visited = new Set<string>();
  let walked = 0;
  let frontier: { siteId: string | null; sha256: string }[] = [{ siteId: null, sha256 }];
  while (frontier.length > 0) {
    const lines = await tx.customCodeAudit.findMany({
      where: {
        action: 'blob-erase',
        OR: frontier.map((from) => ({
          ...(from.siteId === null ? {} : { siteId: from.siteId }),
          detail: { path: ['replaces'], equals: from.sha256 },
        })),
      },
      select: { siteId: true, sha256: true },
      take: MAX_CHAIN_LINES + 1,
    });
    walked += lines.length;
    if (walked > MAX_CHAIN_LINES) throw new DerivedChainTooLongError();
    const next: { siteId: string; sha256: string }[] = [];
    for (const line of lines) {
      if (!line.sha256 || line.sha256 === sha256) continue;
      const key = pairKey(line.siteId, line.sha256);
      if (visited.has(key)) continue;
      visited.add(key);
      next.push({ siteId: line.siteId, sha256: line.sha256 });
    }
    frontier = next;
  }
  if (visited.size === 0) return [];
  const pairs = [...visited].map((key) => {
    const at = key.indexOf(':');
    return { siteId: key.slice(0, at), sha256: key.slice(at + 1) };
  });
  const existing = await tx.customCodeBlob.findMany({
    where: { OR: pairs.map((pair) => ({ siteId: pair.siteId, sha256: pair.sha256 })) },
    select: { siteId: true, sha256: true },
  });
  const live = new Set(existing.map((row) => pairKey(row.siteId, row.sha256)));
  return pairs.filter((pair) => live.has(pairKey(pair.siteId, pair.sha256)));
}

/**
 * Every hash a row was rewritten FROM on its own site, through all its `blob-erase` lines (a row an erase met may
 * have several parents, R2-1 (b)), excluding `root`. An unblock of `root` leaves the row blocked when any of these is
 * still taken down, because the erase carried that block to it too (R2-1 (a)).
 */
async function ancestorsOnSite(tx: Tx, siteId: string, sha256: string, root: string): Promise<Set<string>> {
  const ancestors = new Set<string>();
  let frontier = [sha256];
  let walked = 0;
  while (frontier.length > 0) {
    const lines = await tx.customCodeAudit.findMany({
      where: { action: 'blob-erase', siteId, sha256: { in: frontier } },
      select: { detail: true },
      take: MAX_CHAIN_LINES + 1,
    });
    walked += lines.length;
    if (walked > MAX_CHAIN_LINES) throw new DerivedChainTooLongError();
    const next: string[] = [];
    for (const line of lines) {
      const from = line.detail && typeof line.detail === 'object' && !Array.isArray(line.detail) ? (line.detail as Record<string, unknown>).replaces : null;
      if (typeof from !== 'string' || from === root || from === sha256 || ancestors.has(from)) continue;
      ancestors.add(from);
      next.push(from);
    }
    frontier = next;
  }
  return ancestors;
}

/** Locks, in id order, every site holding a row of this hash plus the given sites, and returns their tenancy. */
async function lockSites(tx: Tx, sha256: string, also: readonly string[]): Promise<LockedSite[]> {
  return tx.$queryRaw<LockedSite[]>`
    SELECT s.id, s.workspace_id, s.tenant_group_id
      FROM public.sites s
     WHERE s.id IN (SELECT b.site_id FROM public.custom_code_blobs b WHERE b.sha256 = ${sha256})
        OR s.id = ANY(${[...also]}::text[])
     ORDER BY s.id
       FOR NO KEY UPDATE OF s`;
}

async function changeHash(tx: Tx, mode: 'block' | 'unblock', sha256: string, actor: TakedownActor, at: Date): Promise<HashTakedownResult> {
  let listChanged = false;
  if (mode === 'block') {
    // The list first: from here on nothing serves or writes this hash anywhere, whatever the rows say.
    const listed = await tx.customCodeBlockedHash.createMany({
      data: [{ sha256, blockedAt: at, blockedBy: actor.label, reason: actor.reason }],
      skipDuplicates: true,
    });
    listChanged = listed.count > 0;
  }
  const derived = await derivedRows(tx, sha256);
  const locked = await lockSites(tx, sha256, derived.map((row) => row.siteId));
  if (mode === 'unblock') listChanged = (await tx.customCodeBlockedHash.deleteMany({ where: { sha256 } })).count > 0;
  const byId = new Map(locked.map((site) => [site.id, site]));

  const audit = (site: LockedSite, hash: string, follows?: string) =>
    tx.customCodeAudit.create({
      data: {
        siteId: site.id,
        workspaceId: site.workspace_id,
        tenantGroupId: site.tenant_group_id,
        actor: actor.label,
        action: mode === 'block' ? 'blob-block' : 'blob-unblock',
        sha256: hash,
        detail: follows ? { reason: actor.reason, follows } : { reason: actor.reason },
        createdAt: at,
      },
    });

  const sites: string[] = [];
  for (const site of locked) {
    // Only a row whose state changes: a repeated call keeps the first time and writes no second audit line.
    const changed = await tx.customCodeBlob.updateMany({
      where: { siteId: site.id, sha256, blockedAt: mode === 'block' ? null : { not: null } },
      data: { blockedAt: mode === 'block' ? at : null },
    });
    if (changed.count === 0) continue;
    sites.push(site.id);
    await audit(site, sha256);
  }

  const followed: { siteId: string; sha256: string }[] = [];
  for (const row of derived) {
    const site = byId.get(row.siteId);
    if (!site) continue; // The site went between the read and the lock; its rows went with it.
    if (mode === 'unblock') {
      // A rewritten row stays blocked when it is taken down for another reason than this hash: its own hash or any
      // hash it was rewritten from on its site (other than this one) is listed or blocked on some row (the erase
      // carries those blocks too, D115). Erring this way leaves a row blocked; the answer names what it unblocked.
      const others = [row.sha256, ...(await ancestorsOnSite(tx, row.siteId, row.sha256, sha256))];
      const otherBlock = await tx.$queryRaw<{ found: number }[]>`
        SELECT 1 AS found FROM public.custom_code_blocked_hashes h WHERE h.sha256 = ANY(${others}::text[])
        UNION ALL
        SELECT 1 FROM public.custom_code_blobs b
         WHERE b.sha256 = ANY(${others}::text[]) AND b.blocked_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM unnest(${derived.map((d) => d.siteId)}::text[], ${derived.map((d) => d.sha256)}::text[]) AS d(site_id, sha256)
                            WHERE d.site_id = b.site_id AND d.sha256 = b.sha256)
        LIMIT 1`;
      if (otherBlock.length > 0) continue;
    }
    const changed = await tx.customCodeBlob.updateMany({
      where: { siteId: row.siteId, sha256: row.sha256, blockedAt: mode === 'block' ? null : { not: null } },
      data: { blockedAt: mode === 'block' ? at : null },
    });
    if (changed.count === 0) continue;
    followed.push(row);
    await audit(site, row.sha256, sha256);
  }
  followed.sort((x, y) => (x.siteId === y.siteId ? x.sha256.localeCompare(y.sha256) : x.siteId.localeCompare(y.siteId)));
  return { sha256, listChanged, sites, derived: followed };
}

export async function blockCustomCodeHash(
  sha256: string,
  actor: TakedownActor,
  prisma: Pick<PrismaClient, '$transaction'> = getPrismaClient(),
  now: () => Date = () => new Date(),
): Promise<HashTakedownResult> {
  return prisma.$transaction((tx) => changeHash(tx, 'block', sha256, actor, now()), TX_OPTIONS);
}

export async function unblockCustomCodeHash(
  sha256: string,
  actor: TakedownActor,
  prisma: Pick<PrismaClient, '$transaction'> = getPrismaClient(),
  now: () => Date = () => new Date(),
): Promise<HashTakedownResult> {
  return prisma.$transaction((tx) => changeHash(tx, 'unblock', sha256, actor, now()), TX_OPTIONS);
}

export async function disableCustomCodeForSite(
  siteId: string,
  actor: TakedownActor,
  prisma: Pick<PrismaClient, '$transaction'> = getPrismaClient(),
  now: () => Date = () => new Date(),
): Promise<SiteDisableResult> {
  return prisma.$transaction(async (tx) => {
    const site = await lockSiteForSwitch(tx, siteId);
    if (!site) return { ok: false, reason: 'not_found' } as const;
    // A branch's switch is never on and nothing sets it (D30); its blocks follow main's. Refused, so an operator
    // who pasted a branch id is told to take down the main site instead of believing it done.
    if (site.branch_of_site_id !== null) return { ok: false, reason: 'branch_site' } as const;
    if (site.custom_code_enabled) {
      await tx.$executeRaw`UPDATE public.sites SET custom_code_enabled = false WHERE id = ${site.id}`;
    }
    await tx.customCodeAudit.create({
      data: {
        siteId: site.id,
        workspaceId: site.workspace_id,
        tenantGroupId: site.tenant_group_id,
        actor: actor.label,
        action: 'disable',
        detail: { reason: actor.reason },
        createdAt: await operatorLineTime(tx, site.id, now()),
      },
    });
    return { ok: true, siteId: site.id, wasEnabled: site.custom_code_enabled } as const;
  }, TX_OPTIONS);
}

/** Locks one site row by id for a switch change; null when no site has the id. */
async function lockSiteForSwitch(tx: Tx, siteId: string) {
  const rows = await tx.$queryRaw<{ id: string; workspace_id: string; tenant_group_id: string; custom_code_enabled: boolean; branch_of_site_id: string | null }[]>`
    SELECT s.id, s.workspace_id, s.tenant_group_id, s.custom_code_enabled, s.branch_of_site_id
      FROM public.sites s
     WHERE s.id = ${siteId}
       FOR NO KEY UPDATE`;
  return rows[0] ?? null;
}

export async function liftCustomCodeDisable(
  siteId: string,
  actor: TakedownActor,
  prisma: Pick<PrismaClient, '$transaction'> = getPrismaClient(),
  now: () => Date = () => new Date(),
): Promise<SiteLiftResult> {
  return prisma.$transaction(async (tx) => {
    const site = await lockSiteForSwitch(tx, siteId);
    if (!site) return { ok: false, reason: 'not_found' } as const;
    if (site.branch_of_site_id !== null) return { ok: false, reason: 'branch_site' } as const;
    // Nothing to lift: no line is written, so a repeated call adds nothing.
    if (!(await readOperatorDisable(tx, site.id))) return { ok: true, siteId: site.id, lifted: false } as const;
    await tx.customCodeAudit.create({
      data: {
        siteId: site.id,
        workspaceId: site.workspace_id,
        tenantGroupId: site.tenant_group_id,
        actor: actor.label,
        action: 'disable',
        detail: { reason: actor.reason, lifted: true },
        createdAt: await operatorLineTime(tx, site.id, now()),
      },
    });
    return { ok: true, siteId: site.id, lifted: true } as const;
  }, TX_OPTIONS);
}

/** The latest switch line an operator wrote for the site, or null. Lines by the site's own people are skipped. */
async function lastOperatorSwitchLine(tx: Pick<Tx, 'customCodeAudit'>, siteId: string) {
  const lines = await tx.customCodeAudit.findMany({
    where: { siteId, action: { in: ['enable', 'disable'] }, actor: { startsWith: 'operator' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { action: true, actor: true, detail: true, createdAt: true },
    take: 20,
  });
  return lines.find((line) => OPERATOR_LABEL_PATTERN.test(line.actor)) ?? null;
}

/**
 * The time an operator's switch line is written with: now, or one millisecond after the site's latest operator
 * line when that one is not older (a clock step back, or two calls in one millisecond), so the order of the
 * operator's own lines is always the order they were written in, and a lift never sorts before its disable.
 */
async function operatorLineTime(tx: Pick<Tx, 'customCodeAudit'>, siteId: string, now: Date): Promise<Date> {
  const last = await lastOperatorSwitchLine(tx, siteId);
  return last && last.createdAt.getTime() >= now.getTime() ? new Date(last.createdAt.getTime() + 1) : now;
}

/**
 * Why Lumitra switched this site's custom code off: set while the latest switch line WRITTEN BY AN OPERATOR is a
 * `disable` that does not say it lifts. Lines by the site's own people never clear it (a stale "switch off" press
 * must not end a takedown), so only `lift-site` does. Null when no operator disable stands. Read with the site's
 * status, and the one reading the enable step of slice C7 must refuse on.
 */
export async function readOperatorDisable(tx: Pick<Tx, 'customCodeAudit'>, siteId: string): Promise<{ reason: string; at: string } | null> {
  const last = await lastOperatorSwitchLine(tx, siteId);
  if (!last || last.action !== 'disable') return null;
  const detail = last.detail && typeof last.detail === 'object' && !Array.isArray(last.detail) ? (last.detail as Record<string, unknown>) : {};
  if (detail.lifted === true) return null;
  return { reason: typeof detail.reason === 'string' ? detail.reason : '', at: last.createdAt.toISOString() };
}
