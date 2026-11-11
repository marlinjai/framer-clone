// src/lib/siteOps/types.ts
//
// The site operations vocabulary (plan docs/plans/2026-11-02-lumitra-sites-agent-plugin.md,
// build step 3): who calls, what a batch of edits may say, and what comes back.
// One vocabulary for the MCP endpoint, the in-editor AI and a CLI, so none of them
// grows its own write path.
//
// Every failure is data, never a throw: a caller (an agent above all) reads the
// code and acts on it. A stale version answers `site_changed` with the version
// stored now; a refused batch answers `rejected` with one reason per operation,
// and nothing of it was written.
//
// Node and page ids an operation names may be a reference to something an earlier
// operation of the same batch created: `ref:<name>`, where <name> is the `ref` the
// caller gave that node or page.

import { z } from 'zod';
import type { TenantScope } from '@/server/sites/repository';

/** The permissions the operations check (FRAMER_PERMISSIONS in src/lib/permissions.ts). */
export type SiteOpsAction = 'viewSite' | 'editSite' | 'publishSite' | 'mergeBranch';

/**
 * Who calls. Built by the caller's own door (a company API key through
 * src/lib/auth-machine.ts, or a verified editor session), so this library never
 * depends on how the caller authenticated. `scope` and `companyId` come from that
 * verification, never from the request.
 */
export interface SiteOpsCaller {
  scope: TenantScope;
  /** The auth-brain company the scope belongs to (stamped on a site it creates). */
  companyId: string;
  /** The company's auth-brain slug, for its shop schema when a first site is created. */
  companySlug?: string;
  actor: { kind: 'user' | 'key'; id: string };
  /** Extra detail for the audit row (a key's service account, say). Never a secret. */
  actorDetail?: Record<string, string>;
  /** How an open editor names this caller on its live stream (plain text); a generic label when absent. */
  actorLabel?: string;
  /**
   * The id an open editor's live stream gave this call (src/server/mcp/presence.ts),
   * kept in the audit row so the feed line of a write has one id live and after a reload.
   */
  liveCallId?: string;
  can(action: SiteOpsAction): boolean | Promise<boolean>;
}

/** One refused operation of a batch: its index in the list, its name, and why. */
export interface RejectedOperation {
  index: number;
  op: string;
  reason: string;
}

export type SiteOpsError =
  | { code: 'forbidden'; message: string }
  | { code: 'site_not_found'; message: string }
  | { code: 'page_not_found'; message: string }
  | { code: 'revision_not_found'; message: string }
  /** Publish or rollback named a site branch: only its site is ever published. */
  | { code: 'branch_cannot_publish'; message: string; mainSiteId?: string }
  | { code: 'site_changed'; message: string; currentVersion: number }
  | { code: 'invalid_request'; message: string; issues?: string[] }
  | { code: 'rejected'; message: string; rejected: RejectedOperation[] }
  | { code: 'rate_limited'; message: string; retryAfterSec: number }
  | { code: 'unavailable'; message: string; retryAfterSec?: number }
  | { code: 'failed'; message: string; writtenVersion?: number };

export type SiteOpsResult<T> = { ok: true; value: T } | { ok: false; error: SiteOpsError };

export const ok = <T>(value: T): SiteOpsResult<T> => ({ ok: true, value });
export const fail = <T = never>(error: SiteOpsError): SiteOpsResult<T> => ({ ok: false, error });

// ---------- the batch ----------

/** The most operations one batch may hold. */
export const MAX_BATCH_OPS = 200;
/** The most top-level nodes one insertNodes operation takes (each may carry its own children). */
export const MAX_INSERT_NODES = 200;

const id = z.string().trim().min(1).max(200);
const ref = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, 'a ref is 1 to 64 letters, digits, _ or -');
const breakpoint = z.string().trim().min(1).max(60).nullable().optional();
const styleValue = z.union([z.string(), z.number(), z.null()]);

/** A target inside a page: a parent (and a position in it) or next to a sibling. */
const placeSchema = z.union([
  z.strictObject({ parentId: id, index: z.number().int().min(0).optional() }),
  z.strictObject({ siblingId: id, position: z.enum(['before', 'after']) }),
]);

export const OperationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('createPage'),
    title: z.string().trim().min(1).max(120),
    slug: z.string().max(200).optional(),
    description: z.string().max(300).optional(),
    ref: ref.optional(),
  }),
  z.strictObject({
    op: z.literal('updatePageSettings'),
    pageId: id,
    title: z.string().max(120).optional(),
    slug: z.string().max(200).optional(),
    description: z.string().max(300).optional(),
    ogImage: z.string().max(2000).optional(),
    noIndex: z.boolean().optional(),
    notFoundPage: z.boolean().optional(),
  }),
  /**
   * Delete a page of the working copy, as the Pages panel does: never the home
   * page or the last page. Links to its address stay (the answer counts them).
   */
  z.strictObject({ op: z.literal('deletePage'), pageId: id }),
  z.strictObject({
    op: z.literal('insertNodes'),
    pageId: id,
    /** The container the nodes go into; the page root when absent. */
    parentId: id.optional(),
    /** Position among the parent's children; appended when absent. */
    index: z.number().int().min(0).optional(),
    /** Nodes in the generation format (describeVocabulary), each with an optional `ref`. */
    nodes: z.array(z.unknown()).min(1).max(MAX_INSERT_NODES),
  }),
  z.strictObject({
    op: z.literal('updateStyle'),
    nodeId: id,
    property: z.string().trim().min(1).max(64),
    /** A string or number sets the value, null removes it. */
    value: styleValue,
    /** A breakpoint key of the page; the largest (or absent) writes the base value. */
    breakpoint,
    /** A named state: the value applies while the node is hovered, focused or pressed. */
    state: z.enum(['hover', 'focused', 'pressed']).optional(),
  }),
  z.strictObject({ op: z.literal('updateText'), nodeId: id, text: z.string() }),
  z.strictObject({
    op: z.literal('setProps'),
    nodeId: id,
    /** Attributes to set; null removes one. Not style, children, rules or behaviour. */
    props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  }),
  z.strictObject({ op: z.literal('moveNode'), nodeId: id, to: placeSchema }),
  z.strictObject({ op: z.literal('removeNode'), nodeId: id }),
  z.strictObject({
    op: z.literal('addRule'),
    nodeId: id,
    /** A selector rule (`&:hover`, `& > li`) with an optional at-rule list, style in breakpoint keys. */
    rule: z.strictObject({
      selector: z.string().trim().min(1).max(500),
      at: z.array(z.string().max(500)).max(4).optional(),
      style: z.record(z.string(), z.unknown()),
    }),
  }),
  z.strictObject({
    op: z.literal('setTheme'),
    /** The whole theme (src/lib/site/theme.ts), replaced in one write. */
    theme: z.strictObject({
      mode: z.enum(['system', 'light', 'dark']).optional(),
      tokens: z.array(z.record(z.string(), z.unknown())).max(700),
      document: z.record(z.string(), z.string()),
    }),
  }),
  z.strictObject({
    op: z.literal('placeComponent'),
    pageId: id,
    definitionId: id,
    to: placeSchema.optional(),
    ref: ref.optional(),
  }),
]);

export type Operation = z.infer<typeof OperationSchema>;
export type OperationName = Operation['op'];

export const BatchSchema = z.strictObject({
  siteId: id,
  /** The version the caller read (getSite or the last write's answer). */
  expectedVersion: z.number().int().min(1),
  ops: z.array(z.unknown()).min(1).max(MAX_BATCH_OPS),
});

export interface BatchOutcome {
  siteId: string;
  /** The site's version after the write: the next batch names it. */
  version: number;
  /** Every `ref` the batch gave, with the id it became. */
  created: Record<string, string>;
  /** One short line per operation, in order. */
  summary: string[];
}
