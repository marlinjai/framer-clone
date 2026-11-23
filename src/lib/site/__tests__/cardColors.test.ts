import { describe, it, expect } from 'vitest';
import { siteCardColors } from '../cardColors';
import { tokenReference, type SiteTheme, type ColorToken } from '../theme';

const color = (id: string, light: string, dark?: string, extra: Partial<ColorToken> = {}): ColorToken => ({
  id, name: id, kind: 'color', light, ...(dark ? { dark } : {}), ...extra,
});

describe('siteCardColors', () => {
  it('reads the document background and text and the first other colour token', () => {
    const theme: SiteTheme = {
      tokens: [color('bgbgbgbg', '#ffffff', '#000000'), color('txtxtxtx', '#111111', '#eeeeee'), color('accentaa', '#ff8800')],
      document: { backgroundColor: tokenReference('bgbgbgbg'), color: tokenReference('txtxtxtx') },
    };
    expect(siteCardColors(theme)).toEqual({ background: '#ffffff', text: '#111111', accent: '#ff8800' });
  });

  it("a forced dark site shows its dark values, as its published page does", () => {
    const theme: SiteTheme = {
      mode: 'dark',
      tokens: [color('bgbgbgbg', '#ffffff', '#000000'), color('accentaa', '#0000ff', '#88aaff')],
      document: { backgroundColor: tokenReference('bgbgbgbg') },
    };
    expect(siteCardColors(theme)).toEqual({ background: '#000000', text: '#f5f5f5', accent: '#88aaff' });
  });

  it('a theme with no colour at all draws the neutral picture (null)', () => {
    expect(siteCardColors({ tokens: [], document: {} })).toBeNull();
    expect(siteCardColors(undefined)).toBeNull();
  });

  it('never passes on a value that is not a colour, nor a deleted token', () => {
    const theme: SiteTheme = {
      tokens: [
        color('brokenaa', 'red; background:url(x)', undefined, { broken: true }),
        color('deadaaaa', '#123456', undefined, { deleted: true }),
        color('goodaaaa', '#00aa00'),
      ],
      document: {},
    };
    expect(siteCardColors(theme)).toEqual({ background: '#ffffff', text: '#111111', accent: '#00aa00' });
  });
});
