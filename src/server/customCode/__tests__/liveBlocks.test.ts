// The per-request read of a published page's live custom code (slice C3 of
// docs/plans/2026-11-02-sandboxed-custom-code.md): only with the kill switch off and a box
// origin set, never on a preview, only blobs of an enabled site that nobody took down.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLiveCustomCode } from '../liveBlocks';

vi.mock('server-only', () => ({}));

const SITE = '0b9e2f4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const ON = { CUSTOM_CODE_DISABLED: '0', SANDBOX_ORIGIN: 'https://run.box.test' };
const good = { reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true };

function fakePrisma(rows: { sha256: string; declaration: unknown }[], blocked: string[] = [], fail = false) {
  const calls: unknown[] = [];
  return {
    calls,
    prisma: {
      customCodeBlob: { findMany: vi.fn(async (args: unknown) => { calls.push(args); if (fail) throw new Error('down'); return rows; }) },
      customCodeBlockedHash: { findMany: vi.fn(async () => blocked.map((sha256) => ({ sha256 }))) },
    } as never,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('loadLiveCustomCode', () => {
  it('reads the blobs of an enabled site, keyed by the site, without blocked ones', async () => {
    const { prisma, calls } = fakePrisma([{ sha256: A, declaration: good }, { sha256: B, declaration: good }], [B]);
    const live = await loadLiveCustomCode({ siteId: SITE, preview: false, hashes: [A, B] }, ON, prisma);
    expect(live?.origin).toBe('https://run.box.test');
    expect(live?.siteId).toBe(SITE);
    expect([...(live?.blobs.keys() ?? [])]).toEqual([A]);
    expect(calls[0]).toEqual({
      where: { siteId: SITE, sha256: { in: [A, B] }, blockedAt: null, site: { customCodeEnabled: true } },
      select: { sha256: true, declaration: true },
    });
  });

  it('leaves out a blob whose stored declaration does not parse, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { prisma } = fakePrisma([{ sha256: C, declaration: { ...good, network: ['x'] } }]);
    const live = await loadLiveCustomCode({ siteId: SITE, preview: false, hashes: [C] }, ON, prisma);
    expect(live?.blobs.size).toBe(0);
    expect(error).toHaveBeenCalled();
  });

  it.each([
    ['the kill switch unset', { SANDBOX_ORIGIN: ON.SANDBOX_ORIGIN }],
    ['the kill switch on', { ...ON, CUSTOM_CODE_DISABLED: '1' }],
    ['no box origin', { CUSTOM_CODE_DISABLED: '0' }],
    ['a malformed box origin', { ...ON, SANDBOX_ORIGIN: 'http://run.box.test' }],
  ])('reads nothing with %s', async (_name, env) => {
    const { prisma, calls } = fakePrisma([{ sha256: A, declaration: good }]);
    expect(await loadLiveCustomCode({ siteId: SITE, preview: false, hashes: [A] }, env, prisma)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('reads nothing on a preview or for a page without blocks', async () => {
    const { prisma, calls } = fakePrisma([{ sha256: A, declaration: good }]);
    expect(await loadLiveCustomCode({ siteId: SITE, preview: true, hashes: [A] }, ON, prisma)).toBeNull();
    expect(await loadLiveCustomCode({ siteId: SITE, preview: false, hashes: [] }, ON, prisma)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('renders without frames when the read fails, loudly', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { prisma } = fakePrisma([], [], true);
    expect(await loadLiveCustomCode({ siteId: SITE, preview: false, hashes: [A] }, ON, prisma)).toBeNull();
    expect(error).toHaveBeenCalled();
  });
});
