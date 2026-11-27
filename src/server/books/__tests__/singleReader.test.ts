// One reader of the stored sender (docs/plans/2026-11-26-books-sender-from-contacts.md). A company linked to a
// sender contact must never print the stored block, so everything that needs the sender asks `resolveSender`.
// This fails when another module reads the stored block or its column.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

/** Who may name them, and why. */
const ALLOWED = new Set([
  'server/books/settings.ts', // reads and writes the row
  'server/books/sender.ts', // the one reader
  'server/books/senderLink.ts', // compares the two sources for the operator
  'server/books/initCompanyCli.ts', // reports which stored fields the operator set
  'server/commerce/db-types.ts', // generated column types
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'migrations' ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the stored sender block', () => {
  it('is read only by the modules that own it', () => {
    const readers = sources(SRC)
      .filter((path) => {
        const code = readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join('\n');
        return /\bstoredSenderBlock\b|\bsender_block\b/.test(code);
      })
      .map((path) => relative(SRC, path))
      .filter((path) => !ALLOWED.has(path));
    expect(readers).toEqual([]);
  });
});
