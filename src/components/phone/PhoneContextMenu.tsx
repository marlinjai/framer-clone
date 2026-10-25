// src/components/phone/PhoneContextMenu.tsx
//
// The phone editor's long-press menu (plan docs/plans/2026-10-24-editor-on-phones.md,
// section "Quick toolbar"), in the manner of iOS context menus: holding a
// finger still on an element selects it (Canvas.tsx recognises the press and
// opens this through editorUI.openPhoneContextMenu), the rest of the screen
// dims and blurs while the element stays sharp and lifted by an outline, and a
// compact glass menu opens next to the finger.
//
// Items per element (src/lib/quickbar/actions.ts contextMenuItemsFor): Select
// parent, Select child (containers), Edit text (text), Duplicate, Copy style,
// Paste style (once a style was copied), Delete. Picking one runs it and
// closes the menu; a tap outside or Escape closes it. The menu is a second
// way in: the quick toolbar stays.
//
// Slide-to-select, as in iOS: the finger that long-pressed may stay down and
// slide over the items. The finger's events still go to the canvas element it
// pressed (implicit pointer capture), so Canvas.tsx forwards its moves and
// its release here (slideMenuMove, slideMenuRelease): the item under the
// finger highlights, a selection tick plays once per item change, and lifting
// on an item runs it. Lifting anywhere else leaves the menu open for a normal
// tap. The release is taken from touchend where the browser sends touch
// events (the menu listens for it while open), not from pointerup: iOS opens
// the keyboard for "Edit text" only from a focus inside touchend or click.
// A contact without touch events (a pen on Windows) releases from Canvas's
// pointerup instead.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { ArrowUp, ClipboardCopy, ClipboardPaste, Copy, CornerDownRight, PencilLine, Trash2 } from 'lucide-react';
import type { EditorUIType } from '@/stores/EditorUIStore';
import { getHistoryStore } from '@/stores/RootStore';
import { duplicateLayer } from '@/lib/layers/layerActions';
import { deleteSelection } from '@/lib/canvas/deleteSelection';
import { haptic, resetSelectionTick, selectionTick } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { placeMenuAtPoint } from '@/lib/quickbar/placement';
import {
  contextMenuItemsFor,
  copyStyle,
  firstChildOf,
  parentOf,
  pasteStyle,
  selectInSameFrame,
  type ContextMenuItem,
} from '@/lib/quickbar/actions';
import { beginInlineTextEdit, measureVisibleArea, screenRectFor } from '@/lib/quickbar/dom';

const ITEM_META: Record<ContextMenuItem, { label: string; icon: React.ReactNode; destructive?: boolean }> = {
  selectParent: { label: 'Select parent', icon: <ArrowUp size={17} /> },
  selectChild: { label: 'Select child', icon: <CornerDownRight size={17} /> },
  editText: { label: 'Edit text', icon: <PencilLine size={17} /> },
  duplicate: { label: 'Duplicate', icon: <Copy size={17} /> },
  copyStyle: { label: 'Copy style', icon: <ClipboardCopy size={17} /> },
  pasteStyle: { label: 'Paste style', icon: <ClipboardPaste size={17} /> },
  delete: { label: 'Delete', icon: <Trash2 size={17} />, destructive: true },
};

/** The scrim's clip path: the whole screen with a hole where the element is (even-odd fill). */
export function scrimClipPath(w: number, h: number, r: { left: number; top: number; width: number; height: number } | null): string | undefined {
  if (!r) return undefined;
  const x1 = Math.max(0, r.left - 4);
  const y1 = Math.max(0, r.top - 4);
  const x2 = Math.min(w, r.left + r.width + 4);
  const y2 = Math.min(h, r.top + r.height + 4);
  return `polygon(evenodd, 0 0, ${w}px 0, ${w}px ${h}px, 0 ${h}px, 0 0, ${x1}px ${y1}px, ${x2}px ${y1}px, ${x2}px ${y2}px, ${x1}px ${y2}px, ${x1}px ${y1}px)`;
}

/** The menu item element at a screen point, or null. */
export function menuItemElementAt(x: number, y: number): HTMLElement | null {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null;
  const hit = document.elementFromPoint(x, y);
  return hit instanceof Element ? hit.closest<HTMLElement>('[data-testid="phone-context-menu"] [data-menu-item]') : null;
}

/**
 * The long-press finger moved while the menu is open: highlight the item
 * under it (none off the menu) and tick once when that item changes.
 */
export function slideMenuMove(editorUI: EditorUIType, x: number, y: number): void {
  if (!editorUI.phoneContextMenu) return;
  const item = menuItemElementAt(x, y)?.dataset.menuItem;
  if (item !== editorUI.phoneContextMenuHover) {
    editorUI.setPhoneContextMenuHover(item);
    selectionTick(item ?? null);
  }
}

/**
 * The long-press finger lifted: on an item, run it (this runs inside the
 * pointerup, so it is a real user gesture); anywhere else, keep the menu open
 * for a tap. Returns true when an item ran.
 */
export function slideMenuRelease(editorUI: EditorUIType, x: number, y: number): boolean {
  if (!editorUI.phoneContextMenu) return false;
  const el = menuItemElementAt(x, y);
  editorUI.setPhoneContextMenuHover(undefined);
  resetSelectionTick();
  if (!el) return false;
  el.click();
  return true;
}

const PhoneContextMenu = observer(({ editorUI }: { editorUI: EditorUIType }) => {
  const point = editorUI.phoneContextMenu;
  const component = editorUI.selectedComponent;
  const page = editorUI.currentPage;
  const breakpointId = editorUI.selectedViewportNode?.breakpointId;
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [shown, setShown] = React.useState(false);
  const open = !!point && !!component && !!page;

  const close = React.useCallback(() => editorUI.closePhoneContextMenu(), [editorUI]);

  // The element went away (undo, a collaborator): nothing to act on.
  React.useEffect(() => {
    if (point && (!component || !page)) close();
  }, [point, component, page, close]);

  // Place the menu next to the finger once it has a size, then fade it in
  // (the first frame is invisible, so the measured placement never jumps).
  React.useLayoutEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    const menu = menuRef.current;
    if (!menu || !point) return;
    const area = measureVisibleArea(0);
    const placed = placeMenuAtPoint(point, { width: menu.offsetWidth, height: menu.offsetHeight }, area);
    menu.style.left = `${Math.round(placed.left)}px`;
    menu.style.top = `${Math.round(placed.top)}px`;
    const raf = requestAnimationFrame(() => setShown(true));
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    return () => cancelAnimationFrame(raf);
  }, [open, point]);

  // Slide-to-select release, and any tap on an item, from touchend (see the
  // header). Cancelling the touchend's default stops the emulated click, so
  // an item never runs twice.
  React.useEffect(() => {
    if (!open) return;
    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!t || e.touches.length > 0) return;
      if (slideMenuRelease(editorUI, t.clientX, t.clientY) && e.cancelable) e.preventDefault();
    };
    window.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    return () => window.removeEventListener('touchend', onTouchEnd, { capture: true });
  }, [open, editorUI]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
        next?.focus();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  if (!open || !component || !page || !point) return null;

  const history = getHistoryStore();
  const items = contextMenuItemsFor(component, page, !!editorUI.copiedStyle && Object.keys(editorUI.copiedStyle).length > 0);
  const rect = screenRectFor(component, breakpointId);
  const w = typeof window !== 'undefined' ? window.innerWidth : 0;
  const h = typeof window !== 'undefined' ? window.innerHeight : 0;

  const run = (item: ContextMenuItem) => {
    close();
    switch (item) {
      case 'selectParent': {
        const parent = parentOf(component, page);
        if (parent) {
          selectInSameFrame(editorUI, parent);
          haptic();
        }
        return;
      }
      case 'selectChild': {
        const child = firstChildOf(component);
        if (child) {
          selectInSameFrame(editorUI, child);
          haptic();
        }
        return;
      }
      case 'editText':
        beginInlineTextEdit(editorUI, component);
        return;
      case 'duplicate':
        duplicateLayer(page, editorUI, history);
        return;
      case 'copyStyle':
        editorUI.setCopiedStyle(copyStyle(component, breakpointId));
        return;
      case 'pasteStyle':
        if (editorUI.copiedStyle) pasteStyle(component, breakpointId, editorUI.copiedStyle, history);
        return;
      case 'delete':
        deleteSelection(page, editorUI, history);
        return;
    }
  };

  return (
    <div data-editor-ui="true" data-testid="phone-context-menu" className="fixed inset-0 z-[1050]">
      {/* The scrim: dims and blurs everything except the pressed element. A tap on it closes. */}
      <div
        data-testid="phone-context-menu-scrim"
        className="glass-scrim float-enter absolute inset-0"
        data-shown={shown ? 'true' : 'false'}
        style={{ clipPath: scrimClipPath(w, h, rect) }}
        // A click, not a pointerdown: the whole tap lands on the scrim, so
        // nothing on the canvas underneath sees it.
        onClick={close}
      />
      {/* The lift: an outline and shadow around the element (no layout change). */}
      {rect && (
        <div
          aria-hidden
          className="float-enter pointer-events-none absolute rounded-md ring-2 ring-brand"
          data-shown={shown ? 'true' : 'false'}
          style={{
            left: rect.left - 4,
            top: rect.top - 4,
            width: rect.width + 8,
            height: rect.height + 8,
            boxShadow: '0 10px 30px rgb(0 0 0 / 0.35)',
            transform: shown ? 'scale(1)' : 'scale(0.98)',
          }}
        />
      )}
      <div
        ref={menuRef}
        role="menu"
        aria-label={`Actions for ${component.displayName}`}
        className="glass-surface float-enter absolute min-w-[200px] overflow-hidden rounded-xl py-1"
        data-shown={shown ? 'true' : 'false'}
        style={{ transform: shown ? 'scale(1)' : 'scale(0.96)', transformOrigin: 'top left' }}
      >
        <div className="truncate px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {component.displayName}
        </div>
        {items.map((item, i) => {
          const meta = ITEM_META[item];
          return (
            <React.Fragment key={item}>
              {meta.destructive && i > 0 && <div role="separator" className="my-1 h-px bg-foreground/10" />}
              <button
                type="button"
                role="menuitem"
                data-menu-item={item}
                data-highlighted={editorUI.phoneContextMenuHover === item ? 'true' : undefined}
                onClick={() => run(item)}
                className={cn(
                  'flex h-11 w-full items-center gap-3 px-3 text-left text-[15px] hover:bg-foreground/8 focus-visible:bg-foreground/8 focus-visible:outline-none data-[highlighted=true]:bg-foreground/12',
                  meta.destructive && 'text-red-600 dark:text-red-400',
                )}
              >
                <span className="flex-1">{meta.label}</span>
                {meta.icon}
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
});

PhoneContextMenu.displayName = 'PhoneContextMenu';
export default PhoneContextMenu;
