import { describe, expect, it } from 'vitest';
import { inputDraftFor } from '../makeInput';
import { inputExpressionFor, type InputDefinition } from '../inputs';

describe('inputDraftFor', () => {
  it('reads the type from the slot and takes the current value as the default', () => {
    expect(inputDraftFor({ type: 'h3', props: { children: 'Hello' } }, 'children', 'Text', [])).toEqual({
      input: { id: 'text', name: 'Text', type: 'text', default: 'Hello' },
      expression: '{{input.text}}',
    });
    expect(inputDraftFor({ type: 'a', props: { href: '/about' } }, 'href', 'Link', []).input).toMatchObject({ type: 'link', default: '/about' });
    expect(inputDraftFor({ type: 'b', props: {} }, 'visible', 'Shown', []).input).toMatchObject({ type: 'toggle', default: true });
    expect(inputDraftFor({ type: 'div', props: { style: { color: '#123456' } } }, 'style.color', 'Colour', []).input).toMatchObject({ type: 'color', default: '#123456' });
  });

  it('makes an image of a src and reads its address back', () => {
    const { input, expression } = inputDraftFor({ type: 'img', props: { src: '/a.jpg', alt: 'A' } }, 'src', 'Image', []);
    expect(input).toMatchObject({ type: 'image', default: { src: '/a.jpg', alt: 'A' } });
    expect(expression).toBe('{{input.image.src}}');
  });

  it('leaves out a default the type refuses, so the node keeps its own value', () => {
    const { input } = inputDraftFor({ type: 'a', props: { href: 'javascript:alert(1)' } }, 'href', 'Link', []);
    expect(input).toEqual({ id: 'link', name: 'Link', type: 'link' });
  });

  it('picks an id and a name the definition does not have yet', () => {
    const taken: InputDefinition[] = [{ id: 'text', name: 'Text', type: 'text' }, { id: 'text-2', name: 'Text 2', type: 'text' }];
    expect(inputDraftFor({ type: 'p', props: {} }, 'children', 'Text', taken).input).toMatchObject({ id: 'text-3', name: 'Text 3' });
  });

  it('on a nested placement, copies the inner input and takes the placement value', () => {
    const inner: InputDefinition = { id: 'tone', name: 'Tone', type: 'choice', options: [{ label: 'Dark', value: 'dark' }], default: 'dark', description: 'inner' };
    const { input, expression } = inputDraftFor({ type: '#component', props: { inputs: { tone: 'dark' } }, inner }, 'input.tone', 'Tone', []);
    expect(input).toEqual({ id: 'tone', name: 'Tone', type: 'choice', options: [{ label: 'Dark', value: 'dark' }], default: 'dark' });
    expect(expression).toBe('{{input.tone}}');
  });
});

describe('inputExpressionFor', () => {
  it('reads an image field by slot and anything else whole', () => {
    expect(inputExpressionFor({ id: 'p', type: 'image' }, 'alt')).toBe('{{input.p.alt}}');
    expect(inputExpressionFor({ id: 'p', type: 'image' }, 'title')).toBe('{{input.p}}');
    expect(inputExpressionFor({ id: 't', type: 'text' }, 'children')).toBe('{{input.t}}');
  });
});
