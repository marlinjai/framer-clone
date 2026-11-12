/**
 * @vitest-environment jsdom
 */
// "Share preview", the public preview link of a branch (site branches, slice S8): the four paths of the dialog.
// The address exists only in the answer that makes the link, so every other state must say so.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { client } = vi.hoisted(() => ({
  client: { previewLink: vi.fn(), makePreviewLink: vi.fn(), revokePreviewLink: vi.fn() },
}));

vi.mock('@/lib/sites/branchClient', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/sites/branchClient')>();
  return { ...actual, branchClient: { ...actual.branchClient, ...client } };
});

import SharePreview, { sharePreviewErrorText } from '../SharePreview';
import { BranchApiError } from '@/lib/sites/branchClient';

const MAIN = 'main-1';
const BRANCH = 'branch-1';
const URL_MADE = 'https://preview-abcdefghijklmnopqrstuvwxyz234567.sites.lumitra.co/';
const LINK = { expiresAt: '2026-11-19T10:00:00.000Z', expired: false, createdBy: 'u1', createdAt: '2026-11-12T10:00:00.000Z' };

function mount(props: Partial<React.ComponentProps<typeof SharePreview>> = {}) {
  return render(<SharePreview mainSiteId={MAIN} branchId={BRANCH} branchName="Spring sale" {...props} />);
}

async function open() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Share preview' }));
  });
}

beforeEach(() => {
  client.previewLink.mockReset().mockResolvedValue({ link: null });
  client.makePreviewLink.mockReset().mockResolvedValue({ link: { ...LINK, url: URL_MADE } });
  client.revokePreviewLink.mockReset().mockResolvedValue({ revoked: true });
});

afterEach(cleanup);

describe('SharePreview', () => {
  it('forward: says what a link is, makes one for 7 days by default, shows the address once and copies it', async () => {
    const copied: string[] = [];
    mount({ copy: async (text) => void copied.push(text) });
    await open();
    expect(await screen.findByText(/to anyone who has the address/)).toBeTruthy();
    expect(screen.getByText(/forms and checkout are switched off/)).toBeTruthy();
    expect(client.makePreviewLink).not.toHaveBeenCalled();
    expect((screen.getByLabelText('7 days') as HTMLInputElement).checked).toBe(true);
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Make the link' }));
    });
    expect(client.makePreviewLink).toHaveBeenCalledWith(MAIN, BRANCH, 7);
    expect((screen.getByLabelText('The address') as HTMLInputElement).value).toBe(URL_MADE);
    expect(screen.getByText(/It works until 19 November 2026/)).toBeTruthy();
    expect(screen.getByText(/cannot be shown again/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy the address' }));
    });
    expect(copied).toEqual([URL_MADE]);
    expect(screen.getByRole('status').textContent).toBe('Copied.');
    // No second "make" beside a fresh address; revoking it is possible at once.
    expect(screen.queryByRole('button', { name: /Make/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke the link' })).toBeTruthy();
  });

  it('revise: another duration is sent as chosen, and a refused clipboard selects the address instead', async () => {
    mount({
      copy: async () => {
        throw new Error('denied');
      },
    });
    await open();
    fireEvent.click(await screen.findByLabelText('30 days'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Make the link' }));
    });
    expect(client.makePreviewLink).toHaveBeenCalledWith(MAIN, BRANCH, 30);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy the address' }));
    });
    expect(screen.getByRole('status').textContent).toMatch(/copy it by hand/);
  });

  it('resume: a link from before is shown without an address, and a new one replaces it', async () => {
    client.previewLink.mockResolvedValue({ link: LINK });
    mount();
    await open();
    expect(await screen.findByText(/made on 12 November 2026\. It works until 19 November 2026/)).toBeTruthy();
    expect(screen.getByText(/Its address is not stored, so it cannot be shown again/)).toBeTruthy();
    expect(screen.queryByLabelText('The address')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }));
    });
    expect((screen.getByLabelText('The address') as HTMLInputElement).value).toBe(URL_MADE);
  });

  it('re-entry: closing forgets the address, and the dialog reads the link again when reopened', async () => {
    mount();
    await open();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Make the link' }));
    });
    client.previewLink.mockResolvedValue({ link: LINK });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    });
    await waitFor(() => expect(screen.queryByLabelText('The address')).toBeNull());
    await open();
    expect(await screen.findByText(/Its address is not stored/)).toBeTruthy();
    expect(screen.queryByLabelText('The address')).toBeNull();
    expect(client.previewLink).toHaveBeenCalledTimes(2);
  });

  it('re-entry: revoking leaves no link, and an expired one is said to be expired', async () => {
    client.previewLink.mockResolvedValue({ link: { ...LINK, expired: true } });
    mount();
    await open();
    expect(await screen.findByText(/It expired on 19 November 2026 and shows nothing any more/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove the expired link' }));
    });
    expect(client.revokePreviewLink).toHaveBeenCalledWith(MAIN, BRANCH);
    expect(screen.queryByText(/expired on/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Make the link' })).toBeTruthy();
  });

  it('failures are said and leave a way on: reading, making and revoking', async () => {
    client.previewLink.mockRejectedValueOnce(new BranchApiError('network', 'The server could not be reached. Check the connection and try again.', 0));
    mount();
    await open();
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be reached/);
    client.previewLink.mockResolvedValue({ link: LINK });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    client.makePreviewLink.mockRejectedValueOnce(new BranchApiError('forbidden', 'forbidden', 403));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Make a new link' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/cannot share or revoke its preview/);
    // Not stuck: the buttons work again.
    expect((screen.getByRole('button', { name: 'Make a new link' }) as HTMLButtonElement).disabled).toBe(false);
    client.revokePreviewLink.mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Revoke the link' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/Nothing was changed; try again/);
    expect(sharePreviewErrorText(new BranchApiError('branch_closed', 'closed', 410))).toMatch(/no preview any more/);
    expect(sharePreviewErrorText(new BranchApiError('preview_link_unavailable', 'Public preview links are not available here.', 409))).toMatch(/not available here/);
  });

  it('stays off, with the reason, for someone who may not edit the site', () => {
    mount({ disabledReason: 'Only someone who may edit this site can share a preview.' });
    const button = screen.getByRole('button', { name: 'Share preview' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/may edit this site/);
  });
});
