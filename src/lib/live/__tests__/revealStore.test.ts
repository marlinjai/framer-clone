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

describe('LiveRevealStore', () => {
  it('holds a batch until its last node played, then forgets it', () => {
    const store = new LiveRevealStore();
    store.start(new Map([['a', 0], ['b', 45], ['c', 90]]));
    expect(store.delayOf('b')).toBe(45);
    vi.advanceTimersByTime(90 + REVEAL_NODE_MS + REVEAL_SETTLE_MS - 1);
    expect(store.size).toBe(3);
    vi.advanceTimersByTime(1);
    expect(store.size).toBe(0);
    expect(store.delayOf('a')).toBeUndefined();
  });

  it("a newer batch's entry for the same node is not removed by the older batch's timer", () => {
    const store = new LiveRevealStore();
    store.start(new Map([['a', 0], ['b', 45]]));
    vi.advanceTimersByTime(200);
    store.start(new Map([['b', 0], ['c', 45]]));
    vi.advanceTimersByTime(150); // the first batch ends (45 + 180 + 120)
    expect([...store.delays.keys()].sort()).toEqual(['b', 'c']);
    vi.advanceTimersByTime(200);
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
