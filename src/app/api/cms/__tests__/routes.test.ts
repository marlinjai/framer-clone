// @vitest-environment node
//
// src/app/api/cms/__tests__/routes.test.ts
//
// Unit tests for the four thin /api/cms READ route handlers. getCmsRepository
// is mocked so no database is touched: we assert the routes map repository
// results onto the success shapes, return a 404 envelope when the repository
// yields null, and SURFACE a repository throw as a 5xx error envelope (never a
// swallowed empty 200).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CmsReadRepository } from '@/server/cms';

// Mock the server barrel BEFORE importing the route modules (vi.mock is
// hoisted). Each test installs the repository behaviour it needs.
vi.mock('@/server/cms', () => ({
  getCmsRepository: vi.fn(),
}));

import { getCmsRepository } from '@/server/cms';
import { GET as collectionsGET } from '../collections/route';
import { GET as collectionGET } from '../collections/[id]/route';
import { GET as rowsGET } from '../collections/[id]/rows/route';
import { GET as rowGET } from '../collections/[id]/rows/[rowId]/route';

const getCmsRepositoryMock = vi.mocked(getCmsRepository);

function installRepo(repo: Partial<CmsReadRepository>): void {
  getCmsRepositoryMock.mockReturnValue(repo as CmsReadRepository);
}

const SAMPLE_COLLECTION = {
  id: 'col_posts',
  slug: 'posts',
  name: 'Posts',
  columns: [{ id: 'title', name: 'Title', type: 'text' as const }],
};

const SAMPLE_ROW = { id: 'post_1', values: { title: 'Hello' } };

beforeEach(() => {
  getCmsRepositoryMock.mockReset();
});

describe('GET /api/cms/collections', () => {
  it('returns the collection list as 200 JSON', async () => {
    installRepo({ listCollections: vi.fn().mockResolvedValue([SAMPLE_COLLECTION]) });
    const res = await collectionsGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([SAMPLE_COLLECTION]);
  });

  it('surfaces a repository throw as a 5xx envelope (never an empty 200)', async () => {
    installRepo({
      listCollections: vi.fn().mockRejectedValue(new Error('db down')),
    });
    const res = await collectionsGET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'cms_read_failed', message: 'db down' },
    });
  });
});

describe('GET /api/cms/collections/[id]', () => {
  it('returns the collection as 200 JSON', async () => {
    installRepo({ getCollection: vi.fn().mockResolvedValue(SAMPLE_COLLECTION) });
    const res = await collectionGET(new Request('http://t/'), {
      params: Promise.resolve({ id: 'col_posts' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SAMPLE_COLLECTION);
  });

  it('returns a 404 envelope when the collection is null', async () => {
    installRepo({ getCollection: vi.fn().mockResolvedValue(null) });
    const res = await collectionGET(new Request('http://t/'), {
      params: Promise.resolve({ id: 'nope' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('surfaces a repository throw as a 5xx envelope', async () => {
    installRepo({
      getCollection: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const res = await collectionGET(new Request('http://t/'), {
      params: Promise.resolve({ id: 'col_posts' }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('cms_read_failed');
  });
});

describe('GET /api/cms/collections/[id]/rows', () => {
  it('returns the rows page as 200 JSON', async () => {
    const page = { rows: [SAMPLE_ROW], total: 1 };
    const listRows = vi.fn().mockResolvedValue(page);
    installRepo({ listRows });
    const res = await rowsGET(new Request('http://t/'), {
      params: Promise.resolve({ id: 'col_posts' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(page);
    expect(listRows).toHaveBeenCalledWith('col_posts', undefined);
  });

  it('decodes the JSON query search param and forwards it to the repo', async () => {
    const listRows = vi.fn().mockResolvedValue({ rows: [], total: 0 });
    installRepo({ listRows });
    const query = {
      filter: [{ column: 'title', op: 'contains', value: 'x' }],
      sort: [{ column: 'title', direction: 'asc' }],
      limit: 5,
    };
    const url = `http://t/api/cms/collections/col_posts/rows?query=${encodeURIComponent(
      JSON.stringify(query),
    )}`;
    const res = await rowsGET(new Request(url), {
      params: Promise.resolve({ id: 'col_posts' }),
    });
    expect(res.status).toBe(200);
    expect(listRows).toHaveBeenCalledWith('col_posts', query);
  });

  it('returns a 400 envelope on an unparseable query param', async () => {
    const listRows = vi.fn();
    installRepo({ listRows });
    const res = await rowsGET(
      new Request('http://t/api/cms/collections/col_posts/rows?query=%7Bnot-json'),
      { params: Promise.resolve({ id: 'col_posts' }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_query');
    expect(listRows).not.toHaveBeenCalled();
  });

  it('surfaces a repository throw as a 5xx envelope', async () => {
    installRepo({ listRows: vi.fn().mockRejectedValue(new Error('bad cursor')) });
    const res = await rowsGET(new Request('http://t/'), {
      params: Promise.resolve({ id: 'col_posts' }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('cms_read_failed');
  });
});

describe('GET /api/cms/collections/[id]/rows/[rowId]', () => {
  it('returns the row as 200 JSON', async () => {
    installRepo({ getRow: vi.fn().mockResolvedValue(SAMPLE_ROW) });
    const res = await rowGET(new Request('http://t/'), {
      params: Promise.resolve({ id: 'col_posts', rowId: 'post_1' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SAMPLE_ROW);
  });

  it('returns a 404 envelope when the row is null', async () => {
    installRepo({ getRow: vi.fn().mockResolvedValue(null) });
    const res = await rowGET(new Request('http://t/'), {
      params: Promise.resolve({ id: 'col_posts', rowId: 'nope' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('surfaces a repository throw as a 5xx envelope', async () => {
    installRepo({ getRow: vi.fn().mockRejectedValue(new Error('boom')) });
    const res = await rowGET(new Request('http://t/'), {
      params: Promise.resolve({ id: 'col_posts', rowId: 'post_1' }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('cms_read_failed');
  });
});
