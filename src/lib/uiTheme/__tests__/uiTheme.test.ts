import { describe, expect, it } from 'vitest';
import { parseUiTheme, uiThemeCookie, UI_THEME_COOKIE } from '../index';

describe('parseUiTheme', () => {
  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
    [undefined, null],
    [null, null],
    ['', null],
    ['system', null],
    ['Light', null],
    ['dark; Domain=evil', null],
  ] as const)('%s gives %s', (value, expected) => {
    expect(parseUiTheme(value)).toBe(expected);
  });
});

describe('uiThemeCookie', () => {
  it('keeps a choice a year, host-only (no Domain), on every path', () => {
    const cookie = uiThemeCookie('light', true);
    expect(cookie).toBe(`${UI_THEME_COOKIE}=light; Max-Age=31536000; Path=/; SameSite=Lax; Secure`);
    expect(cookie).not.toMatch(/domain/i);
  });

  it('System removes the cookie, and plain http (the local server) drops Secure', () => {
    expect(uiThemeCookie('system', false)).toBe(`${UI_THEME_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`);
  });
});
