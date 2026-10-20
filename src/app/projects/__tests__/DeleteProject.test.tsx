// Deleting a project from the dashboard card: "More actions" -> "Delete
// project" opens a confirmation that names the project and what happens;
// a published project needs its name typed, an unpublished one is a plain
// confirm; cancel deletes nothing; a failure keeps the dialog open with the
// reason; success removes the card, refreshes the list and moves focus.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor, within, act } from '@testing-library/react';

const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn() }),
}));
vi.mock('next/link', async () => {
  const R = await import('react');
  const Link = R.forwardRef<HTMLAnchorElement, { href: string; children: React.ReactNode }>(
    ({ href, children, ...rest }, ref) => <a ref={ref} href={href} {...rest}>{children}</a>,
  );
  return { __esModule: true, default: Link };
});

import ProjectCard from '../ProjectCard';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  refreshMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCard(props: Partial<React.ComponentProps<typeof ProjectCard>> = {}) {
  return render(
    <>
      <h1 id="projects-heading" tabIndex={-1}>Projects</h1>
      <ProjectCard
        siteId="site_1"
        name="Bakery"
        status="published"
        updatedLabel="2026-10-20"
        liveHost="k3j9x0abcd12.sites.lumitra.co"
        customDomains={['www.bakery.de']}
        {...props}
      />
    </>,
  );
}

async function openDelete(name = 'Bakery') {
  fireEvent.keyDown(screen.getByRole('button', { name: `More actions for ${name}` }), { key: 'Enter' });
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete project' }));
  return screen.findByRole('alertdialog');
}

const okResponse = () => new Response(JSON.stringify({ siteId: 'site_1', deleted: true }), { status: 200 });

describe('Delete project dialog', () => {
  it('names the project and says what happens to the site, the domains and company data', async () => {
    renderCard();
    const dialog = await openDelete();
    expect(within(dialog).getByRole('heading').textContent).toBe('Delete “Bakery”?');
    const text = dialog.textContent ?? '';
    expect(text).toContain('cannot be undone');
    expect(text).toContain('k3j9x0abcd12.sites.lumitra.co');
    expect(text).toContain('goes offline right away');
    expect(text).toContain('www.bakery.de');
    expect(text).toContain('Books');
  });

  it('cancel deletes nothing and returns focus to the card menu', async () => {
    renderCard();
    const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More actions for Bakery' })),
    );
  });

  it('a published project: Delete stays disabled until the exact name is typed', async () => {
    renderCard();
    const dialog = await openDelete();
    const del = within(dialog).getByRole('button', { name: 'Delete project' }) as HTMLButtonElement;
    const input = within(dialog).getByLabelText(/to confirm/);
    expect(del.disabled).toBe(true);
    for (const wrong of ['bakery', 'Bakery ', 'Bak']) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(del.disabled).toBe(true);
    }
    fireEvent.submit(del.closest('form')!);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('success: sends the typed name, removes the card, refreshes and focuses the heading', async () => {
    fetchMock.mockResolvedValue(okResponse());
    renderCard();
    const dialog = await openDelete();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'Bakery' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects/site_1');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ confirmName: 'Bakery' });
    expect(screen.queryByRole('link', { name: 'Bakery' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Deleted the project Bakery.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Projects' })));
  });

  it('an unpublished project is a plain confirm (no typed name)', async () => {
    fetchMock.mockResolvedValue(okResponse());
    renderCard({ status: 'draft', liveHost: null, customDomains: [] });
    const dialog = await openDelete();
    expect(within(dialog).queryByLabelText(/to confirm/)).toBeNull();
    expect(dialog.textContent).not.toContain('goes offline');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
  });

  it('a failure keeps the dialog open with the reason, and the card stays', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Forbidden' } }), { status: 403 }),
    );
    renderCard({ status: 'draft' });
    const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'You do not have permission to delete this project.',
    );
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    // The card is still there (hidden from the accessibility tree only while
    // the modal dialog is open).
    expect(screen.getByRole('link', { name: 'Bakery', hidden: true })).toBeTruthy();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('while deleting, both buttons are disabled and Escape does not close', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { resolve = r; }));
    renderCard({ status: 'draft' });
    const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    const busy = await within(dialog).findByRole('button', { name: 'Deleting…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await act(async () => resolve(okResponse()));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renamed in the meantime: asks for the current name instead of deleting', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 'confirmation_mismatch', message: 'x', currentName: 'Bakery Berlin' } }),
        { status: 409 },
      ),
    );
    renderCard();
    const dialog = await openDelete();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'Bakery' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Bakery Berlin');
    expect(within(dialog).getByLabelText(/Bakery Berlin/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Delete project' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('link', { name: 'Bakery', hidden: true })).toBeTruthy();
  });

  it('already deleted elsewhere: says so, and closing removes the card', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'site_not_found', message: 'x' } }), { status: 404 }),
    );
    renderCard({ status: 'draft' });
    const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('no longer exists');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'Bakery' })).toBeNull();
  });
});
