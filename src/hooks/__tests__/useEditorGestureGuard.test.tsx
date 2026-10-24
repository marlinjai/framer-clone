// The editor blocks the browser's page zoom outside the canvas (the canvas has
// its own pinch zoom) while one-finger scrolling in panels keeps working.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useEditorGestureGuard, lastPointerIsTouch } from '../useEditorGestureGuard';

function Editor() {
  useEditorGestureGuard();
  return (
    <div>
      <div data-testid="panel" style={{ overflow: 'auto' }}>panel</div>
      <div data-ground="true"><div data-testid="canvas-node">node</div></div>
    </div>
  );
}

afterEach(() => cleanup());

/** A touchmove with `fingers` touches, dispatched on `el`; true when the default was prevented. */
function touchMove(el: Element, fingers: number): boolean {
  const ev = new Event('touchmove', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'touches', { value: Array.from({ length: fingers }, () => ({})) });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

function dispatch(el: Element, ev: Event): boolean {
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

describe('useEditorGestureGuard', () => {
  it('limits the editor to panning (no page pinch or double-tap zoom) and restores on unmount', () => {
    const { unmount } = render(<Editor />);
    expect(document.documentElement.style.touchAction).toBe('pan-x pan-y');
    unmount();
    expect(document.documentElement.style.touchAction).toBe('');
    expect(document.documentElement.hasAttribute('data-pointer')).toBe(false);
  });

  it('a pinch outside the canvas does not zoom the page (default prevented)', () => {
    const { getByTestId } = render(<Editor />);
    expect(touchMove(getByTestId('panel'), 2)).toBe(true);
    // Safari's own pinch events.
    expect(dispatch(getByTestId('panel'), new Event('gesturestart', { bubbles: true, cancelable: true }))).toBe(true);
    expect(dispatch(getByTestId('panel'), new Event('gesturechange', { bubbles: true, cancelable: true }))).toBe(true);
  });

  it('one-finger scrolling in a panel is left to the browser', () => {
    const { getByTestId } = render(<Editor />);
    expect(touchMove(getByTestId('panel'), 1)).toBe(false);
    expect(dispatch(getByTestId('panel'), new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }))).toBe(false);
  });

  it('a trackpad pinch (ctrl+wheel) outside the canvas is blocked, on the canvas it is left to the canvas', () => {
    const { getByTestId } = render(<Editor />);
    const pinch = () => new WheelEvent('wheel', { deltaY: -5, ctrlKey: true, bubbles: true, cancelable: true });
    expect(dispatch(getByTestId('panel'), pinch())).toBe(true);
    expect(dispatch(getByTestId('canvas-node'), pinch())).toBe(false);
    expect(touchMove(getByTestId('canvas-node'), 2)).toBe(false);
  });

  it('remembers the last input type for finger-sized handle hit areas', () => {
    const { getByTestId } = render(<Editor />);
    fireEvent.pointerDown(getByTestId('panel'), { pointerType: 'touch' });
    expect(document.documentElement.getAttribute('data-pointer')).toBe('touch');
    expect(lastPointerIsTouch()).toBe(true);
    fireEvent.pointerDown(getByTestId('panel'), { pointerType: 'pen' });
    expect(lastPointerIsTouch()).toBe(false);
    fireEvent.pointerDown(getByTestId('panel'), { pointerType: 'mouse' });
    expect(document.documentElement.getAttribute('data-pointer')).toBe('mouse');
  });
});
