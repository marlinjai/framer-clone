import 'server-only';

// src/server/customCode/named.ts
//
// Which custom code a site still names, and what that keeps alive (plan
// docs/plans/2026-11-02-sandboxed-custom-code.md, D4, D107, and slice C5's D113 to D116).
//
// One reading of "named", shared by everything that counts or deletes blobs: the site budget of
// the guarded write (C4, D107), the budget at save and publish, and pruning (D4). Two copies of it
// would disagree, and pruning is the one that deletes.
//
// A blob of site S is named while any of these holds its hash under a `customCode.sha256` key, at
// any depth:
//   - S's working copy: its page rows and its component definitions (`workingCopy`, with how many
//     times each hash is named, for the `replaces` rule of D107);
//   - the working copy of every branch of S (a branch is its own `sites` row whose pages copy S's
//     blocks, keyed by S's id, D100), and every branch record's base copy, merge draft and the copy
//     of S kept for "Undo this merge" (`branches`);
//   - S's kept published revisions (`revisions`).
// The hash is checked for its shape here, so anything else stored under that key is ignored.
//
// Never reads or returns code. Called inside the caller's transaction.

import type { Prisma } from '@prisma/client';
import { BOX_LIMITS, BOX_SHA256_PATTERN, canonicalDeclarationJson, parseDeclaration, utf8ByteLength } from '@/lib/customCode/contract';

type Tx = Prisma.TransactionClient;

/** Unnamed blobs younger than this are kept: an editor tab may have written one and not saved yet (D4). */
export const UNNAMED_BLOB_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface NamedHashes {
  /** The site's own working copy: each hash with the number of nodes naming it. */
  workingCopy: Map<string, number>;
  /** The site's branches: their working copies and the copies their records keep. */
  branches: Set<string>;
  /** The working copy of each branch row by its id, so a save of one branch can tell what others name. */
  branchCopies: Map<string, Set<string>>;
  /** The copies the branch records keep: base copy, merge draft, the copy for "Undo this merge". */
  branchRecords: Set<string>;
  /** The site's kept published revisions. */
  revisions: Set<string>;
}

function shaped(value: unknown): value is string {
  return typeof value === 'string' && BOX_SHA256_PATTERN.test(value);
}

/** Every hash a site's working copy names (its own pages and components only), with how many nodes name each. */
export async function workingCopyHashes(tx: Tx, siteId: string): Promise<Map<string, number>> {
  const rows = await tx.$queryRaw<{ sha256: unknown }[]>`
    SELECT pg_catalog.jsonb_path_query(p.snapshot, 'lax $.**.customCode.sha256') #>> '{}' AS sha256
      FROM public.site_pages p WHERE p.site_id = ${siteId}
    UNION ALL
    SELECT pg_catalog.jsonb_path_query(s.components, 'lax $.**.customCode.sha256') #>> '{}'
      FROM public.sites s WHERE s.id = ${siteId}`;
  const counts = new Map<string, number>();
  for (const row of rows) if (shaped(row.sha256)) counts.set(row.sha256, (counts.get(row.sha256) ?? 0) + 1);
  return counts;
}

/** Every hash the site's branches name: each branch row's working copy, and the copies the branch records keep. */
async function branchHashes(tx: Tx, siteId: string): Promise<{ all: Set<string>; copies: Map<string, Set<string>>; records: Set<string> }> {
  const rows = await tx.$queryRaw<{ row: string | null; sha256: unknown }[]>`
    SELECT b.id AS row, pg_catalog.jsonb_path_query(p.snapshot, 'lax $.**.customCode.sha256') #>> '{}' AS sha256
      FROM public.site_pages p JOIN public.sites b ON b.id = p.site_id
     WHERE b.branch_of_site_id = ${siteId}
    UNION ALL
    SELECT b.id, pg_catalog.jsonb_path_query(b.components, 'lax $.**.customCode.sha256') #>> '{}'
      FROM public.sites b WHERE b.branch_of_site_id = ${siteId}
    UNION ALL
    SELECT NULL, pg_catalog.jsonb_path_query(pg_catalog.jsonb_build_array(r.base_document, r.merge_draft, r.main_before_document), 'lax $.**.customCode.sha256') #>> '{}'
      FROM public.site_branches r WHERE r.site_id = ${siteId}`;
  const all = new Set<string>();
  const copies = new Map<string, Set<string>>();
  const records = new Set<string>();
  for (const { row, sha256 } of rows) {
    if (!shaped(sha256)) continue;
    all.add(sha256);
    if (row === null) records.add(sha256);
    else copies.set(row, (copies.get(row) ?? new Set<string>()).add(sha256));
  }
  return { all, copies, records };
}

/** Every hash the site's kept published revisions name. */
async function revisionHashes(tx: Tx, siteId: string): Promise<Set<string>> {
  const rows = await tx.$queryRaw<{ sha256: unknown }[]>`
    SELECT pg_catalog.jsonb_path_query(r.document, 'lax $.**.customCode.sha256') #>> '{}' AS sha256
      FROM public.site_revisions r WHERE r.site_id = ${siteId}`;
  return new Set(rows.map((row) => row.sha256).filter(shaped));
}

/** Everything that names a blob of this site (see the head of this file). */
export async function namedHashes(tx: Tx, siteId: string): Promise<NamedHashes> {
  const workingCopy = await workingCopyHashes(tx, siteId);
  const branches = await branchHashes(tx, siteId);
  const revisions = await revisionHashes(tx, siteId);
  return { workingCopy, branches: branches.all, branchCopies: branches.copies, branchRecords: branches.records, revisions };
}

/**
 * Every hash something other than the working copy of `row` names: `row` is the main site's id (its own working
 * copy) or one of its branch rows. What a save of `row` adds beyond this is code the save brings to life (D114).
 */
export function namedOutside(named: NamedHashes, row: string, mainId: string): Set<string> {
  const outside = new Set<string>([...named.revisions, ...named.branchRecords]);
  if (row !== mainId) for (const sha256 of named.workingCopy.keys()) outside.add(sha256);
  for (const [id, copy] of named.branchCopies) if (id !== row) for (const sha256 of copy) outside.add(sha256);
  return outside;
}

/** Every hash in `named`, from all three places. */
export function allNamed(named: NamedHashes): Set<string> {
  return new Set([...named.workingCopy.keys(), ...named.branches, ...named.revisions]);
}

/** Bytes a stored blob counts against the site budget: its code and its canonical declaration, as at its write. */
function storedBlobBytes(documentBytes: number, declaration: unknown): number {
  const parsed = parseDeclaration(declaration);
  const declarationBytes = parsed.ok ? utf8ByteLength(canonicalDeclarationJson(parsed.declaration)) : utf8ByteLength(JSON.stringify(declaration ?? null));
  return documentBytes + declarationBytes;
}

/** What the named, not blocked blobs among `hashes` come to, in bytes (D107). */
export async function bytesOfBlobs(tx: Tx, siteId: string, hashes: ReadonlySet<string>): Promise<number> {
  if (hashes.size === 0) return 0;
  const rows = await tx.$queryRaw<{ document_bytes: number; declaration: unknown }[]>`
    SELECT pg_catalog.octet_length(b.document)::int AS document_bytes, b.declaration
      FROM public.custom_code_blobs b
     WHERE b.site_id = ${siteId} AND b.blocked_at IS NULL AND b.sha256 = ANY(${[...hashes]}::text[])`;
  return rows.reduce((sum, row) => sum + storedBlobBytes(Number(row.document_bytes), row.declaration), 0);
}

/**
 * The site's live code (D107): every blob something names, not blocked. `replaces`, the hash the node being
 * rewritten names (the caller checked it), stops counting when nothing else names it: no kept revision, no branch,
 * no other node of the working copy.
 */
export async function liveCustomCodeBytes(tx: Tx, siteId: string, replaces?: string): Promise<number> {
  const named = await namedHashes(tx, siteId);
  const counted = allNamed(named);
  if (replaces && !named.revisions.has(replaces) && !named.branches.has(replaces) && (named.workingCopy.get(replaces) ?? 0) <= 1) counted.delete(replaces);
  return bytesOfBlobs(tx, siteId, counted);
}

/** Whether the site stores any blob at all: a site without one names no live code and pays nothing more. */
export async function siteHoldsBlobs(tx: Tx, siteId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ found: number }[]>`SELECT 1 AS found FROM public.custom_code_blobs b WHERE b.site_id = ${siteId} LIMIT 1`;
  return rows.length > 0;
}

/**
 * Deletes the site's blobs that nothing names and that are older than the grace period (D4, D113). A blocked blob
 * is never deleted: its row is the site's record that the code was taken down, which the guarded write reads to
 * refuse the same code again (D3). Returns the deleted hashes, for the log line; never code.
 *
 * The caller holds the site's row lock (a save, a publish, the guarded write), so no write of this site commits in
 * between; a blob written by an open tab is younger than the grace period and stays.
 */
export async function pruneUnnamedBlobs(tx: Tx, siteId: string, now: Date, named?: NamedHashes): Promise<string[]> {
  const cutoff = new Date(now.getTime() - UNNAMED_BLOB_GRACE_MS);
  const candidates = await tx.$queryRaw<{ sha256: string }[]>`
    SELECT b.sha256 FROM public.custom_code_blobs b
     WHERE b.site_id = ${siteId} AND b.blocked_at IS NULL AND b.created_at < ${cutoff}`;
  if (candidates.length === 0) return [];
  const keep = allNamed(named ?? (await namedHashes(tx, siteId)));
  const doomed = candidates.map((row) => row.sha256).filter((sha256) => !keep.has(sha256));
  if (doomed.length === 0) return [];
  await tx.$executeRaw`
    DELETE FROM public.custom_code_blobs b
     WHERE b.site_id = ${siteId} AND b.blocked_at IS NULL AND b.created_at < ${cutoff} AND b.sha256 = ANY(${doomed}::text[])`;
  console.info(`[custom code] site ${siteId}: pruned ${doomed.length} unnamed blob(s) older than 7 days`);
  return doomed;
}

/** The site budget, re-exported for the save path's refusal. */
export const SITE_CODE_BUDGET_BYTES = BOX_LIMITS.siteBytes;
// ci-replay touch
