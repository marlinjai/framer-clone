import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import ContentManagerPanel from '../ContentManagerPanel';
import { CmsClientError, type CmsClient } from '../cmsClient';

// Mock the grid overlay: it would otherwise pull in the server-actions adapter
// (server-only + Prisma). The stub renders the collection name and a close
// button, which is all the panel-level open/close assertions need.
vi.mock('../grid/CmsGridOverlay', () => ({
  default: ({ collectionName, onClose }: { collectionName: string; onClose: () => void }) => (
    <div data-testid="cms-grid-overlay">
      <span data-testid="overlay-collection">{collectionName}</span>
      <button onClick={onClose}>Close overlay</button>
    </div>
  ),
}));

function makeClient(overrides: Partial<CmsClient> = {}): CmsClient {
  return {
    listCollections: vi.fn().mockResolvedValue([]),
    createCollection: vi.fn(),
    renameCollection: vi.fn().mockResolvedValue(undefined),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const EVENTS = {
  id: 'col_events',
  slug: 'events',
  name: 'Events',
  columns: [
    { id: 'title', name: 'title', type: 'text' as const },
    { id: 'date', name: 'date', type: 'date' as const },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('ContentManagerPanel', () => {
  it('shows the empty-state "No collections yet" affordance when there are no collections', async () => {
    render(<ContentManagerPanel client={makeClient()} />);
    const empty = await screen.findByTestId('cms-empty-state');
    expect(empty.textContent).toContain('No collections yet');
  });

  it('creates a collection from the inline input and opens its grid', async () => {
    const listCollections = vi
      .fn()
      .mockResolvedValueOnce([]) // initial: empty
      .mockResolvedValue([EVENTS]); // after create
    const client = makeClient({
      listCollections,
      createCollection: vi.fn().mockResolvedValue(EVENTS),
    });

    render(<ContentManagerPanel client={client} />);
    fireEvent.click(await screen.findByText('Create collection'));

    const input = await screen.findByLabelText('New collection name');
    fireEvent.change(input, { target: { value: 'Events' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(client.createCollection).toHaveBeenCalledWith('Events'));
    expect((await screen.findByTestId('overlay-collection')).textContent).toBe('Events');
  });

  it('opens the editing grid overlay for a collection, then closes it', async () => {
    const client = makeClient({ listCollections: vi.fn().mockResolvedValue([EVENTS]) });
    render(<ContentManagerPanel client={client} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Events' }));
    expect((await screen.findByTestId('overlay-collection')).textContent).toBe('Events');

    fireEvent.click(screen.getByText('Close overlay'));
    await waitFor(() => expect(screen.queryByTestId('cms-grid-overlay')).toBeNull());
  });

  it('deletes a collection through the overflow menu and confirmation dialog', async () => {
    const client = makeClient({
      listCollections: vi.fn().mockResolvedValue([EVENTS]),
      deleteCollection: vi.fn().mockResolvedValue(undefined),
    });
    render(<ContentManagerPanel client={client} />);

    // Open the row's overflow menu (Radix opens on pointerdown).
    const trigger = await screen.findByRole('button', { name: 'Options for Events' });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);

    // Choose Delete -> confirmation dialog -> confirm.
    fireEvent.click(await screen.findByText('Delete'));
    fireEvent.click(await screen.findByText('Delete collection'));

    await waitFor(() => expect(client.deleteCollection).toHaveBeenCalledWith('col_events'));
  });

  it('surfaces a TYPED collision error inline (collection_exists), not a generic message', async () => {
    const client = makeClient({
      createCollection: vi
        .fn()
        .mockRejectedValue(
          new CmsClientError('collection_exists', 'a collection named "Events" already exists', 409),
        ),
    });

    render(<ContentManagerPanel client={client} />);
    fireEvent.click(await screen.findByText('Create collection'));

    const input = await screen.findByLabelText('New collection name');
    fireEvent.change(input, { target: { value: 'Events' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const banner = await screen.findByTestId('cms-error');
    expect(banner.getAttribute('data-error-code')).toBe('collection_exists');
    expect(banner.textContent).toContain('already exists');
  });

  it('renders a read-load failure inline instead of silently showing an empty panel', async () => {
    const client = makeClient({
      listCollections: vi.fn().mockRejectedValue(new CmsClientError('cms_read_failed', 'db down', 500)),
    });
    render(<ContentManagerPanel client={client} />);
    const banner = await screen.findByTestId('cms-error');
    expect(banner.getAttribute('data-error-code')).toBe('cms_read_failed');
  });
});
