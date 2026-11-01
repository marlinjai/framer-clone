// Coverage matrix, three columns in one pass: the format stores it, the published
// renderer emits it, the AI generator can produce it. A cell is decided by what
// the real code does with the entry, and a failure here is a result, not a test
// failure: only an exception in the harness fails this file.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ComponentModel, { ComponentTypeEnum } from '@/models/ComponentModel';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { cssPropertyName } from '@/lib/responsive/responsiveCss';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { isBlockedTag } from '@/lib/renderer/blockedNodes';
import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { BREAKPOINTS, renderPublished } from './lib/published';
import { ruleEncodings, ruleNode, stylesheetHasRule } from './lib/encodings';
import {
  allEntries,
  atRuleSample,
  attributeSample,
  mediaFeatureSample,
  selectorSample,
  styleKeyOf,
} from './lib/universe';
import { writeOut } from './lib/io';
import { rowKey, type Cell, type Entry, type GapId, type SurfaceResults } from './lib/types';

const pass = (note?: string): Cell => ({ status: 'pass', ...(note ? { note } : {}) });
const fail = (gap: GapId, note?: string): Cell => ({ status: 'fail', gap, ...(note ? { note } : {}) });

/** Created, snapshotted, sent through JSON and created again, as a save and load does. */
function storedRoundTrip(type: string, props: Record<string, unknown>) {
  const first = ComponentModel.create({ id: 'probe', type, componentType: ComponentTypeEnum.HOST, props });
  const reloaded = ComponentModel.create(JSON.parse(JSON.stringify(getSnapshot(first))));
  return { model: reloaded, resolved: reloaded.getResolvedProps('', []) as { attributes: Record<string, unknown>; style: Record<string, unknown> } };
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

function probeRule(rule: string, key: string, gap: GapId, presetNote?: string): void {
  const encodings = ruleEncodings(rule);
  const reached = encodings.some((style) => stylesheetHasRule(renderPublished(ruleNode(style)).css, rule));

  // Bytes alone prove nothing here (props are opaque JSON and hold anything), so
  // storing a rule counts only when a reader gives it a meaning.
  results.format[key] = reached ? pass() : fail(gap, presetNote ?? 'the format has no slot for a rule');
  results.renderer[key] = reached ? pass() : fail(gap, presetNote);

  const kept = encodings.some((style) => {
    const made = generate({ type: 'div', props: { style } });
    const out = (made.node?.props.style ?? {}) as Record<string, unknown>;
    return rule in out || (typeof out.color === 'object' && out.color !== null && rule in out.color);
  });
  results.ai[key] = kept ? pass() : fail(gap);
}

/** The width media feature is the one part of @media a node holds: a responsive style map. */
function probeWidthMediaFeature(key: string): void {
  const style = { color: { base: 'red', tablet: 'blue' } };
  const stored = storedRoundTrip('div', { style });
  const tablet = stored.model.getResolvedProps('tablet', BREAKPOINTS).style.color;
  results.format[key] = tablet === 'blue' ? pass('as breakpoints, max-width only') : fail('media-queries');
  const { css } = renderPublished(ruleNode(style));
  results.renderer[key] = /@media \(max-width:767\.98px\)\{\s*\.fc-probe\.fc-probe\{color:blue/.test(css)
    ? pass('as breakpoints, max-width only')
    : fail('media-queries');
  const made = generate({ type: 'div', props: { style: { color: { base: 'red', tablet: 'blue' } } } });
  const color = ((made.node?.props.style ?? {}) as Record<string, unknown>).color as Record<string, unknown> | undefined;
  results.ai[key] = color?.tablet === 'blue' ? pass('as breakpoints') : fail('media-queries');
}

function probe(entry: Entry): void {
  const key = rowKey(entry.kind, entry.id);
  switch (entry.kind) {
    case 'html-element':
      return probeElement(entry.id, key);
    case 'html-global-attribute':
      return probeAttribute(entry.id, key);
    case 'css-property':
      return probeProperty(entry.id, key);
    case 'css-selector':
      return probeRule(
        selectorSample(entry.id),
        key,
        'selector-styles',
        entry.id === ':hover' ? 'partial through a preset: three fixed hover effects, no authored rule' : undefined,
      );
    case 'css-at-rule':
      return probeRule(
        atRuleSample(entry.id),
        key,
        entry.id === '@media' ? 'media-queries' : 'at-rules',
        entry.id === '@media' ? 'partial through a preset: width breakpoints only (see the width media feature row)' : undefined,
      );
    case 'css-media-feature':
      if (entry.id === 'width') return probeWidthMediaFeature(key);
      return probeRule(`@media ${mediaFeatureSample(entry.id)}`, key, 'media-queries');
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
