// Desktop-first breakpoint inheritance on the model
// (docs/plans/2026-10-23-breakpoint-style-inheritance.md): what the canvas
// renders (getResolvedProps), what the panel shows (getResponsiveStyleValue /
// Source), the writes, the reset and one undo step each. Paths: forward
// (edits), backtrack (reset, clearing a field), re-entry (edit again after a
// reset), and loading an older project (values under the primary id).
import { describe, it, expect } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import PageModel from '../PageModel';
import { createIntrinsicComponent, type ComponentInstance } from '../ComponentModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import HistoryStore from '@/stores/HistoryStore';

const D = 'bp-d';
const T = 'bp-t';
const P = 'bp-p';
const ALL = [
  { id: D, minWidth: 1280 },
  { id: T, minWidth: 768 },
  { id: P, minWidth: 320 },
];

function setup(style: Record<string, unknown> = {}) {
  const root = createIntrinsicComponent('root', 'div', {});
  const page = PageModel.create({
    id: 'page',
    metadata: { title: 'Home' },
    appComponentTree: getSnapshot(root),
    canvasNodes: defaultViewportSnapshots([D, T, P]),
  });
  page.appComponentTree.addChild(createIntrinsicComponent('text', 'p', { style, children: 'Hi' }));
  const node = page.appComponentTree.children[0] as ComponentInstance;
  const history = HistoryStore.create({});
  history.setTargetStore(page);
  const rendered = (bp: string) => node.getResolvedProps(bp, ALL).style;
  return { page, node, history, rendered };
}

describe('resolution (canvas and panel agree)', () => {
  it('a Tablet override cascades down to Phone, never up to Desktop', () => {
    const { node, rendered } = setup({ fontSize: { base: '40px', [T]: '28px' } });
    expect(rendered(D).fontSize).toBe('40px');
    expect(rendered(T).fontSize).toBe('28px');
    expect(rendered(P).fontSize).toBe('28px');
    for (const bp of [D, T, P]) expect(node.getResponsiveStyleValue('fontSize', bp)).toBe(rendered(bp).fontSize);
  });

  it('a Phone override wins on Phone only', () => {
    const { rendered } = setup({ fontSize: { base: '40px', [T]: '28px', [P]: '20px' } });
    expect([rendered(D).fontSize, rendered(T).fontSize, rendered(P).fontSize]).toEqual(['40px', '28px', '20px']);
  });

  it('an older project with the value under the primary id renders as before', () => {
    const { node, rendered } = setup({ color: { base: 'black', [D]: 'red' } });
    expect(rendered(D).color).toBe('red');
    expect(rendered(T).color).toBe('red');
    expect(rendered(P).color).toBe('red');
    expect(node.getResponsiveStyleSource('color', D).source).toEqual({ kind: 'own' });
    expect(node.getResponsiveStyleSource('color', P).source).toEqual({ kind: 'inherited', breakpointId: D });
  });

  it('plain values pass through unchanged, an empty breakpoint (floating) reads as the largest', () => {
    const { node, rendered } = setup({ color: 'blue', fontSize: { base: '40px', [T]: '28px' } });
    expect(rendered(P).color).toBe('blue');
    expect(node.getResolvedProps('', ALL).style.fontSize).toBe('40px');
    expect(node.getResponsiveStyleSource('color', D).source).toEqual({ kind: 'own' });
    expect(node.getResponsiveStyleSource('color', T).source).toEqual({ kind: 'inherited', breakpointId: D });
  });

  it('own-only reads: the override on this breakpoint, else undefined', () => {
    const { node } = setup({ fontSize: { base: '40px', [T]: '28px' } });
    expect(node.getOwnResponsiveStyleValue('fontSize', D)).toBe('40px');
    expect(node.getOwnResponsiveStyleValue('fontSize', T)).toBe('28px');
    expect(node.getOwnResponsiveStyleValue('fontSize', P)).toBeUndefined();
  });

  it('knows the page breakpoints, largest first, with their labels', () => {
    const { node } = setup();
    expect(node.pageBreakpoints.map((b: { label: string }) => b.label)).toEqual(['Desktop', 'Tablet', 'Mobile']);
    expect(node.isLargestBreakpoint(D)).toBe(true);
    expect(node.isLargestBreakpoint(T)).toBe(false);
    expect(node.isLargestBreakpoint(undefined)).toBe(true);
  });
});

describe('writes, reset and undo', () => {
  it('a Desktop edit writes the base (and drops a legacy primary-id value)', () => {
    const { node, rendered } = setup({ color: { base: 'black', [D]: 'red', [P]: 'green' } });
    node.updateResponsiveStyle('color', 'blue', D);
    expect(node.props.style.color).toEqual({ base: 'blue', [P]: 'green' });
    expect(rendered(T).color).toBe('blue');
    expect(rendered(P).color).toBe('green');
  });

  it('a Desktop edit on a plain value stays a plain value', () => {
    const { node } = setup({ color: 'black' });
    node.updateResponsiveStyle('color', 'blue', D);
    expect(node.props.style.color).toBe('blue');
  });

  it('a Tablet edit reaches Phone, not Desktop; one undo step', () => {
    const { node, history, rendered } = setup({ fontSize: '40px' });
    node.updateResponsiveStyle('fontSize', '28px', T);
    expect(node.props.style.fontSize).toEqual({ base: '40px', [T]: '28px' });
    expect([rendered(D).fontSize, rendered(T).fontSize, rendered(P).fontSize]).toEqual(['40px', '28px', '28px']);
    expect(history.history.length).toBe(1);
    history.undo();
    expect(node.props.style.fontSize).toBe('40px');
  });

  it('clearing the field on Tablet removes the override (inherits again)', () => {
    const { node, rendered } = setup({ fontSize: { base: '40px', [T]: '28px' } });
    node.updateResponsiveStyle('fontSize', '', T);
    expect(node.props.style.fontSize).toBe('40px');
    expect(rendered(P).fontSize).toBe('40px');
  });

  it('clearing the field on Desktop removes the property when nothing else is left', () => {
    const { node } = setup({ fontSize: '40px' });
    node.updateResponsiveStyle('fontSize', '', D);
    expect('fontSize' in node.props.style).toBe(false);
  });

  it('reset removes the override in one undo step; undo brings it back; editing again works', () => {
    const { node, history, rendered } = setup({ fontSize: { base: '40px', [T]: '28px', [P]: '20px' } });
    node.resetResponsiveStyle('fontSize', P);
    expect(rendered(P).fontSize).toBe('28px'); // back to Tablet's, not Desktop's
    expect(history.history.length).toBe(1);
    history.undo();
    expect(rendered(P).fontSize).toBe('20px');
    history.redo();
    node.resetResponsiveStyle('fontSize', T);
    expect(rendered(P).fontSize).toBe('40px');
    node.updateResponsiveStyle('fontSize', '30px', T);
    expect(rendered(P).fontSize).toBe('30px');
  });

  it('resetting several properties is one undo step; reset on Desktop does nothing', () => {
    const { node, history } = setup({ width: { base: '100px', [T]: '50px' }, height: { base: '80px', [T]: '40px' } });
    node.resetResponsiveStyles(['width', 'height'], T);
    expect(node.props.style).toEqual({ width: '100px', height: '80px' });
    expect(history.history.length).toBe(1);
    node.resetResponsiveStyle('width', D);
    expect(history.history.length).toBe(1);
  });

  it('a node not on a page writes the base for any breakpoint', () => {
    const lone = createIntrinsicComponent('lone', 'div', { style: {} });
    lone.updateResponsiveStyle('color', 'red', 'anything');
    expect(lone.props.style.color).toBe('red');
    expect(lone.getResponsiveStyleValue('color', 'anything')).toBe('red');
  });
});
