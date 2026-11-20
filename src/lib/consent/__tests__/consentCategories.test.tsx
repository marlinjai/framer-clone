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
import FormIsland from '@/lib/renderer/forms/FormIsland';
import { FORM_KIND_ATTR } from '@/lib/forms/definition';
import { createScope } from '@/lib/bindings/resolver/scope';

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
  mapsAtLoad?: boolean;
  mapsAllowed?: () => boolean;
  edited?: () => boolean;
  reload?: () => void;
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
/** jsdom has no navigation: the runtime's reload, observed instead. */
const mockReload = (hash = '') => {
  const reload = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload, hash, pathname: '/contact', search: '?a=1' } as Location);
  return reload;
};
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

  it('accepting answers maps, sets the cookie the middleware reads and reloads into a document that allows the map', () => {
    const reload = mockReload();
    const api = load(['maps']);
    expect(reload).not.toHaveBeenCalled();
    click('Accept');
    expect(stored()).toMatchObject({ v: CONSENT_VERSION, maps: true });
    expect(stored()).not.toHaveProperty('analytics');
    expect(api.get('maps')).toBe('granted');
    expect(mapsCookie()).toBe(`${CONSENT_MAPS_COOKIE}=1`);
    // This document's frame-src has no Google: a map drawn now would be refused.
    expect(reload).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(importTracker).not.toHaveBeenCalled();
  });

  it('accepting in a document already served with the maps cookie announces it, without a reload', () => {
    const reload = mockReload();
    document.cookie = `${CONSENT_MAPS_COOKIE}=1; path=/`;
    const api = load(['maps']);
    click('Accept');
    expect(banner().hidden).toBe(true);
    expect(api.get('maps')).toBe('granted');
    expect(events).toEqual([{ maps: true }]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('tells a map island whether this document was served with the maps cookie', () => {
    mockReload();
    expect(load(['maps']).mapsAtLoad).toBe(false);
    cleanup();
    document.cookie = `${CONSENT_MAPS_COOKIE}=1; path=/`;
    expect(load(['maps']).mapsAtLoad).toBe(true);
  });

  it('says whether the maps cookie is set now, so a map can tell a browser that blocks cookies', () => {
    mockReload();
    const api = load(['maps']);
    expect(api.mapsAllowed?.()).toBe(false);
    document.cookie = `${CONSENT_MAPS_COOKIE}=1; path=/`;
    expect(api.mapsAllowed?.()).toBe(true);
  });

  it('a yes where the cookie does not stick neither reloads nor stays silent: the map hears it and explains', () => {
    const reload = mockReload();
    // A browser that blocks cookies: every write is dropped.
    // Defined by hand: two spies on one accessor restore each other's mock.
    const jar = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(Document.prototype, 'cookie', { configurable: true, get: () => '', set: () => {} });
    try {
      const api = load(['maps']);
      click('Accept');
      expect(api.mapsAllowed?.()).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(events).toEqual([{ maps: true }]);
    } finally {
      Object.defineProperty(Document.prototype, 'cookie', jar);
    }
  });

  it('announces a maps reload first, saying whether a map\'s "Load map" opened the banner', () => {
    const reload = mockReload();
    const reloads: unknown[] = [];
    const onReload = (event: Event) => reloads.push((event as CustomEvent).detail);
    window.addEventListener('lumitra:maps-reload', onReload);
    try {
      const api = load(['maps']);
      api.open('maps');
      click('Accept');
      expect(reloads).toEqual([{ fromMap: true }]);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('lumitra:maps-reload', onReload);
    }
  });

  it('a maps reload from "Cookie settings", which no map opened, says so', () => {
    mockReload();
    const reloads: unknown[] = [];
    const onReload = (event: Event) => reloads.push((event as CustomEvent).detail);
    window.addEventListener('lumitra:maps-reload', onReload);
    try {
      store({ maps: false });
      load(['maps']);
      cookieSettings();
      click('Accept');
      expect(reloads).toEqual([{ fromMap: false }]);
    } finally {
      window.removeEventListener('lumitra:maps-reload', onReload);
    }
  });

  describe('a visitor who edited a field on the page', () => {
    /**
     * jsdom marks every event a test dispatches as untrusted, and the runtime counts only
     * the visitor's own. While on, each input and change event reaches the runtime's own
     * capture listeners once more, reading as trusted: what a browser hands it when the
     * visitor types. Everything else about the event is the real one.
     */
    let visitor = false;
    const asVisitor = (event: Event) => {
      if (!visitor || event.isTrusted) return;
      const trusted = new Proxy(event, {
        get: (target, key) => {
          if (key === 'isTrusted') return true;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      for (const [type, listener] of added) {
        if (type !== event.type) continue;
        if (typeof listener === 'function') listener.call(document, trusted);
        else listener.handleEvent(trusted);
      }
    };
    beforeEach(() => {
      visitor = true;
      window.addEventListener('input', asVisitor, true);
      window.addEventListener('change', asVisitor, true);
    });
    afterEach(() => {
      visitor = false;
      vi.unstubAllGlobals();
      window.removeEventListener('input', asVisitor, true);
      window.removeEventListener('change', asVisitor, true);
      document.querySelectorAll('[data-test-field]').forEach((f) => f.remove());
    });

    /** The platform's published contact form, a React island with controlled fields. */
    const contactForm = () =>
      render(
        <FormIsland
          node={{
            id: 'form-1',
            type: 'div',
            props: { [FORM_KIND_ATTR]: 'form', formName: 'Contact', successMessage: 'Thanks.' },
            children: [
              { id: 'f-name', type: 'div', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'text', name: 'name', label: 'Name' } },
              { id: 'f-message', type: 'div', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'textarea', name: 'message', label: 'Message' } },
              { id: 'f-send', type: 'button', props: { [FORM_KIND_ATTR]: 'form-submit', children: 'Send' } },
            ],
          }}
          scope={createScope()}
          renderedAt={1_700_000_000_000}
        />,
      );

    it('does not reload over text typed into the published contact form: the yes is announced and the map offers the reload', () => {
      const reload = mockReload();
      contactForm();
      load(['maps']);
      const message = screen.getByLabelText(/^Message/) as HTMLTextAreaElement;
      fireEvent.change(message, { target: { value: 'Please call me back on Monday.' } });
      // React keeps a controlled field's default in step with its value: comparing the two
      // cannot tell typed text from none.
      expect(message.defaultValue).toBe(message.value);
      click('Accept');
      expect(reload).not.toHaveBeenCalled();
      expect(events).toEqual([{ maps: true }]);
      expect(mapsCookie()).toBe(`${CONSENT_MAPS_COOKIE}=1`);
      expect(message.value).toBe('Please call me back on Monday.');
    });

    it('reloads again once the contact form was sent: its thanks replaced the fields that held the text', async () => {
      const reload = mockReload();
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, message: 'Thanks' }), { status: 200, headers: { 'content-type': 'application/json' } }))));
      contactForm();
      const api = load(['maps']);
      fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: 'Please call me back.' } });
      expect(api.edited?.()).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('Thanks');
      expect(api.edited?.()).toBe(false);
      click('Accept');
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('counts a field inside a shadow root', () => {
      const reload = mockReload();
      const host = document.createElement('div');
      host.setAttribute('data-test-field', '');
      document.body.append(host);
      const field = document.createElement('input');
      host.attachShadow({ mode: 'open' }).append(field);
      load(['maps']);
      field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      click('Accept');
      expect(reload).not.toHaveBeenCalled();
      expect(events).toEqual([{ maps: true }]);
    });

    it('holds for a name typed into the contact form too', () => {
      const reload = mockReload();
      contactForm();
      load(['maps']);
      fireEvent.input(screen.getByLabelText(/^Name/), { target: { value: 'Ana' } });
      click('Accept');
      expect(reload).not.toHaveBeenCalled();
    });

    it.each([
      ['a ticked box', '<input type="checkbox" data-test-field>', (f: Element) => fireEvent.click(f)],
      ['another option', '<select data-test-field><option>x</option><option>y</option></select>', (f: Element) => fireEvent.change(f, { target: { selectedIndex: 1 } })],
      ['an edited note', '<div contenteditable="true" data-test-field><p>Note</p></div>', (f: Element) => fireEvent.input(f.firstElementChild!)],
    ])('does not reload over %s', (_name, markup, edit) => {
      const reload = mockReload();
      document.body.insertAdjacentHTML('beforeend', markup);
      load(['maps']);
      edit(document.querySelector('[data-test-field]')!);
      click('Accept');
      expect(reload).not.toHaveBeenCalled();
      expect(events).toEqual([{ maps: true }]);
    });

    it('reloads over fields nobody touched, a select without a chosen option, a range and a colour among them', () => {
      const reload = mockReload();
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div data-test-field><select><option>x</option><option>y</option></select><input type="range"><input type="color"><input value="preset"><input type="checkbox" checked></div>',
      );
      contactForm();
      load(['maps']);
      click('Accept');
      expect(reload).toHaveBeenCalledTimes(1);
      expect(events).toEqual([]);
    });

    it('does not count an event a script dispatched', () => {
      visitor = false;
      const reload = mockReload();
      document.body.insertAdjacentHTML('beforeend', '<input data-test-field>');
      load(['maps']);
      fireEvent.input(document.querySelector('[data-test-field]')!, { target: { value: 'x' } });
      click('Accept');
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('does not count an edit inside the banner', () => {
      const reload = mockReload();
      load(['maps']);
      const inside = document.createElement('input');
      banner().append(inside);
      fireEvent.input(inside, { target: { value: 'x' } });
      click('Accept');
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });

  it('offers its reload to the map, which drops the cookie settings address and announces no maps reload', () => {
    const reload = mockReload('#cookie-settings');
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    const reloads: unknown[] = [];
    const onReload = (event: Event) => reloads.push((event as CustomEvent).detail);
    window.addEventListener('lumitra:maps-reload', onReload);
    try {
      const api = load(['maps']);
      api.reload?.();
      expect(replaceState).toHaveBeenCalledWith(null, '', '/contact?a=1');
      expect(reload).toHaveBeenCalledTimes(1);
      expect(reloads).toEqual([]);
    } finally {
      window.removeEventListener('lumitra:maps-reload', onReload);
    }
  });

  it('drops the cookie settings address before the reload, so the banner does not open again', () => {
    const reload = mockReload('#cookie-settings');
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    load(['maps']);
    click('Accept');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/contact?a=1');
    expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0]);
  });

  it('a stored yes whose cookie is gone sets the cookie again and reloads once', () => {
    const reload = mockReload();
    store({ maps: true });
    load(['maps']);
    expect(mapsCookie()).toBe(`${CONSENT_MAPS_COOKIE}=1`);
    expect(reload).toHaveBeenCalledTimes(1);
    // The new document is served with the cookie: no second reload.
    cleanup();
    load(['maps']);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('declining answers no, clears the cookie and announces it, without a reload', () => {
    const reload = mockReload();
    store({ maps: true });
    document.cookie = `${CONSENT_MAPS_COOKIE}=1; path=/`;
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

  it('ignores a quick second tap on a banner it just opened, but not keys, a later tap or one after a press inside', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    store({ maps: false });
    const api = load(['maps']);
    expect(banner().hidden).toBe(true);
    const accept = () => screen.getByRole('button', { name: 'Accept' });
    // "Load map" opens it under the finger; the twin tap 120 ms later answers nothing.
    api.open('maps');
    now += 120;
    fireEvent.click(accept(), { detail: 1 });
    expect(api.get('maps')).toBe('denied');
    expect(banner().hidden).toBe(false);
    // A key on the focused button answers at once (a keyboard click has detail 0).
    fireEvent.click(accept(), { detail: 0 });
    expect(api.get('maps')).toBe('granted');
    // Opened again from the footer link: a press inside the banner first, then a tap, answers.
    cookieSettings();
    fireEvent.pointerDown(banner());
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Decline' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }), { detail: 1 });
    expect(api.get('maps')).toBe('denied');
    // And once the guard has passed, a tap answers too.
    api.open('maps');
    now += 600;
    fireEvent.click(accept(), { detail: 1 });
    expect(api.get('maps')).toBe('granted');
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
    const reload = mockReload();
    const api = load(['maps']);
    click('Accept');
    expect(api.get('maps')).toBe('granted');
    // A reload would forget it: announced in this page view instead.
    expect(events).toEqual([{ maps: true }]);
    expect(reload).not.toHaveBeenCalled();
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

describe('the maps reload and the tracker', () => {
  // The banner has no single "accept all" button; the runtime's accept() answers every question shown at once.
  it('A: accepting everything on a first visit to a page with a map reloads without starting the tracker in this document', () => {
    const reload = mockReload();
    load(['analytics', 'maps']).accept();
    expect(stored()).toMatchObject({ analytics: true, maps: true });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(importTracker).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('B: both answers stored and the maps cookie gone, on a page with a map: reloads before the tracker starts', () => {
    const reload = mockReload();
    store({ analytics: true, maps: true });
    load(['analytics', 'maps']);
    expect(mapsCookie()).toBe(`${CONSENT_MAPS_COOKIE}=1`);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(importTracker).not.toHaveBeenCalled();
    // The new document is served with the cookie: it starts the tracker, once, and does not reload.
    cleanup();
    load(['analytics', 'maps']);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(importTracker).toHaveBeenCalledTimes(1);
  });

  it('C: accepting everything from Cookie settings on a page without a map sets the cookie and does not reload', () => {
    const reload = mockReload();
    store({ analytics: true });
    const api = load(['analytics'], ['analytics', 'maps']);
    expect(importTracker).toHaveBeenCalledTimes(1);
    cookieSettings();
    api.accept();
    expect(stored()).toMatchObject({ analytics: true, maps: true });
    expect(mapsCookie()).toBe(`${CONSENT_MAPS_COOKIE}=1`);
    expect(reload).not.toHaveBeenCalled();
    expect(importTracker).toHaveBeenCalledTimes(1);
  });

  it('a stored yes whose cookie is gone, on a page without a map: sets the cookie, no reload', () => {
    const reload = mockReload();
    store({ analytics: true, maps: true });
    load(['analytics'], ['analytics', 'maps']);
    expect(mapsCookie()).toBe(`${CONSENT_MAPS_COOKIE}=1`);
    expect(reload).not.toHaveBeenCalled();
    expect(importTracker).toHaveBeenCalledTimes(1);
  });
});
