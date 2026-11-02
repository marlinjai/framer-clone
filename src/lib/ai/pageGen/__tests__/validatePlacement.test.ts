// Placements of the site's own components in generated output: what the generator
// keeps, what it drops and why. docs/plans/2026-11-02-reusable-components.md,
// "AI generation".
import { describe, expect, it } from 'vitest';
import { validateGeneration, type GeneratedNodeSnapshot } from '../validate';
import { deriveBreakpointKeys } from '../schema';
import { componentsText } from '../promptSections/components';
import { requestContextText, emitPageTool } from '../prompt';
import { parseComponents } from '@/lib/components/definition';
import { componentSummaries, GenerationComponentsSchema, skeletonDefinitions, type ComponentSummary, type GenerationComponents } from '@/lib/components/summaries';
import { placementOpRefusal } from '@/lib/ai/review/placementOps';
import { validateReviewOps } from '@/lib/ai/review/ops';

const BREAKPOINTS = deriveBreakpointKeys([{ label: 'Desktop', minWidth: 1200 }, { label: 'Mobile', minWidth: 0 }]);

const tree = (id: string, type: string, children: unknown[] = [], props: Record<string, unknown> = {}) => ({ id, type, props, children });
const place = (id: string, component: string) => ({ id, type: '#component', props: { component }, children: [] });

const DEFINITIONS = parseComponents({
  card: {
    id: 'card',
    name: 'Card',
    description: 'A <b>card</b> for one offer',
    page: { appComponentTree: tree('c', 'article', [tree('c-t', 'h3')]) },
    inputs: [
      { id: 'title', name: 'Title', type: 'text', maxLength: 40 },
      { id: 'price', name: 'Price', type: 'number', min: 0, unit: 'px' },
      { id: 'image', name: 'Image', type: 'image' },
      { id: 'tone', name: 'Tone', type: 'choice', options: [{ label: 'Dark', value: 'dark' }] },
      { id: 'chosen', name: 'Chosen', type: 'event' },
    ],
    states: [{ id: 'hover', name: 'Hover', kind: 'hover' }, { id: 's1', name: 'Open', kind: 'custom' }],
  },
  link: { id: 'link', name: 'Link card', page: { appComponentTree: tree('l', 'a', [], { href: '/' }) }, inputs: [], states: [] },
  outer: { id: 'outer', name: 'Outer', page: { appComponentTree: tree('o', 'section', [place('o-p', 'card')]) }, inputs: [], states: [] },
}).definitions;
const SUMMARIES = componentSummaries(DEFINITIONS);

function generate(nodes: unknown[], where: Partial<GenerationComponents> = {}, summaries: ComponentSummary[] = SUMMARIES) {
  let n = 0;
  const outcome = validateGeneration({ nodes }, { breakpoints: BREAKPOINTS, newId: () => `id${++n}`, components: { summaries, ...where } });
  if (!outcome.ok) throw new Error(outcome.errors.join('; '));
  return outcome.result;
}

const first = (nodes: GeneratedNodeSnapshot[]): GeneratedNodeSnapshot | undefined => {
  for (const node of nodes) {
    if (node.type === '#component') return node;
    const inner = first(node.children);
    if (inner) return inner;
  }
  return undefined;
};

describe('summaries', () => {
  it('say what each component is without its tree', () => {
    const card = SUMMARIES.find(summary => summary.id === 'card')!;
    expect(card).toMatchObject({ name: 'Card', rootTag: 'article', holdsInteractive: false, places: [] });
    expect(SUMMARIES.find(summary => summary.id === 'outer')).toMatchObject({ places: ['card'] });
    expect(SUMMARIES.find(summary => summary.id === 'link')).toMatchObject({ rootTag: 'a', holdsInteractive: true });
    expect(JSON.stringify(SUMMARIES)).not.toContain('c-t');
  });

  it('pass the route schema, and a bad input is refused there', () => {
    expect(GenerationComponentsSchema.safeParse({ summaries: SUMMARIES }).success).toBe(true);
    const bad = [{ ...SUMMARIES[0], inputs: [{ id: 'x', name: 'X', type: 'script' }] }];
    expect(GenerationComponentsSchema.safeParse({ summaries: bad }).success).toBe(false);
  });

  it('rebuild skeletons the refusal checks read the same way', () => {
    const skeleton = skeletonDefinitions(SUMMARIES);
    expect(skeleton.outer.page.appComponentTree).toMatchObject({ type: 'section', children: [{ type: '#component', props: { component: 'card' } }] });
  });
});

describe('a generated placement', () => {
  it('is kept with its inputs as written, by name or id', () => {
    const result = generate([
      { type: 'section', children: [{ type: '#component', name: 'card', inputs: { title: 'Pro', price: 20, tone: 'dark', image: { src: '/a.jpg', alt: 'A' } }, label: 'Pro plan' }] },
    ]);
    const placement = first(result.nodes)!;
    expect(placement).toMatchObject({
      type: '#component',
      label: 'Pro plan',
      props: { component: 'card', inputs: { title: 'Pro', price: 20, tone: 'dark', image: { src: '/a.jpg', alt: 'A' } } },
      children: [],
    });
    expect(result.warnings).toEqual([]);
  });

  it('drops an unknown input and a value its input refuses, and says so', () => {
    const result = generate([{ type: '#component', name: 'Card', inputs: { title: 'x'.repeat(41), ghost: 1, tone: 'light', Price: 5 } }]);
    expect(first(result.nodes)?.props).toEqual({ component: 'card', inputs: { price: 5 } });
    expect(result.warnings.join('\n')).toMatch(/Title.*dropped/);
    expect(result.warnings.join('\n')).toMatch(/no input "ghost"/);
    expect(result.warnings.join('\n')).toMatch(/Tone.*not one of the options/);
  });

  it('keeps no picture from another host, and no value for an Event input', () => {
    const result = generate([{ type: '#component', name: 'Card', inputs: { image: { src: 'https://elsewhere.example/a.jpg', alt: '' }, chosen: true } }]);
    expect(first(result.nodes)?.props).toEqual({ component: 'card' });
    expect(result.warnings.join('\n')).toMatch(/comes from the site/);
    expect(result.warnings.join('\n')).toMatch(/event holds no value/);
  });

  it('starts in a custom state by id or name, and in primary otherwise', () => {
    expect(first(generate([{ type: '#component', name: 'Card', state: 'Open' }]).nodes)?.props.state).toBe('s1');
    const pointer = generate([{ type: '#component', name: 'Card', state: 'hover' }]);
    expect(first(pointer.nodes)?.props.state).toBeUndefined();
    expect(pointer.warnings.join('\n')).toMatch(/no state "hover"/);
  });

  it('keeps only its own style and no children', () => {
    const result = generate([{ type: '#component', name: 'Card', props: { style: { width: '300px', color: 'red' }, className: 'x' }, children: [{ type: 'p' }] }]);
    expect(first(result.nodes)?.props.style).toEqual({ width: '300px', color: 'red' });
    expect(first(result.nodes)?.children).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/1 children dropped/);
    expect(result.warnings.join('\n')).toMatch(/prop "className" is not allowed on a placement/);
  });

  it('is dropped when the site has no such component, or none at all', () => {
    expect(generate([{ type: 'div', children: [{ type: '#component', name: 'Ghost' }] }]).warnings.join('\n')).toMatch(/no component named "Ghost"/);
    let n = 0;
    const bare = validateGeneration({ nodes: [{ type: 'div', children: [{ type: '#component', name: 'Card' }] }] }, { breakpoints: BREAKPOINTS, newId: () => `b${++n}` });
    expect(bare.ok && first(bare.result.nodes)).toBeFalsy();
  });

  it('is refused where it would close a cycle, naming the path', () => {
    const result = generate([{ type: 'div', children: [{ type: '#component', name: 'Outer' }] }], { insideDefinition: 'card' });
    expect(first(result.nodes)).toBeUndefined();
    expect(result.warnings.join('\n')).toMatch(/Card contains Outer, which contains Card/);
  });

  it('is refused where a browser would move it out of what holds it', () => {
    const inLink = generate([{ type: 'a', props: { href: '/x' }, children: [{ type: '#component', name: 'Link card' }] }]);
    expect(first(inLink.nodes)).toBeUndefined();
    expect(inLink.warnings.join('\n')).toMatch(/move it out of the <a>/);
    const atTarget = generate([{ type: '#component', name: 'Card' }], { ancestorTags: ['p', 'div'] });
    expect(first(atTarget.nodes)).toBeUndefined();
  });

  it('cannot sit inside svg', () => {
    const result = generate([{ type: 'svg', props: { viewBox: '0 0 1 1' }, children: [{ type: '#component', name: 'Card' }] }]);
    expect(JSON.stringify(result.nodes)).not.toContain('#component');
  });
});

describe('the prompt', () => {
  it('lists the components as escaped data, with their inputs and custom states only', () => {
    const text = componentsText(SUMMARIES);
    expect(text).toContain('<site_components>');
    expect(text).toContain('\\u003cb>card\\u003c/b>');
    expect(text).not.toContain('<b>');
    expect(text).toContain('"states":[{"id":"s1","name":"Open"}]');
    expect(text).not.toContain('"chosen"');
    expect(componentsText([])).toBe('');
    expect(requestContextText({ breakpoints: BREAKPOINTS, target: { kind: 'newPage' }, components: SUMMARIES })).toContain('## Components of this site');
  });

  it('lets the tool carry a placement\'s name, inputs and state', () => {
    const items = (emitPageTool().input_schema as { properties: { nodes: { items: { properties: Record<string, unknown> } } } }).properties.nodes.items.properties;
    expect(Object.keys(items)).toEqual(expect.arrayContaining(['name', 'inputs', 'state']));
  });
});

describe('the review', () => {
  it('styles and removes a placement, and edits nothing inside it', () => {
    expect(placementOpRefusal('#component', 'update_style')).toBeNull();
    expect(placementOpRefusal('#component', 'remove_node')).toBeNull();
    expect(placementOpRefusal('#component', 'update_text')).toMatch(/definition/);
    expect(placementOpRefusal('div', 'update_text')).toBeNull();
    const nodes = new Map([
      ['root', { type: 'main', isRoot: true, textEditable: false, backgroundUrls: new Set<string>() }],
      ['p1', { type: '#component', parentId: 'root', isRoot: false, textEditable: false, backgroundUrls: new Set<string>() }],
    ]);
    const { ops, rejected } = validateReviewOps(
      [
        { op: 'update_style', nodeId: 'p1', property: 'width', breakpoint: null, value: '50%' },
        { op: 'update_text', nodeId: 'p1', text: 'New' },
      ],
      { breakpointKeys: ['desktop', 'mobile'], nodes },
    );
    expect(ops.map(op => op.op)).toEqual(['update_style']);
    expect(rejected[0].reason).toMatch(/definition/);
  });
});

