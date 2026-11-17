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
import { applyCustomCode, customCodeHashes, type LiveCustomCode } from '../applyCustomCode';
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
