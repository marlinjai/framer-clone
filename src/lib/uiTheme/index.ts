// src/lib/uiTheme/index.ts: the editor's interface mode preference (Light, Dark or System),
// docs/plans/2026-11-23-sites-home-and-light-mode.md, slice S2.
//
// Kept per browser in a host-only cookie (no Domain attribute), so it never reaches a
// published site on another host. The root layout reads it on the editor host only and
// writes `<html data-ui-theme>`; with no cookie the attribute is absent and the system
// setting decides through CSS (suite-theme's ui.css), live, with no script.

export const UI_THEME_COOKIE = 'lumitra_ui_theme';

/** A mode someone chose. System is the absence of a choice (no cookie, no attribute). */
export type UiTheme = 'light' | 'dark';
export type UiThemePreference = UiTheme | 'system';

export const UI_THEME_PREFERENCES: readonly UiThemePreference[] = ['system', 'light', 'dark'];

/** The chosen mode from a cookie value; anything else (absent, tampered) is System. */
export function parseUiTheme(value: string | undefined | null): UiTheme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

const YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * The `document.cookie` assignment for a preference: host-only (no Domain), the whole
 * path, a year for a choice, an immediate expiry for System. `secure` on https only, so
 * the local http dev server keeps it.
 */
export function uiThemeCookie(preference: UiThemePreference, secure: boolean): string {
  const tail = `; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
  return preference === 'system'
    ? `${UI_THEME_COOKIE}=; Max-Age=0${tail}`
    : `${UI_THEME_COOKIE}=${preference}; Max-Age=${YEAR_SECONDS}${tail}`;
}
