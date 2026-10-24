// Save and Publish results: inline on the wide bar, a dismissible notice under
// the compact bar, where a success clears itself after a few seconds.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { COMPACT_SUCCESS_MS, TopBarStatus } from '../TopBarStatus';

function setCompact(compact: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: compact, addEventListener() {}, removeEventListener() {} }),
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('TopBarStatus', () => {
  it('compact bar: a success clears itself after a few seconds', () => {
    setCompact(true);
    const onDismiss = vi.fn();
    render(<TopBarStatus kind="success" title="Saved 2 pages." onDismiss={onDismiss}>Saved 2 pages.</TopBarStatus>);
    expect(screen.getByRole('status').textContent).toContain('Saved 2 pages.');
    act(() => vi.advanceTimersByTime(COMPACT_SUCCESS_MS - 1));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('compact bar: an error stays until dismissed', () => {
    setCompact(true);
    const onDismiss = vi.fn();
    render(<TopBarStatus kind="error" title="Save failed" onDismiss={onDismiss}>Save failed</TopBarStatus>);
    act(() => vi.advanceTimersByTime(COMPACT_SUCCESS_MS * 3));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('compact bar: a success that carries a link (Publish) stays until dismissed', () => {
    setCompact(true);
    const onDismiss = vi.fn();
    render(
      <TopBarStatus kind="success" title="Published" onDismiss={onDismiss} persist>
        Published <a href="https://example.com">live at example.com</a>
      </TopBarStatus>,
    );
    act(() => vi.advanceTimersByTime(COMPACT_SUCCESS_MS * 3));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'live at example.com' })).toBeTruthy();
  });

  it('wide bar: a success stays inline as before', () => {
    setCompact(false);
    const onDismiss = vi.fn();
    render(<TopBarStatus kind="success" title="Published" onDismiss={onDismiss}>Published</TopBarStatus>);
    act(() => vi.advanceTimersByTime(COMPACT_SUCCESS_MS * 3));
    expect(onDismiss).not.toHaveBeenCalled();
    // The dismiss button exists only in the compact notice.
    expect(screen.getByRole('button', { name: 'Dismiss' }).className).toContain('lg:hidden');
  });
});
