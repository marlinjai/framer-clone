// The page generator and the Google Maps embed: the model only places a map and
// titles it. The address is the Site settings', an embed address or an iframe the
// model writes never survives, and without an address there is no map.

import { describe, expect, it } from 'vitest';
import { validateGeneration } from '../validate';
import { deriveBreakpointKeys } from '../schema';
import { stableSystemText } from '../prompt';
import { siteAddressOf } from '../promptSections/siteContext';
import { isMapEmbed } from '@/lib/mapEmbed/mapEmbed';

const breakpoints = deriveBreakpointKeys([
  { label: 'Desktop', minWidth: 1280 },
  { label: 'Mobile', minWidth: 320 },
]);
const ADDRESS = 'Hauptstraße 1, 10115 Berlin, DE';

function run(nodes: unknown[], mapAddress: string | null = ADDRESS) {
  let n = 0;
  const out = validateGeneration({ nodes }, { breakpoints, newId: () => `id${(n += 1)}`, mapAddress });
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.result;
}

const section = (...children: unknown[]) => ({ type: 'section', label: 'Contact', children });
const mapOf = (props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ type: 'div', preset: 'mapEmbed', label: 'Map', props, ...extra });

describe('the mapEmbed preset in a generation', () => {
  it('gets the Site settings address whatever the model wrote, and keeps only its title', () => {
    const result = run([section(mapOf({ mapTitle: 'Map: Bakery', mapAddress: 'Somewhere invented 9', mapUrl: 'https://www.google.com/maps/embed?pb=!1m2', style: { height: '360px' } }))]);
    const map = result.nodes[0].children[0];
    expect(isMapEmbed(map.props)).toBe(true);
    expect(map.props.mapAddress).toBe(ADDRESS);
    expect(map.props.mapTitle).toBe('Map: Bakery');
    expect(map.props).not.toHaveProperty('mapUrl');
    expect(result.warnings.some((w) => w.includes('mapUrl is not generated'))).toBe(true);
  });

  it('drops a map when the Site settings hold no address', () => {
    const result = run([section(mapOf()), { type: 'p', props: { children: 'x' } }], null);
    expect(result.nodes[0].children).toEqual([]);
    expect(result.warnings.some((w) => w.includes('needs the business address'))).toBe(true);
  });

  it('keeps one map, without children or text', () => {
    const result = run([section(mapOf({ children: 'text' }, { children: [{ type: 'p', props: { children: 'x' } }] }), mapOf())]);
    const kept = result.nodes[0].children;
    expect(kept).toHaveLength(1);
    expect(kept[0].children).toEqual([]);
    expect(kept[0].props).not.toHaveProperty('children');
    expect(result.warnings.some((w) => w.includes('at most one Google map'))).toBe(true);
  });

  it('never lets a raw iframe through, a Google one included', () => {
    const out = validateGeneration(
      { nodes: [section({ type: 'iframe', props: { src: 'https://www.google.com/maps/embed?pb=!1m2' } }), { type: 'p', props: { children: 'x' } }] },
      { breakpoints, mapAddress: ADDRESS },
    );
    const types = JSON.stringify(out.ok ? out.result.nodes : []);
    expect(types).not.toContain('iframe');
  });

  it('teaches the preset and its rules in the cached prompt', () => {
    const prompt = stableSystemText();
    expect(prompt).toContain('"preset":"mapEmbed"');
    expect(prompt).toContain('Never write mapUrl, mapAddress, an iframe');
  });

  it('builds the address the generator is given from the Site settings fields', () => {
    expect(siteAddressOf({ street: 'Hauptstraße 1', postalCode: '10115', city: 'Berlin', country: 'DE' })).toBe(ADDRESS);
    expect(siteAddressOf({ street: '', postalCode: '', city: '', country: '' })).toBe('');
  });
});
