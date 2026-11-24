// src/components/customCode/customCodeClient.ts
//
// The editor's calls to the guarded custom code route
// (src/app/api/projects/[projectId]/custom-code/route.ts, plan
// docs/plans/2026-11-02-sandboxed-custom-code.md, slice C4). Every answer comes back
// as a result: a value, or the route's own code and sentence, or a sentence for a
// network failure. Nothing is thrown at the panel and nothing is swallowed. Every call
// gives up after a time limit (review 2 of #459, Info 5), so a request that hangs can never
// leave the panel's fields locked.

import type { CustomCodeDeclaration } from '@/lib/customCode/contract';

export interface CustomCodeStatus {
  enabled: boolean;
  branch: boolean;
  canManage: boolean;
  serving: boolean;
  usedBytes: number;
  limits: { blockBytes: number; siteBytes: number; blocksPerPage: number; writesPerHour: number };
}

export interface StoredBlob {
  sha256: string;
  title: string;
  document: string;
  declaration: CustomCodeDeclaration | null;
  createdAt: string;
  blocked: boolean;
}

export interface WriteBody {
  pageId: string;
  nodeId: string;
  title: string;
  document: string;
  declaration: CustomCodeDeclaration;
  replaces?: string;
}

export type ClientResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string };

const NETWORK_MESSAGE = 'The server could not be reached. Check the connection and try again; nothing was changed.';

/** How long a read waits for the server, and how long a save does (it hashes and writes). */
export const CUSTOM_CODE_READ_TIMEOUT_MS = 20_000;
export const CUSTOM_CODE_SAVE_TIMEOUT_MS = 30_000;

const READ_TIMEOUT_MESSAGE = 'The server did not answer in time. Nothing was changed; try again.';
// A save that timed out may have been stored or not; saving the same code again stores it once (D105).
const SAVE_TIMEOUT_MESSAGE =
  'The server did not answer in time, so the block was not changed and your edits are kept. Save again: the same code is stored only once.';

function base(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/custom-code`;
}

async function call<T>(input: string, init: RequestInit, limit: { ms: number; message: string }): Promise<ClientResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit.ms);
  const timedOut = (): ClientResult<T> => ({ ok: false, status: 0, code: 'timeout', message: limit.message });
  let res: Response;
  let json: unknown = null;
  try {
    try {
      res = await fetch(input, { ...init, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    } catch {
      return controller.signal.aborted ? timedOut() : { ok: false, status: 0, code: 'network', message: NETWORK_MESSAGE };
    }
    try {
      json = await res.json();
    } catch {
      // A body cut off by the time limit is a timeout; an unreadable one is read as no body.
      if (controller.signal.aborted) return timedOut();
      json = null;
    }
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return { ok: true, value: json as T };
  const error = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === 'string' ? error.code : `http_${res.status}`;
  const message = typeof error?.message === 'string' && error.message.trim() !== ''
    ? error.message
    : res.status === 401
      ? 'You were signed out. Sign in again, then save the code.'
      : `The server answered ${res.status}. Nothing was changed; try again in a moment.`;
  return { ok: false, status: res.status, code, message };
}

export function fetchCustomCodeStatus(projectId: string): Promise<ClientResult<CustomCodeStatus>> {
  return call<CustomCodeStatus>(base(projectId), {}, { ms: CUSTOM_CODE_READ_TIMEOUT_MS, message: READ_TIMEOUT_MESSAGE });
}

export function fetchCustomCodeBlob(projectId: string, sha256: string): Promise<ClientResult<StoredBlob>> {
  return call<StoredBlob>(`${base(projectId)}?sha256=${encodeURIComponent(sha256)}`, {}, { ms: CUSTOM_CODE_READ_TIMEOUT_MS, message: READ_TIMEOUT_MESSAGE });
}

export function postCustomCode(projectId: string, body: WriteBody): Promise<ClientResult<{ sha256: string; created: boolean }>> {
  return call(
    base(projectId),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { ms: CUSTOM_CODE_SAVE_TIMEOUT_MS, message: SAVE_TIMEOUT_MESSAGE },
  );
}
