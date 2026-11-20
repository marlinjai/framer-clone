// src/lib/renderer/mapEmbed/MapEmbedIsland.tsx
//
// The published map embed (src/lib/mapEmbed/mapEmbed.ts): a client island the
// server renderer (renderComponentNode) emits for a map box. The server renders
// the placeholder, and so does the first client render, so hydration agrees and
// nothing of Google is in the HTML. The frame exists only in React state:
//
//   - on hydration, a stored "yes" to the `maps` consent category shows the map;
//   - "Load map" records nothing: it opens the platform's consent banner on the
//     maps question (`window.__lumitraConsent.open('maps')`, src/lib/consent/consent.ts),
//     and only the banner's own buttons answer. The placeholder is page markup that
//     stored rules can restyle (hide its note, make it invisible over a decoy), so
//     a click on it must never be the consent; the banner is pinned above every
//     stored layer and says itself what Google receives. A "yes" there is announced
//     to every map on the page;
//   - a later "no" (the banner's Decline, reopened from "Cookie settings") is
//     announced the same way and takes the frame out again.
//
// The placeholder and the frame are drawn in a shadow root on the box, so stored rules
// cannot hide the note or restyle the button (the recheck's N1); the banner's tap
// guard (src/lib/consent/consent.ts) covers what a page can still do to the box itself.
//
// The frame's address is checked once more right before it is drawn
// (isRebuiltMapSrc): nothing but an address this platform rebuilt can become an
// iframe's `src`. A React island rather than a runtime that rewrites the DOM, so it
// works inside other islands (a form, a commerce block) without fighting hydration.

'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isRebuiltMapSrc, readMapEmbed } from '@/lib/mapEmbed/mapEmbed';
import { MAP_FRAME_SANDBOX, MAP_FRAME_STYLE, MAP_SHADOW_ROOT_STYLE, mapPlaceholder } from './mapEmbedElement';

interface ConsentApi {
  get?: (category?: string) => string | null;
  open?: (category?: string) => void;
  /** False when this document was served without the maps cookie: its frame-src refuses Google. */
  mapsAtLoad?: boolean;
  /** Whether the maps cookie is set now. False after a yes means the browser blocks cookies. */
  mapsAllowed?: () => boolean;
  /** Whether the visitor has edited a field still on the page, which a reload would clear. */
  edited?: () => boolean;
  /** The runtime's reload, which drops the `#cookie-settings` address first so the banner stays shut. */
  reload?: () => void;
}

/**
 * A new document, through the runtime's own reload when it offers one: that drops the
 * `#cookie-settings` address first, so the new page does not open the banner again.
 */
function reloadPage(): void {
  try {
    const api = consentApi();
    if (api && typeof api.reload === 'function') api.reload();
    else window.location.reload();
  } catch {
    // Nothing to do: the note still says what would help.
  }
}

/**
 * Whether this document's enforced frame-src lets the map in (decision D48 of
 * docs/plans/2026-11-02-sandboxed-custom-code.md). Only a runtime that says it was
 * served without the maps cookie refuses: a frame drawn then would only show the
 * browser's blocked-content page, so the placeholder stays.
 */
function frameAllowed(): boolean {
  return consentApi()?.mapsAtLoad !== false;
}

/**
 * Whether a reload would bring the map: the maps cookie the yes wrote is set. When the
 * browser blocks cookies it never is, the next document would be served without it
 * again, so nothing but "Open in Google Maps" helps.
 */
function cookieKept(): boolean {
  const read = consentApi()?.mapsAllowed;
  return typeof read === 'function' ? read() === true : true;
}

function consentApi(): ConsentApi | undefined {
  return (window as unknown as { __lumitraConsent?: ConsentApi }).__lumitraConsent;
}

/**
 * The session key naming the map box whose "Load map" asked, kept across the reload a
 * yes may cause (decision D48 of docs/plans/2026-11-02-sandboxed-custom-code.md): the
 * new page focuses that map's frame once, as the same page would have. Written only on
 * that reload (the runtime's `lumitra:maps-reload`, or this box's own reload button), so
 * a banner closed without a yes leaves nothing behind. One shot: the first page load on
 * the same path reads it and removes it.
 */
export const MAP_FOCUS_KEY = 'fc-map-focus';

interface MapFocusMark {
  path: string;
  index: number;
}

/** This box's position among the page's map boxes (their light copies), or -1. */
function boxIndex(box: HTMLElement | null): number {
  if (!box) return -1;
  const boxes = Array.from(document.querySelectorAll('[data-fc-map-placeholder]')).map((placeholder) => placeholder.parentElement);
  return boxes.indexOf(box);
}

function writeFocusMark(mark: MapFocusMark | null): void {
  try {
    if (mark) window.sessionStorage.setItem(MAP_FOCUS_KEY, JSON.stringify(mark));
    else window.sessionStorage.removeItem(MAP_FOCUS_KEY);
  } catch {
    // Storage that throws: the new page just does not move focus.
  }
}

function readFocusMark(): MapFocusMark | null {
  try {
    const raw = window.sessionStorage.getItem(MAP_FOCUS_KEY);
    if (!raw) return null;
    const mark = JSON.parse(raw) as Partial<MapFocusMark> | null;
    return mark && typeof mark.path === 'string' && typeof mark.index === 'number' ? { path: mark.path, index: mark.index } : null;
  } catch {
    return null;
  }
}

/** The box whose "Load map" opened the banner last: the one a maps reload focuses. */
let lastAsker: HTMLElement | null = null;

export interface MapEmbedIslandProps {
  /** The box's DOM props, through the render gate and without the map settings. */
  domProps: Record<string, unknown>;
  /** The map settings (mapUrl, mapAddress, mapTitle, mapLanguage), read again here. */
  config: Record<string, unknown>;
}

export default function MapEmbedIsland({ domProps, config }: MapEmbedIslandProps) {
  const view = readMapEmbed(config);
  const [granted, setGranted] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  // Set when this map's "Load map" asked: once the banner's "yes" shows the map, focus
  // goes to it instead of being lost with the button.
  const asked = useRef(false);

  // A focus mark left by this box before a reload: focus the frame once it is drawn.
  const focusOnShow = useRef(false);
  useEffect(() => {
    const mark = readFocusMark();
    if (!mark) return;
    if (mark.path !== window.location.pathname) {
      writeFocusMark(null);
      return;
    }
    // Another box on this page asked: its island reads the mark.
    if (mark.index !== boxIndex(host.current)) return;
    writeFocusMark(null);
    focusOnShow.current = true;
  }, []);

  useEffect(() => {
    if (consentApi()?.get?.('maps') === 'granted') setGranted(true);
    const onConsent = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown> | null>).detail;
      if (detail && typeof detail.maps === 'boolean') setGranted(detail.maps);
    };
    window.addEventListener('lumitra:consent', onConsent);
    return () => window.removeEventListener('lumitra:consent', onConsent);
  }, []);

  // A yes that reloads the page: the map whose "Load map" opened the banner leaves the
  // mark that focuses it on the new page (MAP_FOCUS_KEY). The last box to ask is the one.
  useEffect(() => {
    const onReload = (event: Event) => {
      const detail = (event as CustomEvent<{ fromMap?: unknown } | null>).detail;
      if (detail?.fromMap !== true || lastAsker !== host.current || !host.current) return;
      writeFocusMark({ path: window.location.pathname, index: boxIndex(host.current) });
    };
    window.addEventListener('lumitra:maps-reload', onReload);
    return () => window.removeEventListener('lumitra:maps-reload', onReload);
  }, []);

  const load = useCallback(() => {
    const api = consentApi();
    if (api && typeof api.open === 'function') {
      asked.current = true;
      lastAsker = host.current;
      api.open('maps');
      return;
    }
    // Every page of a site with a map carries the runtime (renderPublishedPage). Without
    // it nobody can be asked, so nothing loads: a renderer bug, said loudly.
    // "Open in Google Maps" still takes the visitor to the map.
    console.error('[map] no consent runtime on this page: the map cannot ask for consent, so it does not load');
  }, []);

  // The platform's own part of the box lives in a shadow root, which no stored rule
  // reaches: a page can restyle the box itself, never hide the note or stretch the
  // button inside it. Attached after hydration, so server and client agree; from then
  // on the light copy below (the server's, for a page without JavaScript) is no longer
  // drawn, because a shadow host shows its shadow tree instead of its children.
  // A layout effect: the root is attached and filled in one synchronous commit, so no
  // moment exists where the box shows an empty shadow tree (nothing at all). With a
  // passive effect that moment was visible to anything that looked between the two
  // renders (the render gate on a slower runner caught it).
  const host = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    try {
      setShadow(el.shadowRoot ?? el.attachShadow({ mode: 'open' }));
    } catch (error) {
      // Only an element that cannot host one throws, which a div never is: said loudly.
      console.error('[map] could not shield the map placeholder from page styles', error);
    }
  }, []);

  const src = view.src;
  // Read only once granted, which happens in an effect: the server render has no window.
  const allowed = granted ? frameAllowed() : true;
  const show = granted && allowed && isRebuiltMapSrc(src);
  // A yes this page's policy cannot honour (storage blocked, so no reload carried it):
  // the placeholder says so and offers the reload, which the cookie already allows.
  // Unless the cookie did not stick (the browser blocks cookies): then no reload helps,
  // and the placeholder says the map cannot be shown here, with only the Google link.
  const refused = granted && !allowed && isRebuiltMapSrc(src);
  const kept = refused ? cookieKept() : true;
  const needsReload = refused && kept;
  const cookiesBlocked = refused && !kept;
  // A yes held because the visitor typed on the page: the note says a reload clears it.
  const reloadClears = needsReload && consentApi()?.edited?.() === true;
  const reloadHere = useCallback(() => {
    // This box's own reload: the new page focuses it, as after the runtime's.
    if (host.current) writeFocusMark({ path: window.location.pathname, index: boxIndex(host.current) });
    reloadPage();
  }, []);

  // After this box asked, focus goes where the answer leads: the map, or the reload
  // button, never lost with the "Load map" button. A mark from before a reload does the same.
  useEffect(() => {
    if (!granted) return;
    const fromMark = focusOnShow.current && show;
    if (!asked.current && !fromMark) return;
    asked.current = false;
    focusOnShow.current = false;
    writeFocusMark(null);
    const active = document.activeElement;
    if (active && active !== document.body && !fromMark) return;
    if (show) frame.current?.focus();
    else if (needsReload) (shadow?.querySelector('[data-fc-map-reload]') as HTMLElement | null)?.focus();
    else if (cookiesBlocked) (shadow?.querySelector('[data-fc-map-open]') as HTMLElement | null)?.focus();
  }, [granted, show, needsReload, cookiesBlocked, shadow]);
  const own = show ? (
    <iframe
      ref={frame}
      data-fc-map-frame=""
      src={src}
      title={view.title}
      loading="lazy"
      // The origin only: what a restricted Maps Embed API key checks.
      referrerPolicy="strict-origin-when-cross-origin"
      // Tested against Google's real embed in Chromium and WebKit on 2026-11-02: the map
      // draws and its links open with exactly these. No top navigation, no forms,
      // no downloads, and of the powerful features only fullscreen.
      sandbox={MAP_FRAME_SANDBOX}
      allow="fullscreen"
      allowFullScreen
      style={MAP_FRAME_STYLE}
    />
  ) : (
    mapPlaceholder(view, { onLoad: load, liveLink: true, onReload: needsReload ? reloadHere : undefined, cookiesBlocked, reloadClears })
  );
  return React.createElement(
    'div',
    { ...domProps, ref: host },
    // The light copy: what the server rendered and a page without JavaScript shows.
    // Its button does nothing (no script, nothing to ask with); the link works.
    mapPlaceholder(view, { liveLink: true }),
    shadow ? createPortal(<div data-fc-map-root="" style={MAP_SHADOW_ROOT_STYLE}>{own}</div>, shadow) : null,
  );
}
