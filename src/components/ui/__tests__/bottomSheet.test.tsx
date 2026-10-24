// The bottom sheet and the on-screen keyboard: while the keyboard covers the
// bottom of the screen (window.visualViewport smaller than the layout
// viewport), the sheet sits on top of it and shrinks to the visible area.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { BottomSheet } from '../bottom-sheet';

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  constructor(height: number) {
    super();
    this.height = height;
  }
}

afterEach(() => {
  cleanup();
  delete (window as { visualViewport?: unknown }).visualViewport;
});

function setViewport(vv: FakeVisualViewport | undefined) {
  Object.defineProperty(window, 'visualViewport', { configurable: true, writable: true, value: vv });
}

describe('BottomSheet and the keyboard', () => {
  it('without a keyboard it is anchored at the bottom with its svh height class', () => {
    setViewport(new FakeVisualViewport(window.innerHeight));
    render(
      <BottomSheet open onOpenChange={() => {}} title="Properties" size="medium" data-testid="s">
        <input aria-label="Width" />
      </BottomSheet>,
    );
    const sheet = screen.getByTestId('s');
    expect(sheet.className).toContain('h-[60svh]');
    expect(sheet.style.bottom).toBe('');
  });

  it('lifts itself above the keyboard and caps its height to the visible area', () => {
    const vv = new FakeVisualViewport(window.innerHeight);
    setViewport(vv);
    render(
      <BottomSheet open onOpenChange={() => {}} title="Properties" size="medium" data-testid="s">
        <input aria-label="Width" />
      </BottomSheet>,
    );
    act(() => {
      vv.height = window.innerHeight - 300;
      vv.dispatchEvent(new Event('resize'));
    });
    const sheet = screen.getByTestId('s');
    expect(sheet.style.bottom).toBe('300px');
    expect(sheet.style.maxHeight).toBe(`${window.innerHeight - 300 - 16}px`);
    // Keyboard closed again: back to normal.
    act(() => {
      vv.height = window.innerHeight;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(sheet.style.bottom).toBe('');
  });

  it('works where visualViewport does not exist', () => {
    setViewport(undefined);
    render(
      <BottomSheet open onOpenChange={() => {}} title="Layers" data-testid="s">
        <p>content</p>
      </BottomSheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Layers' }).className).toContain('h-[85svh]');
  });
});
