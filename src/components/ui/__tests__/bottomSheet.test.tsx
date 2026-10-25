// The bottom sheet and the on-screen keyboard: while the keyboard covers the
// bottom of the screen (window.visualViewport smaller than the layout
// viewport), the sheet sits on top of it and shrinks to the visible area.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BottomSheet, PEEK_SVH, SWIPE_CLOSE_DISTANCE, swipeOutcome, type SheetDetent } from '../bottom-sheet';

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

describe('BottomSheet detents (peek and full)', () => {
  it('the swipe rules: up from peek to full, down from full to peek, down from peek closes', () => {
    expect(swipeOutcome('peek', -SWIPE_CLOSE_DISTANCE)).toBe('full');
    expect(swipeOutcome('full', SWIPE_CLOSE_DISTANCE)).toBe('peek');
    expect(swipeOutcome('peek', SWIPE_CLOSE_DISTANCE)).toBe('close');
    expect(swipeOutcome('full', -200)).toBeNull();
    expect(swipeOutcome('peek', 20)).toBeNull();
    // Without detents only a swipe down does anything: it closes.
    expect(swipeOutcome(undefined, SWIPE_CLOSE_DISTANCE)).toBe('close');
    expect(swipeOutcome(undefined, -200)).toBeNull();
  });

  function Harness({ initial, onClose }: { initial: SheetDetent; onClose: () => void }) {
    const [detent, setDetent] = React.useState<SheetDetent>(initial);
    return (
      <BottomSheet open onOpenChange={(o) => !o && onClose()} title="Properties" size="medium" detent={detent} onDetentChange={setDetent} data-testid="s">
        <div style={{ height: 2000 }}>rows</div>
      </BottomSheet>
    );
  }

  const swipe = (el: HTMLElement, dy: number) => {
    const at = (y: number) => [{ clientX: 100, clientY: y }];
    fireEvent.touchStart(el, { touches: at(400), changedTouches: at(400), targetTouches: at(400) });
    fireEvent.touchMove(el, { touches: at(400 + dy), changedTouches: at(400 + dy), targetTouches: at(400 + dy) });
    fireEvent.touchEnd(el, { touches: [], changedTouches: at(400 + dy), targetTouches: [] });
  };

  it('at peek it keeps its full height and sits lower by the difference, with matching end padding', () => {
    setViewport(new FakeVisualViewport(window.innerHeight));
    render(<Harness initial="peek" onClose={() => {}} />);
    const sheet = screen.getByTestId('s');
    expect(sheet.dataset.detent).toBe('peek');
    expect(sheet.className).toContain('h-[60svh]');
    expect(sheet.style.translate).toBe(`0 ${60 - PEEK_SVH}svh`);
    expect(sheet.style.transform).toBe('');
  });

  it('swipes and the chevron move between the detents; down from peek closes', () => {
    setViewport(new FakeVisualViewport(window.innerHeight));
    let closed = false;
    render(<Harness initial="peek" onClose={() => (closed = true)} />);
    const sheet = screen.getByTestId('s');
    const title = screen.getByText('Properties');
    swipe(title, -120);
    expect(sheet.dataset.detent).toBe('full');
    expect(sheet.style.translate).toBe('0 0px');
    swipe(title, 120);
    expect(sheet.dataset.detent).toBe('peek');
    fireEvent.click(screen.getByTestId('s-detent'));
    expect(sheet.dataset.detent).toBe('full');
    expect(screen.getByTestId('s-detent').getAttribute('aria-label')).toBe('Shrink Properties');
    fireEvent.click(screen.getByTestId('s-detent'));
    swipe(title, 120);
    expect(closed).toBe(true);
  });

  it('with the keyboard up a peek sheet is not pushed down', () => {
    setViewport(new FakeVisualViewport(window.innerHeight - 300));
    render(<Harness initial="peek" onClose={() => {}} />);
    expect(screen.getByTestId('s').style.translate).toBe('0 0px');
  });
});
