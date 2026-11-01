// The rules of the panel's Custom section: what it refuses, and how a typed name
// or value becomes what a node stores.

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BLOCKED_TAGS, isDroppedProp } from '@/lib/renderer/blockedNodes';
import { buildResponsiveCss } from '@/lib/responsive/responsiveCss';
import { webPlatformNamesSource } from '../../../../test/score/lib/webPlatformNames';
import {
  attributeName,
  attributeNameError,
  attributeProp,
  attributeStoredValue,
  attributeSuggestions,
  attributeValueError,
  cssPropertyError,
  cssPropertySpelling,
  cssPropertySuggestions,
  cssValueError,
  isAttributeProp,
  tagGroups,
  tagNestingHint,
  contentOf,
  tagRefusal,
} from '../customEditor';
import { elements } from '../webPlatformNames.generated';

const EMPTY = { childCount: 0, text: undefined };

describe('the generated names', () => {
  it('match the pinned data: run pnpm generate:web-names after a data update', () => {
    const file = fs.readFileSync('src/lib/styles/webPlatformNames.generated.ts', 'utf8');
    expect(file).toBe(webPlatformNamesSource());
  });

  it('never suggest a blocked element, and offer every other one exactly once', () => {
    const offered = tagGroups().flatMap((group) => group.tags);
    expect(new Set(offered).size).toBe(offered.length);
    expect([...offered].sort()).toEqual(elements.filter((tag) => !BLOCKED_TAGS.has(tag)));
    expect(offered).toEqual(expect.arrayContaining(['section', 'h2', 'ul', 'li', 'table', 'article']));
    expect(tagGroups().every((group) => group.tags.length > 0)).toBe(true);
  });

  it('suggest attributes of the element as well as the global ones', () => {
    expect(attributeSuggestions('td')).toEqual(expect.arrayContaining(['colspan', 'id', 'aria-label']));
    expect(attributeSuggestions('div')).not.toContain('colspan');
    expect(attributeSuggestions('div').some((name) => /^on/.test(name))).toBe(false);
    expect(cssPropertySuggestions).toContain('clip-path');
  });
});

describe('CSS names', () => {
  it('accepts standard, legacy, vendor and custom properties, in either spelling', () => {
    for (const name of ['clip-path', 'clipPath', 'CLIP-PATH', 'clip', '-webkit-line-clamp', '--brand-color']) {
      expect(cssPropertyError(name), name).toBeNull();
    }
    expect(cssPropertySpelling(' clipPath ')).toBe('clip-path');
    expect(cssPropertySpelling('--Brand')).toBe('--Brand');
  });

  it('refuses what is no property, so a typing mistake does not silently do nothing', () => {
    for (const name of ['', 'clip-pth', 'color: red', '--', '--a b', '37']) {
      expect(cssPropertyError(name), name).not.toBeNull();
    }
  });
});

describe('CSS values', () => {
  const css = (key: string, value: string) =>
    buildResponsiveCss([{ className: 'fc-a', style: { [key]: value } }], [{ id: 'd', minWidth: 1200 }]);

  it('refuses exactly what the published stylesheet would drop', () => {
    for (const value of ['red}body{display:none', 'red; color: blue', 'url(javascript:alert(1))', 'expression(1)', '"open', '</style>', '@import "x"']) {
      expect(cssValueError('color', value), value).not.toBeNull();
      expect(css('color', value), value).toBe('');
    }
    for (const value of ['polygon(0 0, 100% 0, 50% 100%)', 'url("data:image/png;base64,AA==")', 'inherit']) {
      expect(cssValueError('clipPath', value), value).toBeNull();
      expect(css('clipPath', value), value).not.toBe('');
    }
  });
});

describe('attributes', () => {
  it('stores what React expects and shows the HTML name', () => {
    expect(attributeProp('tabindex', 'div')).toBe('tabIndex');
    expect(attributeProp('class', 'div')).toBe('className');
    expect(attributeProp('colspan', 'td')).toBe('colSpan');
    expect(attributeProp('aria-label', 'div')).toBe('aria-label');
    expect(attributeProp('data-Thing', 'div')).toBe('data-Thing');
    expect(attributeName('tabIndex')).toBe('tabindex');
    expect(attributeName('className')).toBe('class');
  });

  it('keeps a form control editable: value and checked are its starting state', () => {
    expect(attributeProp('value', 'input')).toBe('defaultValue');
    expect(attributeProp('checked', 'input')).toBe('defaultChecked');
    expect(attributeProp('value', 'li')).toBe('value');
    expect(attributeName('defaultValue')).toBe('value');
  });

  it('refuses handlers, raw HTML, styles and the editor\'s own markers', () => {
    for (const name of ['onclick', 'onClick', 'ONERROR', 'dangerouslySetInnerHTML', 'srcdoc', 'style', 'children', 'key', 'ref', 'data-form-kind', 'data-component-kind', 'data-sticky-cta', 'DATA-FORM-KIND', 'Data-Sticky-CTA', '1a', 'a b', '']) {
      expect(attributeNameError(name, 'div'), name).not.toBeNull();
    }
    for (const name of ['id', 'aria-label', 'data-probe', 'role', 'title', 'my-attribute']) {
      expect(attributeNameError(name, 'div'), name).toBeNull();
    }
  });

  it('agrees with blockedNodes on what never reaches a page', () => {
    expect(isDroppedProp('onClick', 'x')).toBe(true);
    expect(attributeNameError('onClick', 'div')).not.toBeNull();
    expect(isAttributeProp('onClick')).toBe(false);
  });

  it('refuses an unsafe address and script text', () => {
    for (const [name, value] of [['href', 'javascript:alert(1)'], ['src', 'data:text/html,x'], ['formaction', '//evil.example'], ['title', 'javascript:alert(1)']]) {
      expect(attributeValueError(name, value), name).not.toBeNull();
    }
    expect(attributeValueError('href', '/contact')).toBeNull();
    expect(attributeValueError('src', 'https://example.com/a.mp4')).toBeNull();
    expect(attributeValueError('title', 'Hello')).toBeNull();
  });

  it('stores a boolean as present or absent: React reads the string "false" as true', () => {
    expect(attributeStoredValue('hidden', '')).toBe(true);
    expect(attributeStoredValue('hidden', 'true')).toBe(true);
    expect(attributeStoredValue('hidden', 'false')).toBeUndefined();
    expect(attributeStoredValue('draggable', 'false')).toBe('false');
    expect(attributeStoredValue('data-x', '')).toBe('');
  });
});

describe('tags', () => {
  it('refuses every blocked tag and the document shell', () => {
    for (const tag of [...BLOCKED_TAGS, 'html', 'head', 'body', 'title']) {
      expect(tagRefusal(tag, EMPTY), tag).not.toBeNull();
    }
  });

  it('refuses a text node and what is no tag', () => {
    for (const tag of ['#text', '', 'A', '1h', 'a b']) expect(tagRefusal(tag, EMPTY), tag).not.toBeNull();
  });

  it('refuses a tag a browser would move the node\'s text out of, and only with text in it', () => {
    for (const tag of ['table', 'tbody', 'tr', 'select']) {
      expect(tagRefusal(tag, EMPTY), tag).toBeNull();
      expect(tagRefusal(tag, { childCount: 1, text: undefined }), tag).toBeNull();
      expect(tagRefusal(tag, { childCount: 0, text: 'Hello' }), tag).toMatch(/move it out of place/);
      expect(tagRefusal(tag, { childCount: 2, text: undefined, hasTextNode: true }), tag).toMatch(/move it out of place/);
    }
    expect(tagRefusal('td', { childCount: 2, text: undefined, hasTextNode: true })).toBeNull();
  });

  it('reads what a node holds, a text node among its children included', () => {
    expect(contentOf({ props: { children: 'Hi' }, children: [] })).toEqual({ childCount: 0, text: 'Hi', hasTextNode: false });
    expect(contentOf({ children: [{ type: 'b' }, { type: '#text' }] })).toEqual({ childCount: 2, text: undefined, hasTextNode: true });
  });

  it('refuses a void tag only for a node with content, which would otherwise vanish', () => {
    expect(tagRefusal('hr', EMPTY)).toBeNull();
    expect(tagRefusal('hr', { childCount: 0, text: '' })).toBeNull();
    expect(tagRefusal('hr', { childCount: 1, text: undefined })).not.toBeNull();
    expect(tagRefusal('hr', { childCount: 0, text: 'Hello' })).not.toBeNull();
    expect(tagRefusal('hr', { childCount: 0, text: 0 })).not.toBeNull();
  });

  it('refuses a textarea with child elements, which React throws on, and accepts one with text', () => {
    expect(tagRefusal('textarea', { childCount: 1, text: undefined })).not.toBeNull();
    expect(tagRefusal('textarea', { childCount: 0, text: 'Hello' })).toBeNull();
  });

  it('notes a tag out of place, without refusing it', () => {
    expect(tagNestingHint('tr', 'div')).toContain('<table>');
    expect(tagNestingHint('tr', 'tbody')).toBeNull();
    expect(tagNestingHint('h2', 'div')).toBeNull();
    expect(tagNestingHint('li', undefined)).toBeNull();
    expect(tagRefusal('tr', EMPTY)).toBeNull();
  });
});
