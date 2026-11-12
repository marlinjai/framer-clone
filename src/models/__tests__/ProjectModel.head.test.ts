// Head items on the model (contract docs/plans/2026-11-02-theme-and-head.md, slice H1), over
// the four paths: forward (write to both homes, ogType), backtrack (undo, a page item removed,
// a kind changed), resume (a snapshot and a JSON round trip, an old page without the fields,
// the shared document) and re-entry (the caps, a dialog save that must not erase the site's
// items, a forged item, a failed write that changes nothing).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel from '../ProjectModel';
import HistoryStore from '@/stores/HistoryStore';
import { HEAD_LIMITS, changeHeadKind, resolveHead, type StoredHeadItem } from '@/lib/site/headItems';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import { mstSnapshotToYDoc, yDocToMstSnapshot } from '@/lib/multiplayer/yjsDocShape';

function setup(snapshotExtra: Record<string, unknown> = {}) {
  const project = ProjectModel.create({ id: 'proj', metadata: { title: 'Bakery' }, pages: {}, ...snapshotExtra });
  const home = project.createPage('Home');
  home.setSlug('');
  const history = HistoryStore.create({});
  history.setTargetStore(project);
  history.clear();
  return { project, home, history };
}

const meta = (name: string, content = 'v'): StoredHeadItem => ({ kind: 'meta', name, content });
const forged = (): StoredHeadItem => JSON.parse('{"kind":"link","rel":"me","href":"/a","__proto__":{"kind":"link","polluted":true}}');
const proto = (value: unknown) => Object.getPrototypeOf(value);

describe('the site home: updateSiteHead', () => {
  it('stores a list, and the item reads back through the merge', () => {
    const { project } = setup();
    expect(project.updateSiteHead([meta('author', 'site')])).toEqual({ ok: true, dropped: 0 });
    expect(project.site.head).toEqual([meta('author', 'site')]);
    expect(resolveHead(project.site.head, []).items).toEqual([meta('author', 'site')]);
  });

  it('is one undo step, and undo restores the earlier list', () => {
    const { project, history } = setup();
    project.updateSiteHead([meta('author', 'a')]);
    history.clear();
    project.updateSiteHead([meta('author', 'b'), meta('rating', 'general')]);
    expect(history.history.length).toBe(1);
    history.undo();
    expect(project.site.head).toEqual([meta('author', 'a')]);
    history.redo();
    expect(project.site.head).toHaveLength(2);
  });

  it('changes nothing, and records no step, when the list is the same', () => {
    const { project, history } = setup();
    project.updateSiteHead([meta('author')]);
    history.clear();
    project.updateSiteHead([meta('author')]);
    expect(history.history.length).toBe(0);
  });

  it('refuses a value that is not a list and changes nothing', () => {
    const { project } = setup();
    project.updateSiteHead([meta('author')]);
    for (const bad of [undefined, null, 'x', { kind: 'meta' }, 5]) {
      expect(project.updateSiteHead(bad)).toMatchObject({ ok: false });
    }
    expect(project.site.head).toEqual([meta('author')]);
  });

  it('keeps a refused item as stored, so the panel can show it as refused', () => {
    const { project } = setup();
    project.updateSiteHead([meta('viewport', 'x')]);
    expect(project.site.head).toEqual([meta('viewport', 'x')]);
    expect(resolveHead(project.site.head, []).items).toEqual([]);
  });

  it('drops the later items over 20 and says how many', () => {
    const { project } = setup();
    const result = project.updateSiteHead(Array.from({ length: 25 }, (_, i) => meta('author', `a${i}`)));
    expect(result).toEqual({ ok: true, dropped: 5 });
    expect(project.site.head).toHaveLength(HEAD_LIMITS.siteItems);
    expect(project.site.head[0]).toMatchObject({ content: 'a0' });
  });

  it('counts an unreadable entry as dropped and keeps the rest', () => {
    const { project } = setup();
    expect(project.updateSiteHead([meta('author'), null, 5, { kind: 5 }])).toEqual({ ok: true, dropped: 3 });
    expect(project.site.head).toEqual([meta('author')]);
  });

  it('forges no prototype from a stored __proto__ key', () => {
    const { project } = setup();
    project.updateSiteHead([forged()]);
    expect(proto(project.site.head[0])).toBe(Object.prototype);
    expect(Object.hasOwn(project.site.head[0], '__proto__')).toBe(true);
    expect(project.site.head[0].polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(resolveHead(project.site.head, []).items).toEqual([]);
  });

  it('the Site settings dialog never erases the head items', () => {
    const { project } = setup();
    // A dialog opened before the edit holds a draft with no head, or the old one.
    const draft = { ...normalizeSiteSettings(project.site), head: [] as StoredHeadItem[] };
    project.updateSiteHead([meta('author', 'edited after the dialog opened')]);
    expect(project.updateSiteSettings({ ...draft, siteName: 'Bakery' })).toEqual({ ok: true });
    expect(project.site.head).toEqual([meta('author', 'edited after the dialog opened')]);
  });

  it('an update to the head keeps every other site setting', () => {
    const { project } = setup();
    project.updateSiteSettings({ siteName: 'Bakery', language: 'de' });
    project.updateSiteHead([meta('author')]);
    expect(project.site).toMatchObject({ siteName: 'Bakery', language: 'de' });
  });

  it('survives a snapshot and a JSON round trip, refused items and all', () => {
    const { project } = setup();
    project.updateSiteHead([meta('author', 'a'), meta('viewport', 'x'), forged()]);
    const snapshot = JSON.parse(JSON.stringify(getSnapshot(project)));
    const again = ProjectModel.create(snapshot);
    expect(JSON.stringify(again.site.head)).toBe(JSON.stringify(project.site.head));
    expect(proto(again.site.head[2])).toBe(Object.prototype);
    expect(JSON.stringify(getSnapshot(again))).toBe(JSON.stringify(getSnapshot(project)));
  });

  it('a project saved before the field existed reads as empty', () => {
    const { project } = setup();
    const snapshot = JSON.parse(JSON.stringify(getSnapshot(project)));
    delete snapshot.siteSettings.head;
    expect(ProjectModel.create(JSON.parse(JSON.stringify(snapshot))).site.head).toEqual([]);
    delete snapshot.siteSettings;
    expect(ProjectModel.create(JSON.parse(JSON.stringify(snapshot))).site.head).toEqual([]);
  });
});

describe('the page home: metadata.head and ogType', () => {
  afterEach(() => vi.useRealTimers());

  it('every metadata update, head or not, moves the page\'s updatedAt (the sitemap lastmod reads it)', () => {
    const { home } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 1));
    home.updateMetadata({ title: 'New title' });
    expect(home.updatedAt.getTime()).toBe(new Date(2030, 0, 1).getTime());
    vi.setSystemTime(new Date(2031, 0, 1));
    home.updateMetadata({ head: [meta('author')] });
    expect(home.updatedAt.getTime()).toBe(new Date(2031, 0, 1).getTime());
  });

  it('a new page has an empty head and the website type', () => {
    const { home } = setup();
    expect(home.metadata.head).toEqual([]);
    expect(home.metadata.ogType).toBe('website');
  });

  it('writes both through updateMetadata, forward', () => {
    const { home } = setup();
    expect(home.updateMetadata({ head: [meta('author', 'page')], ogType: 'article' })).toEqual({ headDropped: 0 });
    expect(home.metadata.head).toEqual([meta('author', 'page')]);
    expect(home.metadata.ogType).toBe('article');
  });

  it('a page item replaces the site item and, once removed, the site item returns', () => {
    const { project, home } = setup();
    project.updateSiteHead([meta('author', 'site')]);
    home.updateMetadata({ head: [meta('author', 'page')] });
    expect(resolveHead(project.site.head, home.metadata.head).items).toEqual([meta('author', 'page')]);
    home.updateMetadata({ head: [] });
    expect(resolveHead(project.site.head, home.metadata.head).items).toEqual([meta('author', 'site')]);
  });

  it('is undone in one step', () => {
    const { home, history } = setup();
    home.updateMetadata({ head: [meta('author', 'a')] });
    history.clear();
    home.updateMetadata({ head: [meta('author', 'b')], ogType: 'book' });
    history.undo();
    expect(home.metadata.head).toEqual([meta('author', 'a')]);
    expect(home.metadata.ogType).toBe('website');
  });

  it('changing an item to another kind drops the fields that kind cannot hold, through the page', () => {
    const { home } = setup();
    home.updateMetadata({ head: [{ kind: 'link', rel: 'alternate', href: '/de', hreflang: 'de', title: 't' }] });
    home.updateMetadata({ head: [changeHeadKind(home.metadata.head[0], 'property')] });
    expect(home.metadata.head[0]).toEqual({ kind: 'property', property: '', content: '' });
    expect(Object.keys(home.metadata.head[0]).sort()).toEqual(['content', 'kind', 'property']);
  });

  it('reads a forged og type as website and never throws', () => {
    const { home } = setup();
    for (const bad of ['product', 'music.song', '__proto__', '', 5, null]) {
      home.updateMetadata({ ogType: bad as never });
      expect(home.metadata.ogType).toBe('website');
    }
  });

  it('drops the later items over 30 and says how many', () => {
    const { home } = setup();
    const result = home.updateMetadata({ head: Array.from({ length: 33 }, (_, i) => meta('author', `a${i}`)) });
    expect(result).toEqual({ headDropped: 3 });
    expect(home.metadata.head).toHaveLength(HEAD_LIMITS.pageItems);
  });

  it('leaves the head alone when an update names other fields, and the other fields alone when it names the head', () => {
    const { home } = setup();
    home.updateMetadata({ head: [meta('author')], description: 'd' });
    home.updateMetadata({ description: 'e' });
    expect(home.metadata.head).toEqual([meta('author')]);
    home.updateMetadata({ head: [] });
    expect(home.metadata.description).toBe('e');
  });

  it('an update carrying a __proto__ key sets no prototype and writes no field', () => {
    const { home } = setup();
    const update = JSON.parse('{"description":"d","__proto__":{"polluted":true},"head":[{"kind":"link","rel":"me","href":"/a","__proto__":{"polluted":true}}]}');
    home.updateMetadata(update);
    expect(home.metadata.description).toBe('d');
    expect(proto(home.metadata)).not.toBe(update.__proto__);
    expect((home.metadata as unknown as Record<string, unknown>).polluted).toBeUndefined();
    expect(proto(home.metadata.head[0])).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('survives a snapshot and a JSON round trip', () => {
    const { project, home } = setup();
    home.updateMetadata({ head: [meta('author', 'a'), forged()], ogType: 'profile' });
    const snapshot = JSON.parse(JSON.stringify(getSnapshot(project)));
    const again = ProjectModel.create(snapshot);
    const page = [...again.pages.values()][0];
    expect(page.metadata.ogType).toBe('profile');
    expect(JSON.stringify(page.metadata.head)).toBe(JSON.stringify(home.metadata.head));
    expect(proto(page.metadata.head[1])).toBe(Object.prototype);
  });

  it('an old page with no head and no og type reads as the defaults', () => {
    const { project } = setup();
    const snapshot = JSON.parse(JSON.stringify(getSnapshot(project)));
    const [id] = Object.keys(snapshot.pages);
    delete snapshot.pages[id].metadata.head;
    delete snapshot.pages[id].metadata.ogType;
    const page = [...ProjectModel.create(snapshot).pages.values()][0];
    expect(page.metadata.head).toEqual([]);
    expect(page.metadata.ogType).toBe('website');
  });

  it('is kept by the shared document, and a stale one without the fields reads as the defaults', () => {
    const { project, home } = setup();
    home.updateMetadata({ head: [meta('author', 'a'), meta('viewport', 'kept')], ogType: 'book' });
    const back = yDocToMstSnapshot(mstSnapshotToYDoc(JSON.parse(JSON.stringify(getSnapshot(project)))));
    const pages = Object.values(back.pages ?? {}) as Array<{ metadata: Record<string, unknown> }>;
    expect(pages[0].metadata).toMatchObject({ ogType: 'book', head: [meta('author', 'a'), meta('viewport', 'kept')] });
    const old = JSON.parse(JSON.stringify(getSnapshot(project)));
    const [id] = Object.keys(old.pages);
    delete old.pages[id].metadata.head;
    delete old.pages[id].metadata.ogType;
    const stale = Object.values(yDocToMstSnapshot(mstSnapshotToYDoc(old)).pages ?? {}) as Array<{ metadata: Record<string, unknown> }>;
    expect(stale[0].metadata).toMatchObject({ ogType: 'website', head: [] });
  });
});
