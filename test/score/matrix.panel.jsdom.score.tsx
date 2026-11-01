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

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { applySnapshot, getSnapshot, isAlive } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import RightSidebar from '@/components/sidebars/RightSidebar';
import { allEntries, attributeSample, markupAttributeSample, namespaceOf, styleKeyOf } from './lib/universe';
import { writeOut } from './lib/io';
import { rowKey, type Cell, type GapId, type SurfaceResults } from './lib/types';

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

function record(before: Record<string, unknown>, after: Record<string, unknown>, onBreakpoint: boolean): void {
  if (before.type !== after.type) written.types.add(String(after.type));
  const beforeProps = (before.props ?? {}) as Record<string, unknown>;
  const afterProps = (after.props ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(beforeProps), ...Object.keys(afterProps)])) {
    if (key === 'style') continue;
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
    const map = afterStyle[key];
    for (const value of map && typeof map === 'object' ? Object.values(map) : [map]) written.styleValues.add(String(value));
    if (onBreakpoint && map && typeof map === 'object' && 'tablet-probe' in map) written.breakpointOverride = true;
  }
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
 * row needs a control that takes free text, which no action here proves, so it
 * stays a fail with the panel's general editor gap.
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

async function operate(el: Element, node: ComponentInstance, onBreakpoint: boolean): Promise<void> {
  const step = async (fn: () => void) => {
    if (!isAlive(node)) return;
    const before = JSON.parse(JSON.stringify(getSnapshot(node)));
    await act(async () => {
      fn();
      await Promise.resolve();
    });
    if (isAlive(node)) record(before, JSON.parse(JSON.stringify(getSnapshot(node))), onBreakpoint);
  };

  if (el instanceof HTMLSelectElement) {
    for (const option of Array.from(el.options)) {
      if (!option.value) continue;
      await step(() => fireEvent.change(el, { target: { value: option.value } }));
    }
    return;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
      await step(() => fireEvent.click(el));
      return;
    }
    if (el instanceof HTMLInputElement && el.type === 'file') return;
    const tries = el instanceof HTMLInputElement && el.type === 'color' ? ['#123456'] : TEXT_TRIES;
    for (const value of tries) {
      // Separate steps: a field commits from its own state on Enter or blur,
      // so the change has to render before the commit reads it.
      await step(() => fireEvent.focus(el));
      await step(() => fireEvent.change(el, { target: { value } }));
      await step(() => fireEvent.keyDown(el, { key: 'Enter' }));
      await step(() => fireEvent.blur(el));
    }
    return;
  }
  // An open section stays open: closing it would hide the controls still to be operated.
  if (el.getAttribute('aria-expanded') === 'true') return;
  await step(() => fireEvent.click(el));
}

async function drive(scenario: Scenario, breakpointId?: string): Promise<void> {
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
    );
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
  view.unmount();
  cleanup();
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

    for (const scenario of SCENARIOS) await drive(scenario);
    await drive(SCENARIOS[0], 'tablet-probe');

    const referenced = referencedStyleKeys();
    const paletteTags = new Set(Object.values(COMPONENT_REGISTRY).map((entry) => entry.htmlType as string));
    const results: SurfaceResults = {};
    const anyStyle = written.styleKeys.size > 0;

    for (const entry of allEntries().filter((e) => !e.excluded && e.kind !== 'aria-pattern')) {
      const key = rowKey(entry.kind, entry.id);
      switch (entry.kind) {
        case 'html-element':
          if (paletteTags.has(entry.id)) results[key] = pass('placed from the palette');
          else if (written.types.has(entry.id)) results[key] = pass('a panel action set this tag');
          else results[key] = fail('panel-no-tag-choice');
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
          results[key] = namespace === 'html' && written.propsOnTag.has(`${tag}.${prop}`) ? pass() : fail('panel-no-general-editor');
          break;
        }
        case 'html-event-handler':
          results[key] = fail('blocked-event-handlers');
          break;
        case 'svg-element':
        case 'mathml-element':
          results[key] = fail('panel-no-tag-choice');
          break;
        case 'css-value': {
          const tried = VALUE_ROW_TRY[entry.id];
          results[key] = tried && written.styleValues.has(tried)
            ? pass(`a control wrote ${tried}`)
            : fail('panel-no-general-editor', 'no control wrote a value of this kind');
          break;
        }
        case 'css-selector':
          results[key] = fail(
            'selector-styles',
            entry.id === ':hover' ? 'partial through a preset: the Effects section offers three hover effects' : undefined,
          );
          break;
        case 'css-at-rule':
          results[key] = fail(entry.id === '@media' ? 'media-queries' : 'at-rules');
          break;
        case 'css-media-feature':
          results[key] = entry.id === 'width' && written.breakpointOverride ? pass('as breakpoints') : fail('media-queries');
          break;
      }
    }

    expect(written.styleKeys.size).toBeGreaterThan(10);
    writeOut('panel', results);
    writeOut('panel-detail', {
      scenarios: SCENARIOS.map((s) => s.label),
      styleKeysWritten: [...written.styleKeys].sort(),
      propKeysWritten: [...written.propKeys].sort(),
      typesWritten: [...written.types].sort(),
      referencedNotDriven: [...referenced].filter((k) => !written.styleKeys.has(k)).sort(),
      paletteTags: [...paletteTags].sort(),
    });
  });
});
