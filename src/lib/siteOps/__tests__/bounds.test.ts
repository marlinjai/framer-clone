// Site operations come from outside the editor (company API keys through the MCP server), so every list in
// them is bounded: an oversized list is refused before its entries are checked (the Zod advisory
// GHSA-mrhx-c7xc-m3w5: without a bound, every failing entry costs an issue).

import { describe, expect, it } from 'vitest';

import { BatchSchema, MAX_BATCH_OPS, MAX_INSERT_NODES, OperationSchema } from '../types';

describe('site operation bounds', () => {
  it(`insertNodes takes up to ${MAX_INSERT_NODES} nodes and refuses more, quickly`, () => {
    const op = { op: 'insertNodes', pageId: 'p1' };
    expect(OperationSchema.safeParse({ ...op, nodes: Array.from({ length: MAX_INSERT_NODES }, () => ({ type: 'div' })) }).success).toBe(true);

    const started = performance.now();
    const result = OperationSchema.safeParse({ ...op, nodes: Array.from({ length: 100_000 }, () => ({ type: 'div' })) });
    expect(result.success).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it(`a batch takes up to ${MAX_BATCH_OPS} operations and refuses more`, () => {
    const batch = { siteId: 's1', expectedVersion: 1 };
    expect(BatchSchema.safeParse({ ...batch, ops: Array.from({ length: MAX_BATCH_OPS }, () => ({})) }).success).toBe(true);
    expect(BatchSchema.safeParse({ ...batch, ops: Array.from({ length: MAX_BATCH_OPS + 1 }, () => ({})) }).success).toBe(false);
  });
});
