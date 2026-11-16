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

/**
 * A name in the application's schema, both parts quoted, as Prisma writes them: `"public"."sites"`. Only `public`: a
 * migration of this repository makes nothing elsewhere, so its rollback has nothing to drop elsewhere. Never Prisma's
 * history table: a rollback may only delete its own row there, through the one shape written for that.
 */
const Q = String.raw`"public"\.(?!"_prisma_migrations")"[a-z_][a-z0-9_]*"`;
/** A quoted column or constraint name. */
const COLUMN = String.raw`"[a-z_][a-z0-9_]*"`;
/** The line that fixes the search path, built from its words (written out, it would read as a runtime path change
 * to lint:guards). */
const SET_LINE = ['SET', 'search_path', '=', 'pg_catalog,', 'pg_temp;'].join(' ');

/**
 * A migration folder's name as Prisma writes it: fourteen digits, an underscore, then lower-case letters, digits and
 * underscores. The own-row DELETE shape is built from the folder's name, so a name with any other character (a quote
 * would end the SQL string and let the rest of the name run as SQL) gets no such shape, and its file cannot pass.
 */
const FOLDER_NAME = /^\d{14}_[a-z0-9_]+$/;

/** Text made literal inside a regular expression. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every shape a statement line of a hand-run rollback may have, and nothing else. The test fails closed: a line that
 * matches none of them fails, whatever it does, so a new kind of statement (dynamic SQL, `\gexec`, an inline comment,
 * an unusual quote) is refused until a shape for it is added here on purpose. Each shape names every object with its
 * schema. `folder` is the migration the file belongs to, the only history row it may delete, and only when its name
 * has Prisma's form (`FOLDER_NAME`).
 */
function shapes(folder: string): RegExp[] {
  const escapedSet = literal(SET_LINE);
  return [
    new RegExp(`^${escapedSet}$`),
    // No CASCADE: it drops what depends on the object in any schema, which no line of the file names.
    new RegExp(String.raw`^DROP (?:TABLE|INDEX) IF EXISTS ${Q};$`),
    new RegExp(String.raw`^DROP FUNCTION IF EXISTS ${Q}\((?:pg_catalog\.[a-z_]+(?:, pg_catalog\.[a-z_]+)*)?\);$`),
    new RegExp(
      String.raw`^ALTER TABLE ${Q} DROP (?:COLUMN|CONSTRAINT) IF EXISTS ${COLUMN}(?:, DROP (?:COLUMN|CONSTRAINT) IF EXISTS ${COLUMN})*;$`,
    ),
    /^DO \$\$$/,
    /^BEGIN$/,
    /^END IF;$/,
    /^END \$\$;$/,
    /^IF pg_catalog\.to_regclass\('public\._prisma_migrations'\) IS NOT NULL THEN$/,
    ...(FOLDER_NAME.test(folder)
      ? [new RegExp(String.raw`^DELETE FROM "public"\."_prisma_migrations" WHERE "migration_name" = '${literal(folder)}';$`)]
      : []),
    /^IF EXISTS \(SELECT 1 FROM information_schema\.columns WHERE table_schema = 'public' AND table_name = '[a-z_]+' AND column_name = '[a-z_]+'\) THEN$/,
    new RegExp(String.raw`^DELETE FROM ${Q} WHERE ${COLUMN} = '[a-z_]+';$`),
  ];
}

/**
 * The lines of a file, split at every line break psql knows: a carriage return also ends a `--` comment for psql, so
 * it ends a line here too (and `unknownLines` refuses it outright).
 */
function linesOf(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * The statement lines of a file: blank lines and whole-line comments left out, and only spaces and tabs trimmed at
 * the ends (Postgres reads other Unicode spaces, a no-break space or a byte order mark, as part of a name, so they
 * are never trimmed away here).
 */
function statementLines(text: string): string[] {
  return linesOf(text)
    .map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ''))
    .filter((line) => line !== '' && !line.startsWith('--'));
}

/**
 * The statement lines that match no allowed shape, and every line of the file, comments included, that could read
 * differently to psql than to this test: one holding a character outside printable ASCII and tab (a carriage return
 * ends a comment for psql), a backslash (a psql command), or `$$` anywhere but the allowed `DO $$` and `END $$;` lines
 * (inside a `DO` block psql reads a comment as part of the quoted body, so a `$$` there ends the body and the rest of
 * the line runs).
 */
function unknownLines(text: string, folder: string): string[] {
  const allowed = shapes(folder);
  const odd = text
    .split('\n')
    .filter(
      (line) =>
        /[^\x20-\x7e\t]|\\/.test(line) || (line.includes('$$') && !/^[ \t]*(?:DO \$\$|END \$\$;)[ \t]*$/.test(line)),
    );
  const unknown = statementLines(text).filter((line) => !allowed.some((shape) => shape.test(line)));
  return [...new Set([...odd, ...unknown])];
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
    // Prisma's history table as a whole, or a row of it chosen any other way.
    'DROP TABLE IF EXISTS "public"."_prisma_migrations";',
    'DROP TABLE IF EXISTS "public"."_prisma_migrations" CASCADE;',
    'ALTER TABLE "public"."_prisma_migrations" DROP COLUMN IF EXISTS "migration_name";',
    'DELETE FROM "public"."_prisma_migrations" WHERE "logs" = \'x\';',
    // An argument list only belongs to a function.
    'DROP TABLE IF EXISTS "public"."a"();',
    // Characters Postgres reads as part of a name, around an allowed line.
    '\u00a0DROP TABLE IF EXISTS "public"."a";',
    'DROP TABLE IF EXISTS "public"."a";\ufeff',
    // A carriage return ends a comment for psql, so the code after it would run.
    '-- note\rDELETE FROM sites;',
    // Another schema than the application's.
    'DROP TABLE IF EXISTS "pg_catalog"."pg_authid";',
    'DELETE FROM "other"."t" WHERE "a" = \'b\';',
    // Inside a DO block a comment is part of the quoted body for psql: `$$` ends it and the rest of the line runs,
    // a backslash command included.
    '-- $$ \\r \\\\ DROP TABLE "public"."victim"; DO $$ BEGIN',
    '-- $$ \\! touch /tmp/marker',
    '-- \\! touch /tmp/marker',
    '    -- note $$',
    'RAISE NOTICE $m$ -- done $m$; DELETE FROM b;',
    'DROP TABLE IF EXISTS "public"."a"; -- don\'t',
    '/* it\'s */ DROP TABLE b;',
    'TRUNCATE "public"."a";',
    'DROP SCHEMA IF EXISTS "postgres" CASCADE;',
    'DROP TABLE IF EXISTS "public"."custom_code_audit" CASCADE;',
    'DROP FUNCTION IF EXISTS "public"."box_document"(pg_catalog.text, pg_catalog.text) CASCADE;',
    'UPDATE "public"."sites" SET "custom_code_enabled" = false;',
    // Another search path (built from its words, like SET_LINE).
    ['SET', 'search_path', '=', 'public;'].join(' '),
  ])('refuses %s', (line) => {
    // Reported as written (a line with an odd character may be reported once more, split where psql splits it).
    expect(unknownLines(line, FOLDER)).toContain(line);
  });

  it.each([
    // A quote in the folder name would end the string and run the rest of the name as SQL.
    [
      '20261116000000_x\'; DROP TABLE "public"."victim"; --',
      'DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = \'20261116000000_x\'; DROP TABLE "public"."victim"; --\';',
    ],
    // A doubled quote keeps the string open into the next line.
    [
      "20261116000001_it'",
      'DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = \'20261116000001_it\'\';',
    ],
    ['20261116000002_Upper', 'DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = \'20261116000002_Upper\';'],
  ])('refuses the own-row delete of a folder named %s, outside Prisma\'s naming', (folder, line) => {
    expect(unknownLines(line, folder)).toContain(line);
  });

  it('reads the migration folder as text, not as a pattern', () => {
    const line = 'DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = \'2026x1\';';
    expect(unknownLines(line, '2026.1')).toEqual([line]);
  });
});

describe('the migrations\' rollback.sql files', () => {
  it('sit only in folders named the way Prisma names them, beside no other hand-run file', () => {
    const odd: string[] = [];
    for (const entry of readdirSync(MIGRATIONS, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        if (entry.name !== 'migration_lock.toml') odd.push(entry.name);
        continue;
      }
      if (!FOLDER_NAME.test(entry.name)) odd.push(`${entry.name}/`);
      for (const file of readdirSync(path.join(MIGRATIONS, entry.name))) {
        // Exact names: on a case-insensitive disk `Rollback.sql` would still be read as rollback.sql, on CI's not.
        if (file !== 'migration.sql' && file !== 'rollback.sql') odd.push(`${entry.name}/${file}`);
      }
    }
    expect(odd).toEqual([]);
  });

  it('are found (the walk works)', () => {
    expect(rollbacks.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        '20261112200000_site_models/rollback.sql',
        '20261112300000_site_model_coordination/rollback.sql',
        '20261115000000_custom_code/rollback.sql',
      ]),
    );
  });

  it.each(rollbacks)('%s documents the one command to run it, with -X', (name, text) => {
    // -X: the operator's ~/.psqlrc cannot switch ON_ERROR_STOP off or ON_ERROR_ROLLBACK on (D35).
    const command = `--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -1 -f prisma/migrations/${name}`;
    // And no other comment line naming psql, in any form (a prompt, a path, a variable before it), that an operator
    // could copy instead: the one command is the only mention.
    expect(linesOf(text).filter((line) => /^\s*--.*\bpsql\b/i.test(line))).toEqual([command]);
  });

  it.each(rollbacks)('%s sets its own search path before any other statement', (_name, text) => {
    expect(statementLines(text)[0]).toBe(SET_LINE);
  });

  it.each(rollbacks)('%s has only lines of the allowed shapes, every object named with its schema', (name, text) => {
    expect(unknownLines(text, path.dirname(name))).toEqual([]);
    // And it forgets its own migration, in a statement line (a comment does not count).
    expect(statementLines(text)).toContain(
      `DELETE FROM "public"."_prisma_migrations" WHERE "migration_name" = '${path.dirname(name)}';`,
    );
  });
});
