// The round trip, both ways. Nodes to JSX to nodes must give the same normalised
// nodes, over every tree the corpus and the patterns use, every registry preset and
// a few synthetic nodes for what those miss. JSX to nodes must render what the JSX
// renders, or say line by line what it could not convert. A construct that cannot
// make the trip is a failure and a named gap: this is an expressiveness test too.
//
// A list of rules is JSON, so it would survive whether or not it means anything. So a
// tree with rules must also publish the same page after the trip, a rule case must
// reach the sheet, and a refused rule must come back reported, not carried. JSX to
// render has no rule case but the reports: its reference is React, which has no sheet,
// and the real emission of one CSS block is step 7 of the complete primitives plan.
//
// Behaviour is JSON too, and it names nodes by id. So a tree with behaviour publishes the
// same page and the same program after the trip, a behaviour case must reach the page, and
// a refused entry must come back reported and left out, never carried and never lost with
// its neighbours. Import of hooks (`useState` and the rest) is step 7's.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { renderToStaticMarkup } from 'react-dom/server';
import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { FORM_KIND_ATTR } from '@/lib/forms/definition';
import { HOVER_GATE } from '@/lib/rules/states';
import { applyBehaviour } from '@/lib/renderer/server/applyBehaviour';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { FIXTURES } from './corpus/fixtures';
import { PATTERNS, n, run, t } from './patterns';
import { renderPublished } from './lib/published';
import { jsxToNodes, nodesToJsx, normalise, withPlaceIds } from './roundtrip/jsx';
import { writeOut } from './lib/io';
import type { GapId, RoundTripCase } from './lib/types';

const SYNTHETIC: Array<{ id: string; node: ComponentNode }> = [
  { id: 'responsive style map', node: { type: 'div', props: { style: { padding: { base: '8px', tablet: '4px' } } } as never } },
  { id: 'responsive attribute', node: { type: 'img', props: { src: { base: '/a.jpg', tablet: '/b.jpg' }, alt: 'x' } as never } },
  { id: 'read binding', node: { type: 'p', props: { children: 'Fallback' } as never, bindings: { children: { mode: 'read', path: 'row.title' } } as never } },
  { id: 'effects', node: { type: 'div', props: { effects: { appear: { kind: 'fade' }, hover: 'lift' } } as never } },
  { id: 'void element', node: { type: 'hr', props: {} } },
  { id: 'text mixed with an element', node: n('p', {}, run('Hello '), t('b', 'bold'), run(' world')) },
  { id: 'adjacent text nodes', node: n('p', {}, run('one'), run('two')) },
  { id: 'text mixed with a bound text node', node: n('p', {}, run('Hi '), { type: '#text', props: { children: 'Fallback' } as never, bindings: { children: { mode: 'read', path: 'row.title' } } as never }, t('b', 'x')) },
  { id: 'text with awkward characters', node: { type: 'p', props: { children: 'a < b & "c" {d}\nnext line' } as never } },
  { id: 'text with outer spaces', node: { type: 'span', props: { children: '  spaced  ' } as never } },
  { id: 'empty string text', node: { type: 'p', props: { children: '' } as never } },
  { id: 'number text', node: { type: 'p', props: { children: 42 } as never } },
  { id: 'custom element', node: { type: 'my-widget', props: { 'data-x': '1' } as never } },
  { id: 'svg child', node: { type: 'svg', props: { viewBox: '0 0 10 10' } as never, children: [{ type: 'circle', props: { r: 5 } as never }] } },
];

const FADE_IN = { id: 'fade', define: '@keyframes u-fade', blocks: [{ selector: 'from', style: { opacity: 0 } }, { selector: '50%', style: { opacity: 0.5 } }, { selector: 'to', style: { opacity: 1 } }] };

/** `sheet`: what the published page must hold, written here and not read from the code under test. */
const RULE_CASES: Array<{ id: string; node: ComponentNode; sheet: RegExp[] }> = [
  {
    id: 'a state with a breakpoint map',
    node: { type: 'button', props: { children: 'Go', rules: [{ id: 'hover', selector: '&:hover', at: [HOVER_GATE], style: { color: { base: '#111111', tablet: '#222222' } } }] } as never },
    sheet: [/@media \(hover:hover\) and \(pointer:fine\)/, /:hover[^}]*#111111/, /max-width:1279\.98px[^]*:hover[^}]*#222222/],
  },
  {
    id: 'a wrapper around a breakpoint map',
    node: { type: 'div', props: { rules: [{ id: 'dark', selector: '& > li', at: ['@media (prefers-color-scheme: dark)', '@supports (display: grid)'], style: { padding: { base: '8px', tablet: 0 }, order: -1 } }] } as never },
    sheet: [/prefers-color-scheme: ?dark/, /@supports/, /padding:8px/, /order:-1/],
  },
  {
    id: 'a definition and the rule that uses it',
    node: { type: 'div', props: { rules: [FADE_IN, { id: 'run', selector: '&', style: { animation: 'u-fade 1s' } }] } as never },
    sheet: [/@keyframes u-fade/, /50%\{opacity:0\.5/, /animation:u-fade 1s/],
  },
  {
    id: 'two faces of one family',
    node: {
      type: 'div',
      props: {
        rules: [
          { id: 'regular', define: '@font-face', style: { fontFamily: 'u-brand', src: 'url(/regular.woff2)', fontWeight: 400 } },
          { id: 'bold', define: '@font-face', style: { fontFamily: 'u-brand', src: 'url(/bold.woff2)', fontWeight: 700 } },
        ],
      } as never,
    },
    sheet: [/regular\.woff2[^]*bold\.woff2/],
  },
  {
    id: 'a custom property syntax in angle brackets',
    node: { type: 'div', props: { rules: [{ id: 'gap', define: '@property --u-gap', style: { syntax: '"<length>"', inherits: 'false', initialValue: '4px' } }] } as never },
    sheet: [/@property --u-gap/],
  },
  {
    id: 'the order of rules and of declarations',
    node: {
      type: 'div',
      props: {
        rules: [
          { id: 'first', selector: '&:hover', style: { padding: '1px', paddingTop: '2px' } },
          { id: 'second', selector: '&:hover', style: { paddingTop: '3px', padding: '4px' } },
        ],
      } as never,
    },
    sheet: [/padding:1px;padding-top:2px[^]*padding-top:3px;padding:4px/],
  },
  {
    id: 'awkward text in a rule',
    node: {
      type: 'blockquote',
      props: {
        rules: [
          { id: 'mark', selector: '&::before', style: { content: '"\u201C"' } },
          { id: 'tag', selector: '&[data-kind="a b"]::after', style: { content: '"</style> & x"' } },
        ],
      } as never,
    },
    sheet: [/\u201C/, /data-kind="a b"/],
  },
  {
    id: 'a rule reading state above its node',
    node: {
      type: 'div',
      props: { behaviour: { state: [{ id: 'open', name: 'Open', type: 'boolean', initial: false }] } } as never,
      children: [{ type: 'p', props: { children: 'x', rules: [{ id: 'shown', selector: '&', when: { state: 'open', eq: true }, style: { color: '#123456' } }] } as never }],
    },
    sheet: [/data-fcs-open[^}]*#123456/],
  },
  {
    id: 'rules on an island and on its child',
    node: {
      type: 'div',
      props: { [FORM_KIND_ATTR]: 'form', rules: [{ id: 'own', selector: '&:focus-within', style: { outline: '1px solid #123456' } }] } as never,
      children: [{ type: 'p', props: { children: 'x', rules: [FADE_IN] } as never }],
    },
    sheet: [/:focus-within[^}]*#123456/, /@keyframes u-fade/],
  },
  { id: 'the table attribute of the same name', node: { type: 'table', props: { rules: 'all' } as never }, sheet: [/<table[^>]* rules="all"/] },
  { id: 'an empty list', node: { type: 'div', props: { rules: [] } as never }, sheet: [] },
];

/** Between two good rules, so a pass also proves the rest of the list stands, in order. */
const REFUSED_RULES: Array<{ id: string; rule: unknown; reason: RegExp }> = [
  { id: 'a selector outside the node', rule: { id: 'bad', selector: 'body', style: { color: 'red' } }, reason: /every part of a selector starts with &/ },
  { id: 'a wrapper that is no condition', rule: { id: 'bad', selector: '&', at: ['@layer base'], style: { color: 'red' } }, reason: /@layer/ },
  { id: 'an external address', rule: { id: 'bad', selector: '&', style: { backgroundImage: 'url(https://example.test/a.png)' } }, reason: /address/ },
  { id: 'a breakpoint map in a keyframe', rule: { id: 'bad', define: '@keyframes u-map', blocks: [{ selector: 'from', style: { opacity: { base: 0, tablet: 1 } } }] }, reason: /no breakpoints/ },
  { id: 'a breakpoint map in a descriptor', rule: { id: 'bad', define: '@font-face', style: { fontFamily: 'u-map', src: 'url(/a.woff2)', fontWeight: { base: 400, tablet: 700 } } }, reason: /no breakpoints/ },
  { id: 'a definition in a wrapper', rule: { id: 'bad', define: '@keyframes u-at', at: ['@media print'], blocks: [{ selector: 'from', style: { opacity: 0 } }] }, reason: /no wrapper/ },
  { id: 'a key that assignment would lose', rule: JSON.parse('{"id":"bad","selector":"&","style":{"__proto__":"red"}}'), reason: /__proto__ is not a property name/ },
  { id: 'a condition with no state in reach', rule: { id: 'bad', selector: '&', when: { state: 'open', eq: true }, style: { color: 'red' } }, reason: /no state is in reach/ },
  { id: 'an uncompiled component state', rule: { id: 'bad', selector: '&', componentState: 'open', style: { color: 'red' } }, reason: /not been compiled/ },
  { id: 'a repeated id', rule: { id: 'before', selector: '&', style: { color: 'red' } }, reason: /same id/ },
];

/** JSX with a `rules` the format cannot hold: the report is the pass. */
const REPORTED_JSX: Array<{ id: string; jsx: string; line: RegExp }> = [
  { id: 'a refused rule written in JSX', jsx: `<div rules={[{ id: 'bad', selector: 'body', style: { color: 'red' } }]}>x</div>`, line: /refused rule bad: every part of a selector starts with &/ },
  { id: 'an entry that is no rule', jsx: `<div rules={['&:hover']}>x</div>`, line: /refused rule #0: a rule is an object/ },
  { id: 'rules that are not a list', jsx: `<div rules={{ id: 'r', selector: '&' }}>x</div>`, line: /neither a list nor a table attribute/ },
  { id: 'rules with no value', jsx: `<div rules>x</div>`, line: /neither a list nor a table attribute/ },
  { id: 'rules on a text run', jsx: `<p><TextRun rules={[{ id: 'r', selector: '&', style: {} }]}>{"x"}</TextRun></p>`, line: /rules on a text node/ },
];

/** A behaviour with one bad entry, beside entries that stand: `KEPT_BEHAVIOUR` is what must come back. */
const OPEN_STATE = { id: 'host-open', name: 'Open', type: 'boolean', initial: false };
const PRESS = { id: 'before', on: 'click', do: [{ toggle: 'host-open' }] };
const ESCAPE = { id: 'after', on: 'keydown', keys: ['Escape'], do: [{ set: 'host-open', value: false }] };
const KEPT_BEHAVIOUR = { state: [OPEN_STATE], on: [PRESS, ESCAPE] };
const withBadTrigger = (bad: unknown) => ({ state: [OPEN_STATE], on: [PRESS, bad, ESCAPE] });

/** `page`: what the published page and its program must hold, written here and not read from the code under test. */
const BEHAVIOUR_CASES: Array<{ id: string; node: ComponentNode; page: RegExp[] }> = [
  {
    id: 'a state',
    node: {
      id: 'acc',
      type: 'div',
      props: { behaviour: { state: [{ id: 'acc-open', name: 'Open', type: 'boolean', initial: true }, { id: 'acc-tab', name: 'Tab', type: 'choice', initial: 'one', options: ['one', 'two'] }] } } as never,
      children: [{ type: 'p', props: { children: 'x' } as never }],
    },
    page: [/data-fcs-acc-open="true"/, /data-fcs-acc-tab="one"/],
  },
  {
    id: 'a trigger naming another node',
    node: {
      id: 'disc',
      type: 'div',
      props: { behaviour: { state: [{ id: 'disc-open', name: 'Open', type: 'boolean', initial: false }] } } as never,
      children: [
        {
          id: 'disc-button',
          type: 'button',
          props: {
            type: 'button',
            children: 'More',
            behaviour: {
              on: [{ id: 'press', on: 'click', do: [{ toggle: 'disc-open' }, { focus: 'disc-target' }] }],
              bind: [{ attr: 'aria-expanded', from: { get: 'disc-open' } }],
            },
          } as never,
        },
        { id: 'disc-panel', type: 'div', props: { children: 'Panel', behaviour: { showWhen: { state: 'disc-open', eq: true } } } as never },
        // Named by the trigger and holding no behaviour: only `nodeId` carries its id.
        { id: 'disc-target', type: 'a', props: { href: '#more', children: 'Read on' } as never },
      ],
    },
    page: [/data-fc-n="disc-button"/, /aria-expanded="false"/, /data-fc-n="disc-target"/, /"disc-target"/],
  },
  {
    // The carried id is what another node's place would be: neither may take the other's key.
    id: 'an id that is also a place',
    node: {
      type: 'div',
      props: {} as never,
      children: [
        { type: 'p', props: { children: 'first' } as never },
        { id: 'n-0', type: 'button', props: { type: 'button', children: 'Go', behaviour: { state: [OPEN_STATE], on: [PRESS] } } as never },
      ],
    },
    page: [/<button[^>]*data-fc-n="n-0"/, /<p>first<\/p>/],
  },
];

const REFUSED_BEHAVIOUR: Array<{ id: string; behaviour: Record<string, unknown>; reason: RegExp }> = [
  { id: 'a trigger naming no node', behaviour: withBadTrigger({ id: 'bad', on: 'click', do: [{ focus: 'ghost' }] }), reason: /ghost/ },
  { id: 'a trigger on state not in reach', behaviour: withBadTrigger({ id: 'bad', on: 'click', do: [{ toggle: 'elsewhere' }] }), reason: /elsewhere/ },
  { id: 'a binding inside behaviour', behaviour: withBadTrigger({ id: 'bad', on: 'click', do: [{ set: 'host-open', value: '{{row.title}}' }] }), reason: /a \{\{binding\}\} cannot stand inside behaviour/ },
  { id: 'an event that is not one', behaviour: withBadTrigger({ id: 'bad', on: 'not-an-event', do: [{ toggle: 'host-open' }] }), reason: /not-an-event/ },
  { id: 'navigation to a script address', behaviour: withBadTrigger({ id: 'bad', on: 'click', do: [{ navigate: 'javascript:alert(1)' }] }), reason: /navigate needs a safe literal address/ },
  { id: 'navigation on no press', behaviour: withBadTrigger({ id: 'bad', on: 'focus', do: [{ navigate: '/next' }] }), reason: /navigate runs only from/ },
  { id: 'a repeated trigger id', behaviour: withBadTrigger({ ...PRESS, do: [{ toggle: 'host-open' }, { toggle: 'host-open' }] }), reason: /same id/ },
  { id: 'a state declared twice', behaviour: { ...KEPT_BEHAVIOUR, state: [OPEN_STATE, { ...OPEN_STATE, initial: true }] }, reason: /declared twice/ },
  { id: 'a field the format does not have', behaviour: { ...KEPT_BEHAVIOUR, onClick: 'alert(1)' }, reason: /onClick is not a behaviour field/ },
  { id: 'noScript that is neither', behaviour: { ...KEPT_BEHAVIOUR, noScript: 'maybe' }, reason: /noScript is show or hide/ },
];

/** JSX whose behaviour, or the id it names, the format cannot hold: the report is the pass. */
const REPORTED_BEHAVIOUR_JSX: Array<{ id: string; jsx: string; line: RegExp }> = [
  { id: 'behaviour that is no object', jsx: `<button behaviour="toggle">Go</button>`, line: /refused behaviour on <button>: behaviour is an object/ },
  { id: 'triggers that are not a list', jsx: `<button behaviour={{ on: { id: 't', on: 'click', do: [] } }}>Go</button>`, line: /refused behaviour on on <button>: on is a list/ },
  { id: 'behaviour on a text run', jsx: `<p><TextRun behaviour={{ state: [{ id: 's', name: 'S', type: 'boolean', initial: false }] }}>{"x"}</TextRun></p>`, line: /no element of its own/ },
  { id: 'a node named but not carried', jsx: `<div><button behaviour={{ on: [{ id: 't', on: 'click', do: [{ focus: 'panel' }] }] }}>Go</button><div>Panel</div></div>`, line: /refused behaviour on #0 on <button>: .*panel/ },
  { id: 'an id that keys no node', jsx: `<button nodeId="a.b" behaviour={{ state: [{ id: 's', name: 'S', type: 'boolean', initial: false }] }}>Go</button>`, line: /refused behaviour on <button> a\.b: a node with no stable id holds no behaviour/ },
  { id: 'an id on two nodes', jsx: `<div><p nodeId="a">x</p><p nodeId="a">y</p></div>`, line: /nodeId a names a second node/ },
  { id: 'an id on a text run', jsx: `<p><TextRun nodeId="t">{"x"}</TextRun></p>`, line: /nodeId on a text node/ },
  { id: 'an id that is no text', jsx: `<p nodeId={7}>x</p>`, line: /nodeId is not text/ },
];

/** Must be refused, not converted: the plan's rule for an island nobody recognises. */
const MUST_REFUSE: Array<{ id: string; node: ComponentNode }> = [
  { id: 'unknown island', node: { type: 'div', props: { 'data-component-kind': 'not-a-real-kind' } as never } },
  { id: 'a function prop', node: { type: 'div', props: { onClick: () => {} } as never } },
  { id: 'a style on a text node', node: { type: 'p', props: {}, children: [{ type: '#text', props: { children: 'x', style: { color: 'red' } } as never }] } },
  { id: 'a rule on a text node', node: { type: 'p', props: {}, children: [{ type: '#text', props: { children: 'x', rules: [{ id: 'r', selector: '&', style: { color: 'red' } }] } as never }] } },
  { id: 'behaviour on a text node', node: { type: 'p', props: {}, children: [{ id: 't', type: '#text', props: { children: 'x', behaviour: { state: [OPEN_STATE] } } as never }] } },
  { id: 'a stored prop named nodeId', node: { type: 'div', props: { nodeId: 'x' } as never } },
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
  { id: 'a computed value in a rule', jsx: `<div rules={[{ id: 'r', selector: '&:hover', style: { color: brand } }]}>Hi</div>` },
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

/** The whole published page and the program it runs, through the behaviour pass, with ids that do not depend on the side of the trip. */
function publish(node: ComponentNode): string {
  const { root, program } = applyBehaviour(withPlaceIds(node));
  const { html, css } = renderPublished(root);
  return `${html}\n${css}\n${JSON.stringify(program)}`;
}

/** The case and, past the JSON, the same page on both sides, holding what `sheet` names. */
function publishedCase(id: string, node: ComponentNode, sheet: RegExp[] = []): RoundTripCase {
  const trip = nodesCase(id, node);
  if (!trip.pass) return trip;
  const before = publish(node);
  const after = publish(jsxToNodes(nodesToJsx(node)).node as ComponentNode);
  if (before !== after) return { ...trip, pass: false, gap: 'roundtrip-not-representable', detail: `published ${before.slice(0, 160)} became ${after.slice(0, 160)}` };
  const missing = sheet.filter((expected) => !expected.test(before));
  if (missing.length > 0) return { ...trip, pass: false, gap: 'unclassified', detail: `the page lacks ${missing.join(', ')}: ${before.slice(0, 160)}` };
  return trip;
}

/** The refused rule comes back as one line with the parser's reason, and its neighbours stand. */
function refusedRuleCase(id: string, rule: unknown, reason: RegExp): RoundTripCase {
  const base = { id: `refused rule: ${id}`, direction: 'nodes-jsx-nodes' as const };
  const before = { id: 'before', selector: '&:hover', style: { color: '#111111' } };
  const after = { id: 'after', selector: '&:focus', style: { color: '#222222' } };
  const { node, leftOver } = jsxToNodes(nodesToJsx({ type: 'div', props: { rules: [before, rule, after] } as never }));
  const kept = JSON.stringify((node?.props as { rules?: unknown } | undefined)?.rules);
  if (leftOver.length === 1 && /^refused rule /.test(leftOver[0]) && reason.test(leftOver[0]) && kept === JSON.stringify([before, after])) return { ...base, pass: true };
  return { ...base, pass: false, gap: 'unclassified', detail: `kept ${kept?.slice(0, 160)}`, leftOver };
}

/**
 * The refused entry comes back as one line with the parser's reason, the rest of the
 * behaviour stands as it was, and the page is the one the stored tree publishes, which
 * leaves that entry out as well: not carried, and nothing lost beside it.
 */
function refusedBehaviourCase(id: string, behaviour: Record<string, unknown>, reason: RegExp): RoundTripCase {
  const base = { id: `refused behaviour: ${id}`, direction: 'nodes-jsx-nodes' as const };
  const stored: ComponentNode = { id: 'host', type: 'button', props: { type: 'button', children: 'Open', behaviour } as never };
  const { node, leftOver } = jsxToNodes(nodesToJsx(stored));
  const kept = JSON.stringify(normalise({ type: 'i', props: { behaviour: (node?.props as { behaviour?: unknown } | undefined)?.behaviour } as never }));
  const expected = JSON.stringify(normalise({ type: 'i', props: { behaviour: KEPT_BEHAVIOUR } as never }));
  const lined = leftOver.length === 1 && /^refused behaviour /.test(leftOver[0]) && reason.test(leftOver[0]);
  if (!lined || kept !== expected) return { ...base, pass: false, gap: 'unclassified', detail: `kept ${kept.slice(0, 160)}`, leftOver };
  const before = publish(stored);
  const after = publish(node as ComponentNode);
  if (before !== after) return { ...base, pass: false, gap: 'roundtrip-not-representable', detail: `published ${before.slice(0, 160)} became ${after.slice(0, 160)}` };
  return { ...base, pass: true };
}

/** JSX with behaviour, or a node id, the format cannot hold: one line, and no behaviour carried. */
function reportedBehaviourCase(id: string, jsx: string, line: RegExp): RoundTripCase {
  const base = { id: `reported: ${id}`, direction: 'jsx-nodes-render' as const };
  const { node, leftOver } = jsxToNodes(jsx);
  const held = JSON.stringify(node).includes('"behaviour"');
  if (node && leftOver.length === 1 && line.test(leftOver[0]) && !held) return { ...base, pass: true };
  return { ...base, pass: false, gap: 'unclassified', detail: `carried: ${held}`, leftOver };
}

function reportedCase(id: string, jsx: string, line: RegExp): RoundTripCase {
  const base = { id: `reported: ${id}`, direction: 'jsx-nodes-render' as const };
  const { node, leftOver } = jsxToNodes(jsx);
  const held = JSON.stringify(node).includes('"rules"');
  if (leftOver.length === 1 && line.test(leftOver[0]) && !held) return { ...base, pass: true };
  return { ...base, pass: false, gap: 'unclassified', detail: `carried: ${held}`, leftOver };
}

function jsxCase(id: string, jsx: string): RoundTripCase {
  const base = { id, direction: 'jsx-nodes-render' as const };
  const imported = jsxToNodes(jsx);
  if (!imported.node || imported.leftOver.length > 0) {
    return { ...base, pass: false, gap: 'import-dynamic-logic', detail: 'reported as left over', leftOver: imported.leftOver };
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
    // A form stamps the moment it was rendered, and two renders must compare equal.
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const cases: RoundTripCase[] = [];
    for (const fixture of FIXTURES) cases.push(publishedCase(`corpus: ${fixture.id}`, fixture.tree()));
    // A tree built from a preset runs behaviour, so it must publish the same program after the trip.
    for (const pattern of PATTERNS) {
      const id = `pattern: ${pattern.id}`;
      cases.push(pattern.built === 'behaviour' ? publishedCase(id, pattern.tree()) : nodesCase(id, pattern.tree()));
    }
    for (const entry of Object.values(COMPONENT_REGISTRY)) {
      cases.push(nodesCase(`preset: ${entry.id}`, { type: entry.htmlType, props: entry.defaultProps as never }));
    }
    for (const { id, node } of SYNTHETIC) cases.push(nodesCase(`synthetic: ${id}`, node));
    for (const { id, node, sheet } of RULE_CASES) cases.push(publishedCase(`rules: ${id}`, node, sheet));
    for (const { id, rule, reason } of REFUSED_RULES) cases.push(refusedRuleCase(id, rule, reason));
    for (const { id, node, page } of BEHAVIOUR_CASES) cases.push(publishedCase(`behaviour: ${id}`, node, page));
    for (const { id, behaviour, reason } of REFUSED_BEHAVIOUR) cases.push(refusedBehaviourCase(id, behaviour, reason));
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
    for (const { id, jsx, line } of REPORTED_JSX) cases.push(reportedCase(id, jsx, line));
    for (const { id, jsx, line } of REPORTED_BEHAVIOUR_JSX) cases.push(reportedBehaviourCase(id, jsx, line));
    expect(cases.length).toBeGreaterThan(40);
    writeOut('roundtrip', cases);
  });
});
