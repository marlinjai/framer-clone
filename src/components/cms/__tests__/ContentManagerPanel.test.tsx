import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import ContentManagerPanel from '../ContentManagerPanel';
import { CmsClientError, type CmsClient } from '../cmsClient';

// Build a CmsClient whose methods are vi.fn()s, defaulting to benign resolves so
// each test overrides only what it asserts on. Injecting this avoids mocking
// global fetch and keeps the panel's state machine under test.
function makeClient(overrides: Partial<CmsClient> = {}): CmsClient {
  return {
    listCollections: vi.fn().mockResolvedValue([]),
    listRows: vi.fn().mockResolvedValue({ rows: [] }),
    createCollection: vi.fn(),
    renameCollection: vi.fn().mockResolvedValue(undefined),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    addColumn: vi.fn(),
    renameColumn: vi.fn().mockResolvedValue(undefined),
    retypeColumn: vi.fn().mockResolvedValue(undefined),
    deleteColumn: vi.fn().mockResolvedValue(undefined),
    createRow: vi.fn(),
    updateRow: vi.fn(),
    deleteRow: vi.fn().mockResolvedValue(undefined),
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
    { id: 'cover', name: 'cover', type: 'file' as const },
    { id: 'tags', name: 'tags', type: 'multi-select' as const },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// globals:false means testing-library's auto-cleanup is not registered; do it
// manually so each test renders into a fresh document.
afterEach(() => {
  cleanup();
});

describe('ContentManagerPanel', () => {
  it('shows the empty-state "Create your first collection" affordance when there are no collections', async () => {
    render(<ContentManagerPanel client={makeClient()} />);
    const empty = await screen.findByTestId('cms-empty-state');
    expect(empty.textContent).toContain('Create your first collection');
  });

  it('creates a collection and it then appears in the list (the same listCollections store the binding picker reads)', async () => {
    const listCollections = vi
      .fn()
      .mockResolvedValueOnce([]) // initial load: empty
      .mockResolvedValue([EVENTS]); // after create: Events present
    const client = makeClient({
      listCollections,
      createCollection: vi.fn().mockResolvedValue(EVENTS),
    });

    render(<ContentManagerPanel client={client} />);
    await screen.findByTestId('cms-empty-state');

    fireEvent.change(screen.getByLabelText('New collection name'), {
      target: { value: 'Events' },
    });
    fireEvent.click(screen.getByText('Create collection'));

    await waitFor(() =>
      expect(client.createCollection).toHaveBeenCalledWith('Events'),
    );
    // Events surfaces in the collection list that the binding picker also reads.
    const item = await screen.findByTestId('cms-collection-col_events');
    expect(item.textContent).toContain('Events');
  });

  it('surfaces a TYPED collision error inline (collection_exists), not a generic message', async () => {
    const client = makeClient({
      createCollection: vi
        .fn()
        .mockRejectedValue(new CmsClientError('collection_exists', 'a collection named "Events" already exists', 409)),
    });

    render(<ContentManagerPanel client={client} />);
    await screen.findByTestId('cms-empty-state');

    fireEvent.change(screen.getByLabelText('New collection name'), {
      target: { value: 'Events' },
    });
    fireEvent.click(screen.getByText('Create collection'));

    const banner = await screen.findByTestId('cms-error');
    // The SPECIFIC code is surfaced (typed path), not a swallowed success or a
    // generic "request failed".
    expect(banner.getAttribute('data-error-code')).toBe('collection_exists');
    expect(banner.textContent).toContain('already exists');
  });

  it('adds a field to the selected collection through the binding ColumnType union', async () => {
    const client = makeClient({
      listCollections: vi.fn().mockResolvedValue([EVENTS]),
      addColumn: vi.fn().mockResolvedValue({ id: 'new', name: 'price', type: 'number' }),
    });

    render(<ContentManagerPanel client={client} />);
    // Select the Events collection to reveal the field editor.
    fireEvent.click(await screen.findByText('Events'));
    await screen.findByTestId('cms-field-editor');

    fireEvent.change(screen.getByLabelText('New field name'), {
      target: { value: 'price' },
    });
    fireEvent.change(screen.getByLabelText('New field type'), {
      target: { value: 'number' },
    });
    fireEvent.click(screen.getByText('Add field'));

    await waitFor(() =>
      expect(client.addColumn).toHaveBeenCalledWith('col_events', {
        name: 'price',
        type: 'number',
      }),
    );
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
