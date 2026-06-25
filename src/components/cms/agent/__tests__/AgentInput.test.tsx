import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import AgentInput from '../AgentInput';

afterEach(() => cleanup());

describe('AgentInput', () => {
  it('limits the file picker to .csv', () => {
    render(<AgentInput isRunning={false} onSend={vi.fn()} />);
    const fileInput = screen.getByTestId('agent-file-input') as HTMLInputElement;
    expect(fileInput.accept).toBe('.csv');
  });

  it('clears the textarea and calls onSend with the prompt', () => {
    const onSend = vi.fn();
    render(<AgentInput isRunning={false} onSend={onSend} />);
    const textarea = screen.getByTestId('agent-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Generate 3 posts' } });
    fireEvent.click(screen.getByTestId('agent-send'));
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Generate 3 posts', model: 'OPUS' }),
    );
    expect(textarea.value).toBe('');
  });

  it('attaches a selected CSV file and sends it as a base64 csvPayload', async () => {
    const onSend = vi.fn();
    render(<AgentInput isRunning={false} onSend={onSend} />);

    const file = new File(['Name,City\nAda,London'], 'people.csv', { type: 'text/csv' });
    const fileInput = screen.getByTestId('agent-file-input') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId('agent-csv-chip')).toBeTruthy());

    fireEvent.change(screen.getByTestId('agent-textarea'), { target: { value: 'Import this' } });
    fireEvent.click(screen.getByTestId('agent-send'));

    expect(onSend).toHaveBeenCalledTimes(1);
    const payload = onSend.mock.calls[0][0];
    expect(payload.csvPayload.name).toBe('people.csv');
    // base64 of the CSV text round-trips back to the original.
    const decoded = atob(payload.csvPayload.content);
    expect(decoded).toContain('Ada,London');
  });

  it('disables send while a run is in flight', () => {
    render(<AgentInput isRunning onSend={vi.fn()} />);
    fireEvent.change(screen.getByTestId('agent-textarea'), { target: { value: 'hi' } });
    expect((screen.getByTestId('agent-send') as HTMLButtonElement).disabled).toBe(true);
  });
});
