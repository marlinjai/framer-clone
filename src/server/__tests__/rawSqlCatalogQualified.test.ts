// Every function called in raw SQL on the Prisma client is schema-qualified (pg_catalog.<name>).
//
// Why: built-in functions are called by their schema-qualified name so that name resolution never depends on the
// session's search path (PostgreSQL 16 documentation, sections 5.9.3 and 10.3). This test keeps a new unqualified call
// from coming back.
//
// Scope: `$queryRaw`, `$executeRaw` and their `Unsafe` forms in non-test source under src/ and scripts/. SQL keywords
// that look like calls (IN, EXISTS, COALESCE, ...) and interpolations (`${...}`) are not function calls and are skipped.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Syntax that is followed by `(` but is not a function looked up through the search path. */
const NOT_FUNCTIONS = new Set([
  'in', 'exists', 'values', 'coalesce', 'greatest', 'least', 'nullif', 'any', 'all', 'some', 'cast', 'filter', 'over',
  'as', 'from', 'join', 'on', 'and', 'or', 'not', 'where', 'select', 'using', 'row', 'array', 'extract', 'when', 'then',
  'else', 'case', 'by', 'set', 'into', 'returning', 'with', 'is', 'like', 'between', 'limit', 'offset', 'distinct',
  'update', 'delete', 'insert', 'union', 'except', 'intersect', 'lateral', 'grouping', 'interval', 'timestamp',
  'timestamptz', 'date', 'time', 'char', 'varchar', 'numeric', 'decimal', 'conflict', 'do', 'nothing', 'key',
]);

const SQL_TEMPLATE = /\$(?:queryRaw|executeRaw)(?:Unsafe)?(?:<[^`(]*?>)?\s*(?:\(\s*)?`((?:[^`\\]|\\.)*)`/g;

/** The raw SQL templates of one source file, each with its line number. */
export function rawSqlTemplates(source: string): { line: number; sql: string }[] {
  const out: { line: number; sql: string }[] = [];
  for (const m of source.matchAll(SQL_TEMPLATE)) {
    out.push({ line: source.slice(0, m.index).split('\n').length, sql: m[1] });
  }
  return out;
}

/** Unqualified function calls in one SQL text: interpolations, comments, string literals and quoted names blanked first. */
export function unqualifiedCalls(sql: string): string[] {
  let s = sql;
  // Interpolations, innermost braces first so nested template literals inside `${...}` disappear too.
  for (let prev = ''; prev !== s; ) { prev = s; s = s.replace(/\$\{[^{}]*\}/g, ' $1 '); }
  s = s.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '"q"');
  const found: string[] = [];
  for (const m of s.matchAll(/(?<![\w.$"])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (!NOT_FUNCTIONS.has(m[1].toLowerCase())) found.push(m[1]);
  }
  return found;
}

function sourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--', 'src', 'scripts'], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((f) => /\.(ts|tsx|mjs|cjs|js)$/.test(f))
    .filter((f) => !/(__tests__\/|\.test\.|\.itest\.|\.spec\.)/.test(f));
}

describe('raw SQL on the Prisma client calls only schema-qualified functions', () => {
  it('finds no unqualified function call in any raw SQL template', () => {
    const offenders: string[] = [];
    let templates = 0;
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('$queryRaw') && !source.includes('$executeRaw')) continue;
      for (const t of rawSqlTemplates(source)) {
        templates++;
        for (const name of unqualifiedCalls(t.sql)) offenders.push(`${file}:${t.line} ${name}(...)`);
      }
    }
    expect(templates, 'the scan found the raw SQL it is meant to guard').toBeGreaterThan(20);
    expect(offenders, 'qualify these as pg_catalog.<name>(...)').toEqual([]);
  });

  it('catches the shapes it is meant to catch, and leaves keywords, interpolations and qualified calls alone', () => {
    expect(unqualifiedCalls('SELECT pg_advisory_xact_lock(hashtext(${key}))')).toEqual(['pg_advisory_xact_lock', 'hashtext']);
    expect(unqualifiedCalls('SELECT 1 FROM t WHERE lower(name) = lower(${n})')).toEqual(['lower', 'lower']);
    expect(unqualifiedCalls('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`a:${b}`}))')).toEqual([]);
    expect(unqualifiedCalls("SELECT id FROM public.sites WHERE id IN (${Prisma.join(ids)}) AND status IN ('a', 'b')")).toEqual([]);
    expect(unqualifiedCalls('SELECT COALESCE(pg_catalog.sum(x), 0), pg_catalog.count(*) FILTER (WHERE y) FROM t')).toEqual([]);
    expect(unqualifiedCalls("SELECT 'now()' AS s, \"weird(\" FROM t -- count(*)\n")).toEqual([]);
    expect(rawSqlTemplates('await tx.$queryRaw<{ n: bigint }[]>`SELECT now()`;')).toEqual([{ line: 1, sql: 'SELECT now()' }]);
    expect(rawSqlTemplates('await tx.$executeRawUnsafe(`SET LOCAL x = 1`);')).toEqual([{ line: 1, sql: 'SET LOCAL x = 1' }]);
  });
});
