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
const QUALIFIED = /^(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)$/;

/** Splits a list of names on the commas that are not inside parentheses (a function's argument types). */
function splitNames(list: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      names.push(current);
      current = '';
    } else current += char;
  }
  names.push(current);
  // The name only: a function's argument list is not part of it.
  return names.map((name) => name.trim().replace(/^ONLY\s+/i, '').replace(/\s*\([\s\S]*$/, ''));
}

/** A name as written: quoted (spaces allowed inside the quotes) or bare, either part. */
const NAME = String.raw`(?:"[^"]+"|[^\s(;,)."]+)(?:\.(?:"[^"]+"|[^\s(;,)."]+))?`;

/**
 * The text with comments and string literals blanked, in one left-to-right pass so a quote inside a comment and a
 * comment marker inside a string are each read as what they are: `--` to the end of the line, `/* ... *\/`, an escape
 * string `E'...'` (backslash escapes) and a plain string (doubled quotes). Dollar-quoted bodies stay: they are code.
 */
function blanked(text: string): string {
  return text.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|[Ee]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'/g, (token) =>
    token.startsWith('--') || token.startsWith('/*') ? ' ' : "''",
  );
}

/** A table reference in a FROM or USING list: the name, then an optional alias. */
const REFERENCE = String.raw`${NAME}(?:\s+(?:AS\s+)?(?!(?:WHERE|JOIN|ON|LEFT|RIGHT|INNER|FULL|CROSS|GROUP|ORDER|LIMIT|USING|RETURNING)\b)\w+)?`;

/** The names of a FROM or USING list, aliases left out. */
function referencesOf(list: string): string[] {
  return splitNames(list).map((reference) => reference.match(new RegExp(`^${NAME}`))![0]);
}

/**
 * Every object a statement drops, alters, empties, deletes from, writes to or reads from, as written, in any letter
 * case and with every name of a list. Comments and string literals are blanked first, so words in a message are not
 * read as SQL; dynamic SQL (`EXECUTE` of a string) cannot be read at all, so it is reported as a name of its own.
 * `FROM` inside the calls that take it as a keyword (extract, substring, trim, overlay, position) and in `REVOKE`
 * is not a relation. A schema a statement drops is listed apart: it is never looked up through the search path, so it
 * is a bare name.
 */
function objectsOf(text: string): { relations: string[]; schemas: string[] } {
  const sql = blanked(text);
  const single = [
    ...sql.matchAll(
      new RegExp(String.raw`\b(?:ALTER TABLE|INSERT INTO|UPDATE)\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?(${NAME})`, 'gi'),
    ),
    ...sql.matchAll(
      new RegExp(String.raw`\bDROP (?:TRIGGER|POLICY|RULE)\s+(?:IF EXISTS\s+)?${NAME}\s+ON\s+(?:ONLY\s+)?(${NAME})`, 'gi'),
    ),
    ...sql.matchAll(new RegExp(String.raw`\bFROM\s*\(\s*TABLE\s+(${NAME})`, 'gi')),
  ].map((match) => match[1]!);
  // FROM, JOIN and USING lists: every table of the list.
  const referenced = [
    ...sql.matchAll(
      new RegExp(
        String.raw`(?<!\b(?:extract|substring|trim|overlay|position)\s*\([^()]*)(?<!\bREVOKE\b[^;]*)\b(?:FROM|JOIN|(?<=\bDELETE\s+FROM\b[^;]*)USING)\s+(?:ONLY\s+)?(${REFERENCE}(?:\s*,\s*${REFERENCE})*)`,
        'gi',
      ),
    ),
  ].flatMap((match) => referencesOf(match[1]!));
  // Statements that take a list of names: every name of the list, not only the first.
  const listed = [
    ...sql.matchAll(
      /\b(?:DROP (?:TABLE|INDEX(?: CONCURRENTLY)?|VIEW|MATERIALIZED VIEW|TYPE|SEQUENCE|FUNCTION)|TRUNCATE(?: TABLE)?)\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?([^;]+?)(?:\s+(?:CASCADE|RESTRICT|RESTART IDENTITY|CONTINUE IDENTITY))*\s*(?:;|$)/gi,
    ),
  ].flatMap((match) => splitNames(match[1]!));
  const dynamic = [...sql.matchAll(/\bEXECUTE\s+(?!ON\b)/gi)].map(() => 'EXECUTE (dynamic SQL)');
  const relations = [...single, ...referenced, ...listed, ...dynamic]
    // `... FROM PUBLIC` names the role every role belongs to, not a relation.
    .filter((name) => name.toUpperCase() !== 'PUBLIC');
  const schemas = [...sql.matchAll(/\bDROP SCHEMA\s+(?:IF EXISTS\s+)?([^;]+?)(?:\s+(?:CASCADE|RESTRICT))?\s*(?:;|$)/gi)].flatMap(
    (match) => splitNames(match[1]!),
  );
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
    ['DROP TABLE IF EXISTS "public"."a", b CASCADE;', ['b']],
    ['drop table if exists site_models;', ['site_models']],
    ['delete from "_prisma_migrations" where a = 1;', ['"_prisma_migrations"']],
    ['DROP POLICY IF EXISTS p ON site_models;', ['site_models']],
    ['DROP RULE r ON "public"."site_models";', []],
    ['DELETE FROM "public"."a" USING b WHERE true;', ['b']],
    ['TRUNCATE "public"."a", b RESTART IDENTITY CASCADE;', ['b']],
    ['DROP SCHEMA IF EXISTS x, a.b CASCADE;', ['a.b']],
    ['revoke all on function "public"."f"() from public;', []],
    ['DROP FUNCTION "public"."f"(text, text), g(int);', ['g']],
    ['DROP FUNCTION IF EXISTS "public"."box_document"(pg_catalog.text, pg_catalog.text);', []],
    ['DROP POLICY "a b" ON x;', ['x']],
    ['DROP INDEX CONCURRENTLY IF EXISTS i;', ['i']],
    ['ALTER TABLE "public"."a" ALTER COLUMN c TYPE text USING c::text;', []],
    ['SELECT extract(epoch from now()) FROM "public"."a";', []],
    ["DO $$ BEGIN RAISE NOTICE 'nothing to update from here'; END $$;", []],
    ['DO $$ BEGIN IF EXISTS (SELECT FROM site_models) THEN NULL; END IF; END $$;', ['site_models']],
    ['SELECT 1 WHERE EXISTS (SELECT FROM c);', ['c']],
    ["DROP TABLE public.a; -- don't\nDROP TABLE b;\nSELECT 'x';", ['b']],
    ["/* it's */ DROP TABLE b;", ['b']],
    ["SELECT E'it\\'s'; DROP TABLE b;", ['b']],
    ["DO $$ BEGIN EXECUTE 'DELETE FROM sites'; END $$;", ['EXECUTE (dynamic SQL)']],
    ['SELECT 1 FROM "public"."a" x, b y WHERE true;', ['b']],
    ['DELETE FROM "public"."a" USING "public"."b", c WHERE true;', ['c']],
    ['SELECT 1 FROM (TABLE x) t;', ['x']],
    ['REVOKE ALL ON FUNCTION "public"."f"() FROM box_reader;', []],
    ['DROP TABLE IF EXISTS "public"."t2";', []],
    ["SELECT '-- not a comment' FROM t;", ['t']],
    ['GRANT EXECUTE ON FUNCTION "public"."f"() TO box_reader;', []],
  ])('%s', (sql, expected) => {
    expect(misnamed(sql)).toEqual(expected);
  });

  it('finds each kind of statement at all', () => {
    const { relations, schemas } = objectsOf(
      'DROP TRIGGER t ON public.a; TRUNCATE public.b; SELECT 1 FROM public.c JOIN public.d ON true; DROP SCHEMA e;',
    );
    expect([...relations].sort()).toEqual(['public.a', 'public.b', 'public.c', 'public.d']);
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
