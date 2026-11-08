// Coverage matrix, three columns in one pass: the format stores it, the published
// renderer emits it, the AI generator can produce it. A cell is decided by what
// the real code does with the entry, and a failure here is a result, not a test
// failure: only an exception in the harness fails this file.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ComponentModel, { ComponentTypeEnum, type ComponentInstance } from '@/models/ComponentModel';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { cssPropertyName, maxWidthBelow } from '@/lib/responsive/responsiveCss';
import { CSS_PROP_SET } from '@/lib/styles/cssPropSet';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { TAUGHT_RULE_ROWS } from '@/lib/ai/pageGen/promptSections/rules';
import { PERSON_TRIGGER_REFUSALS, TAUGHT_EVENT_ROWS } from '@/lib/ai/pageGen/promptSections/behaviour';
import { stableStringify } from '@/lib/ai/serializers/normalize';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { isBlockedTag } from '@/lib/renderer/blockedNodes';
import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { BREAKPOINTS, renderPublished } from './lib/published';
import {
  atRuleProbe,
  isPageLevelRow,
  isTopLayerRow,
  PROBE_COLOR,
  rootProbe,
  ruleNode,
  selectorProbe,
  styleNode,
  stylesheetHasRule,
  wrapperProbe,
  type RuleProbe,
} from './lib/encodings';
import {
  allEntries,
  atRuleSample,
  attributeSample,
  cssValueSample,
  decodeEntities,
  markupAttributeSample,
  mediaFeatureSample,
  namespaceOf,
  openingTag,
  placed,
  selectorSample,
  styleKeyOf,
  type Namespace,
  type NodeShape,
} from './lib/universe';
import { EVENT_PROOFS, NOT_PROVEN, n as proofNode, type StoredProofNode } from './lib/eventProofs';
import { writeOut } from './lib/io';
import { ACCEPTED_NOT_TAUGHT, rowKey, type Cell, type Entry, type GapId, type SurfaceResults } from './lib/types';

const pass = (note?: string): Cell => ({ status: 'pass', ...(note ? { note } : {}) });
const fail = (gap: GapId, note?: string): Cell => ({ status: 'fail', gap, ...(note ? { note } : {}) });

/** Created, snapshotted, sent through JSON and created again, as a save and load does. */
function storedRoundTrip(type: string | NodeShape, props: Record<string, unknown> = {}) {
  const shape = typeof type === 'string' ? { id: 'probe', type, props } : type;
  const first = ComponentModel.create(toSnapshot(shape));
  const reloaded = ComponentModel.create(JSON.parse(JSON.stringify(getSnapshot(first))));
  return { model: reloaded, resolved: reloaded.getResolvedProps('', []) as { attributes: Record<string, unknown>; style: Record<string, unknown> } };
}

const toSnapshot = (shape: NodeShape): Record<string, unknown> => ({
  id: shape.id,
  type: shape.type,
  componentType: ComponentTypeEnum.HOST,
  props: shape.props,
  children: (shape.children ?? []).map(toSnapshot),
});

function findStored(model: ComponentInstance, tag: string): ComponentInstance | undefined {
  if (model.type === tag) return model;
  return (model.children as ComponentInstance[]).map((child) => findStored(child, tag)).find(Boolean);
}

const aiContext = { breakpoints: deriveBreakpointKeys(BREAKPOINTS.map(({ label, minWidth }) => ({ label, minWidth }))) };

function generate(node: Record<string, unknown>) {
  const outcome = validateGeneration({ nodes: [node] }, aiContext);
  if (!outcome.ok) return { node: undefined, warnings: outcome.errors };
  return { node: outcome.result.nodes[0], warnings: outcome.result.warnings };
}

const results = { format: {} as SurfaceResults, renderer: {} as SurfaceResults, ai: {} as SurfaceResults };

function probeElement(tag: string, key: string): void {
  const stored = storedRoundTrip(tag, {});
  results.format[key] = stored.model.type === tag ? pass() : fail('unclassified', 'the model changed the tag');

  const voidlessChild = { id: 'probe', type: tag, props: {} } satisfies ComponentNode;
  const { html } = renderPublished(voidlessChild);
  if (new RegExp(`<${tag}[\\s>/]`).test(html)) results.renderer[key] = pass();
  else if (isBlockedTag(tag)) results.renderer[key] = fail('blocked-embedded-content', 'dropped by blockedNodes.ts');
  else if (COMPONENT_REGISTRY[tag]) {
    results.renderer[key] = fail('registry-tag-collision', `the tag is also a registry id, so it renders as <${COMPONENT_REGISTRY[tag].htmlType}>`);
  }
  else results.renderer[key] = fail('unclassified', `not in the output: ${html.slice(0, 80)}`);

  const made = generate({ type: tag, label: 'Probe' });
  results.ai[key] = made.node?.type === tag ? pass() : fail('ai-tag-allowlist', made.warnings[0]);
}

/** Why a tag is not on the page, so the attributes of a missing element say the same as the element. */
function missingElement(tag: string, html: string): Cell {
  if (isBlockedTag(tag)) return fail('blocked-embedded-content', 'dropped by blockedNodes.ts');
  const entry = COMPONENT_REGISTRY[tag];
  if (entry) return fail('registry-tag-collision', `the tag is also a registry id, so it renders as <${entry.htmlType}>`);
  return fail('unclassified', `not in the output: ${html.slice(0, 80)}`);
}

function findNode(node: { type: string; children?: unknown[] } | undefined, tag: string): (Record<string, unknown> & { type: string }) | undefined {
  if (!node) return undefined;
  if (node.type === tag) return node as Record<string, unknown> & { type: string };
  for (const child of (node.children ?? []) as Array<{ type: string; children?: unknown[] }>) {
    const found = findNode(child, tag);
    if (found) return found;
  }
  return undefined;
}

const stripIds = ({ type, props, children }: NodeShape): Record<string, unknown> => ({
  type,
  props,
  label: 'Probe',
  children: (children ?? []).map(stripIds),
});

const asComponentNode = (shape: NodeShape) => shape as unknown as ComponentNode;

function probeForeignElement(namespace: Namespace, tag: string, key: string): void {
  const tree = placed(namespace, tag);
  const stored = storedRoundTrip(tree);
  results.format[key] = findStored(stored.model, tag) ? pass() : fail('unclassified', 'the model changed the tag');
  const { html } = renderPublished(asComponentNode(tree));
  results.renderer[key] = openingTag(html, tag) ? pass() : missingElement(tag, html);
  const kept = findNode(generate(stripIds(tree)).node, tag);
  results.ai[key] = kept ? pass() : fail('ai-tag-allowlist');
}

function probeElementAttribute(namespace: Namespace, id: string, key: string): void {
  const sample = markupAttributeSample(namespace, id);
  const tree = placed(namespace, sample.tag, { [sample.prop]: sample.value });
  const stored = findStored(storedRoundTrip(tree).model, sample.tag);
  const resolved = stored?.getResolvedProps('', []) as { attributes: Record<string, unknown>; style: Record<string, unknown> } | undefined;
  if (JSON.stringify(resolved?.attributes[sample.prop]) === JSON.stringify(sample.value)) results.format[key] = pass();
  else if (CSS_PROP_SET.has(sample.prop) && resolved?.style[sample.prop] === sample.value) results.format[key] = pass('read back as a style');
  else if (sample.prop === 'style' && JSON.stringify(resolved?.style) === JSON.stringify(sample.value)) results.format[key] = pass();
  else results.format[key] = fail('unclassified', 'not read back unchanged');

  const { html } = renderPublished(asComponentNode(tree));
  const tag = openingTag(html, sample.tag);
  if (!tag) results.renderer[key] = missingElement(sample.tag, html);
  else if (decodeEntities(tag).toLowerCase().includes(sample.html.toLowerCase())) results.renderer[key] = pass();
  else results.renderer[key] = fail('react-attribute-handling', `expected ${sample.html}, got ${tag.slice(0, 100)}`);

  const made = generate(stripIds(tree));
  const kept = findNode(made.node, sample.tag);
  if (!kept) results.ai[key] = fail('ai-tag-allowlist');
  else if (sample.prop in ((kept.props ?? {}) as object)) results.ai[key] = pass();
  else results.ai[key] = fail(CSS_PROP_SET.has(sample.prop) ? 'attribute-read-as-style' : 'ai-attribute-allowlist', made.warnings[0]);
}

type Made = NonNullable<ReturnType<typeof generate>['node']>;

/** The keys whose value names a node, as remapBehaviourRefs in src/lib/behaviour/format.ts reads them. */
const NODE_REFERENCES: ReadonlySet<string> = new Set([
  'focus', 'rove', 'dialog', 'popover', 'details', 'media', 'fullscreen', 'pictureInPicture', 'scroll', 'form',
  'setProp', 'filter', 'effect', 'of', 'active', 'owner',
]);

/** The keys whose text names a state value. */
const STATE_REFERENCES: ReadonlySet<string> = new Set(['set', 'toggle', 'step', 'get', 'map', 'state']);

/** The state ids a tree declares. */
function statesIn(root: Made | StoredProofNode | undefined): string[] {
  if (!root) return [];
  const own = ((root.props as { behaviour?: { state?: Array<{ id?: unknown }> } } | undefined)?.behaviour?.state ?? [])
    .flatMap((entry) => (typeof entry?.id === 'string' ? [entry.id] : []));
  return [...own, ...((root.children ?? []) as Array<Made | StoredProofNode>).flatMap(statesIn)];
}

/**
 * Every trigger of a tree with the tag it sits on. The generator gives each node a fresh id
 * and a reference follows it, so a reference to a node of the tree reads as `#node`.
 * `scopedSuffix` is what the generator appended to every state id it was given
 * (scopeGeneratedState in validate.ts), taken off a state reference so the proof's trigger
 * and the generated one compare as one.
 */
function triggersIn(root: Made | StoredProofNode | undefined, scopedSuffix = ''): Array<{ tag: string; trigger: string }> {
  if (!root) return [];
  const ids = new Set<string>();
  const collect = (node: Made | StoredProofNode): void => {
    ids.add(node.id);
    ((node.children ?? []) as Array<Made | StoredProofNode>).forEach(collect);
  };
  collect(root);
  const unscoped = (v: string) => (scopedSuffix && v.endsWith(scopedSuffix) ? v.slice(0, -scopedSuffix.length) : v);
  const anonymous = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(anonymous);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [
      k,
      NODE_REFERENCES.has(k) && typeof v === 'string' && ids.has(v)
        ? '#node'
        : STATE_REFERENCES.has(k) && typeof v === 'string'
          ? unscoped(v)
          : anonymous(v),
    ]));
  };
  const walk = (node: Made | StoredProofNode): Array<{ tag: string; trigger: string }> => {
    const behaviour = (node.props as { behaviour?: { on?: unknown[] } } | undefined)?.behaviour;
    return [
      ...(behaviour?.on ?? []).map((trigger) => ({ tag: node.type, trigger: stableStringify(anonymous(trigger)) })),
      ...((node.children ?? []) as Array<Made | StoredProofNode>).flatMap(walk),
    ];
  };
  return walk(root);
}

/**
 * The AI cell of an event row: the generator is given the stored page of the row's proof in
 * events.score.ts, the trigger on that event included, and must give it back. Its trigger
 * has to come back unchanged on the same tag, and so does every other trigger the proof
 * stores, since the row's cause depends on them. Acceptance alone earns the cell: the prompt
 * teaches only a press, so every other row says `accepted, not taught`. A trigger the model
 * writes runs on a person's click, key or input only, so a row whose proof stores any other
 * trigger is `ai-trigger-refused`, a safety decision. A row with no proof stays red for the
 * reason the other columns give.
 */
const TRIGGER_REFUSALS: readonly string[] = Object.values(PERSON_TRIGGER_REFUSALS);

function generatedEvent(event: string, key: string): Cell {
  const proof = EVENT_PROOFS[event];
  if (!proof) return fail('blocked-event-handlers', NOT_PROVEN[event] ?? 'no proof yet');
  const trigger = { id: 'proof', on: event, do: [{ set: 'hit', value: true }] };
  const state = [{ id: 'hit', name: 'hit', type: 'boolean', initial: false }, ...(proof.state ?? [])];
  const tree = proofNode('proof-root', 'div', { behaviour: { state } }, ...proof.tree({ on: [trigger] }));
  const made = generate(tree as unknown as Record<string, unknown>);
  const before = triggersIn(tree);
  // The generator scopes every state id it is given; the proof's own `hit` shows by how much.
  const scopedHit = statesIn(made.node).find((id) => id.startsWith('hit-'));
  const after = triggersIn(made.node, scopedHit ? scopedHit.slice('hit'.length) : '');
  const own = stableStringify(trigger);
  const host = before.find((entry) => entry.trigger === own)?.tag;
  const same = (a: { tag: string; trigger: string }, b: { tag: string; trigger: string }) => a.tag === b.tag && a.trigger === b.trigger;
  const kept = after.some((entry) => same(entry, { tag: host ?? '', trigger: own }));
  if (kept && before.every((entry) => after.some((other) => same(entry, other)))) {
    return pass(TAUGHT_EVENT_ROWS.has(key.slice(key.indexOf(':') + 1)) ? undefined : ACCEPTED_NOT_TAUGHT);
  }
  // The proof's own `data-t` markers are refused too, and say nothing about the row.
  const lost = made.warnings.find((warning) => /behaviour|tag "|is a preset/.test(warning)) ?? made.warnings.find((warning) => !warning.includes('"data-t"'));
  if (!findNode(made.node, host ?? '')) return fail('ai-tag-allowlist', lost);
  const refused = made.warnings.find((warning) => TRIGGER_REFUSALS.some((reason) => warning.includes(reason)));
  if (refused) return fail('ai-trigger-refused', refused);
  return fail('blocked-event-handlers', lost ?? 'the generator did not keep the trigger');
}

/**
 * A stored handler is a string of code, and reaching the page would be the failure, so
 * this throws. Whether the event works is a different question, asked in events.score.ts,
 * whose cells replace these two in report.ts. The AI cell is generatedEvent's.
 */
function probeEventHandler(id: string, key: string): void {
  const camel = `on${id[2].toUpperCase()}${id.slice(3)}`;
  const attempts = [{ [id]: 'probe()' }, { [camel]: 'probe()' }];
  const reached = attempts.some((props) => openingTag(renderPublished({ id: 'probe', type: 'div', props: props as never }).html, 'div')?.includes(`${id}=`));
  if (reached) throw new Error(`a stored ${id} string reached the page`);
  results.format[key] = fail('blocked-event-handlers', 'no proof ran');
  results.renderer[key] = fail('blocked-event-handlers', 'no proof ran');
  if (attempts.some((props) => Object.keys(props)[0] in (generate({ type: 'div', props }).node?.props ?? {}))) {
    throw new Error(`the generator kept a stored ${id} string`);
  }
  results.ai[key] = generatedEvent(id.slice(2), key);
}

/** A representative value on a host property, both ways a declaration reaches a page. */
function probeCssValue(id: string, key: string): void {
  const { property, value } = cssValueSample(id);
  const declaration = `${cssPropertyName(property)}:${value}`;

  const stored = storedRoundTrip('div', { style: { [property]: value } });
  results.format[key] = stored.resolved.style[property] === value ? pass() : fail('unclassified', 'not read back unchanged');

  const inline = renderPublished({ id: 'probe', type: 'div', props: { style: { [property]: value } } as never });
  const sheet = renderPublished({
    id: 'probe',
    type: 'div',
    props: { style: { [property]: { base: value, tablet: 'inherit' } } } as never,
  });
  const inInline = decodeEntities(inline.html).includes(declaration);
  const inSheet = sheet.css.includes(declaration);
  results.renderer[key] =
    inInline && inSheet
      ? pass()
      : fail('renderer-drops-value', `inline ${inInline ? 'kept' : 'lost'}, stylesheet ${inSheet ? 'kept' : 'lost'}`);

  const made = generate({ type: 'div', props: { style: { [property]: value } } });
  const style = (made.node?.props.style ?? {}) as Record<string, unknown>;
  if (style[property] === value) results.ai[key] = pass();
  else if (CSS_PROP_SET.has(property)) results.ai[key] = fail('ai-value-refused', made.warnings[0]);
  else results.ai[key] = fail('ai-style-allowlist', `the host property ${property} is not in the list`);
}

function probeAttribute(id: string, key: string): void {
  const sample = attributeSample(id);
  const stored = storedRoundTrip('div', { [sample.prop]: sample.value });
  const readBack = sample.prop === 'style' ? stored.resolved.style : stored.resolved.attributes[sample.prop];
  results.format[key] =
    JSON.stringify(readBack) === JSON.stringify(sample.value) ? pass() : fail('unclassified', 'not read back unchanged');

  const { html } = renderPublished({ id: 'probe', type: 'div', props: { [sample.prop]: sample.value } as never });
  // Attribute names are case-insensitive in HTML, and React's server output keeps the prop's case.
  results.renderer[key] = html.toLowerCase().includes(sample.html.toLowerCase())
    ? pass()
    : fail('react-attribute-handling', `expected ${sample.html}, got ${html.slice(0, 100)}`);

  const made = generate({ type: 'div', props: { [sample.prop]: sample.value } });
  const props = made.node?.props ?? {};
  results.ai[key] = sample.prop in props ? pass() : fail('ai-attribute-allowlist', made.warnings[0]);
}

function probeProperty(property: string, key: string): void {
  const styleKey = styleKeyOf(property);
  const declaration = `${cssPropertyName(styleKey)}:initial`;

  const stored = storedRoundTrip('div', { style: { [styleKey]: 'initial' } });
  results.format[key] = stored.resolved.style[styleKey] === 'initial' ? pass() : fail('unclassified', 'not read back unchanged');

  // Both ways a declaration reaches a published page: inline when the value is
  // plain, the page stylesheet when any value on the node is responsive.
  const inline = renderPublished({ id: 'probe', type: 'div', props: { style: { [styleKey]: 'initial' } } as never });
  const sheet = renderPublished({
    id: 'probe',
    type: 'div',
    props: { style: { [styleKey]: { base: 'initial', tablet: 'inherit' } } } as never,
  });
  const inInline = inline.html.includes(declaration);
  const inSheet = sheet.css.includes(declaration);
  results.renderer[key] =
    inInline && inSheet
      ? pass()
      : fail('renderer-drops-value', `inline ${inInline ? 'kept' : 'lost'}, stylesheet ${inSheet ? 'kept' : 'lost'}`);

  const made = generate({ type: 'div', props: { style: { [styleKey]: 'initial' } } });
  const style = (made.node?.props.style ?? {}) as Record<string, unknown>;
  results.ai[key] = styleKey in style ? pass() : fail('ai-style-allowlist');
}

function probeRule(probe: RuleProbe, key: string, gap: GapId, presetNote?: string): void {
  const { rule } = probe;
  const reached = stylesheetHasRule(renderPublished(ruleNode(rule)).css, probe);
  const stored = JSON.stringify(storedRoundTrip('div', { rules: [rule] }).model.props.rules) === JSON.stringify([rule]);

  // Bytes alone prove nothing here (props are opaque JSON and hold anything), so
  // storing a rule counts only when a reader gives it a meaning.
  results.format[key] = reached && stored ? pass() : fail(gap, presetNote ?? 'stored, but nothing reads it yet');
  results.renderer[key] = reached ? pass() : fail(gap, presetNote);

  const out = (generate({ type: 'div', props: { rules: [rule] } }).node?.props.rules ?? []) as unknown[];
  // Acceptance alone earns the cell: the label says the prompt does not ask for it.
  const taught = TAUGHT_RULE_ROWS.has(key.slice(key.indexOf(':') + 1));
  results.ai[key] = out.some((kept) => JSON.stringify(kept) === JSON.stringify(rule)) ? pass(taught ? undefined : ACCEPTED_NOT_TAUGHT) : fail(reached && stored ? 'ai-rule-refused' : gap);
}

/** A row the route owns: it is left red on purpose, whatever a node could hold. */
function probePageLevel(key: string): void {
  const note = 'applies to the document, which the route owns';
  results.format[key] = fail('page-level-css', note);
  results.renderer[key] = fail('page-level-css', note);
  results.ai[key] = fail('page-level-css', note);
}

/**
 * A row refused on purpose: red in every column, and only while it really is refused.
 * Should one reach the sheet or the generator, the cell says so instead of the gap.
 */
function probeTopLayer(probe: RuleProbe, key: string): void {
  const { rule } = probe;
  // Any of the probe's declaration in the sheet, not only the exact rule, counts as reaching it.
  const reached = stylesheetHasRule(renderPublished(ruleNode(rule)).css, probe) || renderPublished(ruleNode(rule)).css.includes(PROBE_COLOR);
  const generated = ((generate({ type: 'div', props: { rules: [rule] } }).node?.props.rules ?? []) as unknown[]).length > 0;
  const refused = (leaked: boolean) => (leaked ? fail('unclassified', 'a top layer rule reached the page') : fail('top-layer-refused', 'refused on purpose'));
  results.format[key] = refused(reached);
  results.renderer[key] = refused(reached);
  results.ai[key] = refused(generated);
}

/** The width media feature is the one part of @media a node holds: a responsive style map. */
function probeWidthMediaFeature(key: string): void {
  const style = { color: { base: 'red', tablet: 'blue' } };
  const stored = storedRoundTrip('div', { style });
  const tablet = stored.model.getResolvedProps('tablet', BREAKPOINTS).style.color;
  results.format[key] = tablet === 'blue' ? pass('as breakpoints, max-width only') : fail('media-queries');
  const { css } = renderPublished(styleNode(style));
  // A Tablet override sits just below Desktop's min width, see maxWidthBelow.
  const query = maxWidthBelow(BREAKPOINTS[0].minWidth).replace('.', '\\.');
  results.renderer[key] = new RegExp(`@media \\(max-width:${query}px\\)\\{\\s*\\.fc-probe\\.fc-probe\\{color:blue`).test(css)
    ? pass('as breakpoints, max-width only')
    : fail('media-queries');
  const made = generate({ type: 'div', props: { style: { color: { base: 'red', tablet: 'blue' } } } });
  const color = ((made.node?.props.style ?? {}) as Record<string, unknown>).color as Record<string, unknown> | undefined;
  results.ai[key] = color?.tablet === 'blue' ? pass('as breakpoints') : fail('media-queries');
}

function probe(entry: Entry): void {
  const key = rowKey(entry.kind, entry.id);
  if (entry.id === ':root') return probeRule(rootProbe(), key, 'page-level-css');
  if (isPageLevelRow(entry.id)) return probePageLevel(key);
  if (entry.kind === 'css-selector' && isTopLayerRow(entry.id)) return probeTopLayer(selectorProbe(entry.id, selectorSample(entry.id)), key);
  switch (entry.kind) {
    case 'html-element':
      return probeElement(entry.id, key);
    case 'html-global-attribute':
      return probeAttribute(entry.id, key);
    case 'html-element-attribute':
    case 'svg-attribute':
    case 'mathml-attribute':
      return probeElementAttribute(namespaceOf(entry.kind), entry.id, key);
    case 'html-event-handler':
      return probeEventHandler(entry.id, key);
    case 'svg-element':
    case 'mathml-element':
      return probeForeignElement(namespaceOf(entry.kind), entry.id, key);
    case 'css-property':
      return probeProperty(entry.id, key);
    case 'css-value':
      return probeCssValue(entry.id, key);
    case 'css-selector':
      return probeRule(
        selectorProbe(entry.id, selectorSample(entry.id)),
        key,
        'selector-styles',
        entry.id === ':hover' ? 'partial through a preset: three fixed hover effects, no authored rule' : undefined,
      );
    case 'css-at-rule':
      return probeRule(
        atRuleProbe(entry.id, atRuleSample(entry.id)),
        key,
        entry.id === '@media' ? 'media-queries' : 'at-rules',
        entry.id === '@media' ? 'partial through a preset: width breakpoints only (see the width media feature row)' : undefined,
      );
    case 'css-media-feature':
      if (entry.id === 'width') return probeWidthMediaFeature(key);
      return probeRule(wrapperProbe(`@media ${mediaFeatureSample(entry.id)}`), key, 'media-queries');
    case 'aria-pattern':
      return; // Run in a real browser: patterns.score.ts.
  }
}

describe('coverage matrix: format, published renderer, AI generator', () => {
  beforeAll(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('probes every included entry', () => {
    const entries = allEntries().filter((e) => !e.excluded);
    expect(entries.length).toBeGreaterThan(500);
    for (const entry of entries) probe(entry);
    writeOut('format', results.format);
    writeOut('renderer', results.renderer);
    writeOut('ai', results.ai);
  });
});
