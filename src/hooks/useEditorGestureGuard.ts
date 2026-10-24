// src/hooks/useEditorGestureGuard.ts
//
// The editor is a design tool with its own zoom (pinch on the canvas, the
// zoom buttons). While it is mounted, the browser's PAGE zoom must not fight
// it: a pinch on a sidebar, a sheet, the top bar or a dialog would otherwise
// scale the whole editor chrome, and on iOS a pinch that strays off the
// canvas zooms the page under the user's fingers. This hook, mounted once by
// EditorApp (so only the editor routes, never published sites under
// src/app/(site) or the projects list), does three things:
//
//   1. `touch-action: pan-x pan-y` on the document root: one-finger scrolling
//      in panels and sheets keeps working, pinch and double-tap zoom do not.
//      The canvas ground sets `touch-action: none` and runs its own gestures.
//   2. Prevents what touch-action does not reach: Safari's `gesturestart` /
//      `gesturechange` (iOS pinch), a multi-finger `touchmove` outside the
//      canvas, and ctrl/cmd+wheel (a trackpad pinch) outside the canvas.
//   3. Stamps `data-pointer` on the root with the last input type (`touch`,
//      `pen` or `mouse`, seeded from the `(pointer: coarse)` media query), so
//      canvas handles can grow 44px hit areas for fingers only; a pen keeps
//      the precise small ones.
//
// Accessibility trade-off (docs/plans/2026-10-24-editor-on-phones.md): inside
// the editor, browser page zoom by pinch is off; the canvas zoom replaces it
// for the design, and the editor chrome is sized for touch. Keyboard zoom
// (Cmd/Ctrl +) and the system's text size settings still work, and the
// viewport meta tag is unchanged, so published sites keep normal zoom.
'use client';
import { useEffect } from 'react';

/** True when the event target is inside the canvas ground. */
function onCanvas(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('[data-ground]');
}

const pointerTypeListeners = new Set<() => void>();

/** Subscribe to the touch/mouse modality flipping; returns the unsubscribe. */
export function onPointerModalityChange(listener: () => void): () => void {
  pointerTypeListeners.add(listener);
  return () => {
    pointerTypeListeners.delete(listener);
  };
}

export function useEditorGestureGuard(): void {
  useEffect(() => {
    const root = document.documentElement;
    const prevTouchAction = root.style.touchAction;
    const prevPointer = root.getAttribute('data-pointer');
    root.style.touchAction = 'pan-x pan-y';

    let coarse = false;
    try {
      coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    } catch {
      coarse = false;
    }
    root.setAttribute('data-pointer', coarse ? 'touch' : 'mouse');

    const onPointerDown = (e: PointerEvent) => {
      const type = e.pointerType === 'touch' || e.pointerType === 'pen' ? e.pointerType : 'mouse';
      if (root.getAttribute('data-pointer') === type) return;
      const wasTouch = lastPointerIsTouch();
      root.setAttribute('data-pointer', type);
      if (wasTouch !== lastPointerIsTouch()) pointerTypeListeners.forEach(l => l());
    };
    const preventGesture = (e: Event) => e.preventDefault();
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 1 && !onCanvas(e.target)) e.preventDefault();
    };
    const onWheel = (e: WheelEvent) => {
      if ((e.ctrlKey || e.metaKey) && !onCanvas(e.target)) e.preventDefault();
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('gesturestart', preventGesture, { passive: false });
    document.addEventListener('gesturechange', preventGesture, { passive: false });
    document.addEventListener('gestureend', preventGesture, { passive: false });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('gesturechange', preventGesture);
      document.removeEventListener('gestureend', preventGesture);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('wheel', onWheel);
      root.style.touchAction = prevTouchAction;
      if (prevPointer === null) root.removeAttribute('data-pointer');
      else root.setAttribute('data-pointer', prevPointer);
    };
  }, []);
}

/** The last input type the editor saw, for code that sizes hit areas. */
export function lastPointerIsTouch(): boolean {
  return typeof document !== 'undefined' && document.documentElement.getAttribute('data-pointer') === 'touch';
}
