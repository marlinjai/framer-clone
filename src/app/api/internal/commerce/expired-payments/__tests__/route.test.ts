// @vitest-environment node
//
// The scheduled expiry sweep endpoint: the same gate as the custom-domain feed
// (editor host, bearer token, never open), the pass summary as the answer, and a
// non-2xx whenever anything could not be closed, so the host unit fails loudly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sweepAllExpiredPayments } = vi.hoisted(() => ({ sweepAllExpiredPayments: vi.fn() }));
vi.mock('@/server/commerce/payment/expirySweep', () => ({ sweepAllExpiredPayments }));

import { POST } from '../route';

const TOKEN = 'y'.repeat(40);
const KEYS = ['CUSTOM_DOMAIN_SYNC_TOKEN', 'EDITOR_HOST'];
const saved: Record<string, string | undefined> = {};

function req(opts: { host?: string; auth?: string | null } = {}): Request {
  const headers: Record<string, string> = { host: opts.host ?? 'app.lumitra.co' };
  if (opts.auth !== null) headers.authorization = opts.auth ?? `Bearer ${TOKEN}`;
  return new Request('http://app.lumitra.co/api/internal/commerce/expired-payments', { method: 'POST', headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.CUSTOM_DOMAIN_SYNC_TOKEN = TOKEN;
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

describe('POST /api/internal/commerce/expired-payments', () => {
  it('runs a pass and answers its summary', async () => {
    const summary = { tenantGroups: 2, skipped: 1, closed: 3, failed: 0 };
    sweepAllExpiredPayments.mockResolvedValue(summary);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is gated like the custom-domain feed: 401, 404 on a published host, 503 without a token', async () => {
    expect((await POST(req({ auth: null }))).status).toBe(401);
    expect((await POST(req({ auth: 'Bearer nope' }))).status).toBe(401);
    expect((await POST(req({ host: 'www.example.com' }))).status).toBe(404);
    delete process.env.CUSTOM_DOMAIN_SYNC_TOKEN;
    expect((await POST(req())).status).toBe(503);
    expect(sweepAllExpiredPayments).not.toHaveBeenCalled();
  });

  it('answers 500 with the summary (so the host unit fails) when anything could not be closed', async () => {
    const summary = { tenantGroups: 2, skipped: 0, closed: 3, failed: 1 };
    sweepAllExpiredPayments.mockResolvedValue(summary);
    const res = await POST(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('expired_payment_sweep_failed');
    expect(body.error.summary).toEqual(summary);
  });

  it('500s, loudly, when the pass itself fails', async () => {
    sweepAllExpiredPayments.mockRejectedValue(new Error('db down'));
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('expired_payment_sweep_failed');
    expect(console.error).toHaveBeenCalled();
  });
});
