// @vitest-environment node
// The chunk builds for a browser, on every push. Whether it runs in one is
// test/score/importWorker.score.ts, which needs Chromium.

import { describe, expect, it } from 'vitest';
import { bundleImportWorker } from './workerBundle';

const MEGABYTE = 1024 * 1024;

describe('the worker chunk', () => {
  it('builds for a browser, with nothing from the server in it', async () => {
    const { bytes, gzipBytes, metafile } = await bundleImportWorker();
    console.log(`worker chunk: ${(bytes / MEGABYTE).toFixed(2)} megabytes, ${(gzipBytes / MEGABYTE).toFixed(2)} gzipped`);
    const inputs = Object.keys(metafile.inputs);
    expect(inputs.some((name) => name.includes('node_modules/.pnpm/typescript@'))).toBe(true);
    expect(inputs.filter((name) => /src\/server\/|server-only|node_modules\/.*\/(?:react|react-dom|mobx|mobx-state-tree)\//.test(name))).toEqual([]);
    expect(bytes).toBeLessThan(8 * MEGABYTE);
  }, 60_000);
});
