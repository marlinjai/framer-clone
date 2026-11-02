// The Published versions dialog: lists what the server holds, marks what is live,
// makes an older version live, and shows every failure.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PublishedVersionsButton from '../PublishedVersionsButton';

let currentStore: { editorUI: { currentProject: unknown; isUnsavedDemo?: boolean } };
vi.mock('@/hooks/useStore', () => ({ useStore: () => currentStore }));

const AT = '2026-11-01T10:00:00.000Z';
const LIST = {
  status: 'published',
  live: 2,
  revisions: [
    { number: 2, kind: 'publish', createdAt: AT },
    { number: 1, kind: 'baseline', createdAt: AT },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const CLEAN = { missingImpressum: false, placeholders: [] };

/** Press Make live on the only row offering it and wait for the question. */
async function askForVersion(name: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name: 'Make live' }));
  return screen.findByRole('group', { name });
}

function openDialog() {
  render(<PublishedVersionsButton />);
  fireEvent.click(screen.getByRole('button', { name: 'Published versions' }));
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

describe('PublishedVersionsButton', () => {
  it('shows nothing without a project, or for the browser-only demo', () => {
    currentStore = { editorUI: { currentProject: null } };
    const { rerender } = render(<PublishedVersionsButton />);
    expect(screen.queryByRole('button')).toBeNull();
    currentStore = { editorUI: { currentProject: { id: 'demo' }, isUnsavedDemo: true } };
    rerender(<PublishedVersionsButton />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('marks the live version and offers Make live on the others', async () => {
    fetchMock.mockResolvedValue(json(LIST));
    openDialog();

    await screen.findByText(/Version 1/);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/site%201/revisions');
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Make live' })).toHaveLength(1);
    expect(screen.getByText(/before versions were kept/)).toBeTruthy();
  });

  it('makes a version live, then shows the server state', async () => {
    fetchMock.mockResolvedValueOnce(json(LIST));
    fetchMock.mockResolvedValueOnce(json({ number: 1, check: CLEAN }));
    fetchMock.mockResolvedValueOnce(json({ siteId: 'site 1', status: 'published', live: 1 }));
    fetchMock.mockResolvedValueOnce(json({ ...LIST, live: 1 }));
    openDialog();

    const question = await askForVersion(/Confirm version 1/);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/projects/site%201/revisions/1');
    const confirm = await waitFor(() => {
      const button = within(question).getByRole('button', { name: 'Make live' }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      return button;
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const [, init] = fetchMock.mock.calls[2];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ number: 1 });
    await waitFor(() => {
      const row = screen.getByText('Live').closest('li');
      expect(row?.textContent).toContain('Version 1');
    });
  });

  it('shows a refused rollback and keeps the list', async () => {
    fetchMock.mockResolvedValueOnce(json(LIST));
    fetchMock.mockResolvedValueOnce(json({ number: 1, check: CLEAN }));
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'revision_not_found', message: 'gone' } }, 404));
    openDialog();

    const question = await askForVersion(/Confirm version 1/);
    fireEvent.click(await within(question).findByRole('button', { name: 'Make live' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Could not make version 1 live: gone');
    expect(screen.getByText(/Version 2/)).toBeTruthy();
  });

  it('Cancel goes back without changing anything', async () => {
    fetchMock.mockResolvedValueOnce(json(LIST));
    fetchMock.mockResolvedValueOnce(json({ number: 1, check: CLEAN }));
    openDialog();

    const question = await askForVersion(/Confirm version 1/);
    fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('group')).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('shows the warnings of the version being made live, and can go ahead anyway', async () => {
    fetchMock.mockResolvedValueOnce(json(LIST));
    fetchMock.mockResolvedValueOnce(json({
      number: 1,
      check: { missingImpressum: true, placeholders: [{ kind: 'privacy', pageId: 'p', title: 'Privacy', count: 2 }] },
    }));
    openDialog();

    const question = await askForVersion(/Confirm version 1/);

    await within(question).findByText(/no Impressum page/);
    expect(within(question).getByText('Privacy still has 2 placeholders.')).toBeTruthy();
    expect((within(question).getByRole('button', { name: 'Make live' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a check that fails says so and does not block the way back', async () => {
    fetchMock.mockResolvedValueOnce(json(LIST));
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'nope' } }, 500));
    openDialog();

    const question = await askForVersion(/Confirm version 1/);

    await within(question).findByText(/could not be checked/);
    expect((within(question).getByRole('button', { name: 'Make live' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('on an offline site, says the site goes back online and asks for that', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...LIST, status: 'draft', revisions: [LIST.revisions[1]] }));
    fetchMock.mockResolvedValueOnce(json({ number: 1, check: CLEAN }));
    openDialog();

    const question = await askForVersion(/Confirm version 1/);

    expect(question.textContent).toContain('Put this site back online with version 1?');
    await within(question).findByRole('button', { name: 'Put back online' });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('shows a failed load with a retry', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'nope' } }, 500));
    fetchMock.mockResolvedValueOnce(json(LIST));
    openDialog();

    expect((await screen.findByRole('alert')).textContent).toContain('nope');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await screen.findByText(/Version 2/);
  });

  it('shows a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    openDialog();
    expect((await screen.findByRole('alert')).textContent).toContain('network error');
  });

  it('explains an empty list, for a site that went live earlier and for one never published', async () => {
    fetchMock.mockResolvedValueOnce(json({ status: 'published', live: null, revisions: [] }));
    openDialog();
    await screen.findByText(/went live before versions were kept/);
    cleanup();

    fetchMock.mockResolvedValueOnce(json({ status: 'draft', live: null, revisions: [] }));
    openDialog();
    await screen.findByText(/Nothing published yet/);
  });

  it('marks nothing live on an unpublished site, and says what Make live does', async () => {
    fetchMock.mockResolvedValue(json({ ...LIST, status: 'draft' }));
    openDialog();

    await screen.findByText(/This site is offline/);
    expect(screen.queryByText('Live')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Make live' })).toHaveLength(2);
  });
});
