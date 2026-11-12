import 'server-only';

// src/server/mcp/approvals.ts
//
// The person's approval of a publish or a rollback an agent asked for, for an
// MCP client without a confirmation dialog (plan
// docs/plans/2026-11-02-lumitra-sites-agent-plugin.md, decision 6).
//
// The first call of `publish` or `rollback` does every check, writes nothing,
// and opens an approval request here. The agent shows the person its link, an
// editor page on app.lumitra.co (/projects/<site>/confirm/<id>). Opening it needs
// the editor sign-in of a user with publishSite on the site's workspace; the
// page shows what goes live, and a click approves (the approve route records
// who). Only then does the agent's second call, naming the request id, proceed.
// (A one-time code handed to the agent itself could be replayed by content
// injected into the agent; an approval only a signed-in person can give cannot.)
//
// A request is bound to one exact action: company, key, site, workspace, the
// site version the person was shown, and for rollback the revision and the
// revision live at the time. It expires APPROVAL_TTL_MS (five minutes) after it
// was opened, decided or not, and is spent on its first use after a decision. Checking and
// spending happen in one synchronous step, so two concurrent calls cannot both
// use it.
//
// Bounded per key (APPROVALS_PER_KEY, the oldest of that key goes first) and in
// total (APPROVALS_MAX, a backstop), so one key can never push out another
// company's open requests. Process-local, like the other per-request state of
// this app: framer-clone runs as one container (deploy/README.md, "the app must
// run as a single container"). A restart forgets open requests, and the agent
// then opens a new one.

import { randomBytes } from 'node:crypto';
import type { TenantScope } from '@/server/sites/repository';

/** How long an approval request stays usable after it was opened, approved or not. */
export const APPROVAL_TTL_MS = 5 * 60_000;
/** Open requests one key may hold; opening another drops that key's oldest. */
export const APPROVALS_PER_KEY = 5;
/** Open requests in total, a backstop behind the per-key cap. */
export const APPROVALS_MAX = 5_000;

export interface ApprovalSubject {
  action: 'publish' | 'rollback' | 'merge';
  tenantId: string;
  keyId: string;
  scope: TenantScope;
  siteId: string;
  /** The site version the person is shown. */
  version: number;
  /** Rollback only: the revision to serve, and the one live when it was asked. */
  revision?: number;
  live?: number | null;
  /**
   * Merge only (site branches, docs/plans/2026-11-10-site-branches.md): `siteId` is the site merged into and
   * `version` its version; these name the branch, its version, and the review token over both sites' versions,
   * names and erasure epochs, so the approval is for exactly what the person was shown.
   */
  branchId?: string;
  branchVersion?: number;
  token?: string;
}

export type ApprovalDecision = 'approve' | 'decline';

export interface Approval extends ApprovalSubject {
  /** 192 random bits, base64url: the lookup handle of the link, never proof of a decision. */
  id: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
  /** The person's decision, recorded here on the server by the approve route; null while open. */
  decision: ApprovalDecision | null;
  decidedBy: string | null;
  decidedAt: number | null;
}

function sameSubject(a: ApprovalSubject, b: ApprovalSubject): boolean {
  return (
    a.action === b.action &&
    a.tenantId === b.tenantId &&
    a.keyId === b.keyId &&
    a.scope.workspaceId === b.scope.workspaceId &&
    a.scope.tenantGroupId === b.scope.tenantGroupId &&
    a.siteId === b.siteId &&
    a.version === b.version &&
    (a.revision ?? null) === (b.revision ?? null) &&
    (a.live ?? null) === (b.live ?? null) &&
    (a.branchId ?? null) === (b.branchId ?? null) &&
    (a.branchVersion ?? null) === (b.branchVersion ?? null) &&
    (a.token ?? null) === (b.token ?? null)
  );
}

/** What naming a request in a confirming call found. `approved` and `declined` spend it. */
export type RedeemOutcome =
  /** Approved by a person, matching, live: spent now, the action may run. */
  | { kind: 'approved'; approvedBy: string }
  /** Declined by a person: spent now, nothing runs. */
  | { kind: 'declined' }
  /** Matching and live, but nobody decided yet. Kept. */
  | { kind: 'pending'; approval: Approval }
  /** Unknown, expired, spent, or opened for another key, site, version or revision. Untouched. */
  | { kind: 'invalid' };

export type DecideOutcome =
  | { kind: 'decided'; approval: Approval }
  /** Someone decided already; the first decision stands. */
  | { kind: 'already_decided'; approval: Approval }
  | { kind: 'not_found' };

const copy = (a: Approval): Approval => ({ ...a, scope: { ...a.scope } });

export class ApprovalStore {
  readonly #approvals = new Map<string, Approval>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  open(subject: ApprovalSubject, summary: string): Approval {
    this.#sweep();
    const ofKey = [...this.#approvals.values()].filter((a) => a.keyId === subject.keyId && a.tenantId === subject.tenantId);
    for (const old of ofKey.slice(0, Math.max(0, ofKey.length - APPROVALS_PER_KEY + 1))) this.#approvals.delete(old.id);
    while (this.#approvals.size >= APPROVALS_MAX) {
      const oldest = this.#approvals.keys().next().value;
      if (oldest === undefined) break;
      this.#approvals.delete(oldest);
    }
    const now = this.#now();
    const approval: Approval = {
      ...subject,
      scope: { ...subject.scope },
      id: randomBytes(24).toString('base64url'),
      summary,
      createdAt: now,
      expiresAt: now + APPROVAL_TTL_MS,
      decision: null,
      decidedBy: null,
      decidedAt: null,
    };
    this.#approvals.set(approval.id, approval);
    return copy(approval);
  }

  /** A live request by id (for the approval page), or null. Reading never decides anything. */
  get(id: string): Approval | null {
    this.#sweep();
    const found = this.#approvals.get(id);
    return found ? copy(found) : null;
  }

  /** Record a person's decision. The caller has checked their sign-in, publishSite and the site version. */
  decide(id: string, userId: string, decision: ApprovalDecision): DecideOutcome {
    this.#sweep();
    const found = this.#approvals.get(id);
    if (!found) return { kind: 'not_found' };
    if (found.decision) return { kind: 'already_decided', approval: copy(found) };
    found.decision = decision;
    found.decidedBy = userId;
    found.decidedAt = this.#now();
    return { kind: 'decided', approval: copy(found) };
  }

  /** Check and, once a person decided, spend a request in one synchronous step. */
  redeem(id: string, subject: ApprovalSubject): RedeemOutcome {
    this.#sweep();
    const found = this.#approvals.get(id);
    if (!found || !sameSubject(found, subject)) return { kind: 'invalid' };
    if (!found.decision || !found.decidedBy) return { kind: 'pending', approval: copy(found) };
    this.#approvals.delete(id);
    return found.decision === 'approve' ? { kind: 'approved', approvedBy: found.decidedBy } : { kind: 'declined' };
  }

  /** Open requests of one key (tests). */
  countFor(tenantId: string, keyId: string): number {
    this.#sweep();
    return [...this.#approvals.values()].filter((a) => a.keyId === keyId && a.tenantId === tenantId).length;
  }

  get size(): number {
    return this.#approvals.size;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, a] of this.#approvals) if (a.expiresAt <= now) this.#approvals.delete(id);
  }
}

let shared: ApprovalStore | null = null;

/** The process's store, shared by the MCP endpoint and the editor's approval page and route. */
export function getApprovalStore(): ApprovalStore {
  if (!shared) shared = new ApprovalStore();
  return shared;
}

/** The editor page that approves `approval`, on the editor host when it is known. */
export function approvalUrl(approval: Pick<Approval, 'id' | 'siteId'>, editorHost: string | null | undefined): string {
  const path = `/projects/${encodeURIComponent(approval.siteId)}/confirm/${encodeURIComponent(approval.id)}`;
  const host = editorHost?.trim();
  return host ? `https://${host}${path}` : path;
}
