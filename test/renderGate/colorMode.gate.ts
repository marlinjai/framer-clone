// withColorMode against the browser (contract docs/plans/2026-11-02-theme-and-head.md,
// "Light and dark"; T2 code review, finding 1). A forced light or dark site answers
// `prefers-color-scheme` itself, so the rewrite of a stored `@media` prelude must match
// exactly when the browser would match the same prelude with the visitor's setting
// replaced by the site's mode. The browser's verdict is the expected answer:
//
//   - each `(prefers-color-scheme: x)` is replaced by a feature that is plainly true or
//     false for the mode, and `matchMedia` answers the whole prelude, invalid shapes
//     included;
//   - a rewrite to '' must be true there, a dropped rule (null) false, any other rewrite
//     must match exactly when that does;
//   - a prelude left unread (with a warning) must be left byte for byte as stored, which
//     is the documented answer for a form the mode cannot answer, unless a member the mode
//     makes true decides the whole list, which is then checked like any rewrite.
//
// The preludes are a generated sweep: operands, joiners with and without the white space
// CSS requires, `not`, media types and lists with blank members, kept only when the rule
// parser accepts them, since only those can be stored.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType } from 'playwright';
import { withColorMode } from '@/lib/rules/colorMode';
import { parseRule } from '@/lib/rules/rules';

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];

/** True at the probe's 800 pixel width, and false. */
const TRUE = '(min-width: 0px)';
const FALSE = '(min-width: 99999px)';

const OPERANDS = [
  '(prefers-color-scheme: dark)',
  '(prefers-color-scheme:light)',
  '(PREFERS-COLOR-SCHEME: Dark)',
  '(not (prefers-color-scheme: dark))',
  '(not (prefers-color-scheme: light))',
  '(prefers-color-scheme)',
  '(min-width: 600px)',
  '(min-width: 9999px)',
  '(orientation)',
  '(not (min-width: 9999px))',
];
const JOINERS = [' and ', ' AND ', 'and ', ' and', 'and', ' or ', ', ', ',', ' , '];
const PREFIXES = ['', 'not ', 'only screen and ', 'screen and ', 'not(', ', '];
const SUFFIXES = ['', ',', ', ', ' and', ')'];

function sweep(): string[] {
  const out = new Set<string>();
  for (const prefix of PREFIXES) {
    for (const suffix of SUFFIXES) {
      for (const a of OPERANDS) {
        out.add(`${prefix}${a}${suffix}`);
        for (const joiner of JOINERS) {
          for (const b of OPERANDS) out.add(`${prefix}${a}${joiner}${b}${suffix}`);
        }
      }
    }
  }
  // Only what the parser accepts can be stored, and only what names the feature is rewritten.
  return [...out].filter(
    (prelude) =>
      /prefers-color-scheme/i.test(prelude) &&
      parseRule({ id: 'r', selector: '&', at: [`@media ${prelude}`], style: { color: 'red' } }).ok,
  );
}

/** The stored prelude with the visitor's setting replaced by the mode, for the browser to answer. */
const substituted = (prelude: string, mode: 'light' | 'dark') =>
  prelude.replace(/prefers-color-scheme\s*:\s*(light|dark)/gi, (_whole, value: string) => (value.toLowerCase() === mode ? TRUE.slice(1, -1) : FALSE.slice(1, -1)));

describe.each(ENGINES)('withColorMode against matchMedia in %s', (_name, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('answers every stored prelude as the browser does under each forced mode, at both system settings', async () => {
    const preludes = sweep();
    expect(preludes.length).toBeGreaterThan(500);
    const misses: string[] = [];
    let answered = 0;
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 800, height: 600 } });
      const tab = await context.newPage();
      for (const mode of ['light', 'dark'] as const) {
        const cases = preludes.map((prelude) => ({ prelude, read: withColorMode(prelude, mode) }));
        const queries = cases.flatMap(({ prelude, read }) => [substituted(prelude, mode), read.prelude ?? FALSE, read.prelude === '' ? TRUE : read.prelude ?? FALSE]);
        const verdicts = await tab.evaluate((list: string[]) => list.map((q) => matchMedia(q).matches), queries);
        cases.forEach(({ prelude, read }, index) => {
          const expected = verdicts[index * 3];
          const after = read.prelude === null ? false : read.prelude === '' ? true : verdicts[index * 3 + 2];
          if (read.warning !== undefined && read.prelude === prelude) return;
          if (read.warning !== undefined && read.prelude !== '') {
            // Unread: the documented answer is the stored prelude, untouched. Only a member
            // the mode makes true may still decide the list, and that is checked below.
            misses.push(`${JSON.stringify(prelude)} under ${mode}: unread but rewritten to ${JSON.stringify(read.prelude)}`);
            return;
          }
          answered += 1;
          if (after !== expected) {
            misses.push(`${JSON.stringify(prelude)} under ${mode}, system ${scheme}: the browser says ${expected}, the rewrite ${JSON.stringify(read.prelude)} says ${after}`);
          }
        });
      }
      await context.close();
    }
    expect(misses).toEqual([]);
    // The sweep must exercise the rewrite, not only the unread path.
    expect(answered).toBeGreaterThan(1000);
  });
});
