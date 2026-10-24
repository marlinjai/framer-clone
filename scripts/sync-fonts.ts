// scripts/sync-fonts.ts
//
// Copies the self-hosted web fonts (src/lib/fonts/registry.ts) from their
// pinned @fontsource packages into public/fonts/<id>/<version>/, where Next
// serves them from the app's own origin (next.config.ts gives /fonts a
// one-year immutable cache, safe because the path carries the version).
//
// Runs as part of `pnpm dev` and `pnpm build` (the Docker deps stage installs
// with --ignore-scripts, so a postinstall hook would never run there).
// public/fonts is gitignored: the lockfile's integrity hashes pin the bytes.
// Fails loudly when a package is missing or at a different version than the
// registry says, so a font never silently 404s on a published page.

import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_LIBRARY } from '../src/lib/fonts/registry';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(join(root, 'package.json'));
const outRoot = join(root, 'public', 'fonts');

let copied = 0;
let kept = 0;
const problems: string[] = [];
const expectedDirs = new Set<string>();

for (const family of FONT_LIBRARY) {
  let pkgJsonPath: string;
  try {
    pkgJsonPath = require.resolve(`${family.pkg}/package.json`);
  } catch {
    problems.push(`${family.pkg} is not installed (run pnpm install)`);
    continue;
  }
  const pkgDir = dirname(pkgJsonPath);
  const installed = (JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version: string }).version;
  if (installed !== family.version) {
    problems.push(`${family.pkg} is ${installed}, the registry expects ${family.version}`);
    continue;
  }
  const outDir = join(outRoot, family.id, family.version);
  expectedDirs.add(join(family.id, family.version));
  mkdirSync(outDir, { recursive: true });
  for (const face of family.faces) {
    const src = join(pkgDir, 'files', face.file);
    const dest = join(outDir, face.file);
    if (!existsSync(src)) {
      problems.push(`${family.pkg} has no files/${face.file}`);
      continue;
    }
    if (existsSync(dest) && statSync(dest).size === statSync(src).size) {
      kept++;
      continue;
    }
    copyFileSync(src, dest);
    copied++;
  }
}

// Drop families or versions the registry no longer lists.
if (existsSync(outRoot)) {
  for (const id of readdirSync(outRoot)) {
    const idDir = join(outRoot, id);
    if (!statSync(idDir).isDirectory()) continue;
    for (const version of readdirSync(idDir)) {
      if (!expectedDirs.has(join(id, version))) rmSync(join(idDir, version), { recursive: true, force: true });
    }
    if (readdirSync(idDir).length === 0) rmSync(idDir, { recursive: true, force: true });
  }
}

if (problems.length > 0) {
  console.error(`sync-fonts: ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`sync-fonts: ${copied} copied, ${kept} up to date, in public/fonts`);
