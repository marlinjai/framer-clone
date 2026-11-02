// @vitest-environment node
//
// Deleting a site's entries from the origin cache's files after an erase
// (src/server/sites/originCacheFiles.ts), on a real temporary directory written
// in the shape Next's file system cache writes (`{ kind, data, tags }`).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchCacheDir, purgeCachedSiteFiles } from '../originCacheFiles';

let dir: string;

async function entry(name: string, tags: string[], body = 'Max Mustermann'): Promise<void> {
  await fs.writeFile(path.join(dir, name), JSON.stringify({ kind: 'FETCH', data: { body }, revalidate: false, tags }));
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fetch-cache-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('purgeCachedSiteFiles', () => {
  it('deletes exactly the files carrying one of the tags', async () => {
    await entry('a', ['site:bakery-abc']);
    await entry('b', ['site-host:www.bakery.example', 'other']);
    await entry('c', ['site:other-site']);
    // The tag text in the body only, not in the tags: kept.
    await entry('d', ['site:other-site'], '"site:bakery-abc"');
    await fs.writeFile(path.join(dir, 'e'), 'not json "site:bakery-abc"');
    await fs.mkdir(path.join(dir, 'sub'));

    const purged = await purgeCachedSiteFiles(['site:bakery-abc', 'site-host:www.bakery.example'], dir);

    expect(purged).toBe(2);
    expect((await fs.readdir(dir)).sort()).toEqual(['c', 'd', 'e', 'sub']);
  });

  it('is no error when nothing was ever cached, or when there is nothing to look for', async () => {
    await expect(purgeCachedSiteFiles(['site:x'], path.join(dir, 'missing'))).resolves.toBe(0);
    await entry('a', ['site:x']);
    await expect(purgeCachedSiteFiles([], dir)).resolves.toBe(0);
    expect(await fs.readdir(dir)).toEqual(['a']);
  });

  it('looks where Next keeps them, under the working directory', () => {
    expect(fetchCacheDir()).toBe(path.join(process.cwd(), '.next', 'cache', 'fetch-cache'));
  });
});
