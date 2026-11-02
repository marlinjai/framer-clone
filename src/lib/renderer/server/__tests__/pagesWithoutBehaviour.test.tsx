// A page with no behaviour renders byte for byte as it did before the behaviour
// pass existed. The reference file was written from the commit before the pass,
// and is regenerated only on purpose:
//
//   UPDATE_PAGES_WITHOUT_BEHAVIOUR=1 pnpm exec vitest run pagesWithoutBehaviour
//
// The trees are the parity corpus, which is real authored content, plus one page
// holding every kind of thing the published path treats specially.
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FIXTURES } from '../../../../../test/score/corpus/fixtures';
import type { CommerceServerRepository, ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { hydrateBindings } from '@/lib/renderer/publish/hydrateBindings';
import { applyBehaviour } from '../applyBehaviour';
import { renderPublishedPage } from '../renderPublishedPage';

const REFERENCE = path.join(__dirname, '__fixtures__/pagesWithoutBehaviour.json');
const NOW = new Date('2026-11-02T12:00:00.000Z');

const BPS: BreakpointRef[] = [
  { id: 'desktop', minWidth: 1280 },
  { id: 'tablet', minWidth: 768 },
  { id: 'mobile', minWidth: 320 },
];

const node = (id: string, type: string, props: Record<string, unknown> = {}, children: ComponentNode[] = [], bindings?: object): ComponentNode =>
  ({ id, type, props, children, ...(bindings ? { bindings } : {}) }) as ComponentNode;

const cmsRepo = {
  listRows: async () => ({
    rows: [0, 1, 2].map((index) => ({ id: `row-${index}`, values: { title: `Title ${index}`, slug: `slug-${index}` } })),
    total: 3,
  }),
  getRow: async () => null,
} as unknown as CmsReadRepository;

const commerceRepo = {
  listProducts: async () => ({ products: [{ id: 'p1', title: 'One', handle: 'one' }, { id: 'p2', title: 'Two', handle: 'two' }], total: 2 }),
  getProductByHandle: async () => null,
  listVariants: async () => [],
  getPrices: async () => [],
  getAvailability: async () => ({ available: true }),
} as unknown as CommerceServerRepository;

/** Every kind of thing the published path treats specially, with no behaviour on any of it. */
const everything = (): ComponentNode =>
  node('page', 'main', { style: { color: { base: '#111', tablet: '#222' } } }, [
    node('hero', 'h1', { children: 'Hello', rules: [{ id: 'hover', selector: '&:hover', style: { color: 'red' } }] }),
    node('fx', 'div', { effects: { appear: { kind: 'fade' } }, children: 'Revealed' }),
    node('list', 'ul', { 'data-component-kind': 'collection' }, [
      node('row', 'li', { rules: [{ id: 'badge', selector: '& #badge', style: { color: 'red' } }] }, [
        node('badge', 'b', { id: 'badge', children: 'New' }),
        node('note', 'i', { id: 'note', children: 'Nothing points here' }),
        node('row-title', 'span', { className: 'title' }, [], { children: { mode: 'read', expression: '{{row.title}}' } }),
        node('row-anchor', 'a', { href: '#top' }, [], { id: { mode: 'read', expression: '{{row.slug}}' } }),
      ]),
    ], { collection: { mode: 'read', expression: 'posts' } }),
    node('shop', 'div', { 'data-component-kind': 'product-list' }, [
      node('card', 'article', {}, [
        node('card-title', 'h2', {}, [], { children: { mode: 'read', expression: '{{product.title}}' } }),
        node('buy', 'div', { 'data-component-kind': 'add-to-cart', children: 'Buy' }),
      ]),
    ], { products: { mode: 'read', expression: 'all' } }),
    node('form', 'div', { 'data-form-kind': 'form', formName: 'Contact' }, [
      node('field', 'div', { 'data-form-kind': 'form-field', fieldType: 'email', fieldName: 'email', label: 'Email' }),
      node('send', 'button', { 'data-form-kind': 'form-submit', children: 'Send' }),
    ]),
    node('bar', 'div', { 'data-sticky-cta': 'bar', ctaLabel: 'Book', ctaHref: '#top' }),
  ]);

const pages: { id: string; tree: () => ComponentNode }[] = [
  ...FIXTURES.map(({ id, tree }) => ({ id, tree })),
  { id: 'everything', tree: everything },
];

async function renderAll(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const { id, tree } of pages) {
    const { body } = await renderPublishedPage({ root: tree(), pageParams: {}, cmsRepo, commerceRepo, breakpoints: BPS });
    out[id] = renderToStaticMarkup(<>{body}</>);
  }
  return out;
}

describe('a page with no behaviour', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders byte for byte as it did before the behaviour pass', async () => {
    const rendered = await renderAll();
    if (process.env.UPDATE_PAGES_WITHOUT_BEHAVIOUR) {
      fs.writeFileSync(REFERENCE, `${JSON.stringify(rendered, null, 1)}\n`);
    }
    const reference = JSON.parse(fs.readFileSync(REFERENCE, 'utf8')) as Record<string, string>;
    expect(Object.keys(rendered)).toEqual(Object.keys(reference));
    for (const id of Object.keys(reference)) expect(rendered[id], id).toBe(reference[id]);
  });

  it('comes back from the pass as the same tree, so nothing can have changed', async () => {
    for (const { tree } of pages) {
      const hydrated = await hydrateBindings(tree(), {}, { cmsRepo, commerceRepo });
      expect(applyBehaviour(hydrated)).toEqual({ root: hydrated, program: null, hasGate: false });
      expect(applyBehaviour(hydrated).root).toBe(hydrated);
    }
  });
});
