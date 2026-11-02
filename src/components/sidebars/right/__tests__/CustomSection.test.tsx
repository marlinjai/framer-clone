// The Custom section of the properties panel, on a real page with real undo.
// Paths: forward (add, pick), backtrack (Escape, remove, undo), refusal (the node
// stays as it was, the message is visible) and per breakpoint.

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import PageModel from '@/models/PageModel';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import HistoryStore from '@/stores/HistoryStore';
import { getComponentCategory, SECTION_MAP } from '../sectionConfig';
import { controlHolds, ownedProps, ownedStyleKeys, SECTION_STYLE_KEYS } from '../ownedKeys';
import { CustomSection } from '../sections/CustomSection';

afterEach(cleanup);

const BREAKPOINTS = ['bp-d', 'bp-t', 'bp-p'];

function setup(type = 'div', props: Record<string, unknown> = { style: {} }, breakpoint: 'largest' | 'smaller' = 'largest') {
  const page = PageModel.create({
    id: 'page',
    metadata: { title: 'Home' },
    appComponentTree: getSnapshot(createIntrinsicComponent('root', 'div', {})),
    canvasNodes: defaultViewportSnapshots(BREAKPOINTS),
  });
  page.appComponentTree.addChild(createIntrinsicComponent('probe', type as 'div', props));
  const node = page.appComponentTree.children[0] as ComponentInstance;
  const breakpointId = BREAKPOINTS[breakpoint === 'largest' ? 0 : 1];
  const history = HistoryStore.create({});
  history.setTargetStore(page);
  render(<CustomSection component={node} breakpointId={breakpointId} />);
  return { node, history, breakpointId };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

function type(label: string, value: string) {
  fireEvent.change(field(label), { target: { value } });
}

function addCss(name: string, value: string) {
  type('CSS property name', name);
  fireEvent.keyDown(field('CSS property name'), { key: 'Enter' });
  type('CSS property value', value);
  fireEvent.keyDown(field('CSS property value'), { key: 'Enter' });
}

function addAttribute(name: string, value: string) {
  type('Attribute name', name);
  type('Attribute value', value);
  fireEvent.click(screen.getByRole('button', { name: 'Add Attribute' }));
}

const style = (node: ComponentInstance) => (node.props as { style?: Record<string, unknown> }).style ?? {};

describe('CSS properties', () => {
  it('adds any property in one undo step, and the row can be edited', () => {
    const { node, history } = setup();
    addCss('clip-path', 'circle(50%)');
    expect(style(node).clipPath).toBe('circle(50%)');
    expect(history.history.length).toBe(1);
    expect(field('clip-path value').value).toBe('circle(50%)');

    type('clip-path value', 'circle(40%)');
    fireEvent.keyDown(field('clip-path value'), { key: 'Enter' });
    fireEvent.blur(field('clip-path value'));
    expect(style(node).clipPath).toBe('circle(40%)');
    expect(history.history.length).toBe(2);

    history.undo();
    expect(style(node).clipPath).toBe('circle(50%)');
    history.undo();
    expect(style(node).clipPath).toBeUndefined();
  });

  it('moves from name to value on Enter, and clears the form after adding', () => {
    setup();
    type('CSS property name', 'filter');
    field('CSS property name').focus();
    fireEvent.keyDown(field('CSS property name'), { key: 'Enter' });
    expect(document.activeElement).toBe(field('CSS property value'));
    type('CSS property value', 'blur(2px)');
    fireEvent.keyDown(field('CSS property value'), { key: 'Enter' });
    expect(field('CSS property name').value).toBe('');
    expect(field('CSS property value').value).toBe('');
    expect(document.activeElement).toBe(field('CSS property name'));
  });

  it('refuses an unsafe value with a visible message and stores nothing', () => {
    const { node, history } = setup();
    addCss('color-scheme', 'dark}body{display:none');
    expect(screen.getByRole('alert').textContent).toContain('Not saved');
    expect(style(node).colorScheme).toBeUndefined();
    expect(history.history.length).toBe(0);
    expect(field('CSS property value').value).toBe('dark}body{display:none');
  });

  it('refuses an unsafe edit of a row and keeps the stored value', () => {
    const { node } = setup('div', { style: { filter: 'blur(2px)' } });
    type('filter value', 'url(javascript:alert(1))');
    fireEvent.blur(field('filter value'));
    expect(screen.getByRole('alert').textContent).toContain('Not saved');
    expect(field('filter value').getAttribute('aria-invalid')).toBe('true');
    expect(style(node).filter).toBe('blur(2px)');
  });

  it('Escape puts a row back', () => {
    const { node } = setup('div', { style: { filter: 'blur(2px)' } });
    type('filter value', 'none');
    fireEvent.keyDown(field('filter value'), { key: 'Escape' });
    expect(field('filter value').value).toBe('blur(2px)');
    fireEvent.blur(field('filter value'));
    expect(style(node).filter).toBe('blur(2px)');
  });

  it('refuses a typing mistake and a property the sections own, saying where it lives', () => {
    setup();
    addCss('clip-pth', 'x');
    expect(screen.getByRole('alert').textContent).toContain('not a CSS property');
    addCss('opacity', '0.5');
    expect(screen.getByRole('alert').textContent).toContain('Styles section');
  });

  it('takes a value the control of an owned property cannot hold, and leaves the rest to the control', () => {
    const { node } = setup();
    addCss('width', '10px');
    expect(screen.getByRole('alert').textContent).toContain('Size section');
    expect(style(node).width).toBeUndefined();
    addCss('width', 'calc(100% - 8px)');
    expect(style(node).width).toBe('calc(100% - 8px)');
    expect(field('width value').value).toBe('calc(100% - 8px)');
    type('width value', '10px');
    fireEvent.blur(field('width value'));
    expect(style(node).width).toBe('10px');
    expect(screen.queryByLabelText('width value')).toBeNull();
    addCss('display', 'inline-block');
    expect(style(node).display).toBe('inline-block');
  });

  it('does not list or suggest what the sections own, and does where the category has no such section', () => {
    setup('div', { style: { opacity: 0.5, fontSize: '12px', filter: 'none' } });
    expect(screen.queryByLabelText('opacity value')).toBeNull();
    expect(screen.queryByLabelText('font-size value')).toBeNull();
    expect(screen.getByLabelText('filter value')).toBeTruthy();
    const suggested = Array.from(document.querySelectorAll('datalist option')).map((o) => o.getAttribute('value'));
    expect(suggested).not.toContain('opacity');
    expect(suggested).toContain('filter');
    cleanup();
    setup('img', { src: '/x.jpg', alt: 'x', style: { fontSize: '12px' } });
    expect(screen.getByLabelText('font-size value')).toBeTruthy();
  });

  it('writes an override on a smaller breakpoint, shows its source and removes everywhere in one step', () => {
    const { node, history, breakpointId } = setup('div', { style: { filter: 'blur(2px)' } }, 'smaller');
    type('filter value', 'none');
    fireEvent.blur(field('filter value'));
    expect(style(node).filter).toEqual({ base: 'blur(2px)', [breakpointId]: 'none' });
    expect(history.history.length).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter on every breakpoint' }));
    expect(style(node).filter).toBeUndefined();
    expect(history.history.length).toBe(2);
    history.undo();
    expect(style(node).filter).toEqual({ base: 'blur(2px)', [breakpointId]: 'none' });
  });

  it('adds on a smaller breakpoint without touching the largest', () => {
    const { node, breakpointId } = setup('div', { style: {} }, 'smaller');
    addCss('filter', 'blur(1px)');
    expect(style(node).filter).toEqual({ [breakpointId]: 'blur(1px)' });
  });
});

describe('attributes', () => {
  it('adds one in one undo step under the name React expects, and removes it', () => {
    const { node, history } = setup();
    addAttribute('tabindex', '0');
    expect((node.props as Record<string, unknown>).tabIndex).toBe('0');
    expect(history.history.length).toBe(1);
    expect(field('tabindex value').value).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'Remove tabindex' }));
    expect('tabIndex' in (node.props as object)).toBe(false);
    history.undo();
    expect((node.props as Record<string, unknown>).tabIndex).toBe('0');
  });

  it('adds a boolean from the name alone, and false removes it', () => {
    const { node } = setup();
    type('Attribute name', 'hidden');
    fireEvent.keyDown(field('Attribute name'), { key: 'Enter' });
    expect((node.props as Record<string, unknown>).hidden).toBe(true);
    type('hidden value', 'false');
    fireEvent.blur(field('hidden value'));
    expect('hidden' in (node.props as object)).toBe(false);
  });

  it('refuses a handler and an unsafe address with a visible message', () => {
    const { node, history } = setup('section');
    addAttribute('onclick', 'alert(1)');
    expect(screen.getByRole('alert').textContent).toContain('no stored code');
    addAttribute('cite', 'javascript:alert(1)');
    expect(screen.getByRole('alert').textContent).toContain('Not saved');
    expect(history.history.length).toBe(0);
    expect(Object.keys(node.props as object)).toEqual(['style']);
  });

  it('hides the editor\'s markers and what a section owns', () => {
    setup('a', { href: '/x', children: 'Go', 'data-form-kind': 'x', id: 'one', style: {} });
    expect(screen.queryByLabelText('href value')).toBeNull();
    expect(screen.queryByLabelText('data-form-kind value')).toBeNull();
    expect(screen.queryByLabelText('children value')).toBeNull();
    expect(screen.getByLabelText('id value')).toBeTruthy();
  });
});

describe('the tag picker', () => {
  const picker = () => screen.getByLabelText('Tag') as HTMLSelectElement;
  const options = () => Array.from(picker().options).map((o) => o.value);

  it('changes the tag in one undo step and keeps the node', () => {
    const { node, history } = setup('p', { children: 'Hello', style: { color: 'red' } });
    fireEvent.change(picker(), { target: { value: 'h2' } });
    expect(node.type).toBe('h2');
    expect(node.props).toEqual({ children: 'Hello', style: { color: 'red' } });
    expect(history.history.length).toBe(1);
    expect(picker().value).toBe('h2');
    history.undo();
    expect(node.type).toBe('p');
  });

  it('offers semantic tags and no blocked one', () => {
    setup();
    expect(options()).toEqual(expect.arrayContaining(['h1', 'section', 'article', 'nav', 'ul', 'li', 'table']));
    for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'html', 'body']) {
      expect(options()).not.toContain(tag);
    }
  });

  it('refuses a void tag for a node with text, with a message, and the node stays', () => {
    const { node, history } = setup('p', { children: 'Hello', style: {} });
    fireEvent.change(picker(), { target: { value: 'hr' } });
    expect(screen.getByRole('alert').textContent).toContain('cannot hold content');
    expect(node.type).toBe('p');
    expect(picker().value).toBe('p');
    expect(history.history.length).toBe(0);
  });

  it('the model refuses too, whoever calls it', () => {
    const { node, history } = setup();
    node.setTag('script');
    node.setTag('#text');
    expect(node.type).toBe('div');
    expect(history.history.length).toBe(0);
  });

  it('keeps showing a tag outside the list', () => {
    setup('my-widget');
    expect(picker().value).toBe('my-widget');
  });

  it('is absent where the tag defines the component', () => {
    setup('div', { 'data-form-kind': 'form', style: {} });
    expect(screen.queryByLabelText('Tag')).toBeNull();
    cleanup();
    setup('div', { 'data-component-kind': 'collection', style: {} });
    expect(screen.queryByLabelText('Tag')).toBeNull();
  });
});

describe('the section map', () => {
  it('closes every category but the viewport and a placement', () => {
    for (const [category, sections] of Object.entries(SECTION_MAP)) {
      // A placement's styles and attributes are its definition's (decision 7 of the components contract).
      if (category === 'viewport' || category === 'placement') expect(sections).not.toContain('custom');
      else expect(sections[sections.length - 1]).toBe('custom');
    }
  });

  it('knows every style key and prop the sections write, so Custom cannot duplicate one', () => {
    const dir = path.resolve(process.cwd(), 'src/components/sidebars/right/sections');
    const source = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8');
    const FILES: Record<string, string> = {
      size: 'SizeSection.tsx',
      position: 'PositionSection.tsx',
      layout: 'LayoutSection.tsx',
      typography: 'TypographySection.tsx',
      image: 'ImageSection.tsx',
      styles: 'StylesSection.tsx',
    };
    for (const [section, file] of Object.entries(FILES)) {
      const keys = [...source(file).matchAll(/(?:setStyleValue|getStyleValue|src)\(\s*'([A-Za-z]+)'/g)].map((m) => m[1]);
      expect(keys.length, section).toBeGreaterThan(0);
      for (const key of keys) {
        expect(SECTION_STYLE_KEYS[section as keyof typeof SECTION_STYLE_KEYS], `${section} ${key}`).toContain(key);
      }
    }
    const owned = new Set(['link', 'image', 'form', 'formField', 'formSubmit', 'stickyCta'].flatMap((c) => [...ownedProps(c as 'link')]));
    for (const file of ['LinkSection.tsx', 'ImageSection.tsx', 'FormSection.tsx', 'StickyCtaSection.tsx']) {
      for (const match of source(file).matchAll(/setProps\(\{ ([A-Za-z]+):/g)) {
        expect([...owned], `${file} ${match[1]}`).toContain(match[1]);
      }
    }
  });

  it('knows what a control can hold', () => {
    for (const [key, value] of [['width', '12px'], ['width', '50%'], ['width', 'auto'], ['maxWidth', 'none'], ['display', 'flex'], ['color', 'oklch(60% 0.1 50)'], ['width', '']]) {
      expect(controlHolds(key, value), `${key} ${value}`).toBe(true);
    }
    for (const [key, value] of [['width', 'calc(1px + 2px)'], ['width', '2vw'], ['display', 'inline-block'], ['padding', '1px 2px']]) {
      expect(controlHolds(key, value), `${key} ${value}`).toBe(false);
    }
  });

  it('owns by the sections a category shows', () => {
    expect(ownedStyleKeys('container').get('fontSize')).toBe('Typography');
    expect(ownedStyleKeys('image').has('fontSize')).toBe(false);
    expect(ownedStyleKeys('generic').has('padding')).toBe(false);
    expect(ownedStyleKeys('image').has('backgroundImage')).toBe(false);
    expect(ownedStyleKeys('container').has('objectFit')).toBe(false);
    expect(getComponentCategory({ isViewportNode: false, props: {}, type: 'ul' } as unknown as ComponentInstance)).toBe('generic');
  });
});
