// Value math and the model write session behind the on-canvas spacing
// handles: pointer delta to value at any zoom, snapping, clamping, the Alt
// mirror, shorthand handling, one undo step per drag and an exact Escape.
import { describe, it, expect } from 'vitest';
import {
  boxWrites,
  dragDirection,
  gapWrite,
  isAutoSide,
  minValueFor,
  shorthandSide,
  sidesForDrag,
  startSpacingDrag,
  uniformBoxValue,
  valueFromDrag,
} from '../spacingDrag';
import type { Edges } from '../spacingGeometry';
import HistoryStore from '@/stores/HistoryStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import PageModel from '@/models/PageModel';
import { defaultViewportSnapshots } from '@/lib/canvas/defaultViewports';
import { getSnapshot } from 'mobx-state-tree';

const PT = { kind: 'padding', side: 'top' } as const;

describe('dragDirection', () => {
  it('padding grows into the element, margin away from it, gaps right and down', () => {
    expect(dragDirection({ kind: 'padding', side: 'top' })).toEqual({ axis: 'y', sign: 1 });
    expect(dragDirection({ kind: 'padding', side: 'bottom' })).toEqual({ axis: 'y', sign: -1 });
    expect(dragDirection({ kind: 'padding', side: 'left' })).toEqual({ axis: 'x', sign: 1 });
    expect(dragDirection({ kind: 'padding', side: 'right' })).toEqual({ axis: 'x', sign: -1 });
    expect(dragDirection({ kind: 'margin', side: 'top' })).toEqual({ axis: 'y', sign: -1 });
    expect(dragDirection({ kind: 'margin', side: 'right' })).toEqual({ axis: 'x', sign: 1 });
    expect(dragDirection({ kind: 'gap', axis: 'column' })).toEqual({ axis: 'x', sign: 1 });
    expect(dragDirection({ kind: 'gap', axis: 'row' })).toEqual({ axis: 'y', sign: 1 });
  });
});

describe('valueFromDrag', () => {
  const base = { start: 16, dx: 0, dy: 0, target: PT, scale: 1, snap: false, min: 0 };

  it('divides the screen delta by the zoom', () => {
    expect(valueFromDrag({ ...base, dy: 10, scale: 1 })).toBe(26);
    expect(valueFromDrag({ ...base, dy: 10, scale: 2 })).toBe(21);
    expect(valueFromDrag({ ...base, dy: 10, scale: 0.5 })).toBe(36);
    expect(valueFromDrag({ ...base, dy: 10, dx: 500 })).toBe(26); // the other axis is ignored
  });

  it('rounds to whole px, and Shift snaps to 8px steps', () => {
    expect(valueFromDrag({ ...base, dy: 3, scale: 2 })).toBe(18); // 17.5 rounds up
    expect(valueFromDrag({ ...base, dy: 5, snap: true })).toBe(24); // 21 -> 24
    expect(valueFromDrag({ ...base, dy: 3, snap: true })).toBe(16); // 19 -> 16
  });

  it('never goes below the floor', () => {
    expect(valueFromDrag({ ...base, dy: -100 })).toBe(0);
    expect(Object.is(valueFromDrag({ ...base, dy: -16 }), 0)).toBe(true); // not -0
    expect(valueFromDrag({ ...base, target: { kind: 'gap', axis: 'column' }, dx: -50 })).toBe(0);
  });

  it('margin may keep an existing negative value but a drag never creates one', () => {
    expect(minValueFor({ kind: 'margin', side: 'top' }, 12)).toBe(0);
    expect(minValueFor({ kind: 'margin', side: 'top' }, -10)).toBe(-10);
    expect(minValueFor(PT, -10)).toBe(0);
    const mt = { kind: 'margin', side: 'top' } as const;
    expect(valueFromDrag({ ...base, target: mt, start: 4, dy: 50, min: 0 })).toBe(0);
    expect(valueFromDrag({ ...base, target: mt, start: -10, dy: -4, min: -10 })).toBe(-6);
  });
});

describe('Alt mirror and shorthands', () => {
  it('mirrors onto the opposite side', () => {
    expect(sidesForDrag('top', false)).toEqual(['top']);
    expect(sidesForDrag('top', true)).toEqual(['top', 'bottom']);
    expect(sidesForDrag('left', true)).toEqual(['left', 'right']);
  });

  it('reads a side from a box shorthand and spots auto', () => {
    expect(shorthandSide('8px 16px', 'left')).toBe('16px');
    expect(shorthandSide('1px 2px 3px', 'left')).toBe('2px');
    expect(shorthandSide('1px 2px 3px 4px', 'bottom')).toBe('3px');
    expect(shorthandSide('calc(1px + 2px)', 'top')).toBeUndefined();
    expect(isAutoSide('0 auto', undefined, 'left')).toBe(true);
    expect(isAutoSide('0 auto', '', 'top')).toBe(false);
    expect(isAutoSide('0 auto', '12px', 'left')).toBe(false); // the longhand wins
  });

  const start: Edges = { top: 16, right: 16, bottom: 16, left: 16 };

  it('writes only the longhands when no shorthand is authored', () => {
    const authored = (p: string) => (p === 'paddingTop' ? '4px' : undefined);
    expect(boxWrites({ kind: 'padding', sides: ['top', 'bottom'], value: 24, start, authored }))
      .toEqual([{ prop: 'paddingTop', value: '24px' }, { prop: 'paddingBottom', value: '24px' }]);
  });

  it('below the largest breakpoint overrides the shorthand with the four sides instead of clearing it', () => {
    const authored = (p: string) => (p === 'padding' ? '16px' : undefined);
    const writes = boxWrites({ kind: 'padding', sides: ['top'], value: 26, start, authored, clearShorthand: false });
    expect(writes.at(-1)).toEqual({ prop: 'padding', value: '26px 16px 16px 16px' });
  });

  it('expands an authored shorthand into four longhands and clears it', () => {
    const authored = (p: string) => (p === 'margin' ? '0 0 20px' : undefined);
    const writes = boxWrites({
      kind: 'margin', sides: ['top'], value: 24, start: { top: 0, right: 0, bottom: 20, left: 0 }, authored,
    });
    expect(writes).toEqual([
      { prop: 'marginTop', value: '24px' },
      { prop: 'marginRight', value: '0px' },
      { prop: 'marginBottom', value: '20px' },
      { prop: 'marginLeft', value: '0px' },
      { prop: 'margin', value: '' },
    ]);
  });

  it('gap: the shorthand like the panel, an authored longhand in effect, a two-value gap per axis', () => {
    const none = () => undefined;
    expect(gapWrite({ axis: 'column', value: 12, styleKeys: [], authored: none })).toEqual({ prop: 'gap', value: '12px' });
    const col = (p: string) => (p === 'columnGap' ? '4px' : undefined);
    expect(gapWrite({ axis: 'column', value: 12, styleKeys: ['columnGap'], authored: col }))
      .toEqual({ prop: 'columnGap', value: '12px' });
    // The longhand sits before an authored gap: gap is in effect, so gap is written.
    const both = (p: string) => ({ gap: '8px', columnGap: '4px' } as Record<string, string>)[p];
    expect(gapWrite({ axis: 'column', value: 12, styleKeys: ['columnGap', 'gap'], authored: both }))
      .toEqual({ prop: 'gap', value: '12px' });
    const otherOnly = (p: string) => (p === 'rowGap' ? '6px' : undefined);
    expect(gapWrite({ axis: 'column', value: 12, styleKeys: ['rowGap'], authored: otherOnly }))
      .toEqual({ prop: 'columnGap', value: '12px' });
    const two = (p: string) => (p === 'gap' ? '8px 20px' : undefined);
    expect(gapWrite({ axis: 'row', value: 12, styleKeys: ['gap'], authored: two })).toEqual({ prop: 'gap', value: '12px 20px' });
    expect(gapWrite({ axis: 'column', value: 12, styleKeys: ['gap'], authored: two })).toEqual({ prop: 'gap', value: '8px 12px' });
  });
});

describe('startSpacingDrag (model and history)', () => {
  function setup(style: Record<string, unknown> = { padding: '16px' }) {
    const component = createIntrinsicComponent('box', 'div', { style });
    const history = HistoryStore.create({});
    history.setTargetStore(component);
    return { component, history, original: JSON.parse(JSON.stringify(component.props)) };
  }
  const start: Edges = { top: 16, right: 16, bottom: 16, left: 16 };

  it('a whole drag is one undo step, written at the edited breakpoint', () => {
    const { component, history, original } = setup();
    const drag = startSpacingDrag({
      component, breakpointId: 'desktop', target: PT, start, scale: 2, mirror: true, history,
    });
    drag.update({ dx: 0, dy: 4, snap: false });
    drag.update({ dx: 0, dy: 10, snap: false });
    expect(drag.update({ dx: 0, dy: 20, snap: false })).toBe(26);
    drag.commit();

    expect(component.getResponsiveStyleValue('paddingTop', 'desktop')).toBe('26px');
    expect(component.getResponsiveStyleValue('paddingBottom', 'desktop')).toBe('26px'); // Alt mirror
    expect(component.getResponsiveStyleValue('paddingLeft', 'desktop')).toBe('16px'); // expanded
    // Not on a page, so 'desktop' is the only (largest) breakpoint: the
    // shorthand is cleared from the base, which removes it.
    expect('padding' in component.props.style).toBe(false);
    expect(history.history.length).toBe(1);

    history.undo();
    expect(component.props).toEqual(original);
    expect(history.canUndo).toBe(false);
  });

  it('Escape restores exactly and records nothing', () => {
    const { component, history, original } = setup({ padding: { base: '16px', desktop: '20px' } });
    const drag = startSpacingDrag({
      component, breakpointId: 'desktop', target: { kind: 'margin', side: 'left' },
      start: { top: 0, right: 0, bottom: 0, left: 0 }, scale: 1, mirror: true, history,
    });
    drag.update({ dx: -30, dy: 0, snap: true });
    expect(component.getResponsiveStyleValue('marginLeft', 'desktop')).toBe('32px');
    drag.cancel();

    expect(component.props).toEqual(original);
    expect(history.history.length).toBe(0);
    expect(history.canUndo).toBe(false);
  });

  it('a press without movement records no history', () => {
    const { component, history } = setup();
    const drag = startSpacingDrag({ component, breakpointId: 'desktop', target: PT, start, scale: 1, mirror: false, history });
    drag.update({ dx: 3, dy: 0, snap: false }); // moved, but not along this handle's axis
    drag.commit();
    expect(history.history.length).toBe(0);
  });

  it('a gap drag writes gap; floating elements write without a breakpoint', () => {
    const { component, history } = setup({ display: 'flex', gap: '8px' });
    const drag = startSpacingDrag({
      component, breakpointId: undefined, target: { kind: 'gap', axis: 'column' },
      start: { row: 8, column: 8 }, scale: 1, mirror: false, history,
    });
    drag.update({ dx: 7, dy: 0, snap: false });
    drag.commit();
    expect(component.props.style.gap).toBe('15px');
    expect(history.history.length).toBe(1);
  });
});

describe('startSpacingDrag on a page (desktop-first cascade)', () => {
  function onPage(style: Record<string, unknown>) {
    const page = PageModel.create({
      id: 'page',
      metadata: { title: 'Home' },
      appComponentTree: getSnapshot(createIntrinsicComponent('root', 'div', {})),
      canvasNodes: defaultViewportSnapshots(['bp-d', 'bp-t', 'bp-p']),
    });
    page.appComponentTree.addChild(createIntrinsicComponent('box', 'div', { style }));
    const component = page.appComponentTree.children[0] as ComponentInstance;
    const history = HistoryStore.create({});
    history.setTargetStore(page);
    return { component, history, original: JSON.parse(JSON.stringify(component.props)) };
  }
  const start: Edges = { top: 16, right: 16, bottom: 16, left: 16 };

  it('on Tablet with a Desktop shorthand, overrides it on Tablet only; Phone follows, Desktop does not; undo restores', () => {
    const { component, history, original } = onPage({ padding: '16px' });
    const drag = startSpacingDrag({ component, breakpointId: 'bp-t', target: PT, start, scale: 1, mirror: false, history });
    drag.update({ dx: 0, dy: 10, snap: false });
    drag.commit();
    expect(component.props.style.padding).toEqual({ base: '16px', 'bp-t': '26px 16px 16px 16px' });
    expect(component.getResponsiveStyleValue('paddingTop', 'bp-p')).toBe('26px');
    expect(component.getResponsiveStyleValue('paddingTop', 'bp-d')).toBeUndefined();
    history.undo();
    expect(component.props).toEqual(original);
  });

  it('Escape without a history store restores own values: no Tablet override appears', () => {
    const { component, original } = onPage({ paddingTop: '16px' });
    const drag = startSpacingDrag({ component, breakpointId: 'bp-t', target: PT, start, scale: 1, mirror: false, history: null });
    drag.update({ dx: 0, dy: 10, snap: false });
    expect(component.getResponsiveStyleValue('paddingTop', 'bp-t')).toBe('26px');
    drag.cancel();
    expect(component.props).toEqual(original);
  });
});

describe('uniformBoxValue', () => {
  const none = { top: undefined, right: undefined, bottom: undefined, left: undefined };

  it('is undefined when nothing is authored', () => {
    expect(uniformBoxValue(undefined, none)).toBeUndefined();
  });

  it('reads a one-value shorthand', () => {
    expect(uniformBoxValue('16px', none)).toBe('16px');
  });

  it('lets longhands win, so a drag that split the sides never shows the stale shorthand', () => {
    expect(uniformBoxValue('16px', { top: '24px', right: '24px', bottom: '24px', left: '24px' })).toBe('24px');
    expect(uniformBoxValue('16px', { ...none, top: '50px' })).toBe('mixed');
  });

  it('is mixed for a multi-value shorthand', () => {
    expect(uniformBoxValue('8px 16px', none)).toBe('mixed');
  });
});
