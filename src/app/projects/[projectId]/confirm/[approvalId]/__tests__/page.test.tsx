// @vitest-environment node
//
// The agent approval page (../page.tsx), rendered as the server component it
// is, with next/headers, auth-brain, the permission check and the repository
// mocked: a signed-out visitor goes to the login with this page as return_to;
// a recent sign-in with publishSite sees the server-built summary and the two
// buttons, and opening the page decides nothing; an old sign-in is sent through
// a fresh sign-in; a user without publishSite and an unknown link see why.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ cookie: undefined as string | undefined, session: null as unknown, canPublish: true, version: 3 }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'lumitra_session' && env.cookie ? { value: env.cookie } : undefined) }),
  headers: async () => new Headers({ host: 'app.lumitra.co', 'x-forwarded-proto': 'https' }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  },
}));
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: { verifySession: vi.fn(async () => env.session), can: vi.fn(), verifyApiKey: vi.fn(), getCurrentUser: vi.fn() },
}));
vi.mock('@/lib/auth-check', () => ({ checkWorkspaceAccess: vi.fn(async () => env.canPublish) }));
vi.mock('@/server/sites', async (importActual) => ({
  ...(await importActual<typeof import('@/server/sites')>()),
  getSiteRepository: () => ({ loadProjectWithVersion: async () => ({ project: {}, version: env.version }) }),
}));

import Page from '../page';
import { getApprovalStore } from '@/server/mcp/approvals';

function openRequest() {
  return getApprovalStore().open(
    { action: 'publish', tenantId: 'tenant-a', keyId: 'key_1', scope: { workspaceId: 'ws_a', tenantGroupId: 'tg_a' }, siteId: 'site-1', version: 3 },
    'Publish "Bakery" (site site-1) at version 3?',
  );
}

async function render(approvalId: string, projectId = 'site-1'): Promise<string> {
  const element = await Page({ params: Promise.resolve({ projectId, approvalId }) });
  return renderToStaticMarkup(element as React.ReactElement);
}

beforeEach(() => {
  env.cookie = 'sess';
  env.session = { user: { id: 'owner-a' }, session: { created_at: new Date(Date.now() - 60_000).toISOString() } };
  env.canPublish = true;
  env.version = 3;
});

describe('the agent approval page', () => {
  it('sends a signed-out visitor to the login, returning to this page', async () => {
    env.cookie = undefined;
    const { id } = openRequest();
    await expect(render(id)).rejects.toMatchObject({ url: expect.stringContaining(encodeURIComponent(`https://app.lumitra.co/projects/site-1/confirm/${id}`)) });
  });

  it('shows the server-built summary and both buttons to a recent sign-in with publishSite, deciding nothing', async () => {
    const { id } = openRequest();
    const html = await render(id);
    expect(html).toContain('Publish &quot;Bakery&quot; (site site-1) at version 3?');
    expect(html).toContain('Decline');
    expect(getApprovalStore().get(id)?.decision).toBeNull();
  });

  it('sends an old sign-in through a fresh one', async () => {
    env.session = { user: { id: 'owner-a' }, session: { created_at: new Date(Date.now() - 20 * 60_000).toISOString() } };
    const { id } = openRequest();
    const html = await render(id);
    expect(html).toContain('Sign in again to approve');
    expect(html).toContain('/api/auth/logout?return_to=');
    expect(html).not.toContain('Decline');
  });

  it('refuses a user without publishSite, an unknown link, a link of another site and a changed site', async () => {
    const { id } = openRequest();
    env.canPublish = false;
    expect(await render(id)).toContain('You cannot approve this');
    env.canPublish = true;
    expect(await render('no-such-link')).toContain('This approval link is not valid');
    expect(await render(id, 'site-2')).toContain('This approval link is not valid');
    env.version = 4;
    expect(await render(id)).toContain('The site changed since the agent asked');
  });
});
