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

import BranchSwitcher, { recentlyMerged } from '../BranchSwitcher';
import { BarMessage, BranchBadge, BranchClosedElsewhere, MainChangedNote, ReviewAndMergeButton, SharePreviewButton } from '../BranchBar';
import { branchLimitText, discardText } from '../BranchDialogs';
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



describe('recently merged, in the switcher', () => {
  const mergedBranch = (over: Partial<BranchSummaryJson> = {}) =>
    summary({ branchId: 'site-merged', name: 'Winter menu', status: 'merged', version: null, baseVersion: null, mergedAt: '2026-11-11T10:00:00.000Z', ...over });
  const listWith = (closed: BranchSummaryJson[], open: BranchSummaryJson[] = [summary()]) => client.list.mockResolvedValue({ mainSiteId: MAIN, mainVersion: 7, open, closed });

  it('shows no such group when nothing was merged, discarded branches included', async () => {
    listWith([summary({ branchId: 'site-gone', name: 'Old idea', status: 'discarded', discardedAt: '2026-11-11T10:00:00.000Z' })]);
    renderWith(onMain);
    openMenu(/switch branch/i);
    await screen.findByRole('menuitem', { name: /spring sale/i });
    expect(screen.queryByText('Recently merged')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /old idea/i })).toBeNull();
  });

  it('lists the latest three merges, newest first, and leaves the discarded ones out', () => {
    const rows = recentlyMerged(
      [],
      [
        mergedBranch({ branchId: 'm1', name: 'One', mergedAt: '2026-11-01T10:00:00.000Z' }),
        summary({ branchId: 'd1', name: 'Dropped', status: 'discarded' }),
        mergedBranch({ branchId: 'm4', name: 'Four', mergedAt: '2026-11-04T10:00:00.000Z', undoUntil: '2026-12-04T10:00:00.000Z' }),
        mergedBranch({ branchId: 'm2', name: 'Two', mergedAt: '2026-11-02T10:00:00.000Z' }),
        mergedBranch({ branchId: 'm3', name: 'Three', mergedAt: '2026-11-03T10:00:00.000Z' }),
      ],
    );
    expect(rows.map((r) => r.branch.name)).toEqual(['Four', 'Three', 'Two']);
    expect(rows.map((r) => r.canUndo)).toEqual([true, false, false]);
    expect(rows[1].detail).toBe('Merged on 3 November 2026');
    expect(rows[1].opens).toBe('m3');
  });

  it('a merged branch opens its old address, after saving this tab, and offers no undo once that is over', async () => {
    listWith([mergedBranch()]);
    renderWith(onMain);
    openMenu(/switch branch/i);
    expect(await screen.findByText('Recently merged')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /undo the merge/i })).toBeNull();
    const row = screen.getByRole('menuitem', { name: /winter menu/i });
    expect(row.textContent).toMatch(/Merged on 11 November 2026/);
    fireEvent.click(row);
    await waitFor(() => expect(leave.openSite).toHaveBeenCalledWith('site-merged'));
    expect(leave.savedBeforeLeaving).toHaveBeenCalledWith(MAIN);
  });

  it('undoes the latest merge from the menu: the same dialog, this tab saved first, then the new branch', async () => {
    listWith([mergedBranch({ undoUntil: '2026-12-11T10:00:00.000Z' })]);
    client.undoMerge.mockResolvedValue({ undone: true, branch: { branchId: 'branch-new' }, merged: {}, mainVersion: 9 });
    renderWith(onMain);
    openMenu(/switch branch/i);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Undo the merge of “Winter menu”…' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Undo the merge of “Winter menu”\?/);
    expect(dialog.textContent).toMatch(/Bakery goes back to what it was just before this merge/);
    expect(client.undoMerge).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo the merge' }));
    });
    expect(leave.savedBeforeLeaving).toHaveBeenCalledWith(MAIN);
    expect(client.undoMerge).toHaveBeenCalledWith(MAIN, 'site-merged');
    expect(leave.openSite).toHaveBeenCalledWith('branch-new');
  });

  it('does not undo over what this tab has not saved, and says so in the dialog', async () => {
    listWith([mergedBranch({ undoUntil: '2026-12-11T10:00:00.000Z' })]);
    leave.savedBeforeLeaving.mockResolvedValue(false);
    renderWith(onMain);
    openMenu(/switch branch/i);
    fireEvent.click(await screen.findByRole('menuitem', { name: /undo the merge/i }));
    // The dialog opens once the menu has closed.
    const confirm = await screen.findByRole('button', { name: 'Undo the merge' });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/not saved yet/);
    expect(client.undoMerge).not.toHaveBeenCalled();
    // Trying again is possible, and "Keep the merge" closes the dialog with nothing changed.
    expect(screen.getByRole('button', { name: 'Undo the merge' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Keep the merge' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a merge the server no longer undoes closes the dialog and keeps the reason in the bar', async () => {
    listWith([mergedBranch({ undoUntil: '2026-12-11T10:00:00.000Z' })]);
    client.undoMerge.mockRejectedValue(new BranchApiError('merge_undo_unavailable', 'This merge can no longer be undone: only the latest merge can be undone.', 409));
    renderWith(onMain);
    openMenu(/switch branch/i);
    fireEvent.click(await screen.findByRole('menuitem', { name: /undo the merge/i }));
    // The dialog opens once the menu has closed.
    const confirm = await screen.findByRole('button', { name: 'Undo the merge' });
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('status').textContent).toMatch(/only the latest merge can be undone/);
    expect(leave.openSite).not.toHaveBeenCalled();
  });

  it('an undone merge says where the work went and goes there, with no undo offered', async () => {
    listWith([mergedBranch({ undoneIntoBranchId: 'site-back', undoneAt: '2026-11-12T08:00:00.000Z' })], [summary({ branchId: 'site-back', name: 'Winter menu 2' })]);
    renderWith(onMain);
    openMenu(/switch branch/i);
    const row = await screen.findByRole('menuitem', { name: /Merge undone/ });
    expect(row.textContent).toMatch(/Its changes are on the branch “Winter menu 2” now\./);
    expect(screen.queryByRole('menuitem', { name: /undo the merge/i })).toBeNull();
    fireEvent.click(row);
    await waitFor(() => expect(leave.openSite).toHaveBeenCalledWith('site-back'));
  });

  it('an undone merge whose new branch is closed too names it and goes to the old address', () => {
    const undone = mergedBranch({ undoneIntoBranchId: 'site-back', undoneAt: '2026-11-12T08:00:00.000Z' });
    const [named] = recentlyMerged([], [undone, summary({ branchId: 'site-back', name: 'Winter menu 2', status: 'discarded' })]);
    expect(named.detail).toBe('Merge undone. Its changes went to the branch “Winter menu 2”, which has been merged or discarded since.');
    expect(named.opens).toBe('site-merged');
    expect(named.canUndo).toBe(false);
    // The branch that took the work is no longer among the listed ones: still said, without a name.
    const [unnamed] = recentlyMerged([], [undone]);
    expect(unnamed.detail).toBe('Merge undone. Its changes went to another branch, which has been merged or discarded since.');
  });
});

describe('the new branch dialog', () => {
  const tenOpen = Array.from({ length: 10 }, (_, i) => summary({ branchId: `site-b${i}`, name: `Branch number ${i}` }));

  async function openDialog(state: EditorBranchState = onMain) {
    renderWith(state);
    openMenu(/switch branch/i);
    // The item is chosen once the list has answered, as a person does.
    await screen.findAllByRole('menuitem', { name: /spring sale|branch number 0/i });
    fireEvent.click(screen.getByRole('menuitem', { name: /new branch/i }));
    return screen.findByRole('dialog');
  }

  it('says the limit and where the site stands in each state of the count', () => {
    expect(branchLimitText('Bakery', undefined)).toEqual({ text: 'A site can have up to 10 open branches at a time.', reached: false });
    expect(branchLimitText('Bakery', 0)).toEqual({ text: 'Bakery has no open branch yet. A site can have up to 10 at a time.', reached: false });
    expect(branchLimitText('Bakery', 3).text).toBe('3 of 10 branches are open on Bakery.');
    expect(branchLimitText('Bakery', 10).reached).toBe(true);
    expect(branchLimitText('Bakery', 10).text).toMatch(/already has 10 open branches, the most a site can have\. Merge or discard one of them/);
  });

  it('names the site it copies and how many branches are open, tied to the name field', async () => {
    const dialog = await openDialog();
    expect(dialog.textContent).toMatch(/A copy of Bakery as it is saved now/);
    const limit = screen.getByText('1 of 10 branches are open on Bakery.');
    expect(screen.getByLabelText('Branch name').getAttribute('aria-describedby')).toContain(limit.id);
    const create = screen.getByRole('button', { name: 'Create branch' });
    expect(create.getAttribute('aria-disabled')).toBeNull();
  });

  it('opened on a branch, names the site and not the branch as what is copied', async () => {
    const dialog = await openDialog(onBranch());
    expect(dialog.textContent).toMatch(/A copy of Bakery as it is saved now/);
  });

  it('at the limit says why as text, keeps the button reachable and makes no request, by click or by Enter', async () => {
    client.list.mockResolvedValue({ mainSiteId: MAIN, mainVersion: 7, open: tenOpen, closed: [] });
    await openDialog();
    const reason = screen.getByText(/Bakery already has 10 open branches/);
    const create = screen.getByRole('button', { name: 'Create branch' }) as HTMLButtonElement;
    expect(create.getAttribute('aria-disabled')).toBe('true');
    expect(create.disabled).toBe(false);
    expect(create.getAttribute('aria-describedby')).toBe(reason.id);
    const field = screen.getByLabelText('Branch name');
    fireEvent.change(field, { target: { value: 'One more' } });
    fireEvent.click(create);
    fireEvent.submit(field.closest('form')!);
    await act(async () => {});
    expect(client.create).not.toHaveBeenCalled();
    expect(leave.savedBeforeLeaving).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a count from when the editor was opened is shown but does not turn the button off', async () => {
    // The list cannot be read: all the dialog has is the number the editor was opened with.
    client.list.mockRejectedValue(new BranchApiError('branches_failed', 'listing the branches failed, try again', 500));
    client.create.mockRejectedValue(new BranchApiError('branch_limit', 'This site already has 10 open branches.', 409));
    renderWith({ ...onMain, openBranches: 10 } as EditorBranchState);
    openMenu(/switch branch/i);
    await screen.findByText('listing the branches failed, try again');
    fireEvent.click(screen.getByRole('menuitem', { name: /new branch/i }));
    expect(await screen.findByText(/Bakery had 10 open branches when this page was opened/)).toBeTruthy();
    const create = screen.getByRole('button', { name: 'Create branch' });
    expect(create.getAttribute('aria-disabled')).toBeNull();
    fireEvent.change(screen.getByLabelText('Branch name'), { target: { value: 'One more' } });
    fireEvent.click(create);
    // The server decides, and its refusal is said.
    expect((await screen.findByRole('alert')).textContent).toBe('This site already has 10 open branches.');
  });
});

describe('explanations a keyboard and a touch screen reach', () => {
  const describedText = (el: HTMLElement) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? null;

  it('the badge carries its explanation as text, and the switcher\'s menu shows it on a branch only', async () => {
    renderWith(onBranch());
    const words = 'A branch of Bakery. It is never published; merge it into Bakery to publish its changes.';
    expect(screen.getByText('Branch').textContent).toBe(`Branch. ${words}`);
    openMenu(/switch branch/i);
    const menu = await screen.findByRole('menu');
    expect(describedText(menu)).toBe(words);
    cleanup();
    renderWith(onMain);
    openMenu(/switch branch/i);
    expect((await screen.findByRole('menu')).getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText(words)).toBeNull();
  });

  it('"Update" and "Review and merge" point at text that is on the page', () => {
    renderWith(onBranch({ mainMoved: true }));
    expect(describedText(screen.getByRole('button', { name: 'Update' }))).toBe('Bring the changes made to Bakery into this branch');
    expect(describedText(screen.getByRole('button', { name: 'Review and merge' }))).toBe('Branches are never published. Merge into Bakery, then publish from there.');
  });
});

describe('a sentence cut short in the top bar', () => {
  it('opens in full under the bar on a press, by pointer or keyboard, and closes on a second press, Escape or leaving', () => {
    const text = 'Bakery changed in a way this branch cannot take in by itself: three questions need an answer on the review page first.';
    render(<BarMessage text={text} />);
    const cut = screen.getByRole('button', { name: text });
    expect(cut.className).toMatch(/line-clamp-3/);
    expect(cut.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-bar-message-full]')).toBeNull();
    fireEvent.click(cut);
    expect(cut.getAttribute('aria-expanded')).toBe('true');
    const full = document.querySelector('[data-bar-message-full]')!;
    expect(full.textContent).toBe(text);
    expect(full.className).not.toMatch(/line-clamp/);
    // The words are in the button already: the panel is not read a second time.
    expect(full.getAttribute('aria-hidden')).toBe('true');
    fireEvent.keyDown(cut, { key: 'Escape' });
    expect(document.querySelector('[data-bar-message-full]')).toBeNull();
    fireEvent.click(cut);
    fireEvent.click(cut);
    expect(document.querySelector('[data-bar-message-full]')).toBeNull();
    fireEvent.click(cut);
    fireEvent.blur(cut);
    expect(document.querySelector('[data-bar-message-full]')).toBeNull();
  });

  it('a count of open branches from when the page was opened is said as that, never as how it is now', () => {
    expect(branchLimitText('Bakery', 10, false).text).toBe(
      'Bakery had 10 open branches when this page was opened, the most a site can have. If one was merged or discarded since, a new one can be made.',
    );
    expect(branchLimitText('Bakery', 10, true).text).toMatch(/already has 10 open branches/);
    expect(branchLimitText('Bakery', 3, false).text).toBe('3 of 10 branches are open on Bakery.');
  });
});

describe('a narrow window', () => {
  it('folds the labels into their icons with the names kept, shortens the sentences, and never shrinks a button', () => {
    render(
      <SiteBranchProvider initial={onBranch({ mainMoved: true })}>
        <Bar />
        <SharePreviewButton />
      </SiteBranchProvider>,
    );
    for (const name of ['Update', 'Review and merge', 'Share preview']) {
      const control = screen.getByRole('button', { name });
      expect(control.className).toMatch(/\bshrink-0\b/);
      // In the compact bar the words fold into the icon; on the wide bar the bar's own fold decides
      // (docs/plans/2026-11-12-top-bar-fold.md, proven in real browsers in test/behaviour/branches.spec.ts).
      expect(control.querySelector('[data-fold-label]')?.className).toMatch(/max-lg:sr-only/);
    }
    // The switcher's name gives way first; the full name is in its accessible name and in the menu.
    const trigger = screen.getByRole('button', { name: 'Branch Spring sale. Switch branch' });
    expect(trigger.className).toMatch(/\bshrink\b/);
    expect(trigger.className).not.toMatch(/shrink-0/);
    expect(screen.getByText('Bakery has changed').className).toMatch(/min-w-0/);
  });

  it('folds the words of Update, Share preview and Review and merge when the wide bar asks, keeping each name and the filled button', () => {
    render(
      <SiteBranchProvider initial={onBranch({ mainMoved: true })}>
        <MainChangedNote iconOnly />
        <SharePreviewButton iconOnly />
        <ReviewAndMergeButton iconOnly />
      </SiteBranchProvider>,
    );
    for (const name of ['Update', 'Review and merge', 'Share preview']) {
      const control = screen.getByRole('button', { name });
      expect(control.querySelector('[data-fold-label]')?.className).toMatch(/\bsr-only\b/);
      expect(control.className).toMatch(/\bw-8\b/);
    }
    // Review and merge stays the bar's filled (brand) button when it folds.
    expect(screen.getByRole('button', { name: 'Review and merge' }).className).toMatch(/bg-brand/);
    // The idle sentence goes with the words; the button says what it does in its description.
    expect(screen.getByText('Bakery has changed').className).toMatch(/\bhidden\b/);
  });

  it('a branch closed elsewhere keeps "What now?" whole while its sentence shortens', async () => {
    render(
      <SiteBranchProvider initial={onBranch({ status: 'merged' })}>
        <BranchClosedElsewhere />
      </SiteBranchProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep looking' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('This branch was merged into Bakery.').className).toMatch(/truncate/);
    expect(screen.getByRole('button', { name: 'What now?' }).className).toMatch(/shrink-0/);
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
