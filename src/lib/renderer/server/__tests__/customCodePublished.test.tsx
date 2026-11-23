// Sandboxed custom code on the published page (slice C3 of
// docs/plans/2026-11-02-sandboxed-custom-code.md): which blocks the server accepts
// (applyCustomCode), what the island receives, the per-site frame policy, the 4-block
// limit, and that a page without a block carries no broker.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import type { CustomCodeDeclaration } from '@/lib/customCode/contract';
import { FRAMELESS_TAGS, applyCustomCode, customCodeHashes, type LiveCustomCode } from '../applyCustomCode';
import { renderPublishedPage } from '../renderPublishedPage';
import { MAP_EMBED_ATTR, MAP_EMBED_MARKER } from '@/lib/mapEmbed/mapEmbed';

const SITE = '0b9e2f4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const ORIGIN = 'https://run.box.test';
const hash = (n: number) => n.toString(16).padStart(64, '0');
const declaration = (extra: Partial<CustomCodeDeclaration> = {}): CustomCodeDeclaration => ({
  reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true, ...extra,
});

const block = (id: string, n: number, children: ComponentNode[] = [{ type: 'p', id: `${id}-f`, props: { children: 'Fallback' } }]): ComponentNode => ({
  type: 'div',
  id,
  props: { customCode: { sha256: hash(n), title: `Block ${id}` } },
  children,
});

const page = (children: ComponentNode[], behaviour?: object): ComponentNode => ({
  type: 'div',
  id: 'root',
  props: behaviour ? { behaviour } : {},
  children,
});

const STATES = {
  state: [
    { id: 'open', name: 'Open', type: 'boolean', initial: false },
    { id: 'n', name: 'N', type: 'number', initial: 2, min: 0, max: 9 },
    { id: 'tab', name: 'Tab', type: 'choice', initial: 'a', options: ['a', 'b'] },
    { id: 'name', name: 'Name', type: 'text', initial: '' },
  ],
};

const live = (blobs: [number, CustomCodeDeclaration][]): LiveCustomCode => ({ siteId: SITE, origin: ORIGIN, blobs: new Map(blobs.map(([n, d]) => [hash(n), d])) });

const runOf = (root: ComponentNode, id: string): ComponentNode['customCodeRun'] => {
  let found: ComponentNode | undefined;
  const walk = (node: ComponentNode) => {
    if (node.id === id) found = node;
    node.children?.forEach(walk);
  };
  walk(root);
  return found?.customCodeRun;
};

afterEach(() => vi.restoreAllMocks());

describe('applyCustomCode', () => {
  it('gives an accepted block its address, declaration and the definitions of its states', () => {
    const result = applyCustomCode(page([block('b1', 1)], STATES), live([[1, declaration({ reads: ['tab', 'open'], writes: ['n'], emits: ['custom:done'], sizing: 'content', interactive: false })]]));
    expect(result.blocks).toBe(1);
    expect(result.writes).toBe(true);
    expect(runOf(result.root, 'b1')).toEqual({
      src: `${ORIGIN}/box/${SITE}/${hash(1)}`,
      title: 'Block b1',
      reads: ['tab', 'open'],
      writes: ['n'],
      emits: ['custom:done'],
      sizing: 'content',
      interactive: false,
      states: { tab: { type: 'choice', options: ['a', 'b'] }, open: { type: 'boolean' }, n: { type: 'number', min: 0, max: 9 } },
    });
  });

  it.each([
    ['a text state read', declaration({ reads: ['name'] }), 'is text'],
    ['a text state written', declaration({ writes: ['name'] }), 'is text'],
    ['a state that does not exist', declaration({ reads: ['nope'] }), 'does not stand above'],
  ])('refuses %s: the block keeps its fallback', (_name, d, reason) => {
    const result = applyCustomCode(page([block('b1', 1)], STATES), live([[1, d]]));
    expect(result.blocks).toBe(0);
    expect(runOf(result.root, 'b1')).toBeUndefined();
    expect(result.problems.map((p) => p.reason).join()).toContain(reason);
  });

  it('refuses a state that stands beside the block, not above it', () => {
    const root = page([{ type: 'div', id: 'side', props: { behaviour: STATES } }, block('b1', 1)]);
    expect(applyCustomCode(root, live([[1, declaration({ reads: ['open'] })]])).blocks).toBe(0);
  });

  it('refuses a hash with no live blob, a proposal and an invalid value, and everything without live code', () => {
    const root = page([
      block('b1', 1),
      { type: 'div', id: 'p', props: { customCode: { proposal: 'abc', title: 'P' } } },
      { type: 'div', id: 'bad', props: { customCode: { sha256: 'X', title: 'B' } } },
    ]);
    expect(customCodeHashes(root)).toEqual([hash(1)]);
    expect(applyCustomCode(root, live([[2, declaration()]])).blocks).toBe(0);
    const off = applyCustomCode(root, null);
    expect(off.blocks).toBe(0);
    expect(off.root).toBe(root);
  });

  it('accepts the first four blocks in document order and no more', () => {
    const blocks = [1, 2, 3, 4, 5].map((n) => block(`b${n}`, n));
    const root = page([blocks[0], { type: 'section', id: 's', children: [blocks[1], blocks[2]] }, blocks[3], blocks[4]]);
    const result = applyCustomCode(root, live([1, 2, 3, 4, 5].map((n) => [n, declaration()])));
    expect(result.blocks).toBe(4);
    expect(runOf(result.root, 'b5')).toBeUndefined();
    expect(runOf(result.root, 'b4')).toBeDefined();
    expect(result.problems.map((p) => p.node)).toEqual(['b5']);
  });

  it('takes away a customCodeRun that arrives on a node: on a block, a refused block, a plain node, and with live code off', () => {
    const forged = { src: 'https://elsewhere.test/x', title: 'F', reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true, states: {} } as unknown as ComponentNode['customCodeRun'];
    const root = page([
      { ...block('b1', 1), customCodeRun: forged },
      { ...block('b2', 2), customCodeRun: forged },
      { type: 'p', id: 'plain', customCodeRun: forged },
    ]);
    const on = applyCustomCode(root, live([[1, declaration()]]));
    expect(runOf(on.root, 'b1')?.src).toBe(`${ORIGIN}/box/${SITE}/${hash(1)}`);
    expect(runOf(on.root, 'b2')).toBeUndefined();
    expect(runOf(on.root, 'plain')).toBeUndefined();
    const off = applyCustomCode(root, null);
    for (const id of ['b1', 'b2', 'plain']) expect(runOf(off.root, id)).toBeUndefined();
    const noBlocks = applyCustomCode(page([{ type: 'p', id: 'plain', customCodeRun: forged }]), live([]));
    expect(runOf(noBlocks.root, 'plain')).toBeUndefined();
  });

  it('never draws an island from a customCodeRun that arrives on a node', async () => {
    const forged = { src: 'https://elsewhere.test/x', title: 'F', reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true, states: {} } as unknown as ComponentNode['customCodeRun'];
    const { markup } = await html(page([{ ...block('b1', 1), customCodeRun: forged }]), null);
    expect(markup).not.toContain('data-fc-custom-code-state');
    expect(markup).not.toContain('elsewhere.test');
    expect(markup).toContain('Fallback');
  });

  it('accepts no block where the renderer draws no island, and gives such a block no slot (D66, D95)', () => {
    const inside = (id: string, n: number, host: Partial<ComponentNode>): ComponentNode => ({ type: 'div', id: `${id}-host`, ...host, children: [block(id, n)] });
    const root = page([
      inside('form', 1, { props: { 'data-form-kind': 'form' } }),
      { ...block('isForm', 2), props: { ...block('isForm', 2).props, 'data-form-kind': 'form' } },
      inside('field', 3, { props: { 'data-form-kind': 'form-field' } }),
      inside('cart', 4, { props: { 'data-component-kind': 'add-to-cart' } }),
      inside('part', 5, { props: { 'data-shop-part': 'checkout.button' } }),
      inside('sticky', 6, { props: { 'data-sticky-cta': 'bar' } }),
      inside('map', 7, { props: { [MAP_EMBED_ATTR]: MAP_EMBED_MARKER, mapAddress: 'Berlin' } }),
      inside('void', 8, { type: 'img' }),
      // In svg and math a block is drawn as their own container (a div there is a refused tag).
      { type: 'svg', id: 'svg-host', children: [{ ...block('svg', 9), type: 'g' }] },
      { type: 'math', id: 'math-host', children: [{ ...block('math', 10), type: 'mrow' }] },
      { type: 'svg', id: 'deep', children: [{ type: 'g', id: 'g', children: [block('deepSvg', 11)] }] },
      // A box that is itself svg or math is refused too.
      { ...block('ownSvg', 14, [{ type: 'circle', id: 'circle', props: { r: 2 } }]), type: 'svg' },
      { ...block('ownMath', 15, [{ type: 'mi', id: 'mi', props: { children: 'x' } }]), type: 'math' },
      // A foreignObject holds HTML again: a block there is drawn like any.
      { type: 'svg', id: 'fo-svg', children: [{ type: 'foreignObject', id: 'fo', children: [block('fo', 12)] }] },
      block('after', 13),
    ]);
    const forged = { src: 'https://elsewhere.test/x', title: 'F', reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true, states: {} } as unknown as ComponentNode['customCodeRun'];
    // A run that arrives inside a form is taken away like any other.
    (root.children![0].children![0] as ComponentNode).customCodeRun = forged;
    const result = applyCustomCode(root, live(Array.from({ length: 15 }, (_, i) => [i + 1, declaration({ writes: [] })])));
    const refused = ['form', 'isForm', 'field', 'cart', 'part', 'sticky', 'map', 'void', 'svg', 'math', 'deepSvg', 'ownSvg', 'ownMath'];
    for (const id of refused) expect(runOf(result.root, id), id).toBeUndefined();
    expect(runOf(result.root, 'fo')).toBeDefined();
    expect(runOf(result.root, 'after')).toBeDefined();
    expect(result.blocks).toBe(2);
    expect(result.problems.map((p) => p.node)).toEqual(refused);
    const reasons = Object.fromEntries(result.problems.map((p) => [p.node, p.reason]));
    expect(reasons.form).toContain('inside a form');
    expect(reasons.isForm).toContain('on a form');
    expect(reasons.cart).toContain('inside a shop control');
    expect(reasons.svg).toContain('inside svg');
    expect(reasons.math).toContain('inside math');
    expect(reasons.deepSvg).toContain('on a refused tag');
    expect(reasons.ownSvg).toContain('on svg');
    expect(reasons.ownMath).toContain('on math');
  });

  // Review 3 of pull request #452, L2: tags whose element children are not drawn as boxes.
  it.each([
    ['form controls', ['select', 'option', 'optgroup', 'datalist', 'textarea']],
    ['media', ['canvas', 'video', 'audio']],
    ['inert content', ['template', 'noscript']],
    ['a table column group', ['colgroup']],
  ])('refuses a block on or inside %s, where a frame is never seen, and gives it no slot (D66)', (_group, tags) => {
    const root = page([
      ...tags.flatMap((tag, i) => [
        { ...block(`on-${tag}`, 2 * i + 1), type: tag },
        { type: tag, id: `${tag}-host`, children: [block(`in-${tag}`, 2 * i + 2)] },
      ]),
      block('after', 99),
    ]);
    const result = applyCustomCode(root, live([...Array.from({ length: 2 * tags.length }, (_, i): [number, CustomCodeDeclaration] => [i + 1, declaration()]), [99, declaration()]]));
    for (const tag of tags) {
      expect(runOf(result.root, `on-${tag}`), tag).toBeUndefined();
      expect(runOf(result.root, `in-${tag}`), tag).toBeUndefined();
    }
    expect(runOf(result.root, 'after')).toBeDefined();
    expect(result.blocks).toBe(1);
    expect(FRAMELESS_TAGS.size).toBe(11);
    const reasons = Object.fromEntries(result.problems.map((p) => [p.node, p.reason]));
    for (const tag of tags) {
      expect(reasons[`on-${tag}`], tag).toMatch(new RegExp(`on a (${tag}|refused tag)`));
      expect(reasons[`in-${tag}`], tag).toMatch(new RegExp(`inside a (${tag}|refused tag)`));
    }
  });

  it('brings no broker for a page whose only block stands inside a form or svg', async () => {
    const root = page([
      { type: 'div', id: 'f', props: { 'data-form-kind': 'form' }, children: [block('b1', 1)] },
      { type: 'svg', id: 's', children: [block('b2', 2)] },
    ]);
    const { markup, program } = await html(root, live([[1, declaration()], [2, declaration()]]));
    expect(program).toBeNull();
    expect(markup).not.toContain('data-fc-custom-code-state');
    expect(markup).not.toContain('Content-Security-Policy');
    expect(markup).not.toContain('/box/');
  });

  // Hashes told apart by their first characters, which is all the trace shows.
  const marked = (c: string) => c.repeat(64);
  const liveMarked = (cs: string[]): LiveCustomCode => ({ siteId: SITE, origin: ORIGIN, blobs: new Map(cs.map((c) => [marked(c), declaration()])) });
  const markedBlock = (id: string, c: string, type = 'div', children?: ComponentNode[]): ComponentNode => ({
    type, id, props: { customCode: { sha256: marked(c), title: `Block ${id}` } }, ...(children ? { children } : {}),
  });

  // A span anywhere in HTML since C2's fifth review (D96): a div would close an open paragraph at any depth.
  it('draws an accepted void-tag block as a span island, and one in svg as a g with its fallback (customCodeBoxTag)', async () => {
    const root = page([markedBlock('v1', 'a', 'wbr'), { type: 'svg', id: 's', children: [markedBlock('v2', 'b', 'wbr', [{ type: 'circle', id: 'c', props: { r: 4 } }])] }]);
    const { markup } = await html(root, liveMarked(['a', 'b']));
    expect(markup).toMatch(/<span[^>]*data-fc-custom-code="aaaaaaaaaaaa"[^>]*data-fc-custom-code-state="waiting"/);
    expect(markup).toMatch(/<svg><g data-fc-custom-code="bbbbbbbbbbbb"><circle r="4"><\/circle><\/g><\/svg>/);
    expect(markup.match(/data-fc-custom-code-state=/g)).toHaveLength(1);
  });

  it('gives a void-tag block under a table part, a select or an option no frame and no slot, and one in a paragraph a span island with global attributes only', async () => {
    const root = page([
      { type: 'table', id: 't', children: [markedBlock('inTable', 'a', 'img')] },
      { type: 'select', id: 's', children: [markedBlock('inSelect', 'b', 'wbr')] },
      { type: 'p', id: 'p', children: [{ ...markedBlock('inP', 'c', 'img'), props: { ...markedBlock('inP', 'c', 'img').props, alt: 'A', src: '/x.png', title: 'T' } }] },
    ]);
    const result = applyCustomCode(root, liveMarked(['a', 'b', 'c']));
    expect(runOf(result.root, 'inTable')).toBeUndefined();
    expect(runOf(result.root, 'inSelect')).toBeUndefined();
    expect(runOf(result.root, 'inP')).toBeDefined();
    expect(result.blocks).toBe(1);
    expect(result.problems.map((p) => p.reason)).toEqual([
      'a frame is not drawn under a table, where a void tag gets no box; this block shows its fallback',
      // A select draws no element child at all (FRAMELESS_TAGS), which is said before the void tag's missing box.
      'a frame is not drawn inside a select; this block shows its fallback',
    ]);
    const { markup } = await html(root, liveMarked(['a', 'b', 'c']));
    expect(markup).not.toContain('aaaaaaaaaaaa');
    expect(markup).not.toContain('bbbbbbbbbbbb');
    expect(markup).toMatch(/<p><span title="T" data-fc-custom-code="cccccccccccc" data-fc-custom-code-state="waiting"><\/span><\/p>/);
  });

  it('runs the stored hash whatever a binding or the address says (D98, D68)', async () => {
    const bound: ComponentNode = {
      ...markedBlock('b1', 'a', 'div', [{ type: 'p', id: 'f', props: { children: 'Fallback' } }]),
      bindings: {
        customCode: { mode: 'read', expression: '{{page.params.code}}' },
        'customCode.sha256': { mode: 'read', expression: '{{page.params.code}}' },
      },
    };
    const rendered = await renderPublishedPage({ root: page([bound]), pageParams: { code: marked('b') }, cmsRepo, customCode: liveMarked(['a', 'b']) });
    const markup = renderToStaticMarkup(<>{rendered.body}</>);
    expect(markup).toContain('data-fc-custom-code="aaaaaaaaaaaa" data-fc-custom-code-state="waiting"');
    expect(markup).not.toContain('bbbbbbbbbbbb');
  });

  it('leaves a page without blocks as it is', () => {
    const root = page([{ type: 'p', id: 'x' }]);
    expect(applyCustomCode(root, live([])).root).toBe(root);
  });
});

const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;

async function html(root: ComponentNode, customCode: LiveCustomCode | null, mapPage = false) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const rendered = await renderPublishedPage({ root: mapPage ? { ...root, children: [...(root.children ?? []), { type: 'div', id: 'map', props: { [MAP_EMBED_ATTR]: MAP_EMBED_MARKER, mapAddress: 'Berlin' } }] } : root, pageParams: {}, cmsRepo, customCode });
  return { markup: renderToStaticMarkup(<>{rendered.body}</>), program: rendered.behaviour };
}

describe('the published page', () => {
  it('renders an accepted block as the island with its fallback, the per-site frame policy and the broker', async () => {
    const { markup, program } = await html(page([block('b1', 1)]), live([[1, declaration()]]));
    expect(markup).toContain(`data-fc-custom-code="${hash(1).slice(0, 12)}"`);
    expect(markup).toContain('data-fc-custom-code-state="waiting"');
    expect(markup).toContain('Fallback');
    expect(markup).not.toContain('<iframe');
    expect(markup).toContain(`<meta http-equiv="Content-Security-Policy" content="frame-src ${ORIGIN}/box/${SITE}/"/>`);
    expect(program).toEqual({ nodes: {}, broker: true });
  });

  it('keeps Google in the per-site policy on a page with a map, so the header alone decides it', async () => {
    const { markup } = await html(page([block('b1', 1)]), live([[1, declaration()]]), true);
    expect(markup).toContain(`content="frame-src ${ORIGIN}/box/${SITE}/ https://www.google.com"`);
  });

  it('makes a page whose block writes state run the runtime, so the state is held', async () => {
    const { markup, program } = await html(page([block('b1', 1)], STATES), live([[1, declaration({ writes: ['open'] })]]));
    expect(program?.broker).toBe(true);
    expect(Object.keys(program?.nodes ?? {})).toEqual(['root']);
    expect(markup).toContain('data-fc-behaviour-boot');
  });

  it('carries no broker, no policy and no island on a page without a block, or when nothing is live', async () => {
    const plain = await html(page([{ type: 'p', id: 'x', props: { children: 'Hi' } }]), live([]));
    expect(plain.program).toBeNull();
    expect(plain.markup).not.toContain('Content-Security-Policy');
    const off = await html(page([block('b1', 1)]), null);
    expect(off.program).toBeNull();
    expect(off.markup).not.toContain('data-fc-custom-code-state');
    expect(off.markup).toContain(`data-fc-custom-code="${hash(1).slice(0, 12)}"`);
    expect(off.markup).toContain('Fallback');
  });

  it('draws a fifth block as its fallback only', async () => {
    const blocks = [1, 2, 3, 4, 5].map((n) => block(`b${n}`, n));
    const { markup } = await html(page(blocks), live([1, 2, 3, 4, 5].map((n) => [n, declaration()])));
    expect(markup.match(/data-fc-custom-code-state=/g)).toHaveLength(4);
    expect(markup.match(/data-fc-custom-code="/g)).toHaveLength(5);
  });
});
