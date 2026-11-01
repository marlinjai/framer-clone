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

  it.each(['script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'link', 'meta', 'SCRIPT'])(
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

  it('keeps the handlers the editor attaches, which are functions', () => {
    const onClick = () => {};
    const element = createComponentElement({ type: 'div', props: {}, isHostElement: true } as never, { onClick }, []) as React.ReactElement<{ onClick: unknown }>;
    expect(element.props.onClick).toBe(onClick);
  });
});
