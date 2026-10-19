// @vitest-environment node
//
// src/app/projects/migrate-company/__tests__/route.test.ts
//
// The one-time migration of the retired `framer_ws` cookie (a workspace id) to
// `framer_company` (a tenant id). With a valid session it maps the old
// workspace to its company when that company holds the `sites` grant, and
// deletes `framer_ws` in the same response in every case; it ALWAYS answers a
// relative 303 to `/projects?migrated=1` (plus the validated next), the marker
// on which the dashboard never comes back here (loop-free). Without a session
// or during an outage it writes and deletes nothing.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockVerifySession = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: (...args: unknown[]) => mockVerifySession(...args),
    can: vi.fn(),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

import { AuthBrainNetworkError } from '@marlinjai/auth-brain-sdk';
import { GET } from '../route';

function session() {
  return {
    user: { id: 'u' },
    session: {},
    tenants: [
      { id: 't-a', group_id: 'tg_a', name: 'Acme', slug: 'acme', app_grants: ['sites'] },
      { id: 't-b', group_id: 'tg_b', name: 'Beta', slug: 'beta', app_grants: ['sites'] },
      { id: 't-c', group_id: 'tg_c', name: 'Corp', slug: 'corp', app_grants: ['studio'] },
    ],
    workspaces: [
      { id: 'ws_a', tenant_id: 't-a', slug: 'main' },
      { id: 'ws_b', tenant_id: 't-b', slug: 'main' },
      { id: 'ws_c', tenant_id: 't-c', slug: 'main' },
    ],
    active_tenant: null,
    active_workspace: null,
  };
}

function call(cookie: string, query = ''): Promise<Response> {
  return GET(
    new Request(`http://internal:3000/projects/migrate-company${query}`, {
      headers: cookie ? { cookie } : {},
    }),
  );
}

/** The Set-Cookie lines of a response, by cookie name. */
function setCookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    out[line.slice(0, line.indexOf('='))] = line;
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySession.mockResolvedValue(session());
});

describe('GET /projects/migrate-company', () => {
  it("maps a granted company's workspace to framer_company and deletes framer_ws", async () => {
    const res = await call('lumitra_session=s; framer_ws=ws_b');

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/projects?migrated=1');
    const cookies = setCookies(res);
    expect(cookies.framer_company).toMatch(/^framer_company=t-b;/);
    expect(cookies.framer_company).toMatch(/HttpOnly/i);
    expect(cookies.framer_company).toMatch(/SameSite=lax/i);
    expect(cookies.framer_company).toMatch(/Path=\//);
    expect(cookies.framer_company).not.toMatch(/Domain=/i);
    expect(cookies.framer_ws).toMatch(/^framer_ws=;/);
    expect(cookies.framer_ws).toMatch(/Max-Age=0/);
    expect(cookies.framer_ws).toMatch(/Path=\//);
  });

  it('deletes framer_ws without a company when its company lacks the grant', async () => {
    const cookies = setCookies(await call('lumitra_session=s; framer_ws=ws_c'));

    expect(cookies.framer_company).toBeUndefined();
    expect(cookies.framer_ws).toMatch(/Max-Age=0/);
  });

  it('deletes a forged framer_ws without writing a company', async () => {
    const cookies = setCookies(await call('lumitra_session=s; framer_ws=ws_foreign'));

    expect(cookies.framer_company).toBeUndefined();
    expect(cookies.framer_ws).toMatch(/Max-Age=0/);
  });

  it('keeps a usable framer_company (it wins) and still deletes framer_ws', async () => {
    const cookies = setCookies(await call('lumitra_session=s; framer_company=t-a; framer_ws=ws_b'));

    expect(cookies.framer_company).toBeUndefined();
    expect(cookies.framer_ws).toMatch(/Max-Age=0/);
  });

  it('keeps a validated deep link and drops an unsafe one', async () => {
    const deep = await call('lumitra_session=s; framer_ws=ws_a', '?next=%2Fprojects%2Fsite_1');
    expect(deep.headers.get('location')).toBe('/projects?migrated=1&next=%2Fprojects%2Fsite_1');

    const evil = await call('lumitra_session=s; framer_ws=ws_a', '?next=https%3A%2F%2Fevil.example');
    expect(evil.headers.get('location')).toBe('/projects?migrated=1');

    const self = await call('lumitra_session=s; framer_ws=ws_a', '?next=%2Fprojects%2Fmigrate-company');
    expect(self.headers.get('location')).toBe('/projects?migrated=1');
  });

  it('without a session it touches no cookie and returns to the dashboard (which logs in)', async () => {
    const res = await call('framer_ws=ws_a');

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/projects?migrated=1');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(mockVerifySession).not.toHaveBeenCalled();
  });

  it('an invalid session touches no cookie', async () => {
    mockVerifySession.mockResolvedValue(null);

    expect((await call('lumitra_session=bad; framer_ws=ws_a')).headers.getSetCookie()).toEqual([]);
  });

  it('an auth-brain outage touches no cookie (the choice survives for the next try)', async () => {
    mockVerifySession.mockRejectedValue(new AuthBrainNetworkError(new Error('down')));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await call('lumitra_session=s; framer_ws=ws_a');

    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
