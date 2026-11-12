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
    undoMerge: vi.fn(),
  },
  leave: { savedBeforeLeaving: vi.fn(async () => true), openSite: vi.fn(), openReview: vi.fn(), leaveClosedBranch: vi.fn() },
}));
vi.mock('@/lib/sites/branchClient', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/sites/branchClient')>();
  return { ...actual, branchClient: client };
});

vi.mock('../leave', () => leave);
vi.mock('@/hooks/useStore', () => ({ useStore: () => ({ editorUI: { currentProject: null, currentPage: null } }) }));

import BranchSwitcher from '../BranchSwitcher';
import { BranchBadge, BranchClosedElsewhere, MainChangedNote, ReviewAndMergeButton, SharePreviewButton } from '../BranchBar';
import { discardText } from '../BranchDialogs';
import ClosedBranch, { closedBranchText } from '@/app/projects/ClosedBranch';
import UndoMerge, { undoErrorText } from '../UndoMerge';
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
    undoUntil: null,
    undoneIntoBranchId: null,
    undoneAt: null,
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

  it('opens the review page after saving this tab', async () => {
    renderWith(onBranch());
    fireEvent.click(screen.getByRole('button', { name: /review and merge/i }));
    await waitFor(() => expect(leave.openReview).toHaveBeenCalledWith(BRANCH));
    expect(leave.savedBeforeLeaving).toHaveBeenCalledWith(BRANCH);
  });

  it('does not open the review over what this tab has not saved', async () => {
    leave.savedBeforeLeaving.mockResolvedValue(false);
    renderWith(onBranch());
    fireEvent.click(screen.getByRole('button', { name: /review and merge/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not saved yet/);
    expect(leave.openReview).not.toHaveBeenCalled();
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

  it('takes "ready for review" back from the switcher, and says so where it can be seen', async () => {
    client.change.mockResolvedValue({ branch: summary() });
    renderWith(onBranch({ status: 'ready' }));
    openMenu(/switch branch/i);
    fireEvent.click(await screen.findByRole('menuitem', { name: /not ready for review yet/i }));
    await waitFor(() => expect(client.change).toHaveBeenCalledWith(MAIN, BRANCH, { ready: false }));
    await waitFor(() => expect(screen.getByRole('status', { name: '' }).textContent).toBe('No longer marked ready for review.'));
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
    client.changes.mockResolvedValue(review({ upToDate: false, conflicts: [{ id: 'c1', kind: 'value', unit: { kind: 'page', id: 'home' }, path: ['props'], fingerprint: 'f', options: ['main', 'branch'] }] }));
    renderWith(onBranch({ mainMoved: true }));
    fireEvent.click(screen.getByRole('button', { name: /update/i }));
    expect(await screen.findByText(/1 question needs an answer first, so it was not updated\. The branch is unchanged\./)).toBeTruthy();
    expect(client.update).not.toHaveBeenCalled();
    // The way on: each conflict is answered in the review.
    fireEvent.click(screen.getByRole('button', { name: 'Answer in the review' }));
    await waitFor(() => expect(leave.openReview).toHaveBeenCalledWith(BRANCH));
    expect(leave.savedBeforeLeaving).toHaveBeenCalledWith(BRANCH);
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
  const notice = { branchId: BRANCH, status: 'merged' as const, name: 'Spring sale', mainSiteId: MAIN, mainName: 'Bakery', closedAt: '2026-11-11T10:00:00.000Z', undoUntil: null, undoneInto: null };

  it('says when it was merged and links to the site', () => {
    render(<ClosedBranch notice={notice} />);
    expect(screen.getByRole('heading', { name: 'The branch “Spring sale” was merged' })).toBeTruthy();
    expect(screen.getByText(/merged into Bakery on 11 November 2026/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Bakery' }).getAttribute('href')).toBe(`/projects/${MAIN}`);
  });

  it('offers to undo a merge while it can be undone, says what that does, and opens the new branch', async () => {
    const undo = client.undoMerge.mockReset().mockResolvedValue({ undone: true, branch: { branchId: 'branch-new' }, merged: {}, mainVersion: 9 });
    const opened: string[] = [];
    render(<UndoMerge mainSiteId={MAIN} branchId={BRANCH} branchName="Spring sale" mainName="Bakery" undoUntil="2026-12-11T10:00:00.000Z" open={(id) => opened.push(id)} />);
    expect(screen.getByText(/Until 11 December 2026, and as long as no other branch is merged into Bakery/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo this merge' }));
    expect(await screen.findByText(/Bakery goes back to what it was just before this merge/)).toBeTruthy();
    expect(screen.getByText(/anything changed on the site since, moves to a new branch/)).toBeTruthy();
    expect(undo).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo the merge' }));
    });
    expect(undo).toHaveBeenCalledWith(MAIN, BRANCH);
    expect(opened).toEqual(['branch-new']);
  });

  it('a merge that can no longer be undone loses the offer and keeps the reason on the page', async () => {
    const undo = client.undoMerge.mockReset().mockRejectedValue(new BranchApiError('merge_undo_unavailable', 'This merge can no longer be undone: another branch was merged into the site since, and only the latest merge can be undone.', 409));
    const opened: string[] = [];
    render(<UndoMerge mainSiteId={MAIN} branchId={BRANCH} branchName="Spring sale" mainName="Bakery" undoUntil="2026-12-11T10:00:00.000Z" open={(id) => opened.push(id)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo this merge' }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Undo the merge' }));
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/only the latest merge can be undone/);
    expect(opened).toEqual([]);
    // Nothing left that offers what the server just refused for good.
    expect(screen.queryByRole('button', { name: 'Undo this merge' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo the merge' })).toBeNull();
    expect(screen.queryByText(/this merge can be\s+undone/)).toBeNull();
    expect(undo).toHaveBeenCalledTimes(1);
    undo.mockRestore();
  });

  it('a refusal that may pass keeps the dialog open with what to do, and "Keep the merge" changes nothing', async () => {
    const undo = client.undoMerge.mockReset().mockRejectedValue(new BranchApiError('forbidden', 'forbidden', 403));
    render(<UndoMerge mainSiteId={MAIN} branchId={BRANCH} branchName="Spring sale" mainName="Bakery" undoUntil="2026-12-11T10:00:00.000Z" open={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo this merge' }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Undo the merge' }));
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/cannot undo a merge either/);
    // Trying again is possible: the button is back, not stuck on "Undoing".
    expect(screen.getByRole('button', { name: 'Undo the merge' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Keep the merge' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('button', { name: 'Undo this merge' })).toBeTruthy();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(undoErrorText(new Error('network'))).toMatch(/Nothing was changed; try again/);
    undo.mockRestore();
  });

  it('an undo that had already happened (a second tab) opens the branch the first one made', async () => {
    const undo = client.undoMerge.mockReset().mockResolvedValue({ undone: false, branch: { branchId: 'branch-first' }, merged: {}, mainVersion: 9 });
    const opened: string[] = [];
    render(<UndoMerge mainSiteId={MAIN} branchId={BRANCH} branchName="Spring sale" mainName="Bakery" undoUntil="2026-12-11T10:00:00.000Z" open={(id) => opened.push(id)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo this merge' }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Undo the merge' }));
    });
    expect(opened).toEqual(['branch-first']);
    undo.mockRestore();
  });

  it('shows the undo only for a merge that can still be undone', () => {
    const { unmount } = render(<ClosedBranch notice={notice} />);
    expect(screen.queryByRole('button', { name: 'Undo this merge' })).toBeNull();
    unmount();
    render(<ClosedBranch notice={{ ...notice, undoUntil: '2026-12-11T10:00:00.000Z' }} />);
    expect(screen.getByRole('button', { name: 'Undo this merge' })).toBeTruthy();
  });

  it('says a merge was undone and links to the branch that holds the work while it is open', () => {
    const undone = { ...notice, undoneInto: { branchId: 'branch-new', name: 'Spring sale 2', open: true } };
    const { unmount } = render(<ClosedBranch notice={undone} />);
    expect(screen.getByRole('heading', { name: 'The merge of “Spring sale” was undone' })).toBeTruthy();
    expect(screen.getByText(/The merged changes are on the branch “Spring sale 2” now/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the branch “Spring sale 2”' }).getAttribute('href')).toBe('/projects/branch-new');
    expect(screen.queryByRole('button', { name: 'Undo this merge' })).toBeNull();
    unmount();
    render(<ClosedBranch notice={{ ...undone, undoneInto: { branchId: 'branch-new', name: 'Spring sale 2', open: false } }} />);
    expect(screen.getByText(/which has been merged or discarded since/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Open the branch/ })).toBeNull();
  });

  it('says a discard lost the changes and left the site as it was', () => {
    expect(closedBranchText({ ...notice, status: 'discarded' }).body).toMatch(/discarded on 11 November 2026 and its changes are gone/);
  });
});

describe('a tab open on a branch that someone else closed', () => {
  const closedState = (status: 'merged' | 'discarded'): EditorBranchState => ({ kind: 'branch', siteId: BRANCH, mainSiteId: MAIN, mainName: 'Bakery', branch: summary({ status }) });

  it.each([
    ['merged', /was merged into Bakery/, /is in Bakery now/],
    ['discarded', /was discarded/, /What the branch held is gone/],
  ] as const)('%s: says what happened, that nothing more can be saved, and the way to the site', (status, title, body) => {
    render(
      <SiteBranchProvider initial={closedState(status)}>
        <BranchClosedElsewhere />
        <ReviewAndMergeButton />
        <SharePreviewButton />
        <MainChangedNote />
      </SiteBranchProvider>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(title);
    expect(dialog.textContent).toMatch(body);
    expect(dialog.textContent).toMatch(/nothing more can be saved to it/);
    expect(screen.getByRole('link', { name: 'Open Bakery' }).getAttribute('href')).toBe(`/projects/${MAIN}`);
    // Nothing that needs an open branch is offered beside it.
    expect(screen.queryByRole('button', { name: /Review and merge/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share preview' })).toBeNull();
  });

  it('"Keep looking" closes the dialog, the bar keeps saying it, and "What now?" brings it back', async () => {
    render(
      <SiteBranchProvider initial={closedState('merged')}>
        <BranchClosedElsewhere />
      </SiteBranchProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep looking' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status').textContent).toMatch(/This branch was merged into Bakery/);
    fireEvent.click(screen.getByRole('button', { name: 'What now?' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('shows nothing on an open branch, and reads the record again when the live stream says the branch was closed', async () => {
    client.get.mockReset().mockResolvedValue({ branch: summary({ status: 'discarded' }) });
    render(
      <SiteBranchProvider initial={{ kind: 'branch', siteId: BRANCH, mainSiteId: MAIN, mainName: 'Bakery', branch: summary() }}>
        <BranchClosedElsewhere />
      </SiteBranchProvider>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('lumitra:branch-closed', { detail: { siteId: BRANCH } }));
    });
    expect((await screen.findByRole('dialog')).textContent).toMatch(/was discarded/);
    expect(client.get).toHaveBeenCalledWith(MAIN, BRANCH);
  });
});
