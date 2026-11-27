// Every function called in raw SQL on the Prisma client is schema-qualified (pg_catalog.<name>).
//
// Why: built-in functions are called by their schema-qualified name so that name resolution never depends on the
// session's search path (PostgreSQL 16 documentation, sections 5.9.3 and 10.3). This test keeps a new unqualified call
// from coming back.
//
// Scope: `$queryRaw`, `$executeRaw` and their `Unsafe` forms in non-test source under src/ and scripts/. SQL keywords
// that look like calls (IN, EXISTS, COALESCE, ...) and interpolations (`${...}`) are not function calls and are skipped.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

/** Syntax that is followed by `(` but is not a function looked up through the search path. */
const NOT_FUNCTIONS = new Set([
  'in', 'exists', 'values', 'coalesce', 'greatest', 'least', 'nullif', 'any', 'all', 'some', 'cast', 'filter', 'over',
  'as', 'from', 'join', 'on', 'and', 'or', 'not', 'where', 'select', 'using', 'row', 'array', 'extract', 'when', 'then',
  'else', 'case', 'by', 'set', 'into', 'returning', 'with', 'is', 'like', 'between', 'limit', 'offset', 'distinct',
  'update', 'delete', 'insert', 'union', 'except', 'intersect', 'lateral', 'grouping', 'interval', 'timestamp',
  'timestamptz', 'date', 'time', 'char', 'varchar', 'numeric', 'decimal', 'conflict', 'do', 'nothing', 'key',
]);

const SQL_TEMPLATE_START = /\$(?:queryRaw|executeRaw)(?:Unsafe)?(?:<[^`(]*?>)?\s*(?:\(\s*)?`/g;

/** Index just after the quoted JS string that opens at `i`. */
function skipQuoted(s: string, i: number): number {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === q) return j + 1;
  }
  return s.length;
}

/** Index just after the template literal that opens (backtick) at `i`, nested templates inside `${...}` included. */
function skipTemplate(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '`') return j + 1;
    else if (s[j] === '$' && s[j + 1] === '{') j = skipInterpolation(s, j) - 1;
  }
  return s.length;
}

/** Index just after the `${...}` that opens at `i`, matching braces and skipping strings and nested templates. */
function skipInterpolation(s: string, i: number): number {
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '`') j = skipTemplate(s, j) - 1;
    else if (c === "'" || c === '"') j = skipQuoted(s, j) - 1;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j + 1;
  }
  return s.length;
}

/** The raw SQL templates of one source file, each with its line number. */
export function rawSqlTemplates(source: string): { line: number; sql: string }[] {
  const out: { line: number; sql: string }[] = [];
  for (const m of source.matchAll(SQL_TEMPLATE_START)) {
    const open = m.index + m[0].length - 1;
    const end = skipTemplate(source, open);
    out.push({ line: source.slice(0, m.index).split('\n').length, sql: source.slice(open + 1, Math.max(open + 1, end - 1)) });
  }
  return out;
}

/** One token-aware pass: interpolations, comments, string literals and quoted names are blanked, the rest is kept. */
function maskSql(sql: string): string {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (c === '$' && sql[i + 1] === '{') { i = skipInterpolation(sql, i); out += ' '; }
    else if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; out += ' '; }
    else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === c) { if (sql[j + 1] === c) j++; else break; }
      }
      i = j + 1;
      out += c === "'" ? "''" : '"q"';
    } else { out += c; i++; }
  }
  return out;
}

/** Unqualified function calls in one SQL text. */
export function unqualifiedCalls(sql: string): string[] {
  const s = maskSql(sql);
  const found: string[] = [];
  for (const m of s.matchAll(/(?<![\w.$"])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (!NOT_FUNCTIONS.has(m[1].toLowerCase())) found.push(m[1]);
  }
  return found;
}

// Read from the folder, not from `git ls-files`: `pnpm verify` also runs on a copy of the worktree without .git.
function sourceFiles(): string[] {
  return ['src', 'scripts']
    .flatMap((root) => readdirSync(root, { recursive: true, encoding: 'utf8' }).map((f) => `${root}/${f}`))
    .filter((f) => !f.includes('node_modules/'))
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
    expect(unqualifiedCalls("SELECT '--', now()")).toEqual(['now']);
    expect(unqualifiedCalls("SELECT 1 -- it's a comment\n, now()")).toEqual(['now']);
    const nested = 'tx.$queryRaw`SELECT ${`site:${id}`}::text, now()`;';
    expect(rawSqlTemplates(nested)).toEqual([{ line: 1, sql: 'SELECT ${`site:${id}`}::text, now()' }]);
    expect(unqualifiedCalls(rawSqlTemplates(nested)[0].sql)).toEqual(['now']);
    expect(rawSqlTemplates('await tx.$queryRaw<{ n: bigint }[]>`SELECT now()`;')).toEqual([{ line: 1, sql: 'SELECT now()' }]);
    expect(rawSqlTemplates('await tx.$executeRawUnsafe(`SET LOCAL x = 1`);')).toEqual([{ line: 1, sql: 'SET LOCAL x = 1' }]);
  });
});
