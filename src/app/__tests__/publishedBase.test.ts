// @vitest-environment node
// The score compares against test/score/data/published-base.css, a committed copy of
// what the production build ships to a published page. This is what stops that copy
// going stale without anyone noticing. It lives here, not in test/score, because CI
// runs `pnpm test` and not the score.

import { describe, expect, it } from 'vitest';
import { RESET_PSEUDO_ELEMENTS } from '@/lib/site/pageBase';
import { publishedBaseInputs, readPublishedBase } from '../../../test/score/lib/publishedBase';

describe('the published base in the score', () => {
  it('was generated from the current globals.css, layouts and compilers', () => {
    expect(readPublishedBase().meta.inputs, 'a base input changed: run pnpm score:refresh-base and commit the result').toEqual(publishedBaseInputs());
  });

  it('holds the sheet of a real page, not an empty stand-in', () => {
    const { css, meta } = readPublishedBase();
    expect(css).toContain('@layer base');
    expect(css).toContain('--background:');
    expect(css).toContain('@font-face');
    expect(css).not.toContain('/_next/static/');
    expect(meta.bodyClass).toMatch(/__variable_\w+ __variable_\w+ antialiased/);
  });

  it('styles no pseudo-element the browser page base does not take back', () => {
    const { css } = readPublishedBase();
    const start = css.indexOf('@layer base{');
    const layer = css.slice(start, css.indexOf('@layer components', start));
    const styled = new Set([...layer.matchAll(/(?<![\w-]):{1,2}(after|before|backdrop|placeholder|file-selector-button|-webkit-[\w-]+)/g)].map((match) => `::${match[1]}`));
    expect(styled.size).toBeGreaterThan(10);
    expect([...styled].filter((name) => !(RESET_PSEUDO_ELEMENTS as readonly string[]).includes(name))).toEqual([]);
  });
});
