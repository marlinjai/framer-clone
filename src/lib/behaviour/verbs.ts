// src/lib/behaviour/verbs.ts
//
// The actions that touch the page beyond state: focus, the native elements, media,
// scrolling, values and `filter`, and `navigate`. A chunk of its own beside the runtime,
// fetched only by a program that uses one, so a page of plain toggles stays at the core.
// See docs/plans/2026-11-02-behaviour-model.md, "Actions".
//
// The parser decides which of these may run from what. What only exists at run time is
// held here: a `showModal` no press asked for runs once per page load and closes on Escape
// whatever was stored, an address that leaves the site needs a live user activation, and
// a form's `reset` cannot be shadowed by a field of that name. It also holds the key rules
// of keys.ts, which no page without a key trigger needs.
//
// A stored mistake the browser refuses, such as `showModal` on a connected element that
// is already open, costs that verb alone: it warns, and the sequence goes on.
//
// PURE and client-safe: no React, no MST. The effects runtime is fetched when `effect` runs.

import type { Action } from './format';
import { closestTo, every, holds, isElement, isMatch, setAttr } from './dom';
import { leavesSite } from './keys';
import type { CreateVerbs, Kit, Run } from './program';

export { isTextEntry, keysAnswer } from './keys';

const PRESSES: ReadonlySet<string> = new Set(['click', 'keydown', 'keyup']);
const TARGETED = ['focus', 'dialog', 'popover', 'details', 'media', 'fullscreen', 'pictureInPicture', 'scroll', 'form', 'setProp', 'filter', 'effect'] as const;
const CONTROLS = 'a[href],button,input,select,textarea,summary,label,[role="button"],[role="link"],[contenteditable]';
const BOOLEAN_PROPS: readonly string[] = ['checked', 'disabled'];
const MAX_RATE = 16;
const MIN_RATE = 0.0625;

/** Documents where a `showModal` that no press asked for has run. Outlives a restart. */
const modalShown = new WeakSet<Document>();

export const createVerbs: CreateVerbs = (kit: Kit) => {
  /** What an item's inline `display` was before `filter` hid it. */
  const shownAs = new WeakMap<HTMLElement, string>();

  const refuse = (run: Run) => (error: unknown): void => {
    kit.warn(`the browser refused this: ${(error as Error).name}`, run.trigger.id);
  };

  const openModal = (dialog: HTMLDialogElement, run: Run): void => {
    if (dialog.open) return;
    // A press can open a modal any number of times. Nothing else opens one twice, so
    // no cycle through `close` can hold the page, and the consent banner, inert.
    if (!PRESSES.has(run.trigger.on)) {
      if (kit.surface === 'canvas' || modalShown.has(kit.doc)) return;
      modalShown.add(kit.doc);
      // Nobody asked for this one, so Escape always closes it, whatever was stored.
      setAttr(dialog, 'closedby', 'closerequest');
    }
    dialog.showModal();
  };

  const dialogVerb = (dialog: HTMLDialogElement, op: Extract<Action, { dialog: string }>['op'], run: Run): void => {
    if (op === 'showModal') openModal(dialog, run);
    else if (op === 'close' || (op === 'toggle' && dialog.open)) dialog.close();
    else if (!dialog.open) dialog.show();
  };

  const popoverVerb = (el: HTMLElement, op: Extract<Action, { popover: string }>['op']): void => {
    const open = isMatch(el, ':popover-open');
    if (op === 'toggle' ? open : op === 'hide') {
      if (open) el.hidePopover();
    } else if (!open) el.showPopover();
  };

  const mediaVerb = (media: HTMLMediaElement, action: Extract<Action, { media: string }>, run: Run): void => {
    const { op } = action;
    if (op === 'play') media.play().catch(refuse(run));
    else if (op === 'pause') media.pause();
    else if (op === 'load') media.load();
    else {
      const value = Number(kit.evaluate(action.value as never, run));
      if (!Number.isFinite(value)) return;
      if (op === 'seek') media.currentTime = value;
      else if (op === 'rate') media.playbackRate = Math.min(MAX_RATE, Math.max(MIN_RATE, value));
      else media.volume = Math.min(1, Math.max(0, value));
    }
  };

  const filterVerb = (list: Element, action: Extract<Action, { filter: string }>, run: Run): void => {
    const text = String(kit.evaluate(action.text, run) ?? '').toLowerCase();
    const items = every(list, `[role="${action.role}"]`);
    // Reading every item's text is what a page can stack up, so the page pays per item.
    if (!kit.charge(items.length)) return;
    for (const item of items) {
      if ((item.textContent ?? '').toLowerCase().includes(text)) {
        if (shownAs.has(item)) item.style.display = shownAs.get(item) as string;
        shownAs.delete(item);
      } else {
        if (!shownAs.has(item)) shownAs.set(item, item.style.display);
        item.style.display = 'none';
      }
    }
  };

  const setProp = (el: Element, action: Extract<Action, { setProp: string }>, run: Run): void => {
    const value = kit.evaluate(action.value, run);
    if (value === undefined || Number.isNaN(value)) return;
    (el as unknown as Record<string, unknown>)[action.prop] = BOOLEAN_PROPS.includes(action.prop) ? Boolean(value) : String(value);
  };

  /** Only a published page leaves: a preview or the editor must not be navigated away. */
  const navigate = (href: string, run: Run): void => {
    if (kit.surface !== 'published') return;
    // Where the browser cannot say a person just pressed, an outside address waits for nobody.
    if (leavesSite(href) && navigator.userActivation?.isActive !== true) {
      kit.warn('an address that leaves the site needs a press', run.trigger.id);
      return;
    }
    kit.doc.location.assign(href);
  };

  /** Captured, the press would never reach a control inside the node, so a press on one stays its own. */
  const capture = (run: Run): void => {
    const event = run.event as PointerEvent;
    const control = isElement(event.target) ? closestTo(event.target, CONTROLS) : null;
    if (!control || control === run.el || !holds(run.el, control)) run.el.setPointerCapture(event.pointerId);
  };

  const onTarget = (action: Action, target: Element, run: Run): void => {
    const el = target as HTMLElement;
    if ('focus' in action) el.focus();
    else if ('dialog' in action) dialogVerb(target as HTMLDialogElement, action.op, run);
    else if ('popover' in action) popoverVerb(el, action.op);
    else if ('details' in action) {
      const details = target as HTMLDetailsElement;
      details.open = action.op === 'toggle' ? !details.open : action.op === 'open';
    } else if ('media' in action) mediaVerb(target as HTMLMediaElement, action, run);
    else if ('fullscreen' in action) {
      if (action.op === 'enter') el.requestFullscreen().catch(refuse(run));
      else if (kit.doc.fullscreenElement) kit.doc.exitFullscreen().catch(refuse(run));
    } else if ('pictureInPicture' in action) {
      if (action.op === 'enter') (target as HTMLVideoElement).requestPictureInPicture().catch(refuse(run));
      else if (kit.doc.pictureInPictureElement) kit.doc.exitPictureInPicture().catch(refuse(run));
    } else if ('scroll' in action) el.scrollIntoView(action.block ? { block: action.block } : undefined);
    else if ('form' in action) HTMLFormElement.prototype.reset.call(target);
    else if ('setProp' in action) setProp(target, action, run);
    else if ('filter' in action) filterVerb(target, action, run);
    else if ('effect' in action) {
      import('@/lib/effects/runtime').then(({ prefersReducedMotion, reveal }) => reveal(target, !prefersReducedMotion()), refuse(run));
    }
  };

  return (action, run) => {
    kit.settle();
    try {
      if ('navigate' in action) navigate(action.navigate, run);
      else if ('capturePointer' in action) capture(run);
      else {
        const verb = TARGETED.find((name) => name in action);
        if (!verb) {
          kit.warn('this action does not run here', run.trigger.id);
          return;
        }
        const key = (action as unknown as Record<string, string>)[verb];
        const target = kit.find(key, run.el);
        if (target) onTarget(action, target, run);
        else kit.warn('no such node', key);
      }
    } catch (error) {
      refuse(run)(error);
    }
  };
};
