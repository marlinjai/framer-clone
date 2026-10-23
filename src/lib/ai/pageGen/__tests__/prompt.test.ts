// The generator's cached system prefix: the design brief distilled from the
// design skills (docs/plans/2026-10-23-ai-design-quality-and-image-focus.md)
// carries its concrete rules, stays within its word budget and never contains
// a long dash.

import { describe, expect, it } from 'vitest';
import { stableSystemText } from '../prompt';

const text = stableSystemText();
const brief = text.slice(0, text.indexOf('# Output format'));

describe('stableSystemText', () => {
  // Raised from 1200 to 1500 for the "Never" list of the eighteen tells of
  // generated design (docs/plans/2026-10-23-ai-design-quality-round-2.md):
  // the prefix is cache-read at a tenth of the input price, while every tell
  // the model makes anyway costs a whole repair attempt (up to 32k output
  // tokens), so naming them up front is the cheap side of the trade.
  it('keeps the design brief within its word budget (a cached prefix is still paid per request)', () => {
    expect(brief.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(1500);
  });

  it('never contains an em dash or en dash', () => {
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });

  it.each([
    ['layout variety', 'at least three different layout families'],
    ['zigzag cap', 'At most two image and text splits in a row'],
    ['colour zones', 'Alternate section backgrounds in zones'],
    ['hero in the first screen', 'Fits the first screen'],
    ['no viewport units', 'Never vh, svh or dvh'],
    ['hero text budget', 'at most 20 words'],
    ['overused hero', 'Left text with right image is the most overused hero'],
    ['system font stacks', 'no web fonts are loaded'],
    ['display ceiling', 'never above 96'],
    ['tracking floor', 'never tighter'],
    ['measure', '65 to 75 characters'],
    ['contrast', 'at least 4.5:1'],
    ['one accent', 'ONE sharp accent'],
    ['no eyebrows', 'eyebrow'],
    ['no equal cards', 'three identical cards'],
    ['no gradient text', 'gradient text'],
    ['image shapes', 'aspectRatio'],
    ['photo backgrounds', 'Put imageQuery on the section, header or div itself'],
    ['scrim', 'backgroundImage holding ONLY the scrim gradient'],
    ['fallback colour', 'shown if no photo is found'],
    ['the tells list', 'Never (tells of generated design'],
    ['no long dashes in copy', 'Em dashes or en dashes in copy'],
    ['banned typefaces', 'Inter, Geist or Space Grotesk'],
    ['no bento grids', 'Bento grids'],
    ['no purple on black', 'Purple or violet accents on near-black'],
    ['no orbs or dot grids', 'Radial-gradient orbs'],
    ['no terminals or fake screens', 'Terminal windows'],
    ["no \"not X, it's Y\" copy", "\"It's not X, it's Y\""],
    ['no button arrows', 'Arrow glyphs after button labels'],
    ['no hover everywhere', 'transition or transform on every card'],
    ['text off the subject', 'not\n  across the middle where the subject usually is'],
  ])('teaches %s', (_label, phrase) => {
    expect(text).toContain(phrase);
  });

  it('no longer recommends a bento grid as a layout family', () => {
    expect(text).not.toContain('bento grid with unequal cells');
  });

  it('documents photo backgrounds and crops in the output format', () => {
    expect(text).toContain('Photo backgrounds: an imageQuery on a container');
    expect(text).toContain('the server sets objectPosition (img) or backgroundPosition');
  });

  it('is deterministic (byte-identical, so the prompt cache hits)', () => {
    expect(stableSystemText()).toBe(text);
  });
});
