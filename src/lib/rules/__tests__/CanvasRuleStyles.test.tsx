import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { CanvasRuleStyles, PreviewRuleStyles } from '../CanvasRuleStyles';
import type { SurfaceNode } from '../surfaceSheet';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

afterEach(cleanup);

const BREAKPOINTS = [
  { id: 'desk', minWidth: 1280 },
  { id: 'mob', minWidth: 320 },
];
const FRAMES = [
  { breakpointId: 'desk', width: 1280, height: 800 },
  { breakpointId: 'mob', width: 320, height: 640 },
];

const HOVER = { id: 'r', selector: '&:hover', style: { color: 'red' } };
const tree = (rules: unknown[]): SurfaceNode => ({ id: 'a', type: 'div', props: { rules } });

const canvas = (node: SurfaceNode) => <CanvasRuleStyles tree={node} floating={[]} frames={FRAMES} breakpoints={BREAKPOINTS} />;

describe('CanvasRuleStyles', () => {
  it('renders nothing on a page with nothing to show', () => {
    store = createRootStore();
    const { container } = render(canvas({ id: 'a', type: 'div', props: {} }));
    expect(container.querySelector('style')).toBeNull();
  });

  it('renders one element, and follows previewRule from the store', () => {
    store = createRootStore();
    const node = tree([HOVER]);
    const { container } = render(canvas(node));
    expect(container.querySelectorAll('style')).toHaveLength(1);
    expect(container.querySelector('style')!.textContent).not.toContain(':is(*, :hover)');
    act(() => store.editorUI.setPreviewRule({ componentId: 'a', ruleId: 'r' }));
    expect(container.querySelector('style')!.textContent).toContain(':is(*, :hover)');
    act(() => store.editorUI.setPreviewRule(null));
    expect(container.querySelector('style')!.textContent).not.toContain(':is(*, :hover)');
  });

  it('keeps previewRule out of what is saved and out of history', () => {
    store = createRootStore();
    store.editorUI.setPreviewRule({ componentId: 'a', ruleId: 'r' });
    expect(JSON.stringify(getSnapshot(store.editorUI))).not.toContain('previewRule');
  });

  it('warns once for a set of problems, however often the sheet rebuilds', () => {
    store = createRootStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = tree([{ id: 'bad', selector: '& + p', style: {} }]);
    const { rerender } = render(canvas(node));
    rerender(canvas({ ...node }));
    rerender(canvas({ ...node }));
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('warns again for a different problem', () => {
    store = createRootStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { rerender } = render(canvas(tree([{ id: 'bad', selector: '& + p', style: {} }])));
    rerender(canvas(tree([{ id: 'worse', selector: '&</style>', style: {} }])));
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('PreviewRuleStyles', () => {
  it('scopes to the preview frame and needs no store', () => {
    const { container } = render(<PreviewRuleStyles tree={tree([HOVER])} frame={FRAMES[1]} breakpoints={BREAKPOINTS} />);
    expect(container.querySelector('style')!.textContent).toContain('[data-preview-frame] [data-component-id="mob-a"]:hover{color:red!important}');
  });
});
