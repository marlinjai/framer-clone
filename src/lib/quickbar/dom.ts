// src/lib/quickbar/dom.ts
//
// The DOM side of the phone quick toolbar and long-press menu: where the
// selected element is on screen, its computed style, the visible area between
// the bars, and starting inline text editing from a button. The lookups are
// the ones HudSurface uses, so the toolbar anchors to exactly the element the
// selection outline is drawn around.
import type { ComponentInstance } from '@/models/ComponentModel';
import type { EditorUIType } from '@/stores/EditorUIStore';
import { visibleRectInFrame } from '@/lib/canvas/viewportFrame';
import { startInlineTextEdit } from '@/lib/canvas/inlineTextEdit';
import type { ComputedReader } from './actions';
import type { ScreenRect, VisibleArea } from './placement';

/**
 * The rendered element of a component: in the frame it was selected in for a
 * tree node, the ground wrapper for a floating element. Null when it has no
 * frame context (nothing to anchor to) or is not rendered.
 */
export function elementFor(component: ComponentInstance, breakpointId: string | undefined): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (component.isFloatingElement) return document.getElementById(`ground-wrapper-${component.id}`);
  if (!breakpointId) return null;
  return document.querySelector<HTMLElement>(`[data-component-id="${breakpointId}-${component.id}"]`);
}

/** The element's on-screen rect, clipped to its frame (null when clipped away or missing). */
export function screenRectFor(component: ComponentInstance, breakpointId: string | undefined): ScreenRect | null {
  const el = elementFor(component, breakpointId);
  if (!el) return null;
  if (component.isFloatingElement) {
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
  }
  const r = visibleRectInFrame(el);
  return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
}

/** A reader of the element's computed style; kebab-case property names. */
export function computedReaderFor(el: Element | null | undefined): ComputedReader | undefined {
  if (!el || typeof window === 'undefined') return undefined;
  let cached: CSSStyleDeclaration | null = null;
  return (property: string) => {
    try {
      cached ??= window.getComputedStyle(el);
      const value = cached.getPropertyValue(property);
      return value === '' ? undefined : value;
    } catch {
      return undefined;
    }
  };
}

/**
 * The area the floating controls may use: below the top bar, above the
 * bottom bar and the on-screen keyboard.
 */
export function measureVisibleArea(keyboardInset: number): VisibleArea {
  const topBar = document.querySelector<HTMLElement>('[data-editor-topbar]')?.getBoundingClientRect().bottom ?? 0;
  const bar = document.querySelector<HTMLElement>('[data-testid="phone-bottom-bar"]');
  // A hidden bar (inline text editing hides it) covers nothing.
  const barRect = bar && !bar.hidden ? bar.getBoundingClientRect() : null;
  const barTop = barRect && barRect.height > 0 ? barRect.top : window.innerHeight;
  const keyboardTop = window.innerHeight - Math.max(0, keyboardInset);
  return { width: window.innerWidth, top: topBar, bottom: Math.min(barTop, keyboardTop) };
}

/**
 * Start inline text editing of `component` from a button press or a menu
 * item: the canvas's own synchronous entry point (src/lib/canvas/inlineTextEdit.ts,
 * the one its touchend double-tap uses) makes the element editable, focuses
 * it and puts the caret at the end inside this call, then the store is told.
 * Call it from a click or touchend handler: iOS opens the keyboard only for a
 * focus inside one of those. Returns false when the element is not on screen.
 */
export function beginInlineTextEdit(editorUI: EditorUIType, component: ComponentInstance): boolean {
  const breakpointId = editorUI.selectedViewportNode?.breakpointId;
  const el = elementFor(component, breakpointId);
  if (!el) return false;
  startInlineTextEdit(el, 'end');
  editorUI.beginTextEdit(component);
  return true;
}
