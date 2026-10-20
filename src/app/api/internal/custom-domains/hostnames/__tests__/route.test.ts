// @vitest-environment node
//
// The proxy hostname feed: editor host only, constant-time bearer token, never
// open when unconfigured, plain-text data (one hostname per line) and a 500
// (so the host sync keeps its current file) when the list cannot be read.

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listProxyHostnames = vi.fn();
vi.mock('@/server/domains/service', () => ({
  getDomainService: () => ({ listProxyHostnames }),
}));

import { GET } from '../route';

const TOKEN = 'x'.repeat(48);
const saved = { token: process.env.CUSTOM_DOMAIN_SYNC_TOKEN, editor: process.env.EDITOR_HOST };

function req(opts: { host?: string; auth?: string | null } = {}): Request {
  const headers: Record<string, string> = { host: opts.host ?? 'app.lumitra.co' };
  if (opts.auth !== null) headers.authorization = opts.auth ?? `Bearer ${TOKEN}`;
  return new Request('http://app.lumitra.co/api/internal/custom-domains/hostnames', { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CUSTOM_DOMAIN_SYNC_TOKEN = TOKEN;
  process.env.EDITOR_HOST = 'app.lumitra.co';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (saved.token === undefined) delete process.env.CUSTOM_DOMAIN_SYNC_TOKEN;
  else process.env.CUSTOM_DOMAIN_SYNC_TOKEN = saved.token;
  if (saved.editor === undefined) delete process.env.EDITOR_HOST;
  else process.env.EDITOR_HOST = saved.editor;
  vi.restoreAllMocks();
});

describe('GET /api/internal/custom-domains/hostnames', () => {
  it('returns the hostnames as plain text with a count and a hash', async () => {
    listProxyHostnames.mockResolvedValue(['a.example.com', 'www.example.org']);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const body = await res.text();
    expect(body).toBe('a.example.com\nwww.example.org\n');
    expect(res.headers.get('x-hostname-count')).toBe('2');
    expect(res.headers.get('x-content-sha256')).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('an empty list is an empty body (the sync then writes no routers)', async () => {
    listProxyHostnames.mockResolvedValue([]);
    const res = await GET(req());
    expect(await res.text()).toBe('');
  });

  it('401s without or with a wrong token', async () => {
    expect((await GET(req({ auth: null }))).status).toBe(401);
    expect((await GET(req({ auth: 'Bearer wrong' }))).status).toBe(401);
    expect((await GET(req({ auth: TOKEN }))).status).toBe(401);
    expect(listProxyHostnames).not.toHaveBeenCalled();
  });

  it('404s on a published-site host', async () => {
    expect((await GET(req({ host: 'www.example.com' }))).status).toBe(404);
  });

  it('503s when no (or a too short) token is configured, never open', async () => {
    delete process.env.CUSTOM_DOMAIN_SYNC_TOKEN;
    const unset = await GET(req({ auth: 'Bearer ' }));
    expect(unset.status).toBe(503);
    process.env.CUSTOM_DOMAIN_SYNC_TOKEN = 'short';
    expect((await GET(req({ auth: 'Bearer short' }))).status).toBe(503);
    expect(listProxyHostnames).not.toHaveBeenCalled();
  });

  it('500s when the list cannot be read, so the sync keeps its current file', async () => {
    listProxyHostnames.mockRejectedValue(new Error('db down'));
    expect((await GET(req())).status).toBe(500);
  });
});
