// What a published page carries from the site's and its own head items (slice H2): merged,
// logged when left out, and none on a branch preview.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublishedSite } from '../publicResolver';

vi.mock('server-only', () => ({}));

const { publishedHead } = await import('../renderSitePage');

let counter = 0;
const site = (head: unknown[], preview = false) =>
  ({ siteId: `site-${counter++}`, siteSettings: { head }, ...(preview ? { preview: { label: 'x' } } : {}) }) as unknown as PublishedSite;
const meta = (name: string, content: string) => ({ kind: 'meta', name, content });

afterEach(() => vi.restoreAllMocks());

describe('publishedHead', () => {
  it('merges the site and the page, the page replacing the same key', () => {
    const { items } = publishedHead(site([meta('author', 'site'), meta('rating', 'general')]), [meta('author', 'page')]);
    expect(items).toEqual([meta('rating', 'general'), meta('author', 'page')]);
  });

  it('logs each item it leaves out, with its home and position, and renders its neighbours', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { items, problems } = publishedHead(site([meta('viewport', 'x')]), [meta('rating', 'general'), { kind: 'script' }]);
    expect(items).toEqual([meta('rating', 'general')]);
    expect(problems).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toMatch(/site item 0 left out \(refused\)/);
    expect(String(warn.mock.calls[1][0])).toMatch(/page item 1 left out \(refused\)/);
  });

  it('tells each problem once per site, not once per visit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const same = site([meta('viewport', 'x')]);
    for (let i = 0; i < 5; i += 1) publishedHead(same, []);
    expect(warn).toHaveBeenCalledTimes(1);
    publishedHead(site([meta('viewport', 'x')]), []);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('logs a hostile stored name as one short escaped line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    publishedHead(site([{ kind: 'meta', name: `x\n[site head] ERROR forged ${'a'.repeat(10_000)}`, content: 'v' }]), []);
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(400);
  });

  it('carries nothing on a branch preview, and logs nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(publishedHead(site([meta('author', 'x'), meta('viewport', 'x')], true), [meta('rating', 'g')])).toEqual({ items: [], problems: [] });
    expect(warn).not.toHaveBeenCalled();
  });

  it('survives a page with no head and a site with junk', () => {
    expect(publishedHead(site([5, null] as unknown[]), undefined).items).toEqual([]);
    expect(publishedHead({ siteSettings: { head: undefined } } as unknown as PublishedSite, [meta('rating', 'g')]).items).toEqual([meta('rating', 'g')]);
  });
});
