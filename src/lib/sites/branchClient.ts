// src/lib/sites/branchClient.ts
//
// The editor's calls to the site branch routes (docs/plans/2026-11-10-site-branches.md, section 6). Every
// refusal comes back as a BranchApiError with the route's error code, so a dialog can say what happened
// (`branch_name_taken`, `branch_review_stale`, `branch_conflicts`, `branch_closed`, ...). Client-safe.

import type { DocumentChanges } from '@/lib/siteMerge/diff';
import type { BranchSummaryJson } from './branches';

export class BranchApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BranchApiError';
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new BranchApiError('network', 'The server could not be reached. Check the connection and try again.', 0);
  }
  const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } & Record<string, unknown> } | null;
  if (!res.ok) {
    const error = json?.error ?? {};
    throw new BranchApiError(
      typeof error.code === 'string' ? error.code : 'failed',
      typeof error.message === 'string' ? error.message : `The request failed (${res.status}). Try again.`,
      res.status,
      error,
    );
  }
  return json as T;
}

const site = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export interface BranchListJson {
  mainSiteId: string;
  mainVersion: number;
  open: BranchSummaryJson[];
  closed: BranchSummaryJson[];
}

/** The review, as `GET .../branch/changes` answers it (BranchReview in src/server/sites/branches/merge.ts). */
export type DocumentChangesJson = DocumentChanges;
export interface BranchReviewJson {
  branch: BranchSummaryJson;
  token: string;
  upToDate: boolean;
  branchChanges: DocumentChangesJson;
  mainChanges: DocumentChangesJson | null;
  conflicts: Array<{ id: string; kind: string; unit: { kind: string; id: string }; path: string[]; fingerprint: string }>;
  settled: Array<{ id: string; pick: 'main' | 'branch' }>;
  problems: Array<{ code: string; message: string }>;
}

export const branchClient = {
  list: (mainId: string) => call<BranchListJson>('GET', `${site(mainId)}/branches`),
  create: (mainId: string, name: string, branchId: string) =>
    call<{ branch: BranchSummaryJson; created: boolean }>('POST', `${site(mainId)}/branches`, { name, branchId }),
  change: (mainId: string, branchId: string, change: { name?: string; ready?: boolean }) =>
    call<{ branch: BranchSummaryJson }>('PATCH', `${site(mainId)}/branches/${encodeURIComponent(branchId)}`, change),
  discard: (mainId: string, branchId: string) =>
    call<{ branch: BranchSummaryJson; discarded: boolean }>('DELETE', `${site(mainId)}/branches/${encodeURIComponent(branchId)}`),
  get: (mainId: string, branchId: string) => call<{ branch: BranchSummaryJson }>('GET', `${site(mainId)}/branches/${encodeURIComponent(branchId)}`),
  changes: (branchId: string) => call<BranchReviewJson>('GET', `${site(branchId)}/branch/changes`),
  update: (branchId: string, token: string) =>
    call<{ updated: boolean; branch: BranchSummaryJson; token: string }>('POST', `${site(branchId)}/branch/update`, { token }),
  merge: (branchId: string, token: string) =>
    call<{ merged: boolean; branch: BranchSummaryJson; mainVersion: number }>('POST', `${site(branchId)}/branch/merge`, { token }),
};

/** How much a branch changes, in one line: "2 pages, 14 elements changed". */
export function changeCountText(changes: DocumentChangesJson): string {
  const pages = changes.pages.added.length + changes.pages.removed.length + changes.pages.changed.length;
  const nodes = changes.nodes.added + changes.nodes.removed + changes.nodes.changed;
  const other = changes.site.length + changes.settings.length + changes.components.added.length + changes.components.removed.length + changes.components.changed.length;
  if (pages === 0 && nodes === 0 && other === 0 && !changes.pageOrder) return 'No changes yet';
  const parts: string[] = [];
  if (pages > 0) parts.push(`${pages} ${pages === 1 ? 'page' : 'pages'}`);
  if (nodes > 0) parts.push(`${nodes} ${nodes === 1 ? 'element' : 'elements'}`);
  if (other > 0) parts.push(`${other} ${other === 1 ? 'setting or component' : 'settings and components'}`);
  return parts.length > 0 ? `${parts.join(', ')} changed` : 'The page order changed';
}
