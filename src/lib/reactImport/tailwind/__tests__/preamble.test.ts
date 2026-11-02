// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import { IMPORT_PREAMBLE_FILE, importPreambleText } from '../../../../../scripts/generate-import-preamble';
import { buildPreamble, loadModule, loadStylesheet } from '../preamble';

const MEGABYTE = 1024 * 1024;

describe('the preamble', () => {
  it('matches the installed Tailwind and tw-animate-css: run pnpm generate:import-preamble when this fails', () => {
    expect(readFileSync(IMPORT_PREAMBLE_FILE, 'utf8')).toBe(importPreambleText());
  });

  it('loads its two constants and nothing else', async () => {
    await expect(loadStylesheet('tailwindcss')).resolves.toMatchObject({ path: 'tailwindcss' });
    for (const id of ['./theme.css', 'https://evil.test/x.css', '/etc/passwd', 'tailwindcss/index.css']) {
      await expect(loadStylesheet(id)).rejects.toThrow();
    }
    await expect(loadModule()).rejects.toThrow();
  });

  it('writes only checked tokens into its hole, and the dark variant only when asked', () => {
    expect(buildPreamble({ theme: new Map(), darkClass: false })).toBe('@import "tailwindcss";\n@import "tw-animate-css";');
    expect(buildPreamble({ theme: new Map([['--color-brand', 'red']]), darkClass: true })).toContain('@custom-variant dark (&:is(.dark *));\n@theme inline {\n  --color-brand: red;\n}');
  });

  it('cannot reach a file or a program through the compiler', async () => {
    const options = { base: '/', loadStylesheet, loadModule };
    await expect(compile('@import "./secrets.css";', options)).rejects.toThrow();
    await expect(compile('@import "tailwindcss";\n@plugin "evil";', options)).rejects.toThrow();
    await expect(compile('@import "tailwindcss";\n@config "./tailwind.config.js";', options)).rejects.toThrow();
  });

  it('builds for a browser, with nothing from the server in it', async () => {
    const result = await build({
      entryPoints: [path.resolve(__dirname, '../index.ts')],
      bundle: true,
      minify: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      metafile: true,
      logLevel: 'silent',
      tsconfig: path.resolve(__dirname, '../../../../../tsconfig.json'),
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    const code = result.outputFiles[0].text;
    const bytes = Buffer.byteLength(code);
    console.log(`tailwind layer chunk: ${(bytes / MEGABYTE).toFixed(2)} megabytes, ${(gzipSync(code).length / MEGABYTE).toFixed(2)} gzipped`);
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((name) => name.includes('node_modules/.pnpm/tailwindcss@'))).toBe(true);
    expect(inputs.filter((name) => /src\/server\/|server-only|node_modules\/.*\/(?:react|react-dom|mobx|mobx-state-tree)\//.test(name))).toEqual([]);
    expect(code).not.toMatch(/\beval\(|new Function\(/);
    expect(bytes).toBeLessThan(2 * MEGABYTE);
  }, 60_000);
});
