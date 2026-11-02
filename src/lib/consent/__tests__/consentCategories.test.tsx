// The consent runtime's categories (src/lib/consent/consent.ts): a page asks only
// for what it uses, Accept and Decline answer all of it, `grant` answers one, and an
// answer to one category never changes another's.

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
  open(): void;
  accept(): void;
  decline(): void;
  grant(category: string): void;
  get(category?: string): string | null;
  categories: string[];
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

function load(categories: ConsentCategory[], language = 'en') {
  const withTracker = categories.includes('analytics') ? tracker : null;
  render(
    <>
      <ConsentBanner tracker={withTracker} categories={categories} language={language} look={DEFAULT_LOOK} />
      <footer><a href="#cookie-settings">Cookie settings</a></footer>
    </>,
  );
  new Function(consentRuntimeScript({ tracker: withTracker, categories }))();
  return win.__lumitraConsent as Api;
}

const banner = () => document.getElementById(CONSENT_BANNER_ID) as HTMLElement;
const stored = () => JSON.parse(window.localStorage.getItem(CONSENT_STORAGE_KEY) ?? 'null');
const mapsCookie = () => document.cookie.split('; ').find((c) => c.startsWith(`${CONSENT_MAPS_COOKIE}=`)) ?? null;

describe('consent categories', () => {
  it('asks a page with only a map about Google Maps, and loads no tracker', () => {
    const api = load(['maps']);
    expect(banner().hidden).toBe(false);
    expect(banner().textContent).toContain('Google Maps');
    expect(banner().textContent).not.toContain('Lumitra Analytics');
    expect(api.categories).toEqual(['maps']);
    expect(api.get('maps')).toBeNull();
    expect(events).toEqual([]);
    expect(mapsCookie()).toBeNull();
  });

  it('accepting answers maps, sets the cookie the middleware reads and announces it', () => {
    const api = load(['maps']);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(banner().hidden).toBe(true);
    expect(stored()).toMatchObject({ v: CONSENT_VERSION, maps: true });
    expect(stored()).not.toHaveProperty('analytics');
    expect(api.get('maps')).toBe('granted');
    expect(api.get()).toBeNull();
    expect(mapsCookie()).toBe(`${CONSENT_MAPS_COOKIE}=1`);
    expect(events).toEqual([{ maps: true }]);
    expect(importTracker).not.toHaveBeenCalled();
  });

  it('declining answers no, clears the cookie and announces it, without a reload', () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload, hash: '' } as Location);
    const api = load(['maps']);
    api.grant('maps');
    expect(mapsCookie()).toBe(`${CONSENT_MAPS_COOKIE}=1`);
    api.open();
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(api.get('maps')).toBe('denied');
    expect(mapsCookie()).toBeNull();
    expect(events).toEqual([{ maps: true }, { maps: false }]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('grant answers one category, keeps the others, and leaves the banner up while one is open', () => {
    const api = load(['analytics', 'maps']);
    expect(banner().textContent).toContain('Lumitra Analytics');
    expect(banner().textContent).toContain('Google Maps');
    api.grant('maps');
    expect(api.get('maps')).toBe('granted');
    expect(api.get('analytics')).toBeNull();
    expect(stored()).not.toHaveProperty('analytics');
    expect(banner().hidden).toBe(false);
    expect(importTracker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    // Decline answers what the page asks, maps included: the visitor said no to all of it.
    expect(api.get('analytics')).toBe('denied');
    expect(api.get('maps')).toBe('denied');
  });

  it('closes the banner when a grant answers the last open question', () => {
    const api = load(['maps']);
    expect(banner().hidden).toBe(false);
    api.grant('maps');
    expect(banner().hidden).toBe(true);
  });

  it('asks again only for the new category: an analytics answer stays and still loads the tracker', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: CONSENT_VERSION, analytics: true, at: 'x' }));
    const api = load(['analytics', 'maps']);
    expect(importTracker).toHaveBeenCalledTimes(1);
    expect(banner().hidden).toBe(false);
    api.grant('maps');
    expect(stored()).toMatchObject({ analytics: true, maps: true });
    expect(banner().hidden).toBe(true);
  });

  it('keeps the banner hidden on a page whose questions are all answered', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: CONSENT_VERSION, maps: false, at: 'x' }));
    const api = load(['maps']);
    expect(banner().hidden).toBe(true);
    expect(api.get('maps')).toBe('denied');
  });

  it('ignores a category it does not know', () => {
    const api = load(['maps']);
    api.grant('everything');
    expect(stored()).toBeNull();
    expect(events).toEqual([]);
  });

  it('keeps the choice for the page view when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const api = load(['maps']);
    api.grant('maps');
    expect(api.get('maps')).toBe('granted');
    expect(events).toEqual([{ maps: true }]);
  });

  it('reads one category from the stored value', () => {
    const raw = JSON.stringify({ v: CONSENT_VERSION, analytics: false, maps: true, at: 'x' });
    expect(parseStoredConsent(raw, CONSENT_VERSION, 'maps')).toBe('granted');
    expect(parseStoredConsent(raw)).toBe('denied');
    expect(parseStoredConsent(JSON.stringify({ v: CONSENT_VERSION, at: 'x' }), CONSENT_VERSION, 'maps')).toBeNull();
  });

  it('names what the page asks about in both languages', () => {
    expect(consentCopy('de', ['maps']).body).toContain('Google Maps');
    expect(consentCopy('de', ['maps']).body).not.toContain('Lumitra');
    expect(consentCopy('en', ['analytics', 'maps']).body).toMatch(/Lumitra Analytics.*Google Maps/);
    expect(consentCopy('en').body).toBe(consentCopy('en', ['analytics']).body);
    for (const lang of ['de', 'en']) {
      for (const cats of [['analytics'], ['maps'], ['analytics', 'maps']] as ConsentCategory[][]) {
        expect(consentCopy(lang, cats).body).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });
});
