// The phone quick edits on the real stores: what the toolbar and the
// long-press menu offer per element kind, that each action writes the right
// style on the frame being edited (a Mobile override on the Mobile frame,
// the desktop base untouched) as ONE undo step, tree navigation that keeps
// the frame, and copy and paste style.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRootStore, getHistoryStore } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import {
  ancestorsOf,
  centerInParent,
  centerMechanismFor,
  contextMenuItemsFor,
  copyStyle,
  cycleFontWeight,
  firstChildOf,
  isAppearanceStyle,
  isCenteredInParent,
  isContentCentered,
  pasteStyle,
  quickGroupsFor,
  quickKindOf,
  selectInSameFrame,
  setTextAlign,
  setWidthMode,
  stepFontSize,
  stepGap,
  stepPadding,
  toggleCenterContent,
  toggleLayoutDirection,
  widthModeOf,
  type QuickContext,
} from '../actions';

function setup() {
  const store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Quick');
  const project = projectStore.findProjectByTitle('Quick')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  const root = page.appComponentTree as ComponentInstance;
  const main = root.children[0] as ComponentInstance;
  main.addChildren([
    createIntrinsicComponent('q-heading', 'h1', { children: 'Hello', style: { fontSize: '40px' } }),
    createIntrinsicComponent('q-box', 'div', { style: {} }),
  ]);
  const heading = page.findComponent('q-heading')!;
  const box = page.findComponent('q-box')!;
  box.addChildren([createIntrinsicComponent('q-para', 'p', { children: 'Body' })]);
  const para = page.findComponent('q-para')!;
  const frames = page.sortedViewportNodes;
  const desktop = frames[0];
  const mobile = frames[frames.length - 1];
  const history = getHistoryStore()!;
  history.clear();
  const ctx = (component: ComponentInstance, breakpointId = mobile.breakpointId, extra: Partial<QuickContext> = {}): QuickContext => ({
    component,
    breakpointId,
    history,
    ...extra,
  });
  return { page, editorUI, history, root, main, heading, box, para, desktop, mobile, ctx };
}

/** The value stored for `prop` on `bp` itself (undefined when inherited). */
const own = (c: ComponentInstance, prop: string, bp: string | undefined) => c.getOwnResponsiveStyleValue(prop, bp);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('what the toolbar offers per element kind', () => {
  it('text, container, image and other kinds', () => {
    const { heading, box, main, page } = setup();
    expect(quickKindOf(heading)).toBe('text');
    expect(quickKindOf(box)).toBe('container');
    expect(quickGroupsFor(heading)).toEqual(['tree', 'text', 'element']);
    expect(quickGroupsFor(box)).toEqual(['tree', 'container', 'element']);
    const image = (page.appComponentTree as ComponentInstance).children.find(c => c.type === 'img');
    if (image) {
      expect(quickKindOf(image as ComponentInstance)).toBe('image');
      expect(quickGroupsFor(image as ComponentInstance)).toEqual(['tree', 'element']);
    }
    expect(quickKindOf(main)).toBe('container');
  });
});

describe('text actions write a Mobile override, one undo step each', () => {
  it('font size steps from the stored size, desktop base untouched', () => {
    const { heading, ctx, desktop, mobile, history } = setup();
    expect(stepFontSize(ctx(heading), 1)).toBe(41);
    expect(own(heading, 'fontSize', mobile.breakpointId)).toBe('41px');
    expect(own(heading, 'fontSize', desktop.breakpointId)).toBe('40px');
    expect(history.history.length).toBe(1);
    history.undo();
    expect(own(heading, 'fontSize', mobile.breakpointId)).toBeUndefined();
  });

  it('font size starts from the rendered size when nothing is stored', () => {
    const { para, ctx, mobile } = setup();
    stepFontSize(ctx(para, mobile.breakpointId, { computed: (p) => (p === 'font-size' ? '18px' : undefined) }), -1);
    expect(own(para, 'fontSize', mobile.breakpointId)).toBe('17px');
  });

  it('a press-and-hold run inside one batch is one undo step', () => {
    const { heading, ctx, history, mobile } = setup();
    history.startBatch('Font size');
    for (let i = 0; i < 5; i++) stepFontSize(ctx(heading), 1);
    history.commitBatch();
    expect(own(heading, 'fontSize', mobile.breakpointId)).toBe('45px');
    expect(history.history.length).toBe(1);
    history.undo();
    expect(own(heading, 'fontSize', mobile.breakpointId)).toBeUndefined();
  });

  it('weight cycles Regular, Medium, Bold, Regular', () => {
    const { heading, ctx } = setup();
    const c = ctx(heading, undefined, { computed: () => undefined });
    expect(cycleFontWeight(c)).toBe('500');
    expect(cycleFontWeight(c)).toBe('700');
    expect(cycleFontWeight(c)).toBe('400');
  });

  it('text align', () => {
    const { heading, ctx, mobile, history } = setup();
    setTextAlign(ctx(heading), 'center');
    expect(own(heading, 'textAlign', mobile.breakpointId)).toBe('center');
    expect(history.history.length).toBe(1);
  });
});

describe('container actions', () => {
  it('direction: a block becomes a column stack, then toggles row and column', () => {
    const { box, ctx, mobile, history } = setup();
    expect(toggleLayoutDirection(ctx(box))).toBe('column');
    expect(own(box, 'display', mobile.breakpointId)).toBe('flex');
    expect(own(box, 'flexDirection', mobile.breakpointId)).toBe('column');
    expect(history.history.length).toBe(1);
    expect(toggleLayoutDirection(ctx(box))).toBe('row');
    expect(history.history.length).toBe(2);
  });

  it('center content in one tap (one undo step), a second tap undoes the centring', () => {
    const { box, ctx, mobile, history } = setup();
    expect(toggleCenterContent(ctx(box))).toBe(true);
    expect(own(box, 'justifyContent', mobile.breakpointId)).toBe('center');
    expect(own(box, 'alignItems', mobile.breakpointId)).toBe('center');
    expect(isContentCentered(ctx(box))).toBe(true);
    expect(history.history.length).toBe(1);
    history.undo();
    expect(own(box, 'display', mobile.breakpointId)).toBeUndefined();
    history.redo();
    expect(toggleCenterContent(ctx(box))).toBe(false);
    expect(own(box, 'justifyContent', mobile.breakpointId)).toBe('flex-start');
  });

  it('gap and padding steppers', () => {
    const { box, ctx, mobile, desktop } = setup();
    expect(stepGap(ctx(box), 4)).toBe(4);
    expect(own(box, 'gap', mobile.breakpointId)).toBe('4px');
    expect(stepPadding(ctx(box), 8)).toBe(8);
    for (const side of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
      expect(own(box, side, mobile.breakpointId)).toBe('8px');
      expect(own(box, side, desktop.breakpointId)).toBeUndefined();
    }
    expect(stepPadding(ctx(box), -20)).toBe(0);
  });
});

describe('center in parent, by parent layout', () => {
  it('picks the mechanism from the parent layout', () => {
    expect(centerMechanismFor('block', 'row')).toBe('autoMargins');
    expect(centerMechanismFor('flex', 'column')).toBe('alignSelf');
    expect(centerMechanismFor('flex', 'row')).toBe('autoMargins');
    expect(centerMechanismFor('grid', 'row')).toBe('justifySelf');
  });

  it('block parent: auto margins and fit-content width', () => {
    const { box, para, ctx, mobile, history } = setup();
    box.updateResponsiveStyle('display', 'block', mobile.breakpointId);
    history.clear();
    expect(centerInParent(ctx(para), box)).toBe('autoMargins');
    expect(own(para, 'marginLeft', mobile.breakpointId)).toBe('auto');
    expect(own(para, 'marginRight', mobile.breakpointId)).toBe('auto');
    expect(own(para, 'width', mobile.breakpointId)).toBe('fit-content');
    expect(isCenteredInParent(ctx(para), box)).toBe(true);
    expect(history.history.length).toBe(1);
  });

  it('flex column parent: align-self center', () => {
    const { box, para, ctx, mobile } = setup();
    box.updateResponsiveStyle('display', 'flex', mobile.breakpointId);
    box.updateResponsiveStyle('flexDirection', 'column', mobile.breakpointId);
    expect(centerInParent(ctx(para), box)).toBe('alignSelf');
    expect(own(para, 'alignSelf', mobile.breakpointId)).toBe('center');
    expect(own(para, 'width', mobile.breakpointId)).toBeUndefined();
  });

  it('grid parent: justify-self center', () => {
    const { box, para, ctx, mobile } = setup();
    box.updateResponsiveStyle('display', 'grid', mobile.breakpointId);
    expect(centerInParent(ctx(para), box)).toBe('justifySelf');
    expect(own(para, 'justifySelf', mobile.breakpointId)).toBe('center');
  });

  it('an inline element in a block parent becomes a block first', () => {
    const { box, ctx, mobile, main } = setup();
    main.addChildren([createIntrinsicComponent('q-span', 'span', { children: 'x' })]);
    const span = main.children.find(c => c.id === 'q-span') as ComponentInstance;
    centerInParent(ctx(span, mobile.breakpointId, { computed: (p) => (p === 'display' ? 'inline' : undefined) }), box);
    expect(own(span, 'display', mobile.breakpointId)).toBe('block');
  });
});

describe('width mode', () => {
  it('fit, fill and fixed', () => {
    const { heading, ctx, mobile } = setup();
    expect(widthModeOf(ctx(heading))).toBeUndefined();
    setWidthMode(ctx(heading), 'fit', 200);
    expect(own(heading, 'width', mobile.breakpointId)).toBe('fit-content');
    expect(widthModeOf(ctx(heading))).toBe('fit');
    setWidthMode(ctx(heading), 'fill', 200);
    expect(own(heading, 'width', mobile.breakpointId)).toBe('100%');
    setWidthMode(ctx(heading), 'fixed', 212.6);
    expect(own(heading, 'width', mobile.breakpointId)).toBe('213px');
    expect(widthModeOf(ctx(heading))).toBe('fixed');
  });
});

describe('tree navigation keeps the frame', () => {
  it('ancestors nearest first, without frames', () => {
    const { page, para, box, main, root } = setup();
    expect(ancestorsOf(para, page).map(c => c.id)).toEqual([box.id, main.id, root.id]);
    expect(ancestorsOf(root, page)).toEqual([]);
  });

  it('select parent and child in the same frame', () => {
    const { editorUI, para, box, mobile } = setup();
    editorUI.selectComponent(para, mobile.breakpointId);
    selectInSameFrame(editorUI, box);
    expect(editorUI.selectedComponent).toBe(box);
    expect(editorUI.selectedViewportNode).toBe(mobile);
    selectInSameFrame(editorUI, firstChildOf(box)!);
    expect(editorUI.selectedComponent).toBe(para);
    expect(editorUI.selectedViewportNode).toBe(mobile);
  });
});

describe('copy and paste style', () => {
  it('copies appearance only, resolved for the frame', () => {
    expect(isAppearanceStyle('color')).toBe(true);
    expect(isAppearanceStyle('backgroundColor')).toBe(true);
    expect(isAppearanceStyle('fontSize')).toBe(true);
    expect(isAppearanceStyle('width')).toBe(false);
    expect(isAppearanceStyle('padding')).toBe(false);
    expect(isAppearanceStyle('flexDirection')).toBe(false);
  });

  it('round trip onto another element on Mobile is one undo step', () => {
    const { heading, para, desktop, mobile, history } = setup();
    heading.updateResponsiveStyle('color', 'rgb(200, 0, 0)', desktop.breakpointId);
    heading.updateResponsiveStyle('width', '300px', desktop.breakpointId);
    heading.updateResponsiveStyle('fontSize', '28px', mobile.breakpointId);
    const copied = copyStyle(heading, mobile.breakpointId);
    expect(copied).toEqual({ fontSize: '28px', color: 'rgb(200, 0, 0)' });
    history.clear();
    expect(pasteStyle(para, mobile.breakpointId, copied, history)).toBe(2);
    expect(own(para, 'fontSize', mobile.breakpointId)).toBe('28px');
    expect(own(para, 'color', mobile.breakpointId)).toBe('rgb(200, 0, 0)');
    expect(own(para, 'width', mobile.breakpointId)).toBeUndefined();
    expect(own(para, 'color', desktop.breakpointId)).toBeUndefined();
    expect(history.history.length).toBe(1);
    history.undo();
    expect(own(para, 'fontSize', mobile.breakpointId)).toBeUndefined();
    expect(own(para, 'color', mobile.breakpointId)).toBeUndefined();
  });

  it('pasting nothing changes nothing', () => {
    const { para, mobile, history } = setup();
    expect(pasteStyle(para, mobile.breakpointId, {}, history)).toBe(0);
    expect(history.history.length).toBe(0);
  });
});

describe('the long-press menu items', () => {
  it('per element kind', () => {
    const { page, heading, box, root } = setup();
    expect(contextMenuItemsFor(heading, page, false)).toEqual(['selectParent', 'editText', 'duplicate', 'copyStyle', 'delete']);
    expect(contextMenuItemsFor(box, page, true)).toEqual(['selectParent', 'selectChild', 'duplicate', 'copyStyle', 'pasteStyle', 'delete']);
    // The page root: no parent, cannot be duplicated or deleted.
    expect(contextMenuItemsFor(root, page, false)).toEqual(['selectChild', 'copyStyle']);
  });
});
