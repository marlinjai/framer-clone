// @vitest-environment node
//
// The size limits, bundled, minified and gzipped with esbuild, which takes a second. A
// limit only means something if it counts what the chunk imports, so this is what keeps the
// parser out of the runtime: one stray import of format.ts goes straight past it. The
// limits themselves are held on Next's real chunks, which come out larger, in
// test/behaviour/runtime.spec.ts.

import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const KILOBYTE = 1000;

/** Splitting on, as Next does, so what a chunk imports dynamically is not counted in it. */
async function gzippedSize(entry: string, external: string[] = []): Promise<{ raw: string; bytes: number }> {
  const result = await build({
    external,
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
  const file = result.outputFiles.find((output) => path.basename(output.path) === path.basename(entry).replace('.ts', '.js'));
  if (!file) throw new Error(`no output for ${entry}`);
  return { raw: file.text, bytes: gzipSync(file.text).length };
}

describe('the behaviour chunks', () => {
  it('core stays within 5 kilobytes gzipped', async () => {
    const { bytes } = await gzippedSize('runtime.ts');
    expect(bytes).toBeLessThanOrEqual(5 * KILOBYTE);
  });

  it('rove stays within 3 kilobytes gzipped', async () => {
    const { bytes } = await gzippedSize('rove.ts');
    expect(bytes).toBeLessThanOrEqual(3 * KILOBYTE);
  });

  // Here it also carries dom.ts, which Next keeps in the core's chunk.
  it('verbs stays within 3 kilobytes gzipped', async () => {
    const { bytes } = await gzippedSize('verbs.ts');
    expect(bytes).toBeLessThanOrEqual(3 * KILOBYTE);
  });

  // The custom code broker, the third lazy chunk (slice C3 of the sandboxed custom code plan). Next
  // keeps the registry (shared with the island) and the attribute names (shared with the core) in
  // other chunks, so they are not counted here either. 2.2 kilobytes since the second review of pull
  // request #452 (decision D73: the bounded plain-data walk and the nested-frame count).
  it('the custom code broker stays within 2.2 kilobytes gzipped', async () => {
    const { bytes } = await gzippedSize('../customCode/broker.ts', ['./registry', '@/lib/behaviour/names']);
    expect(bytes).toBeLessThanOrEqual(2.2 * KILOBYTE);
  });

  it.each(['runtime.ts', 'rove.ts', 'verbs.ts', '../customCode/broker.ts'])('%s holds no part of the parser, and no code from a string', async (entry) => {
    const { raw } = await gzippedSize(entry);
    expect(raw).not.toContain('a trigger needs');
    expect(raw).not.toMatch(/\beval\(|new Function\(/);
  });
});
