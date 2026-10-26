// A click in the preview on a link to a path of the site is kept in the
// preview (PreviewFrame): sitePathOfClick says which path, or null for
// anchors, outside links and clicks that are not on a link.
import { describe, expect, it } from 'vitest';
import { sitePathOfClick } from '../PreviewFrame';

function linkWith(href: string): HTMLElement {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  const span = document.createElement('span');
  a.appendChild(span);
  return span;
}

describe('sitePathOfClick', () => {
  it('reads the site path of the link around the click, without query or fragment', () => {
    expect(sitePathOfClick(linkWith('/contact'))).toBe('/contact');
    expect(sitePathOfClick(linkWith('/products/pearl-necklace?x=1#top'))).toBe('/products/pearl-necklace');
    expect(sitePathOfClick(linkWith('/'))).toBe('/');
  });

  it('leaves anchors, outside links and plain clicks alone', () => {
    expect(sitePathOfClick(linkWith('#top'))).toBeNull();
    expect(sitePathOfClick(linkWith('https://example.com'))).toBeNull();
    expect(sitePathOfClick(linkWith('//evil.example/x'))).toBeNull();
    expect(sitePathOfClick(document.createElement('div'))).toBeNull();
    expect(sitePathOfClick(null)).toBeNull();
  });
});
