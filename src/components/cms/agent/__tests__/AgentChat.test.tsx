import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import AgentChat from '../AgentChat';
import type { ChatMessage } from '../types';

afterEach(() => cleanup());

describe('AgentChat', () => {
  it('renders the user prompt text', () => {
    const messages: ChatMessage[] = [{ kind: 'user', id: 'm1', text: 'Generate 5 posts' }];
    render(<AgentChat messages={messages} />);
    expect(screen.getByText('Generate 5 posts')).toBeTruthy();
  });

  it('renders the thinking indicator while an assistant turn is streaming', () => {
    const messages: ChatMessage[] = [{ kind: 'assistant', id: 'm2', thinking: true, steps: [] }];
    render(<AgentChat messages={messages} />);
    expect(screen.getByTestId('agent-thinking-indicator')).toBeTruthy();
  });

  it('renders an error message with a Try again action', () => {
    const onRetry = vi.fn();
    const messages: ChatMessage[] = [
      { kind: 'error', id: 'm3', message: 'Image upload requires Storage Brain integration' },
    ];
    render(<AgentChat messages={messages} onRetry={onRetry} />);
    expect(screen.getByText('Image upload requires Storage Brain integration')).toBeTruthy();
    fireEvent.click(screen.getByTestId('agent-try-again'));
    expect(onRetry).toHaveBeenCalled();
  });
});
