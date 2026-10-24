// The media query hook behind the editor's phone layout: matchMedia is mocked
// (jsdom has none), and the CSS `phone:` variant must use the same queries.
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { PHONE_MEDIA_QUERIES, PHONE_MEDIA_QUERY, matchesPhone, useIsPhone, useMediaQuery } from '../use-mobile';

type Listener = () => void;

function mockMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<Listener>();
  const queries: string[] = [];
  const matchMedia = vi.fn((query: string) => {
    queries.push(query);
    return {
      get matches() {
        return matches;
      },
      media: query,
      addEventListener: (_: string, l: Listener) => listeners.add(l),
      removeEventListener: (_: string, l: Listener) => listeners.delete(l),
    } as unknown as MediaQueryList;
  });
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: matchMedia });
  return {
    queries,
    listeners,
    set(next: boolean) {
      matches = next;
      listeners.forEach((l) => l());
    },
  };
}

function Probe() {
  return <span data-testid="phone">{String(useIsPhone())}</span>;
}

afterEach(() => {
  cleanup();
  // jsdom has no matchMedia: put it back the way the other suites expect.
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('useIsPhone', () => {
  it('reports the current match and asks for the phone query', () => {
    const mm = mockMatchMedia(true);
    render(<Probe />);
    expect(screen.getByTestId('phone').textContent).toBe('true');
    expect(mm.queries).toContain(PHONE_MEDIA_QUERY);
  });

  it('follows the query when it starts or stops matching, and unsubscribes on unmount', () => {
    const mm = mockMatchMedia(false);
    const { unmount } = render(<Probe />);
    expect(screen.getByTestId('phone').textContent).toBe('false');
    act(() => mm.set(true));
    expect(screen.getByTestId('phone').textContent).toBe('true');
    act(() => mm.set(false));
    expect(screen.getByTestId('phone').textContent).toBe('false');
    unmount();
    expect(mm.listeners.size).toBe(0);
  });

  it('is false where matchMedia does not exist (server, old jsdom)', () => {
    delete (window as { matchMedia?: unknown }).matchMedia;
    render(<Probe />);
    expect(screen.getByTestId('phone').textContent).toBe('false');
    expect(matchesPhone()).toBe(false);
  });

  it('useMediaQuery takes any query', () => {
    const mm = mockMatchMedia(true);
    function Q() {
      return <span data-testid="q">{String(useMediaQuery('(min-width: 1px)'))}</span>;
    }
    render(<Q />);
    expect(screen.getByTestId('q').textContent).toBe('true');
    expect(mm.queries).toContain('(min-width: 1px)');
  });
});

describe('the phone: CSS variant', () => {
  it('uses exactly the two queries the hook uses', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8');
    const block = css.slice(css.indexOf('@custom-variant phone'));
    for (const q of PHONE_MEDIA_QUERIES) expect(block).toContain(`@media ${q}`);
    expect(PHONE_MEDIA_QUERY).toBe(PHONE_MEDIA_QUERIES.join(', '));
  });
});
