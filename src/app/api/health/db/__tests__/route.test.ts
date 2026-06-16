import { describe, it, expect, vi, beforeEach } from 'vitest';

// The route reads through the server-only PrismaClient singleton. We mock the
// singleton so the test needs no live database: it controls whether
// `SELECT 1` resolves or rejects and asserts the resulting envelope.
const queryRaw = vi.fn();
vi.mock('@/server/db', () => ({
  getPrismaClient: () => ({ $queryRaw: queryRaw }),
}));

describe('GET /api/health/db', () => {
  beforeEach(() => {
    queryRaw.mockReset();
    vi.resetModules();
  });

  it('returns { ok: true } when SELECT 1 resolves', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns a 503 db_unreachable envelope when SELECT 1 rejects', async () => {
    queryRaw.mockRejectedValue(new Error('connection refused'));
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('db_unreachable');
    expect(body.error.message).toBe('connection refused');
  });
});
