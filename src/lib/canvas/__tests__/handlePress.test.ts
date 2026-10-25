// A finger press on a selection handle: drag means the handle gesture, a
// still hold means the selection's long-press menu (src/lib/canvas/handlePress.ts).
import { describe, it, expect, vi } from 'vitest';
import { followHandlePress, startHandlePress, type HandlePressDeps } from '../handlePress';
import { LONG_PRESS_MS, TOUCH_DRAG_THRESHOLD_PX } from '../touchGestures';

function harness(tickResult: string = 'vibrate') {
  let pending: { fn: () => void; ms: number } | null = null;
  const deps = {
    startHandle: vi.fn(),
    openMenu: vi.fn(),
    slideMove: vi.fn(),
    tryTick: vi.fn(() => tickResult),
    tick: vi.fn(),
    setTimer: vi.fn((fn: () => void, ms: number) => { pending = { fn, ms }; return 1; }),
    clearTimer: vi.fn(() => { pending = null; }),
  } satisfies HandlePressDeps;
  const fire = () => { const p = pending; pending = null; p?.fn(); };
  return { deps, fire, pendingMs: () => pending?.ms };
}

describe('startHandlePress', () => {
  it('waits LONG_PRESS_MS before deciding', () => {
    const h = harness();
    const press = startHandlePress({ x: 100, y: 100 }, h.deps);
    expect(press.state).toBe('waiting');
    expect(h.pendingMs()).toBe(LONG_PRESS_MS);
    expect(h.deps.startHandle).not.toHaveBeenCalled();
    expect(h.deps.openMenu).not.toHaveBeenCalled();
  });

  it('a move within the threshold changes nothing; past it the handle gesture starts once and the menu never opens', () => {
    const h = harness();
    const press = startHandlePress({ x: 100, y: 100 }, h.deps);
    press.move(100 + TOUCH_DRAG_THRESHOLD_PX - 1, 100);
    expect(press.state).toBe('waiting');
    press.move(100 + TOUCH_DRAG_THRESHOLD_PX + 1, 100);
    press.move(140, 100);
    expect(press.state).toBe('handle');
    expect(h.deps.startHandle).toHaveBeenCalledTimes(1);
    expect(h.deps.clearTimer).toHaveBeenCalled();
    h.fire(); // a timer that already ran out must not open the menu now
    expect(h.deps.openMenu).not.toHaveBeenCalled();
    expect(h.deps.slideMove).not.toHaveBeenCalled();
  });

  it('a still hold opens the menu, and later moves slide the highlight instead of resizing', () => {
    const h = harness();
    const press = startHandlePress({ x: 100, y: 100 }, h.deps);
    h.fire();
    expect(press.state).toBe('menu');
    expect(h.deps.openMenu).toHaveBeenCalledTimes(1);
    expect(h.deps.tryTick).toHaveBeenCalledTimes(1);
    press.move(160, 220);
    expect(h.deps.slideMove).toHaveBeenCalledWith(160, 220);
    expect(h.deps.startHandle).not.toHaveBeenCalled();
  });

  it('plays the deferred iOS tick at a real release only', () => {
    const released = harness('deferred');
    startHandlePress({ x: 0, y: 0 }, released.deps);
    released.fire();
    const p1 = startHandlePress({ x: 0, y: 0 }, released.deps);
    released.fire();
    p1.end(true);
    expect(released.deps.tick).toHaveBeenCalledTimes(1);

    const cancelled = harness('deferred');
    const p2 = startHandlePress({ x: 0, y: 0 }, cancelled.deps);
    cancelled.fire();
    p2.end(false);
    expect(cancelled.deps.tick).not.toHaveBeenCalled();

    const vibrated = harness('vibrate');
    const p3 = startHandlePress({ x: 0, y: 0 }, vibrated.deps);
    vibrated.fire();
    p3.end(true);
    expect(vibrated.deps.tick).not.toHaveBeenCalled(); // it already played when the menu opened
  });

  it('a quick tap does nothing and clears its timer', () => {
    const h = harness();
    const press = startHandlePress({ x: 50, y: 50 }, h.deps);
    press.end(true);
    expect(press.state).toBe('done');
    expect(h.deps.clearTimer).toHaveBeenCalled();
    expect(h.deps.startHandle).not.toHaveBeenCalled();
    expect(h.deps.openMenu).not.toHaveBeenCalled();
    expect(h.deps.tick).not.toHaveBeenCalled();
  });
});

describe('followHandlePress', () => {
  const pointer = (type: string, pointerId: number, clientX = 0, clientY = 0) =>
    Object.assign(new Event(type), { pointerId, clientX, clientY });

  it('follows its own pointer, hands the deciding point to the handle once, and stops listening at the end', () => {
    const h = harness();
    const target = new EventTarget();
    const startHandle = vi.fn();
    const press = followHandlePress({ pointerId: 5, start: { x: 10, y: 10 }, target, deps: { ...h.deps, startHandle } });
    target.dispatchEvent(pointer('pointermove', 9, 200, 200)); // another finger
    expect(press.state).toBe('waiting');
    target.dispatchEvent(pointer('pointermove', 5, 10 + TOUCH_DRAG_THRESHOLD_PX + 3, 10));
    expect(startHandle).toHaveBeenCalledTimes(1);
    expect(startHandle).toHaveBeenCalledWith({ x: 10 + TOUCH_DRAG_THRESHOLD_PX + 3, y: 10 });
    target.dispatchEvent(pointer('pointermove', 5, 80, 10));
    expect(startHandle).toHaveBeenCalledTimes(1);
    target.dispatchEvent(pointer('pointerup', 5));
    expect(press.state).toBe('done');
    target.dispatchEvent(pointer('pointermove', 5, 300, 300));
    expect(h.deps.slideMove).not.toHaveBeenCalled();
  });

  it('a hold opens the menu; a cancel ends the press without the deferred tick', () => {
    const h = harness('deferred');
    const target = new EventTarget();
    const press = followHandlePress({ pointerId: 2, start: { x: 0, y: 0 }, target, deps: { ...h.deps, startHandle: vi.fn() } });
    h.fire();
    expect(h.deps.openMenu).toHaveBeenCalledTimes(1);
    target.dispatchEvent(pointer('pointermove', 2, 40, 40));
    expect(h.deps.slideMove).toHaveBeenCalledWith(40, 40);
    target.dispatchEvent(pointer('pointercancel', 2));
    expect(press.state).toBe('done');
    expect(h.deps.tick).not.toHaveBeenCalled();
  });
});
