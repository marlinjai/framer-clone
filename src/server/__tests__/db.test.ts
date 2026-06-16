import { describe, it, expect, vi, beforeEach } from 'vitest';

// PrismaClient is mocked so the smoke test needs no generated client, no
// DATABASE_URL, and no live database: we are testing the singleton caching
// behaviour, not Prisma itself.
vi.mock('@prisma/client', () => ({
  PrismaClient: class FakePrismaClient {},
}));

describe('getPrismaClient', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__framerClonePrisma;
    vi.resetModules();
  });

  it('returns the same instance across repeated calls', async () => {
    const { getPrismaClient } = await import('../db');
    const a = getPrismaClient();
    const b = getPrismaClient();
    expect(a).toBe(b);
  });

  it('caches one client across module re-evaluation (HMR-safe)', async () => {
    const first = await import('../db');
    const a = first.getPrismaClient();

    // Simulate Next.js dev HMR re-evaluating the module.
    vi.resetModules();
    const second = await import('../db');
    const b = second.getPrismaClient();

    expect(a).toBe(b);
  });
});
