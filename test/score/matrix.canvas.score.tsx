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
import { inlineStylesheets, ruleEncodings, stylesheetHasRule } from './lib/encodings';
import {
  allEntries,
  atRuleSample,
  attributeSample,
  mediaFeatureSample,
  selectorSample,
  styleKeyOf,
} from './lib/universe';
import { writeOut } from './lib/io';
import { rowKey, type Cell, type GapId, type SurfaceResults } from './lib/types';

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

function probeRule(rule: string, gap: GapId): Cell {
  const reached = ruleEncodings(rule).some((style) => stylesheetHasRule(inlineStylesheets(canvasMarkup('div', { style })), rule));
  return reached ? pass() : fail(gap);
}

function probeEntry(kind: string, id: string): Cell {
  switch (kind) {
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
      return probeRule(selectorSample(id), 'selector-styles');
    case 'css-at-rule':
      return probeRule(atRuleSample(id), id === '@media' ? 'media-queries' : 'at-rules');
    case 'css-media-feature': {
      if (id !== 'width') return probeRule(`@media ${mediaFeatureSample(id)}`, 'media-queries');
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
