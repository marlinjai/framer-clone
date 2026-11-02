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

export type ProjectWriteResult =
  | { kind: 'ok'; payload: Record<string, unknown>; version: number }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'error'; message: string; writtenVersion?: number };

export async function postProjectWrite(
  url: '/api/projects/save' | '/api/projects/publish',
  project: unknown,
  expectedVersion: number | undefined,
  failedLabel: string,
): Promise<ProjectWriteResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, expectedVersion }),
    });
  } catch (err) {
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
      ...(typeof error?.writtenVersion === 'number' ? { writtenVersion: error.writtenVersion } : {}),
    };
  }
  const body = (payload ?? {}) as Record<string, unknown>;
  // A success without the new version cannot be built on: the next write would
  // be refused anyway. Said now, instead of a confusing conflict later.
  if (typeof body.version !== 'number') {
    return {
      kind: 'error',
      message: 'The server took the changes but did not return the project version. Reload the page before making more changes.',
    };
  }
  return { kind: 'ok', payload: body, version: body.version };
}
