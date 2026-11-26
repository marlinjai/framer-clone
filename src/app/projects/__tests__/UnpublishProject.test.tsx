// Unpublish from a dashboard card: offered only for a published site, asks
// first, announces success and keeps a failure on screen with a retry.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProjectCard from '../ProjectCard';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function card(status: string) {
  render(
    <>
      <div id="projects-status" />
      <ProjectCard
        siteId="site-1"
        name="Bakery"
        status={status}
        updatedLabel="today"
        liveHost="abc.sites.lumitra.co"
        customDomains={['bakery.example']}
      />
    </>,
  );
}

function openMenu() {
  const trigger = screen.getByRole('button', { name: 'More actions for Bakery' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
}

async function openDialog() {
  card('published');
  openMenu();
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpublish' }));
  return screen.findByRole('alertdialog');
}

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProjectCard: Unpublish', () => {
  it('is not offered for a draft', async () => {
    card('draft');
    openMenu();
    await screen.findByRole('menuitem', { name: 'Rename' });
    expect(screen.queryByRole('menuitem', { name: 'Unpublish' })).toBeNull();
  });

  it('names the addresses, starts on Cancel and sends nothing when cancelled', async () => {
    const dialog = await openDialog();
    expect(dialog.textContent).toContain('abc.sites.lumitra.co');
    expect(dialog.textContent).toContain('bakery.example');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unpublishes, announces it, refreshes the list and closes', async () => {
    fetchMock.mockResolvedValue(json({ siteId: 'site-1', status: 'draft' }));
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish site' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/unpublish');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ siteId: 'site-1' });
    expect(document.getElementById('projects-status')?.textContent).toBe('The site Bakery is offline.');
    expect(refresh).toHaveBeenCalled();
  });

  it.each([
    ['a refusal', () => Promise.resolve(json({ error: { code: 'forbidden', message: 'no' } }, 403)), 'do not have permission'],
    ['an unfinished unpublish', () => Promise.resolve(json({ error: { code: 'unpublish_failed', message: 'cache' } }, 500)), 'may still see the site'],
    ['a lost answer', () => Promise.reject(new Error('offline')), 'not known whether the site went offline'],
  ])('stays open on %s, with the reason and a retry', async (_name, answer, reason) => {
    fetchMock.mockImplementation(answer);
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish site' }));

    expect((await screen.findByRole('alert')).textContent).toContain(reason);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(document.getElementById('projects-status')?.textContent).toBe('');
    expect(refresh).toHaveBeenCalled();
  });
});
