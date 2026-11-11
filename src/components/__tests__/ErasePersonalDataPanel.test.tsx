// Erase personal data, inside the Published versions dialog: search, look at the
// matches, tick the ones to erase (none is ticked before the owner does), confirm,
// see the proof; a stale preview asks for a new search; every failure is shown;
// nothing is erased before the confirmation, and nothing that was not ticked.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PublishedVersionsButton from '../PublishedVersionsButton';
import { ErasePersonalDataPanel } from '../ErasePersonalDataPanel';

let currentStore: { editorUI: { currentProject: unknown; isUnsavedDemo?: boolean } };
vi.mock('@/hooks/useStore', () => ({ useStore: () => currentStore }));

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const M1 = 'a'.repeat(32);
const M2 = 'b'.repeat(32);
const M3 = 'c'.repeat(32);
const FOUND = {
  token: 'f'.repeat(32),
  total: 3,
  erasable: 2,
  blocked: 1,
  truncated: false,
  locations: [
    { location: { kind: 'working' }, createdAt: null, kind: null, live: false, matches: 1, erasable: 1 },
    { location: { kind: 'revision', number: 4 }, createdAt: '2026-11-01T10:00:00.000Z', kind: 'publish', live: true, matches: 2, erasable: 1 },
  ],
  matches: [
    { id: M1, location: { kind: 'working' }, area: 'settings', pageId: null, pageSlug: null, path: '/siteSettings/business/managingDirectors/0', excerpt: 'Max Mustermann', blocked: null },
    { id: M2, location: { kind: 'revision', number: 4 }, area: 'text', pageId: 'home', pageSlug: '', path: '/pages/0/snapshot/appComponentTree/props/children', excerpt: 'Run by Max Mustermann', blocked: null },
    { id: M3, location: { kind: 'revision', number: 4 }, area: 'address', pageId: 'team', pageSlug: 'max-mustermann', path: '/pages/1/slug', excerpt: 'max-mustermann', blocked: 'address' },
  ],
};

function bodyOf(call: number): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[call][1]?.body)) as Record<string, unknown>;
}

async function searchFor(value: string) {
  fireEvent.change(screen.getByLabelText('Value to find'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: /Search/ }));
  await screen.findByText(/3 matches: 2 can be erased, 1 cannot be erased here/);
}

beforeEach(() => {
  currentStore = { editorUI: { currentProject: { id: 'site 1' }, isUnsavedDemo: false } };
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ErasePersonalDataPanel', () => {
  it('searches by POST, lists every match with its place, and blocks what cannot be erased', async () => {
    fetchMock.mockResolvedValueOnce(json(FOUND));
    render(<ErasePersonalDataPanel projectId="site 1" />);
    await searchFor('Max Mustermann');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/site%201/erasures/search');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(bodyOf(0)).toEqual({ value: 'Max Mustermann', caseSensitive: false, insideWords: false });
    // The value travels in the body, never in the address.
    expect(fetchMock.mock.calls[0][0]).not.toContain('Mustermann');

    const list = screen.getByRole('list', { name: 'Matches' });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(2);
    // Nothing is ticked until the owner ticks it, and the matching rules are stated.
    expect(within(list).getAllByRole('checkbox').every((box) => !(box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('button', { name: 'Erase 0 ticked matches...' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Finds whole words unless asked otherwise/)).toBeTruthy();
    expect(within(list).getByText(/Cannot be erased here: a page address/)).toBeTruthy();
    expect(screen.getByText(/Version 4 \(live\): 2/)).toBeTruthy();
    expect(within(list).getByText(/Editor \(working copy\) · site settings/)).toBeTruthy();
  });

  it('erases nothing before the confirmation, then sends the token, the replacement and only the ticked matches', async () => {
    fetchMock.mockResolvedValueOnce(json(FOUND));
    render(<ErasePersonalDataPanel projectId="site 1" />);
    await searchFor('Max Mustermann');

    fireEvent.click(screen.getByRole('checkbox', { name: /Erase this match in Version 4/ }));
    fireEvent.change(screen.getByLabelText('Replace with (optional)'), { target: { value: '[entfernt]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Erase 1 ticked match...' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const confirm = screen.getByRole('group', { name: 'Confirm the erase' });
    expect(within(confirm).getByText(/Erase 1 ticked match in 1 published version\? This cannot be undone/)).toBeTruthy();
    expect(within(confirm).getByText(/Changes not saved in this tab are lost/)).toBeTruthy();
    fetchMock.mockResolvedValueOnce(json({ erasureId: 'er_1', erased: 1, places: [], remaining: 2, erasableRemaining: 1 }));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Erase' }));

    await screen.findByText('Erased 1 match.');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/projects/site%201/erasures');
    expect(bodyOf(1)).toEqual({
      value: 'Max Mustermann',
      caseSensitive: false,
      insideWords: false,
      replacement: '[entfernt]',
      token: FOUND.token,
      chosen: [M2],
    });
    expect(screen.getByText(/still finds 2 matches, 1 of them erasable/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload the editor' })).toBeTruthy();
    expect(screen.getByText(/every other open tab of this project needs a reload too/)).toBeTruthy();
  });

  it('names each site branch place with its state, two branches of one name kept apart, and says branches in the confirmation', async () => {
    const open = { kind: 'branch', branchId: 'br_open', name: 'Sale', branchStatus: 'open' };
    const closed = { kind: 'branch', branchId: 'br_old', name: 'Sale', branchStatus: 'discarded' };
    const base = { kind: 'branch-base', branchId: 'br_open', name: 'Sale', branchStatus: 'open' };
    const undo = { kind: 'merge-undo', branchId: 'br_done', name: 'Spring', branchStatus: 'merged' };
    const M4 = 'd'.repeat(32);
    fetchMock.mockResolvedValueOnce(
      json({
        token: 'f'.repeat(32), total: 4, erasable: 4, blocked: 0, truncated: false,
        locations: [open, closed, base, undo].map((location) => ({ location, createdAt: null, kind: null, live: false, matches: 1, erasable: 1 })),
        matches: [
          { id: M1, location: open, area: 'text', pageId: 'home', pageSlug: '', path: '/pages/0/snapshot', excerpt: 'Max', blocked: null },
          { id: M2, location: closed, area: 'branch', pageId: null, pageSlug: null, path: '/reviewNote', excerpt: 'Max', blocked: null },
          { id: M3, location: base, area: 'text', pageId: 'home', pageSlug: '', path: '/pages/0/snapshot', excerpt: 'Max', blocked: null },
          { id: M4, location: undo, area: 'text', pageId: 'home', pageSlug: '', path: '/pages/0/snapshot', excerpt: 'Max', blocked: null },
        ],
      }),
    );
    render(<ErasePersonalDataPanel projectId="site 1" />);
    fireEvent.change(screen.getByLabelText('Value to find'), { target: { value: 'Max' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await screen.findByText(/4 matches: 4 can be erased/);

    // One line per place, even where two branches share a name.
    expect(screen.getByText('Branch "Sale": 1')).toBeTruthy();
    expect(screen.getByText('Branch "Sale" (record only, discarded): 1')).toBeTruthy();
    expect(screen.getByText(/Branch "Sale" \(where it started from main\): 1/)).toBeTruthy();
    expect(screen.getByText(/Site before merging "Spring" \(kept to undo the merge\): 1/)).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Matches' });
    expect(within(list).getByText(/record only, discarded\) · branch name or review note/)).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Erase this match in Branch "Sale"' }));
    fireEvent.click(screen.getByRole('button', { name: 'Erase 1 ticked match...' }));
    const confirm = screen.getByRole('group', { name: 'Confirm the erase' });
    expect(within(confirm).getByText(/in its branches\?/)).toBeTruthy();
  });

  it('says no match for this exact text remains, and when the proof could not run', async () => {
    fetchMock.mockResolvedValueOnce(json(FOUND)).mockResolvedValueOnce(json({ erased: 2, remaining: 0, erasableRemaining: 0 }));
    render(<ErasePersonalDataPanel projectId="site 1" />);
    await searchFor('Max Mustermann');
    fireEvent.click(screen.getByRole('button', { name: 'Tick all shown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Erase 2 ticked matches...' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm the erase' })).getByRole('button', { name: 'Erase' }));
    await screen.findByText('No match for this exact text remains in the versions and the editor.');

    cleanup();
    fetchMock.mockResolvedValueOnce(json(FOUND)).mockResolvedValueOnce(json({ erased: 2, remaining: null, erasableRemaining: null }));
    render(<ErasePersonalDataPanel projectId="site 1" />);
    await searchFor('Max Mustermann');
    fireEvent.click(screen.getByRole('button', { name: 'Tick all shown' }));
    fireEvent.click(screen.getByRole('button', { name: 'Erase 2 ticked matches...' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm the erase' })).getByRole('button', { name: 'Erase' }));
    await screen.findByText(/The check afterwards could not run/);
  });

  it('a stale preview offers a new search, which clears the choices', async () => {
    fetchMock
      .mockResolvedValueOnce(json(FOUND))
      .mockResolvedValueOnce(json({ error: { code: 'erase_preview_stale', message: 'The project changed since the search. Search again, then erase.' } }, 409))
      .mockResolvedValueOnce(json(FOUND));
    render(<ErasePersonalDataPanel projectId="site 1" />);
    await searchFor('Max Mustermann');
    fireEvent.click(screen.getByRole('checkbox', { name: /Erase this match in Editor/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Erase 1 ticked match...' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm the erase' })).getByRole('button', { name: 'Erase' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/changed since the search/);
    fireEvent.click(screen.getByRole('button', { name: 'Search again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(bodyOf(2)).toEqual({ value: 'Max Mustermann', caseSensitive: false, insideWords: false });
    // The new search starts with nothing ticked.
    await screen.findByRole('button', { name: 'Erase 0 ticked matches...' });
  });

  it('shows the server refusal for someone who is not the owner, and a network failure', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'owner_required', message: "Only the company's owner can do this." } }, 403));
    render(<ErasePersonalDataPanel projectId="site 1" />);
    fireEvent.change(screen.getByLabelText('Value to find'), { target: { value: 'Max Mustermann' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    expect((await screen.findByRole('alert')).textContent).toBe("Only the company's owner can do this.");

    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/network error/));
  });

  it('says so when nothing is found, and offers no erase', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...FOUND, total: 0, erasable: 0, blocked: 0, matches: [], locations: [] }));
    render(<ErasePersonalDataPanel projectId="site 1" />);
    fireEvent.change(screen.getByLabelText('Value to find'), { target: { value: 'Nobody' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await screen.findByText('Nothing found in any kept version or in the editor.');
    expect(screen.queryByRole('button', { name: /^Erase/ })).toBeNull();
  });

  it('asks for whole words unless told otherwise, and says only shown matches can be erased', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...FOUND, total: 700, truncated: true }));
    render(<ErasePersonalDataPanel projectId="site 1" />);
    fireEvent.click(screen.getByLabelText('Also find it inside longer words'));
    fireEvent.change(screen.getByLabelText('Value to find'), { target: { value: 'Lena' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    await screen.findByText(/Only matches shown here can be erased: narrow the search/);
    expect(bodyOf(0)).toEqual({ value: 'Lena', caseSensitive: false, insideWords: true });
  });
});

describe('the Published versions dialog', () => {
  it('opens Erase personal data and goes back to the list', async () => {
    fetchMock.mockImplementation(async () => json({ status: 'published', live: 1, revisions: [{ number: 1, kind: 'publish', createdAt: '2026-11-01T10:00:00.000Z', rewrittenAt: '2026-11-02T09:00:00.000Z' }] }));
    render(<PublishedVersionsButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Published versions' }));
    expect(await screen.findByText(/personal data erased/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Erase personal data...' }));
    expect(screen.getByLabelText('Value to find')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the versions' }));
    expect(await screen.findByText(/personal data erased/)).toBeTruthy();
    expect(screen.queryByLabelText('Value to find')).toBeNull();
  });
});
