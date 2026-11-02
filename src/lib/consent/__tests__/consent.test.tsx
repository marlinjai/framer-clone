// The consent gate on published pages (src/lib/consent/consent.ts and
// ConsentBanner.tsx): the banner markup is rendered like the server does, then
// the inline runtime is run as the browser would run it after parsing.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT_INHERITED } from '@/lib/rules/rootProperties';
import { cssPropertyName } from '@/lib/responsive/responsiveCss';
import { BANNER_PINNED, ConsentBanner } from '../ConsentBanner';
import {
  CONSENT_BANNER_ID,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  consentCopy,
  consentRuntimeScript,
  parseStoredConsent,
} from '../consent';
import type { TrackerPayload } from '@/lib/renderer/publish/trackerSnippet';
import { DEFAULT_LOOK, legibleLook } from '@/lib/site/notFoundDefault';
import { colorText, parseColor } from '@/lib/ai/review/layoutAudit';
import { parseFontFamilyList, platformFontStack } from '@/lib/fonts/registry';

const written = (fontFamily: string) => platformFontStack(fontFamily) as string;

const tracker: TrackerPayload = {
  variants: {},
  config: { key: 'ap_live_abc', endpoint: 'https://ingest.lumitra.co', projectId: 'proj_x' },
  src: 'https://analytics.lumitra.co/sdk/tracker.js',
};

type Win = Window & {
  __AP_CONFIG?: Record<string, unknown>;
  __AP_VARIANTS?: Record<string, string>;
  __lumitraConsent?: { open(): void; accept(): void; decline(): void; get(): string | null; version: number };
  LumitraAnalytics?: unknown;
  __fcImportTracker?: (url: string) => Promise<unknown>;
};
const win = window as Win;

// The runtime listens on the document; every test runs it afresh, so the
// listeners of the previous run are removed after each test.
const added: Array<[string, EventListenerOrEventListenerObject]> = [];
const realAdd = document.addEventListener.bind(document);

// The tracker is an ES module the runtime imports; the test seam replaces the
// import with a fake module so jsdom can run it.
let trackerModule: { init: ReturnType<typeof vi.fn>; enableTracking: ReturnType<typeof vi.fn> };
let importTracker: ReturnType<typeof vi.fn>;

beforeEach(() => {
  trackerModule = { init: vi.fn(), enableTracking: vi.fn() };
  importTracker = vi.fn(() => Promise.resolve(trackerModule));
  win.__fcImportTracker = importTracker as unknown as (url: string) => Promise<unknown>;
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
  delete win.__fcImportTracker;
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
const trackerLoads = () => importTracker.mock.calls;
const settle = () => new Promise((r) => setTimeout(r, 0));
const stored = () => JSON.parse(window.localStorage.getItem(CONSENT_STORAGE_KEY) ?? 'null');

describe('consent banner', () => {
  it('shows on a first visit and loads nothing before a choice', () => {
    load();
    expect(banner().hidden).toBe(false);
    expect(trackerLoads()).toHaveLength(0);
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

  it('takes no choice from anything outside the banner', async () => {
    load();
    const forged = document.createElement('div');
    forged.setAttribute('data-fc-consent-accept', '');
    document.body.append(forged);
    fireEvent.click(forged);
    await settle();
    expect(stored()).toBeNull();
    expect(trackerLoads()).toHaveLength(0);
    expect(banner().hidden).toBe(false);
    forged.remove();
  });

  it('accepting stores a versioned choice and imports the tracker module', () => {
    load();
    fireEvent.click(screen.getByRole('button', { name: 'Akzeptieren' }));
    expect(banner().hidden).toBe(true);
    expect(stored()).toMatchObject({ v: CONSENT_VERSION, analytics: true });
    expect(typeof stored().at).toBe('string');
    expect(trackerLoads()).toEqual([['https://analytics.lumitra.co/sdk/tracker.js']]);
    expect(win.__AP_CONFIG).toMatchObject({ key: 'ap_live_abc', projectId: 'proj_x', consent: { analytics: true } });
    expect(win.__AP_VARIANTS).toEqual({});
  });

  it('starts the imported tracker with the site config and turns on post-consent tracking', async () => {
    load();
    win.__lumitraConsent!.accept();
    await settle();
    expect(trackerModule.init).toHaveBeenCalledWith({ projectId: 'proj_x', apiKey: 'ap_live_abc', endpoint: 'https://ingest.lumitra.co' });
    expect(trackerModule.enableTracking).toHaveBeenCalledTimes(1);
    expect(win.LumitraAnalytics).toBe(trackerModule);
  });

  it('reports a tracker that fails to load instead of failing silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    importTracker.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    load();
    win.__lumitraConsent!.accept();
    await settle();
    expect(warn).toHaveBeenCalledWith('[consent] analytics tracker failed to load', expect.any(Error));
    expect(trackerModule.init).not.toHaveBeenCalled();
  });

  it('declining stores the choice and loads nothing at all', () => {
    load();
    fireEvent.click(screen.getByRole('button', { name: 'Ablehnen' }));
    expect(banner().hidden).toBe(true);
    expect(stored()).toMatchObject({ v: CONSENT_VERSION, analytics: false });
    expect(trackerLoads()).toHaveLength(0);
    expect(win.__AP_CONFIG).toBeUndefined();
    expect(win.__AP_VARIANTS).toBeUndefined();
  });

  it('remembers a yes on the next page: tracker loads at once, no banner', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: CONSENT_VERSION, analytics: true, at: 'x' }));
    load();
    expect(banner().hidden).toBe(true);
    expect(trackerLoads()).toHaveLength(1);
  });

  it('remembers a no on the next page: nothing loads, no banner', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: CONSENT_VERSION, analytics: false, at: 'x' }));
    load();
    expect(banner().hidden).toBe(true);
    expect(trackerLoads()).toHaveLength(0);
    expect(win.__AP_CONFIG).toBeUndefined();
  });

  it('asks again when the stored choice is for another version or unreadable', () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({ v: CONSENT_VERSION - 1, analytics: true, at: 'x' }));
    load();
    expect(banner().hidden).toBe(false);
    expect(trackerLoads()).toHaveLength(0);
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
    expect(trackerLoads()).toHaveLength(1);
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

describe('the banner against what a page sets on the document', () => {
  /** Inherited, but not what makes the banner readable or lets it be used. */
  const EXEMPT: Record<string, string> = {
    backgroundColor: 'not inherited: the banner paints its own background',
    WebkitTapHighlightColor: 'only the flash of a tap',
  };
  const PINNED_ELSEWHERE = ['color', 'fontFamily', 'fontSize', 'lineHeight'];

  const bannerStyle = (): string => {
    const html = renderToStaticMarkup(<ConsentBanner tracker={tracker} language="en" look={DEFAULT_LOOK} />);
    return /data-fc-consent=""[^>]*style="([^"]*)"/.exec(html)?.[1] ?? '';
  };

  it.each([...ROOT_INHERITED].filter((key) => !(key in EXEMPT)))('pins %s on its own root', (key) => {
    expect(bannerStyle().split(';').map((entry) => entry.split(':')[0])).toContain(cssPropertyName(key));
    if (!PINNED_ELSEWHERE.includes(key)) expect(key in BANNER_PINNED).toBe(true);
  });

  it('pins on the browser base what that base gives a page', () => {
    const html = renderToStaticMarkup(<ConsentBanner tracker={tracker} language="en" look={DEFAULT_LOOK} pageBase="browser" />);
    expect(html).toContain('tab-size:8');
    expect(html).toContain('text-size-adjust:auto');
    expect(html).toContain('-webkit-font-smoothing:auto');
    expect(bannerStyle()).toContain('tab-size:4');
  });

  it('names a reason for what it leaves out, and only for what the list holds', () => {
    for (const key of Object.keys(EXEMPT)) expect(ROOT_INHERITED.has(key)).toBe(true);
  });
});

describe('a look the banner can be read in', () => {
  it.each([
    ['transparent text', { color: 'transparent' }],
    ['a see-through ground', { background: 'transparent' }],
    ['a half see-through ground', { background: 'rgba(0, 0, 0, 0.5)' }],
    ['the same colour twice', { color: '#123456', background: '#123456' }],
    ['too little contrast', { color: '#777777', background: '#888888' }],
    ['white on white, named', { color: 'white', background: 'white' }],
    ['white on white, hsl', { color: 'hsl(0 0% 100%)', background: 'hsl(0 0% 100%)' }],
    ['white on white, oklch', { color: 'oklch(1 0 0)', background: 'oklch(1 0 0)' }],
    ['a see-through ground in hsla', { background: 'hsla(0,0%,0%,0)' }],
    ['color-mix, which has no value here', { color: 'color-mix(in srgb, white, white)', background: 'white' }],
    ['currentColor as the ground', { background: 'currentColor' }],
    ['inherit as the ink', { color: 'inherit' }],
    ['var() on both', { color: 'var(--ink)', background: 'var(--ink)' }],
    ['a gradient as the ground', { color: '#000000', background: 'linear-gradient(#000,#000)' }],
    ['a colour a browser would refuse, so inherit in its place', { color: 'rgb(1, 2 3)', background: 'white' }],
    ['an !important, which an inline style drops', { color: 'navy !important', background: 'white' }],
    ['a trailing dot, which CSS refuses', { color: 'rgb(0. 0. 0.)', background: 'white' }],
    ['a trailing dot in a percentage', { color: 'hsl(0 0% 0.%)', background: 'white' }],
    ['a trailing dot on the ground', { color: 'black', background: 'rgb(255. 255. 255.)' }],
  ])('falls back to the neutral pair on %s', (_name, look) => {
    const out = legibleLook({ ...DEFAULT_LOOK, ...look, fontFamily: 'Georgia' });
    expect({ color: out.color, background: out.background, fontFamily: out.fontFamily }).toEqual({ color: DEFAULT_LOOK.color, background: DEFAULT_LOOK.background, fontFamily: 'Georgia' });
  });

  it('does the same for the buttons, alone, and a trailing dot there too', () => {
    const neutral = { accent: DEFAULT_LOOK.accent, accentText: DEFAULT_LOOK.accentText };
    expect(legibleLook({ ...DEFAULT_LOOK, color: '#ffffff', background: '#000000', accent: '#ff0000', accentText: '#ff0000' })).toEqual({
      ...DEFAULT_LOOK,
      fontFamily: written(DEFAULT_LOOK.fontFamily),
      color: 'rgb(255 255 255 / 1)',
      background: 'rgb(0 0 0 / 1)',
      ...neutral,
    });
    expect(legibleLook({ ...DEFAULT_LOOK, accentText: 'rgb(255. 255. 255.)' })).toMatchObject(neutral);
  });

  it.each([
    ['hex and rgb', '#fff', 'rgb(10, 10, 10)'],
    ['names', 'navy', 'white'],
    ['hsl', 'hsl(210 50% 20%)', 'hsl(0 0% 100%)'],
    ['oklch', 'oklch(0.25 0.05 260)', 'white'],
    ['oklch on a light ground', 'black', 'oklch(0.95 0.02 90)'],
  ])('keeps a pair that reads, in %s, written from its numbers', (_name, color, background) => {
    const out = legibleLook({ ...DEFAULT_LOOK, color, background });
    expect(out.color).toBe(colorText(parseColor(color)!));
    expect(out.background).toBe(colorText(parseColor(background)!));
    expect(out.color).toMatch(/^rgb\([\d. ]+\/ [\d.]+\)$/);
  });

  it('takes a font from the registry, written as the registry writes it', () => {
    for (const fontFamily of [DEFAULT_LOOK.fontFamily, "'Fraunces', Georgia, 'Times New Roman', serif", 'Georgia, serif', 'sans-serif']) {
      const out = legibleLook({ ...DEFAULT_LOOK, fontFamily }).fontFamily;
      expect(parseFontFamilyList(out)).toEqual(parseFontFamilyList(fontFamily));
    }
    expect(legibleLook({ ...DEFAULT_LOOK, fontFamily: 'system-ui,,sans-serif' }).fontFamily).toBe('system-ui, sans-serif');
    expect(legibleLook({ ...DEFAULT_LOOK, fontFamily: 'system-ui,' }).fontFamily).toBe('system-ui');
    expect(legibleLook({ ...DEFAULT_LOOK, fontFamily: 'GEORGIA' }).fontFamily).toBe('Georgia');
  });

  it.each(['u-blank', "'u-blank', sans-serif", 'Inter, sans-serif', 'inherit', 'var(--font)', 'Georgia !important', ''])('takes the neutral stack in place of %j', (fontFamily) => {
    expect(legibleLook({ ...DEFAULT_LOOK, fontFamily }).fontFamily).toBe(DEFAULT_LOOK.fontFamily);
  });

  it('writes the default look as the same colours and families', () => {
    const out = legibleLook(DEFAULT_LOOK);
    for (const key of ['color', 'background', 'accent', 'accentText'] as const) expect(parseColor(out[key])).toEqual(parseColor(DEFAULT_LOOK[key]));
    expect(parseFontFamilyList(out.fontFamily)).toEqual(parseFontFamilyList(DEFAULT_LOOK.fontFamily));
  });

  it('reaches the markup', () => {
    const html = renderToStaticMarkup(<ConsentBanner tracker={tracker} language="en" look={{ ...DEFAULT_LOOK, color: 'transparent' }} />);
    expect(html).toContain('color:#111827');
    expect(html).not.toContain('color:transparent');
  });
});
