// src/lib/renderer/publish/diskSink.ts
//
// The LOCAL output sink for the publish pipeline: writes a built bundle's
// in-memory file map to a directory on disk. This is the dry-run / local target
// (publish spec output) — it is NOT a live host. It imports `node:fs` and is
// therefore a Node-only module; `projectPublisher` reaches it via a dynamic
// import so importing the publisher from a client bundle never pulls in `fs`.
//
// R2 SEAM (deferred to P3, do NOT implement here): a future Cloudflare R2
// uploader implements the exact same `(target, files) => Promise<void>` contract
// as `writeBundleToDisk` — iterate the same `BundleFiles` map and `put` each
// entry to the bucket instead of `writeFile`. The publisher already returns the
// file map decoupled from any sink, so swapping disk for R2 is a one-module
// change with no publisher edit.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export type BundleFiles = Record<string, string | Uint8Array>;

/**
 * Write every entry of a bundle file map under `outDir`, creating parent
 * directories as needed. Relative keys (e.g. `about/index.html`) are joined onto
 * `outDir`. Returns the resolved output directory.
 */
export async function writeBundleToDisk(
  outDir: string,
  files: BundleFiles,
): Promise<string> {
  const root = path.resolve(outDir);
  for (const [relPath, contents] of Object.entries(files)) {
    const full = path.join(root, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const data =
      typeof contents === 'string' ? contents : Buffer.from(contents);
    await fs.writeFile(full, data);
  }
  return root;
}
