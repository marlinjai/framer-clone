// The preview renders effects for the breakpoint it shows: attributes and
// custom properties when the effect is on there, nothing when it is none.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import PageModel from '@/models/PageModel';
import { createIntrinsicComponent } from '@/models/ComponentModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import HeadlessPageRenderer from '../HeadlessPageRenderer';
import { FX_ATTR, FX_VAR, normalizeAppear } from '@/lib/effects/effects';

afterEach(cleanup);

function setup() {
  const page = PageModel.create({
    id: 'page',
    metadata: { title: 'Home' },
    appComponentTree: getSnapshot(createIntrinsicComponent('root', 'div', {})),
    canvasNodes: defaultViewportSnapshots(['bp-d', 'bp-t', 'bp-p']),
  });
  page.appComponentTree.addChild(createIntrinsicComponent('hero', 'section', {
    effects: {
      appear: { base: normalizeAppear({ kind: 'slide-up', distance: 24 }), 'bp-p': normalizeAppear({ kind: 'none' }) },
      hover: 'dim',
    },
  }));
  return page;
}

describe('preview effects', () => {
  it('renders the appear on Desktop with its start values as custom properties', () => {
    const { container } = render(<HeadlessPageRenderer page={setup()} breakpointId="bp-d" />);
    const hero = container.querySelector('section')!;
    expect(hero.hasAttribute(FX_ATTR.appear)).toBe(true);
    expect(hero.classList.contains('fc_fx-dim')).toBe(true);
    expect(hero.hasAttribute('data-fx-h')).toBe(false);
    expect(hero.style.getPropertyValue(FX_VAR.startY)).toBe('24px');
    expect(hero.hasAttribute('effects')).toBe(false);
  });

  it('renders no appear on Mobile where it is none, hover stays', () => {
    const { container } = render(<HeadlessPageRenderer page={setup()} breakpointId="bp-p" />);
    const hero = container.querySelector('section')!;
    expect(hero.hasAttribute(FX_ATTR.appear)).toBe(false);
    expect(hero.classList.contains('fc_fx-dim')).toBe(true);
  });

  it('adds the preset class to a stored className and gives an unset preset none', () => {
    const page = setup();
    page.appComponentTree.addChild(createIntrinsicComponent('card', 'article', { className: 'card', effects: { hover: 'lift' } }));
    page.appComponentTree.addChild(createIntrinsicComponent('plain', 'aside', { effects: { hover: 'none' } }));
    const { container } = render(<HeadlessPageRenderer page={page} breakpointId="bp-d" />);
    expect(container.querySelector('article')!.className).toBe('card fc_fx-lift');
    expect(container.querySelector('aside')!.hasAttribute('class')).toBe(false);
  });
});
