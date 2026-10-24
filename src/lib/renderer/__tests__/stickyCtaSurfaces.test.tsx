/* eslint-disable @typescript-eslint/no-explicit-any */
// The sticky call to action on the editor surfaces (src/lib/stickyCta): the
// canvas shows a labelled normal block whose link never navigates, the
// preview pins the page's first bar at the end of the page root on the
// smallest breakpoint only, the Components panel inserts at most one per page
// (at the end of the page), and the properties panel edits its link.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import PageModel from '@/models/PageModel';
import ComponentModel, { ComponentTypeEnum } from '@/models/ComponentModel';
import HeadlessPageRenderer from '../HeadlessPageRenderer';
import { createComponentElement } from '../createComponentElement';
import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { getComponentCategory, SECTION_MAP } from '@/components/sidebars/right/sectionConfig';
import { StickyCtaSection } from '@/components/sidebars/right/sections/StickyCtaSection';

const BAR_PROPS = { 'data-sticky-cta': 'bar', ctaLabel: 'Book a table', ctaHref: '#booking', style: { backgroundColor: '#ffffff' } };

function viewport(id: string, label: string, breakpointId: string, minWidth: number) {
  return {
    id,
    type: 'div',
    componentType: 'host',
    canvasNodeType: 'viewport',
    label,
    breakpointId,
    breakpointMinWidth: minWidth,
    viewportWidth: Math.max(minWidth, 390),
    viewportHeight: 800,
    canvasX: 0,
    canvasY: 0,
    props: {},
  };
}

function makePage(children: any[]) {
  return PageModel.create({
    id: 'page-test',
    slug: 'test',
    metadata: { title: 'Test page', description: '', keywords: [], ogTitle: '', ogDescription: '', ogImage: '', canonicalUrl: '' },
    appComponentTree: { id: 'root', type: 'div', componentType: 'host', canvasNodeType: 'component', props: {}, children },
    canvasNodes: {
      'viewport-desktop': viewport('viewport-desktop', 'Desktop', 'bp-desktop', 1280),
      'viewport-mobile': viewport('viewport-mobile', 'Mobile', 'bp-mobile', 0),
    },
  } as any);
}

const hero = {
  id: 'hero',
  type: 'section',
  componentType: 'host',
  props: {},
  children: [
    { id: 'bar-1', type: 'div', componentType: 'host', props: BAR_PROPS },
    { id: 'h1', type: 'h1', componentType: 'host', props: { children: 'Trattoria' } },
  ],
};
const second = { id: 'bar-2', type: 'div', componentType: 'host', props: { ...BAR_PROPS, ctaLabel: 'Second bar' } };

afterEach(() => {
  cleanup();
  delete (window as any).__componentRegistry;
});

describe('the preview', () => {
  it('pins the first bar at the end of the page root on the smallest breakpoint', () => {
    const page = makePage([hero, second]);
    const { container } = render(<HeadlessPageRenderer page={page} breakpointId="bp-mobile" />);
    const root = container.querySelector('[data-inner-component-id="root"]')!;
    const wrapper = root.lastElementChild as HTMLElement;
    expect(wrapper.hasAttribute('data-fc-sticky-cta-preview')).toBe(true);
    expect(wrapper.style.position).toBe('sticky');
    expect(wrapper.style.bottom).toBe('0px');
    const links = container.querySelectorAll('a[data-fc-sticky-cta-link]');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('#booking');
    expect(links[0].textContent).toBe('Book a table');
    // Not drawn where it sits in the hero, and the second bar never.
    expect(container.querySelector('[data-inner-component-id="hero"] [data-sticky-cta]')).toBeNull();
    expect(container.textContent).not.toContain('Second bar');
  });

  it('hides the bar on larger breakpoints', () => {
    const page = makePage([hero]);
    const { container } = render(<HeadlessPageRenderer page={page} breakpointId="bp-desktop" />);
    expect(container.querySelector('[data-sticky-cta]')).toBeNull();
    expect(container.querySelector('[data-fc-sticky-cta-preview]')).toBeNull();
    expect(container.textContent).toContain('Trattoria');
  });
});

describe('the editor canvas', () => {
  it('draws a labelled normal block whose link does not navigate', () => {
    const bar = ComponentModel.create({ id: 'bar-1', type: 'div', componentType: ComponentTypeEnum.HOST, props: BAR_PROPS });
    const element = createComponentElement(bar as any, { ...BAR_PROPS }, [], undefined, {
      identity: { breakpointId: 'bp-mobile', componentId: 'bar-1' },
      mode: 'editor',
    });
    const { container } = render(<>{element}</>);
    const block = container.querySelector('[data-inner-component-id="bar-1"]') as HTMLElement;
    expect(block.style.position).toBe('relative');
    expect(block.getAttribute('aria-label')).toMatch(/Sticky call to action/);
    expect(container.querySelector('[data-fc-sticky-cta-label]')!.textContent).toMatch(/Sticky call to action/);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[data-fc-sticky-cta-link]')!.textContent).toBe('Book a table');
    expect(block.hasAttribute('ctaLabel')).toBe(false);
  });
});

describe('inserting from the Components panel', () => {
  it('appends the bar to the end of the page, and a second drop selects the existing one', () => {
    const page = makePage([{ id: 'hero', type: 'section', componentType: 'host', props: {}, children: [] }]);
    const first = page.insertRegistryComponent('stickyCta', { kind: 'parent', parentId: 'hero', index: 0 })!;
    const root = page.appComponentTree as any;
    expect(root.children.map((c: any) => c.id)).toEqual(['hero', first.id]);
    expect(first.props['data-sticky-cta']).toBe('bar');
    expect(first.label).toBe('Sticky call to action');
    const again = page.insertRegistryComponent('stickyCta', { kind: 'floating', x: 10, y: 10 });
    expect(again).toBe(first);
    expect(root.children).toHaveLength(2);
    expect(page.canvasNodes.size).toBe(2);
  });

  it('is a registry component in the basic category with its own panel section', () => {
    expect(COMPONENT_REGISTRY.stickyCta).toMatchObject({ category: 'basic', htmlType: 'div' });
    const bar = ComponentModel.create({ id: 'bar-1', type: 'div', componentType: ComponentTypeEnum.HOST, props: BAR_PROPS });
    expect(getComponentCategory(bar as any)).toBe('stickyCta');
    expect(SECTION_MAP.stickyCta[0]).toBe('stickyCta');
  });
});

describe('the properties panel', () => {
  it('edits the label and the link, and refuses an unsafe link', () => {
    const bar = ComponentModel.create({ id: 'bar-1', type: 'div', componentType: ComponentTypeEnum.HOST, props: BAR_PROPS });
    render(<StickyCtaSection component={bar as any} />);
    const [label, link] = screen.getAllByRole('textbox');
    fireEvent.change(label, { target: { value: 'Reserve now' } });
    expect(bar.props.ctaLabel).toBe('Reserve now');
    fireEvent.change(link, { target: { value: '/contact' } });
    expect(bar.props.ctaHref).toBe('/contact');
    fireEvent.change(link, { target: { value: 'javascript:alert(1)' } });
    expect(bar.props.ctaHref).toBe('/contact');
    expect(screen.getByRole('alert').textContent).toMatch(/page path/);
    fireEvent.change(link, { target: { value: '' } });
    expect(bar.props.ctaHref).toBeUndefined();
    expect(screen.getByRole('alert').textContent).toMatch(/Add a link/);
  });
});
