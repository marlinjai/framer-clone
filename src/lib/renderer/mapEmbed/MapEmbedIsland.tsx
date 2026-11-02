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
// The frame's address is checked once more right before it is drawn
// (isRebuiltMapSrc): nothing but an address this platform rebuilt can become an
// iframe's `src`. A React island rather than a runtime that rewrites the DOM, so it
// works inside other islands (a form, a commerce block) without fighting hydration.

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isRebuiltMapSrc, readMapEmbed } from '@/lib/mapEmbed/mapEmbed';
import { MAP_FRAME_SANDBOX, MAP_FRAME_STYLE, mapPlaceholder } from './mapEmbedElement';

interface ConsentApi {
  get?: (category?: string) => string | null;
  open?: (category?: string) => void;
}

function consentApi(): ConsentApi | undefined {
  return (window as unknown as { __lumitraConsent?: ConsentApi }).__lumitraConsent;
}

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

  useEffect(() => {
    if (!granted || !asked.current) return;
    asked.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) frame.current?.focus();
  }, [granted]);

  useEffect(() => {
    if (consentApi()?.get?.('maps') === 'granted') setGranted(true);
    const onConsent = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown> | null>).detail;
      if (detail && typeof detail.maps === 'boolean') setGranted(detail.maps);
    };
    window.addEventListener('lumitra:consent', onConsent);
    return () => window.removeEventListener('lumitra:consent', onConsent);
  }, []);

  const load = useCallback(() => {
    const api = consentApi();
    if (api && typeof api.open === 'function') {
      asked.current = true;
      api.open('maps');
      return;
    }
    // Every page of a site with a map carries the runtime (renderPublishedPage). Without
    // it nobody can be asked, so nothing loads: a renderer bug, said loudly.
    // "Open in Google Maps" still takes the visitor to the map.
    console.error('[map] no consent runtime on this page: the map cannot ask for consent, so it does not load');
  }, []);

  const src = view.src;
  const show = granted && isRebuiltMapSrc(src);
  return React.createElement(
    'div',
    domProps,
    show ? (
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
      mapPlaceholder(view, { onLoad: load, liveLink: true })
    ),
  );
}
