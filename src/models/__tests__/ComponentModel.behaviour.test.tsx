// Behaviour on the model and the renderers (docs/plans/2026-11-02-behaviour-model.md):
// `props.behaviour` is stored beside `style`, one action and one undo step, follows a
// duplicate, and never reaches the DOM on any surface. Paths: forward (a write), backtrack
// (emptying it), resume (a save and load), and re-entry (undo, and a refused write).
/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import PageModel from '../PageModel';
import ComponentModel, { createIntrinsicComponent, type ComponentInstance } from '../ComponentModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import HistoryStore from '@/stores/HistoryStore';
import { TEXT_NODE_TYPE } from '@/lib/renderer/textNode';
import { nodeDomProps, renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import HeadlessPageRenderer from '@/lib/renderer/HeadlessPageRenderer';
import { STICKY_CTA_ATTR, STICKY_CTA_MARKER } from '@/lib/stickyCta/stickyCta';
import { isAttributeProp } from '@/lib/styles/customEditor';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';

const D = 'bp-d';
const STORED = {
  state: [{ id: 's1', name: 'open', type: 'boolean', initial: false }],
  on: [{ id: 't1', on: 'click', do: [{ toggle: 's1' }] }],
};

function setup(props: Record<string, unknown> = {}) {
  const root = createIntrinsicComponent('root', 'div', {});
  const page = PageModel.create({
    id: 'page',
    metadata: { title: 'Home' },
    appComponentTree: getSnapshot(root),
    canvasNodes: defaultViewportSnapshots([D]),
  });
  page.appComponentTree.addChild(createIntrinsicComponent('card', 'div', props));
  const node = page.appComponentTree.children[0] as ComponentInstance;
  const history = HistoryStore.create({});
  history.setTargetStore(page);
  return { page, node, history };
}

afterEach(cleanup);

describe('setBehaviour', () => {
  it('stores it, replacing the props whole, as one undo step', () => {
    const { node, history } = setup({ className: 'x' });
    const before = node.props;
    expect(node.setBehaviour(STORED)).toEqual({ ok: true });
    expect(node.props).not.toBe(before);
    expect(node.props.behaviour).toEqual(STORED);
    expect(node.props.className).toBe('x');
    history.undo();
    expect(node.props).toEqual({ className: 'x' });
    expect(history.canUndo).toBe(false);
    history.redo();
    expect(node.props.behaviour).toEqual(STORED);
  });

  it('deletes emptied keys, and the prop when nothing is left, so a saved page stays unchanged', () => {
    const { node } = setup();
    node.setBehaviour({ state: [], on: STORED.on, bind: [] });
    expect(node.props.behaviour).toEqual({ on: STORED.on });
    node.setBehaviour({ on: [] });
    expect(node.props).toEqual({});
    node.setBehaviour(STORED);
    node.setBehaviour(undefined);
    expect(node.props).toEqual({});
  });

  it('keeps an entry the parser would refuse, so the panel can show it', () => {
    const { node } = setup();
    const refused = { on: [{ id: 't', on: 'click', do: [{ toggle: 'deleted-state' }] }] };
    expect(node.setBehaviour(refused)).toEqual({ ok: true });
    expect(node.props.behaviour).toEqual(refused);
  });

  it('refuses a node with no element and anything but an object', () => {
    const { page, node } = setup();
    const text = createIntrinsicComponent('t', TEXT_NODE_TYPE as never, { children: 'x' });
    page.appComponentTree.addChild(text);
    const stored = page.appComponentTree.children[1] as ComponentInstance;
    expect(stored.setBehaviour(STORED).ok).toBe(false);
    expect(stored.props).not.toHaveProperty('behaviour');
    for (const value of ['x', 1, []]) expect(node.setBehaviour(value as never).ok).toBe(false);
    expect(node.props).toEqual({});
  });

  it('survives a save and load unchanged', () => {
    const { page, node } = setup();
    node.setBehaviour(STORED);
    const loaded = PageModel.create(JSON.parse(JSON.stringify(getSnapshot(page))));
    expect((loaded.appComponentTree.children[0] as ComponentInstance).props.behaviour).toEqual(STORED);
  });
});

describe('duplicateComponent', () => {
  it('moves references inside the copy, leaves those outside, and never touches the original', () => {
    const { page, node } = setup();
    page.appComponentTree.addChild(createIntrinsicComponent('outside', 'div', {}));
    const inner = ComponentModel.create(getSnapshot(createIntrinsicComponent('inner', 'button', {
      behaviour: {
        on: [{ id: 't', on: 'click', do: [{ focus: 'panel' }, { focus: 'outside' }, { focus: 'card' }] }],
      },
    })));
    node.addChild(inner);
    node.addChild(createIntrinsicComponent('panel', 'div', {}));

    const copy = page.duplicateComponent('card') as ComponentInstance;
    const [copiedInner, copiedPanel] = copy.children as ComponentInstance[];
    expect(copy.id).not.toBe('card');
    expect(copiedInner.props.behaviour.on[0].do).toEqual([{ focus: copiedPanel.id }, { focus: 'outside' }, { focus: copy.id }]);
    expect((node.children[0] as ComponentInstance).props.behaviour.on[0].do).toEqual([{ focus: 'panel' }, { focus: 'outside' }, { focus: 'card' }]);
  });

  it('does the same for a floating element', () => {
    const floating = {
      ...getSnapshot(createIntrinsicComponent('float', 'div', { behaviour: { on: [{ id: 't', on: 'click', do: [{ focus: 'float' }] }] } })),
      canvasNodeType: 'floating' as never,
      canvasX: 0,
      canvasY: 0,
    };
    const page = PageModel.create({
      id: 'page',
      metadata: { title: 'Home' },
      appComponentTree: getSnapshot(createIntrinsicComponent('root', 'div', {})),
      canvasNodes: { ...defaultViewportSnapshots([D]), float: floating },
    });
    const copy = page.duplicateComponent('float') as ComponentInstance;
    expect(copy.props.behaviour.on[0].do).toEqual([{ focus: copy.id }]);
  });
});

describe('never reaching the DOM', () => {
  const values: [string, unknown][] = [['an object', STORED], ['a string', 'marker-text']];

  it.each(values)('skips %s when resolving props for the canvas', (_label, behaviour) => {
    const { node } = setup({ behaviour });
    const resolved = node.getResolvedProps(D, []);
    expect(resolved.attributes).not.toHaveProperty('behaviour');
    expect(resolved.style).not.toHaveProperty('behaviour');
  });

  it.each(values)('drops %s on the published page, and on what an island spreads', (_label, behaviour) => {
    const shells: Record<string, unknown>[] = [
      {},
      { 'data-form-kind': 'form' },
      { 'data-form-kind': 'form-field', fieldType: 'select' },
      { 'data-form-kind': 'form-submit', children: 'Send' },
      { [STICKY_CTA_ATTR]: STICKY_CTA_MARKER, href: '/x', label: 'Buy' },
    ];
    for (const shell of shells) {
      const node: ComponentNode = { id: 'a', type: 'div', props: { ...shell, behaviour } as never };
      const { container, unmount } = render(<>{renderComponentNode(node)}</>);
      expect(container.innerHTML, JSON.stringify(shell)).not.toMatch(/behaviou?r|marker-text|object Object/i);
      unmount();
    }
    for (const kind of ['cart-view', 'add-to-cart', 'variant-selector', 'checkout-button']) {
      expect(nodeDomProps({ id: 'a', type: 'div', props: { 'data-component-kind': kind, behaviour } as never })).not.toHaveProperty('behaviour');
    }
  });

  it.each(values)('drops %s on the headless surfaces, the preview among them', (_label, behaviour) => {
    const child = (id: string, props: Record<string, unknown>) => ({ id, type: 'div', componentType: 'host', canvasNodeType: 'component', props: { ...props, behaviour } });
    const page = PageModel.create({
      id: 'p',
      metadata: { title: 'x' },
      appComponentTree: {
        ...child('root', {}),
        children: [
          child('plain', {}),
          child('form', { 'data-form-kind': 'form' }),
          child('sticky', { [STICKY_CTA_ATTR]: STICKY_CTA_MARKER, href: '/x', label: 'Buy' }),
        ],
      } as never,
      canvasNodes: defaultViewportSnapshots([D]),
    });
    const { container } = render(<HeadlessPageRenderer page={page as any} breakpointId={D} /> as any);
    expect(container.innerHTML).not.toMatch(/behaviou?r|marker-text|object Object/i);
    expect(container.querySelector('[data-inner-component-id="plain"]')).not.toBeNull();
  });

  it('is not offered as an attribute in the Custom section', () => {
    expect(isAttributeProp('behaviour')).toBe(false);
  });
});
