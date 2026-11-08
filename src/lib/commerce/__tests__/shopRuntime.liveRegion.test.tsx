// A part whose message comes later (ShopPartRender.live) is its own status region on
// a live surface: the designed element itself stays mounted in every state, empty and
// visually hidden while it waits, so the design's flex and grid placement and its
// child-combinator rules reach it on a published page as they do on the canvas. Only
// one element carries the role, and a part kept in sight is not pinned into view
// while its region waits empty.
import * as React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_LIVE_REGION_STYLE, ShopPartElement, ShopRuntimeContext, type ShopPartRender, type ShopRuntime } from '../shopRuntime';

afterEach(cleanup);

function runtimeFor(surface: 'live' | 'canvas', renders: Record<string, ShopPartRender>): ShopRuntime {
  return {
    kind: 'checkout-button',
    locale: 'en',
    surface,
    part: (role) => renders[role] ?? { visible: false },
  };
}

function Control({ runtime, role, style }: { runtime: ShopRuntime; role: string; style?: React.CSSProperties }) {
  return (
    <div data-component-kind="checkout-button" data-testid="control" style={{ display: 'flex', gap: '8px' }}>
      <span data-sibling="">before</span>
      <ShopRuntimeContext.Provider value={runtime}>
        <ShopPartElement
          role={role}
          tag="div"
          domProps={{ 'data-shop-part': role, className: 'designed', style: { order: 2, gridColumn: '1 / -1', alignSelf: 'end', ...style } }}
          storedText={undefined}
          surface="preview"
        />
      </ShopRuntimeContext.Provider>
    </div>
  );
}

describe('a message shown later on a live surface', () => {
  it('waits as the designed element itself: a direct item of the control, empty, visually hidden, with the design kept', () => {
    const runtime = runtimeFor('live', { 'checkout.redirecting': { visible: false, live: true } });
    const { getByTestId } = render(<Control runtime={runtime} role="checkout.redirecting" />);
    const control = getByTestId('control');
    const part = control.querySelector<HTMLElement>('[data-shop-part="checkout.redirecting"]')!;
    expect(part).not.toBeNull();
    // No wrapper: the part is the control's own flex item, as on the canvas.
    expect(part.parentElement).toBe(control);
    expect(part.getAttribute('role')).toBe('status');
    expect(part.getAttribute('data-shop-live')).toBe('checkout.redirecting');
    expect(part.className).toBe('designed');
    expect(part.textContent).toBe('');
    expect(part.style.order).toBe('2');
    expect(part.style.alignSelf).toBe('end');
    // Visually hidden, out of the flow and the gap, never display none.
    expect(part.style.position).toBe('absolute');
    expect(part.style.width).toBe('1px');
    expect(part.style.height).toBe('1px');
    expect(part.style.overflow).toBe('hidden');
    expect(part.style.margin).toBe('0px');
    expect(part.style.display).not.toBe('none');
    expect(control.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('the same element receives the message and is drawn in the flow with the design style alone', () => {
    const waiting = runtimeFor('live', { 'checkout.redirecting': { visible: false, live: true } });
    const { getByTestId, rerender } = render(<Control runtime={waiting} role="checkout.redirecting" />);
    const before = getByTestId('control').querySelector('[data-shop-part="checkout.redirecting"]');
    const shown = runtimeFor('live', { 'checkout.redirecting': { visible: true, live: true, text: 'Going to payment', props: { 'data-checkout-redirecting': '' } } });
    rerender(<Control runtime={shown} role="checkout.redirecting" />);
    const part = getByTestId('control').querySelector<HTMLElement>('[data-shop-part="checkout.redirecting"]')!;
    expect(part).toBe(before);
    expect(part.textContent).toBe('Going to payment');
    expect(part.getAttribute('role')).toBe('status');
    expect(part.hasAttribute('data-checkout-redirecting')).toBe(true);
    expect(part.style.position).toBe('');
    expect(part.style.width).toBe('');
    expect(part.style.order).toBe('2');
    expect(getByTestId('control').querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it('a state prop never takes the role away or adds a second one', () => {
    const runtime = runtimeFor('live', { 'checkout.redirecting': { visible: true, live: true, text: 'x', props: { role: 'alert' } } });
    const { getByTestId } = render(<Control runtime={runtime} role="checkout.redirecting" />);
    const control = getByTestId('control');
    expect(control.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(control.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it('a part kept in sight is not pinned into view while its region waits, and is once it shows', () => {
    // checkout.total keeps itself in sight (its spec); given as a later message here to prove the two do not fight.
    const waiting = runtimeFor('live', { 'checkout.total': { visible: false, live: true } });
    const { getByTestId, rerender } = render(<Control runtime={waiting} role="checkout.total" />);
    const part = getByTestId('control').querySelector<HTMLElement>('[data-shop-part="checkout.total"]')!;
    expect(part.style.position).toBe('absolute');
    expect(part.style.getPropertyPriority('position')).toBe('');
    expect(part.style.getPropertyPriority('overflow')).toBe('');
    expect(part.style.getPropertyValue('z-index')).toBe('');

    rerender(<Control runtime={runtimeFor('live', { 'checkout.total': { visible: true, live: true, text: 'Total' } })} role="checkout.total" />);
    expect(getByTestId('control').querySelector('[data-shop-part="checkout.total"]')).toBe(part);
    expect(part.style.getPropertyValue('position')).toBe('relative');
    expect(part.style.getPropertyPriority('position')).toBe('important');

    // Back to waiting: the pins come off and the region hides again (the lift above its siblings too).
    rerender(<Control runtime={waiting} role="checkout.total" />);
    expect(part.style.position).toBe('absolute');
    expect(part.style.overflow).toBe('hidden');
    expect(part.style.getPropertyValue('z-index')).toBe('');
    expect(part.style.getPropertyValue('opacity')).toBe('');
    expect(part.textContent).toBe('');
  });

  it('on the canvas a hidden later message is not drawn at all (nothing is announced there)', () => {
    const runtime = runtimeFor('canvas', { 'checkout.redirecting': { visible: false, live: true } });
    const { getByTestId } = render(<Control runtime={runtime} role="checkout.redirecting" />);
    expect(getByTestId('control').querySelector('[data-shop-part="checkout.redirecting"]')).toBeNull();
  });

  it('the hidden style takes no space: no padding, border or margin, clipped to one pixel', () => {
    expect(EMPTY_LIVE_REGION_STYLE).toMatchObject({ position: 'absolute', width: '1px', height: '1px', padding: 0, border: 0, margin: 0, overflow: 'hidden' });
  });
});
