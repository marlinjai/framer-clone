// src/lib/renderer/mapEmbed/MapEmbedIsland.tsx
//
// The published map embed (src/lib/mapEmbed/mapEmbed.ts): a client island the
// server renderer (renderComponentNode) emits for a map box. The server renders
// the placeholder, and so does the first client render, so hydration agrees and
// nothing of Google is in the HTML. The frame exists only in React state:
//
//   - on hydration, a stored "yes" to the `maps` consent category shows the map;
//   - "Load map" records that yes through the page's consent runtime
//     (`window.__lumitraConsent.grant('maps')`, src/lib/consent/consent.ts), which
//     announces it to every map on the page;
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
import { MAP_FRAME_STYLE, mapPlaceholder } from './mapEmbedElement';

interface ConsentApi {
  get?: (category?: string) => string | null;
  grant?: (category: string) => void;
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
  const focusFrame = useRef(false);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (consentApi()?.get?.('maps') === 'granted') setGranted(true);
    const onConsent = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown> | null>).detail;
      if (detail && typeof detail.maps === 'boolean') setGranted(detail.maps);
    };
    window.addEventListener('lumitra:consent', onConsent);
    return () => window.removeEventListener('lumitra:consent', onConsent);
  }, []);

  useEffect(() => {
    if (granted && focusFrame.current) {
      focusFrame.current = false;
      frame.current?.focus();
    }
  }, [granted]);

  const load = useCallback(() => {
    focusFrame.current = true;
    const api = consentApi();
    if (api && typeof api.grant === 'function') {
      api.grant('maps');
      // The runtime announces it; a page view whose storage throws still answers here.
      if (api.get?.('maps') === 'granted') setGranted(true);
      return;
    }
    // Every page with a map carries the runtime (renderPublishedPage). Without it the
    // visitor's click is still the consent, for this page view only.
    console.warn('[map] no consent runtime on this page: the map loads for this page view only');
    setGranted(true);
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
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
        style={MAP_FRAME_STYLE}
      />
    ) : (
      mapPlaceholder(view, { onLoad: load, liveLink: true })
    ),
  );
}
