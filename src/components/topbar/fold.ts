// src/components/topbar/fold.ts
//
// How the editor's wide top bar (1024px and up) gives way when its controls do not fit
// (decision recorded in docs/plans/2026-11-12-top-bar-fold.md). The bar folds by what it holds, not by the
// window: a site branch adds a switcher, Share preview and Review and merge, an agent at work adds its chip, a
// failed save adds its reason, and a long site or page name takes more room. So the bar measures itself.
//
// The fold order, each level keeping everything of the one before:
//   0. Everything with its words.
//   1. Generate, Polish, Share preview and Review and merge (and Update, on a branch behind main) lose their words
//      and become icon buttons; each keeps its name for a screen reader and says it in a tooltip that hover and
//      keyboard focus both open.
//   2. The page name beside the site name narrows from 10rem to 6rem (its full name on hover, and in the Pages
//      panel), and the branch badge gives way (the switcher names the branch, its menu says what a branch is).
//   3. The secondary icons (site settings, theme, history, and on main the published versions, domains, form
//      submissions and the light and dark switch) move into a More menu. Last, the site and branch names
//      truncate.
// Never folded: undo, redo, preview (play), the save status and the agent chip. Review and merge (or Publish on
// main) stays the bar's one filled button at every level.
//
// Under 1024px the compact bar of docs/plans/2026-10-24-editor-on-phones.md applies instead, as before.

import React from 'react';
import { flushSync } from 'react-dom';

export const MAX_FOLD = 3;
export type FoldLevel = 0 | 1 | 2 | 3;

/** The compact top bar's media query (Tailwind's `max-lg`), where this fold does not apply. */
const COMPACT_QUERY = '(max-width: 1023.98px)';

/**
 * The next level to try, from the width the bar has and the widths its content needed at the levels seen so far
 * (`required[level]`, unknown until that level was laid out once). Folds one step while the current level does
 * not fit; unfolds one step while the level before fits, trying it once when its need is not known yet. A known
 * need never changes with the window's width (every control keeps its own width until level 3), so the result
 * settles and never swings between two levels.
 */
export function decideFoldLevel(level: FoldLevel, available: number, required: ReadonlyArray<number | undefined>): FoldLevel {
  const need = required[level];
  if (need !== undefined && need > available) return level < MAX_FOLD ? ((level + 1) as FoldLevel) : level;
  if (level === 0) return level;
  const before = required[level - 1];
  // The level before has not been laid out since the content last changed: try it; if it does not fit, the
  // next measure comes back here with its need known.
  if (before === undefined || before <= available) return (level - 1) as FoldLevel;
  return level;
}

/**
 * The settled level for `available`, given what each level needs: the fewest folds that fit, or the last level.
 * What the bar converges to through decideFoldLevel, one step per layout.
 */
export function foldLevelFor(available: number, required: ReadonlyArray<number>): FoldLevel {
  for (let level = 0; level < MAX_FOLD; level++) if (required[level] <= available) return level as FoldLevel;
  return MAX_FOLD;
}

/**
 * The width the bar's content needs as laid out now: its full scroll width (every control keeps its own width
 * until the last fold, so what does not fit overflows the bar), less the free room the stretching gap in the middle (`[data-fold-gap]`) holds.
 */
export function measureRequired(bar: HTMLElement): number {
  let gap = 0;
  bar.querySelectorAll<HTMLElement>('[data-fold-gap]').forEach((el) => {
    gap += el.getBoundingClientRect().width;
  });
  return bar.scrollWidth - gap;
}

/**
 * The fold level of the top bar `ref` points at. Measured in a layout effect after every render, on every change
 * of the bar's width (ResizeObserver), every change of what it holds (MutationObserver over its text and its
 * elements; folding itself only changes classes, so it never counts as a change of content), when a control
 * grows so that the bar overflows (ResizeObserver on each control), and when web fonts finish loading. Each step is
 * rendered synchronously before the browser paints, so a person never sees a bar that does not fit.
 * Level 0 where there is no layout to measure (a test's DOM) or under 1024px.
 */
export function useTopBarFold(ref: React.RefObject<HTMLElement | null>): FoldLevel {
  const [level, setLevel] = React.useState<FoldLevel>(0);
  const [, setTick] = React.useState(0);
  const required = React.useRef<(number | undefined)[]>([]);
  const levelRef = React.useRef<FoldLevel>(0);
  levelRef.current = level;

  const measure = React.useCallback(() => {
    const bar = ref.current;
    if (!bar || typeof window === 'undefined') return;
    if (typeof window.matchMedia === 'function' && window.matchMedia(COMPACT_QUERY).matches) {
      if (levelRef.current !== 0) setLevel(0);
      return;
    }
    const available = bar.clientWidth;
    // No layout here (jsdom): nothing to decide from.
    if (available === 0) return;
    required.current[levelRef.current] = measureRequired(bar);
    const next = decideFoldLevel(levelRef.current, available, required.current);
    if (next !== levelRef.current) setLevel(next);
  }, [ref]);

  // After every render: the step just rendered is measured, and the next one, if any, rendered before paint.
  React.useLayoutEffect(measure);

  // Attached before the first paint, so no change of the bar between its first measure and the observers is missed
  // (a branch control or the agent chip that arrives in that moment).
  React.useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const rerun = () => {
      // Out of React's own render: rendered at once, so the steps land before the next paint.
      flushSync(() => setTick((t) => t + 1));
    };
    let width = bar.clientWidth;
    const resize = new ResizeObserver(() => {
      if (bar.clientWidth !== width) {
        width = bar.clientWidth;
        rerun();
        return;
      }
      // A control grew without a change of the bar's elements or text (a class or a state of its own, a late image):
      // only an overflow counts, so the fold's own steps, which resize the controls too, never start it over.
      if (bar.scrollWidth > bar.clientWidth + 1) {
        required.current = [];
        rerun();
      }
    });
    resize.observe(bar);
    // The controls themselves, observed again whenever the bar's elements change.
    const observeControls = () => {
      for (const child of Array.from(bar.children)) resize.observe(child);
    };
    observeControls();
    const content = new MutationObserver(() => {
      // What the bar holds changed (an agent began, a save failed, a branch control came): every need is new.
      required.current = [];
      observeControls();
      rerun();
    });
    content.observe(bar, { childList: true, subtree: true, characterData: true });
    const compact = typeof window.matchMedia === 'function' ? window.matchMedia(COMPACT_QUERY) : null;
    compact?.addEventListener?.('change', rerun);
    // A web font arriving after the first paint widens every word without changing an element or the bar's width:
    // the needs measured with the fallback font no longer hold. (A ResizeObserver on the controls would hear the
    // fold's own steps too, and start over after each one.)
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    let live = true;
    const fontsChanged = () => {
      if (!live) return;
      required.current = [];
      rerun();
    };
    fonts?.addEventListener?.('loadingdone', fontsChanged);
    void fonts?.ready?.then(fontsChanged);
    // What changed before the observers were attached is measured now.
    required.current = [];
    measure();
    return () => {
      live = false;
      resize.disconnect();
      content.disconnect();
      compact?.removeEventListener?.('change', rerun);
      fonts?.removeEventListener?.('loadingdone', fontsChanged);
    };
  }, [ref, measure]);

  return level;
}
