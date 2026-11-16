// A sandboxed custom code block on every surface (src/lib/renderer/customCode,
// plan docs/plans/2026-11-02-sandboxed-custom-code.md, slice C2):
//   - the published page renders the box and its fallback, marked with the
//     first characters of the hash only for a block, and never a frame;
//   - the canvas and the preview over the editor draw the tile;
//   - the standalone preview draws the box and its fallback;
//   - no surface ever draws an iframe from a stored value, a `src` or a `srcdoc`,
//     and `customCode` never reaches the DOM.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { previewSafeTree } from '@/lib/renderer/server/previewSafe';
import { BLOCKED_TAGS, isBlockedProp } from '@/lib/renderer/blockedNodes';
import { isRenderedAttribute } from '@/lib/renderer/renderVocabulary';
import ComponentModel, { ComponentTypeEnum, type ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import {
  CUSTOM_CODE_PREVIEW_LINK_TEXT,
  CUSTOM_CODE_TILE_TEXT,
  CustomCodeSurfaceContext,
  createCustomCodeElement,
} from '../customCodeElement';

const HASH = '0123456789abcdef'.repeat(4);
const OTHER_SITES_HASH = 'f'.repeat(64);
const TITLE = 'Truck wash scene';
const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fallback = (id: string): ComponentNode => ({ type: 'p', id: `${id}-fb`, props: { children: `Fallback of ${id}` } });

const blockNode = (id: string, customCode: unknown, extra: Record<string, unknown> = {}, children: ComponentNode[] = [fallback(id)]): ComponentNode => ({
  type: 'div',
  id,
  props: { customCode, style: { height: '200px' }, ...extra },
  children,
});

async function publish(...nodes: ComponentNode[]) {
  const page = await renderPublishedPage({ root: { type: 'div', id: 'root', children: nodes }, pageParams: {}, cmsRepo });
  return renderToStaticMarkup(<>{page.body}</>);
}

/** Every way a stored value could try to become a frame. */
const HOSTILE_VALUES: [string, unknown][] = [
  ['a block with src', { sha256: HASH, title: TITLE, src: 'https://evil.example/' }],
  ['a block with srcdoc', { sha256: HASH, title: TITLE, srcdoc: '<script>parent.x()</script>' }],
  ['a src and a title', { src: 'https://evil.example/', title: TITLE }],
  ['a srcdoc and a title', { srcdoc: '<script>parent.x()</script>', title: TITLE }],
  ['an iframe as markup', '<iframe src="https://evil.example/"></iframe>'],
  ['an address', 'https://evil.example/box/x'],
  ['an array', [HASH, TITLE]],
  ['a hash naming a path', { sha256: `../../evil.example/${HASH}`, title: TITLE }],
  ['a title with markup', { sha256: HASH, title: '<iframe src="https://evil.example/"></iframe>' }],
];

describe('the published page', () => {
  it('renders the box and its fallback, marked with the first 12 characters of the hash, and no frame', async () => {
    const markup = await publish(blockNode('cc', { sha256: HASH, title: TITLE }));
    expect(markup).toContain(`data-fc-custom-code="${HASH.slice(0, 12)}"`);
    expect(markup).toContain('Fallback of cc');
    expect(markup).not.toContain(HASH);
    expect(markup).not.toContain(TITLE);
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toMatch(/customcode/i);
    expect(markup).not.toContain(CUSTOM_CODE_TILE_TEXT);
  });

  it('keeps the box\'s own attributes and style', async () => {
    const markup = await publish(blockNode('cc', { sha256: HASH, title: TITLE }, { id: 'scene', className: 'hero' }));
    expect(markup).toMatch(/<div[^>]*id="scene"[^>]*data-fc-custom-code=/);
    expect(markup).toContain('class="hero');
  });

  it('shows the fallback alone for a proposal, without its id or a mark', async () => {
    const markup = await publish(blockNode('cc', { proposal: 'proposal-42', title: TITLE }));
    expect(markup).toContain('Fallback of cc');
    expect(markup).not.toContain('data-fc-custom-code');
    expect(markup).not.toContain('proposal-42');
    expect(markup).not.toContain('<iframe');
  });

  it('shows the fallback alone for a malformed value', async () => {
    for (const value of [undefined, null, 'x', {}, { sha256: HASH.toUpperCase(), title: TITLE }, { sha256: HASH }]) {
      const markup = await publish(blockNode('cc', value));
      expect(markup).toContain('Fallback of cc');
      expect(markup).not.toContain('data-fc-custom-code');
      expect(markup).not.toContain('<iframe');
      expect(markup).not.toMatch(/customcode/i);
    }
  });

  it('shows only the fallback for a hash of another site or one nobody stored: the page never draws the frame itself', async () => {
    // Which site a hash belongs to is the box's to know (its lookup is keyed on the
    // site and the hash, D3). The renderer draws no frame at all, so a foreign or
    // unknown hash cannot reach anything from here.
    const markup = await publish(blockNode('cc', { sha256: OTHER_SITES_HASH, title: TITLE }));
    expect(markup).toContain('Fallback of cc');
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toContain(OTHER_SITES_HASH);
  });

  it.each(HOSTILE_VALUES)('draws no frame from %s', async (_name, value) => {
    const markup = await publish(blockNode('cc', value));
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toContain('evil.example');
    expect(markup).not.toContain('srcdoc');
    expect(markup).not.toContain('<script');
    expect(markup).toContain('Fallback of cc');
  });

  it('refuses a stored iframe in the fallback, and one beside the block', async () => {
    const markup = await publish(
      blockNode('cc', { sha256: HASH, title: TITLE }, { srcDoc: '<p>x</p>' }, [
        { type: 'iframe', id: 'f1', props: { src: 'https://evil.example/', srcdoc: '<script>parent.x()</script>' } },
        fallback('cc'),
      ]),
      { type: 'iframe', id: 'f2', props: { src: `https://run.example.com/box/00000000-0000-4000-8000-000000000000/${HASH}`, sandbox: 'allow-scripts' } },
    );
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toContain('evil.example');
    expect(markup).not.toContain('run.example.com');
    expect(markup).toContain('Fallback of cc');
  });

  it('a stored node cannot pass for a block with the renderer\'s own mark', () => {
    for (const name of ['data-fc-custom-code', 'data-fc-custom-code-tile', 'data-fc-custom-code-preview']) {
      expect(isRenderedAttribute(name)).toBe(false);
    }
    const forged: ComponentNode = { type: 'div', id: 'x', props: { 'data-fc-custom-code': HASH.slice(0, 12), 'data-fc-custom-code-tile': '', children: 'x' } };
    expect(renderToStaticMarkup(<>{renderComponentNode(forged)}</>)).toBe('<div>x</div>');
  });

  it('draws a void tag holding the prop as a box with its fallback', async () => {
    const markup = await publish({ type: 'img', id: 'cc', props: { customCode: { sha256: HASH, title: TITLE }, alt: 'x' }, children: [fallback('cc')] });
    expect(markup).toMatch(/<div[^>]*data-fc-custom-code="0123456789ab"[^>]*>/);
    expect(markup).toContain('Fallback of cc');
  });
});

describe('the render gate', () => {
  it('keeps refusing iframe by name', () => {
    expect(BLOCKED_TAGS.has('iframe')).toBe(true);
    expect(renderComponentNode({ type: 'iframe', id: 'f', props: { src: 'https://run.example.com/box/x' } })).toBeNull();
  });

  it('drops customCode as an attribute under any value, without a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const value of [{ sha256: HASH, title: TITLE }, 'x', [HASH], 1, true]) expect(isBlockedProp('customCode', value)).toBe(true);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('customCode'));
  });
});

describe('a branch preview link', () => {
  it('takes customCode off, so the node is its fallback with no mark', () => {
    const tree = previewSafeTree(blockNode('cc', { sha256: HASH, title: TITLE }, { id: 'scene' }));
    expect(tree.props).toEqual({ style: { height: '200px' }, id: 'scene' });
    const markup = renderToStaticMarkup(<>{renderComponentNode(tree as ComponentNode)}</>);
    expect(markup).not.toContain('data-fc-custom-code');
    expect(markup).toContain('Fallback of cc');
  });
});

// The editor surfaces, through HeadlessComponentRenderer and createComponentElement, the
// dispatch the canvas shares (the canvas itself is mounted in CustomCode.editor.test.tsx).
const BREAKPOINTS = [{ id: 'desktop', minWidth: 0 }];

function modelOf(node: ComponentNode): ComponentInstance {
  const toSnapshot = (n: ComponentNode): Record<string, unknown> => ({
    id: n.id,
    type: n.type,
    componentType: ComponentTypeEnum.HOST,
    props: n.props ?? {},
    children: (n.children ?? []).map(toSnapshot),
  });
  return ComponentModel.create(toSnapshot(node) as never);
}

function drawPreview(node: ComponentNode, info?: { standalone: boolean; previewHref: string | null }) {
  const tree = <HeadlessComponentRenderer component={modelOf(node)} breakpointId="desktop" allBreakpoints={BREAKPOINTS} />;
  return render(info ? <CustomCodeSurfaceContext.Provider value={info}>{tree}</CustomCodeSurfaceContext.Provider> : tree).container;
}

describe('the preview over the editor', () => {
  it('draws the tile with the title, a badge and the link, never the fallback or a frame', () => {
    const container = drawPreview(blockNode('cc', { sha256: HASH, title: TITLE }), { standalone: false, previewHref: '/projects/s/preview?page=p' });
    const tile = container.querySelector('[data-fc-custom-code-tile]');
    expect(tile?.textContent).toContain(CUSTOM_CODE_TILE_TEXT);
    expect(tile?.textContent).toContain(TITLE);
    expect(tile?.querySelector('[data-fc-custom-code-badge]')?.textContent).toBe('Custom code');
    const link = tile?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/projects/s/preview?page=p');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.textContent).toBe(CUSTOM_CODE_PREVIEW_LINK_TEXT);
    expect(container.textContent).not.toContain('Fallback of cc');
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.innerHTML).not.toContain(HASH);
    expect(container.innerHTML).not.toMatch(/customcode/i);
  });

  it('draws the tile without a link where nobody said where the preview is', () => {
    const container = drawPreview(blockNode('cc', { sha256: HASH, title: TITLE }));
    expect(container.querySelector('[data-fc-custom-code-tile]')).not.toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('says what a proposal and an invalid value are', () => {
    const proposal = drawPreview(blockNode('cc', { proposal: 'p-1', title: TITLE }));
    expect(proposal.querySelector('[data-fc-custom-code-badge]')?.textContent).toBe('Proposed, not active');
    expect(proposal.innerHTML).not.toContain('p-1');
    cleanup();
    const invalid = drawPreview(blockNode('cc', 'nonsense'));
    expect(invalid.querySelector('[data-fc-custom-code-badge]')?.textContent).toBe('Not a valid block, shows its fallback');
    expect(invalid.innerHTML).not.toContain('nonsense');
  });

  it.each(HOSTILE_VALUES)('draws no frame from %s', (_name, value) => {
    const container = drawPreview(blockNode('cc', value));
    expect(container.querySelector('iframe, frame, object, embed')).toBeNull();
    // Nothing points anywhere: a title is text, and a stored address is never an attribute.
    expect(container.querySelector('[src], [srcdoc], [href]')).toBeNull();
    expect(container.innerHTML).not.toContain('srcdoc');
  });
});

describe('the standalone preview', () => {
  it('draws the box and its fallback with the mark, as the published page does, and no frame', () => {
    const container = drawPreview(blockNode('cc', { sha256: HASH, title: TITLE }), { standalone: true, previewHref: null });
    expect(container.querySelector('[data-fc-custom-code-tile]')).toBeNull();
    expect(container.querySelector(`[data-fc-custom-code="${HASH.slice(0, 12)}"]`)?.textContent).toContain('Fallback of cc');
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.innerHTML).not.toContain(HASH);
  });

  it('shows the fallback alone for a proposal', () => {
    const container = drawPreview(blockNode('cc', { proposal: 'p-1', title: TITLE }), { standalone: true, previewHref: null });
    expect(container.querySelector('[data-fc-custom-code]')).toBeNull();
    expect(container.textContent).toContain('Fallback of cc');
  });
});

describe('createCustomCodeElement', () => {
  it('never changes the props it is given', () => {
    const domProps = { id: 'a', customCode: { sha256: HASH, title: TITLE }, children: 'x' };
    renderToStaticMarkup(createCustomCodeElement('published', { tag: 'div', domProps, config: domProps.customCode }));
    expect(domProps).toEqual({ id: 'a', customCode: { sha256: HASH, title: TITLE }, children: 'x' });
  });

  it('takes customCode off the attributes even when the gate did not', () => {
    for (const surface of ['editor', 'preview', 'standalone', 'published'] as const) {
      const markup = renderToStaticMarkup(
        createCustomCodeElement(surface, { tag: 'div', domProps: { customCode: 'leak' }, config: { sha256: HASH, title: TITLE } }),
      );
      expect(markup).not.toContain('leak');
      expect(markup).not.toMatch(/customcode/i);
      expect(markup).not.toContain('<iframe');
    }
  });
});
