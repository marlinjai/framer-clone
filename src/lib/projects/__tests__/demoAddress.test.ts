import { describe, it, expect } from 'vitest';
import { DEMO_PATH, demoPageHref, wantsDemo } from '../demoAddress';

describe('the demo address', () => {
  it('is `/?demo=1`, and a page of it keeps the marker', () => {
    expect(DEMO_PATH).toBe('/?demo=1');
    expect(demoPageHref('p 1')).toBe('/?demo=1&page=p%201');
  });

  it.each([
    [{ demo: '1' }, true],
    [{ page: 'abc' }, true], // links and bookmarks from before the home
    [{ preview: '1' }, true],
    [{ demo: ['1', '2'] }, true],
    [{}, false],
    [{ page: '' }, false],
    [{ demo: '0' }, false],
    [{ preview: '0' }, false],
    [{ switch: '1' }, false],
  ])('wantsDemo(%j) is %s', (query, expected) => {
    expect(wantsDemo(query)).toBe(expected);
  });
});
// ci-replay touch
