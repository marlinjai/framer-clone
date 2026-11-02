// @vitest-environment node
//
// The size limits of the contract, on the chunk as a browser receives it: bundled,
// minified and gzipped. A limit only means something if it counts what the chunk imports,
// so this is what keeps the parser out of the runtime: one stray import of format.ts
// goes straight past it.

import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const KILOBYTE = 1000;

/** Splitting on, as Next does, so what a chunk imports dynamically is not counted in it. */
async function gzippedSize(entry: string): Promise<{ raw: string; bytes: number }> {
  const result = await build({
    entryPoints: [path.resolve(__dirname, '..', entry)],
    bundle: true,
    minify: true,
    write: false,
    splitting: true,
    outdir: '/virtual',
    format: 'esm',
    target: 'es2022',
    alias: { '@': path.resolve(__dirname, '../../..') },
  });
  const file = result.outputFiles.find((output) => path.basename(output.path) === entry.replace('.ts', '.js'));
  if (!file) throw new Error(`no output for ${entry}`);
  return { raw: file.text, bytes: gzipSync(file.text).length };
}

describe('the behaviour chunks', () => {
  it('core stays within 5 kilobytes gzipped', async () => {
    const { bytes } = await gzippedSize('runtime.ts');
    expect(bytes).toBeLessThanOrEqual(5 * KILOBYTE);
  });

  it('verbs stays within 2 kilobytes gzipped', async () => {
    const { bytes } = await gzippedSize('verbs.ts');
    expect(bytes).toBeLessThanOrEqual(2 * KILOBYTE);
  });

  it.each(['runtime.ts', 'verbs.ts'])('%s holds no part of the parser, and no code from a string', async (entry) => {
    const { raw } = await gzippedSize(entry);
    expect(raw).not.toContain('a trigger needs');
    expect(raw).not.toMatch(/\beval\(|new Function\(/);
  });
});
