import { describe, expect, it } from 'vitest';
import {
  INPUT_TYPES,
  inputDefinitionRefusal,
  MAX_LIST_ITEMS,
  mayBindToSlot,
  parseInputValue,
  type InputDefinition,
  type InputType,
} from '../inputs';

const input = (type: InputType, extra: Partial<InputDefinition> = {}): InputDefinition => ({ id: 'x', name: 'X', type, ...extra });

const parsed = (definition: InputDefinition, value: unknown): unknown => {
  const result = parseInputValue(definition, value);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
};
const refused = (definition: InputDefinition, value: unknown): boolean => !parseInputValue(definition, value).ok;

describe('parseInputValue', () => {
  it('has a case for each of the 17 types', () => {
    expect(INPUT_TYPES).toHaveLength(17);
    for (const type of INPUT_TYPES) {
      expect(parseInputValue(input(type), Symbol('no type takes this')).ok).toBe(false);
    }
  });

  it('text: a string, within its length, and a number as its digits', () => {
    expect(parsed(input('text'), 'Hello')).toBe('Hello');
    expect(parsed(input('text'), 12)).toBe('12');
    expect(refused(input('text'), { a: 1 })).toBe(true);
    expect(refused(input('text'), NaN)).toBe(true);
    expect(refused(input('text', { maxLength: 3 }), 'four')).toBe(true);
  });

  it('number: finite, in range, with its unit', () => {
    expect(parsed(input('number'), 4)).toBe(4);
    expect(parsed(input('number', { unit: 'rem' }), 4)).toBe('4rem');
    expect(refused(input('number'), '4')).toBe(true);
    expect(refused(input('number'), Infinity)).toBe(true);
    expect(refused(input('number', { min: 5 }), 4)).toBe(true);
    expect(refused(input('number', { max: 3 }), 4)).toBe(true);
  });

  it('toggle: strictly a boolean', () => {
    expect(parsed(input('toggle'), false)).toBe(false);
    expect(refused(input('toggle'), 'false')).toBe(true);
    expect(refused(input('toggle'), 0)).toBe(true);
  });

  it('color: a safe value or a responsive map of them', () => {
    expect(parsed(input('color'), ' #fff ')).toBe('#fff');
    expect(parsed(input('color'), { base: 'red', mobile: 'blue' })).toEqual({ base: 'red', mobile: 'blue' });
    expect(refused(input('color'), 'red;background:url(https://track.example/x)')).toBe(true);
    expect(refused(input('color'), 'url(https://track.example/x)')).toBe(true);
    expect(refused(input('color'), { base: 'red', mobile: 'red;x:y' })).toBe(true);
    expect(refused(input('color'), {})).toBe(true);
    expect(refused(input('color'), 3)).toBe(true);
  });

  it('image: a safe address with its description', () => {
    expect(parsed(input('image'), { src: '/a.jpg', alt: 'A' })).toEqual({ src: '/a.jpg', alt: 'A' });
    expect(parsed(input('image'), 'https://cdn.example/a.jpg')).toEqual({ src: 'https://cdn.example/a.jpg', alt: '' });
    expect(parsed(input('image'), { src: '/a.jpg', focalPoint: { x: 0.5, y: 0.2 } })).toEqual({
      src: '/a.jpg',
      alt: '',
      focalPoint: { x: 0.5, y: 0.2 },
    });
    expect(refused(input('image'), { src: 'javascript:alert(1)' })).toBe(true);
    expect(refused(input('image'), { src: 'data:image/svg+xml,x' })).toBe(true);
    expect(refused(input('image'), { src: '/_next/image?url=https://evil.example' })).toBe(true);
    expect(refused(input('image'), { src: '/a.jpg', alt: 3 })).toBe(true);
    expect(refused(input('image'), { src: '/a.jpg', focalPoint: { x: 'left' } })).toBe(true);
    expect(refused(input('image'), [])).toBe(true);
  });

  it('link and file: a safe address only', () => {
    for (const type of ['link', 'file'] as const) {
      expect(parsed(input(type), '/about us')).toBe('/about%20us');
      expect(refused(input(type), 'javascript:alert(1)')).toBe(true);
      expect(refused(input(type), 3)).toBe(true);
    }
  });

  it('choice: one of its options', () => {
    const choice = input('choice', { options: [{ label: 'Dark', value: 'dark' }] });
    expect(parsed(choice, 'dark')).toBe('dark');
    expect(refused(choice, 'light')).toBe(true);
    expect(refused(input('choice'), 'dark')).toBe(true);
  });

  it('richtext: validated runs, never markup, or a plain string', () => {
    const runs = { runs: [{ text: 'Bold', marks: ['strong'] }, { text: 'link', href: '/a b' }] };
    expect(parsed(input('richtext'), runs)).toEqual({
      runs: [{ text: 'Bold', marks: ['strong'] }, { text: 'link', href: '/a%20b' }],
    });
    expect(parsed(input('richtext'), '<b>as text</b>')).toBe('<b>as text</b>');
    expect(refused(input('richtext'), { runs: [{ text: 'x', marks: ['script'] }] })).toBe(true);
    expect(refused(input('richtext'), { runs: [{ text: 'x', href: 'javascript:alert(1)' }] })).toBe(true);
    expect(refused(input('richtext'), { runs: [{ marks: [] }] })).toBe(true);
    expect(refused(input('richtext'), { html: '<b>' })).toBe(true);
  });

  it('date: an ISO 8601 string', () => {
    expect(parsed(input('date'), '2026-11-02')).toBe('2026-11-02');
    expect(parsed(input('date'), '2026-11-02T10:00:00Z')).toBe('2026-11-02T10:00:00Z');
    expect(refused(input('date'), 'next week')).toBe(true);
    expect(refused(input('date'), '2026-13-45')).toBe(true);
    expect(refused(input('date'), 1762041600000)).toBe(true);
  });

  it('border, shadow and transition: safe CSS that fetches nothing', () => {
    expect(parsed(input('border'), '1px solid red')).toBe('1px solid red');
    expect(parsed(input('shadow'), '0 1px 2px rgba(0,0,0,0.2)')).toBe('0 1px 2px rgba(0,0,0,0.2)');
    expect(parsed(input('transition'), 'translate 160ms')).toBe('translate 160ms');
    for (const type of ['border', 'shadow', 'transition'] as const) {
      expect(refused(input(type), 'x;background:red')).toBe(true);
      expect(refused(input(type), 'x}y{')).toBe(true);
      expect(refused(input(type), 'image-set("https://track.example/x" 1x)')).toBe(true);
      expect(refused(input(type), '')).toBe(true);
      expect(refused(input(type), 3)).toBe(true);
    }
  });

  it('cursor: a keyword', () => {
    expect(parsed(input('cursor'), 'pointer')).toBe('pointer');
    expect(refused(input('cursor'), 'url(/x.png), auto')).toBe(true);
    expect(refused(input('cursor'), 'POINTER')).toBe(true);
  });

  it('list: each item checked, unknown keys dropped, at most 100', () => {
    const list = input('list', { fields: [input('text', { id: 'label' }), input('link', { id: 'to' })] });
    expect(parsed(list, [{ label: 'A', to: '/a', other: 1 }])).toEqual([{ label: 'A', to: '/a' }]);
    expect(refused(list, [{ to: 'javascript:alert(1)' }])).toBe(true);
    expect(refused(list, ['a'])).toBe(true);
    expect(refused(list, 'a')).toBe(true);
    expect(refused(list, Array.from({ length: MAX_LIST_ITEMS + 1 }, () => ({})))).toBe(true);
  });

  it('gallery: each item an image, at most 100', () => {
    expect(parsed(input('gallery'), ['/a.jpg', { src: '/b.jpg', alt: 'B' }])).toEqual([
      { src: '/a.jpg', alt: '' },
      { src: '/b.jpg', alt: 'B' },
    ]);
    expect(refused(input('gallery'), [{ src: 'javascript:alert(1)' }])).toBe(true);
    expect(refused(input('gallery'), '/a.jpg')).toBe(true);
    expect(refused(input('gallery'), Array.from({ length: MAX_LIST_ITEMS + 1 }, () => '/a.jpg'))).toBe(true);
  });

  it('event: holds no value', () => {
    expect(refused(input('event'), 'anything')).toBe(true);
  });
});

describe('inputDefinitionRefusal', () => {
  it('takes a valid input of each kind', () => {
    expect(inputDefinitionRefusal(input('text', { default: 'Hi', maxLength: 10, multiline: true, group: 'Copy' }))).toBeNull();
    expect(inputDefinitionRefusal(input('number', { min: 0, max: 4, step: 1, unit: 'px' }))).toBeNull();
    expect(inputDefinitionRefusal(input('choice', { options: [{ label: 'A', value: 'a' }], default: 'a' }))).toBeNull();
    expect(inputDefinitionRefusal(input('list', { fields: [input('image', { id: 'photo' })] }))).toBeNull();
  });

  it('refuses a broken input', () => {
    expect(inputDefinitionRefusal(null)).toMatch(/object/);
    expect(inputDefinitionRefusal(input('text', { id: 'a b' }))).toMatch(/id/);
    expect(inputDefinitionRefusal(input('text', { name: '' }))).toMatch(/name/);
    expect(inputDefinitionRefusal({ id: 'x', name: 'X', type: 'font' })).toMatch(/unknown type/);
    expect(inputDefinitionRefusal(input('text', { group: 3 as unknown as string }))).toMatch(/text/);
    expect(inputDefinitionRefusal(input('number', { min: NaN }))).toMatch(/numbers/);
    expect(inputDefinitionRefusal(input('number', { unit: 'px;' }))).toMatch(/unit/);
    expect(inputDefinitionRefusal(input('text', { maxLength: -1 }))).toMatch(/whole/);
    expect(inputDefinitionRefusal(input('text', { multiline: 1 as unknown as boolean }))).toMatch(/multiline/);
    expect(inputDefinitionRefusal(input('choice'))).toMatch(/options/);
    expect(inputDefinitionRefusal(input('list'))).toMatch(/fields/);
    expect(inputDefinitionRefusal(input('list', { fields: [input('list', { id: 'y', fields: [input('text')] })] }))).toMatch(/scalar/);
    expect(inputDefinitionRefusal(input('link', { default: 'javascript:alert(1)' }))).toMatch(/default/);
  });
});

describe('mayBindToSlot', () => {
  it('keeps a text value off an address in any spelling', () => {
    for (const slot of ['href', 'HREF', 'src', 'formAction', 'xlink:href', 'srcSet', 'ping']) {
      expect(mayBindToSlot('text', slot)).toBe(false);
    }
    expect(mayBindToSlot('text', 'children')).toBe(true);
    expect(mayBindToSlot('text', 'aria-label')).toBe(true);
    expect(mayBindToSlot('text', 'style.color')).toBe(true);
    expect(mayBindToSlot('link', 'href')).toBe(true);
    expect(mayBindToSlot('image', 'src')).toBe(true);
    expect(mayBindToSlot('file', 'href')).toBe(true);
  });
});
