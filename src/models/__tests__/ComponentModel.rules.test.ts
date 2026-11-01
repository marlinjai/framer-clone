// Selector-level rules on the model (docs/plans/2026-11-02-selector-styling.md):
// `props.rules` beside `props.style`, the four actions, one undo step each, and
// nothing left behind. Paths: forward (a first value creates the rule), backtrack
// (clearing the last value removes it), resume (a save and load keeps it), and
// re-entry (undo past its creation, a rule that was deleted, a refused rule).
import { describe, it, expect } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PageModel from '../PageModel';
import ComponentModel, { ComponentTypeEnum, createIntrinsicComponent, type ComponentInstance } from '../ComponentModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import HistoryStore from '@/stores/HistoryStore';
import { HOVER_GATE } from '@/lib/rules/states';
import { MAX_RULES_PER_NODE, storedRulesOf, type SelectorRule } from '@/lib/rules/rules';
import { TEXT_NODE_TYPE } from '@/lib/renderer/textNode';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';

const D = 'bp-d';
const T = 'bp-t';
const P = 'bp-p';

function setup(props: Record<string, unknown> = {}) {
  const root = createIntrinsicComponent('root', 'div', {});
  const page = PageModel.create({
    id: 'page',
    metadata: { title: 'Home' },
    appComponentTree: getSnapshot(root),
    canvasNodes: defaultViewportSnapshots([D, T, P]),
  });
  page.appComponentTree.addChild(createIntrinsicComponent('card', 'div', props));
  const node = page.appComponentTree.children[0] as ComponentInstance;
  const history = HistoryStore.create({});
  history.setTargetStore(page);
  const rules = () => storedRulesOf(node.props) as SelectorRule[];
  return { page, node, history, rules };
}

const custom = (selector: string, style: Record<string, unknown> = { color: 'red' }) => ({ selector, style });

describe('reading a node', () => {
  it('never turns a rule list into a DOM attribute', () => {
    const { node } = setup({ rules: [{ id: 'r1', selector: '&:hover', style: { color: 'red' } }] });
    expect(node.getResolvedProps(D, []).attributes).not.toHaveProperty('rules');
    expect(node.getResolvedProps(D, []).style).not.toHaveProperty('color');
  });

  it('leaves a string alone, the legacy table attribute of that name', () => {
    const { node } = setup({ rules: 'all' });
    expect(node.getResolvedProps(D, []).attributes.rules).toBe('all');
    expect(renderToStaticMarkup(renderComponentNode({ id: 't', type: 'table', props: { rules: 'all' } as never }) as React.ReactElement)).toContain('rules="all"');
  });

  it('never renders a rule list on the published page', () => {
    const node: ComponentNode = { id: 'a', type: 'div', props: { rules: [{ id: 'r1', selector: '&', style: {} }] } as never };
    expect(renderToStaticMarkup(renderComponentNode(node) as React.ReactElement)).toBe('<div></div>');
  });

  it('survives a save and load unchanged', () => {
    const rules = [{ id: 'r1', selector: '&:hover', at: [HOVER_GATE], style: { color: { base: '#00f', tablet: '#0a0' } } }];
    const first = ComponentModel.create({ id: 'a', type: 'div', componentType: ComponentTypeEnum.HOST, props: { rules } });
    const again = ComponentModel.create(JSON.parse(JSON.stringify(getSnapshot(first))));
    expect(again.props.rules).toEqual(rules);
  });
});

describe('setRuleStyle', () => {
  it('creates a state on its first value, with its selector and gate', () => {
    const { node, rules } = setup();
    expect(node.setRuleStyle('hover', 'color', '#00f', D)).toEqual({ ok: true });
    expect(rules()).toEqual([{ id: 'hover', selector: '&:hover', at: [HOVER_GATE], style: { color: '#00f' } }]);
  });

  it('cascades like a responsive style: a smaller breakpoint writes its own override', () => {
    const { node, rules } = setup();
    node.setRuleStyle('hover', 'color', '#00f', D);
    node.setRuleStyle('hover', 'color', '#0a0', T);
    expect(rules()[0].style.color).toEqual({ base: '#00f', [T]: '#0a0' });
  });

  it('leaves Normal alone', () => {
    const { node } = setup({ style: { color: '#111' } });
    node.setRuleStyle('hover', 'color', '#00f', D);
    expect(node.props.style).toEqual({ color: '#111' });
  });

  it('keeps named states in order at the start, whatever order they are made in', () => {
    const { node, rules } = setup();
    node.addRule(custom('&:nth-child(2n)'));
    node.setRuleStyle('pressed', 'color', 'red', D);
    node.setRuleStyle('hover', 'color', 'red', D);
    node.setRuleStyle('focused', 'color', 'red', D);
    expect(rules().map((rule) => rule.selector)).toEqual(['&:hover', '&:focus-visible', '&:active', '&:nth-child(2n)']);
  });

  it('removes a rule with its last value, and the list with its last rule', () => {
    const { node } = setup();
    node.setRuleStyle('hover', 'color', '#00f', D);
    node.setRuleStyle('hover', 'color', undefined, D);
    expect('rules' in node.props).toBe(false);
  });

  it('keeps the rule while another value holds it', () => {
    const { node, rules } = setup();
    node.setRuleStyle('hover', 'color', '#00f', D);
    node.setRuleStyle('hover', 'opacity', 0.5, D);
    node.setRuleStyle('hover', 'color', '', D);
    expect(rules()[0].style).toEqual({ opacity: 0.5 });
  });

  it('stores nothing when a state with no rule is cleared', () => {
    const { node } = setup();
    const before = getSnapshot(node);
    expect(node.setRuleStyle('hover', 'color', undefined, D)).toEqual({ ok: true });
    expect(getSnapshot(node)).toEqual(before);
  });

  it('reaches a state that arrived with another id, as an import does', () => {
    const { node, rules } = setup({ rules: [{ id: 'imported', selector: '&:hover', at: [HOVER_GATE], style: { color: 'red' } }] });
    node.setRuleStyle('hover', 'opacity', 0.5, D);
    expect(rules()).toHaveLength(1);
    expect(rules()[0]).toMatchObject({ id: 'imported', style: { color: 'red', opacity: 0.5 } });
  });

  it('edits an authored rule by its id', () => {
    const { node, rules } = setup();
    node.addRule({ id: 'r1', ...custom('&:nth-child(2n)') });
    node.setRuleStyle('r1', 'opacity', 0.5, D);
    expect(rules()[0].style).toEqual({ color: 'red', opacity: 0.5 });
  });

  it('refuses a rule that no longer exists, which is what a stale panel holds', () => {
    const { node } = setup();
    expect(node.setRuleStyle('gone', 'color', 'red', D)).toMatchObject({ ok: false });
    expect('rules' in node.props).toBe(false);
  });

  it('refuses a definition, which is edited as text', () => {
    const { node } = setup({ rules: [{ id: 'd1', define: '@font-face', style: { fontFamily: 'u-x' } }] });
    expect(node.setRuleStyle('d1', 'color', 'red', D)).toMatchObject({ ok: false });
  });

  it('keeps a rule the parser refuses editable, so it can be fixed or deleted', () => {
    const { node, rules } = setup({ rules: [{ id: 'bad', selector: '&', style: { backgroundImage: 'url(https://evil.test/x)' } }] });
    node.setRuleStyle('bad', 'backgroundImage', 'url(/a.png)', D);
    expect(rules()[0].style.backgroundImage).toBe('url(/a.png)');
  });

  it('refuses a new state past the cap', () => {
    const list = Array.from({ length: MAX_RULES_PER_NODE }, (_, i) => ({ id: `r${i}`, ...custom('&:empty') }));
    const { node } = setup({ rules: list });
    expect(node.setRuleStyle('hover', 'color', 'red', D)).toMatchObject({ ok: false, reason: expect.stringMatching(/64/) });
  });
});

describe('addRule', () => {
  it('stores what parses, and gives it an id', () => {
    const { node, rules } = setup();
    expect(node.addRule(custom('&:nth-child(2n)'))).toEqual({ ok: true });
    expect(rules()[0]).toMatchObject({ selector: '&:nth-child(2n)', style: { color: 'red' } });
    expect(rules()[0].id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('stores nothing refused, and says why', () => {
    const { node } = setup();
    expect(node.addRule(custom('& + p'))).toMatchObject({ ok: false, reason: expect.stringMatching(/sibling/) });
    expect(node.addRule(custom('&', { backgroundImage: 'url(https://evil.test/x)' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/address/) });
    expect(node.addRule({ define: '@keyframes spin', blocks: [{ selector: 'from', style: {} }] })).toMatchObject({ ok: false });
    expect('rules' in node.props).toBe(false);
  });

  it('takes a definition', () => {
    const { node } = setup();
    expect(node.addRule({ define: '@keyframes u-spin', blocks: [{ selector: 'to', style: { rotate: '360deg' } }] })).toEqual({ ok: true });
  });

  it('refuses a second rule with the same id, or a second of one state', () => {
    const { node, rules } = setup();
    node.addRule({ id: 'r1', ...custom('&:empty') });
    expect(node.addRule({ id: 'r1', ...custom('&:first-child') })).toMatchObject({ ok: false });
    node.setRuleStyle('hover', 'color', 'red', D);
    expect(node.addRule({ selector: '&:hover', at: [HOVER_GATE], style: { color: 'blue' } })).toMatchObject({ ok: false, reason: expect.stringMatching(/Hover/) });
    expect(rules()).toHaveLength(2);
  });

  it('places a state among the states, ahead of authored rules', () => {
    const { node, rules } = setup();
    node.addRule(custom('&:empty'));
    node.addRule({ selector: '&:active', style: { scale: '0.9' } });
    expect(rules().map((rule) => rule.selector)).toEqual(['&:active', '&:empty']);
  });

  it('refuses past the cap', () => {
    const list = Array.from({ length: MAX_RULES_PER_NODE }, (_, i) => ({ id: `r${i}`, ...custom('&:empty') }));
    const { node } = setup({ rules: list });
    expect(node.addRule(custom('&:first-child'))).toMatchObject({ ok: false });
  });
});

describe('removeRule and moveRule', () => {
  it('removes one rule, and the list with the last', () => {
    const { node, rules } = setup();
    node.addRule({ id: 'r1', ...custom('&:empty') });
    node.addRule({ id: 'r2', ...custom('&:first-child') });
    node.removeRule('r1');
    expect(rules().map((rule) => rule.id)).toEqual(['r2']);
    node.removeRule('r2');
    expect('rules' in node.props).toBe(false);
  });

  it('removes a state by the state it is', () => {
    const { node } = setup({ rules: [{ id: 'imported', selector: '&:active', style: { color: 'red' } }] });
    node.removeRule('pressed');
    expect('rules' in node.props).toBe(false);
  });

  it('moves an authored rule, and never ahead of a state', () => {
    const { node, rules } = setup();
    node.setRuleStyle('hover', 'color', 'red', D);
    node.addRule({ id: 'a', ...custom('&:empty') });
    node.addRule({ id: 'b', ...custom('&:first-child') });
    node.moveRule('b', 0);
    expect(rules().map((rule) => rule.id)).toEqual(['hover', 'b', 'a']);
  });

  it('writes nothing for a rule that is gone or a move that changes nothing', () => {
    const { node } = setup();
    node.addRule({ id: 'a', ...custom('&:empty') });
    node.addRule({ id: 'b', ...custom('&:first-child') });
    const props = node.props;
    node.removeRule('gone');
    node.moveRule('gone', 0);
    node.moveRule('a', 0);
    expect(node.props).toBe(props);
  });
});

describe('text nodes hold no rules', () => {
  const textNode = () => ComponentModel.create({ id: 't', type: TEXT_NODE_TYPE, componentType: ComponentTypeEnum.HOST, props: { children: 'Hi' } });

  it('refuses a rule loudly, since nothing would ever show it', () => {
    const node = textNode();
    expect(node.addRule(custom('&:hover'))).toMatchObject({ ok: false, reason: expect.stringMatching(/Text/) });
    expect(node.setRuleStyle('hover', 'color', 'red', D)).toMatchObject({ ok: false });
    expect('rules' in node.props).toBe(false);
  });
});

describe('one action, one undo step', () => {
  it('undoes a first value in one step, and leaves the node as it was', () => {
    const { node, history } = setup();
    const before = getSnapshot(node);
    node.setRuleStyle('hover', 'color', '#00f', D);
    expect('rules' in node.props).toBe(true);
    history.undo();
    expect(getSnapshot(node)).toEqual(before);
    expect(history.canUndo).toBe(false);
  });

  it('undoes a removal, and redoes it', () => {
    const { node, history, rules } = setup();
    node.addRule({ id: 'r1', ...custom('&:empty') });
    node.removeRule('r1');
    history.undo();
    expect(rules().map((rule) => rule.id)).toEqual(['r1']);
    history.redo();
    expect('rules' in node.props).toBe(false);
  });
});
