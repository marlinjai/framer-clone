import 'server-only';

// src/server/customCode/authoring.ts
//
// Writing a sandboxed custom code block (plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// slice C4, decisions D99 to D112). The one way code and its declaration enter the database:
// the guarded route calls writeCustomCodeBlob after its session and permission checks.
//
// One transaction per write, serialised per site by a lock on the site row (D104), in which:
//   1. the site is read under the lock: a branch (D100) or a site whose custom code is off is refused;
//   2. a hash on the takedown list, or blocked on any site, is refused (D3, D32);
//   3. the node is looked up in the STORED working copy of the page the request names, and its
//      declaration checked against the states in reach of it there (D108);
//   4. the same code already stored for the site is answered as it is, nothing written (D105);
//   5. the site's writes of the last hour (D106) and its live code (D107) are counted;
//   6. the blob and its `blob-write` audit line are written.
// Every refusal comes back as a CustomCodeRefusal with its reason; nothing is swallowed, and an
// unexpected database error is thrown to the route, which answers 500.
//
// Never logs or returns the code. The audit line holds ids and sizes only (D3).

import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import {
  BOX_LIMITS,
  BOX_SHA256_PATTERN,
  canonicalDeclarationJson,
  customCodeHash,
  parseDeclaration,
  utf8ByteLength,
  type CustomCodeDeclaration,
} from '@/lib/customCode/contract';
import { hasCustomCode, parseCustomCode } from '@/lib/customCode/customCode';
import { REVISIONS_KEPT } from '@/server/sites/repository';
import {
  CUSTOM_CODE_WRITES_PER_HOUR,
  declarationStateRefusal,
  refusal,
  sizeInWords,
  type CheckedCustomCode,
  type CustomCodeRefusal,
  type StateInReach,
} from '@/lib/customCode/authoring';
import { statesInReach } from '@/lib/behaviour/authoring';
import type { BehaviourNode } from '@/lib/behaviour/format';

export interface CustomCodeWriteInput {
  siteId: string;
  workspaceId: string;
  tenantGroupId: string;
  /** The auth-brain user writing it. */
  actor: string;
  pageId: string;
  nodeId: string;
  code: CheckedCustomCode;
  /** The hash the node named before, when it named one: left out of the budget unless a kept revision names it (D107). */
  replaces?: string;
}

export type CustomCodeWriteResult =
  | { ok: true; sha256: string; created: boolean }
  | { ok: false; refusal: CustomCodeRefusal }
  | { ok: false; notFound: true };

const HOUR_MS = 60 * 60 * 1000;

type Tx = Prisma.TransactionClient;

interface SiteRow {
  custom_code_enabled: boolean;
  branch_of_site_id: string | null;
  components: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The trees of a stored page snapshot: its tree, then every canvas node (floating elements). */
function rootsOfSnapshot(snapshot: unknown): BehaviourNode[] {
  if (!isRecord(snapshot)) return [];
  const roots: BehaviourNode[] = [];
  if (isRecord(snapshot.appComponentTree)) roots.push(snapshot.appComponentTree as BehaviourNode);
  if (isRecord(snapshot.canvasNodes)) {
    for (const node of Object.values(snapshot.canvasNodes)) if (isRecord(node)) roots.push(node as BehaviourNode);
  }
  return roots;
}

/** The node with this id in the trees, or null. Iterative, so a deep stored tree cannot overflow the stack. */
function findNode(roots: readonly BehaviourNode[], nodeId: string): BehaviourNode | null {
  const stack: unknown[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node)) continue;
    if (node.id === nodeId) return node as BehaviourNode;
    if (Array.isArray(node.children)) for (const child of node.children) stack.push(child);
  }
  return null;
}

/** The stored page the request names: a page of the site, or the page of one of its component definitions. */
async function storedPageRoots(tx: Tx, siteId: string, pageId: string, components: unknown): Promise<BehaviourNode[] | null> {
  const rows = await tx.$queryRaw<{ snapshot: unknown }[]>`
    SELECT p.snapshot FROM public.site_pages p WHERE p.site_id = ${siteId} AND p.page_id = ${pageId} LIMIT 1`;
  if (rows.length > 0) return rootsOfSnapshot(rows[0].snapshot);
  if (isRecord(components)) {
    for (const definition of Object.values(components)) {
      if (isRecord(definition) && isRecord(definition.page) && definition.page.id === pageId) return rootsOfSnapshot(definition.page);
    }
  }
  return null;
}

/** The hashes named by the stored working copy (pages and component definitions) and by the kept revisions. */
async function namedHashes(tx: Tx, siteId: string): Promise<{ workingCopy: Map<string, number>; revisions: Set<string> }> {
  // `$.**` reaches every depth of the stored JSON; the hash is checked for its shape below, so
  // anything else stored under a key of that name is ignored.
  const rows = await tx.$queryRaw<{ origin: string; sha256: unknown }[]>`
    SELECT 'w' AS origin, pg_catalog.jsonb_path_query(p.snapshot, 'lax $.**.customCode.sha256') #>> '{}' AS sha256
      FROM public.site_pages p WHERE p.site_id = ${siteId}
    UNION ALL
    SELECT 'w', pg_catalog.jsonb_path_query(s.components, 'lax $.**.customCode.sha256') #>> '{}'
      FROM public.sites s WHERE s.id = ${siteId}
    UNION ALL
    SELECT 'r', pg_catalog.jsonb_path_query(r.document, 'lax $.**.customCode.sha256') #>> '{}'
      FROM public.site_revisions r WHERE r.site_id = ${siteId}`;
  // The working copy's hashes with how many nodes name each: a hash two blocks name still counts when one is replaced.
  const workingCopy = new Map<string, number>();
  const revisions = new Set<string>();
  for (const row of rows) {
    if (typeof row.sha256 !== 'string' || !BOX_SHA256_PATTERN.test(row.sha256)) continue;
    if (row.origin === 'r') revisions.add(row.sha256);
    else workingCopy.set(row.sha256, (workingCopy.get(row.sha256) ?? 0) + 1);
  }
  return { workingCopy, revisions };
}

/** Bytes a stored blob counts against the site budget: its code and its canonical declaration, as at its write. */
function storedBlobBytes(documentBytes: number, declaration: unknown): number {
  const parsed = parseDeclaration(declaration);
  const declarationBytes = parsed.ok ? utf8ByteLength(canonicalDeclarationJson(parsed.declaration)) : utf8ByteLength(JSON.stringify(declaration ?? null));
  return documentBytes + declarationBytes;
}

/** What the site's live code comes to (D107): blobs named by the working copy or a kept revision, not blocked. */
export async function liveCustomCodeBytes(tx: Tx, siteId: string, replaces?: string): Promise<number> {
  const { workingCopy, revisions } = await namedHashes(tx, siteId);
  const counted = new Set<string>([...workingCopy.keys(), ...revisions]);
  // The block being replaced stops counting once the save that names the new hash lands, unless a kept revision or
  // another node of the working copy still names it. The caller has checked that the node names `replaces`.
  if (replaces && !revisions.has(replaces) && (workingCopy.get(replaces) ?? 0) <= 1) counted.delete(replaces);
  if (counted.size === 0) return 0;
  const hashes = [...counted];
  const rows = await tx.$queryRaw<{ sha256: string; document_bytes: number; declaration: unknown }[]>`
    SELECT b.sha256, pg_catalog.octet_length(b.document)::int AS document_bytes, b.declaration
      FROM public.custom_code_blobs b
     WHERE b.site_id = ${siteId} AND b.blocked_at IS NULL AND b.sha256 = ANY(${hashes}::text[])`;
  return rows.reduce((sum, row) => sum + storedBlobBytes(Number(row.document_bytes), row.declaration), 0);
}

/** "1 minute", "50 minutes": the wait a refusal names, never less than a minute. */
function minutesInWords(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** The states in reach of a stored node, as the declaration check reads them. */
function reachOf(roots: readonly BehaviourNode[], nodeId: string): StateInReach[] {
  return statesInReach(roots, nodeId).map(({ state }) => ({ id: state.id, name: state.name, type: state.type }));
}

/**
 * Writes one block's code for a site, or says why not. The hash is computed before the
 * transaction (it covers code and declaration, D4); everything that depends on the database
 * is read inside it, under the site's lock.
 */
export async function writeCustomCodeBlob(
  input: CustomCodeWriteInput,
  prisma: Pick<PrismaClient, '$transaction'> = getPrismaClient(),
  now: () => Date = () => new Date(),
): Promise<CustomCodeWriteResult> {
  const { code } = input;
  const sha256 = await customCodeHash(code.document, code.declaration);
  const declaration: CustomCodeDeclaration = code.declaration;

  return prisma.$transaction(
    async (tx) => {
      // D104: the first statement, so every later read sees what an earlier write of this site committed.
      const sites = await tx.$queryRaw<SiteRow[]>`
        SELECT s.custom_code_enabled, s.branch_of_site_id, s.components
          FROM public.sites s
         WHERE s.id = ${input.siteId} AND s.workspace_id = ${input.workspaceId} AND s.tenant_group_id = ${input.tenantGroupId}
           FOR NO KEY UPDATE`;
      if (sites.length === 0) return { ok: false, notFound: true } as const;
      const site = sites[0];
      if (site.branch_of_site_id !== null) {
        return { ok: false, refusal: refusal('branch_site', 'Custom code is written on the main site, not on a branch. Open the main site to add or change this block.') } as const;
      }
      if (!site.custom_code_enabled) {
        return { ok: false, refusal: refusal('custom_code_off', 'Custom code is not switched on for this site. An admin switches it on in Site settings first.') } as const;
      }

      const blocked = await tx.$queryRaw<{ found: number }[]>`
        SELECT 1 AS found FROM public.custom_code_blocked_hashes h WHERE h.sha256 = ${sha256}
        UNION ALL
        SELECT 1 FROM public.custom_code_blobs b WHERE b.sha256 = ${sha256} AND b.blocked_at IS NOT NULL
        LIMIT 1`;
      if (blocked.length > 0) {
        return { ok: false, refusal: refusal('blocked', 'This code was taken down by Lumitra and cannot be saved again. Write different code, or contact support if you think this is a mistake.') } as const;
      }

      // D108: the node and the states in reach of it, as the server holds them.
      const roots = await storedPageRoots(tx, input.siteId, input.pageId, site.components);
      const node = roots ? findNode(roots, input.nodeId) : null;
      if (!roots || !node) {
        return { ok: false, refusal: refusal('node_not_saved', 'This block is not saved on the page yet. Wait until the page shows Saved, then save the code again.') } as const;
      }
      if (!hasCustomCode(node.props)) {
        return { ok: false, refusal: refusal('not_a_block', 'The element saved on the page is not a custom code block. Add a block from the Components panel and save the code there.') } as const;
      }
      // `replaces` is the hash this very node names in the stored page, or nothing: it lowers the budget count and
      // goes into the audit, so it is never taken on the request's word.
      if (input.replaces !== undefined) {
        const stored = parseCustomCode((node.props as Record<string, unknown>).customCode);
        const named = stored.ok && stored.value.kind === 'block' ? stored.value.sha256 : null;
        if (named !== input.replaces) {
          return {
            ok: false,
            refusal: refusal('replaces_mismatch', 'The saved page names other code for this block than the request replaces. Reload the editor so it shows the block as saved, then save the code again.'),
          } as const;
        }
      }
      const stateProblem = declarationStateRefusal(declaration, reachOf(roots, input.nodeId));
      if (stateProblem) return { ok: false, refusal: stateProblem } as const;

      // D105: the same code is not a new write.
      const existing = await tx.customCodeBlob.findUnique({
        where: { siteId_sha256: { siteId: input.siteId, sha256 } },
        select: { sha256: true },
      });
      if (existing) return { ok: true, sha256, created: false } as const;

      // D106: thirty writes an hour, counted from the audit table under the lock.
      const at = now();
      const since = new Date(at.getTime() - HOUR_MS);
      const recent = await tx.customCodeAudit.findMany({
        where: { siteId: input.siteId, action: 'blob-write', createdAt: { gt: since } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      if (recent.length >= CUSTOM_CODE_WRITES_PER_HOUR) {
        const freesAt = recent[recent.length - CUSTOM_CODE_WRITES_PER_HOUR].createdAt.getTime() + HOUR_MS;
        const retryAfterSeconds = Math.max(1, Math.ceil((freesAt - at.getTime()) / 1000));
        return {
          ok: false,
          refusal: refusal(
            'rate_limited',
            `This site saved new code ${CUSTOM_CODE_WRITES_PER_HOUR} times in the last hour, the most allowed. Try again in ${minutesInWords(retryAfterSeconds)}.`,
            { retryAfterSeconds },
          ),
        } as const;
      }

      // D107: the site's live code plus this block.
      const used = await liveCustomCodeBytes(tx, input.siteId, input.replaces);
      if (used + code.bytes > BOX_LIMITS.siteBytes) {
        return {
          ok: false,
          refusal: refusal(
            'site_budget',
            `This site's saved page and its last ${REVISIONS_KEPT} published versions hold ${sizeInWords(used)} of code, and this block adds ${sizeInWords(code.bytes)}; a site holds at most ${sizeInWords(BOX_LIMITS.siteBytes)}. Make the code smaller. A block removed from the page stops counting once the page is saved if it was never published, and otherwise only once none of the last ${REVISIONS_KEPT} published versions holds it.`,
          ),
        } as const;
      }

      const written = await tx.customCodeBlob.createMany({
        data: [{
          siteId: input.siteId,
          sha256,
          document: code.document,
          declaration: JSON.parse(canonicalDeclarationJson(declaration)) as Prisma.InputJsonValue,
          title: code.title,
          createdBy: input.actor,
          createdAt: at,
        }],
        skipDuplicates: true,
      });
      if (written.count === 0) return { ok: true, sha256, created: false } as const;
      await tx.customCodeAudit.create({
        data: {
          siteId: input.siteId,
          workspaceId: input.workspaceId,
          tenantGroupId: input.tenantGroupId,
          actor: input.actor,
          action: 'blob-write',
          sha256,
          // Ids and a size only, never code (D3).
          detail: {
            pageId: input.pageId,
            nodeId: input.nodeId,
            bytes: code.bytes,
            ...(input.replaces ? { replaces: input.replaces } : {}),
          },
          createdAt: at,
        },
      });
      return { ok: true, sha256, created: true } as const;
    },
    { maxWait: 5_000, timeout: 15_000 },
  );
}

/** What the editor reads about the site's custom code (the route's status read). */
export interface CustomCodeSiteStatus {
  enabled: boolean;
  branch: boolean;
  usedBytes: number;
}

export async function readCustomCodeStatus(
  site: { siteId: string; workspaceId: string; tenantGroupId: string },
  prisma: Pick<PrismaClient, '$transaction'> = getPrismaClient(),
): Promise<CustomCodeSiteStatus | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ custom_code_enabled: boolean; branch_of_site_id: string | null }[]>`
      SELECT s.custom_code_enabled, s.branch_of_site_id FROM public.sites s
       WHERE s.id = ${site.siteId} AND s.workspace_id = ${site.workspaceId} AND s.tenant_group_id = ${site.tenantGroupId}`;
    if (rows.length === 0) return null;
    return {
      enabled: rows[0].custom_code_enabled,
      branch: rows[0].branch_of_site_id !== null,
      usedBytes: await liveCustomCodeBytes(tx, site.siteId),
    };
  });
}

/** One stored blob of the site, for the panel: its code, declaration and title. Null when this site holds no such hash. */
export async function readCustomCodeBlob(
  site: { siteId: string; workspaceId: string },
  sha256: string,
  prisma: Pick<PrismaClient, 'customCodeBlob' | 'customCodeBlockedHash'> = getPrismaClient(),
): Promise<{ sha256: string; title: string; document: string; declaration: CustomCodeDeclaration | null; createdAt: string; blocked: boolean } | null> {
  if (!BOX_SHA256_PATTERN.test(sha256)) return null;
  const [row, listed] = await Promise.all([prisma.customCodeBlob.findFirst({
    // Keyed by the site and its workspace: another site's hash, or a site of another workspace, finds nothing.
    where: { siteId: site.siteId, sha256, site: { workspaceId: site.workspaceId } },
    select: { sha256: true, title: true, document: true, declaration: true, createdAt: true, blockedAt: true },
  }), prisma.customCodeBlockedHash.findUnique({ where: { sha256 }, select: { sha256: true } })]);
  if (!row) return null;
  const parsed = parseDeclaration(row.declaration);
  return {
    sha256: row.sha256,
    title: row.title,
    document: row.document,
    declaration: parsed.ok ? parsed.declaration : null,
    createdAt: row.createdAt.toISOString(),
    // Taken down on this row, or on the list that outlives every row (D32).
    blocked: row.blockedAt !== null || listed !== null,
  };
}
