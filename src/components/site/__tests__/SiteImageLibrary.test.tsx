// "Uploaded images" (SiteImageLibrary): lists the site's uploads with the
// totals, offers a delete only for an image nothing names (the server's answer
// and what this editor holds unsaved), asks before deleting, reloads after,
// and says what to do when the delete or the list fails.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { SiteImageLibrary } from '../SiteImageLibrary';

const fetchMock = vi.fn();
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function item(sha256: string, inUse: boolean) {
  return { sha256, path: `/site-images/${sha256}.png`, contentType: 'image/png', byteSize: 2048, width: 512, height: 512, inUse };
}

function answer(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const listing = (items: ReturnType<typeof item>[]) =>
  answer(200, { items, totalBytes: items.length * 2048, maxImages: 100, maxBytes: 50 * 1024 * 1024 });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SiteImageLibrary', () => {
  it('shows the totals and offers a delete only for an image nothing names', async () => {
    fetchMock.mockResolvedValueOnce(listing([item(A, true), item(B, false), item(C, false)]));
    render(<SiteImageLibrary projectId="site_1" namedHere={new Set([C])} version={0} />);
    expect(await screen.findByText(/3 of 100 images, 6 KB of 50.0 MB/)).toBeTruthy();
    const deletes = screen.getAllByRole('button', { name: /Delete the unused image/ });
    expect(deletes).toHaveLength(1);
    // A: in use on the server; C: chosen in this editor, not saved yet.
    expect(screen.getAllByText('In use')).toHaveLength(2);
  });

  it('asks first, deletes, and reloads the list', async () => {
    fetchMock
      .mockResolvedValueOnce(listing([item(B, false)]))
      .mockResolvedValueOnce(answer(204, null))
      .mockResolvedValueOnce(listing([]));
    render(<SiteImageLibrary projectId="site_1" namedHere={new Set()} version={0} />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete the unused image/ }));
    expect(screen.getByText('Delete for good?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByText('No images uploaded yet.')).toBeTruthy());
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/projects/site_1/images/${B}`);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
  });

  it("keeps the image and shows the server's reason when it is still in use", async () => {
    fetchMock
      .mockResolvedValueOnce(listing([item(B, false)]))
      .mockResolvedValueOnce(answer(409, { error: { code: 'image_in_use', message: 'This image is still in use: remove it there first.' } }))
      .mockResolvedValueOnce(listing([item(B, true)]));
    render(<SiteImageLibrary projectId="site_1" namedHere={new Set()} version={0} />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete the unused image/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/still in use/);
    await waitFor(() => expect(screen.getByText('In use')).toBeTruthy());
  });

  it('says what to do when the list cannot be loaded', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<SiteImageLibrary projectId="site_1" namedHere={new Set()} version={0} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Check your connection, then open Site settings again/);
  });
});
