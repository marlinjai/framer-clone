// The validator's part of the page essentials (decision 7): alt text is kept
// as the model wrote it (never filled from the label or with "Image"), a
// decorative image becomes alt "" plus data-decorative, and the sticky call to
// action is accepted only on a new page, at most once, as the last top-level
// node, with a label and a safe link. The prompt tells the model all of it.

import { describe, expect, it } from 'vitest';
import { validateGeneration, type GeneratedNodeSnapshot } from '../validate';
import { DECORATIVE_ATTR, deriveBreakpointKeys } from '../schema';
import { stableSystemText } from '../prompt';
import { STICKY_CTA_ATTR } from '@/lib/stickyCta/stickyCta';

const breakpoints = deriveBreakpointKeys([
  { label: 'Desktop', minWidth: 1280 },
  { label: 'Mobile', minWidth: 320 },
]);

function run(nodes: unknown[], allowStickyCta = true) {
  let n = 0;
  const out = validateGeneration({ nodes }, { breakpoints, allowStickyCta, newId: () => `id${(n += 1)}` });
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.result;
}

const sticky = (props: Record<string, unknown> = {}) => ({
  type: 'div',
  preset: 'stickyCta',
  label: 'Sticky call to action',
  props: { ctaLabel: 'Book a table', ctaHref: 'tel:+49301234', ...props },
});
const hero = { type: 'section', label: 'Hero', children: [{ type: 'h1', props: { children: 'Hi' } }] };
const isBar = (node: GeneratedNodeSnapshot) => node.props[STICKY_CTA_ATTR] === 'bar';

describe('alt text in the validator', () => {
  it('keeps the model alt, and leaves a missing one missing (no preset "Image" default)', () => {
    const result = run([
      { type: 'img', preset: 'image', label: 'Hero photo', props: { imageQuery: 'pasta on a table' } },
      { type: 'img', label: 'Team', props: { alt: 'Our team at the summer party' } },
      { type: 'img', label: 'Blank', props: { alt: '   ' } },
    ]);
    const [a, b, c] = result.nodes;
    expect(a.props).not.toHaveProperty('alt');
    expect(b.props.alt).toBe('Our team at the summer party');
    expect(c.props).not.toHaveProperty('alt');
  });

  it('turns decorative: true into alt "" plus the decorative marker, whatever alt was sent', () => {
    const result = run([{ type: 'img', props: { decorative: true, alt: 'texture', imageQuery: 'paper texture' } }]);
    expect(result.nodes[0].props.alt).toBe('');
    expect(result.nodes[0].props[DECORATIVE_ATTR]).toBe('true');
    expect(result.nodes[0].props).not.toHaveProperty('decorative');
  });

  it('keeps an echoed decorative image and refuses a non-boolean flag', () => {
    const echoed = run([{ type: 'img', props: { alt: '', [DECORATIVE_ATTR]: 'true', src: '/x.jpg' } }]);
    expect(echoed.nodes[0].props).toMatchObject({ alt: '', [DECORATIVE_ATTR]: 'true' });
    const odd = run([{ type: 'img', props: { decorative: 'yes', alt: 'A dog on a beach' } }]);
    expect(odd.nodes[0].props[DECORATIVE_ATTR]).toBeUndefined();
    expect(odd.nodes[0].props.alt).toBe('A dog on a beach');
    expect(odd.warnings.join('\n')).toMatch(/decorative must be true or false/);
  });
});

describe('the sticky call to action in the validator', () => {
  it('keeps one bar with its cleaned link props as the last top-level node', () => {
    const result = run([sticky({ buttonBackground: '#b45309', style: { backgroundColor: '#fff' } }), hero]);
    expect(result.nodes.map((node) => node.label)).toEqual(['Hero', 'Sticky call to action']);
    const bar = result.nodes[1];
    expect(bar.props).toMatchObject({
      [STICKY_CTA_ATTR]: 'bar',
      ctaLabel: 'Book a table',
      ctaHref: 'tel:+49301234',
      buttonBackground: '#b45309',
    });
    expect(bar.parentId).toBeUndefined();
    expect(bar.children).toEqual([]);
  });

  it('moves a nested bar to the top level and drops a second one', () => {
    const result = run([
      { type: 'section', label: 'Contact', children: [{ type: 'h2', props: { children: 'Visit' } }, sticky()] },
      sticky({ ctaLabel: 'Call us' }),
    ]);
    expect(result.nodes.map((node) => node.label)).toEqual(['Contact', 'Sticky call to action']);
    expect(result.nodes[0].children.some(isBar)).toBe(false);
    expect(result.nodes[1].props.ctaLabel).toBe('Book a table');
    expect(result.warnings.join('\n')).toMatch(/at most one sticky call to action per page/);
  });

  it('drops the bar in a section generation', () => {
    const result = run([hero, sticky()], false);
    expect(result.nodes.some(isBar)).toBe(false);
    expect(result.warnings.join('\n')).toMatch(/belongs to a whole page, not a section/);
  });

  it('drops a bar without a label or with an unsafe link, and cleans bad colours', () => {
    const noHref = run([hero, sticky({ ctaHref: 'javascript:alert(1)' })]);
    expect(noHref.nodes.some(isBar)).toBe(false);
    expect(noHref.warnings.join('\n')).toMatch(/ctaHref of the sticky call to action is not usable/);
    expect(noHref.warnings.join('\n')).toMatch(/needs a ctaLabel and a ctaHref/);

    const noLabel = run([hero, sticky({ ctaLabel: '' })]);
    expect(noLabel.nodes.some(isBar)).toBe(false);

    const badColour = run([hero, sticky({ buttonBackground: 'red;position:fixed' })]);
    const bar = badColour.nodes.find(isBar)!;
    // The preset default stays, the injected value never reaches the props.
    expect(bar.props.buttonBackground).toBe('#111827');
  });

  it('takes text on the bar as its label and drops children', () => {
    const result = run([
      hero,
      { type: 'div', preset: 'stickyCta', props: { children: 'Reserve now', ctaHref: '#booking' }, children: [{ type: 'a', props: { children: 'x' } }] },
    ]);
    const bar = result.nodes.find(isBar)!;
    expect(bar.props.ctaLabel).toBe('Reserve now');
    expect(bar.props).not.toHaveProperty('children');
    expect(bar.children).toEqual([]);
  });

  it('keeps the position fixed injection guard: a breakout in another value is still dropped', () => {
    const result = run([{ type: 'div', props: { style: { color: 'red;position:fixed;inset:0' } } }]);
    expect(result.nodes[0].props.style).toBeUndefined();
  });
});

describe('the prompt', () => {
  it('describes the sticky call to action, decorative images and meaningful alt texts', () => {
    const text = stableSystemText();
    expect(text).toContain('# Sticky call to action (phones)');
    expect(text).toContain('"preset":"stickyCta"');
    expect(text).toContain('never build that with position fixed or sticky yourself');
    expect(text).toContain('"decorative": true');
    expect(text).toMatch(/never "image", "photo", a file name or the layer name/);
  });
});
