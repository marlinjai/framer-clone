// src/lib/live/revealStore.ts
//
// The nodes revealing on the canvas right now (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 4): node id to delay, from a reveal plan (./reveal.ts). Held on the
// editor user interface (UI) store as volatile state, like the presence store: never part of
// the project, so never saved, never published and never in the history.
// ComponentRenderer reads one key per node (an observable map tracks each key
// on its own, so a batch re-renders only its own nodes) and draws the entry as
// a Cascading Style Sheets (CSS) animation with that delay; no JavaScript runs per frame.
//
// Each batch's entries leave on their own timer once their animation has
// played (delay + REVEAL_NODE_MS + REVEAL_SETTLE_MS), so:
//   - a node remounted later (a redo, a page switch) appears at once instead
//     of playing its reveal again;
//   - a second batch arriving within the first's 600 ms never cuts the first
//     short (no reset on start). A node still revealing keeps its timing when
//     a newer batch names it again (rewriting its delay would restart it).
//
// The timer is armed only once the batch has been painted (two animation
// frames after start), never at start: start runs inside the adoption's
// action, and the commit that draws the new nodes can block the main thread
// for longer than the whole reveal (a first adoption, a slow device). A timer
// armed at start then fired the moment that task ended and took the entries
// away before any element had played its animation, so that write never
// revealed. The margin past the animation's end (REVEAL_SETTLE_MS) covers an
// element whose first style pass comes a little after the paint; should the
// timer still win, the node only snaps to fully visible.
//
// Who starts a reveal decides whether one is due (an adopted agent write, a
// generate_page result, the in-editor Generate apply); this store only plays
// what it is given. Reduced motion is the stylesheet's call (the rule on
// [data-live-reveal] turns the animation off), so a change of the setting
// mid-session is followed too.

import { action, makeObservable, observable } from 'mobx';
import { REVEAL_NODE_MS } from './reveal';

/** Kept past the animation's end, so the entry does not leave while a late-mounted node still plays. */
export const REVEAL_SETTLE_MS = 400;

export class LiveRevealStore {
  /** Node id to its delay in milliseconds. */
  readonly delays = observable.map<string, number>();
  /** Which batch set each entry. */
  private batches = new Map<string, number>();
  private batch = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private frames = new Set<number>();

  constructor() {
    makeObservable<LiveRevealStore, 'expire'>(this, {
      start: action,
      expire: action,
      reset: action,
    });
  }

  /** The delay of a node revealing now, undefined when it is not revealing. */
  delayOf(id: string): number | undefined {
    return this.delays.get(id);
  }

  get size(): number {
    return this.delays.size;
  }

  /** Reveal the nodes of a plan (node id to delay, in reveal order). Answers the batch's number. */
  start(plan: ReadonlyMap<string, number>): number {
    const batch = ++this.batch;
    if (plan.size === 0) return batch;
    let last = 0;
    const ids: string[] = [];
    for (const [id, delay] of plan) {
      if (this.delays.has(id)) continue;
      this.delays.set(id, delay);
      this.batches.set(id, batch);
      ids.push(id);
      if (delay > last) last = delay;
    }
    if (ids.length === 0) return batch;
    const arm = () => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.expire(batch, ids);
      }, last + REVEAL_NODE_MS + REVEAL_SETTLE_MS);
      this.timers.add(timer);
    };
    this.afterPaint(arm);
    return batch;
  }

  /** Run `fn` once the frame that draws the current changes has been painted (at once without animation frames). */
  private afterPaint(fn: () => void): void {
    if (typeof requestAnimationFrame !== 'function') {
      fn();
      return;
    }
    // The first callback runs before the paint of the commit's frame, the second after it.
    const first = requestAnimationFrame(() => {
      this.frames.delete(first);
      const second = requestAnimationFrame(() => {
        this.frames.delete(second);
        fn();
      });
      this.frames.add(second);
    });
    this.frames.add(first);
  }

  private expire(batch: number, ids: readonly string[]): void {
    for (const id of ids) {
      if (this.batches.get(id) !== batch) continue;
      this.batches.delete(id);
      this.delays.delete(id);
    }
  }

  /** Forget everything (the editor closed the site, or opened another). */
  reset(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (typeof cancelAnimationFrame === 'function') for (const frame of this.frames) cancelAnimationFrame(frame);
    this.frames.clear();
    this.batches.clear();
    this.delays.clear();
  }
}
