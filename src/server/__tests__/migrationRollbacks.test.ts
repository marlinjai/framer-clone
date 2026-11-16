// Every hand-run rollback.sql beside a Prisma migration sets its own search path and names every object with its schema.
//
// Why: the operator runs these files by hand, as a superuser, with psql. Like every file the operator applies as a
// superuser (prisma/sql/commerce-roles.sql, box-reader.sql and its rollback and preflight), what they drop and delete
// must not depend on the session's search path, which differs between databases, rebuilds and sessions. The rehearsal
// in src/server/commerce/provisioning/__tests__/box-reader-roles.itest.ts runs one of them against a database where
// that matters; this test holds the shape of all of them, including the ones no container runs.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = path.resolve(__dirname, '../../../prisma/migrations');

const rollbacks = readdirSync(MIGRATIONS)
  .map((folder) => path.join(MIGRATIONS, folder, 'rollback.sql'))
  .filter((file) => existsSync(file))
  .map((file) => [path.relative(MIGRATIONS, file), readFileSync(file, 'utf8')] as const);

/** The file's statements, comment lines left out. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('the migrations\' rollback.sql files', () => {
  it('are found (the walk works)', () => {
    expect(rollbacks.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        '20261112200000_site_models/rollback.sql',
        '20261112300000_site_model_coordination/rollback.sql',
        '20261115000000_custom_code/rollback.sql',
      ]),
    );
  });

  it.each(rollbacks)('%s sets its own search path before any other statement', (_name, text) => {
    const first = code(text).split('\n').find((line) => line.trim() !== '');
    // Compared word by word (the line itself, written out here, would read as a runtime path change to lint:guards).
    expect(first?.trim().split(/\s+/)).toEqual(['SET', 'search_path', '=', 'pg_catalog,', 'pg_temp;']);
  });

  it.each(rollbacks)('%s names Prisma\'s history table and every changed object with its schema', (_name, text) => {
    const body = code(text);
    // Every mention of the history table carries the public schema.
    const history = [...body.matchAll(/(?:"?public"?\.)?"?_prisma_migrations"?/g)].map((match) => match[0]);
    expect(history.length).toBeGreaterThan(0);
    expect(history.filter((name) => !/^"?public"?\./.test(name))).toEqual([]);
    // Every catalog lookup is pg_catalog's own.
    const lookups = [...body.matchAll(/([A-Za-z_."]*)\bto_regclass\(/g)].map((match) => match[1]);
    expect(lookups.filter((prefix) => prefix !== 'pg_catalog.')).toEqual([]);
    // Every object a statement drops, alters, deletes from or writes to is named with its schema.
    const targets = [
      ...body.matchAll(/\b(?:DROP (?:TABLE|FUNCTION|INDEX|VIEW|TYPE|SEQUENCE)|ALTER TABLE|DELETE FROM|INSERT INTO|UPDATE)\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?([^\s(;]+)/g),
    ].map((match) => match[1]!);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((target) => !/^"?[a-z_]+"?\."?[A-Za-z_]+"?$/.test(target))).toEqual([]);
  });
});
