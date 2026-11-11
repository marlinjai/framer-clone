// src/components/branches/__tests__/branches.test.tsx
//
// Site branches in the editor, slice S4 (docs/plans/2026-11-10-site-branches.md): the switcher, the badge,
// "Main has changed" with Update and "Review and merge", in each state the plan names (branches off, main with no
// branches, an open branch, a ready one, one behind main) and the closed-branch page. The branch routes are
// mocked at the client; leaving the page is mocked so nothing navigates.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SiteBranchProvider } from '@/contexts/SiteBranchContext';
import type { BranchSummaryJson, EditorBranchState } from '@/lib/sites/branches';
import type { BranchReviewJson } from '@/lib/sites/branchClient';

const { client, leave } = vi.hoisted(() => ({
  client: {
    list: vi.fn(),
    create: vi.fn(),
    change: vi.fn(),
    discard: vi.fn(),
    get: vi.fn(),
    changes: vi.fn(),
    update: vi.fn(),
    merge: vi.fn(),
  },
  leave: { savedBeforeLeaving: vi.fn(async () => true), openSite: vi.fn(), leaveClosedBranch: vi.fn() },
}));
vi.mock('@/lib/sites/branchClient', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/sites/branchClient')>();
  return { ...actual, branchClient: client };
});

vi.mock('../leave', () => leave);

import BranchSwitcher from '../BranchSwitcher';
import { BranchBadge, MainChangedNote, ReviewAndMergeButton } from '../BranchBar';
import { discardText } from '../BranchDialogs';
import ClosedBranch, { closedBranchText } from '@/app/projects/ClosedBranch';
import { BranchApiError } from '@/lib/sites/branchClient';

const MAIN = 'site-main';
const BRANCH = 'site-branch';

function summary(over: Partial<BranchSummaryJson> = {}): BranchSummaryJson {
  return {
    branchId: BRANCH,
    mainSiteId: MAIN,
    name: 'Spring sale',
    status: 'open',
    createdByKind: 'user',
    createdBy: 'user-a',
    createdAt: '2026-11-11T09:00:00.000Z',
    updatedAt: '2026-11-11T09:00:00.000Z',
    version: 3,
    baseVersion: 7,
    mainMoved: false,
    readyBy: null,
    readyAt: null,
    reviewNote: null,
    approved: false,
    mergedAt: null,
    discardedAt: null,
    ...over,
  };
}

const NONE = { site: [], settings: [], pages: { added: [], removed: [], changed: [] }, components: { added: [], removed: [], changed: [] }, nodes: { added: 0, removed: 0, changed: 0 }, pageOrder: false };

function review(over: Partial<BranchReviewJson> = {}): BranchReviewJson {
  return {
    branch: summary(),
    token: 'tok-1',
    upToDate: true,
    branchChanges: { ...NONE, pages: { added: [], removed: [], changed: ['home'] }, nodes: { added: 1, removed: 0, changed: 2 } },
    mainChanges: null,
    conflicts: [],
    settled: [],
    problems: [],
    ...over,
  };
}

const onMain: EditorBranchState = { kind: 'main', siteId: MAIN, siteName: 'Bakery', openBranches: 0 };
const onBranch = (over: Partial<BranchSummaryJson> = {}): EditorBranchState => ({
  kind: 'branch',
  siteId: BRANCH,
  mainSiteId: MAIN,
  mainName: 'Bakery',
  branch: summary(over),
});

function Bar() {
  return (
    <>
      <BranchSwitcher />
      <BranchBadge />
      <MainChangedNote />
      <ReviewAndMergeButton />
    </>
  );
}

function renderWith(state: EditorBranchState | null) {
  return render(
    <SiteBranchProvider initial={state}>
      <Bar />
    </SiteBranchProvider>,
  );
}

function openMenu(name: RegExp) {
  const trigger = screen.getByRole('button', { name });
  act(() => {
    fireEvent.keyDown(trigger, { key: 'Enter' });
  });
}

beforeEach(() => {
  Object.values(client).forEach((fn) => fn.mockReset());
  Object.values(leave).forEach((fn) => fn.mockReset());
  leave.savedBeforeLeaving.mockResolvedValue(true);
  client.list.mockResolvedValue({ mainSiteId: MAIN, mainVersion: 7, open: [summary()], closed: [] });
  client.get.mockResolvedValue({ branch: summary() });
});

afterEach(() => cleanup());

describe('branches off for the company', () => {
  it('shows nothing of branches', () => {
    const { container } = renderWith(null);
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('main', () => {
  it('names Main in the switcher, with no badge and no review', () => {
    renderWith(onMain);
    expect(screen.getByRole('button', { name: 'Main. Switch branch' })).toBeTruthy();
    expect(screen.queryByText('Branch')).toBeNull();
    expect(screen.queryByRole('button', { name: /review and merge/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /update/i })).toBeNull();
  });

  it('lists the open branches and opens one after saving this tab', async () => {
    renderWith(onMain);
    openMenu(/switch branch/i);
    const item = await screen.findByRole('menuitem', { name: /spring sale/i });
    fireEvent.click(item);
    await waitFor(() => expect(leave.openSite).toHaveBeenCalledWith(BRANCH));
    expect(leave.savedBeforeLeaving).toHaveBeenCalledWith(MAIN);
    expect(client.list).toHaveBeenCalledWith(MAIN);
  });

  it('stays when this tab\'s work could not be saved, and says why', async () => {
    leave.savedBeforeLeaving.mockResolvedValue(false);
    renderWith(onMain);
    openMenu(/switch branch/i);
    fireEvent.click(await screen.findByRole('menuitem', { name: /spring sale/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/not saved yet/));
    expect(leave.openSite).not.toHaveBeenCalled();
  });

  it('says so when the branches cannot be listed', async () => {
    client.list.mockRejectedValue(new BranchApiError('branches_failed', 'listing the branches failed, try again', 500));
    renderWith(onMain);
    openMenu(/switch branch/i);
    expect(await screen.findByText('listing the branches failed, try again')).toBeTruthy();
  });

  it('creates a branch from the dialog, keeping one id across a retry, and opens it', async () => {
    client.create
      .mockRejectedValueOnce(new BranchApiError('network', 'The server could not be reached.', 0))
      .mockResolvedValue({ branch: summary({ branchId: 'site-new' }), created: true });
    renderWith(onMain);
    openMenu(/switch branch/i);
    fireEvent.click(await screen.findByRole('menuitem', { name: /new branch/i }));
    const field = await screen.findByLabelText('Branch name');
    fireEvent.change(field, { target: { value: '  Spring   sale ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' }));
    await waitFor(() => expect(leave.openSite).toHaveBeenCalledWith('site-new'));
    const [first, second] = client.create.mock.calls;
    expect(first[1]).toBe('Spring sale');
    expect(first[2]).toBe(second[2]);
  });

  it('refuses an empty name in the dialog without a request', async () => {
    renderWith(onMain);
    openMenu(/switch branch/i);
    fireEvent.click(await screen.findByRole('menuitem', { name: /new branch/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create branch' }));
    expect((await screen.findByRole('alert')).textContent).toBe('A branch needs a name.');
    expect(client.create).not.toHaveBeenCalled();
  });
});

describe('an open branch', () => {
  it('names the branch, shows the badge and Review and merge, and no Update', () => {
    renderWith(onBranch());
    expect(screen.getByRole('button', { name: 'Branch Spring sale. Switch branch' })).toBeTruthy();
    expect(screen.getByText('Branch')).toBeTruthy();
    expect(screen.getByRole('button', { name: /review and merge/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /update/i })).toBeNull();
  });

  it('merges from the review when nothing needs an answer, then leaves for main', async () => {
    client.changes.mockResolvedValue(review());
    client.merge.mockResolvedValue({ merged: true, branch: summary({ status: 'merged' }), mainVersion: 8 });
    renderWith(onBranch());
    fireEvent.click(screen.getByRole('button', { name: /review and merge/i }));
    expect(await screen.findByText(/2 elements|3 elements/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Merge into Bakery' }));
    await waitFor(() => expect(leave.leaveClosedBranch).toHaveBeenCalledWith(BRANCH, MAIN));
    expect(client.merge).toHaveBeenCalledWith(BRANCH, 'tok-1');
    expect(leave.savedBeforeLeaving).toHaveBeenCalledWith(BRANCH);
  });

  it('shows a refused merge (not an admin) and stays', async () => {
    client.changes.mockResolvedValue(review());
    client.merge.mockRejectedValue(new BranchApiError('forbidden', 'Only an admin of this company can merge.', 403));
    renderWith(onBranch());
    fireEvent.click(screen.getByRole('button', { name: /review and merge/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Merge into Bakery' }));
    expect(await screen.findByText('Only an admin of this company can merge.')).toBeTruthy();
    expect(leave.leaveClosedBranch).not.toHaveBeenCalled();
  });

  it('cannot merge a branch without changes', async () => {
    client.changes.mockResolvedValue(review({ branchChanges: NONE }));
    renderWith(onBranch());
    fireEvent.click(screen.getByRole('button', { name: /review and merge/i }));
    expect(await screen.findByText(/No changes yet/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Merge into Bakery' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('names a result that would not be a valid site, and cannot merge it', async () => {
    client.changes.mockResolvedValue(review({ problems: [{ code: 'slug_taken', message: 'Two pages would have the address /about.' }] }));
    renderWith(onBranch());
    fireEvent.click(screen.getByRole('button', { name: /review and merge/i }));
    expect(await screen.findByText('Two pages would have the address /about.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Merge into Bakery' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not review what this tab has not saved', async () => {
    leave.savedBeforeLeaving.mockResolvedValue(false);
    renderWith(onBranch());
    fireEvent.click(screen.getByRole('button', { name: /review and merge/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not saved yet/);
    expect(client.changes).not.toHaveBeenCalled();
  });
});

describe('a ready branch', () => {
  it('says ready, or approved once approved', () => {
    renderWith(onBranch({ status: 'ready' }));
    expect(screen.getByText('Ready for review')).toBeTruthy();
    cleanup();
    renderWith(onBranch({ status: 'ready', approved: true }));
    expect(screen.getByText('Approved')).toBeTruthy();
  });

  it('goes back to open from the switcher', async () => {
    client.change.mockResolvedValue({ branch: summary() });
    renderWith(onBranch({ status: 'ready' }));
    openMenu(/switch branch/i);
    fireEvent.click(await screen.findByRole('menuitem', { name: /back to open/i }));
    await waitFor(() => expect(client.change).toHaveBeenCalledWith(MAIN, BRANCH, { ready: false }));
    await waitFor(() => expect(screen.getByRole('status', { name: '' }).textContent).toBe('Back to open.'));
  });
});

describe('a branch behind main', () => {
  it('offers Update, which brings main in with the review\'s token', async () => {
    client.changes.mockResolvedValue(review({ upToDate: false, mainChanges: NONE }));
    client.update.mockResolvedValue({ updated: true, branch: summary(), token: 'tok-2' });
    client.get.mockResolvedValue({ branch: summary({ mainMoved: false, baseVersion: 8 }) });
    renderWith(onBranch({ mainMoved: true }));
    fireEvent.click(screen.getByRole('button', { name: /update/i }));
    await waitFor(() => expect(client.update).toHaveBeenCalledWith(BRANCH, 'tok-1'));
    // The record is read again: main no longer moved, so Update goes and the outcome is said.
    await waitFor(() => expect(screen.queryByRole('button', { name: /update/i })).toBeNull());
    expect(screen.getByText('Updated from Bakery.')).toBeTruthy();
  });

  it('does not update over conflicts, and says the branch is unchanged', async () => {
    client.changes.mockResolvedValue(review({ upToDate: false, conflicts: [{ id: 'c1', kind: 'value', unit: { kind: 'page', id: 'home' }, path: ['props'], fingerprint: 'f' }] }));
    renderWith(onBranch({ mainMoved: true }));
    fireEvent.click(screen.getByRole('button', { name: /update/i }));
    expect(await screen.findByText(/conflict in 1 place, so it was not updated/)).toBeTruthy();
    expect(client.update).not.toHaveBeenCalled();
  });

  it('shows the conflicts in the review and cannot merge', async () => {
    client.changes.mockResolvedValue(review({ upToDate: false, mainChanges: NONE, conflicts: [{ id: 'c1', kind: 'value', unit: { kind: 'page', id: 'home' }, path: ['props'], fingerprint: 'f' }, { id: 'c2', kind: 'value', unit: { kind: 'page', id: 'home' }, path: ['x'], fingerprint: 'g' }] }));
    renderWith(onBranch({ mainMoved: true }));
    fireEvent.click(screen.getByRole('button', { name: /review and merge/i }));
    expect(await screen.findByText(/conflict in 2 places/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Merge into Bakery' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reads the review again when the merge brought main in first', async () => {
    client.changes.mockResolvedValueOnce(review({ upToDate: false, mainChanges: NONE })).mockResolvedValue(review({ token: 'tok-2' }));
    client.merge.mockRejectedValueOnce(new BranchApiError('branch_updated_from_main', 'Main had changed: its changes were brought in first. Review again, then merge.', 409));
    renderWith(onBranch({ mainMoved: true }));
    fireEvent.click(screen.getByRole('button', { name: /review and merge/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Merge into Bakery' }));
    expect(await screen.findByText(/brought in first/)).toBeTruthy();
    await waitFor(() => expect(client.changes).toHaveBeenCalledTimes(2));
    expect(leave.leaveClosedBranch).not.toHaveBeenCalled();
  });
});

describe('discard', () => {
  it('names what is lost in each state of the count', () => {
    expect(discardText({ kind: 'loading' })).toMatch(/Counting/);
    expect(discardText({ kind: 'unknown' })).toMatch(/could not be counted/);
    expect(discardText({ kind: 'known', text: 'No changes yet' })).toBe('This branch holds no changes yet.');
    expect(discardText({ kind: 'known', text: '1 page, 3 elements changed' })).toBe('1 page, 3 elements changed on this branch will be lost.');
  });

  it('discards from the switcher and leaves for main', async () => {
    client.changes.mockResolvedValue(review());
    client.discard.mockResolvedValue({ branch: summary({ status: 'discarded' }), discarded: true });
    renderWith(onBranch());
    openMenu(/switch branch/i);
    fireEvent.click(await screen.findByRole('menuitem', { name: /discard branch/i }));
    expect(await screen.findByText(/on this branch will be lost/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard branch' }));
    });
    await waitFor(() => expect(leave.leaveClosedBranch).toHaveBeenCalledWith(BRANCH, MAIN));
  });
});

describe('the closed branch page', () => {
  const notice = { branchId: BRANCH, status: 'merged' as const, name: 'Spring sale', mainSiteId: MAIN, mainName: 'Bakery', closedAt: '2026-11-11T10:00:00.000Z' };

  it('says when it was merged and links to the site', () => {
    render(<ClosedBranch notice={notice} />);
    expect(screen.getByRole('heading', { name: 'The branch “Spring sale” was merged' })).toBeTruthy();
    expect(screen.getByText(/merged into Bakery on 11 November 2026/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Bakery' }).getAttribute('href')).toBe(`/projects/${MAIN}`);
  });

  it('says a discard lost the changes and left the site as it was', () => {
    expect(closedBranchText({ ...notice, status: 'discarded' }).body).toMatch(/discarded on 11 November 2026 and its changes are gone/);
  });
});
