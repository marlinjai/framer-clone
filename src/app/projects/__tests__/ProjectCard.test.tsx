// The dashboard's project card rename: the card menu's "Rename" opens an inline
// field; Enter / blur save, Escape cancels, empty is refused with a message,
// a failed save rolls back with the reason, success refreshes the list.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

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

function renderCard(name = 'Framer Clone Demo') {
  return render(<ProjectCard siteId="site_1" name={name} status="published" updatedLabel="2026-10-20" />);
}

// Radix opens its menu on pointerdown (jsdom has no pointer layout); the
// keyboard path (Enter on the trigger) is the accessible one and works here.
async function openRename(cardName = 'Framer Clone Demo') {
  const trigger = screen.getByRole('button', { name: `More actions for ${cardName}` });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
  // Radix hands focus back after the menu closed, in a timeout: wait for it.
  const input = (await screen.findByRole('textbox', { name: 'Project name' })) as HTMLInputElement;
  // The field owns focus once the menu is gone (no focus trap pulling it back).
  await waitFor(() => expect(document.activeElement).toBe(input));
  return input;
}

describe('ProjectCard', () => {
  it('links the name into the editor and offers Rename in the card menu', async () => {
    renderCard();
    expect(screen.getByRole('link', { name: 'Framer Clone Demo' }).getAttribute('href')).toBe('/projects/site_1');
    const input = await openRename();
    expect(input.value).toBe('Framer Clone Demo');
  });

  it('Enter saves optimistically and refreshes the list', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ name: 'Bakery' }), { status: 200 }));
    renderCard();
    const input = await openRename();
    fireEvent.change(input, { target: { value: 'Bakery' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const link = screen.getByRole('link', { name: 'Bakery' });
    // Focus returns to the card's name, not to <body>.
    expect(document.activeElement).toBe(link);
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: 'Bakery',
      expectedName: 'Framer Clone Demo',
    });
  });

  it('blur saves', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ name: 'On blur' }), { status: 200 }));
    renderCard();
    const input = await openRename();
    fireEvent.change(input, { target: { value: 'On blur' } });
    fireEvent.blur(input);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('Escape cancels without a request', async () => {
    renderCard();
    const input = await openRename();
    fireEvent.change(input, { target: { value: 'Discard me' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Framer Clone Demo' }));
  });

  it('an empty name is refused with a message', async () => {
    renderCard();
    const input = await openRename();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('A project needs a name.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed save rolls back and says why', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'rename_failed', message: 'database down' } }), { status: 500 }),
    );
    renderCard();
    const input = await openRename();
    fireEvent.change(input, { target: { value: 'Will fail' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((await screen.findByRole('alert')).textContent).toBe('Could not rename the project: database down');
    expect(screen.getByRole('link', { name: 'Framer Clone Demo' })).toBeTruthy();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("a lost race shows the other person's name and says so", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'name_conflict', message: 'x', currentName: 'Their name' } }),
        { status: 409 },
      ),
    );
    renderCard();
    const input = await openRename();
    fireEvent.change(input, { target: { value: 'Mine' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((await screen.findByRole('alert')).textContent).toContain('Their name');
    expect(screen.getByRole('link', { name: 'Their name' })).toBeTruthy();
  });

  it('Rename is unavailable while a save is in flight', async () => {
    let resolveFirst!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolveFirst = r; }));
    renderCard();
    const input = await openRename();
    fireEvent.change(input, { target: { value: 'Slow' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions for Slow' }), { key: 'Enter' });
    const item = screen.getByRole('menuitem', { name: 'Rename' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    resolveFirst(new Response(JSON.stringify({ name: 'Slow' }), { status: 200 }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it('follows a refreshed name from the server', () => {
    const { rerender } = renderCard();
    rerender(<ProjectCard siteId="site_1" name="Renamed elsewhere" status="published" updatedLabel="2026-10-20" />);
    expect(screen.getByRole('link', { name: 'Renamed elsewhere' })).toBeTruthy();
  });
});
