// Coverage matrix, panel column: can the properties panel edit it? The panel is
// driven, not read. The real RightSidebar is mounted for a node of every component
// category, every control it shows is operated (inputs typed in, selects walked,
// buttons and switches clicked, until no new control appears), and the node's
// snapshot is compared before and after each action. A key counts as editable only
// when an action actually changed it.
//
// "Editable" for an element: a person can get that tag onto a page, because a
// palette entry produces it or a panel action changes a node's type. The source of
// the sections is also scanned, so a key the panel writes but this driver did not
// reach becomes "not tested" and never a silent fail or pass.
//
// The state switch is driven on its own: a click on it changes what every other
// control writes, so the sweep leaves it alone, and a state counts when a value typed
// into a real row of the panel ends up in that state's rule on the node.
//
// Selectors and at-rules with no control of their own go through the raw field behind
// the switch's `+`: the row's sample is typed there, and a row counts when that rule is
// on the node. Such a cell is labelled `raw field`, because a person typing CSS is not
// a control, and the report counts them apart.
//
// The Custom section's add fields take a name, then a value, so typing the same few
// probes into every field cannot reach them. For those the driver types each name of
// the universe, as a person would, and only a real write counts.
//
// An event row asks whether a person can write, through the Interactions section, the
// stored page of that event's proof in events.score.ts: the proof's tree is on the page
// without its trigger, its host is selected, and the driver adds the interaction as a
// person would (the event, then "Set a value", the value, true). The cell passes when the
// node then holds exactly the trigger the proof stores and the parser refuses nothing on
// it. An event picked from "All events" rather than the first list carries `raw field`.
// report.ts lowers a cell whose proof does not run on the published page. The two
// behaviour sections stay out of the sweep: a click there writes `behaviour`, which
// counts for a pattern only when the palette places its preset.

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { applySnapshot, getSnapshot, isAlive } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import ComponentModel, { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { readBehaviourTree, type BehaviourNode } from '@/lib/behaviour/format';
import { isQuickEvent } from '@/lib/behaviour/authoring';
import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import RightSidebar from '@/components/sidebars/RightSidebar';
import { BLOCKED_TAGS } from '@/lib/renderer/blockedNodes';
import { isDefinitionRule, ruleCssText, storedRulesOf, type StoredRule } from '@/lib/rules/rules';
import { NAMED_STATES, namedStateOf } from '@/lib/rules/states';
import { cssPropertyName } from '@/lib/responsive/responsiveCss';
import { attributeName, attributeProp } from '@/lib/styles/customEditor';
import { PATTERNS, treeVocabulary } from './patterns';
import { allEntries, atRuleSample, attributeSample, cssValueSample, markupAttributeSample, mediaFeatureSample, namespaceOf, selectorSample, styleKeyOf } from './lib/universe';
import { atRuleProbe, isPageLevelRow, isTopLayerRow, selectorProbe, wrapperProbe, type RuleProbe } from './lib/encodings';
import { writeOut } from './lib/io';
import { RAW_FIELD, rowKey, type Cell, type GapId, type SurfaceResults } from './lib/types';
import { EVENT_PROOFS, NOT_PROVEN, n as proofNode, type EventProof, type StoredProofNode } from './lib/eventProofs';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

const pass = (note?: string): Cell => ({ status: 'pass', ...(note ? { note } : {}) });
const fail = (gap: GapId, note?: string): Cell => ({ status: 'fail', gap, ...(note ? { note } : {}) });

/** What the actions changed, over every category. */
const written = {
  styleKeys: new Set<string>(),
  propKeys: new Set<string>(),
  /** `tag.prop`, because an attribute of one element says nothing about another. */
  propsOnTag: new Set<string>(),
  /** Every value a style action left, for the value rows. */
  styleValues: new Set<string>(),
  types: new Set<string>(),
  breakpointOverride: false,
  /** The pseudo-class of each named state that a row of the panel wrote a value into. */
  states: new Set<string>(),
  /** The rows the raw field stored, by row key. */
  rawField: new Set<string>(),
};

interface Scenario {
  label: string;
  type: string;
  props: Record<string, unknown>;
}

const preset = (id: string): Pick<Scenario, 'type' | 'props'> => {
  const entry = COMPONENT_REGISTRY[id];
  return { type: entry.htmlType, props: { ...entry.defaultProps } };
};

/** One per component category of sectionConfig.ts, plus the seeds that reveal conditional rows. */
const SCENARIOS: Scenario[] = [
  { label: 'container', type: 'div', props: { style: {} } },
  { label: 'flex container', type: 'div', props: { style: { display: 'flex' } } },
  { label: 'grid container', type: 'div', props: { style: { display: 'grid' } } },
  { label: 'photo background', type: 'div', props: { style: { backgroundImage: 'url(/x.jpg)' } } },
  { label: 'absolute container', type: 'section', props: { style: { position: 'absolute' } } },
  { label: 'text', type: 'p', props: { children: 'Text', style: {} } },
  { label: 'link', type: 'a', props: { children: 'Link', href: '/', style: {} } },
  { label: 'image', type: 'img', props: { src: '/x.jpg', alt: 'x', style: {} } },
  { label: 'generic', type: 'button', props: { children: 'Go', style: { border: '1px solid red' } } },
  { label: 'form control', type: 'input', props: { style: {} } },
  { label: 'form', ...preset('form') },
  { label: 'form submit', ...preset('formSubmit') },
  { label: 'sticky bar', ...preset('stickyCta') },
];

function setUp(scenario: Scenario): ComponentInstance {
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Panel probe');
  const project = projectStore.findProjectByTitle('Panel probe')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  const main = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
  main.addChildren([createIntrinsicComponent('probe', scenario.type as 'div', scenario.props)]);
  return main.children.find((c: ComponentInstance) => c.id === 'probe') as ComponentInstance;
}

/** Notes what an action changed, and returns the style keys it wrote. */
function record(before: Record<string, unknown>, after: Record<string, unknown>, onBreakpoint: boolean): string[] {
  const styleKeys: string[] = [];
  if (before.type !== after.type) written.types.add(String(after.type));
  const beforeProps = (before.props ?? {}) as Record<string, unknown>;
  const afterProps = (after.props ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(beforeProps), ...Object.keys(afterProps)])) {
    // `behaviour` counts through the event rows and the palette's presets, never through the sweep.
    if (key === 'style' || key === 'rules' || key === 'behaviour') continue;
    if (JSON.stringify(beforeProps[key]) !== JSON.stringify(afterProps[key])) {
      written.propKeys.add(key);
      written.propsOnTag.add(`${String(after.type)}.${key}`);
    }
  }
  const beforeStyle = (beforeProps.style ?? {}) as Record<string, unknown>;
  const afterStyle = (afterProps.style ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(beforeStyle), ...Object.keys(afterStyle)])) {
    if (JSON.stringify(beforeStyle[key]) === JSON.stringify(afterStyle[key])) continue;
    written.styleKeys.add(key);
    styleKeys.push(key);
    const map = afterStyle[key];
    for (const value of map && typeof map === 'object' ? Object.values(map) : [map]) written.styleValues.add(String(value));
    if (onBreakpoint && map && typeof map === 'object' && 'tablet-probe' in map) written.breakpointOverride = true;
  }
  return styleKeys;
}

/** A stable name for a control, so it is operated once per scenario. */
function controlName(el: Element): string {
  const label = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent?.trim().slice(0, 30) ?? '';
  const id = el.getAttribute('id') ?? '';
  const row = el.closest('div.grid')?.textContent?.trim().slice(0, 30) ?? '';
  return `${el.tagName}|${el.getAttribute('type') ?? ''}|${el.getAttribute('role') ?? ''}|${label}|${row}|${label ? '' : id}`;
}

const TEXT_TRIES = ['37', '12px', 'probe-value', '#123456'];

/**
 * The value rows a driver action can decide: the shapes in TEXT_TRIES. Any other
 * row needs a control that takes free text: the Custom section's, driven with the
 * row's sample in driveCustomNames.
 */
const VALUE_ROW_TRY: Record<string, string> = {
  '<length>': '12px',
  '<length-percentage>': '12px',
  '<dimension>': '12px',
  px: '12px',
  '<color>': '#123456',
  '<integer>': '37',
  '<number>': '37',
};

/** The control that last wrote a style key, by controlName, so a sample value can be typed into it. */
const writers = new Map<string, string>();
let lastStyleKeys: string[] = [];

/** Runs one action on the panel and records what it changed on the node. */
async function step(node: ComponentInstance, onBreakpoint: boolean, fn: () => void): Promise<void> {
  if (!isAlive(node)) return;
  const before = JSON.parse(JSON.stringify(getSnapshot(node)));
  await act(async () => {
    fn();
    await Promise.resolve();
  });
  if (isAlive(node)) lastStyleKeys = record(before, JSON.parse(JSON.stringify(getSnapshot(node))), onBreakpoint);
}

async function operate(el: Element, node: ComponentInstance, onBreakpoint: boolean): Promise<void> {
  if (el instanceof HTMLSelectElement) {
    for (const option of Array.from(el.options)) {
      if (!option.value) continue;
      await step(node, onBreakpoint, () => fireEvent.change(el, { target: { value: option.value } }));
    }
    return;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
      await step(node, onBreakpoint, () => fireEvent.click(el));
      return;
    }
    if (el instanceof HTMLInputElement && el.type === 'file') return;
    const tries = el instanceof HTMLInputElement && el.type === 'color' ? ['#123456'] : TEXT_TRIES;
    for (const value of tries) {
      // Separate steps: a field commits from its own state on Enter or blur,
      // so the change has to render before the commit reads it.
      await step(node, onBreakpoint, () => fireEvent.focus(el));
      await step(node, onBreakpoint, () => fireEvent.change(el, { target: { value } }));
      await step(node, onBreakpoint, () => fireEvent.keyDown(el, { key: 'Enter' }));
      for (const key of lastStyleKeys) writers.set(key, controlName(el));
      await step(node, onBreakpoint, () => fireEvent.blur(el));
      for (const key of lastStyleKeys) writers.set(key, controlName(el));
    }
    return;
  }
  // An open section stays open: closing it would hide the controls still to be operated.
  if (el.getAttribute('aria-expanded') === 'true') return;
  await step(node, onBreakpoint, () => fireEvent.click(el));
}

/** Each preset the palette offers, dropped on a real page as a drop does it: what comes back says which really landed. */
function placePresets(): string[] {
  const { projectStore } = createRootStore();
  projectStore.createProject('Preset probe');
  const page = projectStore.findProjectByTitle('Preset probe')?.findPageBySlug('');
  if (!page) throw new Error('no page to place a preset on');
  return Object.values(COMPONENT_REGISTRY).flatMap((entry) => {
    if (!entry.preset) return [];
    const placed = page.insertRegistryComponent(entry.id, { kind: 'appTree' });
    const kind = (placed?.props.behaviour as { preset?: { kind: string } } | undefined)?.preset?.kind;
    return kind ? [kind] : [];
  });
}

/** Adds one property or attribute through the Custom section, by keyboard. */
async function addThroughCustom(node: ComponentInstance, thing: string, name: string, value: string): Promise<void> {
  const field = (kind: string) => document.body.querySelector(`input[aria-label="${thing} ${kind}"]`);
  const nameField = field('name');
  const valueField = field('value');
  if (!nameField || !valueField) return;
  await step(node, false, () => fireEvent.change(nameField, { target: { value: name } }));
  await step(node, false, () => fireEvent.change(valueField, { target: { value } }));
  await step(node, false, () => fireEvent.keyDown(valueField, { key: 'Enter' }));
}

/** Types a value into the section control that writes this style key, as the row's own field. */
async function typeIntoOwnControl(node: ComponentInstance, styleKey: string, value: string): Promise<void> {
  const name = writers.get(styleKey);
  const el = Array.from(document.body.querySelectorAll('input')).find((input) => controlName(input) === name);
  if (!el) return;
  await step(node, false, () => fireEvent.focus(el));
  await step(node, false, () => fireEvent.change(el, { target: { value } }));
  await step(node, false, () => fireEvent.keyDown(el, { key: 'Enter' }));
  await step(node, false, () => fireEvent.blur(el));
}

/** Sets the node's tag through the Custom section's picker. False when the picker does not offer it. */
async function pickTag(node: ComponentInstance, tag: string): Promise<boolean> {
  const picker = document.body.querySelector('select:has(option[value="section"])');
  if (!picker || !picker.querySelector(`option[value="${tag}"]`)) return false;
  await step(node, false, () => fireEvent.change(picker, { target: { value: tag } }));
  return node.type === tag;
}

/** Every name of the universe that no control has written yet. */
async function driveCustomNames(node: ComponentInstance): Promise<void> {
  const seed = getSnapshot(node);
  for (const entry of allEntries().filter((e) => !e.excluded)) {
    if (entry.kind === 'css-property') {
      if (written.styleKeys.has(styleKeyOf(entry.id))) continue;
      const name = entry.id === '--*' ? '--probe' : entry.id;
      await addThroughCustom(node, 'CSS property', name, 'inherit');
    } else if (entry.kind === 'html-global-attribute') {
      const sample = attributeSample(entry.id);
      if (sample.prop === 'style' || written.propKeys.has(sample.prop)) continue;
      await addThroughCustom(node, 'Attribute', sample.html.split('=')[0], String(sample.value));
    } else if (entry.kind === 'css-value') {
      const { property, value } = cssValueSample(entry.id);
      if (written.styleValues.has(value)) continue;
      await addThroughCustom(node, 'CSS property', cssPropertyName(property), value);
      if (!written.styleValues.has(value)) await typeIntoOwnControl(node, property, value);
    } else if (entry.kind === 'html-element-attribute') {
      const { tag, prop, value } = markupAttributeSample('html', entry.id);
      const key = `${tag}.${prop}`;
      if (written.propsOnTag.has(key)) continue;
      // Through the picker: an element it does not offer has no attributes to edit.
      if (!(await pickTag(node, tag))) continue;
      const attribute = entry.id.slice(entry.id.indexOf('.') + 1);
      const name = attribute.startsWith('type_') ? 'type' : attribute;
      await addThroughCustom(node, 'Attribute', name, value === true ? '' : String(value));
      // A form control's `value` is stored as `defaultValue`: one attribute.
      if (written.propsOnTag.has(`${tag}.${attributeProp(name, tag)}`)) written.propsOnTag.add(key);
    } else continue;
    await act(async () => applySnapshot(node, seed));
  }
  // The attributes the interaction patterns use, which the lists above do not name.
  const patternProps = new Set(PATTERNS.flatMap((pattern) => [...treeVocabulary(pattern.tree()).props]));
  for (const prop of patternProps) {
    if (prop === 'style' || written.propKeys.has(prop)) continue;
    const name = attributeName(prop);
    await addThroughCustom(node, 'Attribute', name, 'probe');
    // A pattern spells `popovertarget`, a node stores React's `popoverTarget`: one attribute.
    if (written.propKeys.has(attributeProp(name, String(node.type)))) written.propKeys.add(prop);
    await act(async () => applySnapshot(node, seed));
  }
}

async function drive(scenario: Scenario, breakpointId?: string, customNames = false): Promise<void> {
  const node = setUp(scenario);
  if (breakpointId) {
    // A second frame's breakpoint id is random per store: give it a known one.
    store.editorUI.currentPage?.sortedViewportNodes[1].setViewportProperties({ breakpointId });
  }
  store.editorUI.selectComponent(node, breakpointId);

  const view = render(
    <DataSourceProviderContext.Provider value={new InMemoryDataSourceProvider()}>
      <RightSidebar />
    </DataSourceProviderContext.Provider>,
  );
  const seed = getSnapshot(node);
  const operated = new Set<string>();
  for (let pass = 0; pass < 8; pass++) {
    const controls = Array.from(
      document.body.querySelectorAll('input,textarea,select,button,[role="switch"],[role="slider"],[role="combobox"]'),
    ).filter((el) => !el.closest('[data-testid="state-switch"],[data-testid="interactions-section"],[data-testid="page-state-panel"]'));
    let acted = false;
    for (const el of controls) {
      if (!el.isConnected || !isAlive(node)) continue;
      const name = controlName(el);
      if (operated.has(name)) continue;
      operated.add(name);
      acted = true;
      await operate(el, node, breakpointId !== undefined);
      // Back to the seed, so one control (a display switch) cannot hide the
      // rows the rest of this list still has to operate.
      if (isAlive(node)) await act(async () => applySnapshot(node, seed));
    }
    if (!acted || !isAlive(node)) break;
  }
  if (customNames) await driveCustomNames(node);
  view.unmount();
  cleanup();
}

/** Picks each state on the switch and types a width into the row, as a person would. */
async function driveStates(scenario: Scenario): Promise<void> {
  const node = setUp(scenario);
  store.editorUI.selectComponent(node);
  const view = render(
    <DataSourceProviderContext.Provider value={new InMemoryDataSourceProvider()}>
      <RightSidebar />
    </DataSourceProviderContext.Provider>,
  );
  for (const [index, state] of NAMED_STATES.entries()) {
    const radio = Array.from(document.body.querySelectorAll('[role="radio"]')).find((el) => el.textContent === state.label);
    if (!radio) continue;
    await act(async () => fireEvent.click(radio));
    const field = document.body.querySelector('input[aria-label="Width"]');
    if (!field) continue;
    // A different width each: typing what a state already shows is no edit, and Pressed shows Hover's.
    await step(node, false, () => fireEvent.change(field, { target: { value: String(37 + index) } }));
    await step(node, false, () => fireEvent.keyDown(field, { key: 'Enter' }));
    const rule = storedRulesOf(node.props).find((candidate) => namedStateOf(candidate) === state);
    const normalWidth = (node.props.style as Record<string, unknown> | undefined)?.width;
    if (rule?.style?.width !== undefined && normalWidth === undefined) written.states.add(state.selector.slice(1));
  }
  view.unmount();
  cleanup();
}

const RAW_KINDS = new Set(['css-selector', 'css-at-rule', 'css-media-feature']);

/** What a person types for a row, and the rule it has to become. */
function rawFieldProbe(kind: string, id: string): { text: string; probe: RuleProbe } {
  if (kind === 'css-selector') {
    const probe = selectorProbe(id, selectorSample(id));
    const sample = selectorSample(id);
    const { at } = probe.rule as { at?: string[] };
    return { text: at ? `${at[0]} { ${sample} { color: red; } }` : sample, probe };
  }
  if (kind === 'css-at-rule') {
    const probe = atRuleProbe(id, atRuleSample(id));
    return { text: isDefinitionRule(probe.rule) ? ruleCssText(probe.rule) : atRuleSample(id), probe };
  }
  const at = `@media ${mediaFeatureSample(id)}`;
  return { text: at, probe: wrapperProbe(at) };
}

const sameRule = (stored: StoredRule, wanted: StoredRule): boolean => {
  if (isDefinitionRule(wanted)) return isDefinitionRule(stored) && stored.define === wanted.define;
  return !isDefinitionRule(stored) && stored.selector === wanted.selector && JSON.stringify(stored.at ?? []) === JSON.stringify(wanted.at ?? []);
};

/** Types every row into the raw field, one at a time, on a fresh node. */
async function driveRawField(scenario: Scenario): Promise<void> {
  const node = setUp(scenario);
  store.editorUI.selectComponent(node);
  const seed = getSnapshot(node);
  const view = render(
    <DataSourceProviderContext.Provider value={new InMemoryDataSourceProvider()}>
      <RightSidebar />
    </DataSourceProviderContext.Provider>,
  );
  for (const entry of allEntries().filter((e) => !e.excluded && RAW_KINDS.has(e.kind))) {
    // `&:root` parses and means nothing: a page-level row stays red here as on every surface.
    if (entry.id === 'width' || written.states.has(entry.id) || isPageLevelRow(entry.id)) continue;
    const { text, probe } = rawFieldProbe(entry.kind, entry.id);
    const plus = document.body.querySelector('button[aria-label="Add a custom rule"]');
    if (!plus) throw new Error('the switch has no add button');
    await act(async () => fireEvent.click(plus));
    const field = document.body.querySelector('textarea[aria-label="Selector or CSS rule"]');
    if (!field) throw new Error('the add button opened no field');
    await act(async () => fireEvent.change(field, { target: { value: text } }));
    await act(async () => fireEvent.keyDown(field, { key: 'Enter' }));
    if (storedRulesOf(node.props).some((rule) => sameRule(rule, probe.rule))) written.rawField.add(rowKey(entry.kind, entry.id));
    // Refused: the field stays open with its reason, and the next row must start clean.
    const open = document.body.querySelector('textarea[aria-label="Selector or CSS rule"]');
    if (open) await act(async () => fireEvent.keyDown(open, { key: 'Escape' }));
    await act(async () => {
      store.editorUI.setActiveRule(null);
      applySnapshot(node, seed);
    });
  }
  view.unmount();
  cleanup();
}

/** The trigger every proof stores: set `hit` to true. */
const proofTrigger = (event: string) => ({ id: 'proof', on: event, do: [{ set: 'hit', value: true }] });

/** The stored page of a proof under its root, holding `on` wherever the event fires. */
function proofPage(proof: EventProof, on: Record<string, unknown>): StoredProofNode {
  const state = [{ id: 'hit', name: 'hit', type: 'boolean', initial: false }, ...(proof.state ?? [])];
  return proofNode('proof-root', 'div', { behaviour: { state } }, ...proof.tree(on));
}

/** Every node of a stored tree, depth first. */
const nodesOf = (node: StoredProofNode): StoredProofNode[] => [node, ...node.children.flatMap(nodesOf)];
const triggersOf = (node: { props?: unknown }): Record<string, unknown>[] => {
  const behaviour = (node.props as { behaviour?: { on?: unknown } } | undefined)?.behaviour;
  return Array.isArray(behaviour?.on) ? (behaviour.on as Record<string, unknown>[]) : [];
};
const withoutId = ({ id: _id, ...rest }: Record<string, unknown>) => rest;

/** What a person does in the Interactions section to write a proof's trigger; `verb` swaps the action for the negative control. */
async function addThroughPanel(event: string, prevent: boolean, verb = 'set'): Promise<void> {
  const button = Array.from(document.body.querySelectorAll('button')).find((el) => el.textContent?.trim() === 'Add interaction');
  if (!button) throw new Error('the Interactions section has no Add interaction');
  await act(async () => fireEvent.click(button));
  const field = (label: string) => document.body.querySelector(`[data-testid="interactions-section"] [aria-label="${label}"]`);
  const eventField = field('Event') as HTMLSelectElement | null;
  if (!eventField || !Array.from(eventField.options).some((option) => option.value === event)) throw new Error(`the event list has no ${event}`);
  await act(async () => fireEvent.change(eventField, { target: { value: event } }));
  await act(async () => fireEvent.change(field('Action 1') as Element, { target: { value: verb } }));
  if (verb === 'set') {
    await act(async () => fireEvent.change(field('Value to change in action 1') as Element, { target: { value: 'hit' } }));
    await act(async () => fireEvent.change(field('New value in action 1') as Element, { target: { value: 'true' } }));
  }
  if (prevent) {
    const editor = document.body.querySelector('[data-testid="interactions-section"] [role="group"][aria-label="Interaction"]');
    const toggle = editor?.querySelector('[role="switch"]');
    if (!toggle) throw new Error(`${event} offers no way to stop the browser's own response`);
    await act(async () => fireEvent.click(toggle));
  }
  const save = field('Add this interaction');
  if (!save) throw new Error('the interaction has no Add button');
  await act(async () => fireEvent.click(save));
}

/**
 * The panel cell of one event row: the proof's page without its trigger, its host picked,
 * the trigger added through the real panel. Passes when the host holds exactly the proof's
 * triggers and nothing on it is refused.
 */
async function driveEvent(event: string, proof: EventProof, verb = 'set'): Promise<Cell> {
  const wanted = proofPage(proof, { on: [proofTrigger(event)] });
  const host = nodesOf(wanted).find((node) => triggersOf(node).some((trigger) => trigger.id === 'proof'));
  if (!host) return fail('blocked-event-handlers', 'the proof stores no trigger');
  const start = proofPage(proof, { on: [] });

  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Event probe');
  const project = projectStore.findProjectByTitle('Event probe')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  const main = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
  main.addChildren([ComponentModel.create(start as never)]);
  const node = page.findComponent(host.id);
  if (!node) return fail('blocked-event-handlers', `${host.id} did not land on the page`);
  editorUI.selectComponent(node);

  const view = render(
    <DataSourceProviderContext.Provider value={new InMemoryDataSourceProvider()}>
      <RightSidebar />
    </DataSourceProviderContext.Provider>,
  );
  try {
    const prevent = triggersOf(host).some((trigger) => trigger.id === 'proof' && trigger.prevent === true);
    await addThroughPanel(event, prevent, verb);
    const stored = triggersOf(node);
    const expected = triggersOf(host);
    // Triggers on one event run in order, so that order must match; across events order means nothing.
    const byEvent = (list: Record<string, unknown>[]) => {
      const out = new Map<string, string[]>();
      for (const trigger of list) out.set(String(trigger.on), [...(out.get(String(trigger.on)) ?? []), JSON.stringify(withoutId(trigger))]);
      return JSON.stringify([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
    };
    const same = stored.length === expected.length && byEvent(stored) === byEvent(expected);
    if (!same) {
      const alert = document.body.querySelector('[data-testid="interactions-section"] [role="alert"]')?.textContent;
      return fail('blocked-event-handlers', alert ? `the panel refused it: ${alert}` : 'the panel did not write the trigger the proof stores');
    }
    const refused = readBehaviourTree(getSnapshot(page.appComponentTree) as unknown as BehaviourNode).refused.filter((entry) => entry.nodeId === host.id);
    if (refused.length > 0) return fail('blocked-event-handlers', `written and refused: ${refused[0].reason}`);
    return pass(isQuickEvent(event) ? undefined : RAW_FIELD);
  } catch (error) {
    return fail('blocked-event-handlers', String((error as Error).message).slice(0, 120));
  } finally {
    view.unmount();
    cleanup();
  }
}

/** Every event row through the Interactions section. A row with no proof stays red for the reason the other columns give. */
async function driveEvents(): Promise<SurfaceResults> {
  const cells: SurfaceResults = {};
  for (const entry of allEntries().filter((e) => e.kind === 'html-event-handler' && !e.excluded)) {
    const event = entry.id.slice(2);
    const proof = EVENT_PROOFS[event];
    cells[rowKey(entry.kind, entry.id)] = proof ? await driveEvent(event, proof) : fail('blocked-event-handlers', NOT_PROVEN[event] ?? 'no proof yet');
  }
  return cells;
}

/** Every style key the section sources name, whether or not a control for it was reached. */
function referencedStyleKeys(): Set<string> {
  const dir = path.resolve(process.cwd(), 'src/components/sidebars/right/sections');
  const keys = new Set<string>();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.tsx')) continue;
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of source.matchAll(/(?:setStyleValue|updateResponsiveStyle)\(\s*'([A-Za-z]+)'/g)) keys.add(m[1]);
  }
  return keys;
}

describe('coverage matrix: properties panel', () => {
  it('drives every control of the real panel', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    // A generic element shows fewer sections, so Custom accepts what a container's own controls hold.
    for (const scenario of SCENARIOS) await drive(scenario, undefined, ['container', 'generic', 'form control'].includes(scenario.label));
    await drive(SCENARIOS[0], 'tablet-probe');
    await driveStates(SCENARIOS[0]);
    await driveRawField(SCENARIOS[0]);
    // A write the parser refuses earns nothing: focus on a hover is refused, so this cell must fail.
    const refusedWrite = await driveEvent('mouseenter', EVENT_PROOFS.mouseenter, 'focus');
    expect(refusedWrite.status).toBe('fail');
    const events = await driveEvents();

    const referenced = referencedStyleKeys();
    const paletteTags = new Set(Object.values(COMPONENT_REGISTRY).map((entry) => entry.htmlType as string));
    const presetsPlaced = placePresets();
    const results: SurfaceResults = {};
    const anyStyle = written.styleKeys.size > 0;

    for (const entry of allEntries().filter((e) => !e.excluded && e.kind !== 'aria-pattern')) {
      const key = rowKey(entry.kind, entry.id);
      switch (entry.kind) {
        case 'html-element':
          if (paletteTags.has(entry.id)) results[key] = pass('placed from the palette');
          else if (written.types.has(entry.id)) results[key] = pass('a panel action set this tag');
          else results[key] = fail(BLOCKED_TAGS.has(entry.id) ? 'blocked-embedded-content' : 'panel-no-tag-choice');
          break;
        case 'html-global-attribute': {
          const { prop } = attributeSample(entry.id);
          const ok = prop === 'style' ? anyStyle : written.propKeys.has(prop);
          results[key] = ok ? pass() : fail('panel-no-general-editor');
          break;
        }
        case 'css-property': {
          const styleKey = styleKeyOf(entry.id);
          if (written.styleKeys.has(styleKey)) results[key] = pass();
          else if (referenced.has(styleKey)) {
            results[key] = { status: 'not-tested', gap: 'harness-limit', note: 'named in a section, but the driver did not reach a control that writes it' };
          } else results[key] = fail('panel-no-general-editor');
          break;
        }
        case 'html-element-attribute':
        case 'svg-attribute':
        case 'mathml-attribute': {
          // Only HTML: an SVG or MathML `a` is not the link the panel edits.
          const namespace = namespaceOf(entry.kind);
          const { tag, prop } = markupAttributeSample(namespace, entry.id);
          if (namespace === 'html' && written.propsOnTag.has(`${tag}.${prop}`)) results[key] = pass();
          else results[key] = fail(BLOCKED_TAGS.has(tag) ? 'blocked-embedded-content' : 'panel-no-general-editor');
          break;
        }
        case 'html-event-handler':
          results[key] = events[key];
          break;
        case 'svg-element':
        case 'mathml-element':
          results[key] = fail('panel-no-tag-choice');
          break;
        case 'css-value': {
          const tried = [VALUE_ROW_TRY[entry.id], cssValueSample(entry.id).value].find((value) => written.styleValues.has(value));
          results[key] = tried ? pass(`a control wrote ${tried}`) : fail('panel-no-general-editor', 'no control wrote a value of this kind');
          break;
        }
        case 'css-selector':
          if (written.states.has(entry.id)) results[key] = pass('through the state switch');
          else if (written.rawField.has(key)) results[key] = pass(RAW_FIELD);
          else results[key] = fail(isPageLevelRow(entry.id) ? 'page-level-css' : isTopLayerRow(entry.id) ? 'top-layer-refused' : 'selector-styles');
          break;
        case 'css-at-rule':
          if (written.rawField.has(key)) results[key] = pass(RAW_FIELD);
          else results[key] = fail(isPageLevelRow(entry.id) ? 'page-level-css' : entry.id === '@media' ? 'media-queries' : 'at-rules');
          break;
        case 'css-media-feature':
          if (entry.id === 'width' && written.breakpointOverride) results[key] = pass('as breakpoints');
          else results[key] = written.rawField.has(key) ? pass(RAW_FIELD) : fail('media-queries');
          break;
      }
    }

    expect(written.styleKeys.size).toBeGreaterThan(10);
    expect(written.states.size).toBe(NAMED_STATES.length);
    writeOut('panel', results);
    writeOut('panel-detail', {
      scenarios: SCENARIOS.map((s) => s.label),
      styleKeysWritten: [...written.styleKeys].sort(),
      propKeysWritten: [...written.propKeys].sort(),
      typesWritten: [...written.types].sort(),
      referencedNotDriven: [...referenced].filter((k) => !written.styleKeys.has(k)).sort(),
      paletteTags: [...paletteTags].sort(),
      presetsPlaced,
      rawFieldRows: [...written.rawField].sort(),
      rawFieldEvents: Object.entries(events).filter(([, cell]) => cell.note === RAW_FIELD).map(([key]) => key).sort(),
    });
  }, 900_000);
});
