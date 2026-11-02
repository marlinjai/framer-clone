// The reusable component rows that can be measured so far: the format column and
// the published column, for the capabilities expansion delivers and the seven
// first input types. Every check runs the real code: a stored shape goes through
// ComponentModel, a snapshot, JSON and parseComponents, and a page through
// snapshotToComponentNode and renderPublishedPage. A row with no probe here stays
// failed in report.ts, so an unmeasured promise can never count as kept.

import { describe, expect, it, vi } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ComponentModel, { ComponentTypeEnum } from '@/models/ComponentModel';
import { parseComponents, type ComponentDefinitions } from '@/lib/components/definition';
import { compiledEventName, expandPlacements } from '@/lib/components/expand';
import { readBehaviourTree } from '@/lib/behaviour/format';
import { readRules } from '@/lib/rules/rules';
import { HOVER_GATE } from '@/lib/rules/states';
import { parseInputValue, type InputDefinition, type InputType } from '@/lib/components/inputs';
import { MISSING_TYPE } from '@/lib/components/placement';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { componentEntries } from './lib/universe';
import { CARD, definition, definitionsOf, INPUT_PROBES, jsonTrip, page, placement, read, type Stored } from './lib/componentProbes';
import { BREAKPOINTS, renderThroughPublishedPage } from './lib/published';
import { writeOut } from './lib/io';
import { ACCEPTED_NOT_TAUGHT, rowKey, type Cell, type SurfaceResults } from './lib/types';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { componentSummaries, type GenerationComponents } from '@/lib/components/summaries';

/** Through the editor's model, a snapshot, JSON and the model again, as a save and load does. */
function savedAndLoaded(node: Stored): Stored {
  const withType = (n: Stored): Record<string, unknown> => ({
    ...n,
    componentType: ComponentTypeEnum.HOST,
    props: n.props ?? {},
    ...(n.children ? { children: n.children.map(withType) } : {}),
  });
  const first = ComponentModel.create(withType(node) as never);
  const second = ComponentModel.create(jsonTrip(getSnapshot(first)));
  return jsonTrip(getSnapshot(second)) as unknown as Stored;
}

const expandedRoot = (children: Stored[], definitions: ComponentDefinitions): ComponentNode => {
  const stored = savedAndLoaded(page(children));
  return expandPlacements(stored as ComponentNode, definitions, BREAKPOINTS);
};

/** A button whose root and label each hold one stored rule for a pointer state, through ComponentModel and JSON. */
const POINTER_KINDS = { 'state-hover': 'hover', 'state-pressed': 'pressed', 'state-focused': 'focused' } as const;
const POINTER_CSS = { hover: ':hover', pressed: ':active', focused: ':is(:focus-visible, :has(:focus-visible))' } as const;
const MARKER = '[data-u-c-btn="btn"]';

function pointerButton(kind: keyof typeof POINTER_CSS) {
  const rule = (style: Record<string, unknown>) => ({ id: `state-${kind}`, componentState: kind, selector: '&', style });
  const tree = savedAndLoaded({
    id: 'b-root', type: 'button', props: { rules: [rule({ color: 'rgb(1, 2, 3)' })] },
    children: [{ id: 'b-label', type: 'span', props: { children: 'Go', rules: [rule({ fontWeight: '700' })] } }],
  });
  return { ...definition('btn', tree), states: [{ id: kind, name: kind, kind }] } as unknown as ReturnType<typeof definition>;
}

/** A menu whose list shows only in its custom Open state, through ComponentModel and JSON. */
function customMenu() {
  const tree = savedAndLoaded({
    id: 'm-root', type: 'nav', props: {},
    children: [{ id: 'm-links', type: 'ul', props: { style: { display: 'none' }, rules: [
      { id: 'state-open', componentState: 'open', selector: '&', style: { display: 'flex' } },
    ] } }],
  });
  return { ...definition('menu', tree), states: [{ id: 'open', name: 'Open', kind: 'custom' }] } as unknown as ReturnType<typeof definition>;
}
const MENU_STATE = 'cs-menu';

/**
 * A menu whose button opens it on click (or `on`), emits its Event input, and whose
 * list shows in Open. Through ComponentModel and JSON.
 */
function interactiveMenu(on = 'click') {
  const tree = savedAndLoaded({
    id: 'm-root', type: 'nav', props: {},
    children: [
      { id: 'm-toggle', type: 'button', props: { type: 'button', children: 'Menu', behaviour: { on: [
        { id: 'open', on, do: [{ set: MENU_STATE, value: 'open' }] },
        { id: 'chosen', on: 'click', do: [{ emit: 'input-chosen' }] },
      ] } } },
      { id: 'm-links', type: 'ul', props: { style: { display: 'none' }, rules: [
        { id: 'state-open', componentState: 'open', selector: '&', style: { display: 'flex' } },
      ] } },
    ],
  });
  return {
    ...definition('menu', tree, [{ id: 'chosen', name: 'Chosen', type: 'event' }]),
    states: [{ id: 'open', name: 'Open', kind: 'custom' }],
  } as unknown as ReturnType<typeof definition>;
}
const NAVIGATE = { behaviour: { on: [{ id: 'go', on: 'click', do: [{ navigate: '/two' }] }] } };
const LISTEN = { behaviour: { on: [{ id: 'l', on: 'custom:input-chosen', do: [{ set: 'cs-menu', value: 'primary' }] }] } };

const pass = (): Cell => ({ status: 'pass' });
const fail = (note: string): Cell => ({ status: 'fail', gap: 'reusable-components', note });
const cell = (ok: boolean, note: string): Cell => (ok ? pass() : fail(note));

async function probe(check: () => Promise<Cell> | Cell): Promise<Cell> {
  try {
    return await check();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const key = (id: string) => rowKey('component', id);

async function formatCells(): Promise<SurfaceResults> {
  const out: SurfaceResults = {};
  const cards = definitionsOf(CARD);
  out[key('definition')] = await probe(() => {
    const { definitions, refused } = parseComponents(jsonTrip({ card: CARD }));
    const tree = definitions.card?.page.appComponentTree as unknown as Stored | undefined;
    return cell(refused.length === 0 && tree?.children?.[0].id === 'c-title' && definitions.card.inputs.length === 1, 'a definition did not survive JSON and the reader');
  });
  out[key('placement')] = await probe(() => {
    const expanded = expandedRoot([placement('p1', 'card', { inputs: { title: 'Kept' } })], cards);
    return cell(expanded.children?.[0].type === 'article' && JSON.stringify(expanded).includes('Kept'), 'a saved placement did not expand');
  });
  out[key('placement-style')] = await probe(() => {
    const expanded = expandedRoot([placement('p1', 'card', { style: { width: { base: '300px' } } })], cards);
    const width = (expanded.children?.[0].props?.style as Record<string, unknown> | undefined)?.width as Record<string, unknown> | undefined;
    return cell(width?.base === '300px' && width.mobile === '50%', `merged width was ${JSON.stringify(width)}`);
  });
  out[key('nested')] = await probe(() => {
    const outer = definition('outer', { id: 'o', type: 'section', children: [placement('in', 'card')] });
    const expanded = expandedRoot([placement('p1', 'outer')], definitionsOf(outer, CARD));
    return cell(expanded.children?.[0].children?.[0].id === 'p1__in', 'a nested placement did not expand under its path');
  });
  out[key('cycle-refused')] = await probe(() => {
    const a = definition('a', { id: 'a-r', type: 'div', children: [placement('x', 'b')] });
    const b = definition('b', { id: 'b-r', type: 'div', children: [placement('y', 'a')] });
    const expanded = expandedRoot([placement('p1', 'a')], definitionsOf(a, b));
    return cell(expanded.children?.[0].children?.[0].children?.[0].type === MISSING_TYPE, 'a stored cycle was not refused');
  });
  out[key('collection-template')] = await probe(() => {
    const collection: Stored = {
      id: 'list', type: 'div', props: { 'data-component-kind': 'collection' }, bindings: { collection: read('col') },
      children: [placement('p1', 'card', {}, { 'input.title': read('{{row.title}}') })],
    };
    const template = expandedRoot([collection], cards).children?.[0].children?.[0];
    return cell(template?.type === 'article' && JSON.stringify(template.props).includes('{{row.title}}'), 'the row binding did not survive');
  });
  for (const [row, kind] of Object.entries(POINTER_KINDS)) {
    out[key(row)] = await probe(() => {
      const { definitions, refused } = parseComponents(jsonTrip({ btn: pointerButton(kind) }));
      const stored = definitions.btn?.page.appComponentTree as unknown as Stored | undefined;
      // Fail closed: the stored rule is refused raw, and only expansion makes it apply.
      const raw = readRules(stored?.props).refused.length === 1;
      const expanded = expandedRoot([placement('p1', 'btn')], definitions).children?.[0];
      const read = readRules(expanded?.props);
      const active = `${MARKER}${POINTER_CSS[kind]}`;
      const compiled = read.refused.length === 0 && read.rules[0]?.kind === 'selector'
        && read.rules[0].parts[0] === `&:where(${active}, ${active} *)`
        && (read.rules[0].at[0] === HOVER_GATE) === (kind === 'hover');
      const marked = expanded?.props?.['data-u-c-btn'] === 'btn' && definitions.btn.states[0]?.kind === kind;
      return cell(refused.length === 0 && raw && compiled && marked, `the ${kind} state did not survive the round trip and compile: ${JSON.stringify(read)}`);
    });
  }
  out[key('state-custom')] = await probe(() => {
    const { definitions, refused } = parseComponents(jsonTrip({ menu: customMenu() }));
    const expanded = expandedRoot([placement('p1', 'menu', { state: 'open' })], definitions).children?.[0];
    const choice = ((expanded?.props?.behaviour as { state?: Record<string, unknown>[] } | undefined)?.state ?? [])[0];
    const rule = ((expanded?.children?.[0].props?.rules ?? []) as Record<string, unknown>[])[0];
    const ok = refused.length === 0 && choice?.id === MENU_STATE && choice.initial === 'open'
      && JSON.stringify(choice.options) === '["primary","open"]'
      && JSON.stringify(rule?.when) === JSON.stringify({ state: MENU_STATE, eq: 'open' }) && !('componentState' in (rule ?? {}));
    return cell(ok, `the custom state did not survive the round trip and compile: ${JSON.stringify(expanded).slice(0, 300)}`);
  });
  /** The page expanded from saved and loaded placements, and what the behaviour parser refused of it. */
  const interactive = (on: string, placed: Record<string, unknown>) => {
    const { definitions, refused } = parseComponents(jsonTrip({ menu: interactiveMenu(on) }));
    const expanded = expandedRoot([placement('p1', 'menu', placed)], definitions);
    return { refused: [...refused, ...readBehaviourTree(expanded).refused], text: JSON.stringify(expanded), root: expanded.children?.[0] };
  };
  for (const [row, on] of [['interaction-click', 'click'], ['interaction-appear', 'view-enter']] as const) {
    out[key(row)] = await probe(() => {
      const { refused, text } = interactive(on, {});
      const ok = refused.length === 0 && text.includes(`{"id":"open","on":"${on}","do":[{"set":"${MENU_STATE}","value":"open"}]}`);
      return cell(ok, `the ${on} trigger did not survive and parse: ${JSON.stringify(refused)}`);
    });
  }
  out[key('placement-trigger')] = await probe(() => {
    const { refused, root } = interactive('click', NAVIGATE);
    const on = (root?.props?.behaviour as { on?: unknown[] } | undefined)?.on;
    return cell(refused.length === 0 && JSON.stringify(on) === JSON.stringify(NAVIGATE.behaviour.on), `the placement's trigger did not land on its root: ${JSON.stringify(on)}`);
  });
  out[key('event')] = await probe(() => {
    const { refused, text } = interactive('click', LISTEN);
    const name = compiledEventName('menu', 'chosen');
    const ok = refused.length === 0 && text.includes(`{"emit":"${name}"}`) && text.includes(`"on":"custom:${name}"`) && !text.includes('input-chosen');
    return cell(ok, `the event input did not pair its emit with the placement's listener: ${JSON.stringify(refused)}`);
  });
  for (const [type, sample] of Object.entries(INPUT_PROBES)) {
    out[key(type)] = await probe(() => {
      const input = jsonTrip({ id: 'x', name: 'X', type, ...sample.input }) as InputDefinition;
      const taken = parseInputValue(input, jsonTrip(sample.value)).ok;
      const stored = parseComponents(jsonTrip({ d: definition('d', { id: 'r', type: 'div' }, [input]) })).refused.length === 0;
      return cell(taken && stored && !parseInputValue(input, sample.refused).ok, 'the input did not take its sample or did not refuse the bad one');
    });
  }
  return out;
}

async function publishedCells(): Promise<SurfaceResults> {
  const out: SurfaceResults = {};
  const cards = definitionsOf(CARD);
  const html = (children: Stored[], definitions: ComponentDefinitions, rows?: Record<string, unknown>[]) =>
    renderThroughPublishedPage({ tree: page(children), definitions, rows }).then((r) => r.html);

  out[key('definition')] = await probe(async () => {
    const page1 = await html([placement('p1', 'card')], cards);
    return cell(page1.includes('<h3>Card title</h3>'), 'the default did not reach the page');
  });
  out[key('placement')] = await probe(async () => {
    const text = await html([placement('p1', 'card', { inputs: { title: 'One' } }), placement('p2', 'card', { inputs: { title: 'Two' } })], cards);
    return cell(text.includes('<h3>One</h3>') && text.includes('<h3>Two</h3>') && !text.includes('#component'), 'two placements were not two cards');
  });
  out[key('placement-style')] = await probe(async () => {
    const { html: text, } = await renderThroughPublishedPage({
      tree: page([placement('p1', 'card', { style: { width: { base: '300px' } } })]),
      definitions: cards,
    });
    return cell(text.includes('width:300px') && text.includes('width:50%'), 'the merged width did not reach the stylesheet');
  });
  out[key('nested')] = await probe(async () => {
    const outer = definition('outer', { id: 'o', type: 'section', children: [
      placement('in', 'card', {}, { 'input.title': read('{{input.heading}}') }),
    ] }, [{ id: 'heading', name: 'Heading', type: 'text' }]);
    const text = await html([placement('p1', 'outer', { inputs: { heading: 'Passed down' } })], definitionsOf(outer, CARD));
    return cell(text.includes('<section><article') && text.includes('<h3>Passed down</h3>'), 'the outer input did not reach the inner placement');
  });
  out[key('cycle-refused')] = await probe(async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = definition('a', { id: 'a-r', type: 'div', props: { title: 'kept' }, children: [placement('x', 'a')] });
    const text = await html([placement('p1', 'a')], definitionsOf(a));
    warn.mockRestore();
    return cell(text.includes('<div title="kept"></div>'), 'a cycle did not stop at the first repeat');
  });
  out[key('collection-template')] = await probe(async () => {
    const collection: Stored = {
      id: 'list', type: 'div', props: { 'data-component-kind': 'collection' }, bindings: { collection: read('col') },
      children: [placement('p1', 'card', {}, { 'input.title': read('{{row.title}}') })],
    };
    const text = await html([collection], cards, [{ title: 'Row one' }, { title: 'Row two' }]);
    return cell(text.includes('<h3>Row one</h3>') && text.includes('<h3>Row two</h3>'), 'a row did not reach its card');
  });
  for (const [row, kind] of Object.entries(POINTER_KINDS)) {
    out[key(row)] = await probe(async () => {
      const text = await html([placement('p1', 'btn'), placement('p2', 'btn')], definitionsOf(pointerButton(kind)));
      const active = `${MARKER}${POINTER_CSS[kind]}`;
      const label = `.fc_r-b-label.fc_r-b-label:where(${active}, ${active} *){font-weight:700}`;
      const root = `.fc_r-b-root.fc_r-b-root:where(${active}, ${active} *){color:rgb(1, 2, 3)}`;
      const gated = kind !== 'hover' || text.includes(`@media (hover:hover) and (pointer:fine){\n${root}`);
      const ok = text.split(label).length === 2 && text.includes(root) && gated && (text.match(/<button data-u-c-btn="btn"/g) ?? []).length === 2;
      return cell(ok, `the ${kind} state did not reach the sheet once, relative to both placements: ${text.slice(0, 400)}`);
    });
  }
  out[key('state-custom')] = await probe(async () => {
    const text = await html([placement('p1', 'menu', { state: 'open' }), placement('p2', 'menu')], definitionsOf(customMenu()));
    const rule = `.fc_r-m-links.fc_r-m-links:where([data-fcs-${MENU_STATE}="open"] *, [data-fcs-${MENU_STATE}="open"]){display:flex}`;
    const ok = text.split(rule).length === 2 && text.includes(`<nav data-fcs-${MENU_STATE}="open"`) && text.includes(`<nav data-fcs-${MENU_STATE}="primary"`);
    return cell(ok, `each placement did not start in its own state: ${text.slice(0, 400)}`);
  });
  /** The program of a published page of two placements, and whether a node or an entry was left out. */
  const program = async (on: string, first: Record<string, unknown>, second: Record<string, unknown>) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const output = await renderThroughPublishedPage({ tree: page([placement('p1', 'menu', first), placement('p2', 'menu', second)]), definitions: definitionsOf(interactiveMenu(on)) });
    const leftOut = warn.mock.calls.some(call => String(call[0]).startsWith('applyBehaviour'));
    warn.mockRestore();
    return { html: output.html, program: JSON.stringify(output.behaviour), leftOut };
  };
  for (const [row, on] of [['interaction-click', 'click'], ['interaction-appear', 'view-enter']] as const) {
    out[key(row)] = await probe(async () => {
      const { html: text, program: entries, leftOut } = await program(on, {}, {});
      const ok = !leftOut && entries.includes(`{"id":"open","on":"${on}","do":[{"set":"${MENU_STATE}","value":"open"}]}`)
        && (text.match(/data-fc-n="m-toggle"/g) ?? []).length === 2 && (text.match(new RegExp(`data-fcs-${MENU_STATE}="primary"`, 'g')) ?? []).length === 2;
      return cell(ok, `the ${on} trigger did not reach the program for both placements: ${entries.slice(0, 300)}`);
    });
  }
  out[key('placement-trigger')] = await probe(async () => {
    const { html: text, program: entries, leftOut } = await program('click', NAVIGATE, {});
    const ok = !leftOut && entries.includes('{"navigate":"/two"}') && text.includes('data-fc-n="m-root"');
    return cell(ok, `one placement's own trigger did not reach the program: ${entries.slice(0, 300)}`);
  });
  out[key('event')] = await probe(async () => {
    const { program: entries, leftOut } = await program('click', LISTEN, NAVIGATE);
    const name = compiledEventName('menu', 'chosen');
    const ok = !leftOut && entries.includes(`{"emit":"${name}"}`) && entries.includes(`"on":"custom:${name}"`);
    return cell(ok, `the event's emit and listener did not reach the program: ${entries.slice(0, 300)}`);
  });
  for (const [type, sample] of Object.entries(INPUT_PROBES)) {
    out[key(type)] = await probe(async () => {
      const stored = definition('d', { id: 'r', ...sample.node }, [{ id: 'x', name: 'X', type: type as InputType, ...sample.input }]);
      const text = await html([placement('p1', 'd', { inputs: { x: sample.value } })], definitionsOf(stored));
      const ok = text.includes(sample.expected) && !(sample.absent && text.includes(sample.absent));
      return cell(ok, `expected ${sample.expected} in ${text.slice(-200)}`);
    });
  }
  return out;
}

// ---------- the AI generator ----------

const AI_BREAKPOINTS = deriveBreakpointKeys([{ label: 'Desktop', minWidth: 1200 }, { label: 'Tablet', minWidth: 768 }, { label: 'Mobile', minWidth: 0 }]);

/** What `validateGeneration` keeps of these nodes, given the site's components and where they land. */
function generated(nodes: unknown[], stored: ReturnType<typeof definition>[], where: Omit<GenerationComponents, 'summaries'> = {}) {
  const definitions = definitionsOf(...stored);
  const outcome = validateGeneration({ nodes }, { breakpoints: AI_BREAKPOINTS, newId: (() => { let n = 0; return () => `g${++n}`; })(), components: { summaries: componentSummaries(definitions), ...where } });
  return { definitions, nodes: outcome.ok ? outcome.result.nodes : [], warnings: outcome.ok ? outcome.result.warnings : outcome.errors };
}

/** The placement props the generator kept, the first one. */
const placedProps = (nodes: { type: string; props: Record<string, unknown> }[]): Record<string, unknown> | undefined =>
  nodes.find((node) => node.type === '#component')?.props;

/** The page a generated placement expands to, as published. */
const expandedFrom = (nodes: unknown[], definitions: ComponentDefinitions): ComponentNode =>
  expandPlacements(savedAndLoaded(page(nodes as Stored[])) as ComponentNode, definitions, BREAKPOINTS);

/** The prompt teaches placing, inputs by these types, a state and the placement's own style. */
const TAUGHT_TYPES: ReadonlySet<string> = new Set(['text', 'number', 'toggle', 'choice', 'link', 'richtext', 'image']);
const taught = (ok: boolean, note: string, isTaught: boolean): Cell =>
  ok ? (isTaught ? pass() : { status: 'pass', note: ACCEPTED_NOT_TAUGHT }) : fail(note);

async function aiCells(): Promise<SurfaceResults> {
  const out: SurfaceResults = {};
  out[key('definition')] = await probe(() => {
    const { nodes } = generated([{ type: '#component', name: 'card' }], [CARD]);
    return cell(placedProps(nodes)?.component === 'card', `the placement was not kept: ${JSON.stringify(nodes)}`);
  });
  out[key('placement')] = await probe(() => {
    const { nodes } = generated([
      { type: '#component', name: 'card', inputs: { title: 'One' } },
      { type: '#component', name: 'card', inputs: { title: 'Two' } },
    ], [CARD]);
    const titles = nodes.map((node) => (node.props.inputs as Record<string, unknown> | undefined)?.title);
    return cell(JSON.stringify(titles) === '["One","Two"]', `two placements were not kept with their inputs: ${JSON.stringify(nodes)}`);
  });
  out[key('placement-style')] = await probe(() => {
    const { nodes } = generated([{ type: '#component', name: 'card', props: { style: { width: { base: '300px', mobile: '100%' } } } }], [CARD]);
    const width = (placedProps(nodes)?.style as Record<string, unknown> | undefined)?.width;
    return cell(JSON.stringify(width) === JSON.stringify({ base: '300px', mobile: '100%' }), `the placement's width was ${JSON.stringify(width)}`);
  });
  out[key('nested')] = await probe(() => {
    const outer = definition('outer', { id: 'o', type: 'section', children: [] });
    const { nodes } = generated([{ type: '#component', name: 'card' }], [outer, CARD], { insideDefinition: 'outer' });
    return cell(placedProps(nodes)?.component === 'card', `a placement inside another component was not kept: ${JSON.stringify(nodes)}`);
  });
  out[key('cycle-refused')] = await probe(() => {
    const a = definition('a', { id: 'a-r', type: 'div', children: [placement('x', 'b')] });
    const b = definition('b', { id: 'b-r', type: 'div', children: [] });
    const { nodes, warnings } = generated([{ type: 'div', children: [{ type: '#component', name: 'a' }] }], [a, b], { insideDefinition: 'b' });
    const kept = JSON.stringify(nodes).includes('#component');
    return cell(!kept && warnings.some((warning) => warning.includes('b contains a, which contains b')), `a cycle was not refused with its path: ${JSON.stringify(warnings)}`);
  });
  out[key('collection-template')] = await probe(() =>
    fail('a generated node holds no binding, so a placement cannot read a row: the generator writes no data connections'));
  for (const [row, kind] of Object.entries(POINTER_KINDS)) {
    out[key(row)] = await probe(() => {
      const { nodes, definitions } = generated([{ type: '#component', name: 'btn' }], [pointerButton(kind)]);
      const expanded = expandedFrom(nodes, definitions).children?.[0];
      const read = readRules(expanded?.props);
      const ok = placedProps(nodes)?.component === 'btn' && expanded?.props?.['data-u-c-btn'] === 'btn' && read.refused.length === 0 && read.rules.length === 1;
      return cell(ok, `a generated placement did not carry the ${kind} state: ${JSON.stringify(read)}`);
    });
  }
  out[key('state-custom')] = await probe(() => {
    const { nodes } = generated([{ type: '#component', name: 'menu', state: 'Open' }], [customMenu()]);
    const props = placedProps(nodes);
    const refused = generated([{ type: '#component', name: 'menu', state: 'closed' }], [customMenu()]);
    return cell(props?.state === 'open' && placedProps(refused.nodes)?.state === undefined, `the starting state was ${JSON.stringify(props?.state)}`);
  });
  for (const [row, on] of [['interaction-click', 'click'], ['interaction-appear', 'view-enter']] as const) {
    out[key(row)] = await probe(() => {
      const { nodes, definitions } = generated([{ type: '#component', name: 'menu' }], [interactiveMenu(on)]);
      const text = JSON.stringify(expandedFrom(nodes, definitions));
      const ok = placedProps(nodes)?.component === 'menu' && text.includes(`{"id":"open","on":"${on}","do":[{"set":"${MENU_STATE}","value":"open"}]}`);
      return cell(ok, `a generated placement did not carry the ${on} trigger`);
    });
  }
  out[key('placement-trigger')] = await probe(() =>
    fail("the generator writes no behaviour on a placement yet, so a placement's own trigger is not kept"));
  out[key('event')] = await probe(() =>
    fail('an Event input is wired by a listener on the placement, which the generator does not write yet'));
  for (const [type, sample] of Object.entries(INPUT_PROBES)) {
    out[key(type)] = await probe(() => {
      const stored = definition('d', { id: 'r', type: 'div' }, [{ id: 'x', name: 'X', type: type as InputType, ...sample.input }]);
      const { nodes } = generated([{ type: '#component', name: 'd', inputs: { x: sample.value } }], [stored]);
      const kept = (placedProps(nodes)?.inputs as Record<string, unknown> | undefined)?.x;
      const refused = generated([{ type: '#component', name: 'd', inputs: { x: sample.refused } }], [stored]);
      const keptRefused = (placedProps(refused.nodes)?.inputs as Record<string, unknown> | undefined)?.x;
      const ok = JSON.stringify(kept) === JSON.stringify(sample.value) && keptRefused === undefined && placedProps(refused.nodes) !== undefined;
      return taught(ok, `kept ${JSON.stringify(kept)}, refused sample kept ${JSON.stringify(keptRefused)}`, TAUGHT_TYPES.has(type));
    });
  }
  // A component's pointer states and triggers are its own: placing it carries them, and
  // the prompt teaches nothing about them, so they are accepted, not taught.
  for (const row of ['state-hover', 'state-pressed', 'state-focused', 'interaction-click', 'interaction-appear']) {
    const result = out[key(row)];
    if (result?.status === 'pass') out[key(row)] = { status: 'pass', note: ACCEPTED_NOT_TAUGHT };
  }
  return out;
}

describe('reusable component rows', () => {
  it('measures what is built, and names nothing that is not a row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results = { format: await formatCells(), renderer: await publishedCells(), ai: await aiCells() };
    warn.mockRestore();
    const rows = new Set(componentEntries().map((e) => rowKey(e.kind, e.id)));
    for (const surface of Object.values(results)) {
      for (const name of Object.keys(surface)) expect(rows.has(name), name).toBe(true);
    }
    writeOut('components', results);
  });
});
