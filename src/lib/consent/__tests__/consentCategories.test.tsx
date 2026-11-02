// The consent runtime's categories (src/lib/consent/consent.ts): one choice per
// purpose, only the banner's own buttons answer, a map's "Load map" only opens the
// banner on the maps question, and a "yes" given on one page can be withdrawn on any
// page of the site, where Decline all answers every category.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConsentBanner } from '../ConsentBanner';
import {
  CONSENT_BANNER_ID,
  CONSENT_MAPS_COOKIE,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  consentCopy,
  consentRuntimeScript,
  parseStoredConsent,
  type ConsentCategory,
} from '../consent';
import type { TrackerPayload } from '@/lib/renderer/publish/trackerSnippet';
import { DEFAULT_LOOK } from '@/lib/site/notFoundDefault';

const tracker: TrackerPayload = {
  variants: {},
  config: { key: 'ap_live_abc', endpoint: 'https://ingest.lumitra.co', projectId: 'proj_x' },
  src: 'https://analytics.lumitra.co/sdk/tracker.js',
};

interface Api {
  open(category?: string): void;
  accept(): void;
  decline(): void;
  get(category?: string): string | null;
  categories: string[];
  grant?: unknown;
}
type Win = Window & { __lumitraConsent?: Api; __fcImportTracker?: (url: string) => Promise<unknown>; __AP_CONFIG?: unknown };
const win = window as Win;

const added: Array<[string, EventListenerOrEventListenerObject]> = [];
const realAdd = document.addEventListener.bind(document);
let importTracker: ReturnType<typeof vi.fn>;
let events: Record<string, unknown>[];
const onConsent = (event: Event) => events.push((event as CustomEvent<Record<string, unknown>>).detail);

beforeEach(() => {
  events = [];
  importTracker = vi.fn(() => Promise.resolve({ init: vi.fn(), enableTracking: vi.fn() }));
  win.__fcImportTracker = importTracker as unknown as (url: string) => Promise<unknown>;
  window.addEventListener('lumitra:consent', onConsent);
  vi.spyOn(document, 'addEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    added.push([type, listener]);
    realAdd(type, listener, options);
  }) as typeof document.addEventListener);
});

afterEach(() => {
  for (const [type, listener] of added.splice(0)) document.removeEventListener(type, listener);
  window.removeEventListener('lumitra:consent', onConsent);
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.cookie = `${CONSENT_MAPS_COOKIE}=; path=/; max-age=0`;
  delete win.__fcImportTracker;
  delete win.__lumitraConsent;
  delete win.__AP_CONFIG;
});

/** A page using `page`, on a site using `site` (the page's own when not given). */
function load(page: ConsentCategory[], site: ConsentCategory[] = page, language = 'en') {
  const withTracker = site.includes('analytics') ? tracker : null;
  render(
    <>
      <ConsentBanner tracker={withTracker} categories={page} siteCategories={site} language={language} look={DEFAULT_LOOK} />
      <main><button type="button">Load map</button></main>
      <footer><a href="#cookie-settings">Cookie settings</a></footer>
    </>,
  );
  new Function(consentRuntimeScript({ tracker: withTracker, categories: page, siteCategories: site }))();
  return win.__lumitraConsent as Api;
}

const banner = () => document.getElementById(CONSENT_BANNER_ID) as HTMLElement;
const row = (c: string) => banner().querySelector(`[data-fc-consent-row="${c}"]`) as HTMLElement;
const stored = () => JSON.parse(window.localStorage.getItem(CONSENT_STORAGE_KEY) ?? 'null');
const mapsCookie = () => document.cookie.split('; ').find((c) => c.startsWith(`${CONSENT_MAPS_COOKIE}=`)) ?? null;
const store = (value: Record<string, unknown>) => window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: CONSENT_VERSION, at: 'x', ...value }));
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const cookieSettings = () => fireEvent.click(screen.getByRole('link', { name: 'Cookie settings' }));

describe('a site with one purpose', () => {
  it('asks a page with a map about Google Maps alone, and loads no tracker', () => {
    const api = load(['maps']);
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toContain('Google Maps');
    expect(banner().textContent).not.toContain('Lumitra Analytics');
    expect(banner().querySelector('[data-fc-consent-row]')).toBeNull();
    expect(api.categories).toEqual(['maps']);
    expect(api.get('maps')).toBeNull();
    expect(events).toEqual([]);
  });

  it('accepting answers maps, sets the cookie the middleware reads and announces it', () => {
    const api = load(['maps']);
    click('Accept');
    expect(banner().hidden).toBe(true);
    expect(stored()).toMatchObject({ v: CONSENT_VERSION, maps: true });
    expect(stored()).not.toHaveProperty('analytics');
    expect(api.get('maps')).toBe('granted');
    expect(mapsCookie()).toBe(`${CONSENT_MAPS_COOKIE}=1`);
    expect(events).toEqual([{ maps: true }]);
    expect(importTracker).not.toHaveBeenCalled();
  });

  it('declining answers no, clears the cookie and announces it, without a reload', () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload, hash: '' } as Location);
    store({ maps: true });
    const api = load(['maps']);
    cookieSettings();
    click('Decline');
    expect(api.get('maps')).toBe('denied');
    expect(mapsCookie()).toBeNull();
    expect(events).toEqual([{ maps: false }]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('withdraws maps from a page of a maps-only site that has no map', () => {
    store({ maps: true });
    document.cookie = `${CONSENT_MAPS_COOKIE}=1; path=/`;
    const api = load([], ['maps']);
    // Nothing on this page asks, so the banner waits for the footer link.
    expect(banner().hidden).toBe(true);
    cookieSettings();
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toContain('Google Maps');
    click('Decline');
    expect(api.get('maps')).toBe('denied');
    expect(mapsCookie()).toBeNull();
  });
});

describe('a site with two purposes: one choice each', () => {
  it('asks each purpose in its own row, so analytics alone can be allowed', () => {
    const api = load(['analytics', 'maps']);
    expect(row('analytics').hidden).toBe(false);
    expect(row('maps').hidden).toBe(false);
    expect(row('maps').textContent).toContain('Google Ireland Limited');
    click('Audience measurement (Lumitra Analytics): Accept');
    expect(api.get('analytics')).toBe('granted');
    expect(api.get('maps')).toBeNull();
    expect(importTracker).toHaveBeenCalledTimes(1);
    expect(stored()).not.toHaveProperty('maps');
    // Maps is still open, so the banner stays.
    expect(banner().hidden).toBe(false);
    click('Maps from Google Maps: Decline');
    expect(api.get('maps')).toBe('denied');
    expect(banner().hidden).toBe(true);
    expect(events).toContainEqual({ maps: false });
  });

  it('marks each row with its answer', () => {
    store({ analytics: true });
    load(['analytics', 'maps']);
    expect(screen.getByRole('button', { name: 'Audience measurement (Lumitra Analytics): Accept' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Maps from Google Maps: Accept' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('Decline all answers every row with no', () => {
    const api = load(['analytics', 'maps']);
    click('Decline all');
    expect(api.get('analytics')).toBe('denied');
    expect(api.get('maps')).toBe('denied');
    expect(banner().hidden).toBe(true);
  });

  it('keeps an earlier analytics answer without a new version, and asks only about maps', () => {
    store({ analytics: true });
    const api = load(['analytics', 'maps']);
    expect(importTracker).toHaveBeenCalledTimes(1);
    expect(banner().hidden).toBe(false);
    click('Maps from Google Maps: Accept');
    expect(stored()).toMatchObject({ v: CONSENT_VERSION, analytics: true, maps: true });
    expect(api.get('analytics')).toBe('granted');
    expect(banner().hidden).toBe(true);
  });

  it('on a page without a map, auto-asks analytics only, yet withdraws maps from the footer link', () => {
    store({ maps: true });
    document.cookie = `${CONSENT_MAPS_COOKIE}=1; path=/`;
    const api = load(['analytics'], ['analytics', 'maps']);
    expect(banner().hidden).toBe(false);
    expect(row('analytics').hidden).toBe(false);
    expect(row('maps').hidden).toBe(true);
    click('Audience measurement (Lumitra Analytics): Accept');
    expect(banner().hidden).toBe(true);
    // Reopened, the banner shows every category of the site, the maps "yes" included.
    cookieSettings();
    expect(row('maps').hidden).toBe(false);
    expect(screen.getByRole('button', { name: 'Maps from Google Maps: Accept' }).getAttribute('aria-pressed')).toBe('true');
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload, hash: '' } as Location);
    click('Decline all');
    expect(api.get('maps')).toBe('denied');
    expect(api.get('analytics')).toBe('denied');
    expect(mapsCookie()).toBeNull();
    // The tracker ran, so the page reloads to stop it.
    expect(reload).toHaveBeenCalled();
    // A reopened banner stays until the visitor closes it.
    expect(banner().hidden).toBe(false);
    click('Close');
    expect(banner().hidden).toBe(true);
  });
});

describe('a map asks through the banner', () => {
  it('open("maps") shows the banner on the maps question, focused, and records nothing by itself', () => {
    store({ analytics: false });
    const api = load(['analytics', 'maps']);
    expect(banner().hidden).toBe(false);
    api.open('maps');
    expect(document.activeElement).toBe(row('maps'));
    expect(stored()).not.toHaveProperty('maps');
    expect(events).toEqual([]);
    click('Maps from Google Maps: Accept');
    expect(api.get('maps')).toBe('granted');
    expect(banner().hidden).toBe(true);
  });

  it('has no way to answer except the banner: no grant, and forged buttons do nothing', () => {
    const api = load(['maps']);
    expect(api.grant).toBeUndefined();
    const forged = document.createElement('button');
    forged.setAttribute('data-fc-consent-accept', 'maps');
    document.body.append(forged);
    fireEvent.click(forged);
    expect(stored()).toBeNull();
    expect(events).toEqual([]);
    forged.remove();
  });

  it('keeps the choice for the page view when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const api = load(['maps']);
    click('Accept');
    expect(api.get('maps')).toBe('granted');
    expect(events).toEqual([{ maps: true }]);
  });
});

describe('stored value and copy', () => {
  it('reads one category from the stored value', () => {
    const raw = JSON.stringify({ v: CONSENT_VERSION, analytics: false, maps: true, at: 'x' });
    expect(parseStoredConsent(raw, CONSENT_VERSION, 'maps')).toBe('granted');
    expect(parseStoredConsent(raw)).toBe('denied');
    expect(parseStoredConsent(JSON.stringify({ v: CONSENT_VERSION, at: 'x' }), CONSENT_VERSION, 'maps')).toBeNull();
  });

  it('names each purpose in both languages, without long dashes', () => {
    expect(consentCopy('de', ['maps']).body).toContain('Google Maps');
    expect(consentCopy('de', ['maps']).body).not.toContain('Lumitra');
    expect(consentCopy('de', ['analytics', 'maps']).rows.maps.text).toContain('Google Ireland Limited');
    expect(consentCopy('en').body).toBe(consentCopy('en', ['analytics']).body);
    for (const lang of ['de', 'en']) {
      for (const cats of [['analytics'], ['maps'], ['analytics', 'maps']] as ConsentCategory[][]) {
        const copy = consentCopy(lang, cats);
        expect(`${copy.body} ${copy.rows.analytics.text} ${copy.rows.maps.text}`).not.toMatch(/[–—]/);
      }
    }
  });
});
