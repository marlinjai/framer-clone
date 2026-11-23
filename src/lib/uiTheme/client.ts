'use client';
// src/lib/uiTheme/client.ts: reading and switching the interface mode in the browser.
// The switch writes the cookie and the attribute together, so the page changes at once
// and the next page load (rendered by the server from the cookie) starts in the same mode.

import { useSyncExternalStore } from 'react';
import { parseUiTheme, uiThemeCookie, type UiThemePreference } from './index';

const listeners = new Set<() => void>();

function current(): UiThemePreference {
  return parseUiTheme(document.documentElement.getAttribute('data-ui-theme')) ?? 'system';
}

/** Apply a preference now (the attribute) and for later loads (the cookie). */
export function setUiTheme(preference: UiThemePreference): void {
  document.cookie = uiThemeCookie(preference, window.location.protocol === 'https:');
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-ui-theme');
  else root.setAttribute('data-ui-theme', preference);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The preference in effect: the attribute the server wrote or the last switch. */
export function useUiTheme(): UiThemePreference {
  // The server cannot know it in a client component; 'system' until hydration reads the attribute.
  return useSyncExternalStore(subscribe, current, () => 'system');
}
