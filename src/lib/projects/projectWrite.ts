// src/lib/projects/projectWrite.ts
//
// The request the editor's Save and Publish share: POST the project snapshot
// with the site version it is based on (`expectedVersion`, the version lock;
// see src/stores/openProject.ts and src/app/api/projects/_schema.ts) and sort
// the answer into the three outcomes the buttons handle:
//   - ok: the server wrote it and answered the site's new version;
//   - conflict: 409 `site_changed`, the project moved on to `currentVersion`
//     and nothing was written (SiteChangedDialog asks what to do);
//   - error: anything else, as a sentence to show. A publish that committed
//     before a later step failed says so with `writtenVersion`: the server
//     then holds exactly the sent snapshot at that version.

import { editorTabId } from './tabId';

export type ProjectWriteResult =
  | { kind: 'ok'; payload: Record<string, unknown>; version: number }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'error'; message: string; status?: number; writtenVersion?: number };

/** Browsers refuse a `keepalive` request whose body is larger than 64 KB; stay under it. */
export const KEEPALIVE_BODY_MAX_BYTES = 60 * 1024;

/**
 * How long a save may take before it counts as a network failure (and enters
 * autosave's retry backoff). Only the save has a deadline: aborting a publish
 * client-side could hide a write the server already committed.
 */
export const SAVE_TIMEOUT_MS = 30_000;

export interface ProjectWriteOptions {
  /** Names this attempt (save only): a retry of the same content reuses it. */
  requestKey?: string;
  /** This tab's earlier attempts on the same base whose answers were lost (save and publish). */
  previousRequestKeys?: readonly string[];
  /**
   * Leaving the page: ask the browser to finish the request when the body fits
   * what is left of the page's keepalive budget (the browser caps all keepalive
   * bodies of a page at 64 KB together); the size is taken from it. A body
   * that does not fit goes as a normal request, covered by the unload warning.
   */
  keepaliveBudget?: { remaining: number };
}

export async function postProjectWrite(
  url: '/api/projects/save' | '/api/projects/publish',
  project: unknown,
  expectedVersion: number | undefined,
  failedLabel: string,
  options: ProjectWriteOptions = {},
): Promise<ProjectWriteResult> {
  let res: Response;
  try {
    const body = JSON.stringify({
      project,
      expectedVersion,
      ...(options.requestKey ? { requestKey: options.requestKey } : {}),
      ...(options.previousRequestKeys?.length ? { previousRequestKeys: options.previousRequestKeys } : {}),
      // The live stream tells this tab its own write apart from everyone else's (src/lib/projects/tabId.ts).
      originTab: editorTabId(),
    });
    // A larger body goes as a normal request: it may not outlive the page,
    // which the unload warning covers.
    const budget = options.keepaliveBudget;
    const size = budget ? new Blob([body]).size : 0;
    const keepalive = !!budget && size <= Math.min(budget.remaining, KEEPALIVE_BODY_MAX_BYTES);
    if (budget && keepalive) budget.remaining -= size;
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      ...(keepalive ? { keepalive: true } : {}),
      ...(url === '/api/projects/save' ? { signal: AbortSignal.timeout(SAVE_TIMEOUT_MS) } : {}),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { kind: 'error', message: `${failedLabel}: the server did not answer in time.` };
    }
    return { kind: 'error', message: err instanceof Error ? err.message : `Network error: ${failedLabel}.` };
  }
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (
      payload as { error?: { code?: unknown; message?: unknown; currentVersion?: unknown; writtenVersion?: unknown } } | null
    )?.error;
    if (res.status === 409 && error?.code === 'site_changed' && typeof error.currentVersion === 'number') {
      return { kind: 'conflict', currentVersion: error.currentVersion };
    }
    return {
      kind: 'error',
      message: typeof error?.message === 'string' ? error.message : `${failedLabel} (${res.status}).`,
      status: res.status,
      ...(typeof error?.writtenVersion === 'number' ? { writtenVersion: error.writtenVersion } : {}),
    };
  }
  const body = (payload ?? {}) as Record<string, unknown>;
  // A success without the new version cannot be built on. It is a server
  // error (502, retried like one), never a refusal or a conflict: a retry with
  // the same attempt key gets the stored result.
  if (typeof body.version !== 'number') {
    return {
      kind: 'error',
      status: 502,
      message: 'The server did not confirm the save (its answer had no project version).',
    };
  }
  return { kind: 'ok', payload: body, version: body.version };
}
