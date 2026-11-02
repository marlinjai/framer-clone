// Stored nodes never put code on a page: the published renderer and the shared
// editor and preview dispatch drop the same tags and props.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createComponentElement } from '@/lib/renderer/createComponentElement';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';

const published = (node: Record<string, unknown>) => renderToStaticMarkup(renderComponentNode({ id: 'n', ...node } as never) as never);
const editor = (type: string, props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createComponentElement({ type, props: {}, isHostElement: true } as never, props, [], props.children as never) as never,
  );

describe('blocked nodes', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  it.each(['script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'link', 'meta', 'SCRIPT', 'geolocation', 'camera', 'microphone', 'usermedia', 'install', 'model'])(
    'renders nothing for a stored <%s>',
    (type) => {
      expect(published({ type, props: { children: 'x' } })).toBe('');
      expect(editor(type, { children: 'x' })).toBe('');
    },
  );

  it('drops a blocked child and keeps its parent', () => {
    const html = published({ type: 'div', children: [{ id: 'a', type: 'script', props: { children: 'x' } }, { id: 'b', type: 'p', props: { children: 'kept' } }] });
    expect(html).toBe('<div><p>kept</p></div>');
  });

  it('drops raw html and stored handlers on both surfaces, and keeps the rest', () => {
    const props = { dangerouslySetInnerHTML: { __html: '<img onerror=x>' }, onClick: 'x', id: 'keep' };
    expect(published({ type: 'div', props })).toBe('<div id="keep"></div>');
    expect(editor('div', props)).toBe('<div id="keep"></div>');
  });

  it.each(['onclick', 'ONCLICK', 'onClick', 'OnMouseOver'])('drops a stored %s on a custom element', (name) => {
    expect(published({ type: 'x-y', props: { [name]: 'x', id: 'keep' } })).toBe('<x-y id="keep"></x-y>');
    expect(editor('x-y', { [name]: 'x', id: 'keep' })).toBe('<x-y id="keep"></x-y>');
  });

  it.each([
    ['attributeName', 'href'],
    ['attributeName', ' HREF '],
    ['attributename', 'xlink:href'],
    ['ATTRIBUTENAME', 'onclick'],
  ])('drops %s=%s on an SVG animation', (name, value) => {
    expect(published({ type: 'animate', props: { [name]: value, to: 'x' } })).toBe('<animate to="x"></animate>');
  });

  it.each([
    ['a', 'HREF', 'javascript:alert(1)'],
    ['a', 'href', ' jav\tascript:alert(1)'],
    ['a', 'HrEf', 'VBSCRIPT:x'],
    ['a', 'xlink:href', 'javascript:x'],
    ['button', 'FORMACTION', 'javascript:x'],
    ['form', 'ACTION', 'javascript:x'],
    ['x-y', 'href', 'data:text/html,x'],
  ])('drops a script destination on <%s %s>', (type, name, value) => {
    const html = published({ type, props: { [name]: value, id: 'keep' } });
    expect(html.toLowerCase()).not.toMatch(/script|data:/);
    expect(html).toContain('id="keep"');
  });

  it('keeps ordinary destinations', () => {
    expect(published({ type: 'a', props: { href: '/shop' } })).toContain('href="/shop"');
    expect(published({ type: 'img', props: { src: 'data:image/png;base64,AAAA', alt: '' } })).toContain('data:image/png');
  });

  it('keeps animation of a harmless attribute', () => {
    expect(published({ type: 'animate', props: { attributeName: 'opacity' } })).toContain('opacity');
  });

  it.each(['popover', 'POPOVER', 'popoverTarget', 'popovertargetaction', 'command', 'commandFor', 'action', 'formAction', 'formtarget', 'ping'])(
    'drops %s on the editor surfaces',
    (name) => {
      const html = editor('div', { [name]: 'x', id: 'keep' });
      expect(html).toBe('<div id="keep"></div>');
    },
  );

  it('never lets a stored form submit from an editor surface', () => {
    const element = createComponentElement({ type: 'form', props: {}, isHostElement: true } as never, { action: 'https://evil.test/steal' }, []) as React.ReactElement<{ action?: string; onSubmit: (e: { preventDefault(): void }) => void }>;
    expect(element.props.action).toBeUndefined();
    let stopped = false;
    element.props.onSubmit({ preventDefault: () => { stopped = true; } });
    expect(stopped).toBe(true);
  });

  it('keeps the handlers the editor attaches, which are functions', () => {
    const onClick = () => {};
    const element = createComponentElement({ type: 'div', props: {}, isHostElement: true } as never, { onClick }, []) as React.ReactElement<{ onClick: unknown }>;
    expect(element.props.onClick).toBe(onClick);
  });
});
