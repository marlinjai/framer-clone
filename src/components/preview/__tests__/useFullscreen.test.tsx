// The fullscreen state machine against a mocked document Fullscreen API:
// entering, leaving by Esc (a bare fullscreenchange), a rejected request, no
// API at all, and entering again after leaving.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { useFullscreen } from '../useFullscreen';
import FullscreenExitControl, { EXIT_CONTROL_HIDE_MS } from '../FullscreenExitControl';

let root: HTMLDivElement;
let current: Element | null;
let request: ReturnType<typeof vi.fn>;
const doc = document as Document & Record<string, unknown>;

const fire = () => document.dispatchEvent(new Event('fullscreenchange'));

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  current = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => current });
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
  request = vi.fn(async () => {
    current = root;
    fire();
  });
  root.requestFullscreen = request as unknown as typeof root.requestFullscreen;
  document.exitFullscreen = vi.fn(async () => {
    current = null;
    fire();
  });
});
afterEach(() => {
  cleanup();
  root.remove();
  delete (doc as Record<string, unknown>).fullscreenElement;
  delete (doc as Record<string, unknown>).fullscreenEnabled;
  delete (doc as { exitFullscreen?: unknown }).exitFullscreen;
});

const setup = (onLeave?: () => void) => renderHook(() => useFullscreen({ current: root }, { onLeave }));

describe('useFullscreen', () => {
  it('enter requests real fullscreen on the root and follows the change event', async () => {
    const { result } = setup();
    await act(() => result.current.enter());
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.native).toBe(true);
    expect(result.current.fallback).toBe(false);
    expect(result.current.immersive).toBe(true);
  });

  it('exit leaves fullscreen and reports it once', async () => {
    const onLeave = vi.fn();
    const { result } = setup(onLeave);
    await act(() => result.current.enter());
    await act(() => result.current.exit());
    expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(result.current.immersive).toBe(false);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('Esc (a fullscreenchange with no fullscreen element) returns to normal and reports it', async () => {
    const onLeave = vi.fn();
    const { result } = setup(onLeave);
    await act(() => result.current.enter());
    act(() => {
      current = null;
      fire();
    });
    expect(result.current.native).toBe(false);
    expect(result.current.immersive).toBe(false);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('can enter again after leaving with Esc', async () => {
    const { result } = setup();
    await act(() => result.current.enter());
    act(() => {
      current = null;
      fire();
    });
    await act(() => result.current.enter());
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.native).toBe(true);
  });

  it('a rejected request falls back to the in-window view without an unhandled rejection', async () => {
    request.mockRejectedValueOnce(new TypeError('Permissions check failed'));
    const { result } = setup();
    await act(() => result.current.enter());
    expect(result.current.native).toBe(false);
    expect(result.current.fallback).toBe(true);
    expect(result.current.immersive).toBe(true);
    // The fallback has a way out, and leaving it needs no browser call.
    await act(() => result.current.exit());
    expect(document.exitFullscreen).not.toHaveBeenCalled();
    expect(result.current.immersive).toBe(false);
  });

  it('a synchronous throw is handled the same way', async () => {
    request.mockImplementationOnce(() => {
      throw new Error('not allowed');
    });
    const { result } = setup();
    await act(() => result.current.enter());
    expect(result.current.fallback).toBe(true);
  });

  it('no Fullscreen API (iPhone Safari): falls back at once', async () => {
    (root as unknown as Record<string, unknown>).requestFullscreen = undefined;
    const { result } = setup();
    await act(() => result.current.enter());
    expect(result.current.fallback).toBe(true);
    expect(result.current.native).toBe(false);
  });

  it('fullscreen disabled by the embedding frame: falls back without asking', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false });
    const { result } = setup();
    await act(() => result.current.enter());
    expect(request).not.toHaveBeenCalled();
    expect(result.current.fallback).toBe(true);
  });

  it('uses the webkit-prefixed API where only that exists', async () => {
    (root as unknown as Record<string, unknown>).requestFullscreen = undefined;
    const webkitRequest = vi.fn(() => {
      Object.defineProperty(document, 'webkitFullscreenElement', { configurable: true, get: () => root });
      document.dispatchEvent(new Event('webkitfullscreenchange'));
    });
    (root as unknown as Record<string, unknown>).webkitRequestFullscreen = webkitRequest;
    const { result } = setup();
    await act(() => result.current.enter());
    expect(webkitRequest).toHaveBeenCalledTimes(1);
    expect(result.current.native).toBe(true);
    delete (doc as Record<string, unknown>).webkitFullscreenElement;
  });

  it('toggle enters, then exits', async () => {
    const { result } = setup();
    await act(() => result.current.toggle());
    expect(result.current.immersive).toBe(true);
    await act(() => result.current.toggle());
    expect(result.current.immersive).toBe(false);
  });
});

describe('FullscreenExitControl', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const visible = () => screen.getByRole('button', { name: 'Exit fullscreen' }).hasAttribute('data-visible');

  it('is shown on entering, fades after two seconds, and returns on mouse movement', () => {
    render(<FullscreenExitControl onExit={() => {}} />);
    expect(visible()).toBe(true);
    act(() => void vi.advanceTimersByTime(EXIT_CONTROL_HIDE_MS + 10));
    expect(visible()).toBe(false);
    act(() => void window.dispatchEvent(new MouseEvent('mousemove')));
    expect(visible()).toBe(true);
    act(() => void vi.advanceTimersByTime(EXIT_CONTROL_HIDE_MS + 10));
    expect(visible()).toBe(false);
  });

  it('stays while hovered and exits on click', () => {
    const onExit = vi.fn();
    render(<FullscreenExitControl onExit={onExit} />);
    const button = screen.getByRole('button', { name: 'Exit fullscreen' });
    fireEvent.mouseEnter(button);
    act(() => void vi.advanceTimersByTime(EXIT_CONTROL_HIDE_MS * 3));
    expect(visible()).toBe(true);
    fireEvent.click(button);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});
