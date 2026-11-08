// The generator's behaviour: everything goes through validateGeneration and the real
// behaviour parser behind it. Model output is untrusted, and a generation may have been
// written by a prompt injection in a brief, so most of this file is what must not get
// through. See docs/plans/2026-11-02-behaviour-model.md, "AI output".
import { describe, expect, it } from 'vitest';
import ComponentModel from '@/models/ComponentModel';
import { renderToStaticMarkup } from 'react-dom/server';
import { readBehaviourTree, type BehaviourNode } from '@/lib/behaviour/format';
import { startBehaviour } from '@/lib/behaviour/runtime';
import { createVerbs, isOpen, isTextEntry, keysAnswer, pointerAt, selectionAt, viewObserver } from '@/lib/behaviour/verbs';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { applyBehaviour } from '@/lib/renderer/server/applyBehaviour';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
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

/**
 * Every state id the model declares comes back scoped to the generation (`open` as
 * `open-id4`, scopeGeneratedState). The tests below compare what the model wrote, so
 * `run` takes the scope token off again; scoped() keeps it, and the tests of the scoping
 * itself use it.
 */
const STATE_KEYS = new Set(['set', 'toggle', 'step', 'get', 'map', 'state']);
const SCOPE_TOKEN = /-id\d+$/;
function descope(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(descope);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === 'state' && Array.isArray(entry)) {
      return [key, entry.map((decl) => (decl && typeof decl === 'object' && typeof decl.id === 'string' ? { ...decl, id: decl.id.replace(SCOPE_TOKEN, '') } : decl))];
    }
    if (STATE_KEYS.has(key) && typeof entry === 'string') return [key, entry.replace(SCOPE_TOKEN, '')];
    return [key, descope(entry)];
  }));
}

function scoped(nodes: unknown[]) {
  let n = 0;
  const out = validateGeneration({ nodes }, { breakpoints, newId: () => `id${(n += 1)}` });
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.result;
}

function run(nodes: unknown[]) {
  const result = scoped(nodes);
  const unscope = (node: GeneratedNodeSnapshot): GeneratedNodeSnapshot => ({
    ...node,
    props: node.props.behaviour === undefined ? node.props : { ...node.props, behaviour: descope(node.props.behaviour) },
    children: node.children.map(unscope),
  });
  return { ...result, nodes: result.nodes.map(unscope) };
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

  it('scopes the state the model declares to the generation, references and all', () => {
    const { nodes } = scoped([reveal()]);
    const [section] = nodes;
    const id = (behaviourOf(section)?.state as Array<{ id: string }>)[0].id;
    expect(id).toMatch(/^open-[a-z0-9]+$/);
    expect(triggersOf(section.children[0])[0].do).toEqual([{ toggle: id }]);
    expect(behaviourOf(section.children[0])?.bind).toEqual([{ attr: 'aria-expanded', from: { get: id } }]);
    expect(behaviourOf(section.children[1])?.showWhen).toEqual({ state: id, eq: true });
    // A map's case names are its own text, never a state id.
    const mapped = scoped([{
      type: 'div',
      props: { behaviour: { state: [{ id: 'mode', name: 'Mode', type: 'choice', initial: 'open', options: ['open', 'shut'] }] } },
      children: [{ type: 'p', props: { children: 'x', behaviour: { bind: [{ attr: 'data-u-mode', from: { map: 'mode', cases: { open: 'yes', shut: 'no' } } }] } } }],
    }]).nodes[0];
    const modeId = (behaviourOf(mapped)?.state as Array<{ id: string }>)[0].id;
    expect(behaviourOf(mapped.children[0])?.bind).toEqual([{ attr: 'data-u-mode', from: { map: modeId, cases: { open: 'yes', shut: 'no' } } }]);
  });

  it('keeps its own value when placed under a node that declares the same id', async () => {
    const { nodes } = scoped([reveal()]);
    // The page holds "open" too, above where the generation lands (the prompt's own example).
    const page = {
      id: 'page-root',
      type: 'div',
      props: { behaviour: { state: [flag('open')] } },
      children: [{ id: 'page-flag', type: 'p', props: { children: 'Page', behaviour: { showWhen: { state: 'open', eq: true } } }, children: [] }, ...nodes],
    };
    expect(readBehaviourTree(page as unknown as BehaviourNode).refused).toEqual([]);
    const compiled = applyBehaviour(page as unknown as ComponentNode);
    document.body.innerHTML = renderToStaticMarkup(renderComponentNode(compiled.root));
    const stop = startBehaviour({
      container: document,
      program: compiled.program!,
      surface: 'preview',
      verbs: createVerbs,
      extras: { keysAnswer, isTextEntry, pointerAt, isOpen, viewObserver, selectionAt },
    });
    try {
      const id = (behaviourOf(nodes[0])?.state as Array<{ id: string }>)[0].id;
      const scopes = [...document.querySelectorAll('[data-fc-scope]')];
      const pageScope = scopes.find((el) => el.hasAttribute('data-fcs-open'));
      const ownScope = scopes.find((el) => el.hasAttribute(`data-fcs-${id}`));
      expect(pageScope).toBeDefined();
      expect(ownScope).toBeDefined();
      (document.querySelector('button') as HTMLButtonElement).click();
      expect(ownScope?.getAttribute(`data-fcs-${id}`)).toBe('true');
      expect(pageScope?.getAttribute('data-fcs-open')).toBe('false');
    } finally {
      stop();
      document.body.innerHTML = '';
    }
  });

  it('takes off the marks only a preset may carry', () => {
    const { nodes } = run([{
      type: 'section',
      props: { behaviour: { preset: { kind: 'tabs', version: 1 }, state: [{ ...flag('open'), preset: true }] } },
      children: [{
        type: 'button',
        props: {
          type: 'button',
          children: 'Show',
          behaviour: {
            on: [{ id: 'press', on: 'click', do: [{ toggle: 'open' }], preset: true }],
            bind: [{ attr: 'aria-expanded', from: { get: 'open' }, preset: true }],
          },
        },
      }],
    }]);
    expect(behaviourOf(nodes[0])).toEqual({ state: [flag('open')] });
    expect(behaviourOf(nodes[0].children[0])).toEqual({
      on: [{ id: 'press', on: 'click', do: [{ toggle: 'open' }] }],
      bind: [{ attr: 'aria-expanded', from: { get: 'open' } }],
    });
  });

  it('refuses scope on a trigger the model wrote: it hears its own node only', () => {
    const { nodes, warnings } = run([reveal({ on: [{ id: 'esc', on: 'keydown', scope: 'document', keys: ['Escape'], do: [{ set: 'open', value: false }] }] })]);
    expect(triggersOf(nodes[0].children[0])).toEqual([]);
    expect(warnings.join(' ')).toContain('scope is refused');
    // The tooltip preset's own Escape on the document stays.
    const tip = run([{ preset: 'tooltip', options: { label: 'Save', text: 'Saves' } }]);
    const all = (node: GeneratedNodeSnapshot): GeneratedNodeSnapshot[] => [node, ...node.children.flatMap(all)];
    expect(all(tip.nodes[0]).flatMap(triggersOf).some((t) => t.scope === 'document')).toBe(true);
    expect(tip.warnings).toEqual([]);
  });

  it('keeps two long state ids that cut to one stem two values', () => {
    const outer = `${'a'.repeat(58)}x`;
    const inner = `${'a'.repeat(58)}y`;
    // Eight characters of token, as a real id gives one: a 59 character id is cut to 55.
    let n = 0;
    const out = validateGeneration({ nodes: [{
      type: 'section',
      props: { behaviour: { state: [flag(outer)] } },
      children: [{
        type: 'div',
        props: { behaviour: { state: [flag(inner)] } },
        children: [
          { type: 'button', props: { type: 'button', children: 'Toggle', behaviour: { on: [{ id: 'press', on: 'click', do: [{ toggle: inner }] }] } } },
          { type: 'p', props: { children: 'Outer', behaviour: { showWhen: { state: outer, eq: true } } } },
        ],
      }],
    }] }, { breakpoints, newId: () => `${(n += 1)}`.padStart(8, 'k') });
    if (!out.ok) throw new Error(out.errors.join('; '));
    const { nodes, warnings } = out.result;
    expect(warnings).toEqual([]);
    const outerId = (behaviourOf(nodes[0])?.state as Array<{ id: string }>)[0].id;
    const innerId = (behaviourOf(nodes[0].children[0])?.state as Array<{ id: string }>)[0].id;
    expect(outerId).not.toBe(innerId);
    for (const id of [outerId, innerId]) expect(id.length).toBeLessThanOrEqual(64);
    const [button, part] = nodes[0].children[0].children;
    expect(triggersOf(button)[0].do).toEqual([{ toggle: innerId }]);
    expect(behaviourOf(part)?.showWhen).toEqual({ state: outerId, eq: true });
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
    // A variant selector is a commerce island, which owns the fields under it: the tabs'
    // own state and bindings are refused there, so the tabs go whole.
    const out = validateGeneration({
      nodes: [{ type: 'div', preset: 'variantSelector', children: [{ preset: 'tabs', items: [{ title: 'One', body: 'First' }, { title: 'Two', body: 'Second' }], options: { label: 'S' } }] }],
    }, { breakpoints });
    if (!out.ok) throw new Error(out.errors.join('; '));
    expect(out.result.nodes[0].children).toEqual([]);
    expect(out.result.warnings.join(' ')).toContain('preset dropped, its behaviour does not hold here');
    expect(out.result.stats.nodeCount).toBe(1);
  });

  it('keeps a model handle from turning a preset\'s own references', () => {
    // A node the model names with an id a preset uses inside it must not take the preset's references.
    const tabsRequest = { preset: 'tabs', items: [{ title: 'One', body: 'First' }, { title: 'Two', body: 'Second' }], options: { label: 'S' } };
    let n = 0;
    const first = validateGeneration({ nodes: [tabsRequest] }, { breakpoints, newId: () => `id${(n += 1)}` });
    if (!first.ok) throw new Error(first.errors.join('; '));
    const all = (node: GeneratedNodeSnapshot): GeneratedNodeSnapshot[] => [node, ...node.children.flatMap(all)];
    const inner = all(first.result.nodes[0]).slice(1).map((node) => node.id);
    n = 0;
    const out = validateGeneration({
      nodes: [tabsRequest, ...inner.map((id) => ({ id, type: 'p', props: { children: 'Decoy', tabIndex: -1 } }))],
    }, { breakpoints, newId: () => `id${(n += 1)}` });
    if (!out.ok) throw new Error(out.errors.join('; '));
    expect(out.result.warnings).toEqual([]);
    expect(all(out.result.nodes[0]).map((node) => node.props.behaviour)).toEqual(all(first.result.nodes[0]).map((node) => node.props.behaviour));
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

  it('finds a no-flow parent, a tag in any case, and a floating canvas node', () => {
    const tree = { id: 'root', type: 'div', children: [
      { id: 'list', type: 'ul', children: [{ id: 'item', type: 'li', children: [] }] },
      { id: 'upper', type: 'BUTTON', children: [{ id: 'label', type: 'span', children: [] }] },
    ] };
    const floating = { id: 'float', type: 'button', children: [{ id: 'float-inner', type: 'span', children: [] }] };
    expect(closedAncestorOf(tree, 'list', 'insert')).toBe('ul');
    expect(closedAncestorOf(tree, 'item', 'insert')).toBeUndefined();
    expect(closedAncestorOf(tree, 'item', 'replace')).toBe('ul');
    expect(closedAncestorOf(tree, 'label', 'insert')).toBe('button');
    expect(closedAncestorOf([tree, floating], 'float-inner', 'insert')).toBe('button');
    expect(closedAncestorOf([tree, floating], 'float', 'insert')).toBe('button');
    expect(closedAncestorOf(tree, 'float-inner', 'insert')).toBeUndefined();
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

  it.each(['ul', 'ol', 'menu', 'dl', 'hgroup', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup', 'picture', 'video', 'audio', 'ruby', 'datalist', 'optgroup', 'option'])('keeps a preset from being a direct child of <%s>', (tag) => {
    const { nodes, warnings } = run([{ type: tag, children: [{ preset: 'menu-button', items: ['Copy', 'Paste'], options: { label: 'Actions' } }] }]);
    expect(nodes[0]?.children ?? []).toEqual([]);
    expect(warnings.join(' ')).toContain(`cannot sit inside <${tag}>`);
  });

  it('places a preset in a list item or a table cell, which take flow content again', () => {
    const item = run([{ type: 'ul', children: [{ type: 'li', children: [{ preset: 'menu-button', items: ['Copy', 'Paste'], options: { label: 'Actions' } }] }] }]);
    expect(item.nodes[0].children[0].children).toHaveLength(1);
    expect(item.warnings.join(' ')).not.toContain('cannot sit inside');
    const cell = run([{ type: 'table', children: [{ type: 'tbody', children: [{ type: 'tr', children: [{ type: 'td', children: [{ preset: 'menu-button', items: ['Copy', 'Paste'], options: { label: 'Actions' } }] }] }] }] }]);
    const td = cell.nodes[0].children[0].children[0].children[0];
    expect(td.children).toHaveLength(1);
  });

  it('reads a no-flow parent from the placement context, for the top-level nodes only', () => {
    const out = validateGeneration({ nodes: [{ preset: 'menu-button', items: ['Copy', 'Paste'], options: { label: 'Actions' } }, { type: 'li', children: [{ preset: 'menu-button', items: ['Copy', 'Paste'], options: { label: 'Actions' } }] }] }, { breakpoints, closedAncestor: 'UL' });
    if (!out.ok) throw new Error(out.errors.join('; '));
    expect(out.result.nodes.map((node) => node.type)).toEqual(['li']);
    expect(out.result.nodes[0].children).toHaveLength(1);
  });

  it('places a preset inside a section, a list item or a div', () => {
    for (const tag of ['section', 'div', 'article']) {
      const { nodes, warnings } = run([{ type: tag, children: [{ preset: 'menu-button', items: ['Copy', 'Paste'], options: { label: 'Actions' } }] }]);
      expect(nodes[0].children).toHaveLength(1);
      expect(warnings).toEqual([]);
    }
  });

  it('says how many nodes the model wrote when it is over the limit, a dropped preset included', () => {
    // The preset comes first so it is counted, and the variant selector around it makes it not
    // hold: it is dropped after the limit was decided, and the error must not count without it.
    let n = 0;
    const out = validateGeneration({
      nodes: [
        { type: 'div', preset: 'variantSelector', children: [{ preset: 'tabs', items: [{ title: 'One', body: 'First' }, { title: 'Two', body: 'Second' }], options: { label: 'S' } }] },
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
