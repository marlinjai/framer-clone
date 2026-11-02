// src/lib/renderer/mapEmbed/mapEmbedElement.tsx
//
// The map embed box (src/lib/mapEmbed/mapEmbed.ts) as React elements, shared by
// every surface. PURE: no hooks, no MST, no window, no 'use client' and no
// server-only, because the published island, the preview and the editor canvas
// all draw the same placeholder.
//
//   - 'editor':    the placeholder where the box sits, with a label saying what
//                  it does; the button and the link are spans (a click selects
//                  the component). The map never loads: the canvas runs on the
//                  signed-in editor's origin, and nothing there contacts Google.
//   - 'preview':   the same placeholder with a real "Open in Google Maps" link;
//                  the preview is the editor's origin too, so no map either.
//   - published:   MapEmbedIsland draws mapPlaceholder with a working button and
//                  swaps it for the frame once the visitor consents.

import React from 'react';
import { MAP_EMBED_CANVAS_LABEL, readMapEmbed, stripMapEmbedProps, type MapEmbedView } from '@/lib/mapEmbed/mapEmbed';

export type MapEmbedSurface = 'editor' | 'preview';

/** The box's own content fills what the owner sized. */
export const MAP_FILL_STYLE: React.CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  height: '100%',
  minHeight: 200,
};

const PLACEHOLDER_STYLE: React.CSSProperties = {
  ...MAP_FILL_STYLE,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  padding: 16,
  overflow: 'auto',
  background: '#eef0f3',
  color: '#111827',
  fontFamily: 'inherit',
  fontSize: 14,
  lineHeight: 1.45,
  textAlign: 'center',
};

const BUTTON_STYLE: React.CSSProperties = {
  minHeight: 44,
  padding: '10px 18px',
  borderRadius: 8,
  border: '1px solid #111827',
  background: '#111827',
  color: '#ffffff',
  font: 'inherit',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
};

const LINK_STYLE: React.CSSProperties = {
  color: 'inherit',
  textDecoration: 'underline',
  fontWeight: 600,
};

/**
 * The root of the map's shadow tree (MapEmbedIsland). `all: initial` drops whatever
 * the page lets the box inherit (a transparent text colour, a zero font size, a
 * hidden visibility), then the platform's own look applies. Only what the box itself
 * is (its size, its own opacity, where it sits) stays the page's.
 */
export const MAP_SHADOW_ROOT_STYLE: React.CSSProperties = {
  all: 'initial',
  display: 'block',
  boxSizing: 'border-box',
  width: '100%',
  height: '100%',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  color: '#111827',
  visibility: 'visible',
};

/** What Google's embed needs to draw and to open its own links in a new tab, and nothing more. */
export const MAP_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox';

/** The frame's style: the box's size, no border, a usable height when the box sets none. */
export const MAP_FRAME_STYLE: React.CSSProperties = {
  ...MAP_FILL_STYLE,
  display: 'block',
  border: 0,
  minHeight: 240,
};

const CANVAS_LABEL_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 8,
  transform: 'translateY(-100%)',
  padding: '2px 6px',
  borderRadius: '4px 4px 0 0',
  background: '#2563eb',
  color: '#ffffff',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 10,
  fontWeight: 600,
  lineHeight: 1.4,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  userSelect: 'none',
};

export interface MapPlaceholderOptions {
  /** The real button (published); without it the button is an inert span. */
  onLoad?: () => void;
  /** Whether "Open in Google Maps" is a real link (not on the canvas). */
  liveLink: boolean;
}

/**
 * The placeholder: the address, a note that loading the map sends data to Google,
 * the "Load map" button and "Open in Google Maps", a plain link that needs no consent.
 */
export function mapPlaceholder(view: MapEmbedView, { onLoad, liveLink }: MapPlaceholderOptions): React.ReactElement {
  const { copy } = view;
  return (
    <div data-fc-map-placeholder="" role="group" aria-label={copy.region} style={PLACEHOLDER_STYLE}>
      {view.address ? <p style={{ margin: 0, fontWeight: 600, fontSize: 16 }}>{view.address}</p> : null}
      {view.src ? (
        <>
          <p style={{ margin: 0, maxWidth: 420, fontSize: 13 }}>{copy.note}</p>
          {onLoad ? (
            <button type="button" data-fc-map-load="" onClick={onLoad} style={BUTTON_STYLE}>
              {copy.load}
            </button>
          ) : (
            <span data-fc-map-load="" style={{ ...BUTTON_STYLE, display: 'inline-flex', alignItems: 'center', cursor: 'default' }}>
              {copy.load}
            </span>
          )}
        </>
      ) : (
        <p style={{ margin: 0, fontSize: 13 }}>{copy.empty}</p>
      )}
      {view.openHref ? (
        liveLink ? (
          <a data-fc-map-open="" href={view.openHref} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
            {copy.open}
          </a>
        ) : (
          <span data-fc-map-open="" style={LINK_STYLE}>
            {copy.open}
          </span>
        )
      ) : null}
    </div>
  );
}

/**
 * The box on an editor surface. `props` go on the element, so they have been through
 * the render gate. `config` holds the map settings, which the gate rightly drops as
 * attributes: readMapEmbed checks them itself.
 */
export function createMapEmbedElement(
  props: Record<string, unknown>,
  surface: MapEmbedSurface,
  key?: React.Key,
  config: Record<string, unknown> = props,
): React.ReactElement {
  const view = readMapEmbed(config);
  const domProps = stripMapEmbedProps(props);
  if (surface === 'editor') {
    const style = { ...((domProps.style as React.CSSProperties | undefined) ?? {}), position: 'relative' as const };
    return React.createElement(
      'div',
      { ...domProps, key, style, 'aria-label': MAP_EMBED_CANVAS_LABEL },
      <span data-fc-map-label="" aria-hidden="true" style={CANVAS_LABEL_STYLE}>
        Google Maps · loads after consent
      </span>,
      mapPlaceholder(view, { liveLink: false }),
    );
  }
  return React.createElement('div', { ...domProps, key }, mapPlaceholder(view, { liveLink: true }));
}
