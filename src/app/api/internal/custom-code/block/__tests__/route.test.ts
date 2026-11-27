// @vitest-environment node
//
// The custom code takedown route (plan docs/plans/2026-11-02-sandboxed-custom-code.md, D116 to D119): its own
// operator token (never the host timers' token), editor host only, never open, a strict body, the operator label
// of D34 checked before the database sees it, and each action's answer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { blockCustomCodeHash, unblockCustomCodeHash, disableCustomCodeForSite, liftCustomCodeDisable } = vi.hoisted(() => ({
  blockCustomCodeHash: vi.fn(),
  unblockCustomCodeHash: vi.fn(),
  disableCustomCodeForSite: vi.fn(),
  liftCustomCodeDisable: vi.fn(),
}));
vi.mock('@/server/customCode/takedown', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/customCode/takedown')>()),
  blockCustomCodeHash,
  unblockCustomCodeHash,
  disableCustomCodeForSite,
  liftCustomCodeDisable,
}));

import { POST } from '../route';

const TOKEN = 'o'.repeat(40);
const TIMER_TOKEN = 't'.repeat(40);
const HASH = 'a'.repeat(64);
const KEYS = ['CUSTOM_CODE_OPERATOR_TOKEN', 'CUSTOM_DOMAIN_SYNC_TOKEN', 'EDITOR_HOST'];
const saved: Record<string, string | undefined> = {};

function req(body: unknown, opts: { host?: string; auth?: string | null } = {}): Request {
  const headers: Record<string, string> = { host: opts.host ?? 'app.lumitra.co', 'content-type': 'application/json' };
  if (opts.auth !== null) headers.authorization = opts.auth ?? `Bearer ${TOKEN}`;
  return new Request('http://app.lumitra.co/api/internal/custom-code/block', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const block = { action: 'block', sha256: HASH, reason: 'phishing form' };

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.CUSTOM_CODE_OPERATOR_TOKEN = TOKEN;
  process.env.CUSTOM_DOMAIN_SYNC_TOKEN = TIMER_TOKEN;
  process.env.EDITOR_HOST = 'app.lumitra.co';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('POST /api/internal/custom-code/block: the gate', () => {
  it('answers 404 off the editor host, 401 without the token or with the host timers\' token', async () => {
    expect((await POST(req(block, { host: 'bakery.sites.lumitra.co' }))).status).toBe(404);
    expect((await POST(req(block, { auth: null }))).status).toBe(401);
    expect((await POST(req(block, { auth: 'Bearer nope' }))).status).toBe(401);
    expect((await POST(req(block, { auth: `Bearer ${TIMER_TOKEN}` }))).status).toBe(401);
    expect(blockCustomCodeHash).not.toHaveBeenCalled();
  });

  it('is never open: 503 with no token or a short one', async () => {
    delete process.env.CUSTOM_CODE_OPERATOR_TOKEN;
    const res = await POST(req(block));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'custom_code_operator_not_configured' } });
    process.env.CUSTOM_CODE_OPERATOR_TOKEN = 'short';
    expect((await POST(req(block, { auth: 'Bearer short' }))).status).toBe(503);
    expect(blockCustomCodeHash).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/custom-code/block: the body', () => {
  it.each([
    ['not JSON', '{'],
    ['an unknown action', { ...block, action: 'delete' }],
    ['a hash in upper case', { ...block, sha256: 'A'.repeat(64) }],
    ['a short hash', { ...block, sha256: 'a'.repeat(63) }],
    ['no reason', { action: 'block', sha256: HASH }],
    ['a blank reason', { ...block, reason: '   ' }],
    ['a reason over 500 characters', { ...block, reason: 'x'.repeat(501) }],
    ['an unknown key', { ...block, siteId: 'site-1' }],
    ['disable-site without a site', { action: 'disable-site', reason: 'phishing' }],
  ])('refuses %s with 400', async (_label, body) => {
    expect((await POST(req(body))).status).toBe(400);
    expect(blockCustomCodeHash).not.toHaveBeenCalled();
    expect(disableCustomCodeForSite).not.toHaveBeenCalled();
  });

  it.each([
    ['a person\'s id', '018f9c10-0000-7000-8000-000000000001'],
    ['a label with a user id', 'operator:user-42'],
    ['upper case', 'Operator'],
    ['a label over 64 characters', `operator:${'a'.repeat(60)}`],
  ])('refuses %s as `by` with 400 bad_label', async (_label, by) => {
    const res = await POST(req({ ...block, by }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_label' } });
    expect(blockCustomCodeHash).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/custom-code/block: the actions', () => {
  it('blocks a hash as `operator` by default, with the trimmed reason', async () => {
    blockCustomCodeHash.mockResolvedValue({ sha256: HASH, listChanged: true, sites: ['site-a', 'site-b'] });
    const res = await POST(req({ ...block, reason: '  phishing form  ' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ action: 'block', sha256: HASH, listChanged: true, sites: ['site-a', 'site-b'] });
    expect(blockCustomCodeHash).toHaveBeenCalledWith(HASH, { label: 'operator', reason: 'phishing form' });
  });

  it('unblocks a hash under a channel label', async () => {
    unblockCustomCodeHash.mockResolvedValue({ sha256: HASH, listChanged: false, sites: [] });
    const res = await POST(req({ action: 'unblock', sha256: HASH, reason: 'reported in error', by: 'operator:abuse-report' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ action: 'unblock', sha256: HASH, listChanged: false, sites: [] });
    expect(unblockCustomCodeHash).toHaveBeenCalledWith(HASH, { label: 'operator:abuse-report', reason: 'reported in error' });
  });

  it('disables a site, and answers 404 and 400 for an unknown id and a branch', async () => {
    disableCustomCodeForSite.mockResolvedValueOnce({ ok: true, siteId: 'site-a', wasEnabled: true });
    const ok = await POST(req({ action: 'disable-site', siteId: 'site-a', reason: 'phishing' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ action: 'disable-site', siteId: 'site-a', wasEnabled: true });

    disableCustomCodeForSite.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    const missing = await POST(req({ action: 'disable-site', siteId: 'nope', reason: 'phishing' }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'site_not_found' } });

    disableCustomCodeForSite.mockResolvedValueOnce({ ok: false, reason: 'branch_site' });
    const branch = await POST(req({ action: 'disable-site', siteId: 'branch-1', reason: 'phishing' }));
    expect(branch.status).toBe(400);
    expect(await branch.json()).toMatchObject({ error: { code: 'branch_site' } });
  });

  it('lifts a site\'s disable, and refuses a branch', async () => {
    liftCustomCodeDisable.mockResolvedValueOnce({ ok: true, siteId: 'site-a', lifted: true });
    const ok = await POST(req({ action: 'lift-site', siteId: 'site-a', reason: 'reviewed, the form is gone' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ action: 'lift-site', siteId: 'site-a', lifted: true });
    expect(liftCustomCodeDisable).toHaveBeenCalledWith('site-a', { label: 'operator', reason: 'reviewed, the form is gone' });
    expect(disableCustomCodeForSite).not.toHaveBeenCalled();

    liftCustomCodeDisable.mockResolvedValueOnce({ ok: false, reason: 'branch_site' });
    expect((await POST(req({ action: 'lift-site', siteId: 'branch-1', reason: 'x' }))).status).toBe(400);
  });

  it('answers 500 on a database failure, with nothing changed', async () => {
    blockCustomCodeHash.mockRejectedValue(new Error('connection reset'));
    const res = await POST(req(block));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'takedown_failed' } });
  });
});
