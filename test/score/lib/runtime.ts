// The behaviour runtime and its chunks as one plain script, for a score that runs stored
// behaviour on a static page. Not a Next build: `test/behaviour` proves those two meet, and
// a build per pattern would take an hour.

import path from 'node:path';
import type { BehaviourProgram } from '@/lib/behaviour/program';

/** Started as the island starts it, with both chunks already there. */
export async function bundleRuntime(): Promise<string> {
  // Loaded here, not at the top: a jsdom test that reads a fixture imports this file, and esbuild refuses to load under jsdom.
  const { build } = await import('esbuild');
  const bundled = await build({
    stdin: {
      contents: `
        import { startBehaviour } from '@/lib/behaviour/runtime';
        import { createRover } from '@/lib/behaviour/rove';
        import * as verbs from '@/lib/behaviour/verbs';
        window.__start = (program) => startBehaviour({ container: document, program, surface: 'published', verbs: verbs.createVerbs, extras: verbs, rove: createRover });
      `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    alias: { '@': path.resolve('src') },
    // `effect` reaches this with a dynamic import, which a plain script cannot split.
    external: ['@/lib/effects/runtime'],
  });
  return bundled.outputFiles[0].text;
}

/** The two script tags that run a page's program, where the page's markup ends. */
export function runtimeScripts(runtime: string, program: BehaviourProgram): string {
  const data = JSON.stringify(program).replace(/</g, '\\u003c');
  return `<script>${runtime.replace(/<\/script/gi, '<\\/script')}</script><script>window.__start(${data})</script>`;
}
