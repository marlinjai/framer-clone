// Erase personal data, inside the Published versions dialog: search, look at the
// matches, leave some out, confirm, see the proof; a stale preview asks for a new
// search; every failure is shown; nothing is erased before the confirmation.

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
    expect(bodyOf(0)).toEqual({ value: 'Max Mustermann', caseSensitive: false });
    // The value travels in the body, never in the address.
    expect(fetchMock.mock.calls[0][0]).not.toContain('Mustermann');

    const list = screen.getByRole('list', { name: 'Matches' });
    expect(within(list).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(list).getByText(/Cannot be erased here: a page address/)).toBeTruthy();
    expect(screen.getByText(/Version 4 \(live\): 2/)).toBeTruthy();
    expect(within(list).getByText(/Editor \(working copy\) · site settings/)).toBeTruthy();
  });

  it('erases nothing before the confirmation, then sends the token, the replacement and the matches left out', async () => {
    fetchMock.mockResolvedValueOnce(json(FOUND));
    render(<ErasePersonalDataPanel projectId="site 1" />);
    await searchFor('Max Mustermann');

    fireEvent.click(screen.getByRole('checkbox', { name: /Erase this match in Editor/ }));
    fireEvent.change(screen.getByLabelText('Replace with (optional)'), { target: { value: '[entfernt]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Erase 1 match...' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const confirm = screen.getByRole('group', { name: 'Confirm the erase' });
    expect(within(confirm).getByText(/Erase 1 match from 1 published version and the editor\? This\s+cannot be undone/)).toBeTruthy();
    fetchMock.mockResolvedValueOnce(json({ erasureId: 'er_1', erased: 1, places: [], remaining: 2, erasableRemaining: 1 }));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Erase' }));

    await screen.findByText('Erased 1 match.');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/projects/site%201/erasures');
    expect(bodyOf(1)).toEqual({
      value: 'Max Mustermann',
      caseSensitive: false,
      replacement: '[entfernt]',
      token: FOUND.token,
      leaveOut: [M1],
    });
    expect(screen.getByText(/still finds 2 matches, 1 of them erasable/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload the editor' })).toBeTruthy();
    expect(screen.getByText(/every other open tab of this project needs a reload too/)).toBeTruthy();
  });

  it('says the value is gone when the proof finds nothing, and when the proof could not run', async () => {
    fetchMock.mockResolvedValueOnce(json(FOUND)).mockResolvedValueOnce(json({ erased: 2, remaining: 0, erasableRemaining: 0 }));
    render(<ErasePersonalDataPanel projectId="site 1" />);
    await searchFor('Max Mustermann');
    fireEvent.click(screen.getByRole('button', { name: 'Erase 2 matches...' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm the erase' })).getByRole('button', { name: 'Erase' }));
    await screen.findByText(/A new search finds nothing/);

    cleanup();
    fetchMock.mockResolvedValueOnce(json(FOUND)).mockResolvedValueOnce(json({ erased: 2, remaining: null, erasableRemaining: null }));
    render(<ErasePersonalDataPanel projectId="site 1" />);
    await searchFor('Max Mustermann');
    fireEvent.click(screen.getByRole('button', { name: 'Erase 2 matches...' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Erase 1 match...' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm the erase' })).getByRole('button', { name: 'Erase' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/changed since the search/);
    fireEvent.click(screen.getByRole('button', { name: 'Search again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(bodyOf(2)).toEqual({ value: 'Max Mustermann', caseSensitive: false });
    await screen.findByRole('button', { name: 'Erase 2 matches...' });
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
