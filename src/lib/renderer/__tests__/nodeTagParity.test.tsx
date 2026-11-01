// A stored node type is the tag on both surfaces. The published renderer used to
// read it as a registry id first, so `form` came out as the Form entry's div and
// `link` as the Link entry's a, while the canvas emitted the type unchanged.
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { createComponentElement } from '@/lib/renderer/createComponentElement';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { FORM_KIND_ATTR } from '@/lib/forms/definition';

const published = (node: Record<string, unknown>) => renderToStaticMarkup(renderComponentNode({ id: 'n', ...node } as never) as never);
const canvas = (type: string, props: Record<string, unknown>, children: React.ReactNode[] = []) =>
  renderToStaticMarkup(
    createComponentElement({ type, props: {}, isHostElement: true } as never, props, children, props.children as never) as never,
  );

describe('stored node types', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('renders an unmarked form as a form on both surfaces, children included', () => {
    const child = { id: 'c', type: 'p', props: { children: 'x' } };
    expect(published({ type: 'form', props: { id: 'f' }, children: [child] })).toBe('<form id="f"><p>x</p></form>');
    expect(canvas('form', { id: 'f' }, [<p key="c">x</p>])).toBe('<form id="f"><p>x</p></form>');
  });

  it.each(Object.keys(COMPONENT_REGISTRY))('emits the same markup on both surfaces for the type %s', (id) => {
    expect(published({ type: id, props: { title: 't' } })).toBe(canvas(id, { title: 't' }));
  });

  it('renders the Link component as a link, with its target, on both surfaces', () => {
    const { htmlType } = COMPONENT_REGISTRY.link;
    expect(htmlType).toBe('a');
    const props = { href: '/about', children: 'About' };
    expect(published({ type: htmlType, props })).toBe('<a href="/about">About</a>');
    expect(canvas(htmlType, props)).toBe('<a href="/about">About</a>');
  });

  it('still mounts the form island for a marked node, whichever tag it stores', () => {
    for (const type of ['div', 'form']) {
      const html = published({ type, props: { [FORM_KIND_ATTR]: 'form', formName: 'Contact' } });
      expect(html.match(/<form[ >]/g)).toHaveLength(1);
      expect(html).toContain('action="/api/forms/submit"');
    }
  });

  it('does not let a stored form run a javascript url', () => {
    const html = published({ type: 'form', props: { action: 'javascript:alert(1)' } });
    expect(html).toMatch(/^<form/);
    expect(html).not.toContain('alert(1)');
  });
});
