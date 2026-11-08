// src/lib/canvas/interactShim.ts
//
// What one canvas frame needs, in the Interact tool, so the page in it behaves as it does
// published while the editor stays where it is. See "Interact: the page runs, in the frame"
// in docs/plans/2026-11-02-behaviour-model.md.
//
//   - Ids across frames. Every frame renders the same ids, so `label for` resolves to the
//     first frame. A label pressed in another frame focuses and presses its own control.
//     The other two id references the plan names, `popovertarget` and `commandfor`, never
//     reach the canvas: the editor surfaces drop them (EDITOR_SURFACE_DROPPED in
//     src/lib/renderer/blockedNodes.ts), so nothing of a page can open over the editor's
//     panels by them. The runtime's own actions name nodes, not ids, inside its frame.
//   - Links. A same-document link (`#x`) keeps its default: the editor never reads the
//     hash. A link to a path of the site switches the editor to that page, as the preview
//     does. Any other web address opens in a new tab, so the editor is never navigated away.
//   - A form's submit is prevented, and the editor says why: nothing on the canvas sends.
//
// Links and forms are read in the bubble phase, after the page's own stored triggers have
// heard the event in capture, so a trigger that prevents the default is the page's word.
//
// No React, no MST.

import { submitMethod } from '@/lib/renderer/blockedNodes';
import { sitePathOfClick } from '@/lib/site/sitePath';

export interface InteractFrameHooks {
  /** A link to a path of the site was followed. */
  sitePath(path: string): void;
  /** Something the page asked for that the canvas does not do, and why. */
  refused(message: string): void;
}

/** Input types whose label press focuses them rather than pressing them. */
const TEXT_ENTRY = /^(?:text|search|email|url|tel|password|number|date|datetime-local|month|week|time|color)$/;

/** The element with this id inside the frame, or null. */
function inFrame(frame: Element, id: string): HTMLElement | null {
  for (const el of Array.from(frame.querySelectorAll('[id]'))) if (el.id === id) return el as HTMLElement;
  return null;
}

/** The element `id` names for something in this frame, when the document would find it in another one. */
function stray(frame: Element, id: string | null): HTMLElement | null {
  if (!id) return null;
  const found = frame.ownerDocument.getElementById(id);
  if (!found || frame.contains(found)) return null;
  return inFrame(frame, id);
}

/** A label press in this frame acts on the control of this frame. */
function retarget(frame: Element, event: MouseEvent): void {
  const start = event.target instanceof Element ? event.target : null;
  const label = start?.closest('label[for]') as HTMLLabelElement | null;
  if (!start || !label || !frame.contains(label)) return;
  const control = stray(frame, label.htmlFor);
  if (!control) return;
  // The browser would act on the other frame's control: this one does it here instead,
  // as the browser does for a label: focus, and a press on a control that is pressed.
  event.preventDefault();
  control.focus();
  const typed = (control instanceof HTMLInputElement && TEXT_ENTRY.test(control.type)) || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement;
  if (!typed) control.click();
}

/** A followed link, once the page had its say. */
function follow(event: MouseEvent, hooks: InteractFrameHooks): void {
  if (event.defaultPrevented || !(event.target instanceof Element)) return;
  const link = event.target.closest('a[href]') as HTMLAnchorElement | null;
  if (!link) return;
  const href = link.getAttribute('href') ?? '';
  if (href.startsWith('#')) return;
  const path = sitePathOfClick(event.target);
  if (path !== null) {
    event.preventDefault();
    hooks.sitePath(path);
    return;
  }
  let url: URL;
  try {
    url = new URL(href, link.ownerDocument.baseURI);
  } catch {
    event.preventDefault();
    hooks.refused(`This link has an address the browser cannot read: ${href}`);
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  // A new tab, whatever the link's target, so the editor stays where it is.
  event.preventDefault();
  link.ownerDocument.defaultView?.open(url.href, '_blank', 'noopener,noreferrer');
}

/** Starts the frame's handling. Returns what stops it. */
export function startInteractFrame(frame: HTMLElement, hooks: InteractFrameHooks): () => void {
  const onPress = (event: MouseEvent) => retarget(frame, event);
  const onClick = (event: MouseEvent) => follow(event, hooks);
  const onSubmit = (event: SubmitEvent) => {
    if (event.defaultPrevented) return;
    // A dialog form sends nothing: the browser closes its dialog, as on the published page.
    if (submitMethod(event) === 'dialog') return;
    event.preventDefault();
    hooks.refused('A form on the canvas does not send. Publish the page to send it.');
  };
  frame.addEventListener('click', onPress, true);
  frame.addEventListener('click', onClick);
  frame.addEventListener('submit', onSubmit);
  return () => {
    frame.removeEventListener('click', onPress, true);
    frame.removeEventListener('click', onClick);
    frame.removeEventListener('submit', onSubmit);
  };
}

/** What holds a page on the canvas: a breakpoint frame's content, or a floating element's. */
export const PAGE_CONTENT_SELECTOR = '[data-viewport-content-id],[data-floating-root-id]';

/** The page content `target` is in, or null when it is the canvas around the frames. */
export function pageContentOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest(PAGE_CONTENT_SELECTOR) : null;
}

const SCROLLS = /^(?:auto|scroll|overlay)$/;

/**
 * True when a wheel with these deltas would scroll something in the page under `target`.
 * A frame has no scroller of its own, so a wheel over the page pans the camera unless a
 * scroller in the page can still move that way.
 */
export function wheelScrollsPage(target: EventTarget | null, deltaX: number, deltaY: number): boolean {
  const content = pageContentOf(target);
  if (!content) return false;
  for (let el = target as Element | null; el && el !== content; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (deltaY !== 0 && SCROLLS.test(style.overflowY)) {
      const room = deltaY > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop;
      if (room > 0.5) return true;
    }
    if (deltaX !== 0 && SCROLLS.test(style.overflowX)) {
      const room = deltaX > 0 ? el.scrollWidth - el.clientWidth - el.scrollLeft : el.scrollLeft;
      if (room > 0.5) return true;
    }
  }
  return false;
}
