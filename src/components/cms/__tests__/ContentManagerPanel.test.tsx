import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import ContentManagerPanel from '../ContentManagerPanel';
import { CmsClientError, type CmsClient } from '../cmsClient';

// Mock the workspace overlay: it would otherwise pull in the server-actions
// adapter (server-only + Prisma). The stub renders enough DOM for panel-level
// assertions: the active collection name, a way to switch collections, and a
// close button. It also renders a data-testid for the grid keyed by tableId so
// we can assert the grid swaps when the active collection changes.
vi.mock('../grid/CmsWorkspaceOverlay', () => ({
  default: ({
    collections,
    activeId,
    onSetActive,
    onClose,
  }: {
    collections: Array<{ id: string; name: string }>;
    activeId: string;
    onSetActive: (id: string) => void;
    onClose: () => void;
  }) => {
    const active = collections.find((c) => c.id === activeId);
    return (
      <div data-testid="cms-workspace-overlay">
        <span data-testid="workspace-active-collection">{active?.name ?? ''}</span>
        {/* Grid stub: key shows which tableId is currently active */}
        <div data-testid={`cms-grid-${activeId}`} />
        {/* Allow tests to switch the active collection */}
        {collections.map((c) => (
          <button key={c.id} data-testid={`set-active-${c.id}`} onClick={() => onSetActive(c.id)}>
            Switch to {c.name}
          </button>
        ))}
        <button onClick={onClose}>Close workspace</button>
      </div>
    );
  },
}));

function makeClient(overrides: Partial<CmsClient> = {}): CmsClient {
  return {
    listCollections: vi.fn().mockResolvedValue([]),
    createCollection: vi.fn(),
    renameCollection: vi.fn().mockResolvedValue(undefined),
    updateCollection: vi.fn().mockResolvedValue(undefined),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const EVENTS: { id: string; slug: string; name: string; columns: []; itemCount: number } = {
  id: 'col_events',
  slug: 'events',
  name: 'Events',
  columns: [],
  itemCount: 12,
};

const TEAM: { id: string; slug: string; name: string; columns: []; itemCount: number } = {
  id: 'col_team',
  slug: 'team',
  name: 'Team',
  columns: [],
  itemCount: 4,
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

  it('creates a collection and opens the workspace with it active', async () => {
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
    // Workspace overlay should now be visible with Events active.
    expect((await screen.findByTestId('workspace-active-collection')).textContent).toBe('Events');
  });

  it('opens the workspace overlay when clicking Open on a collection row', async () => {
    const client = makeClient({ listCollections: vi.fn().mockResolvedValue([EVENTS]) });
    render(<ContentManagerPanel client={client} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Events' }));
    expect((await screen.findByTestId('workspace-active-collection')).textContent).toBe('Events');
  });

  it('switching the active collection in the rail re-keys the grid to the new tableId without closing', async () => {
    const client = makeClient({
      listCollections: vi.fn().mockResolvedValue([EVENTS, TEAM]),
    });
    render(<ContentManagerPanel client={client} />);

    // Open workspace with Events.
    fireEvent.click(await screen.findByRole('button', { name: 'Open Events' }));
    await screen.findByTestId('cms-workspace-overlay');

    // Check Events grid is mounted.
    expect(screen.getByTestId('cms-grid-col_events')).toBeTruthy();

    // Switch to Team via the rail control exposed by the stub.
    fireEvent.click(screen.getByTestId('set-active-col_team'));

    // Workspace stays open, grid now keys to Team.
    await waitFor(() => expect(screen.queryByTestId('cms-workspace-overlay')).toBeTruthy());
    expect(screen.getByTestId('cms-grid-col_team')).toBeTruthy();
  });

  it('Close unmounts the workspace overlay', async () => {
    const client = makeClient({ listCollections: vi.fn().mockResolvedValue([EVENTS]) });
    render(<ContentManagerPanel client={client} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Events' }));
    await screen.findByTestId('cms-workspace-overlay');

    fireEvent.click(screen.getByText('Close workspace'));
    await waitFor(() => expect(screen.queryByTestId('cms-workspace-overlay')).toBeNull());
  });

  it('deletes a collection through the overflow menu and confirmation dialog', async () => {
    const client = makeClient({
      listCollections: vi.fn().mockResolvedValue([EVENTS]),
      deleteCollection: vi.fn().mockResolvedValue(undefined),
    });
    render(<ContentManagerPanel client={client} />);

    const trigger = await screen.findByRole('button', { name: 'Options for Events' });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);

    fireEvent.click(await screen.findByText('Delete'));
    fireEvent.click(await screen.findByText('Delete collection'));

    await waitFor(() => expect(client.deleteCollection).toHaveBeenCalledWith('col_events'));
  });

  it('updates a collection icon through the settings dialog', async () => {
    const client = makeClient({
      listCollections: vi.fn().mockResolvedValue([EVENTS]),
      updateCollection: vi.fn().mockResolvedValue(undefined),
    });
    render(<ContentManagerPanel client={client} />);

    const trigger = await screen.findByRole('button', { name: 'Options for Events' });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText('Settings'));

    await screen.findByTestId('cms-settings-dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Icon calendar' }));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(client.updateCollection).toHaveBeenCalledWith('col_events', {
        name: 'Events',
        icon: 'calendar',
      }),
    );
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
