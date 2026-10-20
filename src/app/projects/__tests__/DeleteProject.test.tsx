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
import { expectViewportFitPanel } from '@/components/ui/__tests__/viewportFit';

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
      <p id="projects-status" role="status" aria-live="polite" />
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
    expect(text).toContain('goes offline');
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
    expect((await within(dialog).findByRole('alert')).textContent).toContain('not in the selected company any more');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'Bakery' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('The project Bakery is no longer in this company.');
  });

  it('focus starts inside the dialog: on the name field when typing is needed', async () => {
    renderCard();
    const dialog = await openDelete();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText(/to confirm/)));
  });

  it('focus starts inside the dialog: on Cancel for a plain confirm', async () => {
    renderCard({ status: 'draft', liveHost: null, customDomains: [] });
    const dialog = await openDelete();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })));
  });

  it('published since the page loaded: switches to asking for the name, then deletes', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 'confirmation_mismatch', message: 'x', currentName: 'Bakery' } }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(okResponse());
    renderCard({ status: 'draft', liveHost: null, customDomains: [] });
    const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This project was published in the meantime, so it now needs its name typed to confirm.',
    );
    const input = within(dialog).getByLabelText(/to confirm/);
    const del = within(dialog).getByRole('button', { name: 'Delete project' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'Bakery' } });
    fireEvent.click(del);
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ confirmName: 'Bakery' });
  });

  it('deleted but the cache could not be cleared: says so, and the card goes', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'delete_cache_failed', message: 'The project was deleted, but its published pages may still be served from cache until the next deploy.' } }),
        { status: 500 },
      ),
    );
    renderCard();
    const dialog = await openDelete();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'Bakery' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('was deleted, but');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(screen.getByRole('status').textContent).toBe('Deleted the project Bakery.');
  });

  it('a published project with an empty stored name: type the shown fallback, the real name is sent', async () => {
    fetchMock.mockResolvedValue(okResponse());
    renderCard({ name: '' });
    const dialog = await openDelete('Untitled Project');
    expect(within(dialog).getByText('Untitled Project', { selector: 'span' })).toBeTruthy();
    const del = within(dialog).getByRole('button', { name: 'Delete project' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true); // an empty field never confirms
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'Untitled Project' } });
    fireEvent.click(del);
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ confirmName: '' });
  });
});

describe('Delete project dialog in a small window', () => {
  it('scrolls the explanation (a long domain list) while the confirmation and buttons stay on screen', async () => {
    const domains = Array.from({ length: 30 }, (_, i) => `shop-${i}.bakery.de`);
    renderCard({ customDomains: domains });
    const dialog = await openDelete();
    const classes = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);

    expectViewportFitPanel(dialog);
    const header = dialog.querySelector('[data-slot="alert-dialog-header"]');
    // The title stays; the explanation with the domain list is what scrolls.
    const message = dialog.querySelector('[data-slot="alert-dialog-description"]');
    expect(classes(message)).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto']));
    expect(message!.textContent).toContain('shop-29.bakery.de');
    expect(message!.contains(within(dialog).getByRole('heading'))).toBe(false);

    const actions = within(dialog).getByTestId('delete-project-actions');
    expect(classes(actions)).toContain('shrink-0');
    expect(header!.contains(actions)).toBe(false);
    expect(within(actions).getByRole('button', { name: 'Delete project' })).toBeTruthy();
    expect(within(actions).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(within(actions).getByLabelText(/to confirm/)).toBeTruthy();
  });
});

