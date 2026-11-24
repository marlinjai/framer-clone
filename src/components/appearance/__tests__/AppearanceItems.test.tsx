// The interface mode switch (docs/plans/2026-11-23-sites-home-and-light-mode.md, S2), the four
// paths of the stateful-flow standard where a unit test can hold them: forward (Light applies
// at once and is kept), backtrack (System removes both), resume (the attribute the server wrote
// is read back as the choice), re-entry (a second switch after System works the same).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import AppearanceMenu from '../AppearanceMenu';

const cookieWrites: string[] = [];
beforeEach(() => {
  cookieWrites.length = 0;
  Object.defineProperty(document, 'cookie', { configurable: true, get: () => '', set: (v: string) => void cookieWrites.push(v) });
  document.documentElement.removeAttribute('data-ui-theme');
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-ui-theme');
});

const open = () => {
  act(() => {
    fireEvent.keyDown(screen.getByRole('button', { name: 'Appearance' }), { key: 'Enter' });
  });
  return screen.getByRole('menu');
};
const checked = (menu: HTMLElement) =>
  within(menu).getAllByRole('menuitemradio').filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.textContent?.trim());

describe('Appearance', () => {
  it('offers System, Light and Dark, with System chosen when the server wrote no attribute', () => {
    render(<AppearanceMenu />);
    const menu = open();
    expect(within(menu).getByText('Appearance (this browser)')).toBeTruthy();
    expect(within(menu).getAllByRole('menuitemradio').map((el) => el.textContent?.trim())).toEqual(['System', 'Light', 'Dark']);
    expect(checked(menu)).toEqual(['System']);
  });

  it('Light applies at once, is kept in the cookie, and the menu stays open', () => {
    render(<AppearanceMenu />);
    const menu = open();
    act(() => {
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Light' }));
    });
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('light');
    expect(cookieWrites.at(-1)).toMatch(/^lumitra_ui_theme=light; Max-Age=31536000; Path=\/; SameSite=Lax$/);
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(checked(screen.getByRole('menu'))).toEqual(['Light']);
  });

  it('System afterwards removes the attribute and the cookie, and a new choice works again', () => {
    render(<AppearanceMenu />);
    const menu = open();
    act(() => {
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Dark' }));
    });
    act(() => {
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'System' }));
    });
    expect(document.documentElement.hasAttribute('data-ui-theme')).toBe(false);
    expect(cookieWrites.at(-1)).toMatch(/^lumitra_ui_theme=; Max-Age=0;/);
    act(() => {
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Light' }));
    });
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('light');
  });

  it('reads the mode the server wrote into the page as the choice (a reload, a new tab)', () => {
    document.documentElement.setAttribute('data-ui-theme', 'dark');
    render(<AppearanceMenu />);
    expect(checked(open())).toEqual(['Dark']);
  });
});
