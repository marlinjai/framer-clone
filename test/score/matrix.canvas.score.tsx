// Coverage matrix, canvas column: does the editor canvas show it? Each entry goes
// through the real ComponentRenderer (the component the canvas mounts, with a real
// root store), rendered to markup. Rendered to markup rather than into jsdom on
// purpose: jsdom's style object silently drops properties it does not know, which
// would score jsdom instead of the editor. Effects, drag and selection do not run
// in this render, so this answers "does it reach the DOM", nothing more.
//
// A rule row renders CanvasRuleStyles beside it, because that is what the canvas
// mounts. What such a row must find is written here, not imported from the code under
// test. canvasRules.score.ts proves on the mounted editor what that text then does.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { ComponentTypeEnum, default as ComponentModel, type ComponentInstance } from '@/models/ComponentModel';
import { cssPropertyName } from '@/lib/responsive/responsiveCss';
import { isBlockedTag } from '@/lib/renderer/blockedNodes';
import ComponentRenderer from '@/components/ComponentRenderer';
import { CanvasRuleStyles } from '@/lib/rules/CanvasRuleStyles';
import {
  atRuleProbe,
  inlineStylesheets,
  isPageLevelRow,
  rootProbe,
  normalize,
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

/** A frame every constant condition among the samples holds on: (min-height: 400px), 16 / 9, landscape. */
const PROBE_FRAME = { breakpointId: 'desktop', width: 1600, height: 900 };
/** What `&` becomes for the probe node in that frame. */
const COPY = '[data-viewport-content-id] [data-component-id="desktop-probe"]';
const DECLARED = '{color:rgb(1, 2, 3)!important}';

/** Pointer rows, as the sheet writes them unpreviewed and previewed. */
const POINTER_REWRITES: Record<string, { dead: string; live: string }> = Object.fromEntries(
  [':hover', ':active', ':focus', ':focus-visible', ':focus-within'].map((row) => [row, { dead: ':not(*, :hover)', live: ':is(*, :hover)' }]),
);

/** Media feature rows answered from the frame itself. The others describe the editor. */
const FRAME_FEATURES = new Set(['height', 'aspect-ratio', 'orientation']);

/** The canvas sheet for one stored rule, with that rule previewed or not. */
function canvasSheet(rule: RuleProbe['rule'], previewed: boolean): string {
  const component = ComponentModel.create({ id: 'probe', type: 'div', componentType: ComponentTypeEnum.HOST, props: { rules: [rule] } }) as ComponentInstance;
  store.editorUI.setPreviewRule(previewed ? { componentId: 'probe', ruleId: rule.id } : null);
  const html = renderToStaticMarkup(
    <>
      <CanvasRuleStyles tree={component} floating={[]} frames={[PROBE_FRAME]} breakpoints={BREAKPOINTS} />
      <ComponentRenderer component={component} breakpointId="desktop" allBreakpoints={BREAKPOINTS} />
    </>,
  );
  store.editorUI.setPreviewRule(null);
  return inlineStylesheets(html);
}

const holds = (css: string, text: string): boolean => normalize(css).includes(normalize(text));

function probeSelector(id: string, gap: GapId): Cell {
  const { rule } = selectorProbe(id, selectorSample(id));
  const selector = 'selector' in rule ? rule.selector : '';
  const at = 'selector' in rule ? (rule.at ?? []) : [];
  const pointer = POINTER_REWRITES[id];
  if (pointer) {
    const shown = holds(canvasSheet(rule, false), `${COPY}${pointer.dead}${DECLARED}`) && holds(canvasSheet(rule, true), `${COPY}${pointer.live}${DECLARED}`);
    return shown ? pass('dead until previewed') : fail(gap);
  }
  const parts = selector.split(/,(?![^(]*\))/).map((part) => part.trim().slice(1));
  // `:scope` needs an `@scope`, which reads what is above the node, so it waits for a preview.
  const sheet = canvasSheet(rule, at.length > 0);
  return parts.every((part) => holds(sheet, `${COPY}${part}${DECLARED}`)) ? pass(at.length > 0 ? 'dead until previewed' : undefined) : fail(gap);
}

/** An environment condition shows only when previewed, and then with its wrapper gone. */
function probeEnvironment(at: string, gap: GapId): Cell {
  const { rule } = wrapperProbe(at);
  const body = `${COPY}${DECLARED}`;
  return !holds(canvasSheet(rule, false), body) && holds(canvasSheet(rule, true), body) ? pass('dead until previewed') : fail(gap);
}

/** A condition the frame answers: the block is there, with no query around it. */
function probeFrameCondition(at: string, gap: GapId): Cell {
  const css = canvasSheet(wrapperProbe(at).rule, false);
  return holds(css, `${COPY}${DECLARED}`) && !css.includes('@media') ? pass('answered by the frame') : fail(gap);
}

function probeAtRule(id: string, gap: GapId): Cell {
  // An `@scope` prelude is matched above the node, which is the editor here.
  if (id === '@media' || id === '@scope') return probeEnvironment(atRuleSample(id), gap);
  const probe = atRuleProbe(id, atRuleSample(id));
  const css = canvasSheet(probe.rule, false);
  if ('define' in probe.rule) return stylesheetHasRule(css, probe) ? pass() : fail(gap);
  return holds(css, `${atRuleSample(id)}{${COPY}${DECLARED}`) ? pass() : fail(gap);
}

function probeEntry(kind: RowKind, id: string): Cell {
  if (id === ':root') return holds(canvasSheet(rootProbe().rule, false), `${COPY}${DECLARED}`) ? pass('on the page root of each frame') : fail('page-level-css');
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
      return probeSelector(id, 'selector-styles');
    case 'css-at-rule':
      return probeAtRule(id, id === '@media' ? 'media-queries' : 'at-rules');
    case 'css-media-feature': {
      const at = `@media ${mediaFeatureSample(id)}`;
      if (FRAME_FEATURES.has(id)) return probeFrameCondition(at, 'media-queries');
      if (id !== 'width') return probeEnvironment(at, 'media-queries');
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
