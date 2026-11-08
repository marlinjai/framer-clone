// The generator's behaviour: everything goes through validateGeneration and the real
// behaviour parser behind it. Model output is untrusted, and a generation may have been
// written by a prompt injection in a brief, so most of this file is what must not get
// through. See docs/plans/2026-11-02-behaviour-model.md, "AI output".
import { describe, expect, it } from 'vitest';
import ComponentModel from '@/models/ComponentModel';
import { readBehaviourTree, type BehaviourNode } from '@/lib/behaviour/format';
import { carousel } from '@/lib/behaviour/presets/carousel';
import { combobox } from '@/lib/behaviour/presets/combobox';
import { feed } from '@/lib/behaviour/presets/feed';
import { grid } from '@/lib/behaviour/presets/grid';
import { menuButton } from '@/lib/behaviour/presets/menu';
import { menubar } from '@/lib/behaviour/presets/menubar';
import { multithumbSlider } from '@/lib/behaviour/presets/slider';
import { splitter } from '@/lib/behaviour/presets/splitter';
import { tabs } from '@/lib/behaviour/presets/tabs';
import { toolbar } from '@/lib/behaviour/presets/toolbar';
import { tooltip } from '@/lib/behaviour/presets/tooltip';
import { treegrid, treeview } from '@/lib/behaviour/presets/tree';
import type { PresetNode } from '@/lib/behaviour/presets';
import { GENERATION_LIMITS, deriveBreakpointKeys } from '../schema';
import { GENERATED_TRIGGER_EVENTS, MAX_GENERATED_PRESETS, closedAncestorOf, MAX_GENERATED_TRIGGERS, behaviourDocs } from '../promptSections/behaviour';
import { buildSchemaDocs } from '../schemaDocs';
import { validateGeneration, type GeneratedNodeSnapshot } from '../validate';

const breakpoints = deriveBreakpointKeys([
  { label: 'Desktop', minWidth: 1280 },
  { label: 'Mobile', minWidth: 320 },
]);

function run(nodes: unknown[]) {
  let n = 0;
  const out = validateGeneration({ nodes }, { breakpoints, newId: () => `id${(n += 1)}` });
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.result;
}

const flag = (id: string, initial = false) => ({ id, name: id, type: 'boolean', initial });
const behaviourOf = (node: GeneratedNodeSnapshot) => node.props.behaviour as Record<string, unknown> | undefined;
const triggersOf = (node: GeneratedNodeSnapshot) => (behaviourOf(node)?.on ?? []) as Array<Record<string, unknown>>;

/** The taught form: a section declares a value, its button toggles it, a part shows while it is set. */
const reveal = (extra: Record<string, unknown> = {}) => ({
  type: 'section',
  props: { behaviour: { state: [flag('open')] } },
  children: [
    {
      type: 'button',
      props: {
        type: 'button',
        children: 'Show details',
        behaviour: { on: [{ id: 'press', on: 'click', do: [{ toggle: 'open' }] }], bind: [{ attr: 'aria-expanded', from: { get: 'open' } }], ...extra },
      },
    },
    { type: 'p', props: { children: 'The details', behaviour: { showWhen: { state: 'open', eq: true } } } },
  ],
});

describe('behaviour the model writes itself', () => {
  it('keeps the taught form unchanged', () => {
    const { nodes, warnings } = run([reveal()]);
    const [section] = nodes;
    expect(behaviourOf(section)).toEqual({ state: [flag('open')] });
    expect(behaviourOf(section.children[0])).toEqual({
      on: [{ id: 'press', on: 'click', do: [{ toggle: 'open' }] }],
      bind: [{ attr: 'aria-expanded', from: { get: 'open' } }],
    });
    expect(behaviourOf(section.children[1])).toEqual({ showWhen: { state: 'open', eq: true } });
    expect(warnings).toEqual([]);
    expect(() => ComponentModel.create(section)).not.toThrow();
  });

  it('keeps what the parser accepts beyond the taught form', () => {
    const { nodes } = run([{
      type: 'div',
      props: { behaviour: { state: [{ id: 'n', name: 'n', type: 'number', initial: 0, min: 0, max: 3 }] } },
      children: [{
        type: 'button',
        props: { type: 'button', children: 'Next', behaviour: { on: [{ id: 'k', on: 'keydown', keys: ['ArrowRight'], prevent: true, do: [{ step: 'n', wrap: true }] }] } },
      }],
    }]);
    expect(triggersOf(nodes[0].children[0])).toEqual([{ id: 'k', on: 'keydown', keys: ['ArrowRight'], prevent: true, do: [{ step: 'n', wrap: true }] }]);
  });

  it('lets a reference follow the node the model named, inside the generation only', () => {
    const { nodes, warnings } = run([{
      type: 'div',
      props: { behaviour: { state: [flag('open')] } },
      children: [
        { type: 'button', props: { type: 'button', children: 'Open', behaviour: { on: [{ id: 'press', on: 'click', do: [{ toggle: 'open' }, { focus: 'body' }, { scroll: 'elsewhere' }] }] } } },
        { id: 'body', type: 'p', props: { children: 'Body', tabIndex: -1 } },
      ],
    }]);
    const [button, body] = nodes[0].children;
    // A reference to a node outside the generation names nothing: the trigger is refused whole.
    expect(triggersOf(button)).toEqual([]);
    expect(warnings.join(' ')).toMatch(/behaviour on\[0\] dropped/);
    const followed = run([{
      type: 'div',
      props: { behaviour: { state: [flag('open')] } },
      children: [
        { type: 'button', props: { type: 'button', children: 'Open', behaviour: { on: [{ id: 'press', on: 'click', do: [{ toggle: 'open' }, { focus: 'body' }] }] } } },
        { id: 'body', type: 'p', props: { children: 'Body', tabIndex: -1 } },
      ],
    }]).nodes[0].children;
    expect(triggersOf(followed[0])[0].do).toEqual([{ toggle: 'open' }, { focus: followed[1].id }]);
    expect(body.id).not.toBe('body');
  });

  it('names nothing with an id two nodes gave', () => {
    const { nodes } = run([{
      type: 'div',
      children: [
        { type: 'button', props: { type: 'button', children: 'Go', behaviour: { on: [{ id: 'press', on: 'click', do: [{ focus: 'twin' }] }] } } },
        { id: 'twin', type: 'p', props: { children: 'One', tabIndex: -1 } },
        { id: 'twin', type: 'p', props: { children: 'Two', tabIndex: -1 } },
      ],
    }]);
    expect(triggersOf(nodes[0].children[0])).toEqual([]);
  });

  it('drops what the parser refuses, entry by entry, and says why', () => {
    const { nodes, warnings } = run([reveal({
      on: [
        { id: 'press', on: 'click', do: [{ toggle: 'open' }] },
        { id: 'bad', on: 'onclick', do: [{ toggle: 'open' }] },
        { id: 'code', on: 'click', do: [{ eval: 'alert(1)' }] },
      ],
      bind: [{ attr: 'aria-expanded', from: { get: 'open' } }, { attr: 'href', from: 'https://evil.test' }],
    })]);
    const button = nodes[0].children[0];
    expect(triggersOf(button).map((t) => t.id)).toEqual(['press']);
    expect(behaviourOf(button)?.bind).toEqual([{ attr: 'aria-expanded', from: { get: 'open' } }]);
    expect(warnings.filter((w) => w.includes('dropped'))).toHaveLength(3);
  });

  it('keeps a value in reach only of the nodes inside the one declaring it', () => {
    const { nodes } = run([
      { type: 'div', props: { behaviour: { state: [flag('open')] } } },
      { type: 'p', props: { children: 'Other', behaviour: { showWhen: { state: 'open', eq: true } } } },
    ]);
    expect(behaviourOf(nodes[1])).toBeUndefined();
  });

  it('refuses a trigger on a timer: nothing generated moves by itself unasked', () => {
    const { nodes, warnings } = run([reveal({ on: [{ id: 'tick', on: 'every', ms: 2000, do: [{ toggle: 'open' }] }] })]);
    expect(triggersOf(nodes[0].children[0])).toEqual([]);
    expect(warnings.join(' ')).toContain('every is refused');
  });

  // Security review of slice B12: a model-written trigger runs only on what a person does.
  it.each(['page-ready', 'view-enter', 'view-leave', 'custom:next', 'focus', 'mouseenter'])(
    'refuses a trigger the model wrote on %s: nothing it writes runs without a person',
    (event) => {
      const { nodes, warnings } = run([reveal({ on: [{ id: 'auto', on: event, do: [{ toggle: 'open' }] }] })]);
      expect(triggersOf(nodes[0].children[0])).toEqual([]);
      expect(warnings.join(' ')).toContain(`runs on a person's click, key or input only: "${event}" is refused`);
    },
  );

  it('refuses a dialog the model opens on load, with any text in it', () => {
    const { nodes, warnings } = run([{
      type: 'div',
      children: [
        { id: 'gate', type: 'dialog', children: [{ type: 'p', props: { children: 'Your session expired, sign in again' } }] },
        { type: 'div', props: { behaviour: { on: [
          { id: 'load', on: 'page-ready', do: [{ dialog: 'gate', op: 'showModal' }] },
          { id: 'seen', on: 'view-enter', do: [{ dialog: 'gate', op: 'showModal' }] },
        ] } } },
      ],
    }]);
    const all = (node: GeneratedNodeSnapshot): GeneratedNodeSnapshot[] => [node, ...node.children.flatMap(all)];
    expect(all(nodes[0]).flatMap(triggersOf)).toEqual([]);
    expect(warnings.filter((w) => w.includes('is refused'))).toHaveLength(2);
  });

  it('refuses a delay and an emit in a trigger the model wrote, so it builds no timer of its own', () => {
    const { nodes, warnings } = run([reveal({ on: [
      { id: 'later', on: 'click', do: [{ delay: 1000, do: [{ toggle: 'open' }] }] },
      { id: 'chain', on: 'click', do: [{ toggle: 'open' }, { emit: 'next' }] },
    ] })]);
    expect(triggersOf(nodes[0].children[0])).toEqual([]);
    expect(warnings.join(' ')).toContain('delay is refused');
    expect(warnings.join(' ')).toContain('emit is refused');
    // The loop itself, a page-ready that waits and emits and a custom event that does it again:
    // every link of it is refused, so nothing the model wrote advances the page by itself.
    const loop = run([reveal({ on: [
      { id: 'start', on: 'page-ready', do: [{ delay: 1000, do: [{ toggle: 'open' }, { emit: 'tick' }] }] },
      { id: 'again', on: 'custom:tick', do: [{ delay: 1000, do: [{ toggle: 'open' }, { emit: 'tick' }] }] },
    ] })]);
    expect(triggersOf(loop.nodes[0].children[0])).toEqual([]);
    expect(loop.warnings.filter((w) => w.includes('is refused'))).toHaveLength(2);
  });

  it('keeps a trigger the model wrote on a key, an input or a change', () => {
    for (const event of ['keydown', 'keyup', 'input', 'change']) {
      // Typing repeats, so the parser takes only what repeating leaves unchanged there.
      const trigger = { id: 'act', on: event, do: [{ set: 'open', value: true }] };
      const { nodes, warnings } = run([reveal({ on: [trigger] })]);
      expect(triggersOf(nodes[0].children[0])).toEqual([trigger]);
      expect(warnings).toEqual([]);
    }
  });

  it('takes a site path or an anchor for navigate, never an address off the site', () => {
    const go = (href: string) => triggersOf(run([{
      type: 'button',
      props: { type: 'button', children: 'Go', behaviour: { on: [{ id: 'go', on: 'click', do: [{ navigate: href }] }] } },
    }]).nodes[0]);
    expect(go('/pricing')).toHaveLength(1);
    expect(go('#contact')).toHaveLength(1);
    for (const away of ['https://evil.test/', 'http://evil.test', '//evil.test/x', 'mailto:a@b.test', 'tel:123']) expect(go(away)).toEqual([]);
  });

  it(`keeps at most ${MAX_GENERATED_TRIGGERS} triggers the model wrote, the outer ones first`, () => {
    const buttons = Array.from({ length: MAX_GENERATED_TRIGGERS + 3 }, (_, i) => ({
      type: 'button',
      props: { type: 'button', children: `B${i}`, behaviour: { on: [{ id: 'press', on: 'click', do: [{ toggle: 'open' }] }] } },
    }));
    const { nodes, warnings } = run([{ type: 'div', props: { behaviour: { state: [flag('open')] } }, children: buttons }]);
    const kept = nodes[0].children.filter((b) => triggersOf(b).length > 0);
    expect(kept).toHaveLength(MAX_GENERATED_TRIGGERS);
    expect(kept.at(-1)?.props.children).toBe(`B${MAX_GENERATED_TRIGGERS - 1}`);
    expect(warnings.filter((w) => w.includes(`more than ${MAX_GENERATED_TRIGGERS} triggers`))).toHaveLength(3);
  });

  it('drops customCode, always, with a warning', () => {
    const { nodes, warnings } = run([
      { type: 'div', props: { customCode: { sha256: 'a'.repeat(64), title: 'Calculator' } } },
      { type: 'div', props: { customCode: 'alert(1)', behaviour: { state: [flag('open')] } } },
    ]);
    for (const node of nodes) expect(node.props).not.toHaveProperty('customCode');
    expect(warnings.filter((w) => w.includes('customCode dropped: custom code is never written by a generator'))).toHaveLength(2);
  });

  it('drops customCode in any spelling', () => {
    const spellings = ['customcode', 'CustomCode', 'CUSTOMCODE', 'custom_code', 'custom-code'];
    const { nodes, warnings } = run(spellings.map((key) => ({ type: 'div', props: { [key]: { sha256: 'a'.repeat(64), title: 'Calculator' } } })));
    nodes.forEach((node, i) => expect(node.props).not.toHaveProperty(spellings[i]));
    for (const key of spellings) expect(warnings).toContainEqual(expect.stringContaining(`${key} dropped: custom code is never written by a generator`));
  });

  it('counts stored behaviour as a rule for an image from another host', () => {
    const { nodes, warnings } = run([
      reveal(),
      { type: 'img', props: { src: 'https://evil.test/pixel.png', alt: 'A pixel' } },
    ]);
    expect(nodes[1].props.src).not.toContain('evil.test');
    expect(warnings.join(' ')).toContain('from another host beside a rule');
  });

  it('leaves a node without behaviour as it was', () => {
    const { nodes } = run([{ type: 'p', props: { children: 'Plain' } }]);
    expect(nodes[0].props).not.toHaveProperty('behaviour');
  });
});

/** A node as the palette's function wrote it, without the labels the validator adds. */
const shape = (node: PresetNode | GeneratedNodeSnapshot): unknown => ({
  id: node.id,
  type: node.type,
  props: node.props,
  children: (node.children ?? []).map(shape),
});

describe('behaviour presets the model asks for', () => {
  const requests: Array<[string, Record<string, unknown>, (seed: string) => PresetNode]> = [
    ['tabs', { items: [{ title: 'One', body: 'First' }, { title: 'Two', body: 'Second' }], options: { label: 'Sections' } },
      (seed) => tabs({ seed, label: 'Sections', items: [{ title: 'One', body: 'First' }, { title: 'Two', body: 'Second' }] })],
    ['toolbar', { items: ['Bold', 'Italic'], options: { label: 'Format' } }, (seed) => toolbar({ seed, label: 'Format', items: ['Bold', 'Italic'] })],
    ['tooltip', { options: { label: 'Save', text: 'Saves the page' } }, (seed) => tooltip({ seed, label: 'Save', text: 'Saves the page' })],
    ['carousel', { items: ['One', 'Two', 'Three'], options: { label: 'Offers' } }, (seed) => carousel({ seed, label: 'Offers', slides: ['One', 'Two', 'Three'] })],
    ['menu-button', { items: ['Copy', 'Paste'], options: { label: 'Actions' } }, (seed) => menuButton({ seed, label: 'Actions', items: ['Copy', 'Paste'] })],
    ['menubar', { items: [{ title: 'Shop', href: '/shop', items: [{ title: 'New', href: '/shop/new' }] }], options: { label: 'Site' } },
      (seed) => menubar({ seed, label: 'Site', menus: [{ title: 'Shop', href: '/shop', items: [{ title: 'New', href: '/shop/new' }] }] })],
    ['combobox', { items: ['Bern', 'Basel'], options: { label: 'City' } }, (seed) => combobox({ seed, label: 'City', options: ['Bern', 'Basel'] })],
    ['slider-multithumb', { options: { label: 'Price', min: 0, max: 10, low: 2, high: 8 } }, (seed) => multithumbSlider({ seed, label: 'Price', min: 0, max: 10, low: 2, high: 8 })],
    ['windowsplitter', { options: { label: 'Resize', first: 'Left', second: 'Right', at: 30 } }, (seed) => splitter({ seed, label: 'Resize', first: 'Left', second: 'Right', at: 30 })],
    ['feed', { items: [{ title: 'One', body: 'First' }], options: { label: 'News' } }, (seed) => feed({ seed, label: 'News', articles: [{ title: 'One', body: 'First' }] })],
    ['dataGrid', { items: [['Tea', '3']], options: { label: 'Prices', columns: ['Item', 'Price'] } }, (seed) => grid({ seed, label: 'Prices', columns: ['Item', 'Price'], rows: [['Tea', '3']] })],
    ['treeview', { items: [{ title: 'Fruit', children: [{ title: 'Apple' }] }], options: { label: 'Files' } },
      (seed) => treeview({ seed, label: 'Files', items: [{ title: 'Fruit', children: [{ title: 'Apple' }] }] })],
    ['treegrid', { items: [{ cells: ['Lunch', 'Ana'], children: [{ cells: ['Re: Lunch', 'Ben'] }] }], options: { label: 'Mail', columns: ['Subject', 'From'] } },
      (seed) => treegrid({ seed, label: 'Mail', columns: ['Subject', 'From'], rows: [{ cells: ['Lunch', 'Ana'], children: [{ cells: ['Re: Lunch', 'Ben'] }] }] })],
  ];

  it.each(requests)('builds %s with the palette\'s own function, whole, under a fresh seed', (name, request, build) => {
    const { nodes, warnings } = run([{ preset: name, label: 'Widget', ...request }]);
    expect(warnings).toEqual([]);
    const [root] = nodes;
    expect(root.label).toBe('Widget');
    expect(root.id).toMatch(new RegExp(`^${name.toLowerCase()}-`));
    expect(shape(root)).toEqual(shape(build(root.id)));
    expect(readBehaviourTree(root as BehaviourNode).refused).toEqual([]);
    expect(() => ComponentModel.create(root)).not.toThrow();
  });

  it('gives two presets of a generation seeds of their own', () => {
    const one = { preset: 'toolbar', items: ['A', 'B'], options: { label: 'One' } };
    const { nodes } = run([one, { ...one, options: { label: 'Two' } }]);
    expect(nodes[0].id).not.toBe(nodes[1].id);
  });

  it('refuses a request without what it needs, and says what', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ preset: 'tabs', items: [{ title: 'One', body: 'First' }, { title: 'Two', body: 'Second' }] }, 'needs options.label'],
      [{ preset: 'tabs', items: [{ title: 'One', body: 'First' }], options: { label: 'S' } }, 'needs at least 2'],
      [{ preset: 'tooltip', options: { label: 'Save' } }, 'needs options.text'],
      [{ preset: 'dataGrid', items: [['Tea']], options: { label: 'P', columns: ['Item', 'Price'] } }, 'needs at least 1 row'],
      [{ preset: 'slider-multithumb', options: { label: 'P', min: 5, max: 5 } }, 'min below'],
      [{ preset: 'menubar', items: [{ title: 'Shop', href: 'javascript:alert(1)', items: [{ title: 'x', href: '/x' }] }], options: { label: 'Site' } }, 'needs at least 1 menu'],
    ];
    for (const [request, reason] of cases) {
      const out = validateGeneration({ nodes: [request, { type: 'p', props: { children: 'Kept' } }] }, { breakpoints });
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      expect(out.result.nodes.map((node) => node.type)).toEqual(['p']);
      expect(out.result.warnings.join(' ')).toContain(reason);
    }
  });

  it('never builds a carousel that rotates', () => {
    const { nodes, warnings } = run([{ preset: 'carousel', items: ['One', 'Two'], options: { label: 'Offers', rotateMs: 1000 } }]);
    const all = (node: GeneratedNodeSnapshot): GeneratedNodeSnapshot[] => [node, ...node.children.flatMap(all)];
    expect(all(nodes[0]).flatMap(triggersOf).some((t) => t.on === 'every')).toBe(false);
    expect(warnings.join(' ')).toContain('never rotates by itself');
  });

  it(`places at most ${MAX_GENERATED_PRESETS} presets in one generation`, () => {
    const request = { preset: 'toolbar', items: ['A', 'B'], options: { label: 'Tools' } };
    const { nodes, warnings } = run(Array.from({ length: MAX_GENERATED_PRESETS + 2 }, () => request));
    expect(nodes).toHaveLength(MAX_GENERATED_PRESETS);
    expect(warnings.filter((w) => w.includes(`more than ${MAX_GENERATED_PRESETS} presets`))).toHaveLength(2);
  });

  it('does not count a preset\'s triggers against the model\'s own', () => {
    const menus = Array.from({ length: 6 }, (_, i) => ({ title: `M${i}`, href: `/m${i}`, items: [{ title: 'x', href: `/m${i}/x` }] }));
    const { nodes, warnings } = run([{ preset: 'menubar', items: menus, options: { label: 'Site' } }, reveal()]);
    expect(warnings).toEqual([]);
    expect(triggersOf(nodes[1].children[0])).toHaveLength(1);
  });

  it('drops a preset whole when any part of it does not hold where it stands', () => {
    // The model declares the preset's own state above it, so the preset's state is refused there.
    let n = 0;
    const newId = () => `id${(n += 1)}`;
    const out = validateGeneration({
      nodes: [{
        type: 'div',
        props: { behaviour: { state: [{ id: 'tabs-id2-active', name: 'Taken', type: 'number', initial: 0 }] } },
        children: [{ preset: 'tabs', items: [{ title: 'One', body: 'First' }, { title: 'Two', body: 'Second' }], options: { label: 'S' } }],
      }],
    }, { breakpoints, newId });
    if (!out.ok) throw new Error(out.errors.join('; '));
    expect(out.result.nodes[0].children).toEqual([]);
    expect(out.result.warnings.join(' ')).toContain('preset dropped, its behaviour does not hold here');
    expect(out.result.stats.nodeCount).toBe(1);
  });

  it('keeps a preset\'s own triggers on events the model may not write itself', () => {
    const { nodes, warnings } = run([{ preset: 'tooltip', options: { label: 'Save', text: 'Saves the page' } }]);
    const all = (node: GeneratedNodeSnapshot): GeneratedNodeSnapshot[] => [node, ...node.children.flatMap(all)];
    const events = all(nodes[0]).flatMap(triggersOf).map((t) => t.on as string);
    expect(events.some((event) => !GENERATED_TRIGGER_EVENTS.has(event))).toBe(true);
    expect(warnings).toEqual([]);
  });

  it.each(['button', 'a', 'label', 'p', 'h2', 'summary'])('keeps a preset out of <%s>, at any depth', (tag) => {
    const request = { preset: 'menu-button', items: ['Copy', 'Paste'], options: { label: 'Actions' } };
    const host = (children: unknown[]) => ({ type: tag, props: tag === 'a' ? { href: '/x' } : tag === 'button' ? { type: 'button' } : {}, children });
    const direct = run([tag === 'summary' ? { type: 'details', children: [host([request])] } : host([request])]);
    const hostOf = (nodes: GeneratedNodeSnapshot[]) => (nodes[0].type === 'details' ? nodes[0].children[0] : nodes[0]);
    expect(hostOf(direct.nodes).children).toEqual([]);
    expect(direct.warnings.join(' ')).toContain(`cannot sit inside <${tag}>`);
    const deep = run([tag === 'summary'
      ? { type: 'details', children: [host([{ type: 'span', children: [request] }])] }
      : host([{ type: 'span', children: [request] }])]);
    expect(hostOf(deep.nodes).children[0].children).toEqual([]);
    expect(deep.warnings.join(' ')).toContain(`cannot sit inside <${tag}>`);
  });

  it('keeps a preset out of the element a generation is placed under, from the context', () => {
    const placed = (closedAncestor?: string) => validateGeneration(
      { nodes: [{ preset: 'menu-button', items: ['Copy', 'Paste'], options: { label: 'Actions' } }, { type: 'span', props: { children: 'Kept' } }] },
      { breakpoints, ...(closedAncestor === undefined ? {} : { closedAncestor }) },
    );
    for (const tag of ['p', 'button']) {
      const out = placed(tag);
      if (!out.ok) throw new Error(out.errors.join('; '));
      expect(out.result.nodes.map((node) => node.type)).toEqual(['span']);
      expect(out.result.warnings.join(' ')).toContain(`cannot sit inside <${tag}>`);
    }
    // Not an element a preset is refused under (and the value crosses the wire): ignored.
    for (const tag of [undefined, 'section', 'script']) {
      const out = placed(tag);
      if (!out.ok) throw new Error(out.errors.join('; '));
      expect(out.result.nodes).toHaveLength(2);
    }
  });

  it('finds the nearest closed element a placed generation stands under', () => {
    const tree = { id: 'root', type: 'div', children: [
      { id: 'card', type: 'section', children: [{ id: 'para', type: 'p', children: [{ id: 'em', type: 'em', children: [] }] }] },
      { id: 'cta', type: 'button', children: [{ id: 'inner', type: 'span', children: [] }] },
    ] };
    expect(closedAncestorOf(tree, 'para', 'insert')).toBe('p');
    expect(closedAncestorOf(tree, 'em', 'insert')).toBe('p');
    expect(closedAncestorOf(tree, 'inner', 'insert')).toBe('button');
    expect(closedAncestorOf(tree, 'inner', 'replace')).toBe('button');
    expect(closedAncestorOf(tree, 'card', 'insert')).toBeUndefined();
    // A replace takes the target's place, so the target itself does not count.
    expect(closedAncestorOf(tree, 'para', 'replace')).toBeUndefined();
    expect(closedAncestorOf(tree, 'cta', 'replace')).toBeUndefined();
    expect(closedAncestorOf({ id: 'r', type: 'p', children: [] }, 'r', 'replace')).toBe('p');
    expect(closedAncestorOf(tree, 'missing', 'insert')).toBeUndefined();
  });

  it('places a preset inside a section, a list item or a div', () => {
    for (const tag of ['section', 'div', 'article']) {
      const { nodes, warnings } = run([{ type: tag, children: [{ preset: 'menu-button', items: ['Copy', 'Paste'], options: { label: 'Actions' } }] }]);
      expect(nodes[0].children).toHaveLength(1);
      expect(warnings).toEqual([]);
    }
  });

  it('says how many nodes the model wrote when it is over the limit, a dropped preset included', () => {
    // The preset comes first so it is counted, and the model's state above it makes it not hold:
    // it is dropped after the limit was decided, and the error must not count without it.
    let n = 0;
    const out = validateGeneration({
      nodes: [
        {
          type: 'div',
          props: { behaviour: { state: [{ id: 'tabs-id2-active', name: 'Taken', type: 'number', initial: 0 }] } },
          children: [{ preset: 'tabs', items: [{ title: 'One', body: 'First' }, { title: 'Two', body: 'Second' }], options: { label: 'S' } }],
        },
        ...Array.from({ length: GENERATION_LIMITS.maxNodes + 20 }, (_, i) => ({ type: 'p', props: { children: `Filler ${i}` } })),
      ],
    }, { breakpoints, newId: () => `id${(n += 1)}` });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors).toContain(`${GENERATION_LIMITS.maxNodes + 1} nodes exceed the limit of ${GENERATION_LIMITS.maxNodes}: produce a smaller page`);
  });

  it('keeps a preset out of svg', () => {
    const { nodes, warnings } = run([{ type: 'svg', children: [{ preset: 'toolbar', items: ['A', 'B'], options: { label: 'T' } }] }]);
    expect(nodes[0].children).toEqual([]);
    expect(warnings.join(' ')).toContain('cannot sit inside svg');
  });

  it('caps what the model wrote: list lengths and text', () => {
    const { nodes, warnings } = run([{ preset: 'toolbar', items: Array.from({ length: 20 }, (_, i) => `B${i}`), options: { label: 'x'.repeat(500) } }]);
    expect(nodes[0].children).toHaveLength(12);
    expect((nodes[0].props['aria-label'] as string).length).toBe(80);
    expect(warnings.join(' ')).toContain('at most 12 items');
  });
});

describe('the prompt', () => {
  it('teaches the presets by their palette names and the one simple form, and nothing else', () => {
    const section = behaviourDocs();
    expect(buildSchemaDocs()).toContain(section);
    for (const name of ['"tabs"', '"dataGrid"', '"menu-button"', '"treegrid"', '"toggle":"open"', '"showWhen"']) expect(section).toContain(name);
    for (const untaught of ['"every"', '"navigate"', 'customCode', '"rove"', '"filter"', '"delay"', 'keydown']) expect(section).not.toContain(untaught);
  });
});
