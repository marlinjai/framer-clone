// The review page's guards (src/app/projects/[projectId]/review/page.tsx, slice S5): each loader outcome goes
// where the editor's does, and only a branch has a review.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';

const { load, nav } = vi.hoisted(() => ({
  load: vi.fn(),
  nav: {
    notFound: vi.fn(() => {
      throw new Error('NOT_FOUND');
    }),
    redirect: vi.fn((to: string) => {
      throw new Error(`REDIRECT ${to}`);
    }),
  },
}));
vi.mock('../../loader', () => ({ loadProjectSnapshot: load }));
vi.mock('next/navigation', () => nav);
vi.mock('../ReviewMount', () => ({ default: () => null }));
vi.mock('../../../AuthUnavailable', () => ({ default: () => null }));
vi.mock('../../../ClosedBranch', () => ({ default: () => null }));

import ReviewPage from '../page';
import ReviewMount from '../ReviewMount';
import ClosedBranch from '../../../ClosedBranch';
import AuthUnavailable from '../../../AuthUnavailable';

const params = (projectId: string) => ({ params: Promise.resolve({ projectId }) });
const snapshot = { id: 'branch-1' };
const main = { snapshot: { id: 'site-a1' }, version: 8 };
const onBranch = { kind: 'branch', siteId: 'branch-1', mainSiteId: 'site-a1', mainName: 'Bakery', branch: { name: 'Spring' } };

beforeEach(() => vi.clearAllMocks());

describe('the review page', () => {
  it('renders the review of a branch with both copies and the permissions', async () => {
    load.mockResolvedValue({ status: 'ok', snapshot, version: 3, site: {}, branch: onBranch, main, can: { edit: true, review: true, merge: false } });
    const el = (await ReviewPage(params('branch-1'))) as React.ReactElement<Record<string, unknown>>;
    expect(load).toHaveBeenCalledWith('branch-1', '/review', { withMain: true });
    expect(el.type).toBe(ReviewMount);
    expect(el.props).toEqual({
      branchId: 'branch-1', branchName: 'Spring', mainSiteId: 'site-a1', mainName: 'Bakery',
      branch: { snapshot, version: 3 }, main, can: { edit: true, review: true, merge: false },
    });
  });

  it('answers 404 for main, for a site with branches off, and for a missing or foreign id', async () => {
    load.mockResolvedValue({ status: 'ok', snapshot, version: 3, site: {}, branch: { kind: 'main', siteId: 'site-a1', siteName: 'Bakery', openBranches: 1 } });
    await expect(ReviewPage(params('site-a1'))).rejects.toThrow('NOT_FOUND');
    load.mockResolvedValue({ status: 'ok', snapshot, version: 3, site: {}, branch: null });
    await expect(ReviewPage(params('site-a1'))).rejects.toThrow('NOT_FOUND');
    load.mockResolvedValue({ status: 'not_found' });
    await expect(ReviewPage(params('nope'))).rejects.toThrow('NOT_FOUND');
  });

  it('sends no session to the login and no company to the chooser, and says when auth-brain is down', async () => {
    load.mockResolvedValue({ status: 'unauthenticated', loginUrl: '/login?x' });
    await expect(ReviewPage(params('branch-1'))).rejects.toThrow('REDIRECT /login?x');
    load.mockResolvedValue({ status: 'choose_company', chooserUrl: '/?choose' });
    await expect(ReviewPage(params('branch-1'))).rejects.toThrow('REDIRECT /?choose');
    load.mockResolvedValue({ status: 'auth_unavailable' });
    const el = (await ReviewPage(params('branch-1'))) as React.ReactElement<{ retryHref: string }>;
    expect(el.type).toBe(AuthUnavailable);
    expect(el.props.retryHref).toBe('/projects/branch-1/review');
  });

  it('a merged or discarded branch says what happened', async () => {
    const notice = { branchId: 'branch-1', status: 'merged' };
    load.mockResolvedValue({ status: 'branch_closed', notice });
    const el = (await ReviewPage(params('branch-1'))) as React.ReactElement<{ notice: unknown }>;
    expect(el.type).toBe(ClosedBranch);
    expect(el.props.notice).toBe(notice);
  });
});
