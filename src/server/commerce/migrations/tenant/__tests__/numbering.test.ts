import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMERCE_TENANT_MIGRATIONS } from '../index';

// The tenant migrations run in the order of their ids, and every company schema records the ids it
// has applied. Two branches that each add the next number (031 twice, 2026-11-23: the session pin and
// the form notification mail) would both pass on their own and break the order once both land. This
// test makes the second one fail on its own branch after a rebase.

const dir = join(__dirname, '..');
const files = readdirSync(dir)
  .filter((f) => /^\d{3}_.+\.ts$/.test(f))
  .sort();
const ids = COMMERCE_TENANT_MIGRATIONS.map((m) => m.id);
const number = (name: string) => name.slice(0, 3);

describe('commerce tenant migration numbering', () => {
  it('gives every migration file its own number', () => {
    const numbers = files.map(number);
    const repeated = numbers.filter((n, i) => numbers.indexOf(n) !== i);
    expect(repeated, `files sharing a number: ${files.filter((f) => repeated.includes(number(f))).join(', ')}`).toEqual([]);
  });

  it('numbers the files without a gap, from 000', () => {
    expect(files.map(number)).toEqual(files.map((_, i) => String(i).padStart(3, '0')));
  });

  it('lists every file once, in order, under the id of its file name', () => {
    expect(ids).toEqual(files.map((f) => f.replace(/\.ts$/, '')));
  });
});
