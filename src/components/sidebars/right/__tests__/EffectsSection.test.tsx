// The Effects section and the effects model on a component: appear and scroll
// cascade per breakpoint (with the source dot and reset), hover is one value,
// every write is one undo step and never leaks into the DOM attributes.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import PageModel from '@/models/PageModel';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import HistoryStore from '@/stores/HistoryStore';
import { EffectsSection, hoverOptionsFor } from '../sections/EffectsSection';
import { SECTION_MAP } from '../sectionConfig';
import { effectBadgeText } from '@/components/EffectBadge';
import { normalizeAppear, NO_SCROLL } from '@/lib/effects/effects';

const D = 'bp-d';
const T = 'bp-t';
const P = 'bp-p';

function setup(type = 'section', props: Record<string, unknown> = {}, withChildren = true) {
  const page = PageModel.create({
    id: 'page',
    metadata: { title: 'Home' },
    appComponentTree: getSnapshot(createIntrinsicComponent('root', 'div', {})),
    canvasNodes: defaultViewportSnapshots([D, T, P]),
  });
  page.appComponentTree.addChild(createIntrinsicComponent('node', type as 'div', props));
  const node = page.appComponentTree.children[0] as ComponentInstance;
  if (withChildren && type !== 'img') {
    node.addChild(createIntrinsicComponent('c1', 'p', { children: 'One' }));
    node.addChild(createIntrinsicComponent('c2', 'p', { children: 'Two' }));
  }
  const history = HistoryStore.create({});
  history.setTargetStore(page);
  return { node, history };
}

const row = (label: string) => screen.getByText(label, { selector: 'label' }).closest('div.grid') as HTMLElement;
const select = (label: string) => within(row(label)).getByRole('combobox') as HTMLSelectElement;

afterEach(cleanup);

describe('effects model', () => {
  it('stores nothing until an effect is set, and nothing again once it is none', () => {
    const { node } = setup();
    expect(node.props.effects).toBeUndefined();
    node.setEffect('appear', normalizeAppear({ kind: 'fade' }));
    expect(node.props.effects.appear.kind).toBe('fade');
    node.setEffect('appear', normalizeAppear({ kind: 'none' }));
    expect(node.props.effects).toBeUndefined();
  });

  it('cascades appear desktop-first: none on Phone only', () => {
    const { node } = setup();
    node.setEffect('appear', normalizeAppear({ kind: 'slide-up' }), D);
    node.setEffect('appear', normalizeAppear({ kind: 'none' }), P);
    expect(node.getEffect('appear', D).kind).toBe('slide-up');
    expect(node.getEffect('appear', T).kind).toBe('slide-up');
    expect(node.getEffect('appear', P).kind).toBe('none');
    expect(node.getEffectSource('appear', P).source.kind).toBe('own');
    expect(node.getEffectSource('appear', T).source).toEqual({ kind: 'inherited', breakpointId: D });
    node.resetEffect('appear', P);
    expect(node.getEffect('appear', P).kind).toBe('slide-up');
  });

  it('never renders effects as a DOM attribute', () => {
    const { node } = setup();
    node.setEffect('hover', 'dim');
    const { attributes } = node.getResolvedProps(D, [{ id: D, minWidth: 1280 }, { id: T, minWidth: 768 }, { id: P, minWidth: 320 }]);
    expect(attributes).not.toHaveProperty('effects');
  });
});

describe('EffectsSection', () => {
  it('is offered for containers, text, images and generic elements, not the viewport', () => {
    expect(SECTION_MAP.container).toContain('effects');
    expect(SECTION_MAP.text).toContain('effects');
    expect(SECTION_MAP.image).toContain('effects');
    expect(SECTION_MAP.viewport).not.toContain('effects');
  });

  it('sets an appear in one undo step and shows its fields', () => {
    const { node, history } = setup();
    render(<EffectsSection component={node} breakpointId={D} />);
    // Collapsed while the element has no effects.
    expect(screen.queryByText('Appear')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Effects/ }));
    fireEvent.change(select('Appear'), { target: { value: 'slide-up' } });
    expect(node.getEffect('appear', D).kind).toBe('slide-up');
    expect(history.history.length).toBe(1);
    expect(screen.getByText('Distance')).toBeTruthy();
    expect(screen.getByText('Duration')).toBeTruthy();
    expect(screen.getByText('Stagger')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Play/ })).toBeTruthy();
  });

  it('clamps a typed duration to the motion limits', () => {
    const { node } = setup('section', { effects: { appear: normalizeAppear({ kind: 'fade' }) } });
    render(<EffectsSection component={node} breakpointId={D} />);
    const input = within(row('Duration')).getByRole('textbox');
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.blur(input);
    expect(node.getEffect('appear', D).duration).toBe(400);
  });

  it('shows the breakpoint source dot on Phone and resets the override', () => {
    const { node } = setup('section', {
      effects: { appear: { base: normalizeAppear({ kind: 'fade' }), [P]: normalizeAppear({ kind: 'none' }) } },
    });
    render(<EffectsSection component={node} breakpointId={P} />);
    const reset = within(row('Appear')).getByRole('button', { name: 'Set on Mobile, click to reset to Desktop' });
    fireEvent.click(reset);
    expect(node.getEffect('appear', P).kind).toBe('fade');
  });

  it('plays the appear on the canvas element of the edited breakpoint', () => {
    const { node } = setup('section', { effects: { appear: normalizeAppear({ kind: 'fade' }) } });
    const canvasEl = document.createElement('section');
    canvasEl.setAttribute('data-component-id', `${D}-node`);
    const animate = vi.fn(() => ({ cancel() {} }));
    (canvasEl as unknown as { animate: unknown }).animate = animate;
    document.body.appendChild(canvasEl);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    window.matchMedia = globalThis.matchMedia as typeof window.matchMedia;
    render(<EffectsSection component={node} breakpointId={D} />);
    fireEvent.click(screen.getByRole('button', { name: /Play/ }));
    expect(animate).toHaveBeenCalledTimes(1);
    canvasEl.remove();
    vi.unstubAllGlobals();
  });

  it('offers parallax only on images, underline only on links, and no lift with a parallax', () => {
    const { node } = setup('img', { src: '/a.jpg' }, false);
    render(<EffectsSection component={node} breakpointId={D} />);
    fireEvent.click(screen.getByRole('button', { name: /Effects/ }));
    fireEvent.change(select('Scroll'), { target: { value: 'parallax' } });
    expect(node.getEffect('scroll', D).kind).toBe('parallax');
    expect(screen.getByText('Strength')).toBeTruthy();
    expect(hoverOptionsFor('img', true).map(o => o.value)).toEqual(['none', 'dim']);
    expect(hoverOptionsFor('a', false).map(o => o.value)).toContain('underline');
    expect(hoverOptionsFor('div', false).map(o => o.value)).not.toContain('underline');
    cleanup();
    const { node: section } = setup();
    render(<EffectsSection component={section} breakpointId={D} />);
    fireEvent.click(screen.getByRole('button', { name: /Effects/ }));
    expect(screen.queryByText('Scroll')).toBeNull();
  });
});

describe('canvas badge', () => {
  it('names the effects, and is empty without any', () => {
    expect(effectBadgeText(normalizeAppear({ kind: 'fade' }), 'lift', NO_SCROLL)).toBe('Fade in · Hover lift');
    expect(effectBadgeText(normalizeAppear({}), 'none', NO_SCROLL)).toBeNull();
  });
});
