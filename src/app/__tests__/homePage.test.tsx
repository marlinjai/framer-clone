// src/app/__tests__/homePage.test.tsx
//
// `/` on the editor host (docs/plans/2026-11-23-sites-home-and-light-mode.md, section 2):
// the demo editor when the address asks for it, the projects for a signed-in visitor, the
// welcome page for everyone else, never the login.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The page links the editor's stylesheets; the test only reads markup.
vi.mock('../globals.css', () => ({}));
vi.mock('../cms-grid-theme.css', () => ({}));
vi.mock('@marlinjai/data-table-react/dist/styles/variables.css', () => ({}));
vi.mock('@marlinjai/data-table-react/dist/styles/base.css', () => ({}));

const mockLoadHomeEntry = vi.fn();
vi.mock('../projects/loader', () => ({ loadHomeEntry: () => mockLoadHomeEntry() }));
vi.mock('../DemoEditor', () => ({ default: () => <div data-testid="demo-editor" /> }));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(url);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

import Page, { generateMetadata } from '../page';

const LOGIN = 'https://auth.lumitra.co/login?return_to=https%3A%2F%2Fapp.lumitra.co%2Fprojects';

async function run(query: Record<string, string>) {
  try {
    const element = await Page({ searchParams: Promise.resolve(query) });
    return { redirect: null, html: renderToStaticMarkup(element as React.ReactElement) };
  } catch (err) {
    if (err instanceof RedirectSignal) return { redirect: err.url, html: '' };
    throw err;
  }
}

beforeEach(() => {
  mockLoadHomeEntry.mockReset();
});

describe('the home at /', () => {
  it.each([[{ demo: '1' }], [{ page: 'p1' }], [{ preview: '1' }]])(
    'opens the demo editor for %j without reading the session, signed in or not',
    async (query) => {
      const result = await run(query);
      expect(result.html).toContain('data-testid="demo-editor"');
      expect(mockLoadHomeEntry).not.toHaveBeenCalled();
    },
  );

  it('sends a signed-in visitor on to the projects', async () => {
    mockLoadHomeEntry.mockResolvedValue({ status: 'signed_in' });
    expect((await run({})).redirect).toBe('/projects');
  });

  it('shows a signed-out visitor the welcome: the demo with no account, and sign in', async () => {
    mockLoadHomeEntry.mockResolvedValue({ status: 'signed_out', loginUrl: LOGIN });
    const result = await run({});
    expect(result.redirect).toBeNull();
    expect(result.html).toContain('Build and run your website in one place.');
    expect(result.html).toContain('href="/?demo=1"');
    expect(result.html).toContain(`href="${LOGIN.replace(/&/g, '&amp;')}"`);
    expect(result.html).not.toContain('not answering');
  });

  it('auth-brain down: still the welcome (never an error, never the login), with a note', async () => {
    mockLoadHomeEntry.mockResolvedValue({ status: 'auth_unavailable', loginUrl: LOGIN });
    const result = await run({});
    expect(result.redirect).toBeNull();
    expect(result.html).toContain('href="/?demo=1"');
    expect(result.html).toContain('Sign-in is not answering right now');
  });

  it('names the page for what it shows', async () => {
    expect((await generateMetadata({ searchParams: Promise.resolve({}) })).title).toBe('Lumitra Sites');
    expect((await generateMetadata({ searchParams: Promise.resolve({ demo: '1' }) })).title).toBe('Demo editor | Lumitra Sites');
  });
});
