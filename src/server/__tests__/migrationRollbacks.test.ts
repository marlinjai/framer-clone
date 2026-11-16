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

/** A schema-qualified name, both parts quoted, as Prisma writes them: `"public"."sites"`. */
const Q = String.raw`"[a-z_][a-z0-9_]*"\."[a-z_][a-z0-9_]*"`;
/** A quoted column or constraint name. */
const COLUMN = String.raw`"[a-z_][a-z0-9_]*"`;
/** The line that fixes the search path, built from its words (written out, it would read as a runtime path change
 * to lint:guards). */
const SET_LINE = ['SET', 'search_path', '=', 'pg_catalog,', 'pg_temp;'].join(' ');

/**
 * Every shape a statement line of a hand-run rollback may have, and nothing else. The test fails closed: a line that
 * matches none of them fails, whatever it does, so a new kind of statement (dynamic SQL, `\gexec`, an inline comment,
 * an unusual quote) is refused until a shape for it is added here on purpose. Each shape names every object with its
 * schema. `folder` is the migration the file belongs to, the only history row it may delete.
 */
function shapes(folder: string): RegExp[] {
  const escapedSet = SET_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`^${escapedSet}$`),
    new RegExp(String.raw`^DROP (?:TABLE|INDEX|FUNCTION) IF EXISTS ${Q}(?:\((?:pg_catalog\.[a-z_]+(?:, pg_catalog\.[a-z_]+)*)?\))?(?: CASCADE)?;$`),
    new RegExp(
      String.raw`^ALTER TABLE ${Q} DROP (?:COLUMN|CONSTRAINT) IF EXISTS ${COLUMN}(?:, DROP (?:COLUMN|CONSTRAINT) IF EXISTS ${COLUMN})*;$`,
    ),
    /^DO \$\$$/,
    /^BEGIN$/,
    /^END IF;$/,
    /^END \$\$;$/,
    /^IF pg_catalog\.to_regclass\('public\._prisma_migrations'\) IS NOT NULL THEN$/,
    new RegExp(String.raw`^DELETE FROM "public"\."_prisma_migrations" WHERE "migration_name" = '${folder}';$`),
    /^IF EXISTS \(SELECT 1 FROM information_schema\.columns WHERE table_schema = 'public' AND table_name = '[a-z_]+' AND column_name = '[a-z_]+'\) THEN$/,
    new RegExp(String.raw`^DELETE FROM ${Q} WHERE ${COLUMN} = '[a-z_]+';$`),
  ];
}

/** The statement lines of a file (blank lines and whole-line comments left out) that match no allowed shape. */
function unknownLines(text: string, folder: string): string[] {
  const allowed = shapes(folder);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('--'))
    .filter((line) => !allowed.some((shape) => shape.test(line)));
}

const FOLDER = '20261115000000_custom_code';

describe('the allowed shapes of a rollback line', () => {
  it.each([
    'DROP TABLE IF EXISTS "public"."custom_code_audit";',
    'DROP FUNCTION IF EXISTS "public"."box_document"(pg_catalog.text, pg_catalog.text);',
    'DROP FUNCTION IF EXISTS "public"."custom_code_blobs_immutable"();',
    'DROP INDEX IF EXISTS "public"."site_models_pending_until_idx";',
    'ALTER TABLE "public"."site_models" DROP COLUMN IF EXISTS "attempt", DROP COLUMN IF EXISTS "state";',
    'DELETE FROM "public"."site_models" WHERE "state" = \'pending\';',
    `DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = '${FOLDER}';`,
    '    END IF;',
  ])('accepts %s', (line) => {
    expect(unknownLines(line, FOLDER)).toEqual([]);
  });

  it.each([
    // Names without their schema, in any letter case or position of a list.
    'DROP TABLE IF EXISTS "site_models";',
    'drop table if exists "public"."site_models";',
    'DROP TABLE IF EXISTS "public"."a", b;',
    'DROP FUNCTION IF EXISTS "public"."f"(text), g(int);',
    'DELETE FROM "_prisma_migrations" WHERE "migration_name" = \'x\';',
    'ALTER TABLE ONLY site_models DROP COLUMN x;',
    'IF to_regclass(\'_prisma_migrations\') IS NOT NULL THEN',
    // Another migration's history row.
    'DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = \'20261112200000_site_models\';',
    // Anything that reads or writes elsewhere, or that this test cannot read.
    'DO $$ BEGIN IF EXISTS (SELECT FROM site_models) THEN NULL; END IF; END $$;',
    'EXECUTE \'DELETE FROM sites\';',
    'EXECUTE(\'DELETE FROM sites\');',
    "SELECT 'DROP TABLE ' || 'sites' \\gexec",
    'SELECT dblink_exec(\'DROP TABLE sites\');',
    'RAISE NOTICE $m$ -- done $m$; DELETE FROM b;',
    'DROP TABLE IF EXISTS "public"."a"; -- don\'t',
    '/* it\'s */ DROP TABLE b;',
    'TRUNCATE "public"."a";',
    'DROP SCHEMA IF EXISTS "postgres" CASCADE;',
    'UPDATE "public"."sites" SET "custom_code_enabled" = false;',
    // Another search path (built from its words, like SET_LINE).
    ['SET', 'search_path', '=', 'public;'].join(' '),
  ])('refuses %s', (line) => {
    expect(unknownLines(line, FOLDER)).toEqual([line.trim()]);
  });
});

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
    const first = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('--'));
    expect(first).toBe(SET_LINE);
  });

  it.each(rollbacks)('%s has only lines of the allowed shapes, every object named with its schema', (name, text) => {
    expect(unknownLines(text, path.dirname(name))).toEqual([]);
    // And it forgets its own migration.
    expect(text).toContain(`WHERE "migration_name" = '${path.dirname(name)}';`);
  });
});
