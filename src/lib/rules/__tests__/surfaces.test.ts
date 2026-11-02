import { describe, expect, it } from 'vitest';
import {
  DEAD_STATE,
  LIVE_STATE,
  animationsAtRest,
  asImportant,
  isEditorOwned,
  mediaVerdict,
  constantConditions,
  surfaceWrappers,
} from '../surfaces';

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 320, height: 640 };

const rewritePointerStates = (text: string, live: boolean) => constantConditions(text, 'canvas', live);

describe('editor-owned properties', () => {
  // What ComponentRenderer writes inline, and what would undo it wholesale.
  it.each(['pointer-events', 'user-select', '-webkit-user-select', '-webkit-touch-callout', 'cursor', 'all', 'interactivity', '-webkit-user-modify'])(
    '%s is never emitted on the canvas',
    (property) => {
      expect(isEditorOwned(property)).toBe(true);
      expect(isEditorOwned(property.toUpperCase())).toBe(true);
    },
  );

  it.each(['color', 'pointer', 'user', 'all-small-caps', '--cursor'])('%s is not', (property) => {
    expect(isEditorOwned(property)).toBe(false);
  });
});

describe('asImportant', () => {
  it('adds one', () => {
    expect(asImportant('color:red')).toBe('color:red!important');
  });

  it.each(['color:red !important', 'color:red!important', 'color:red ! IMPORTANT', 'color:red  !important  '])('strips a stored one first: %s', (text) => {
    expect(asImportant(text)).toBe('color:red!important');
  });

  it('leaves a string that says it', () => {
    expect(asImportant('content:"!important"')).toBe('content:"!important"!important');
  });

  it('keeps a value the browser would refuse refused, as on the published page', () => {
    expect(asImportant('color:red !important !important')).toBe('color:red !important!important');
  });
});

describe('constantConditions, pointer states', () => {
  it.each([':hover', ':active', ':focus', ':focus-visible', ':focus-within'])('%s, dead and live', (state) => {
    expect(rewritePointerStates(state, false)).toBe(DEAD_STATE);
    expect(rewritePointerStates(state, true)).toBe(LIVE_STATE);
  });

  it('ignores case', () => {
    expect(rewritePointerStates(':HoVeR', false)).toBe(DEAD_STATE);
    expect(rewritePointerStates(':FOCUS-Visible', true)).toBe(LIVE_STATE);
  });

  it('reads inside a function, and leaves what surrounds it', () => {
    expect(rewritePointerStates(':is(a:hover, b) > a:focus::before', false)).toBe(`:is(a${DEAD_STATE}, b) > a${DEAD_STATE}::before`);
    expect(rewritePointerStates(':not(:active)', true)).toBe(`:not(${LIVE_STATE})`);
    expect(rewritePointerStates(':has(a:focus-within)', false)).toBe(`:has(a${DEAD_STATE})`);
  });

  it.each([':checked', ':disabled', ':empty', ':first-child', ':hover-x', ':focused', '::hover', '::focus', ':active-view-transition', ':active-view-transition-type(x)'])(
    'leaves %s',
    (text) => {
      expect(rewritePointerStates(text, false)).toBe(text);
    },
  );

  it('does not read a string or an attribute selector', () => {
    expect(rewritePointerStates('[title=":hover"]:hover', false)).toBe(`[title=":hover"]${DEAD_STATE}`);
    expect(rewritePointerStates("[data-x=':focus']", true)).toBe("[data-x=':focus']");
  });

  it('stops at a quote left open, which only hand-built text can hold', () => {
    expect(rewritePointerStates('[a="b:hover', false)).toBe('[a="b:hover');
  });
});

describe('constantConditions, outward conditions', () => {
  const dead = (text: string) => `:not(*, ${text})`;
  const live = (text: string) => `:is(*, ${text})`;

  it.each([
    ':is(html:has([data-x]) *)',
    ':is(.dark *)',
    ':is(.group:hover *)',
    ':is(a b, c)',
    ':is(c, a b)',
    ':is(a>b)',
    ':is(a > b)',
    ':is(a+b)',
    ':is(a~b)',
    ':is(a || b)',
    ':where(html *)',
    ':not(html *)',
    ':nth-child(n of html *)',
    ':nth-last-child(2n + 1 of html x)',
    ':-webkit-any(a b)',
  ])('%s is a constant, dead and live, on both surfaces', (text) => {
    expect(constantConditions(text, 'canvas', false)).toBe(dead(text));
    expect(constantConditions(text, 'canvas', true)).toBe(live(text));
    expect(constantConditions(text, 'preview', false)).toBe(dead(text));
  });

  it('finds one at any depth, and keeps what surrounds it', () => {
    expect(constantConditions(':where(:not(:is(html x)))', 'canvas', false)).toBe(`:where(:not(${dead(':is(html x)')}))`);
    expect(constantConditions(':is(:not(html *), b):first-child', 'canvas', true)).toBe(`:is(${live(':not(html *)')}, b):first-child`);
    expect(constantConditions(':has(:is(html x))', 'canvas', false)).toBe(`:has(${dead(':is(html x)')})`);
    expect(constantConditions(':nth-child(n of :is(html x))', 'canvas', false)).toBe(`:nth-child(n of ${dead(':is(html x)')})`);
    expect(constantConditions(' h2:is(a b)::before', 'canvas', false)).toBe(` h2${dead(':is(a b)')}::before`);
  });

  it.each([
    ':is(h1, h2)',
    ':is( h1 , h2 )',
    ':not(p)',
    ':where(.a.b)',
    ':is(a[title="x y"])',
    ':is(a:not(b))',
    ':has(img)',
    ':has(> li)',
    ':has(ul li)',
    ':has(input:checked)',
    ':nth-child(2n + 1)',
    ':nth-of-type(2n + 1)',
    ':nth-child(2n of li)',
    ':nth-child(2n + 1 of .a, .b)',
    ':lang(de)',
    ':dir(rtl)',
    '::part(a b)',
    '::highlight(x)',
    '[title=":is(a b)"]',
  ])('%s only reads the stored page, and stays real', (text) => {
    expect(constantConditions(text, 'canvas', false)).toBe(text);
    expect(constantConditions(text, 'preview', false)).toBe(text);
  });

  it('leaves a pointer state real on the preview', () => {
    expect(constantConditions(':hover', 'preview', false)).toBe(':hover');
    expect(constantConditions(':is(a:focus, b)', 'preview', false)).toBe(':is(a:focus, b)');
  });

  it('stops at a bracket left open, which only hand-built text can hold', () => {
    expect(constantConditions(':is(a b', 'canvas', false)).toBe(':is(a b');
  });
});

describe('mediaVerdict', () => {
  it.each([
    ['(min-width: 1024px)', 'yes', 'no'],
    ['(max-width: 1279.98px)', 'no', 'yes'],
    ['(width: 1280px)', 'yes', 'no'],
    ['(min-width: 64rem)', 'yes', 'no'],
    ['(min-width: 0)', 'yes', 'yes'],
    ['(min-height: 700px)', 'yes', 'no'],
    ['(max-height: 700px)', 'no', 'yes'],
    ['(orientation: landscape)', 'yes', 'no'],
    ['(orientation: portrait)', 'no', 'yes'],
    ['(min-aspect-ratio: 3/2)', 'yes', 'no'],
    ['(aspect-ratio: 16 / 10)', 'yes', 'no'],
    ['(max-aspect-ratio: 1)', 'no', 'yes'],
    ['(width >= 64rem)', 'yes', 'no'],
    ['(600px > width)', 'no', 'yes'],
    ['(width > 600px)', 'yes', 'no'],
    ['(1400px > width >= 1000px)', 'yes', 'no'],
    ['(aspect-ratio >= 3/2)', 'yes', 'no'],
    ['screen and (min-width: 1024px)', 'yes', 'no'],
    ['only screen and (min-width: 1024px)', 'yes', 'no'],
    ['all', 'yes', 'yes'],
    ['not (min-width: 1024px)', 'no', 'yes'],
    ['not screen', 'no', 'no'],
    ['(width)', 'yes', 'yes'],
    ['(min-width: 1024px), (max-width: 400px)', 'yes', 'yes'],
    ['(min-width: 5000px), (max-width: 10px)', 'no', 'no'],
  ])('%s: desktop %s, phone %s', (prelude, desktop, phone) => {
    expect(mediaVerdict(prelude, DESKTOP)).toBe(desktop);
    expect(mediaVerdict(prelude, PHONE)).toBe(phone);
  });

  it.each([
    'print',
    '(prefers-color-scheme: dark)',
    '(prefers-reduced-motion: reduce)',
    '(hover: hover)',
    '(hover:hover) and (pointer:fine)',
    '(any-pointer: fine)',
    '(forced-colors: active)',
    '(min-resolution: 2dppx)',
    '(resolution >= 2dppx)',
    '(color)',
    'not print',
    'screen and (prefers-contrast: more)',
    '(min-device-width: 100px)',
  ])('%s describes the editor, not the frame', (prelude) => {
    expect(mediaVerdict(prelude, DESKTOP)).toBe('environment');
  });

  it.each(['(min-width: 40em)', '(min-width: calc(1px + 2px))', '(width >= 40em)', '(min-width: 1px) or (hover)', '(orientation: sideways)', '(min-orientation: portrait)', 'screen and', 'not'])(
    '%s cannot be worked out',
    (prelude) => {
      expect(mediaVerdict(prelude, DESKTOP)).toBe('unknown');
    },
  );

  it('a constant no beats what the environment could say', () => {
    expect(mediaVerdict('(hover: hover) and (min-width: 5000px)', DESKTOP)).toBe('no');
    expect(mediaVerdict('(hover: hover) and (min-width: 1000px)', DESKTOP)).toBe('environment');
  });

  it('reads a nested condition', () => {
    expect(mediaVerdict('((min-width: 1024px) and (min-height: 100px))', DESKTOP)).toBe('yes');
    expect(mediaVerdict('(not (min-width: 1024px))', DESKTOP)).toBe('no');
  });
});

describe('surfaceWrappers on the canvas', () => {
  const canvas = (at: string[], previewed = false, frame = DESKTOP) => surfaceWrappers(at, frame, 'canvas', previewed);

  it('drops a condition the frame meets, and omits a block it does not', () => {
    expect(canvas(['@media (min-width: 1024px)'])).toEqual([]);
    expect(canvas(['@media (min-width: 1024px)'], false, PHONE)).toBeNull();
  });

  it('holds an environment condition dead until previewed, then removes it', () => {
    expect(canvas(['@media (prefers-color-scheme: dark)'])).toBeNull();
    expect(canvas(['@media print'])).toBeNull();
    expect(canvas(['@media (prefers-color-scheme: dark)'], true)).toEqual([]);
    expect(canvas(['@media print'], true)).toEqual([]);
  });

  it('treats a width it cannot read the same way', () => {
    expect(canvas(['@media (min-width: 40em)'])).toBeNull();
    expect(canvas(['@media (min-width: 40em)'], true)).toEqual([]);
  });

  it('never previews what the frame rules out', () => {
    expect(canvas(['@media (hover: hover) and (min-width: 5000px)'], true)).toBeNull();
  });

  it('keeps every other wrapper, in order', () => {
    const at = ['@supports (display: grid)', '@container (min-width: 400px)', '@starting-style'];
    expect(canvas(at)).toEqual(at);
    expect(canvas(['@supports (display: grid)', '@media (min-width: 1px)', '@starting-style'])).toEqual(['@supports (display: grid)', '@starting-style']);
  });

  it('holds any @scope prelude dead, because its root is matched above the node, and removes it when previewed', () => {
    for (const at of ['@scope (html:has([data-x]))', '@scope (html[data-x*="a"])', '@scope (.card)', '@scope (.a) to (.b)', '@scope to (html x)']) {
      expect(canvas([at])).toBeNull();
      expect(canvas([at], true)).toEqual([]);
    }
  });

  it('keeps an @scope with no prelude', () => {
    expect(canvas(['@scope'])).toEqual(['@scope']);
  });

  it('leaves @supports selector() as the question it is', () => {
    expect(canvas(['@supports selector(:hover)'])).toEqual(['@supports selector(:hover)']);
  });

  it('reads the at-rule name in any case', () => {
    expect(canvas(['@MEDIA print'])).toBeNull();
  });
});

describe('surfaceWrappers on the preview', () => {
  const preview = (at: string[], frame = DESKTOP) => surfaceWrappers(at, frame, 'preview', false);

  it('answers a width from the frame and keeps the real environment', () => {
    expect(preview(['@media (min-width: 1024px)'])).toEqual([]);
    expect(preview(['@media (min-width: 1024px)'], PHONE)).toBeNull();
    expect(preview(['@media (hover:hover) and (pointer:fine)'])).toEqual(['@media (hover:hover) and (pointer:fine)']);
    expect(preview(['@media print'])).toEqual(['@media print']);
  });

  it('keeps what the frame cannot answer from a mixed query', () => {
    expect(preview(['@media (hover:hover) and (min-width: 1024px)'])).toEqual(['@media (hover:hover)']);
    expect(preview(['@media (hover:hover) and (min-width: 5000px)'])).toBeNull();
    expect(preview(['@media screen and (prefers-reduced-motion: reduce)'])).toEqual(['@media (prefers-reduced-motion: reduce)']);
  });

  it('lists what is left of a list, and a true query ends it', () => {
    expect(preview(['@media print, (min-width: 5000px)'])).toEqual(['@media print']);
    expect(preview(['@media print, (min-width: 1024px)'])).toEqual([]);
  });

  it('does not take a negated query apart', () => {
    expect(preview(['@media not print'])).toEqual(['@media not print']);
  });

  it('holds an @scope dead: nothing previews here', () => {
    expect(preview(['@scope (html:has([data-x]))'])).toBeNull();
  });
});

describe('animationsAtRest', () => {
  it('covers elements and both pseudo-elements under both roots', () => {
    const css = animationsAtRest([]);
    for (const root of ['[data-viewport-content-id]', '[data-floating-root-id]']) {
      expect(css).toContain(`${root}${root} *,`);
      expect(css).toContain(`${root}${root} *::before`);
      expect(css).toContain(`${root}${root} *::after`);
    }
    expect(css).toContain('animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important');
    expect(css).not.toContain('animation:none');
  });

  it('leaves out a previewed node and what is inside it', () => {
    expect(animationsAtRest(['a1'])).toContain(':not([data-inner-component-id="a1"], [data-inner-component-id="a1"] *)::before');
  });
});
