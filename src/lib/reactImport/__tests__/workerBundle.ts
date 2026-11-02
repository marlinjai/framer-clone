// Builds the worker chunk the way a browser receives it: one file, for the browser
// platform, with nothing left to fetch or `require`. Next's own bundler is the one that
// will ship it, in slice `import-dialog`; this measures what that chunk has to hold.

import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { build, type Metafile } from 'esbuild';

export interface WorkerBundle {
  code: string;
  bytes: number;
  gzipBytes: number;
  metafile: Metafile;
}

export async function bundleImportWorker(): Promise<WorkerBundle> {
  const result = await build({
    entryPoints: [path.resolve(__dirname, 'workerEntry.ts')],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    metafile: true,
    logLevel: 'silent',
    tsconfig: path.resolve(__dirname, '../../../../tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const code = result.outputFiles[0].text;
  return { code, bytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length, metafile: result.metafile };
}
