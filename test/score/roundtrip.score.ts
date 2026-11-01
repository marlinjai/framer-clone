// The round trip, both ways. Nodes to JSX to nodes must give the same normalised
// nodes, over every tree the corpus and the patterns use, every registry preset and
// a few synthetic nodes for what those miss. JSX to nodes must render what the JSX
// renders, or say line by line what it could not convert. A construct that cannot
// make the trip is a failure and a named gap: this is an expressiveness test too.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { FIXTURES } from './corpus/fixtures';
import { PATTERNS } from './patterns';
import { renderPublished } from './lib/published';
import { jsxToNodes, nodesToJsx, normalise } from './roundtrip/jsx';
import { writeOut } from './lib/io';
import type { GapId, RoundTripCase } from './lib/types';

const SYNTHETIC: Array<{ id: string; node: ComponentNode }> = [
  { id: 'responsive style map', node: { type: 'div', props: { style: { padding: { base: '8px', tablet: '4px' } } } as never } },
  { id: 'responsive attribute', node: { type: 'img', props: { src: { base: '/a.jpg', tablet: '/b.jpg' }, alt: 'x' } as never } },
  { id: 'read binding', node: { type: 'p', props: { children: 'Fallback' } as never, bindings: { children: { mode: 'read', path: 'row.title' } } as never } },
  { id: 'effects', node: { type: 'div', props: { effects: { appear: { kind: 'fade' }, hover: 'lift' } } as never } },
  { id: 'void element', node: { type: 'hr', props: {} } },
  { id: 'text with awkward characters', node: { type: 'p', props: { children: 'a < b & "c" {d}\nnext line' } as never } },
  { id: 'text with outer spaces', node: { type: 'span', props: { children: '  spaced  ' } as never } },
  { id: 'empty string text', node: { type: 'p', props: { children: '' } as never } },
  { id: 'number text', node: { type: 'p', props: { children: 42 } as never } },
  { id: 'custom element', node: { type: 'my-widget', props: { 'data-x': '1' } as never } },
  { id: 'svg child', node: { type: 'svg', props: { viewBox: '0 0 10 10' } as never, children: [{ type: 'circle', props: { r: 5 } as never }] } },
];

/** Must be refused, not converted: the plan's rule for an island nobody recognises. */
const MUST_REFUSE: Array<{ id: string; node: ComponentNode }> = [
  { id: 'unknown island', node: { type: 'div', props: { 'data-component-kind': 'not-a-real-kind' } as never } },
  { id: 'a function prop', node: { type: 'div', props: { onClick: () => {} } as never } },
];

const JSX_CASES: Array<{ id: string; jsx: string }> = [
  { id: 'static markup', jsx: `<section style={{ padding: 16 }}><h1>Title</h1><p className="lead">Copy</p></section>` },
  { id: 'attributes', jsx: `<a href="/x" aria-label="Go" data-track="1" target="_blank">Link</a>` },
  { id: 'void and booleans', jsx: `<div><input disabled type="text" /><hr /></div>` },
  { id: 'multi-line text', jsx: `<p>\n  One line\n  and another\n</p>` },
  { id: 'text before an element', jsx: `<p>Hello <b>bold</b></p>` },
  { id: 'text after an element', jsx: `<p>Hello <b>bold</b> world</p>` },
  { id: 'a condition', jsx: `true && <p>Shown</p>` },
  { id: 'a loop', jsx: `<ul>{[1, 2].map((n) => <li key={n}>{n}</li>)}</ul>` },
  { id: 'an event handler', jsx: `<button onClick={() => {}}>Go</button>` },
  { id: 'spread props', jsx: `<div {...{ id: 'x' }}>Hi</div>` },
  { id: 'an unknown component', jsx: `<Card title="Hi" />` },
  { id: 'a computed class', jsx: `<div className={['a', 'b'].join(' ')}>Hi</div>` },
];

/** What React makes of the JSX, as the reference: compiled, not parsed by the importer. */
function renderJsx(jsx: string): string {
  const code = ts.transpileModule(`module.exports = (${jsx});`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const result = { exports: {} as React.ReactNode };
  new Function('React', 'module', 'Card', code)(React, result, () => null);
  return renderToStaticMarkup(React.createElement(React.Fragment, null, result.exports));
}

function nodesCase(id: string, node: ComponentNode): RoundTripCase {
  const base = { id, direction: 'nodes-jsx-nodes' as const };
  let jsx: string;
  try {
    jsx = nodesToJsx(node);
  } catch (error) {
    return { ...base, pass: false, gap: 'roundtrip-not-representable', detail: error instanceof Error ? error.message : String(error) };
  }
  const imported = jsxToNodes(jsx);
  if (!imported.node || imported.leftOver.length > 0) {
    return { ...base, pass: false, gap: 'roundtrip-not-representable', detail: 'not imported', leftOver: imported.leftOver };
  }
  const before = JSON.stringify(normalise(node));
  const after = JSON.stringify(normalise(imported.node));
  if (before === after) return { ...base, pass: true };
  return { ...base, pass: false, gap: 'roundtrip-not-representable', detail: `${before.slice(0, 160)} became ${after.slice(0, 160)}` };
}

function jsxCase(id: string, jsx: string): RoundTripCase {
  const base = { id, direction: 'jsx-nodes-render' as const };
  const imported = jsxToNodes(jsx);
  const gap: GapId = imported.mixedText ? 'mixed-text' : 'import-dynamic-logic';
  if (!imported.node || imported.leftOver.length > 0) {
    return { ...base, pass: false, gap, detail: 'reported as left over', leftOver: imported.leftOver };
  }
  const reference = renderJsx(jsx).toLowerCase();
  const rendered = renderPublished(imported.node).html.toLowerCase();
  // And back: the exported JSX must render the same as well.
  const backAgain = renderJsx(nodesToJsx(imported.node)).toLowerCase();
  if (rendered === reference && backAgain === reference) return { ...base, pass: true };
  const silent: GapId = /text|<b>/.test(jsx) ? 'mixed-text' : 'unclassified';
  return { ...base, pass: false, gap: silent, detail: `rendered ${rendered.slice(0, 120)}, expected ${reference.slice(0, 120)}` };
}

describe('round trip', () => {
  it('runs both directions over every case', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cases: RoundTripCase[] = [];
    for (const fixture of FIXTURES) cases.push(nodesCase(`corpus: ${fixture.id}`, fixture.tree()));
    for (const pattern of PATTERNS) cases.push(nodesCase(`pattern: ${pattern.id}`, pattern.tree()));
    for (const entry of Object.values(COMPONENT_REGISTRY)) {
      cases.push(nodesCase(`preset: ${entry.id}`, { type: entry.htmlType, props: entry.defaultProps as never }));
    }
    for (const { id, node } of SYNTHETIC) cases.push(nodesCase(`synthetic: ${id}`, node));
    for (const { id, node } of MUST_REFUSE) {
      let refused = false;
      try {
        nodesToJsx(node);
      } catch {
        refused = true;
      }
      cases.push({ id: `refused: ${id}`, direction: 'nodes-jsx-nodes', pass: refused, ...(refused ? {} : { gap: 'unclassified', detail: 'converted without a report' }) });
    }
    for (const { id, jsx } of JSX_CASES) cases.push(jsxCase(id, jsx));
    expect(cases.length).toBeGreaterThan(40);
    writeOut('roundtrip', cases);
  });
});
