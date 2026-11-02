// The Google Maps embed's parser and props (src/lib/mapEmbed/mapEmbed.ts): what an
// owner may paste, what is rebuilt from it, and what is refused.

import { describe, expect, it } from 'vitest';
import {
  addressMapSrc,
  cleanMapEmbedProp,
  isMapEmbed,
  isRebuiltMapSrc,
  openInMapsHref,
  parseMapEmbed,
  readMapEmbed,
  stripMapEmbedProps,
  treesHoldMapEmbed,
  withMapLanguage,
} from '../mapEmbed';

// The shape Google's Share, Embed a map dialog gives (coordinates and a place id, a name percent-encoded).
const PB =
  '!1m18!1m12!1m3!1d2419.6!2d13.2834!3d52.6871!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x47a85f0f%3A0x1c1c!2sWerkstatt%20Birkenwerder!5e0!3m2!1sde!2sde!4v1730000000000!5m2!1sde!2sde';
const SHARE = `https://www.google.com/maps/embed?pb=${PB}`;
const SNIPPET = `<iframe src="${SHARE}" width="600" height="450" style="border:0;" allowfullscreen="" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
const KEY = 'AIzaSyD-test_key_0123456789abcdefgh';

const parsed = (input: unknown) => {
  const result = parseMapEmbed(input);
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.map;
};
const refused = (input: unknown) => {
  const result = parseMapEmbed(input);
  expect(result.ok, String(input)).toBe(false);
  return result.ok ? '' : result.error;
};

describe('parseMapEmbed', () => {
  it('keeps the Share dialog address exactly, and reads its coordinates for the open link', () => {
    const map = parsed(SHARE);
    expect(map).toEqual({ src: SHARE, form: 'share', query: '52.6871,13.2834' });
  });

  it('reads src out of the pasted embed code, with the entities the dialog writes', () => {
    expect(parsed(SNIPPET).src).toBe(SHARE);
    expect(parsed(`<iframe src='${SHARE.replace('pb=', 'pb=')}&amp;extra=1'></iframe>`).src).toBe(SHARE);
    expect(refused('<div>no map here</div>')).toMatch(/holds no map/);
  });

  it('rebuilds a Maps Embed API address from the parameters its mode documents', () => {
    const map = parsed(`https://www.google.com/maps/embed/v1/place?key=${KEY}&q=Hauptstra%C3%9Fe+1,+Berlin&zoom=15&maptype=satellite&tracking=1&callback=x`);
    expect(map.form).toBe('embed-api');
    expect(map.src).toBe(`https://www.google.com/maps/embed/v1/place?key=${KEY}&q=${encodeURIComponent('Hauptstraße 1, Berlin')}&zoom=15&maptype=satellite`);
    expect(map.query).toBe('Hauptstraße 1, Berlin');
    expect(parsed(`https://www.google.com/maps/embed/v1/view?key=${KEY}&center=52.52,13.40&zoom=12`).query).toBe('52.52,13.40');
    expect(parsed(`https://www.google.com/maps/embed/v1/directions?key=${KEY}&origin=A&destination=B&mode=walking&avoid=tolls|ferries`).src)
      .toBe(`https://www.google.com/maps/embed/v1/directions?key=${KEY}&origin=A&destination=B&mode=walking&avoid=tolls%7Cferries`);
    expect(parsed(`https://www.google.com/maps/embed/v1/streetview?key=${KEY}&location=52.52,13.40&heading=210&pitch=10&fov=35`).form).toBe('embed-api');
  });

  it('drops a parameter value that is out of range, and refuses a mode without what it requires', () => {
    expect(parsed(`https://www.google.com/maps/embed/v1/place?key=${KEY}&q=Berlin&zoom=99&maptype=terrain`).src).toBe(`https://www.google.com/maps/embed/v1/place?key=${KEY}&q=Berlin`);
    expect(refused(`https://www.google.com/maps/embed/v1/place?key=${KEY}`)).toMatch(/missing q/);
    expect(refused(`https://www.google.com/maps/embed/v1/directions?key=${KEY}&origin=A`)).toMatch(/origin and destination/);
    expect(refused(`https://www.google.com/maps/embed/v1/place?q=Berlin`)).toMatch(/key/);
    expect(refused(`https://www.google.com/maps/embed/v1/js?key=${KEY}&q=x`)).toMatch(/no "js" embed/);
  });

  it('rebuilds the keyless query form on www.google.com, from maps.google.com too', () => {
    expect(parsed('https://maps.google.com/maps?q=Birkenwerder&z=14&t=k&output=embed&iwloc=near').src).toBe('https://www.google.com/maps?q=Birkenwerder&z=14&t=k&output=embed');
    expect(refused('https://www.google.com/maps?q=Birkenwerder')).toMatch(/not an embed/);
    expect(refused('https://www.google.com/maps?output=embed')).toMatch(/no place/);
  });

  it('refuses every other host, scheme and shape', () => {
    for (const input of [
      'https://evil.test/maps/embed?pb=!1m2',
      'https://www.google.com.evil.test/maps/embed?pb=!1m2',
      'https://www.google.de/maps/embed?pb=!1m2',
      'http://www.google.com/maps/embed?pb=!1m2',
      'https://user:pw@www.google.com/maps/embed?pb=!1m2',
      'https://www.google.com:8443/maps/embed?pb=!1m2',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      '//www.google.com/maps/embed?pb=!1m2',
      'https://www.google.com/search?q=x',
      '',
      '   ',
      42,
      null,
      `https://www.google.com/maps/embed?pb=${'x'.repeat(5000)}`,
    ]) {
      refused(input);
    }
  });

  it('never rebuilds a pb that could break out of the address: encoded by the parser, or refused', () => {
    for (const pb of ['!1m2"onload="x', '!1m2<script>', '!1m2 x', "!1m2'", '!1m2#frag']) {
      const result = parseMapEmbed(`https://www.google.com/maps/embed?pb=${pb}`);
      if (result.ok) expect(result.map.src, pb).toMatch(/^https:\/\/www\.google\.com\/maps\/embed\?pb=[A-Za-z0-9!._~*:+%-]+$/);
    }
    expect(parseMapEmbed('https://www.google.com/maps/embed?pb=!1m2%zz').ok).toBe(false);
    expect(parseMapEmbed('https://www.google.com/maps/embed?pb=!1m2&pb=!2m3').ok && parsed('https://www.google.com/maps/embed?pb=!1m2&pb=!2m3').src)
      .toBe('https://www.google.com/maps/embed?pb=!1m2');
  });

  it('never lets free text carry markup or control characters', () => {
    expect(refused(`https://www.google.com/maps/embed/v1/place?key=${KEY}&q=%3Cscript%3E`)).toMatch(/missing q/);
    expect(refused('https://www.google.com/maps?q=a%00b&output=embed')).toMatch(/no place/);
    // A line break is whitespace, which becomes one space.
    expect(parsed('https://www.google.com/maps?q=a%0Ab&output=embed').src).toBe('https://www.google.com/maps?q=a%20b&output=embed');
  });
});

describe('isRebuiltMapSrc', () => {
  it('accepts only an address this module builds, unchanged', () => {
    expect(isRebuiltMapSrc(SHARE)).toBe(true);
    expect(isRebuiltMapSrc(addressMapSrc('Hauptstraße 1, 10115 Berlin'))).toBe(true);
    expect(isRebuiltMapSrc(`${SHARE}&x=1`)).toBe(false);
    expect(isRebuiltMapSrc('https://maps.google.com/maps?q=x&output=embed')).toBe(false);
    expect(isRebuiltMapSrc('https://evil.test/')).toBe(false);
    expect(isRebuiltMapSrc(null)).toBe(false);
  });
});

describe('readMapEmbed', () => {
  it('uses a valid URL, the address as the placeholder text and the open link', () => {
    const view = readMapEmbed({ mapUrl: SHARE, mapAddress: 'Werkstatt, Birkenwerder', mapLanguage: 'de-DE' });
    expect(view.src).toBe(SHARE);
    expect(view.title).toBe('Karte: Werkstatt, Birkenwerder');
    expect(view.openHref).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('Werkstatt, Birkenwerder')}`);
    expect(view.copy.load).toBe('Karte laden');
    expect(view.urlError).toBeNull();
  });

  it('falls back to the address when the URL is refused, and says why', () => {
    const view = readMapEmbed({ mapUrl: 'https://evil.test/x', mapAddress: 'Berlin' });
    expect(view.src).toBe('https://www.google.com/maps?q=Berlin&output=embed');
    expect(view.urlError).toMatch(/Only Google Maps/);
  });

  it('has no map without a usable URL or address', () => {
    expect(readMapEmbed({}).src).toBeNull();
    expect(readMapEmbed({ mapAddress: '<b>x</b>' }).src).toBeNull();
    expect(readMapEmbed(null).openHref).toBeNull();
    expect(readMapEmbed({ mapAddress: 'Berlin', mapTitle: 'Our shop' }).title).toBe('Our shop');
  });

  it('opens the coordinates of a Share address without an address', () => {
    expect(readMapEmbed({ mapUrl: SHARE }).openHref).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('52.6871,13.2834')}`);
    expect(openInMapsHref(null)).toBeNull();
  });
});

describe('props and trees', () => {
  it('knows its marker and strips its settings from the DOM props', () => {
    expect(isMapEmbed({ 'data-map-embed': 'google' })).toBe(true);
    expect(isMapEmbed({ 'data-map-embed': 'yes' })).toBe(false);
    expect(stripMapEmbedProps({ 'data-map-embed': 'google', mapUrl: SHARE, mapAddress: 'x', mapTitle: 't', mapLanguage: 'de', id: 'a', children: 'c' }))
      .toEqual({ 'data-map-embed': 'google', id: 'a' });
  });

  it('cleans a generated or typed value', () => {
    expect(cleanMapEmbedProp('mapUrl', SNIPPET)).toBe(SHARE);
    expect(cleanMapEmbedProp('mapUrl', 'https://evil.test')).toBeUndefined();
    expect(cleanMapEmbedProp('mapAddress', '  Haupt   straße 1 ')).toBe('Haupt straße 1');
    expect(cleanMapEmbedProp('mapTitle', 'x'.repeat(201))).toBeUndefined();
    expect(cleanMapEmbedProp('mapLanguage', 'de')).toBeUndefined();
  });

  it('finds a map in a tree and writes the site language onto it, without touching the input', () => {
    const map = { props: { 'data-map-embed': 'google', mapAddress: 'Berlin' }, children: [] };
    const root = { props: {}, children: [{ props: {}, children: [map] }, { props: { id: 'other' }, children: [] }] };
    expect(treesHoldMapEmbed([root])).toBe(true);
    expect(treesHoldMapEmbed([{ props: {}, children: [] }, null])).toBe(false);
    const out = withMapLanguage(root, 'de');
    expect(out.hasMap).toBe(true);
    expect(out.root.children[0].children[0].props).toEqual({ 'data-map-embed': 'google', mapAddress: 'Berlin', mapLanguage: 'de' });
    expect(out.root.children[1]).toBe(root.children[1]);
    expect(map.props).not.toHaveProperty('mapLanguage');
    const none = { props: {}, children: [] };
    expect(withMapLanguage(none, 'de')).toEqual({ root: none, hasMap: false });
  });
});
