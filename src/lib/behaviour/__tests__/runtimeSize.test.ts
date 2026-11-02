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

async function gzippedSize(entry: string): Promise<{ raw: string; bytes: number }> {
  const result = await build({
    entryPoints: [path.resolve(__dirname, '..', entry)],
    bundle: true,
    minify: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    alias: { '@': path.resolve(__dirname, '../../..') },
  });
  const raw = result.outputFiles[0].text;
  return { raw, bytes: gzipSync(raw).length };
}

describe('the behaviour chunks', () => {
  it('core stays within 5 kilobytes gzipped', async () => {
    const { bytes } = await gzippedSize('runtime.ts');
    expect(bytes).toBeLessThanOrEqual(5 * KILOBYTE);
  });

  it('holds no part of the parser, and no code from a string', async () => {
    const { raw } = await gzippedSize('runtime.ts');
    expect(raw).not.toContain('a trigger needs');
    expect(raw).not.toMatch(/\beval\(|new Function\(/);
  });
});
