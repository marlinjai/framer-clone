// @vitest-environment node
//
// The scheduled re-check endpoint: same gate as the feed (editor host, bearer
// token, never open), 503 when custom domains are not configured, and the
// service's pass summary as the answer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recheckDue = vi.fn();
vi.mock('@/server/domains/service', () => ({ getDomainService: () => ({ recheckDue }) }));

import { POST } from '../route';

const TOKEN = 'y'.repeat(40);
const KEYS = ['CUSTOM_DOMAIN_SYNC_TOKEN', 'EDITOR_HOST', 'CUSTOM_DOMAIN_TARGET_HOST', 'CUSTOM_DOMAIN_TARGET_IPV4'];
const saved: Record<string, string | undefined> = {};

function req(opts: { host?: string; auth?: string | null } = {}): Request {
  const headers: Record<string, string> = { host: opts.host ?? 'app.lumitra.co' };
  if (opts.auth !== null) headers.authorization = opts.auth ?? `Bearer ${TOKEN}`;
  return new Request('http://app.lumitra.co/api/internal/custom-domains/recheck', { method: 'POST', headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.CUSTOM_DOMAIN_SYNC_TOKEN = TOKEN;
  process.env.EDITOR_HOST = 'app.lumitra.co';
  process.env.CUSTOM_DOMAIN_TARGET_HOST = 'domains.lumitra.co';
  process.env.CUSTOM_DOMAIN_TARGET_IPV4 = '203.0.113.10';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('POST /api/internal/custom-domains/recheck', () => {
  it('runs a pass and answers its summary', async () => {
    const summary = { checked: 3, ok: 1, transient: 1, failing: 1, released: 0 };
    recheckDue.mockResolvedValue(summary);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
    expect(recheckDue.mock.calls[0][0]).toMatchObject({ targetHost: 'domains.lumitra.co' });
  });

  it('is gated like the feed: 401, 404 on a published host, 503 without a token', async () => {
    expect((await POST(req({ auth: null }))).status).toBe(401);
    expect((await POST(req({ auth: 'Bearer nope' }))).status).toBe(401);
    expect((await POST(req({ host: 'www.example.com' }))).status).toBe(404);
    delete process.env.CUSTOM_DOMAIN_SYNC_TOKEN;
    expect((await POST(req())).status).toBe(503);
    expect(recheckDue).not.toHaveBeenCalled();
  });

  it('503s when custom domains are not configured', async () => {
    delete process.env.CUSTOM_DOMAIN_TARGET_IPV4;
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('custom_domains_not_configured');
  });

  it('500s when the pass fails', async () => {
    recheckDue.mockRejectedValue(new Error('db down'));
    expect((await POST(req())).status).toBe(500);
  });
});
