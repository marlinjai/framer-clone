// The colour values the theme grammar is held to, shared by the unit test
// (src/lib/site/__tests__/theme.test.ts) and the browser gate
// (test/renderGate/theme.gate.ts), so both judge the same list.

/**
 * Every value the grammar accepts today, each one a colour a browser reads. The grammar
 * only ever widens: a stored value a build accepted must stay accepted, or a frozen
 * published page loses a colour. Removing a line here fails the unit test, which is the point.
 */
export const ACCEPTED_COLORS: readonly string[] = [
  '#abc', '#ABCD', '#112233', '#11223344',
  'rgb(1 2 3)', 'rgb(1, 2, 3)', 'rgba(255, 0, 0, 0.5)', 'rgb(10% 20% 30% / 50%)', 'RGB(1 2 3)',
  'hsl(120deg 50% 50%)', 'hsla(120, 50%, 50%, 0.3)', 'hsl(0.5turn 10% 10%)', 'hsl(3.14rad 1% 1%)', 'hsl(200grad 1% 1%)',
  'hwb(12 50% 0%)', 'lab(52.2% 40.1 59.9)', 'lch(52.2% 72.2 50)', 'oklab(0.5 0.1 -0.1)',
  'oklch(0.205 0 0)', 'oklch(1 0 0 / 10%)', 'oklch(0.7 0.1 none)', 'oklch(.5 .1 1e2)',
  'color(srgb 1 0 0)', 'color(srgb-linear 0.2 0.3 0.4 / 0.5)', 'color(display-p3 1 0.5 0)',
  'red', 'RebeccaPurple', 'transparent', 'white',
  '  #123456  ',
];

/**
 * Refused, each for a stated reason. The first group is every hostile value of the
 * contract's probe (`theme.mjs`) and of its review (`review-browser.mjs`), which broke out
 * of a raw sheet in Chromium: `}` hid the body, `;` loaded an address, `</style>` ran
 * script, and an unclosed bracket swallowed every later rule.
 */
export const REFUSED_COLORS: ReadonlyArray<readonly [string, unknown]> = [
  ['closing brace', 'red}body{display:none'],
  ['semicolon', 'red;background:url(http://evil.test/x)'],
  ['comment', 'red/*'],
  ['style end', 'red</style><img src=x onerror=window.__ran=1>'],
  ['wide keyword initial', 'initial'],
  ['alias', 'var(--fc-t-b)'],
  ['unclosed bracket', 'rgb(0 0 0'],
  ['unclosed bracket with a semicolon', 'rgb(0 0 0;'],
  ['stray bracket', 'rgb(0 0 0))'],
  ['wide keyword inherit', 'inherit'],
  ['wide keyword unset', 'unset'],
  ['wide keyword revert', 'revert'],
  ['wide keyword revert-layer', 'revert-layer'],
  ['alias to a token', 'var(--fc-t-ab12cd34)'],
  ['nested bracket', 'rgb(calc(1) 0 0)'],
  ['url', 'url(https://evil.test/x)'],
  ['calc', 'calc(1px)'],
  ['color-mix', 'color-mix(in srgb, red, blue)'],
  ['light-dark', 'light-dark(red, blue)'],
  ['currentcolor', 'currentcolor'],
  ['unknown function', 'device-cmyk(0 0 0 1)'],
  ['unknown colour space', 'color(rec2020 1 0 0)'],
  ['colour() without a space', 'color(1 0 0)'],
  ['empty call', 'rgb()'],
  ['a word inside a call', 'rgb(red 0 0)'],
  ['double quote', 'rgb(1 2 "3")'],
  ['single quote', "'red'"],
  ['backslash', 'r\\65 d'],
  ['angle brackets', '<red>'],
  ['unknown name', 'reddish'],
  ['too long', `rgb(${'1 '.repeat(40)})`],
  ['empty', ''],
  ['white space only', '   '],
  ['not a string', 42],
  ['a hex of five', '#12345'],
  ['text after a call', 'rgb(1 2 3) red'],
  ['important', 'red !important'],
  ['style end in a call', 'rgb(1 2 3</style>)'],
  ['escaped brace', 'red\\}'],
];

/**
 * The T1 code review's probe (`review-t1probe.mts`): every function with every body below,
 * plus a few names. The parser before the review accepted 257 of these, and Chromium and
 * WebKit refused 190 of those 257. The browser gate asserts every value the parser accepts
 * now is a colour in both.
 */
const REVIEW_FUNCTIONS = ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color'];
const REVIEW_BODIES = [
  '0. 0 0', '1.e3 0 0', '.5 .5 .5', '1e2 0 0', '+1 -1 0', '0 0 0 / 0.', '1 2 3,4', '1, 2 3', '1,2,3,4,5', '1 2 3 4 5', '1', '1 2',
  'none 0 0', 'none, 0, 0', '0deg 0% 0%', '10% 10% 10%', '0 0 0 / 50%', '1 2 3 / 4 / 5', '1//2 3', '1, 2, 3 / 0.5', '1e 2 3',
  '0 0 0', '0 0 0', '0﻿0 0', '0　0 0', '10deg 10deg 10deg', '1turn 0 0', '0 0 0 0', 'srgb 1 0 0', 'srgb 1 0',
  'display-p3 1 0 0 / .5', 'srgb-linear 1,0,0', 'SRGB 1 0 0',
];
export const REVIEW_PROBE_VALUES: readonly string[] = [
  ...REVIEW_FUNCTIONS.flatMap((fn) => REVIEW_BODIES.map((body) => `${fn}(${body})`)),
  '#abc', '#ABCD', '#12345', ' red ', 'RED', 'transparent', 'Transparent', 'rgb(0 0 0)\n', ' red ', '﻿red',
];

/**
 * Payloads from the review's classes the parser must refuse, each a value a browser
 * refuses: numbers CSS does not tokenise, wrong arity, mixed separators, commas where a
 * function has no comma form, units in the wrong slot, `none` in the comma form, and
 * Unicode white space.
 */
export const REVIEW_REFUSED: readonly string[] = [
  'rgb(0. 0 0)', 'rgb(1.e3 0 0)', 'rgb(0 0 0 / 0.)',
  'rgb(1)', 'rgb(1 2)', 'rgb(1 2 3 4 5)', 'oklch(0 0 0 0)', 'color(srgb 1 0)',
  'rgb(1, 2 3)', 'rgb(1 2 3,4)', 'rgb(1, 2, 3 / 0.5)', 'rgb(1//2 3)', 'rgb(1 2 3 / 4 / 5)',
  'lab(1, 2, 3)', 'lch(1, 2, 3)', 'oklab(1, 2, 3)', 'oklch(1, 2, 3)', 'hwb(1, 2%, 3%)', 'color(srgb-linear 1,0,0)',
  'rgb(0deg 0% 0%)', 'hsl(10% 10% 10%)', 'hsl(10deg 10deg 10deg)', 'oklch(1turn 0 0)',
  'rgb(none, 0, 0)',
  'rgb(0 0 0)', 'rgb(0 0 0)', 'rgb(0﻿0 0)', 'rgb(0　0 0)', ' red ', '﻿red',
  'rgb(1, 2%, 3)', 'hsl(10, 20, 30)', 'rgb(1e 2 3)', '#12345',
];

/**
 * A generated sweep: every function with combinations of component spellings, in the
 * modern form with and without an alpha and in the comma form with three and four values.
 * The browser gate asserts every value the parser accepts here is a colour in Chromium and
 * WebKit, so a gap in the grammar fails a test instead of a page.
 */
export function colorSweep(): string[] {
  const parts = ['0', '1', '.5', '0.', '1e2', '-1', '50%', '10deg', '1turn', 'none', '1.e3', '0.5%'];
  const alphas = ['0.5', '50%', 'none', '0.', '10deg'];
  const out: string[] = [];
  for (const fn of REVIEW_FUNCTIONS) {
    const spaces = fn === 'color' ? ['srgb ', 'display-p3 ', 'srgb-linear ', 'xyz '] : [''];
    for (const space of spaces) {
      for (const a of parts) for (const b of parts) for (const c of parts) {
        out.push(`${fn}(${space}${a} ${b} ${c})`);
        out.push(`${fn}(${space}${a},${b}, ${c})`);
      }
      for (const a of parts) for (const alpha of alphas) {
        out.push(`${fn}(${space}${a} ${a} ${a} / ${alpha})`);
        out.push(`${fn}(${space}${a} ${a} ${a}/${alpha})`);
        out.push(`${fn}(${space}${a}, ${a}, ${a}, ${alpha})`);
      }
    }
  }
  return out;
}
