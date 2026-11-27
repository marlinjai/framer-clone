import 'server-only';

// src/server/customCode/takedown.ts
//
// The operator's takedown of sandboxed custom code (plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// "Abuse handling" steps 1 and 2, decisions D116 to D119). Called only by POST /api/internal/custom-code/block,
// after its operator token check. Three actions:
//
//   - block a hash: the takedown list (D32) gets the hash, every site's row of it gets `blocked_at`, and each
//     site whose row this newly blocked gets a `blob-block` audit line. The list is what decides: the box,
//     the published page and the guarded write all read it, so a row written after this commits (a write on
//     another site that read the list just before) is still refused service and refused writing again.
//   - unblock a hash: the reverse, for a takedown made in error. The hash leaves the list, every row loses
//     `blocked_at`, and each site whose row this unblocked gets a `blob-unblock` line.
//   - disable a site: `custom_code_enabled` goes false and a `disable` line records the operator's reason,
//     which the site's editors read (readCustomCodeStatus). Written on every call, also when the switch was
//     already off, because the reason is what the owner is told. While it stands, the site's own enable step
//     (slice C7) must refuse to switch the site on (readOperatorDisable is the one reading of "it stands").
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
}

export type SiteDisableResult =
  | { ok: true; siteId: string; wasEnabled: boolean }
  | { ok: false; reason: 'not_found' | 'branch_site' };

export type SiteLiftResult =
  | { ok: true; siteId: string; lifted: boolean }
  | { ok: false; reason: 'not_found' | 'branch_site' };

const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;

/** Locks, in id order, every site holding a row of this hash, and returns their ids and tenancy. */
async function lockHolders(tx: Tx, sha256: string): Promise<{ id: string; workspace_id: string; tenant_group_id: string }[]> {
  return tx.$queryRaw<{ id: string; workspace_id: string; tenant_group_id: string }[]>`
    SELECT s.id, s.workspace_id, s.tenant_group_id
      FROM public.sites s
     WHERE s.id IN (SELECT b.site_id FROM public.custom_code_blobs b WHERE b.sha256 = ${sha256})
     ORDER BY s.id
       FOR NO KEY UPDATE OF s`;
}

export async function blockCustomCodeHash(
  sha256: string,
  actor: TakedownActor,
  prisma: Pick<PrismaClient, '$transaction'> = getPrismaClient(),
  now: () => Date = () => new Date(),
): Promise<HashTakedownResult> {
  return prisma.$transaction(async (tx) => {
    const at = now();
    // The list first: from here on nothing serves or writes this hash anywhere, whatever the rows say.
    const listed = await tx.customCodeBlockedHash.createMany({
      data: [{ sha256, blockedAt: at, blockedBy: actor.label, reason: actor.reason }],
      skipDuplicates: true,
    });
    const holders = await lockHolders(tx, sha256);
    const sites: string[] = [];
    for (const site of holders) {
      // Only a row not blocked yet: a repeated call keeps the first time and writes no second audit line.
      const changed = await tx.customCodeBlob.updateMany({ where: { siteId: site.id, sha256, blockedAt: null }, data: { blockedAt: at } });
      if (changed.count === 0) continue;
      sites.push(site.id);
      await tx.customCodeAudit.create({
        data: {
          siteId: site.id,
          workspaceId: site.workspace_id,
          tenantGroupId: site.tenant_group_id,
          actor: actor.label,
          action: 'blob-block',
          sha256,
          detail: { reason: actor.reason },
          createdAt: at,
        },
      });
    }
    return { sha256, listChanged: listed.count > 0, sites };
  }, TX_OPTIONS);
}

export async function unblockCustomCodeHash(
  sha256: string,
  actor: TakedownActor,
  prisma: Pick<PrismaClient, '$transaction'> = getPrismaClient(),
  now: () => Date = () => new Date(),
): Promise<HashTakedownResult> {
  return prisma.$transaction(async (tx) => {
    const at = now();
    const holders = await lockHolders(tx, sha256);
    const unlisted = await tx.customCodeBlockedHash.deleteMany({ where: { sha256 } });
    const sites: string[] = [];
    for (const site of holders) {
      const changed = await tx.customCodeBlob.updateMany({ where: { siteId: site.id, sha256, blockedAt: { not: null } }, data: { blockedAt: null } });
      if (changed.count === 0) continue;
      sites.push(site.id);
      await tx.customCodeAudit.create({
        data: {
          siteId: site.id,
          workspaceId: site.workspace_id,
          tenantGroupId: site.tenant_group_id,
          actor: actor.label,
          action: 'blob-unblock',
          sha256,
          detail: { reason: actor.reason },
          createdAt: at,
        },
      });
    }
    return { sha256, listChanged: unlisted.count > 0, sites };
  }, TX_OPTIONS);
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
        createdAt: now(),
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
        createdAt: now(),
      },
    });
    return { ok: true, siteId: site.id, lifted: true } as const;
  }, TX_OPTIONS);
}

/**
 * Why Lumitra switched this site's custom code off, when the latest switch change was an operator's disable that
 * was not lifted; null when the switch was last changed by the site's own people, by a lift, or never. Read with
 * the site's status, and the one reading the enable step of slice C7 must refuse on.
 */
export async function readOperatorDisable(tx: Pick<Tx, 'customCodeAudit'>, siteId: string): Promise<{ reason: string; at: string } | null> {
  const last = await tx.customCodeAudit.findFirst({
    where: { siteId, action: { in: ['enable', 'disable'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { action: true, actor: true, detail: true, createdAt: true },
  });
  if (!last || last.action !== 'disable' || !OPERATOR_LABEL_PATTERN.test(last.actor)) return null;
  const detail = last.detail && typeof last.detail === 'object' && !Array.isArray(last.detail) ? (last.detail as Record<string, unknown>) : {};
  if (detail.lifted === true) return null;
  return { reason: typeof detail.reason === 'string' ? detail.reason : '', at: last.createdAt.toISOString() };
}
