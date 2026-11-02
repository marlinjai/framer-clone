// The expansion memo: one expansion per site revision, a fresh budget per caller,
// a held tree no render writes to, and a form lookup an unknown id cannot make
// expensive.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PageSnapshotOut } from '@/models/PageModel';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { BREAKPOINTS } from '../../../../test/score/lib/published';
import { parseComponents } from '../definition';
import { COMPONENT_LIMITS } from '../placement';
import { adaptedPage, literalPage, resetExpandedPages, siteFormIds } from '../expandedPages';

type Node = Record<string, unknown>;

const read = (expression: string) => ({ mode: 'read', expression });

const components = parseComponents({
  card: {
    id: 'card',
    name: 'Card',
    inputs: [{ id: 'title', name: 'Title', type: 'text', default: 'Hello' }],
    states: [],
    page: {
      canvasNodes: {},
      appComponentTree: {
        id: 'c-root',
        type: 'section',
        props: { style: { width: { base: '100%' } } },
        children: [
          { id: 'c-title', type: 'h3', props: { children: 'x' }, bindings: { children: read('{{input.title}}') } },
          { id: 'c-form', type: 'form', props: { 'data-form-kind': 'form' } },
        ],
      },
    },
  },
}).definitions;

const placement = (id: string, inputs?: Record<string, unknown>): Node => ({
  id,
  type: '#component',
  componentType: 'host',
  props: { component: 'card', ...(inputs ? { inputs } : {}) },
});

const canvasNodes = Object.fromEntries(
  BREAKPOINTS.map((b) => [b.id, { canvasNodeType: 'viewport', breakpointId: b.id, breakpointMinWidth: b.minWidth }]),
);

const rowOf = (pageId: string, ...children: Node[]) => ({
  pageId,
  slug: pageId,
  snapshot: { slug: pageId, canvasNodes, appComponentTree: { id: `root-${pageId}`, type: 'div', props: {}, children } } as unknown as PageSnapshotOut,
});

const site = (revision: string | undefined, pages = [rowOf('home', placement('p1'), placement('p2', { title: 'Two' }))]) => ({
  siteId: 'site-1',
  ...(revision ? { revision } : {}),
  components,
  pages,
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const render = async (adapted: ReturnType<typeof adaptedPage>) => {
  const { body } = await renderPublishedPage({
    root: adapted.root!,
    budget: adapted.budget,
    pageParams: {},
    cmsRepo: {} as CmsReadRepository,
    breakpoints: adapted.breakpoints,
  });
  return renderToStaticMarkup(<>{body}</>);
};

/** A form carries the time it was rendered, which is the one thing meant to differ. */
const stamp = (markup: string) => markup.replace(/value="\d{13}"/g, 'value="time"');

beforeEach(() => resetExpandedPages());
afterEach(() => vi.restoreAllMocks());

describe('adaptedPage', () => {
  it('expands a page once per revision', () => {
    const current = site('r1');
    expect(adaptedPage(current, current.pages[0]).root).toBe(adaptedPage(current, current.pages[0]).root);
  });

  it('finds the same tree through a site deserialised afresh, as the cache gives it', () => {
    const current = site('r1');
    const fresh = JSON.parse(JSON.stringify(current)) as typeof current;
    expect(adaptedPage(fresh, fresh.pages[0]).root).toBe(adaptedPage(current, current.pages[0]).root);
  });

  it('expands again for a new revision, so a saved definition reaches the page', () => {
    const before = site('r1');
    const first = adaptedPage(before, before.pages[0]).root;
    const after = site('r2');
    expect(adaptedPage(after, after.pages[0]).root).not.toBe(first);
  });

  it('keeps sites apart', () => {
    const one = site('r1');
    const two = { ...site('r1'), siteId: 'site-2' };
    expect(adaptedPage(two, two.pages[0]).root).not.toBe(adaptedPage(one, one.pages[0]).root);
  });

  it('holds nothing without a revision', () => {
    const current = site(undefined);
    expect(adaptedPage(current, current.pages[0]).root).not.toBe(adaptedPage(current, current.pages[0]).root);
  });

  it('gives each caller its own budget, charged with what expansion spent', () => {
    const current = site('r1');
    const first = adaptedPage(current, current.pages[0]);
    const spent = first.budget.nodes;
    expect(spent).toBeGreaterThan(0);
    first.budget.charge(100, 100);
    const second = adaptedPage(current, current.pages[0]);
    expect(second.budget).not.toBe(first.budget);
    expect(second.budget.nodes).toBe(spent);
  });

  it('carries an exhausted budget to the next caller', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: COMPONENT_LIMITS.expandedNodesPerPage }, (_, i) => placement(`p${i}`));
    const current = site('r1', [rowOf('home', ...many)]);
    expect(adaptedPage(current, current.pages[0]).budget.exhausted).toBe(true);
    const again = adaptedPage(current, current.pages[0]).budget;
    expect(again.exhausted).toBe(true);
    expect(again.failures).toEqual([{ kind: 'over-budget' }]);
  });

  it('renders a held tree twice to the same markup without writing to it', async () => {
    const current = site('r1');
    const adapted = adaptedPage(current, current.pages[0]);
    deepFreeze(adapted.root);
    const first = await render(adapted);
    expect(first).toContain('Hello');
    expect(first).toContain('Two');
    expect(stamp(await render(adaptedPage(current, current.pages[0])))).toBe(stamp(first));
  });

  it('lets the oldest go past the entry limit, and keeps what was read lately', () => {
    const page = rowOf('home', placement('p1'));
    const oldest = site('old', [page]);
    const recent = site('recent', [page]);
    const heldOldest = adaptedPage(oldest, page).root;
    const heldRecent = adaptedPage(recent, page).root;
    for (let revision = 1; revision < 512; revision++) {
      if (revision === 500) adaptedPage(recent, page);
      adaptedPage(site(`r${revision}`, [page]), page);
    }
    expect(adaptedPage(recent, page).root).toBe(heldRecent);
    expect(adaptedPage(oldest, page).root).not.toBe(heldOldest);
  });

  it('lets the oldest go past the byte limit, long before the entry limit', () => {
    const heavy = parseComponents({
      big: { id: 'big', name: 'Big', inputs: [], states: [], page: { canvasNodes: {}, appComponentTree: {
        id: 'b', type: 'p', props: { children: 'x'.repeat(200 * 1024) },
      } } },
    }).definitions;
    const page = rowOf('home', ...Array.from({ length: 20 }, (_, i) => ({ ...placement(`p${i}`), props: { component: 'big' } })));
    const first = { ...site('r0', [page]), components: heavy };
    const held = adaptedPage(first, page).root;
    for (let revision = 1; revision <= 64; revision++) adaptedPage({ ...first, revision: `r${revision}` }, page);
    expect(adaptedPage(first, page).root).not.toBe(held);
  });
});

describe('literalPage', () => {
  it('is held apart from the rendering tree', () => {
    const current = site('r1');
    const literal = literalPage(current, current.pages[0]);
    expect(literal.root).toBe(literalPage(current, current.pages[0]).root);
    expect(literal.root).not.toBe(adaptedPage(current, current.pages[0]).root);
    expect(JSON.stringify(literal.root)).toContain('"Two"');
  });
});

describe('siteFormIds', () => {
  it('lists each placed form under its own id, on the first page holding it', () => {
    const ids = siteFormIds(site('r1'));
    expect(ids.get('p1__c-form')).toBe('home');
    expect(ids.get('p2__c-form')).toBe('home');
  });

  it('builds the list once per revision', () => {
    const current = site('r1');
    expect(siteFormIds(current)).toBe(siteFormIds(JSON.parse(JSON.stringify(current)) as typeof current));
  });

  it('builds a new list for a new revision', () => {
    expect(siteFormIds(site('r2'))).not.toBe(siteFormIds(site('r1')));
  });
});
