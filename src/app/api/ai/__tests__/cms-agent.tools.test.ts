// @vitest-environment node
//
// The CMS agent's tool input schemas bound every id list the model writes, so an oversized list is refused
// before its entries are checked (the Zod advisory GHSA-mrhx-c7xc-m3w5: without a bound, every failing
// entry costs an issue).

import { describe, expect, it } from 'vitest';

import { toolInputSchemas } from '../cms-agent/tools';

describe('CMS agent tool input bounds', () => {
  it('generate_content takes up to 200 target columns and refuses more, quickly', () => {
    const base = { tableId: 't1', prompt: 'greetings', count: 1 };
    const ok = Array.from({ length: 200 }, (_, i) => `c${i}`);
    expect(toolInputSchemas.generate_content.safeParse({ ...base, targetColumns: ok }).success).toBe(true);

    // Every entry also fails its own check (not a string): the bound is read before the entries are.
    const oversized = Array.from({ length: 100_000 }, () => 0);
    const started = performance.now();
    const result = toolInputSchemas.generate_content.safeParse({ ...base, targetColumns: oversized });
    expect(result.success).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it.each([
    ['bulk_create_rows', 'rows', 500, { tableId: 't1' }],
    ['bulk_archive_rows', 'rowIds', 500, {}],
    ['bulk_update_status', 'rowIds', 500, { status: 'done' }],
    ['translate_field', 'rowIds', 200, { tableId: 't1', columnId: 'c1', targetLanguage: 'de' }],
  ] as const)('%s: %s takes at most %d entries', (tool, field, max, rest) => {
    const entry = field === 'rows' ? {} : 'r';
    const schema = toolInputSchemas[tool];
    expect(schema.safeParse({ ...rest, [field]: Array.from({ length: max }, () => entry) }).success).toBe(true);
    expect(schema.safeParse({ ...rest, [field]: Array.from({ length: max + 1 }, () => entry) }).success).toBe(false);
  });
});
