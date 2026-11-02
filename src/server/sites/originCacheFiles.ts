import 'server-only';

// src/server/sites/originCacheFiles.ts
//
// Deleting a site's resolution from the origin cache's files, for an erase of
// personal data (plan docs/plans/2026-11-01-immutable-published-copy.md,
// "Erasing personal data from the history").
//
// `unstable_cache` on a self-hosted Next server writes each cached site (its full
// frozen documents) as one JSON file under `.next/cache/fetch-cache`, with the
// entry's tags inside. `revalidateTag` only marks a tag stale: the file stays until
// the next visit overwrites it, and a site that is offline is never visited, so
// its file would keep the erased value until the next deploy. This deletes every
// file that carries one of the site's tags instead. Next's own in-process copy of
// an entry is no longer served once its tag is stale and ages out of memory.
//
// Per container: with more than one, each keeps its own directory, and only the
// one that ran the erase is cleaned (deploy/README.md, "Erasing personal data").

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Where Next keeps `unstable_cache` entries: `<distDir>/cache/fetch-cache`, the dist dir being `.next` under the working directory (also in the standalone image). */
export function fetchCacheDir(): string {
  return path.join(process.cwd(), '.next', 'cache', 'fetch-cache');
}

/** True when a cache file's own `tags` list holds one of `tags`. */
function carriesTag(raw: string, tags: readonly string[]): boolean {
  // Cheap first: a file without the tag text cannot carry it.
  if (!tags.some((tag) => raw.includes(JSON.stringify(tag)))) return false;
  try {
    const parsed = JSON.parse(raw) as { tags?: unknown };
    return Array.isArray(parsed.tags) && parsed.tags.some((tag) => tags.includes(tag as string));
  } catch {
    // Not one of Next's entries (or half written): leave it alone.
    return false;
  }
}

/**
 * Delete every cached file carrying one of `tags`. Returns how many went. A
 * directory that does not exist (nothing cached yet, the test runner) is no error;
 * any other failure throws, so the erase route reports that the refresh failed and
 * the owner repeats it.
 */
export async function purgeCachedSiteFiles(tags: readonly string[], dir: string = fetchCacheDir()): Promise<number> {
  if (tags.length === 0) return 0;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let purged = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      // Deleted meanwhile (a visit replacing it), or a directory: nothing of ours.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') continue;
      throw err;
    }
    if (!carriesTag(raw, tags)) continue;
    try {
      await fs.unlink(file);
      purged++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return purged;
}
