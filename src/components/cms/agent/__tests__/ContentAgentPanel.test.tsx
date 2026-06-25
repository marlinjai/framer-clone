import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import ContentAgentPanel from '../ContentAgentPanel';
import type { AgentTransport } from '@/lib/ai/cmsAgentClient';

afterEach(() => cleanup());

function renderPanel(transport: AgentTransport, onRunComplete = vi.fn()) {
  return render(
    <ContentAgentPanel
      collectionId="t1"
      workspaceId="ws1"
      collectionName="Events"
      transport={transport}
      onRunComplete={onRunComplete}
    />,
  );
}

const noopTransport: AgentTransport = async () => {};

describe('ContentAgentPanel', () => {
  it('renders the header, suggestion chips, and input bar', () => {
    renderPanel(noopTransport);
    expect(screen.getByText('Content agent')).toBeTruthy();
    expect(screen.getByText('Generate 5 blog posts')).toBeTruthy();
    expect(screen.getByTestId('agent-textarea')).toBeTruthy();
  });

  it('populates the input when a suggestion chip is clicked', () => {
    renderPanel(noopTransport);
    fireEvent.click(screen.getByText('Translate to German'));
    const textarea = screen.getByTestId('agent-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Translate to German');
  });

  it('disables the send button while a run is in flight', async () => {
    // A transport that never resolves keeps the panel in the running state.
    const pending: AgentTransport = () => new Promise<void>(() => {});
    renderPanel(pending);
    const textarea = screen.getByTestId('agent-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Generate 3 posts' } });
    fireEvent.click(screen.getByTestId('agent-send'));
    await waitFor(() => {
      expect((screen.getByTestId('agent-send') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('shows the ChangesCard on agent:done with the streamed summaries', async () => {
    const transport: AgentTransport = async (_req, handlers) => {
      handlers.onToolResult?.({ tool: 'bulk_create_rows', success: true, summary: 'Created 3 items' });
      handlers.onDone?.({
        runId: 'run1',
        changes: [{ tool: 'bulk_create_rows', entityType: 'Events', icon: 'plus', count: 3, label: '+3 items' }],
      });
    };
    const onRunComplete = vi.fn();
    renderPanel(transport, onRunComplete);
    fireEvent.change(screen.getByTestId('agent-textarea'), { target: { value: 'Generate 3' } });
    fireEvent.click(screen.getByTestId('agent-send'));
    await waitFor(() => {
      expect(screen.getByTestId('agent-changes-card')).toBeTruthy();
    });
    expect(screen.getByText('+3 items')).toBeTruthy();
    expect(onRunComplete).toHaveBeenCalledWith('run1');
  });
});
