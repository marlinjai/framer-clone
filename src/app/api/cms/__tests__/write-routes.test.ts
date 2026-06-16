// @vitest-environment node
//
// src/app/api/cms/__tests__/write-routes.test.ts
//
// Unit tests for the admin-guarded /api/cms WRITE routes. The write repository
// is mocked (no database); the REAL requireAdmin, cmsWriteErrorResponse, and
// typed error classes are kept so we exercise the actual guard + typed-envelope
// contract: a missing/wrong secret is 401/403, a duplicate collection is a 409
// `collection_exists` envelope (the specific-error path, not a generic 500).

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/server/cms', async (importActual) => {
  const actual = await importActual<typeof import('@/server/cms')>();
  return {
    ...actual,
    getCmsWriteRepository: vi.fn(),
    getCmsRepository: vi.fn(),
  };
});

import {
  getCmsWriteRepository,
  getCmsRepository,
  CollectionExistsError,
  type CmsWriteRepository,
  type CmsReadRepository,
} from '@/server/cms';
import { POST as collectionsPOST } from '../collections/route';
import { POST as columnsPOST } from '../collections/[id]/columns/route';

const writeMock = vi.mocked(getCmsWriteRepository);
const readMock = vi.mocked(getCmsRepository);

const SECRET = 'test-admin-secret';

function installWrite(repo: Partial<CmsWriteRepository>): void {
  writeMock.mockReturnValue(repo as CmsWriteRepository);
}
function installRead(repo: Partial<CmsReadRepository>): void {
  readMock.mockReturnValue(repo as CmsReadRepository);
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

describe('POST /api/cms/collections/[id]/columns', () => {
  it('adds a column and returns 201 with the entity when authorized', async () => {
    const column = { id: 'fld_title', name: 'title', type: 'text' as const };
    installWrite({ addColumn: vi.fn().mockResolvedValue(column) });
    const res = await columnsPOST(
      postReq('http://t/c/col_events/columns', { name: 'title', type: 'text' }, { secret: SECRET }),
      { params: Promise.resolve({ id: 'col_events' }) },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(column);
  });

  it('rejects an unguarded add-column with 401', async () => {
    const add = vi.fn();
    installWrite({ addColumn: add });
    installRead({});
    const res = await columnsPOST(
      postReq('http://t/c/col_events/columns', { name: 'title', type: 'text' }),
      { params: Promise.resolve({ id: 'col_events' }) },
    );
    expect(res.status).toBe(401);
    expect(add).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid column type', async () => {
    const add = vi.fn();
    installWrite({ addColumn: add });
    const res = await columnsPOST(
      postReq('http://t/c/col_events/columns', { name: 'x', type: 'url' }, { secret: SECRET }),
      { params: Promise.resolve({ id: 'col_events' }) },
    );
    expect(res.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });
});
