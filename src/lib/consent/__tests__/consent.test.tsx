// The consent gate on published pages (src/lib/consent/consent.ts and
// ConsentBanner.tsx): the banner markup is rendered like the server does, then
// the inline runtime is run as the browser would run it after parsing.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConsentBanner } from '../ConsentBanner';
import {
  CONSENT_BANNER_ID,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  consentCopy,
  consentRuntimeScript,
  parseStoredConsent,
} from '../consent';
import type { TrackerPayload } from '@/lib/renderer/publish/trackerSnippet';
import { DEFAULT_LOOK } from '@/lib/site/notFoundDefault';

const tracker: TrackerPayload = {
  variants: {},
  config: { key: 'ap_live_abc', endpoint: 'https://ingest.lumitra.co', projectId: 'proj_x' },
  src: 'https://cdn.lumitra.co/tracker.js',
};

type Win = Window & {
  __AP_CONFIG?: Record<string, unknown>;
  __AP_VARIANTS?: Record<string, string>;
  __lumitraConsent?: { open(): void; accept(): void; decline(): void; get(): string | null; version: number };
  LumitraAnalytics?: { enableTracking(): void };
};
const win = window as Win;

// The runtime listens on the document; every test runs it afresh, so the
// listeners of the previous run are removed after each test.
const added: Array<[string, EventListenerOrEventListenerObject]> = [];
const realAdd = document.addEventListener.bind(document);

beforeEach(() => {
  vi.spyOn(document, 'addEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    added.push([type, listener]);
    realAdd(type, listener, options);
  }) as typeof document.addEventListener);
});

afterEach(() => {
  for (const [type, listener] of added.splice(0)) document.removeEventListener(type, listener);
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.head.querySelectorAll('script[data-fc-tracker]').forEach((s) => s.remove());
  delete win.__AP_CONFIG;
  delete win.__AP_VARIANTS;
  delete win.__lumitraConsent;
  delete win.LumitraAnalytics;
  window.history.replaceState(null, '', '/');
});

/** Render the banner (plus a footer link) and run the runtime, as a page load. */
function load(language = 'de', footer = true) {
  const utils = render(
    <>
      <ConsentBanner tracker={tracker} language={language} look={DEFAULT_LOOK} privacyHref="/datenschutz" />
      <main><button type="button">Content</button></main>
      {footer ? <footer><a href="#cookie-settings">Cookie-Einstellungen</a></footer> : null}
    </>,
  );
  new Function(consentRuntimeScript({ tracker }))();
  return utils;
}

const banner = () => document.getElementById(CONSENT_BANNER_ID) as HTMLElement;
const trackerScripts = () => document.head.querySelectorAll('script[data-fc-tracker]');
const stored = () => JSON.parse(window.localStorage.getItem(CONSENT_STORAGE_KEY) ?? 'null');

describe('consent banner', () => {
  it('shows on a first visit and loads nothing before a choice', () => {
    load();
    expect(banner().hidden).toBe(false);
    expect(trackerScripts()).toHaveLength(0);
    expect(win.__AP_CONFIG).toBeUndefined();
    // Not modal and takes no focus on its own.
    expect(banner().getAttribute('role')).toBe('dialog');
    expect(banner().getAttribute('aria-modal')).toBe('false');
    expect(document.activeElement).not.toBe(banner());
  });

  it('is a labelled dialog with two equal-weight buttons', () => {
    load();
    const dialog = screen.getByRole('dialog', { name: 'Datenschutz-Einstellungen' });
    expect(dialog.getAttribute('aria-describedby')).toBe(`${CONSENT_BANNER_ID}-text`);
    const accept = screen.getByRole('button', { name: 'Akzeptieren' });
    const decline = screen.getByRole('button', { name: 'Ablehnen' });
    expect(accept.getAttribute('style')).toBe(decline.getAttribute('style'));
    expect(screen.getByRole('link', { name: 'Datenschutzerklärung' }).getAttribute('href')).toBe('/datenschutz');
  });

  it('accepting stores a versioned choice and loads the tracker', () => {
    load();
    fireEvent.click(screen.getByRole('button', { name: 'Akzeptieren' }));
    expect(banner().hidden).toBe(true);
    expect(stored()).toMatchObject({ v: CONSENT_VERSION, analytics: true });
    expect(typeof stored().at).toBe('string');
    const scripts = trackerScripts();
    expect(scripts).toHaveLength(1);
    expect((scripts[0] as HTMLScriptElement).src).toBe('https://cdn.lumitra.co/tracker.js');
    expect(win.__AP_CONFIG).toMatchObject({ key: 'ap_live_abc', projectId: 'proj_x', consent: { analytics: true } });
    expect(win.__AP_VARIANTS).toEqual({});
  });

  it('calls the loader enableTracking once it has loaded', () => {
    load();
    const enableTracking = vi.fn();
    win.LumitraAnalytics = { enableTracking };
    win.__lumitraConsent!.accept();
    trackerScripts()[0].dispatchEvent(new Event('load'));
    expect(enableTracking).toHaveBeenCalledTimes(1);
  });

  it('declining stores the choice and loads nothing at all', () => {
    load();
    fireEvent.click(screen.getByRole('button', { name: 'Ablehnen' }));
    expect(banner().hidden).toBe(true);
    expect(stored()).toMatchObject({ v: CONSENT_VERSION, analytics: false });
    expect(trackerScripts()).toHaveLength(0);
    expect(win.__AP_CONFIG).toBeUndefined();
    expect(win.__AP_VARIANTS).toBeUndefined();
  });

  it('remembers a yes on the next page: tracker loads at once, no banner', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: CONSENT_VERSION, analytics: true, at: 'x' }));
    load();
    expect(banner().hidden).toBe(true);
    expect(trackerScripts()).toHaveLength(1);
  });

  it('remembers a no on the next page: nothing loads, no banner', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: CONSENT_VERSION, analytics: false, at: 'x' }));
    load();
    expect(banner().hidden).toBe(true);
    expect(trackerScripts()).toHaveLength(0);
    expect(win.__AP_CONFIG).toBeUndefined();
  });

  it('asks again when the stored choice is for another version or unreadable', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: CONSENT_VERSION - 1, analytics: true, at: 'x' }));
    load();
    expect(banner().hidden).toBe(false);
    expect(trackerScripts()).toHaveLength(0);
  });

  it('reopens from the footer link with focus, and Escape closes it back to the link', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: CONSENT_VERSION, analytics: false, at: 'x' }));
    load();
    const link = screen.getByRole('link', { name: 'Cookie-Einstellungen' });
    link.focus();
    fireEvent.click(link);
    expect(banner().hidden).toBe(false);
    expect(document.activeElement).toBe(banner());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(banner().hidden).toBe(true);
    expect(document.activeElement).toBe(link);
  });

  it('opens programmatically through window.__lumitraConsent.open()', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: CONSENT_VERSION, analytics: true, at: 'x' }));
    load('de', false);
    expect(win.__lumitraConsent!.get()).toBe('granted');
    expect(win.__lumitraConsent!.version).toBe(CONSENT_VERSION);
    win.__lumitraConsent!.open();
    expect(banner().hidden).toBe(false);
  });

  it('Escape does not dismiss a first-visit banner without a choice', () => {
    load();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(banner().hidden).toBe(false);
  });

  it('opens when the page is visited at #cookie-settings', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: CONSENT_VERSION, analytics: false, at: 'x' }));
    window.history.replaceState(null, '', '/#cookie-settings');
    load();
    expect(banner().hidden).toBe(false);
  });

  it('revoking an earlier yes removes what the tracker stored', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: CONSENT_VERSION, analytics: true, at: 'x' }));
    window.sessionStorage.setItem('ap_session_id', 's1');
    window.sessionStorage.setItem('ap_exp_hero', 'b');
    window.sessionStorage.setItem('other', 'keep');
    // jsdom has no navigation: the reload the runtime asks for only logs.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    load();
    win.__lumitraConsent!.open();
    fireEvent.click(screen.getByRole('button', { name: 'Ablehnen' }));
    expect(stored()).toMatchObject({ analytics: false });
    expect(window.sessionStorage.getItem('ap_session_id')).toBeNull();
    expect(window.sessionStorage.getItem('ap_exp_hero')).toBeNull();
    expect(window.sessionStorage.getItem('other')).toBe('keep');
  });

  it('still works when storage throws (choice kept for this page view)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    load();
    expect(banner().hidden).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Akzeptieren' }));
    expect(trackerScripts()).toHaveLength(1);
    expect(win.__lumitraConsent!.get()).toBe('granted');
  });

  it('speaks English for non-German sites', () => {
    load('en');
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Privacy settings' })).toBeTruthy();
  });
});

describe('consent helpers', () => {
  it('parses only a valid choice of the current version', () => {
    expect(parseStoredConsent(null)).toBeNull();
    expect(parseStoredConsent('nope')).toBeNull();
    expect(parseStoredConsent(JSON.stringify({ v: CONSENT_VERSION, analytics: 'yes' }))).toBeNull();
    expect(parseStoredConsent(JSON.stringify({ v: 99, analytics: true }))).toBeNull();
    expect(parseStoredConsent(JSON.stringify({ v: CONSENT_VERSION, analytics: true }))).toBe('granted');
    expect(parseStoredConsent(JSON.stringify({ v: CONSENT_VERSION, analytics: false }))).toBe('denied');
  });

  it('picks German for de tags and English for everything else', () => {
    expect(consentCopy('de-AT').accept).toBe('Akzeptieren');
    expect(consentCopy('fr').accept).toBe('Accept');
  });

  it('never lets the tracker data close the script element', () => {
    const script = consentRuntimeScript({ tracker: { ...tracker, src: 'https://x.test/a.js?</script><b>' } });
    expect(script).not.toContain('</script>');
  });
});
