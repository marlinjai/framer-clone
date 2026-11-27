// @vitest-environment node
//
// src/app/api/projects/__tests__/custom-code-route.test.ts
//
// GET and POST /api/projects/<id>/custom-code (plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// slice C4, D99 and D103): the switch, the guard, the permission, the body and every refusal with its
// reason. The guard, the permission check and the database module are mocked: the guard has its own
// tests, and what the write does is proven on a real database in
// src/server/customCode/__tests__/authoring.itest.ts. These assert what the route asks for, in which
// order, and what it answers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuthorize = vi.fn();
vi.mock('@/server/domains/guard', () => ({
  authorizeDomainProject: (...args: unknown[]) => mockAuthorize(...args),
}));
const mockAccess = vi.fn();
vi.mock('@/lib/auth-check', () => ({
  checkWorkspaceAccess: (...args: unknown[]) => mockAccess(...args),
}));
const mockWrite = vi.fn();
const mockStatus = vi.fn();
const mockBlob = vi.fn();
vi.mock('@/server/customCode/authoring', () => ({
  writeCustomCodeBlob: (...args: unknown[]) => mockWrite(...args),
  readCustomCodeStatus: (...args: unknown[]) => mockStatus(...args),
  readCustomCodeBlob: (...args: unknown[]) => mockBlob(...args),
}));

import { AuthzUnavailableError } from '@/lib/authBrainAvailability';
import { BOX_LIMITS } from '@/lib/customCode/contract';
import { GET, POST } from '../[projectId]/custom-code/route';

const PROJECT = { id: 'site_1', workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra' };
const ctx = { params: Promise.resolve({ projectId: 'site_1' }) };
const HASH = 'a'.repeat(64);
const DECLARATION = { reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true };
const BODY = { pageId: 'home', nodeId: 'block-1', title: 'Clock', document: '<p>tick</p>', declaration: DECLARATION };

function get(query = ''): Request {
  return new Request(`http://localhost/api/projects/site_1/custom-code${query}`);
}

function post(body: unknown, raw?: string): Request {
  return new Request('http://localhost/api/projects/site_1/custom-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

async function errorOf(res: Response): Promise<{ code: string; message: string; retryAfterSeconds?: number }> {
  const json = await res.json();
  expect(typeof json.error.message).toBe('string');
  expect(json.error.message.length).toBeGreaterThan(15);
  return json.error;
}

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CUSTOM_CODE_AVAILABLE = '1';
  process.env.CUSTOM_CODE_DISABLED = '0';
  process.env.SANDBOX_ORIGIN = 'https://run.example.com';
  mockAuthorize.mockResolvedValue({ ok: true, project: PROJECT, userId: 'user_1' });
  mockAccess.mockResolvedValue(true);
  mockWrite.mockResolvedValue({ ok: true, sha256: HASH, created: true });
  mockStatus.mockResolvedValue({ enabled: true, branch: false, usedBytes: 1234 });
  mockBlob.mockResolvedValue({ sha256: HASH, title: 'Clock', document: '<p>tick</p>', declaration: DECLARATION, createdAt: '2026-11-23T00:00:00.000Z', blocked: false });
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('the switch CUSTOM_CODE_AVAILABLE (D99)', () => {
  it.each([undefined, '', '0', 'true', 'yes', ' 1', '1 '])('answers 404 with the reason for %j, before any session is read', async (value) => {
    if (value === undefined) delete process.env.CUSTOM_CODE_AVAILABLE;
    else process.env.CUSTOM_CODE_AVAILABLE = value;
    for (const res of [await GET(get(), ctx), await POST(post(BODY), ctx)]) {
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe('custom_code_unavailable');
    }
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('GET: the status and one blob', () => {
  it('reads under viewSite and says whether this person may write, uncached', async () => {
    const res = await GET(get(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      enabled: true, branch: false, canManage: true, serving: true, usedBytes: 1234,
      limits: { blockBytes: BOX_LIMITS.documentBytes, siteBytes: BOX_LIMITS.siteBytes, blocksPerPage: 4, writesPerHour: 30 },
    });
    expect(mockAuthorize).toHaveBeenCalledWith(expect.anything(), 'site_1', 'viewSite');
    expect(mockAccess).toHaveBeenCalledWith('user_1', 'ws_marlin', 'manageCustomCode');
    expect(mockStatus).toHaveBeenCalledWith({ siteId: 'site_1', workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra' });
  });

  it('passes on why Lumitra switched the site off (D118)', async () => {
    const disabledByLumitra = { reason: 'phishing form reported', at: '2026-11-27T12:00:00.000Z' };
    mockStatus.mockResolvedValue({ enabled: false, branch: false, usedBytes: 0, disabledByLumitra });
    expect(await (await GET(get(), ctx)).json()).toMatchObject({ enabled: false, disabledByLumitra });
  });

  it('says when this server serves no block (the kill switch)', async () => {
    process.env.CUSTOM_CODE_DISABLED = '1';
    expect((await (await GET(get(), ctx)).json()).serving).toBe(false);
  });

  it('answers a missing site the way the guard answers a foreign one', async () => {
    mockStatus.mockResolvedValue(null);
    const res = await GET(get(), ctx);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('forbidden');
  });

  it('gives one blob of this site by hash, and 404 with the reason for one it does not hold', async () => {
    const res = await GET(get(`?sha256=${HASH}`), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).document).toBe('<p>tick</p>');
    expect(mockBlob).toHaveBeenCalledWith({ siteId: 'site_1', workspaceId: 'ws_marlin' }, HASH);
    mockBlob.mockResolvedValue(null);
    const missing = await GET(get(`?sha256=${HASH}`), ctx);
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('blob_not_found');
  });

  it('refuses a malformed hash without reading', async () => {
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), '../x', '']) {
      const res = await GET(get(`?sha256=${encodeURIComponent(bad)}`), ctx);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe('bad_hash');
    }
    expect(mockBlob).not.toHaveBeenCalled();
  });

  it('answers 503 when the permission service cannot answer, never a grant', async () => {
    mockAccess.mockRejectedValue(new AuthzUnavailableError(new Error('down')));
    const res = await GET(get(), ctx);
    expect(res.status).toBe(503);
  });

  it('turns a read failure into a 500 with a reason, logging no row', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockBlob.mockRejectedValue(Object.assign(new Error('value "<p>secret</p>" too long'), { code: 'P2000' }));
    const res = await GET(get(`?sha256=${HASH}`), ctx);
    expect(res.status).toBe(500);
    expect((await errorOf(res)).code).toBe('custom_code_failed');
    expect(spy.mock.calls.flat().join(' ')).not.toContain('secret');
    spy.mockRestore();
  });
});

describe('POST: who may write', () => {
  it('passes the guard response on, and words its bare 403', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await POST(post(BODY), ctx)).status).toBe(401);
    mockAuthorize.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Forbidden' } }), { status: 403 }) });
    const res = await POST(post(BODY), ctx);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).message).toMatch(/does not exist, or your account has no access/);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses a person without manageCustomCode with the reason', async () => {
    mockAccess.mockResolvedValue(false);
    const res = await POST(post(BODY), ctx);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('permission_denied');
    expect(mockAccess).toHaveBeenCalledWith('user_1', 'ws_marlin', 'manageCustomCode');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('answers 503 when the permission service cannot answer', async () => {
    mockAccess.mockRejectedValue(new AuthzUnavailableError(new Error('down')));
    expect((await POST(post(BODY), ctx)).status).toBe(503);
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('POST: what arrives', () => {
  it('writes and answers 201 with the hash, under the session user, scoped to the project', async () => {
    const res = await POST(post({ ...BODY, replaces: HASH }), ctx);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sha256: HASH, created: true });
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const arg = mockWrite.mock.calls[0][0];
    expect(arg).toMatchObject({ siteId: 'site_1', workspaceId: 'ws_marlin', tenantGroupId: 'tg_lumitra', actor: 'user_1', pageId: 'home', nodeId: 'block-1', replaces: HASH });
    expect(arg.code).toMatchObject({ title: 'Clock', document: '<p>tick</p>', declaration: DECLARATION });
  });

  it('answers 200 when the code was already stored', async () => {
    mockWrite.mockResolvedValue({ ok: true, sha256: HASH, created: false });
    expect((await POST(post(BODY), ctx)).status).toBe(200);
  });

  it.each([
    ['not JSON', undefined, '{', 400, 'bad_json'],
    ['an unknown key', { ...BODY, siteId: 'other' }, undefined, 400, 'bad_body'],
    ['no node id', { ...BODY, nodeId: undefined }, undefined, 400, 'bad_body'],
    ['a node id that is markup', { ...BODY, nodeId: '<img>' }, undefined, 400, 'bad_body'],
    ['a malformed replaces', { ...BODY, replaces: 'nope' }, undefined, 400, 'bad_body'],
    ['an empty title', { ...BODY, title: '  ' }, undefined, 400, 'title_invalid'],
    ['a title with a bidirectional override', { ...BODY, title: 'Clock‮' }, undefined, 400, 'title_invalid'],
    ['empty code', { ...BODY, document: ' \n ' }, undefined, 400, 'document_empty'],
    ['code that is not text', { ...BODY, document: 42 }, undefined, 400, 'document_empty'],
    ['a NUL in the code', { ...BODY, document: 'a\u0000b' }, undefined, 400, 'document_nul'],
    ['a lone surrogate', { ...BODY, document: 'a\ud800b' }, undefined, 400, 'document_not_well_formed'],
    ['a declaration with an unknown key', { ...BODY, declaration: { ...DECLARATION, network: true } }, undefined, 400, 'declaration_invalid'],
    ['a declaration without sizing', { ...BODY, declaration: { interactive: true } }, undefined, 400, 'declaration_invalid'],
    ['a malformed state id', { ...BODY, declaration: { ...DECLARATION, reads: ['Bad Id'] } }, undefined, 400, 'declaration_invalid'],
  ])('refuses %s with its reason, writing nothing', async (_what, body, raw, status, code) => {
    const res = await POST(post(body, raw), ctx);
    expect(res.status).toBe(status);
    expect((await errorOf(res)).code).toBe(code);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses code over 256 KB with its size, not the transport limit', async () => {
    const document = 'x'.repeat(BOX_LIMITS.documentBytes);
    const res = await POST(post({ ...BODY, document }), ctx);
    expect(res.status).toBe(413);
    const error = await errorOf(res);
    expect(error.code).toBe('too_large');
    expect(error.message).toMatch(/256 KB/);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses code just over the limit counted in UTF-8 bytes, and takes code just under', async () => {
    // A three-byte character: 87,000 of them are 261,000 bytes, under; with the declaration and 400 more, over.
    const under = '€'.repeat(87_000);
    expect((await POST(post({ ...BODY, document: under }), ctx)).status).toBe(201);
    const over = '€'.repeat(87_400);
    expect((await POST(post({ ...BODY, document: over }), ctx)).status).toBe(413);
  });

  it('refuses a body past the transport cap', async () => {
    const res = await POST(post({ ...BODY, document: 'x'.repeat(1024 * 1024 + 10) }), ctx);
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe('too_large');
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('POST: what the write refuses', () => {
  it.each([
    ['branch_site', 409],
    ['custom_code_off', 409],
    ['blocked', 410],
    ['node_not_saved', 409],
    ['not_a_block', 409],
    ['replaces_mismatch', 409],
    ['declaration_state', 422],
    ['site_budget', 413],
  ])('passes %s on with its status and message', async (code, status) => {
    mockWrite.mockResolvedValue({ ok: false, refusal: { code, status, message: `the reason for ${code}, in a sentence` } });
    const res = await POST(post(BODY), ctx);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toEqual({ code, message: `the reason for ${code}, in a sentence` });
  });

  it('passes the hourly limit on with Retry-After', async () => {
    mockWrite.mockResolvedValue({ ok: false, refusal: { code: 'rate_limited', status: 429, message: 'Thirty writes this hour already; try again later.', retryAfterSeconds: 120 } });
    const res = await POST(post(BODY), ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
    expect((await errorOf(res)).retryAfterSeconds).toBe(120);
  });

  it('answers a site the write cannot find as the guard answers a foreign one', async () => {
    mockWrite.mockResolvedValue({ ok: false, notFound: true });
    const res = await POST(post(BODY), ctx);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('forbidden');
  });

  it('turns a database failure into a 500 with a reason, logging neither the code nor the error message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockWrite.mockRejectedValue(Object.assign(new Error('insert of "<p>tick</p>" failed'), { code: 'P2010' }));
    const res = await POST(post(BODY), ctx);
    expect(res.status).toBe(500);
    expect((await errorOf(res)).code).toBe('custom_code_failed');
    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).toContain('P2010');
    expect(logged).not.toContain('tick');
    spy.mockRestore();
  });
});
