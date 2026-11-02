// What the component rows measure with, on every surface: stored definitions and
// placements, and one sample per input type.

import { parseComponents, type ComponentDefinitions } from '@/lib/components/definition';
import type { InputDefinition, InputType } from '@/lib/components/inputs';
import { PLACEMENT_TYPE } from '@/lib/components/placement';
import { viewportCanvasNodes } from './published';

export const read = (expression: string) => ({ mode: 'read', expression });
export const jsonTrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface Stored {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  bindings?: Record<string, unknown>;
  children?: Stored[];
}

export const definition = (id: string, tree: Stored, inputs: InputDefinition[] = []) => ({
  id,
  name: id,
  page: { appComponentTree: tree, canvasNodes: viewportCanvasNodes(`d-${id}`) },
  inputs,
  states: [],
});

export const definitionsOf = (...stored: ReturnType<typeof definition>[]): ComponentDefinitions =>
  parseComponents(jsonTrip(Object.fromEntries(stored.map((d) => [d.id, d])))).definitions;

export const placement = (id: string, component: string, props: Record<string, unknown> = {}, bindings?: Record<string, unknown>): Stored => ({
  id,
  type: PLACEMENT_TYPE,
  props: { component, ...props },
  ...(bindings ? { bindings } : {}),
});

export const page = (children: Stored[]): Stored => ({ id: 'page', type: 'main', props: {}, children });

export const CARD = definition(
  'card',
  { id: 'c-root', type: 'article', props: { style: { width: { base: '100%', 'd-card-mobile': '50%' } } }, children: [
    { id: 'c-title', type: 'h3', props: { children: 'Stored' }, bindings: { children: read('{{input.title}}') } },
  ] },
  [{ id: 'title', name: 'Title', type: 'text', default: 'Card title' }],
);

/** One sample per input type: a value it must take, one it must refuse, the node that binds it, and what must reach the page. */
export interface InputProbe {
  input: Omit<InputDefinition, 'id' | 'name' | 'type'>;
  value: unknown;
  refused: unknown;
  node: Pick<Stored, 'type' | 'props' | 'bindings' | 'children'>;
  expected: string;
  /** What the canvas must hold: it writes attributes of its own between these. */
  canvas: string[];
  /** What must not be on the page. */
  absent?: string;
}

export const INPUT_PROBES: Partial<Record<InputType, InputProbe>> = {
  text: {
    input: {},
    value: 'Probe title',
    refused: { an: 'object' },
    node: { type: 'h2', bindings: { children: read('{{input.x}}') } },
    expected: '<h2>Probe title</h2>',
    canvas: ['>Probe title</h2>'],
  },
  number: {
    input: { min: 0, max: 100, unit: 'px' },
    value: 40,
    refused: 400,
    node: { type: 'div', bindings: { 'style.width': read('{{input.x}}') } },
    expected: 'style="width:40px"',
    canvas: ['width: 40px'],
  },
  toggle: {
    input: {},
    value: false,
    refused: 'false',
    node: { type: 'b', props: { children: 'Hidden badge' }, bindings: { visible: read('{{input.x}}') } },
    expected: '<main></main>',
    canvas: ['data-inner-component-id'],
    absent: 'Hidden badge',
  },
  color: {
    input: {},
    value: 'rgb(1, 2, 3)',
    refused: 'red;background:url(https://track.example/x)',
    node: { type: 'div', bindings: { 'style.color': read('{{input.x}}') } },
    expected: 'style="color:rgb(1, 2, 3)"',
    canvas: ['color: rgb(1, 2, 3)'],
  },
  image: {
    input: {},
    value: { src: '/probe.jpg', alt: 'Probe' },
    refused: { src: 'javascript:alert(1)' },
    node: { type: 'img', bindings: { src: read('{{input.x.src}}'), alt: read('{{input.x.alt}}') } },
    expected: 'src="/probe.jpg" alt="Probe"',
    canvas: ['src="/probe.jpg"', 'alt="Probe"'],
  },
  link: {
    input: {},
    value: '/probe',
    refused: 'javascript:alert(1)',
    node: { type: 'a', props: { children: 'Go' }, bindings: { href: read('{{input.x}}') } },
    expected: 'href="/probe"',
    canvas: ['href="/probe"'],
  },
  choice: {
    input: { options: [{ label: 'Dark', value: 'dark' }] },
    value: 'dark',
    refused: 'light',
    node: { type: 'div', bindings: { 'data-tone': read('{{input.x}}') } },
    expected: 'data-tone="dark"',
    canvas: ['data-tone="dark"'],
  },
  richtext: {
    input: {},
    value: { runs: [{ text: 'Plain ' }, { text: 'bold', marks: ['strong'] }, { text: ' link', href: '/probe' }] },
    refused: { runs: [{ text: 'x', href: 'javascript:alert(1)' }] },
    node: { type: 'p', bindings: { children: read('{{input.x}}') } },
    expected: '<p>Plain <strong>bold</strong><a href="/probe"> link</a></p>',
    canvas: ['>Plain <strong>bold</strong><a href="/probe"> link</a></p>'],
  },
  file: {
    input: {},
    value: '/files/probe.pdf',
    refused: 'javascript:alert(1)',
    node: { type: 'a', props: { children: 'Download' }, bindings: { href: read('{{input.x}}') } },
    expected: 'href="/files/probe.pdf"',
    canvas: ['href="/files/probe.pdf"'],
  },
  date: {
    input: {},
    value: '2026-11-02',
    refused: '2 November',
    node: { type: 'time', bindings: { children: read('{{input.x}}'), dateTime: read('{{input.x}}') } },
    expected: '<time dateTime="2026-11-02">2026-11-02</time>',
    canvas: ['datetime="2026-11-02"', '>2026-11-02</time>'],
  },
  border: {
    input: {},
    value: '1px solid rgb(1, 2, 3)',
    refused: '1px solid red;background:url(https://track.example/x)',
    node: { type: 'div', bindings: { 'style.border': read('{{input.x}}') } },
    expected: 'style="border:1px solid rgb(1, 2, 3)"',
    canvas: ['border: 1px solid rgb(1, 2, 3)'],
  },
  shadow: {
    input: {},
    value: '0 4px 12px rgba(0, 0, 0, 0.2)',
    refused: '0 0 1px red;background:url(https://track.example/x)',
    node: { type: 'div', bindings: { 'style.boxShadow': read('{{input.x}}') } },
    expected: 'style="box-shadow:0 4px 12px rgba(0, 0, 0, 0.2)"',
    canvas: ['box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2)'],
  },
  cursor: {
    input: {},
    value: 'pointer',
    refused: 'url(https://track.example/x.cur), auto',
    node: { type: 'div', bindings: { 'style.cursor': read('{{input.x}}') } },
    expected: 'style="cursor:pointer"',
    canvas: ['cursor: pointer'],
  },
  list: {
    input: { fields: [{ id: 'label', name: 'Label', type: 'text' }, { id: 'to', name: 'To', type: 'link' }] },
    value: [{ label: 'One', to: '/one' }, { label: 'Two', to: '/two' }],
    refused: [{ label: 'Bad', to: 'javascript:alert(1)' }],
    node: { type: 'ul', children: [
      { id: 'li', type: 'li', props: { 'data-repeat': 'x' }, children: [
        { id: 'go', type: 'a', props: { children: 'Stored' }, bindings: { children: read('{{item.label}}'), href: read('{{item.to}}') } },
      ] },
    ] },
    expected: '<ul><li><a href="/one">One</a></li><li><a href="/two">Two</a></li></ul>',
    canvas: ['href="/one"', '>One</a>', 'href="/two"', '>Two</a>'],
    absent: 'Stored',
  },
  gallery: {
    input: {},
    value: [{ src: '/a.jpg', alt: 'First' }, { src: '/b.jpg', alt: 'Second' }],
    refused: [{ src: 'javascript:alert(1)' }],
    node: { type: 'div', children: [
      { id: 'pic', type: 'img', props: { 'data-repeat': 'x' }, bindings: { src: read('{{item.src}}'), alt: read('{{item.alt}}') } },
    ] },
    expected: '<div><img src="/a.jpg" alt="First" fetchPriority="high"/><img src="/b.jpg" alt="Second" loading="lazy" decoding="async"/></div>',
    canvas: ['src="/a.jpg"', 'alt="First"', 'src="/b.jpg"', 'alt="Second"'],
    absent: 'data-repeat',
  },
  transition: {
    input: {},
    value: 'opacity 200ms ease',
    refused: 'opacity 1s;background:url(https://track.example/x)',
    node: { type: 'div', bindings: { 'style.transition': read('{{input.x}}') } },
    expected: 'style="transition:opacity 200ms ease"',
    canvas: ['transition: opacity 200ms ease'],
  },
};
