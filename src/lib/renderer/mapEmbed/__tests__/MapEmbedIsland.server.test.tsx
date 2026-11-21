// @vitest-environment node
// The map island as the published page's server renders it: no window, so nothing the
// island reads from the consent runtime may be touched before hydration.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MapEmbedIsland from '../MapEmbedIsland';

const SHARE = 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2419.6!2d13.2834!3d52.6871!5e0';

describe('the map island on the server', () => {
  it('renders its placeholder without a window', () => {
    expect(typeof window).toBe('undefined');
    const markup = renderToStaticMarkup(<MapEmbedIsland domProps={{}} config={{ mapUrl: SHARE, mapAddress: 'Werkstatt', mapLanguage: 'en' }} />);
    expect(markup).toContain('data-fc-map-placeholder');
    expect(markup).toContain('Load map');
    expect(markup).not.toContain('<iframe');
  });
});
