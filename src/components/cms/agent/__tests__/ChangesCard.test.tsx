import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import ChangesCard from '../ChangesCard';
import type { AgentChangeSummary } from '@/lib/ai/cmsAgentProtocol';

const changes: AgentChangeSummary[] = [
  { tool: 'bulk_create_rows', entityType: 'Events', icon: 'plus', count: 3, label: '+3 items' },
  { tool: 'update_row', entityType: 'Events', icon: 'pencil', count: 1, label: '1 updated' },
];

afterEach(() => cleanup());
beforeEach(() => vi.restoreAllMocks());

describe('ChangesCard', () => {
  it('renders one row per change with its entity and label', () => {
    render(<ChangesCard runId="run1" changes={changes} />);
    expect(screen.getAllByTestId('agent-change-row')).toHaveLength(2);
    expect(screen.getByText('+3 items')).toBeTruthy();
    expect(screen.getByText('1 updated')).toBeTruthy();
  });

  it('calls the undo endpoint when "Undo all" is clicked', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ undone: 4, skipped: 0, warnings: [] }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const onUndone = vi.fn();
    render(<ChangesCard runId="run1" changes={changes} onUndone={onUndone} />);
    fireEvent.click(screen.getByTestId('agent-undo-all'));

    await waitFor(() => expect(onUndone).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/cms-agent/undo',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows a spinner while the undo is in flight', async () => {
    let resolve!: (v: { json: () => Promise<unknown> }) => void;
    const fetchMock = vi.fn(() => new Promise((r) => (resolve = r))) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    render(<ChangesCard runId="run1" changes={changes} />);
    fireEvent.click(screen.getByTestId('agent-undo-all'));

    await waitFor(() => expect(screen.getByTestId('agent-undo-spinner')).toBeTruthy());
    resolve({ json: async () => ({ undone: 4, skipped: 0, warnings: [] }) });
  });

  it('renders a warning row on a partial undo', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ undone: 1, skipped: 1, warnings: ['Could not reverse update_row'] }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    render(<ChangesCard runId="run1" changes={changes} />);
    fireEvent.click(screen.getByTestId('agent-undo-all'));

    await waitFor(() => expect(screen.getByTestId('agent-undo-warning')).toBeTruthy());
    expect(screen.getByText(/Could not reverse update_row/)).toBeTruthy();
  });
});
