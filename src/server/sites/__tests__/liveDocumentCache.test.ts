// The kept document bodies of GET /api/projects/<id>/document
// (src/server/sites/liveDocumentCache.ts): exact-version hits, one version per
// site, never stepping back, a forget that a racing load cannot undo, and the
// bounds.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cachedDocument,
  documentEpoch,
  forgetSiteDocuments,
  LIVE_DOCUMENT_CACHE_LIMITS,
  rememberDocument,
  resetLiveDocumentCacheForTests,
} from '../liveDocumentCache';

const A = { workspaceId: 'ws_a', tenantGroupId: 'tg_a' };
const B = { workspaceId: 'ws_b', tenantGroupId: 'tg_b' };

beforeEach(() => resetLiveDocumentCacheForTests());

describe('liveDocumentCache', () => {
  it('answers only the exact version, only in the workspace it was kept for', () => {
    rememberDocument(A, 's1', 3, 'v3', documentEpoch());
    expect(cachedDocument(A, 's1', 3)).toBe('v3');
    expect(cachedDocument(A, 's1', 4)).toBeUndefined();
    expect(cachedDocument(B, 's1', 3)).toBeUndefined();
  });

  it('keeps one version per site, and a slower load of an older version never replaces a newer one', () => {
    rememberDocument(A, 's1', 4, 'v4', documentEpoch());
    rememberDocument(A, 's1', 3, 'v3', documentEpoch());
    expect(cachedDocument(A, 's1', 4)).toBe('v4');
    rememberDocument(A, 's1', 5, 'v5', documentEpoch());
    expect(cachedDocument(A, 's1', 4)).toBeUndefined();
    expect(cachedDocument(A, 's1', 5)).toBe('v5');
  });

  it('forgets a site, and a load that started before the forget is not kept', () => {
    rememberDocument(A, 's1', 3, 'old name', documentEpoch());
    const epoch = documentEpoch();
    // A rename commits while the next load is in flight.
    forgetSiteDocuments('s1');
    expect(cachedDocument(A, 's1', 3)).toBeUndefined();
    rememberDocument(A, 's1', 3, 'old name again', epoch);
    expect(cachedDocument(A, 's1', 3)).toBeUndefined();
    rememberDocument(A, 's1', 3, 'new name', documentEpoch());
    expect(cachedDocument(A, 's1', 3)).toBe('new name');
  });

  it('is bounded by entries and by size, the least recently used going first, and never keeps an oversized body', () => {
    for (let i = 0; i <= LIVE_DOCUMENT_CACHE_LIMITS.entries; i++) rememberDocument(A, `s${i}`, 1, `b${i}`, documentEpoch());
    expect(cachedDocument(A, 's0', 1)).toBeUndefined();
    expect(cachedDocument(A, `s${LIVE_DOCUMENT_CACHE_LIMITS.entries}`, 1)).toBe(`b${LIVE_DOCUMENT_CACHE_LIMITS.entries}`);

    resetLiveDocumentCacheForTests();
    const big = 'x'.repeat(LIVE_DOCUMENT_CACHE_LIMITS.entryBytes);
    const count = Math.floor(LIVE_DOCUMENT_CACHE_LIMITS.bytes / big.length);
    for (let i = 0; i < count; i++) rememberDocument(A, `big${i}`, 1, big, documentEpoch());
    // Touching the first keeps it; the next one pushes the least recently used (the second) out.
    expect(cachedDocument(A, 'big0', 1)).toBe(big);
    rememberDocument(A, 'one-more', 1, 'small', documentEpoch());
    expect(cachedDocument(A, 'big1', 1)).toBeUndefined();
    expect(cachedDocument(A, 'big0', 1)).toBe(big);

    rememberDocument(A, 'huge', 1, `${big}y`, documentEpoch());
    expect(cachedDocument(A, 'huge', 1)).toBeUndefined();
  });
});
