// @vitest-environment node
//
// The job watchdog endpoint: the same gate as the other host timers (editor host, bearer token, never open), the
// report as the answer, and a non-2xx only for a failed pass or a late job. A dead job is a count, so one dead row
// cannot hold the monitor red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runCommerceWatchdogPass } = vi.hoisted(() => ({ runCommerceWatchdogPass: vi.fn() }));
vi.mock('@/server/commerce/jobs/runtime', () => ({ runCommerceWatchdogPass }));

import { POST } from '../route';

const TOKEN = 'y'.repeat(40);
const HEALTHY = {
  tenantGroups: 2,
  skipped: 1,
  ran: 3,
  failed: 0,
  deadUnacknowledged: 0,
  purgesStuck: 0,
  findingsOpen: 0,
  oldestDueSeconds: 0,
  receiptsUnissued: 0,
  receipts: 'ok',
};

function req(opts: { host?: string; auth?: string | null } = {}): Request {
  const headers: Record<string, string> = { host: opts.host ?? 'app.lumitra.co' };
  if (opts.auth !== null) headers.authorization = opts.auth ?? `Bearer ${TOKEN}`;
  return new Request('http://app.lumitra.co/api/internal/commerce/jobs/run', { method: 'POST', headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CUSTOM_DOMAIN_SYNC_TOKEN', TOKEN);
  vi.stubEnv('EDITOR_HOST', 'app.lumitra.co');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/internal/commerce/jobs/run', () => {
  it('runs a pass and answers its report', async () => {
    runCommerceWatchdogPass.mockResolvedValue(HEALTHY);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(HEALTHY);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is gated like the other host timers: 401, 404 on a published host, 503 without a token', async () => {
    expect((await POST(req({ auth: null }))).status).toBe(401);
    expect((await POST(req({ auth: 'Bearer nope' }))).status).toBe(401);
    expect((await POST(req({ host: 'www.example.com' }))).status).toBe(404);
    vi.stubEnv('CUSTOM_DOMAIN_SYNC_TOKEN', '');
    expect((await POST(req())).status).toBe(503);
    expect(runCommerceWatchdogPass).not.toHaveBeenCalled();
  });

  it('names paid orders without an invoice in the field its keyword monitor matches, and stays 200', async () => {
    const healthy = await (await (runCommerceWatchdogPass.mockResolvedValue(HEALTHY), POST(req()))).text();
    expect(healthy).toContain('"receipts":"ok"');
    runCommerceWatchdogPass.mockResolvedValue({ ...HEALTHY, deadUnacknowledged: 1, receiptsUnissued: 1, receipts: 'unissued' });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"receipts":"unissued"');
    expect(body).not.toContain('"receipts":"ok"');
    expect(JSON.parse(body)).toMatchObject({ receiptsUnissued: 1 });
  });

  it('stays 200 with a count when jobs are dead', async () => {
    const report = { ...HEALTHY, deadUnacknowledged: 4 };
    runCommerceWatchdogPass.mockResolvedValue(report);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(report);
  });

  it('answers 500 with the report when a tenant group failed', async () => {
    const report = { ...HEALTHY, failed: 1 };
    runCommerceWatchdogPass.mockResolvedValue(report);
    const res = await POST(req());
    expect(res.status).toBe(500);
    const { error } = await res.json();
    expect(error.code).toBe('commerce_jobs_unhealthy');
    expect(error.report).toEqual(report);
  });

  it('answers 500 past 10 minutes of lateness, and 200 at exactly 10 minutes', async () => {
    runCommerceWatchdogPass.mockResolvedValue({ ...HEALTHY, oldestDueSeconds: 600 });
    expect((await POST(req())).status).toBe(200);

    runCommerceWatchdogPass.mockResolvedValue({ ...HEALTHY, oldestDueSeconds: 601 });
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error.report.oldestDueSeconds).toBe(601);
  });

  it('500s, loudly, when the pass itself fails', async () => {
    runCommerceWatchdogPass.mockRejectedValue(new Error('db down'));
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_jobs_unhealthy');
    expect(console.error).toHaveBeenCalled();
  });
});
