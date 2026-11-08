// revealStore.ts: the nodes revealing now. Volatile, so never in the project,
// a save or the history (EditorUIStore holds it outside the MST snapshot);
// each batch leaves on its own timer; reset forgets everything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { autorun } from 'mobx';
import { LiveRevealStore, REVEAL_SETTLE_MS } from '../revealStore';
import { REVEAL_NODE_MS } from '../reveal';
import { createRootStore } from '@/stores/RootStore';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** The batch was painted: its timer runs from here (two animation frames after start). */
function painted() {
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();
}

describe('LiveRevealStore', () => {
  it('holds a batch until its last node played, then forgets it', () => {
    const store = new LiveRevealStore();
    store.start(new Map([['a', 0], ['b', 45], ['c', 90]]));
    expect(store.delayOf('b')).toBe(45);
    painted();
    vi.advanceTimersByTime(90 + REVEAL_NODE_MS + REVEAL_SETTLE_MS - 1);
    expect(store.size).toBe(3);
    vi.advanceTimersByTime(1);
    expect(store.size).toBe(0);
    expect(store.delayOf('a')).toBeUndefined();
  });

  it('a node still revealing keeps its timing when a newer batch names it again', () => {
    const store = new LiveRevealStore();
    store.start(new Map([['a', 0], ['b', 45]]));
    painted();
    const firstEnds = Date.now() + 45 + REVEAL_NODE_MS + REVEAL_SETTLE_MS;
    vi.advanceTimersByTime(200);
    store.start(new Map([['b', 0], ['c', 45]]));
    expect(store.delayOf('b')).toBe(45);
    painted();
    const secondEnds = Date.now() + 45 + REVEAL_NODE_MS + REVEAL_SETTLE_MS;
    vi.advanceTimersByTime(firstEnds - Date.now()); // the first batch ends
    expect([...store.delays.keys()]).toEqual(['c']);
    vi.advanceTimersByTime(secondEnds - Date.now());
    expect(store.size).toBe(0);
  });

  it('the timer runs from the first paint, so a commit that blocks longer than the reveal never takes it away unplayed', () => {
    const store = new LiveRevealStore();
    store.start(new Map([['a', 0]]));
    // The adoption's render blocks the main thread: timers are due, but no frame has been painted yet.
    vi.advanceTimersByTime(0);
    expect(store.delayOf('a')).toBe(0);
    painted();
    expect(store.delayOf('a')).toBe(0);
    vi.advanceTimersByTime(REVEAL_NODE_MS + REVEAL_SETTLE_MS);
    expect(store.size).toBe(0);
  });

  it('an empty plan changes nothing; reset forgets everything and its timers', () => {
    const store = new LiveRevealStore();
    store.start(new Map());
    expect(store.size).toBe(0);
    store.start(new Map([['a', 0]]));
    store.reset();
    expect(store.size).toBe(0);
    store.start(new Map([['a', 0]]));
    vi.advanceTimersByTime(10_000);
    expect(store.size).toBe(0);
  });

  it('a node observes only its own key', () => {
    const store = new LiveRevealStore();
    const seen: Array<number | undefined> = [];
    const stop = autorun(() => seen.push(store.delayOf('x')));
    store.start(new Map([['other', 0]]));
    expect(seen).toEqual([undefined]);
    store.start(new Map([['x', 30]]));
    expect(seen).toEqual([undefined, 30]);
    stop();
  });

  it('lives on the editor UI store as volatile state: never in its snapshot', () => {
    const root = createRootStore();
    root.editorUI.liveReveal.start(new Map([['a', 0]]));
    expect(JSON.stringify(getSnapshot(root.editorUI))).not.toContain('liveReveal');
    expect(JSON.stringify(getSnapshot(root))).not.toContain('"a"');
  });
});
