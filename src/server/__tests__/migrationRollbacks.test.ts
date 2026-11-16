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

/** A name with its schema: `schema.name`, either part quoted or not. */
const QUALIFIED = /^"?[a-z_]+"?\."?[A-Za-z_]+"?$/;

/**
 * Every object a statement drops, alters, empties, deletes from, writes to or reads from, as written. A schema a
 * statement drops is listed apart: it is never looked up through the search path, so it is a bare name.
 */
function objectsOf(sql: string): { relations: string[]; schemas: string[] } {
  const relations = [
    ...sql.matchAll(
      /\b(?:DROP (?:TABLE|FUNCTION|INDEX|VIEW|MATERIALIZED VIEW|TYPE|SEQUENCE)|ALTER TABLE|TRUNCATE(?: TABLE)?|DELETE FROM|INSERT INTO|UPDATE|FROM|JOIN)\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?([^\s(;,)]+)/g,
    ),
    ...sql.matchAll(/\bDROP TRIGGER\s+(?:IF EXISTS\s+)?\S+\s+ON\s+(?:ONLY\s+)?([^\s(;,)]+)/g),
  ]
    .map((match) => match[1]!)
    // `REVOKE ... FROM PUBLIC` names the role every role belongs to, not a relation.
    .filter((name) => name !== 'PUBLIC');
  const schemas = [...sql.matchAll(/\bDROP SCHEMA\s+(?:IF EXISTS\s+)?([^\s(;,)]+)/g)].map((match) => match[1]!);
  return { relations, schemas };
}

/** What `objectsOf` finds that is not named the way these files must name it. */
function misnamed(sql: string): string[] {
  const { relations, schemas } = objectsOf(sql);
  return [...relations.filter((name) => !QUALIFIED.test(name)), ...schemas.filter((name) => !/^"?[a-z_]+"?$/.test(name))];
}

describe('the detector of objects a rollback names', () => {
  it.each([
    ['DROP TABLE IF EXISTS "site_models";', ['"site_models"']],
    ['DROP TABLE IF EXISTS "public"."site_models";', []],
    ['ALTER TABLE ONLY site_models DROP COLUMN x;', ['site_models']],
    ['DELETE FROM "_prisma_migrations" WHERE a = 1;', ['"_prisma_migrations"']],
    ['DROP TRIGGER IF EXISTS t ON "site_models";', ['"site_models"']],
    ['DROP TRIGGER t ON "public"."site_models";', []],
    ['TRUNCATE site_models;', ['site_models']],
    ['TRUNCATE TABLE ONLY "public"."site_models";', []],
    ['SELECT 1 FROM site_models s JOIN sites t ON true;', ['site_models', 'sites']],
    ['SELECT 1 FROM information_schema.columns WHERE true;', []],
    ['DROP SCHEMA IF EXISTS "postgres" CASCADE;', []],
    ['DROP SCHEMA a.b;', ['a.b']],
    ['REVOKE ALL ON FUNCTION "public"."f"() FROM PUBLIC;', []],
  ])('%s', (sql, expected) => {
    expect(misnamed(sql)).toEqual(expected);
  });

  it('finds each kind of statement at all', () => {
    const { relations, schemas } = objectsOf(
      'DROP TRIGGER t ON public.a; TRUNCATE public.b; SELECT 1 FROM public.c JOIN public.d ON true; DROP SCHEMA e;',
    );
    expect(relations).toEqual(['public.b', 'public.c', 'public.d', 'public.a']);
    expect(schemas).toEqual(['e']);
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
    const first = code(text).split('\n').find((line) => line.trim() !== '');
    // Compared word by word (the line itself, written out here, would read as a runtime path change to lint:guards).
    expect(first?.trim().split(/\s+/)).toEqual(['SET', 'search_path', '=', 'pg_catalog,', 'pg_temp;']);
  });

  it.each(rollbacks)('%s names Prisma\'s history table and every object it touches with its schema', (_name, text) => {
    const body = code(text);
    // Every mention of the history table carries the public schema.
    const history = [...body.matchAll(/(?:"?public"?\.)?"?_prisma_migrations"?/g)].map((match) => match[0]);
    expect(history.length).toBeGreaterThan(0);
    expect(history.filter((name) => !/^"?public"?\./.test(name))).toEqual([]);
    // Every catalog lookup is pg_catalog's own.
    const lookups = [...body.matchAll(/([A-Za-z_."]*)\bto_regclass\(/g)].map((match) => match[1]);
    expect(lookups.filter((prefix) => prefix !== 'pg_catalog.')).toEqual([]);
    // Every object a statement drops, alters, empties, deletes from, writes to or reads from is named with its schema.
    expect(objectsOf(body).relations.length).toBeGreaterThan(0);
    expect(misnamed(body)).toEqual([]);
  });
});
