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
import { COMPACT_TOP_BAR_QUERY as COMPACT_QUERY } from '@/components/TopBarStatus';

export const MAX_FOLD = 3;
export type FoldLevel = 0 | 1 | 2 | 3;

/**
 * How much room to spare a level must leave before the bar unfolds to it from a remembered need. A word that
 * changes width (the save status, the history count, the agent chip) then never folds and unfolds the bar on
 * every edit at the one width where it just fits.
 */
export const UNFOLD_SLACK = 16;

/** Marks the More menu's trigger: where the focus goes when a fold hides the control that had it. */
export const MORE_TRIGGER_ATTR = 'data-topbar-more';

/**
 * The next level to try, from the width the bar has and the widths its content needed at the levels seen so far
 * (`required[level]`, unknown until that level was laid out once). Folds one step while the current level does
 * not fit; unfolds one step while the level before fits with UNFOLD_SLACK to spare, trying it once when its need
 * is not known yet. A known need never changes with the window's width (every control keeps its own width until
 * level 3), so the result settles and never swings between two levels.
 */
export function decideFoldLevel(level: FoldLevel, available: number, required: ReadonlyArray<number | undefined>): FoldLevel {
  const need = required[level];
  if (need !== undefined && need > available) return level < MAX_FOLD ? ((level + 1) as FoldLevel) : level;
  if (level === 0) return level;
  const before = required[level - 1];
  // The level before has not been laid out since the content last changed: try it; if it does not fit, the
  // next measure comes back here with its need known.
  if (before === undefined || before + UNFOLD_SLACK <= available) return (level - 1) as FoldLevel;
  return level;
}

/**
 * The settled level for `available`, given what each level needs: the fewest folds that fit, or the last level.
 * What the bar converges to through decideFoldLevel, one step per layout.
 */
export function foldLevelFor(available: number, required: ReadonlyArray<number>): FoldLevel {
  // As the bar gets there from no fold: a level that fits is taken, slack or not.
  for (let level = 0; level < MAX_FOLD; level++) if (required[level] <= available) return level as FoldLevel;
  return MAX_FOLD;
}

let measuringCanvas: HTMLCanvasElement | undefined;
/** The width `text` takes in `el`'s font; undefined where there is no canvas to measure with (a test's DOM). */
function textWidth(el: Element, text: string): number | undefined {
  measuringCanvas ??= document.createElement('canvas');
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = measuringCanvas.getContext('2d');
  } catch {
    return undefined;
  }
  if (!context) return undefined;
  const style = getComputedStyle(el);
  context.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return context.measureText(text).width;
}

/**
 * The width the bar's content needs as laid out now: its full scroll width (every control keeps its own width
 * until the last fold, so what does not fit overflows the bar), less the free room the stretching gap in the
 * middle (`[data-fold-gap]`) holds, plus the room a word that takes turns with a longer one would need for it
 * (`[data-fold-reserve="<the longer word>"]`: the save status's Saved, which Unsaved changes replaces on every
 * edit). The word itself is drawn at its own width; only the fold counts the longer one.
 */
export function measureRequired(bar: HTMLElement): number {
  let gap = 0;
  bar.querySelectorAll<HTMLElement>('[data-fold-gap]').forEach((el) => {
    gap += el.getBoundingClientRect().width;
  });
  let reserve = 0;
  bar.querySelectorAll<HTMLElement>('[data-fold-reserve]').forEach((el) => {
    if (el.getClientRects().length === 0) return;
    const longer = textWidth(el, el.getAttribute('data-fold-reserve') ?? '');
    if (longer !== undefined) reserve += Math.max(0, longer - el.getBoundingClientRect().width);
  });
  return bar.scrollWidth - gap + reserve;
}

/**
 * The needs after the level `at`, measured again, came out `delta` wider (or narrower) than remembered: what the
 * bar holds changed (an agent began, a save failed, a note went). The other levels get an estimate, measured when
 * the bar steps there. Growth moves them all alike: a level below that needs more than estimated is tried once
 * and refolds before paint, which nobody sees. Shrinking forgets the levels below instead: what went may have been
 * wider there (a note that is a sentence at level 0 and an icon at level 1), and an estimate that is too high would
 * keep the bar folded with room to spare.
 */
export function shiftNeeds(required: ReadonlyArray<number | undefined>, at: number, delta: number): (number | undefined)[] {
  return required.map((need, level) => {
    if (need === undefined) return undefined;
    if (delta < 0 && level < at) return undefined;
    return need + delta;
  });
}

/** Whether someone is using the bar: the focus is in it, or one of its menus or dropdowns is open. */
function inUse(bar: HTMLElement): boolean {
  return bar.contains(document.activeElement) || bar.querySelector('[aria-expanded="true"]') !== null;
}

/**
 * The fold level of the top bar `ref` points at. Measured in a layout effect after every render, on every change
 * of the bar's width (ResizeObserver), every change of what it holds (MutationObserver over its text and its
 * elements; folding itself only changes classes, so it never counts as a change of content), when a control
 * grows so that the bar overflows (ResizeObserver on each control), when web fonts finish loading, and when the
 * focus leaves the bar (it never unfolds under someone's hands). Each step is rendered synchronously before the
 * browser paints, so a person never sees a bar that does not fit.
 * Level 0 where there is no layout to measure (a test's DOM) or under 1024px.
 */
export function useTopBarFold(ref: React.RefObject<HTMLElement | null>): FoldLevel {
  const [level, setLevel] = React.useState<FoldLevel>(0);
  const [, setTick] = React.useState(0);
  const required = React.useRef<(number | undefined)[]>([]);
  const levelRef = React.useRef<FoldLevel>(0);
  // The level the last measure was taken at: measured again at the same level, a different need means the
  // content changed.
  const lastMeasured = React.useRef<FoldLevel | null>(null);
  // The bar's width at that measure: at the last level the names truncate with the width, so a change measured
  // there with another width is the window's, not the content's.
  const lastWidth = React.useRef(0);
  // The level just tried on the way up without a known need: kept only if it fits with UNFOLD_SLACK to spare, like
  // an unfold from a known need, so a word that grows and shrinks again never swings the bar.
  const trying = React.useRef<FoldLevel | null>(null);
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
    const at = levelRef.current;
    const need = measureRequired(bar);
    const before = required.current[at];
    const sameWidth = lastWidth.current === available;
    if (lastMeasured.current === at && sameWidth && before !== undefined && Math.abs(need - before) > 0.5) {
      required.current = shiftNeeds(required.current, at, need - before);
    }
    required.current[at] = need;
    lastMeasured.current = at;
    lastWidth.current = available;
    // What each level needs, as last measured or estimated: on the bar for a proof (and a person debugging) to
    // read. An attribute, so the bar's own MutationObserver does not hear it.
    bar.setAttribute('data-fold-needs', JSON.stringify(required.current.map((n) => (n === undefined ? null : Math.round(n)))));
    // A fold hid the control that had the focus: the focus goes to More, where that control is now.
    const focused = document.activeElement as HTMLElement | null;
    if (focused && focused !== document.body && bar.contains(focused) && focused.getClientRects().length === 0) {
      bar.querySelector<HTMLElement>(`[${MORE_TRIGGER_ATTR}]`)?.focus();
    }
    const tried = trying.current === at;
    trying.current = null;
    let next = decideFoldLevel(at, available, required.current);
    if (tried && next === at && need + UNFOLD_SLACK > available && at < MAX_FOLD) next = (at + 1) as FoldLevel;
    else if (next < at && required.current[next] === undefined) trying.current = next;
    // Never unfold under someone's hands (a focused control or an open menu would move or vanish); folding
    // cannot wait, or controls would overlap. The bar unfolds when the focus leaves it.
    if (next < at && inUse(bar)) return;
    if (next !== at) setLevel(next);
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
      // only an overflow counts, so the fold's own steps, which resize the controls too, never start it over. Rare,
      // so it waits a frame: folding inside this callback would resize the other controls in the same delivery.
      if (bar.scrollWidth > bar.clientWidth + 1) requestAnimationFrame(rerun);
    });
    resize.observe(bar);
    // The controls themselves, observed again whenever the bar's elements change (and let go when removed).
    const observed = new Set<Element>();
    const observeControls = () => {
      const now = new Set(Array.from(bar.children));
      for (const el of observed) if (!now.has(el)) resize.unobserve(el);
      for (const el of now) if (!observed.has(el)) resize.observe(el);
      observed.clear();
      for (const el of now) observed.add(el);
    };
    observeControls();
    const content = new MutationObserver(() => {
      // What the bar holds changed (an agent began, a save failed, a branch control came): measured again at the
      // current level, the other levels move with it (shiftNeeds).
      observeControls();
      rerun();
    });
    // aria-expanded too: a menu of the bar closing (by a click outside, which leaves the focus where it lands and
    // re-renders only the menu) is when an unfold held back for it applies. The fold itself never sets it.
    content.observe(bar, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-expanded'] });
    const compact = typeof window.matchMedia === 'function' ? window.matchMedia(COMPACT_QUERY) : null;
    compact?.addEventListener?.('change', rerun);
    // A web font arriving after the first paint widens every word without changing an element or the bar's width:
    // the needs measured with the fallback font no longer hold, and the words that fold widen too, so the needs
    // are forgotten rather than shifted.
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    let live = true;
    const fontsChanged = () => {
      if (!live) return;
      required.current = [];
      lastMeasured.current = null;
      rerun();
    };
    fonts?.addEventListener?.('loadingdone', fontsChanged);
    // The focus left the bar (or a menu of it closed and the focus moved on): an unfold that waited applies now.
    const focusLeft = () => requestAnimationFrame(() => live && rerun());
    bar.addEventListener('focusout', focusLeft);
    void fonts?.ready?.then(fontsChanged);
    // What changed before the observers were attached is measured now.
    required.current = [];
    lastMeasured.current = null;
    measure();
    return () => {
      live = false;
      bar.removeEventListener('focusout', focusLeft);
      resize.disconnect();
      content.disconnect();
      compact?.removeEventListener?.('change', rerun);
      fonts?.removeEventListener?.('loadingdone', fontsChanged);
    };
  }, [ref, measure]);

  return level;
}
