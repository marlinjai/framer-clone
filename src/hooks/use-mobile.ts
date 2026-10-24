// src/hooks/use-mobile.ts
//
// Media query hooks for the editor's responsive layout (plan
// docs/plans/2026-10-24-editor-on-phones.md).
//
// A "phone" is a viewport under 768px wide (Tailwind's `md` edge), or a phone
// held sideways: a touch screen (coarse pointer) at most 500px high. The same
// query is the `phone:` Tailwind variant in src/app/globals.css, so CSS that
// hides the docked panels before hydration and the hook that switches the
// layout after it always agree (a test keeps the two strings identical).
//
// The server, and the first client render during hydration, report `false`
// (desktop): `useSyncExternalStore` then re-renders with the real value.
import * as React from 'react';

export const PHONE_MEDIA_QUERY = '(max-width: 767.98px), (max-height: 500px) and (pointer: coarse)';

function getMediaQueryList(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(query);
}

/** Whether `query` matches now, updated when it starts or stops matching. */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const mql = getMediaQueryList(query);
      if (!mql) return () => {};
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = React.useCallback(() => getMediaQueryList(query)?.matches ?? false, [query]);
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** True on a phone sized viewport: the editor shows its canvas-first layout with sheets. */
export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_MEDIA_QUERY);
}

/** One-off read for event handlers and timers (not reactive). */
export function matchesPhone(): boolean {
  return getMediaQueryList(PHONE_MEDIA_QUERY)?.matches ?? false;
}
