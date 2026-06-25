// @vitest-environment node
//
// src/app/api/cms/__tests__/write-routes.test.ts
//
// Unit tests for the admin-guarded /api/cms COLLECTION write routes. The write
// repository is mocked (no database); the REAL requireAdmin, cmsWriteErrorResponse,
// and typed error classes are kept so we exercise the actual guard + typed-envelope
// contract: a missing/wrong secret is 401/403, a duplicate collection is a 409
// `collection_exists` envelope (the specific-error path, not a generic 500).
//
// Column/row writes are no longer HTTP routes (the editor grid persists them via
// the data-table server-actions adapter), so only collection routes remain here.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/server/cms', async (importActual) => {
  const actual = await importActual<typeof import('@/server/cms')>();
  return {
    ...actual,
    getCmsWriteRepository: vi.fn(),
  };
});

import {
  getCmsWriteRepository,
  CollectionExistsError,
  type CmsWriteRepository,
} from '@/server/cms';
import { POST as collectionsPOST } from '../collections/route';

const writeMock = vi.mocked(getCmsWriteRepository);

const SECRET = 'test-admin-secret';

function installWrite(repo: Partial<CmsWriteRepository>): void {
  writeMock.mockReturnValue(repo as CmsWriteRepository);
}

function postReq(
  url: string,
  body: unknown,
  opts?: { secret?: string },
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts?.secret !== undefined) headers['x-admin-secret'] = opts.secret;
  return new Request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FRAMER_CLONE_ADMIN_SECRET = SECRET;
});

describe('POST /api/cms/collections guard', () => {
  it('returns 401 when no admin secret is presented', async () => {
    const create = vi.fn();
    installWrite({ createCollection: create });
    const res = await collectionsPOST(
      postReq('http://t/api/cms/collections', { name: 'Events' }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
    expect(create).not.toHaveBeenCalled();
  });

  it('returns 403 when the admin secret is wrong', async () => {
    const create = vi.fn();
    installWrite({ createCollection: create });
    const res = await collectionsPOST(
      postReq('http://t/api/cms/collections', { name: 'Events' }, { secret: 'nope' }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('POST /api/cms/collections (authorized)', () => {
  it('creates a collection and returns 201 with the entity', async () => {
    const created = { id: 'col_events', slug: 'events', name: 'Events', columns: [] };
    installWrite({ createCollection: vi.fn().mockResolvedValue(created) });
    const res = await collectionsPOST(
      postReq('http://t/api/cms/collections', { name: 'Events' }, { secret: SECRET }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(created);
  });

  it('surfaces a duplicate name as a typed 409 collection_exists envelope', async () => {
    installWrite({
      createCollection: vi.fn().mockRejectedValue(new CollectionExistsError('Events')),
    });
    const res = await collectionsPOST(
      postReq('http://t/api/cms/collections', { name: 'Events' }, { secret: SECRET }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('collection_exists');
  });

  it('returns 400 on an invalid body (missing name)', async () => {
    const create = vi.fn();
    installWrite({ createCollection: create });
    const res = await collectionsPOST(
      postReq('http://t/api/cms/collections', {}, { secret: SECRET }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_body');
    expect(create).not.toHaveBeenCalled();
  });
});
