// src/lib/__tests__/activeCompanyCookie.test.ts
//
// A route handler must read the selector cookies exactly like a page (the
// next/headers jar): last duplicate wins, values URL-decoded. Proved by
// resolving the company for the same duplicated Cookie header through both
// paths and requiring the same answer.

import { describe, it, expect } from 'vitest';
import { RequestCookies } from 'next/dist/server/web/spec-extension/cookies';
import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';
import {
  companySelectorsFromJar,
  readCompanySelectors,
  readRequestCookie,
} from '../activeCompanyCookie';
import { resolveActiveCompany } from '@/server/sites/scope';

const session = {
  user: { id: 'u' },
  session: {},
  tenants: [
    { id: 't-a', group_id: 'tg_a', name: 'Acme', slug: 'acme', app_grants: ['sites'] },
    { id: 't-b', group_id: 'tg_b', name: 'Beta', slug: 'beta', app_grants: ['sites'] },
  ],
  workspaces: [
    { id: 'ws_a', tenant_id: 't-a', slug: 'main' },
    { id: 'ws_b', tenant_id: 't-b', slug: 'main' },
  ],
  active_tenant: null,
  active_workspace: null,
} as unknown as SessionVerifyResponse;

function req(cookie: string): Request {
  return new Request('http://t/api/projects', { headers: { cookie } });
}

describe('route-handler cookie reading matches the page cookie jar', () => {
  it.each([
    ['duplicated framer_company', 'lumitra_session=s; framer_company=t-a; framer_company=t-b'],
    ['duplicated framer_ws', 'lumitra_session=s; framer_ws=ws_a; framer_ws=ws_b'],
    ['URL-encoded value', 'lumitra_session=s; framer_company=t%2Db'],
  ])('page and API resolve the same company: %s', (_name, cookie) => {
    const api = resolveActiveCompany(session, readCompanySelectors(req(cookie)));
    const page = resolveActiveCompany(
      session,
      companySelectorsFromJar(new RequestCookies(new Headers({ cookie }))),
    );
    expect(api).toEqual(page);
    expect(api).toMatchObject({ ok: true, companyId: 't-b' });
  });

  it('keeps the last duplicate and decodes, like the jar', () => {
    expect(readRequestCookie(req('a=1; a=2'), 'a')).toBe('2');
    expect(readRequestCookie(req('a=x%20y'), 'a')).toBe('x y');
    expect(readRequestCookie(req('a='), 'a')).toBeNull();
    expect(readRequestCookie(req('b=1'), 'a')).toBeNull();
  });
});
