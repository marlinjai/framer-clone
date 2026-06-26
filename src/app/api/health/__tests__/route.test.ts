// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { GET } from '../route';

describe('GET /api/health (liveness)', () => {
  it('returns { ok: true } with a 200, independent of the database', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
