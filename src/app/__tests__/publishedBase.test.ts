// @vitest-environment node
// The score compares against test/score/data/published-base.css, a committed copy of
// what the production build ships to a published page. This is what stops that copy
// going stale without anyone noticing. It lives here, not in test/score, because CI
// runs `pnpm test` and not the score.

import { describe, expect, it } from 'vitest';
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
});
