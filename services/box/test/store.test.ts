import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The statements the box sends name every object with its schema (plan, decision D33). The role's search path is
// pg_catalog only, which already hides `public`; this pins the qualifiers themselves, so that neither guard depends on
// the other. Read from the source: the two statements are the box's whole use of the database.

const source = readFileSync(path.join(__dirname, '../src/store.ts'), 'utf8');
/** Every tagged statement (`sql\`...\`` or `sql<...>\`...\``) in the store, with its interpolations blanked. */
const statements = [...source.matchAll(/\bsql(?:<[^`]*?>)?`([^`]*)`/g)].map((match) => match[1]!.replace(/\$\{[^}]*\}/g, '$'));

describe('the statements of the store', () => {
  it('are the lookup and the health check, and nothing else', () => {
    expect(statements).toHaveLength(2);
    expect(statements.every((text) => text.includes('box_document('))).toBe(true);
  });

  it('call box_document only as public.box_document', () => {
    for (const text of statements) {
      const calls = [...text.matchAll(/([\w.]*)box_document\(/g)].map((match) => match[1]);
      expect(calls.length, text).toBeGreaterThan(0);
      expect(calls.every((prefix) => prefix === 'public.'), text).toBe(true);
    }
  });

  it('call to_json only as pg_catalog.to_json', () => {
    const calls = statements.flatMap((text) => [...text.matchAll(/([\w.]*)to_json\(/g)].map((match) => match[1]));
    expect(calls).toEqual(['pg_catalog.', 'pg_catalog.']);
  });

  it('call no other function without a schema', () => {
    // Words directly followed by "(" that are not one of the two qualified calls (keywords such as FROM never are).
    const unqualified = statements.flatMap((text) =>
      [...text.matchAll(/(^|[^\w.])([a-z_][\w]*)\s*\(/gi)].map((match) => match[2]!.toLowerCase()),
    );
    expect(unqualified).toEqual([]);
  });
});
