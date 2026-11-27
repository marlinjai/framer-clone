// @vitest-environment node
//
// The takedown's report of rows a personal-data erase rewrote a hash into (D117): read after the takedown, it never
// throws, so a failed read can never undo or hide a takedown that already committed.

import { describe, expect, it, vi } from 'vitest';
import { readRewrittenRows } from '@/server/customCode/takedown';

describe('readRewrittenRows', () => {
  it('answers null and logs when the read fails, instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = { customCodeAudit: { findMany: vi.fn().mockRejectedValue(new Error('statement timeout')) } };
    expect(await readRewrittenRows('a'.repeat(64), failing as never)).toBeNull();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('dedupes lines in memory and asks for one more line than it keeps', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { siteId: 's1', sha256: 'b'.repeat(64) },
      { siteId: 's1', sha256: 'b'.repeat(64) },
    ]);
    const blobs = vi.fn().mockResolvedValue([{ siteId: 's1', sha256: 'b'.repeat(64), blockedAt: null }]);
    const listed = vi.fn().mockResolvedValue([]);
    const prisma = { customCodeAudit: { findMany }, customCodeBlob: { findMany: blobs }, customCodeBlockedHash: { findMany: listed } };
    expect(await readRewrittenRows('a'.repeat(64), prisma as never)).toEqual({ rows: [{ siteId: 's1', sha256: 'b'.repeat(64), blocked: false }], truncated: false });
    expect(findMany.mock.calls[0][0]).toMatchObject({ take: 201, where: { action: 'blob-erase', NOT: { sha256: 'a'.repeat(64) } } });
    expect(blobs.mock.calls[0][0].where.OR).toHaveLength(1);
  });
});
