// @vitest-environment node
//
// The broker is a lazy chunk of the behaviour runtime (slice C3 of the sandboxed custom
// code plan): a page without a block must load none of it. One static import anywhere in
// the application would put it in a shared bundle, so the only place that names it is
// BehaviourIsland's dynamic import, behind `program.broker`.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../..');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sources(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|itest)\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('the custom code broker', () => {
  it('is named only by BehaviourIsland, as a dynamic import behind program.broker', () => {
    const naming = sources(SRC).filter((file) => /customCode\/broker['"]/.test(fs.readFileSync(file, 'utf8')));
    expect(naming.map((file) => path.relative(SRC, file))).toEqual([path.join('lib', 'renderer', 'server', 'BehaviourIsland.tsx')]);
    const island = fs.readFileSync(naming[0], 'utf8');
    expect(island).toMatch(/program\.broker \? import\('@\/lib\/customCode\/broker'\)/);
    expect(island).not.toMatch(/^import [^;]*customCode\/broker/m);
  });
});
