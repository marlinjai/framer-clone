// The standalone preview has nothing to save: Cmd/Ctrl+S only keeps the
// browser's "save page" dialog away, also when a field stops the key.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import BlockSaveShortcut from '../BlockSaveShortcut';

afterEach(() => cleanup());

describe('BlockSaveShortcut', () => {
  it('prevents the dialog for Cmd+S and Ctrl+S, sends nothing, and leaves other keys alone', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<BlockSaveShortcut />);
    const field = document.createElement('input');
    field.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.appendChild(field);
    const cmd = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(cmd);
    expect(cmd.defaultPrevented).toBe(true);
    const ctrl = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    const other = new KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    field.remove();
    vi.unstubAllGlobals();
  });
});
