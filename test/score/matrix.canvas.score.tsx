// Coverage matrix, canvas column: does the editor canvas show it? Each entry goes
// through the real ComponentRenderer (the component the canvas mounts, with a real
// root store), rendered to markup. Rendered to markup rather than into jsdom on
// purpose: jsdom's style object silently drops properties it does not know, which
// would score jsdom instead of the editor. Effects, drag and selection do not run
// in this render, so this answers "does it reach the DOM", nothing more.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { ComponentTypeEnum, default as ComponentModel, type ComponentInstance } from '@/models/ComponentModel';
import { cssPropertyName } from '@/lib/responsive/responsiveCss';
import { isBlockedTag } from '@/lib/renderer/blockedNodes';
import ComponentRenderer from '@/components/ComponentRenderer';
import {
  atRuleProbe,
  inlineStylesheets,
  isPageLevelRow,
  selectorProbe,
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
  type NodeShape,
} from './lib/universe';
import { writeOut } from './lib/io';
import { rowKey, type Cell, type GapId, type RowKind, type SurfaceResults } from './lib/types';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

const BREAKPOINTS = [
  { id: 'desktop', minWidth: 1280 },
  { id: 'tablet', minWidth: 768 },
  { id: 'mobile', minWidth: 320 },
];

const pass = (note?: string): Cell => ({ status: 'pass', ...(note ? { note } : {}) });
const fail = (gap: GapId, note?: string): Cell => ({ status: 'fail', gap, ...(note ? { note } : {}) });

function canvasMarkup(type: string, props: Record<string, unknown>, breakpointId = 'desktop'): string {
  const component = ComponentModel.create({ id: 'probe', type, componentType: ComponentTypeEnum.HOST, props }) as ComponentInstance;
  return renderToStaticMarkup(
    <ComponentRenderer component={component} breakpointId={breakpointId} allBreakpoints={BREAKPOINTS} />,
  );
}

const toSnapshot = (shape: NodeShape): Record<string, unknown> => ({
  id: shape.id,
  type: shape.type,
  componentType: ComponentTypeEnum.HOST,
  props: shape.props,
  children: (shape.children ?? []).map(toSnapshot),
});

function treeMarkup(shape: NodeShape): string {
  const component = ComponentModel.create(toSnapshot(shape)) as ComponentInstance;
  return renderToStaticMarkup(
    <ComponentRenderer component={component} breakpointId="desktop" allBreakpoints={BREAKPOINTS} />,
  );
}

function missingElement(tag: string): Cell {
  return isBlockedTag(tag) ? fail('blocked-embedded-content', 'dropped by blockedNodes.ts') : fail('unclassified', 'not on the canvas');
}

function probeElementAttribute(kind: RowKind, id: string): Cell {
  const namespace = namespaceOf(kind);
  const sample = markupAttributeSample(namespace, id);
  const html = treeMarkup(placed(namespace, sample.tag, { [sample.prop]: sample.value }));
  const tag = openingTag(html, sample.tag);
  if (!tag) return missingElement(sample.tag);
  const decoded = decodeEntities(tag).toLowerCase();
  if (decoded.includes(sample.html.toLowerCase())) return pass();
  // getResolvedProps sends a prop named like a CSS property into the style.
  if (decoded.includes(`${cssPropertyName(sample.prop)}:`)) {
    return namespace === 'html'
      ? fail('attribute-read-as-style')
      : pass('reaches the canvas as a style declaration, which SVG maps to the same property');
  }
  return fail('react-attribute-handling', `expected ${sample.html}`);
}

function probeRule(probe: RuleProbe, gap: GapId): Cell {
  return stylesheetHasRule(inlineStylesheets(canvasMarkup('div', { rules: [probe.rule] })), probe) ? pass() : fail(gap);
}

function probeEntry(kind: RowKind, id: string): Cell {
  if (isPageLevelRow(id)) return fail('page-level-css', 'applies to the document, which the route owns');
  switch (kind) {
    case 'html-element-attribute':
    case 'svg-attribute':
    case 'mathml-attribute':
      return probeElementAttribute(kind, id);
    case 'html-event-handler': {
      const camel = `on${id[2].toUpperCase()}${id.slice(3)}`;
      const reached = [id, camel].some((prop) => openingTag(canvasMarkup('div', { [prop]: 'probe()' }), 'div')?.includes(`${id}=`));
      return reached ? pass() : fail('blocked-event-handlers');
    }
    case 'svg-element':
    case 'mathml-element':
      return openingTag(treeMarkup(placed(namespaceOf(kind), id)), id) ? pass() : missingElement(id);
    case 'css-value': {
      const { property, value } = cssValueSample(id);
      return decodeEntities(canvasMarkup('div', { style: { [property]: value } })).includes(`${cssPropertyName(property)}:${value}`)
        ? pass()
        : fail('renderer-drops-value', 'the canvas lost the value');
    }
    case 'html-element': {
      const html = canvasMarkup(id, {});
      if (new RegExp(`<${id}[\\s>/]`).test(html)) return pass();
      return isBlockedTag(id) ? fail('blocked-embedded-content', 'dropped by blockedNodes.ts') : fail('unclassified', 'not on the canvas');
    }
    case 'html-global-attribute': {
      const sample = attributeSample(id);
      return canvasMarkup('div', { [sample.prop]: sample.value }).toLowerCase().includes(sample.html.toLowerCase())
        ? pass()
        : fail('react-attribute-handling', `expected ${sample.html}`);
    }
    case 'css-property': {
      const key = styleKeyOf(id);
      return canvasMarkup('div', { style: { [key]: 'initial' } }).includes(`${cssPropertyName(key)}:initial`)
        ? pass()
        : fail('renderer-drops-value', 'the canvas overwrites this property with its own value');
    }
    case 'css-selector':
      return probeRule(selectorProbe(id, selectorSample(id)), 'selector-styles');
    case 'css-at-rule':
      return probeRule(atRuleProbe(id, atRuleSample(id)), id === '@media' ? 'media-queries' : 'at-rules');
    case 'css-media-feature': {
      if (id !== 'width') return probeRule(wrapperProbe(`@media ${mediaFeatureSample(id)}`), 'media-queries');
      const style = { color: { base: 'red', tablet: 'blue' } };
      const shown = canvasMarkup('div', { style }, 'desktop').includes('color:red') && canvasMarkup('div', { style }, 'tablet').includes('color:blue');
      return shown ? pass('as breakpoints') : fail('media-queries');
    }
    default:
      throw new Error(`no canvas probe for ${kind}`);
  }
}

describe('coverage matrix: editor canvas', () => {
  it('probes every included entry through ComponentRenderer', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    store = createRootStore();
    const entries = allEntries().filter((e) => !e.excluded && e.kind !== 'aria-pattern');
    expect(entries.length).toBeGreaterThan(500);
    const results: SurfaceResults = {};
    for (const entry of entries) results[rowKey(entry.kind, entry.id)] = probeEntry(entry.kind, entry.id);
    writeOut('canvas', results);
  });
});
