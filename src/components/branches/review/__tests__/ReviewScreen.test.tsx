// src/components/branches/review/__tests__/ReviewScreen.test.tsx
//
// The review screen of slice S5 (docs/plans/2026-11-10-site-branches.md, section 3 "A reviewer"), with the branch
// routes mocked at the client and the panes stubbed (the browser proof draws them). Covers the four paths of a
// stateful flow: forward (review, approve, merge), backtrack (an answer changed, main moving mid-review, an edit
// after approval), resume (a reload finds the answers; stale ones gone) and re-entry (a merged branch, a merge
// that brought main in first).

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BranchReviewJson, ShownConflictJson } from '@/lib/sites/branchClient';
import type { BranchSummaryJson } from '@/lib/sites/branches';
import type { DocumentReview } from '@/lib/siteMerge/elementChanges';

const { client, router, panes } = vi.hoisted(() => ({
  client: { changes: vi.fn(), changesIfMoved: vi.fn(), answers: vi.fn(), update: vi.fn(), approve: vi.fn(), sendBack: vi.fn(), merge: vi.fn() },
  router: { refresh: vi.fn() },
  panes: [] as Array<{ side: string; outlines: string; focusId: string | null; emptyText: string; hasPage: boolean }>,
}));
vi.mock('@/lib/sites/branchClient', async (importActual) => ({ ...(await importActual<typeof import('@/lib/sites/branchClient')>()), branchClient: client }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../ReviewPane', () => ({
  ReviewPane: (p: { side: string; title: string; outlines: string; focusId: string | null; emptyText: string; page: unknown }) => {
    panes.push({ side: p.side, outlines: p.outlines, focusId: p.focusId, emptyText: p.emptyText, hasPage: Boolean(p.page) });
    return <section aria-label={p.title} data-outlines={p.outlines} />;
  },
}));

import { ReviewScreen } from '../ReviewScreen';
import { BranchApiError } from '@/lib/sites/branchClient';

const BRANCH = 'site-branch';
const MAIN = 'site-main';

function summary(over: Partial<BranchSummaryJson> = {}): BranchSummaryJson {
  return {
    branchId: BRANCH, mainSiteId: MAIN, name: 'Spring sale', status: 'open', createdByKind: 'user', createdBy: 'u', createdAt: '2026-11-11T09:00:00.000Z',
    updatedAt: '2026-11-11T09:00:00.000Z', version: 3, baseVersion: 7, mainMoved: false, readyBy: null, readyAt: null, reviewNote: null, approved: false,
    mergedAt: null, discardedAt: null,
    undoUntil: null,
    undoneIntoBranchId: null,
    undoneAt: null, ...over,
  };
}
const NONE = { site: [], settings: [], pages: { added: [], removed: [], changed: [] }, components: { added: [], removed: [], changed: [] }, nodes: { added: 0, removed: 0, changed: 0 }, pageOrder: false };
const LIST: DocumentReview = {
  site: [],
  settings: [],
  pageOrder: false,
  units: [
    {
      unit: 'page', id: 'home', title: 'Home', change: 'changed', slug: { before: '', after: '' }, fields: [],
      elements: [
        { id: 'title', kind: 'changed', type: 'h1', label: 'Fresh rolls', fields: [{ field: 'props.children', before: 'Fresh bread', after: 'Fresh rolls' }] },
        { id: 'new', kind: 'added', type: 'p', label: 'Open Sundays', fields: [] },
        { id: 'gone', kind: 'removed', type: 'p', label: 'Closed Mondays', fields: [] },
      ],
    },
    { unit: 'page', id: 'team', title: 'Team', change: 'added', slug: { before: null, after: 'team' }, fields: [], elements: [] },
  ],
};
const conflict = (id: string, main: string, branch: string): ShownConflictJson => ({
  id, kind: 'value', unit: { kind: 'node', id: 'title', container: 'page:home' }, path: ['props', 'children'], fingerprint: `fp-${id}`, options: ['main', 'branch'], base: 'Fresh bread', main, branch,
});
function review(over: Partial<BranchReviewJson> = {}): BranchReviewJson {
  return {
    branch: summary(), token: 'tok-1', upToDate: true, branchChanges: NONE, mainChanges: null, conflicts: [], settled: [], problems: [], review: LIST,
    versions: { main: 8, branch: 3 }, ...over,
  };
}
const snapshot = (id: string) => ({ id, metadata: { title: id }, pages: {} }) as never;
const CAN_ALL = { edit: true, review: true, merge: true };

function open(can: { edit: boolean; review: boolean; merge: boolean } | null = CAN_ALL) {
  return render(
    <ReviewScreen
      branchId={BRANCH} branchName="Spring sale" mainSiteId={MAIN} mainName="Bakery"
      branch={{ snapshot: snapshot(BRANCH), version: 3 }} main={{ snapshot: snapshot(MAIN), version: 8 }} can={can}
    />,
  );
}
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const lastPane = (side: string) => [...panes].reverse().find((p) => p.side === side)!;

beforeEach(() => {
  panes.length = 0;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('forward', () => {
  it('lists the changes by page with old and new values, and outlines them on each side', async () => {
    client.changes.mockResolvedValue(review());
    open();
    expect(await screen.findByText('2 pages, 3 elements changed')).toBeTruthy();
    const nav = screen.getByRole('region', { name: 'Questions and changes' });
    expect(within(nav).getByText(/Fresh bread → Fresh rolls/)).toBeTruthy();
    // The branch outlines what it added and changed; main what it removed and changed.
    expect(lastPane('branch').outlines).toMatch(/"title".*\n.*"new"/);
    expect(lastPane('branch').outlines).not.toContain('"gone"');
    expect(lastPane('main').outlines).toContain('"gone"');
    expect(lastPane('main').outlines).not.toContain('"new"');
    // Choosing an element brings it into view on both sides, outlined thicker.
    fireEvent.click(within(nav).getByText('Open Sundays'));
    expect(lastPane('branch').focusId).toBe('new');
    expect(lastPane('branch').outlines).toMatch(/"new"\]\{outline:4px/);
    // A page new on the branch has nothing on main.
    fireEvent.click(within(nav).getByText('Team'));
    expect(lastPane('main').emptyText).toBe('This page is new on the branch.');
  });

  it('approves, then merges and says nothing was published, with the way to main', async () => {
    client.changes.mockResolvedValueOnce(review()).mockResolvedValue(review({ branch: summary({ approved: true }) }));
    client.approve.mockResolvedValue({ branch: summary({ approved: true }) });
    client.merge.mockResolvedValue({ merged: true, branch: summary({ status: 'merged' }), mainVersion: 9 });
    open();
    await screen.findByText(/elements changed/);
    fireEvent.click(button(/looks good/i));
    await waitFor(() => expect(client.approve).toHaveBeenCalledWith(BRANCH, 'tok-1'));
    expect(await screen.findByText(/Marked as looking good/)).toBeTruthy();
    await waitFor(() => expect(client.changes).toHaveBeenCalledTimes(2));
    // What the press does is text the button points at, not only its tooltip.
    expect(document.getElementById(button('Merge into Bakery').getAttribute('aria-describedby') ?? '')?.textContent).toBe('Merge into Bakery. Nothing is published.');
    fireEvent.click(button('Merge into Bakery'));
    expect(await screen.findByRole('heading', { name: 'Merged into Bakery' })).toBeTruthy();
    expect(screen.getByText(/Nothing was published/)).toBeTruthy();
    expect((screen.getByRole('link', { name: 'Open Bakery' }) as HTMLAnchorElement).getAttribute('href')).toBe(`/projects/${MAIN}`);
    // No read after the merge: the branch is gone and would only answer 410.
    const reads = client.changes.mock.calls.length;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(client.changes.mock.calls.length).toBe(reads);
  });

  it('sends back with a note, and needs one', async () => {
    client.changes.mockResolvedValue(review());
    client.sendBack.mockResolvedValue({ branch: summary({ reviewNote: 'Fix the hours' }) });
    open();
    await screen.findByText(/elements changed/);
    fireEvent.click(button(/^send back$/i));
    const form = screen.getByRole('textbox').closest('form')!;
    expect((within(form).getByRole('button', { name: 'Send back' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Fix the hours ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send back' }));
    await waitFor(() => expect(client.sendBack).toHaveBeenCalledWith(BRANCH, 'tok-1', 'Fix the hours'));
    expect(await screen.findByText(/Sent back with your note/)).toBeTruthy();
  });
});

describe('what a person may do', () => {
  it('a viewer without review or merge rights reads, with each control off and why', async () => {
    client.changes.mockResolvedValue(review({ upToDate: false, conflicts: [conflict('c1', 'Main title', 'Branch title')] }));
    open({ edit: false, review: false, merge: false });
    await screen.findByText(/elements changed/);
    expect(button(/looks good/i).disabled).toBe(true);
    expect(button(/looks good/i).title).toMatch(/may not review/);
    expect(button('Update from Bakery first').disabled).toBe(true);
    expect(button('Update from Bakery first').title).toMatch(/Only an admin/);
    expect(button(/Bakery: Main title/).getAttribute('aria-disabled')).toBe('true');
    expect(button(/All from Bakery/).title).toMatch(/Only someone who may edit/);
    // The reasons are on the page as text too: a disabled button's tooltip reaches neither a keyboard nor a touch screen.
    expect(screen.getByText(/“Looks good” and “Send back” are off: You may not review/)).toBeTruthy();
    expect(screen.getByText(/The answers are off: Only someone who may edit/)).toBeTruthy();
    expect(screen.getByText(/Merge is not possible yet: Only an admin/)).toBeTruthy();
  });

  it('with the permission service down, every control stays on and the server decides', async () => {
    client.changes.mockResolvedValue(review());
    client.merge.mockRejectedValue(new BranchApiError('forbidden', 'Only an admin of this company can merge.', 403));
    open(null);
    await screen.findByText(/elements changed/);
    fireEvent.click(button('Merge into Bakery'));
    expect(await screen.findByText('Only an admin of this company can merge.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Merged into/ })).toBeNull();
  });
});

describe('questions from main', () => {
  const two = () => review({ upToDate: false, conflicts: [conflict('c1', 'Main title', 'Branch title'), { ...conflict('c2', 'Main hours', 'Branch hours'), unit: { kind: 'node', id: 'new', container: 'page:home' } }] });

  it('stores each answer as given, one request at a time, and merge waits for every answer', async () => {
    client.changes.mockResolvedValue(two());
    let release!: () => void;
    client.answers.mockImplementationOnce(() => new Promise((r) => (release = () => r(review({ upToDate: false, conflicts: [two().conflicts[1]], settled: [{ id: 'c1', pick: 'branch', conflict: two().conflicts[0] }] })))));
    open();
    expect(await screen.findByText(/Home: Fresh rolls: text/)).toBeTruthy();
    expect(button('Update from Bakery first').disabled).toBe(true);
    expect(button('Update the branch').disabled).toBe(true);
    // Why "Update the branch" is off is text beside it, not only its tooltip.
    expect(screen.getByText('Every question needs an answer first.')).toBeTruthy();
    fireEvent.click(button(/Branch: Branch title/));
    await waitFor(() => expect(client.answers).toHaveBeenCalledWith(BRANCH, 'tok-1', { c1: { fingerprint: 'fp-c1', pick: 'branch' } }));
    // While it is stored, no other answer can be given.
    expect(button(/Branch: Branch hours/).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button(/Branch: Branch hours/));
    expect(client.answers).toHaveBeenCalledTimes(1);
    await act(async () => release());
    expect(button(/Branch: Branch title/).getAttribute('aria-pressed')).toBe('true');
    // The answered question stays where it was, first, and the pressed button keeps the keyboard's focus.
    expect(screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-conflict')).map((li) => li.getAttribute('data-conflict'))).toEqual(['c1', 'c2']);
    expect(button('Update from Bakery first').disabled).toBe(true);
  });

  it('all from main sends every question in one request, also the answered ones', async () => {
    client.changes.mockResolvedValue(review({ upToDate: false, conflicts: [conflict('c2', 'M', 'B')], settled: [{ id: 'c1', pick: 'branch', conflict: conflict('c1', 'Main title', 'Branch title') }] }));
    client.answers.mockResolvedValue(review({ upToDate: false, settled: [] }));
    open();
    await screen.findByText(/All from Bakery/);
    fireEvent.click(button('All from Bakery'));
    await waitFor(() => expect(client.answers).toHaveBeenCalledTimes(1));
    expect(client.answers).toHaveBeenCalledWith(BRANCH, 'tok-1', { c2: { fingerprint: 'fp-c2', pick: 'main' }, c1: { fingerprint: 'fp-c1', pick: 'main' } });
  });

  it('backtrack: an answer is changed by pressing the other side', async () => {
    const answered = review({ upToDate: false, settled: [{ id: 'c1', pick: 'main', conflict: conflict('c1', 'Main title', 'Branch title') }] });
    client.changes.mockResolvedValue(answered);
    client.answers.mockResolvedValue(review({ upToDate: false, settled: [{ id: 'c1', pick: 'branch', conflict: conflict('c1', 'Main title', 'Branch title') }] }));
    open();
    expect((await screen.findByRole('button', { name: /Bakery: Main title/ })).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button(/Branch: Branch title/));
    await waitFor(() => expect(button(/Branch: Branch title/).getAttribute('aria-pressed')).toBe('true'));
    expect(button(/Bakery: Main title/).getAttribute('aria-pressed')).toBe('false');
    // Every question answered: Update may go, and brings main in with the review's token.
    client.update.mockResolvedValue({ updated: true, branch: summary(), token: 'tok-2' });
    fireEvent.click(button('Update the branch'));
    await waitFor(() => expect(client.update).toHaveBeenCalledWith(BRANCH, 'tok-1'));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('main moving mid-review: the answer is refused as stale, the review is read again and the pictures reload', async () => {
    client.changes.mockResolvedValueOnce(two()).mockResolvedValue(review({ token: 'tok-2', upToDate: false, conflicts: [conflict('c3', 'Newer', 'Branch title')], versions: { main: 9, branch: 3 } }));
    client.answers.mockRejectedValue(new BranchApiError('branch_review_stale', 'stale', 409));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Branch: Branch title/ }));
    expect(await screen.findByText(/changed while you were reviewing/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Bakery: Newer/ })).toBeTruthy();
    // The data names main 9, the pictures are of 8: reloaded once.
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
  });
});

describe('resume and re-entry', () => {
  it('resume: a fresh open shows the stored answers as given; ones that no longer apply are simply gone', async () => {
    client.changes.mockResolvedValue(review({ upToDate: false, conflicts: [conflict('c2', 'M2', 'B2')], settled: [{ id: 'c1', pick: 'branch', conflict: conflict('c1', 'Main title', 'Branch title') }] }));
    open();
    expect((await screen.findByRole('button', { name: /Branch: Branch title/ })).getAttribute('aria-pressed')).toBe('true');
    expect(button(/Bakery: M2/).getAttribute('aria-pressed')).toBe('false');
  });

  it('the counter-case: nothing moved, so the pictures are not reloaded', async () => {
    client.changes.mockResolvedValue(review());
    open();
    await screen.findByText(/elements changed/);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('the regular look asks whether anything moved, with the key of the review it holds, and reads the review only when something did', async () => {
    client.changes.mockResolvedValue(review({ state: 'state-1' }));
    client.changesIfMoved.mockResolvedValueOnce({ current: true, state: 'state-1' });
    open();
    await screen.findByText(/elements changed/);
    expect(client.changes).toHaveBeenCalledTimes(1);
    const look = () =>
      act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });

    // Nothing moved: no review comes back, the page keeps what it shows and reloads no picture.
    await look();
    expect(client.changesIfMoved).toHaveBeenLastCalledWith(BRANCH, 'state-1');
    expect(client.changes).toHaveBeenCalledTimes(1);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(button(/looks good/i).disabled).toBe(false);

    // Someone approved meanwhile: the answer is the review itself, shown at once, and the next look asks with its key.
    client.changesIfMoved.mockResolvedValueOnce(review({ state: 'state-2', branch: summary({ approved: true }) }));
    await look();
    await screen.findByText(/· Looks good/);
    client.changesIfMoved.mockResolvedValueOnce({ current: true, state: 'state-2' });
    await look();
    expect(client.changesIfMoved).toHaveBeenLastCalledWith(BRANCH, 'state-2');
    expect(client.changes).toHaveBeenCalledTimes(1);

    // A branch closed elsewhere is heard by the regular look too.
    client.changesIfMoved.mockRejectedValueOnce(new BranchApiError('branch_closed', 'closed', 410));
    await look();
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1));
  });

  it('a page that is new as a whole is one line with its number of elements, never a list of them', async () => {
    const list: DocumentReview = {
      ...LIST,
      units: [{ unit: 'page', id: 'team', title: 'Team', change: 'added', slug: { before: null, after: 'team' }, fields: [], elements: [], elementCount: 1200 }],
    };
    client.changes.mockResolvedValue(review({ review: list }));
    open();
    await screen.findByText('The whole page is new, with 1,200 elements.');
    expect(screen.getByText('1 page, 1200 elements changed')).toBeTruthy();
    expect(document.querySelectorAll('[data-element]')).toHaveLength(0);
    expect(lastPane('branch').outlines).toBe('');
  });

  it('a rename moves only the token: the pictures reload once, and not again for the same state', async () => {
    client.changes.mockResolvedValueOnce(review()).mockResolvedValue(review({ token: 'tok-renamed' }));
    open();
    await screen.findByText(/elements changed/);
    expect(router.refresh).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }
    await waitFor(() => expect(client.changes).toHaveBeenCalledTimes(3));
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('an edit after approval withdraws it: the next read says so and offers Looks good again', async () => {
    client.changes.mockResolvedValueOnce(review({ branch: summary({ approved: true }) })).mockResolvedValue(review({ token: 'tok-2', branch: summary({ approved: false }), versions: { main: 8, branch: 4 } }));
    open();
    await screen.findByText(/· Looks good/);
    expect(button(/looks good/i).disabled).toBe(true);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(button(/looks good/i).disabled).toBe(false));
    expect(screen.queryByText(/· Looks good/)).toBeNull();
  });

  it('a merge that brought main in first says so and reads the review again', async () => {
    client.changes.mockResolvedValue(review());
    client.merge.mockRejectedValue(new BranchApiError('branch_updated_from_main', 'brought in first', 409));
    open();
    await screen.findByText(/elements changed/);
    fireEvent.click(button('Merge into Bakery'));
    expect(await screen.findByText(/were brought into the branch first/)).toBeTruthy();
    await waitFor(() => expect(client.changes).toHaveBeenCalledTimes(2));
  });

  it('a branch merged or discarded elsewhere reloads the page, which says what happened', async () => {
    client.changes.mockRejectedValue(new BranchApiError('branch_closed', 'closed', 410));
    open();
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('a branch with no changes cannot be merged, and says why', async () => {
    client.changes.mockResolvedValue(review({ review: { site: [], settings: [], units: [], pageOrder: false } }));
    open();
    expect(await screen.findByText('This branch changes nothing yet.')).toBeTruthy();
    expect(button('Merge into Bakery').disabled).toBe(true);
    expect(screen.getByText(/The branch changes nothing yet/)).toBeTruthy();
  });

  it('a result that would not be a valid site cannot be merged', async () => {
    client.changes.mockResolvedValue(review({ problems: [{ code: 'slug_taken', message: 'Two pages would have the address /about.' }] }));
    open();
    expect((await screen.findAllByText('Two pages would have the address /about.')).length).toBeGreaterThan(0);
    expect(button('Merge into Bakery').disabled).toBe(true);
  });
});
