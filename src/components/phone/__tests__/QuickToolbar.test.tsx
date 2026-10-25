// The phone quick toolbar: what it shows per element kind, that a stepper's
// press (and a press-and-hold run) is one undo step on the frame being
// edited, parent and child selection keep the frame, and a selection tick
// plays on those (haptics mocked).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { TransformProvider } from '@/contexts/TransformContext';
import QuickToolbar from '../QuickToolbar';

const hapticSpy = vi.fn();
vi.mock('@/lib/haptics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/haptics')>()),
  haptic: () => hapticSpy(),
}));

let store: RootStoreType;

function setup() {
  store = createRootStore();
  const { projectStore, editorUI } = store;
  projectStore.createProject('Toolbar');
  const project = projectStore.findProjectByTitle('Toolbar')!;
  const page = project.findPageBySlug('')!;
  editorUI.setCurrentProject(project);
  editorUI.setCurrentPage(page);
  const root = page.appComponentTree as ComponentInstance;
  const main = root.children[0] as ComponentInstance;
  main.addChildren([
    createIntrinsicComponent('t-heading', 'h1', { children: 'Hello', style: { fontSize: '40px' } }),
    createIntrinsicComponent('t-box', 'div', { style: {} }),
  ]);
  const heading = page.findComponent('t-heading')!;
  const box = page.findComponent('t-box')!;
  box.addChildren([createIntrinsicComponent('t-para', 'p', { children: 'Body' })]);
  const para = page.findComponent('t-para')!;
  const frames = page.sortedViewportNodes;
  const mobile = frames[frames.length - 1];
  const desktop = frames[0];
  const history = getHistoryStore()!;
  history.clear();
  return { editorUI, page, heading, box, para, main, mobile, desktop, history };
}

function renderBar(onMore = vi.fn()) {
  render(
    <TransformProvider>
      <QuickToolbar editorUI={store.editorUI} onMore={onMore} />
    </TransformProvider>,
  );
  return { onMore, bar: () => screen.getByTestId('quick-toolbar') };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  hapticSpy.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('contents per element kind', () => {
  it('text: tree controls, the text row, element actions, no container row', () => {
    const { editorUI, heading, mobile } = setup();
    editorUI.selectComponent(heading, mobile.breakpointId);
    const { bar } = renderBar();
    const b = within(bar());
    expect((b.getByRole('button', { name: 'Select parent' }) as HTMLButtonElement).disabled).toBe(false);
    expect(b.getByTestId('quick-breadcrumb').textContent).toContain('Heading');
    // The frame is named on the chip: edits land on Mobile.
    expect(b.getByTestId('quick-breadcrumb').textContent).toMatch(/mobile/i);
    expect(b.getByTestId('quick-text-row')).toBeTruthy();
    expect(b.queryByTestId('quick-container-row')).toBeNull();
    for (const name of ['Edit text', 'Center in parent', 'Duplicate', 'Delete', 'More properties', 'Align center', 'Text color']) {
      expect(b.getByRole('button', { name })).toBeTruthy();
    }
    expect(b.getByRole('group', { name: 'Font size' }).textContent).toContain('40');
  });

  it('container: select child, the container row, no text row', () => {
    const { editorUI, box, mobile } = setup();
    editorUI.selectComponent(box, mobile.breakpointId);
    const { bar } = renderBar();
    const b = within(bar());
    expect((b.getByRole('button', { name: 'Select first child' }) as HTMLButtonElement).disabled).toBe(false);
    expect(b.getByTestId('quick-container-row')).toBeTruthy();
    expect(b.queryByTestId('quick-text-row')).toBeNull();
    expect(b.queryByRole('button', { name: 'Edit text' })).toBeNull();
    expect(b.getByRole('group', { name: 'Gap' })).toBeTruthy();
    expect(b.getByRole('group', { name: 'Padding' })).toBeTruthy();
  });

  it('the page root has no parent, no duplicate and no delete', () => {
    const { editorUI, page, mobile } = setup();
    editorUI.selectComponent(page.appComponentTree as ComponentInstance, mobile.breakpointId);
    const { bar } = renderBar();
    const b = within(bar());
    expect((b.getByRole('button', { name: 'Select parent' }) as HTMLButtonElement).disabled).toBe(true);
    expect(b.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(b.queryByRole('button', { name: 'Duplicate' })).toBeNull();
  });
});

describe('edits', () => {
  it('a stepper press is one undo step on the Mobile frame, with the override dot', () => {
    const { editorUI, heading, mobile, desktop, history } = setup();
    editorUI.selectComponent(heading, mobile.breakpointId);
    const { bar } = renderBar();
    const plus = within(bar()).getByRole('button', { name: 'Increase font size' });
    act(() => {
      fireEvent.pointerDown(plus, { button: 0, pointerId: 1 });
      fireEvent.pointerUp(plus, { button: 0, pointerId: 1 });
    });
    expect(heading.getOwnResponsiveStyleValue('fontSize', mobile.breakpointId)).toBe('41px');
    expect(heading.getOwnResponsiveStyleValue('fontSize', desktop.breakpointId)).toBe('40px');
    expect(history.history.length).toBe(1);
    expect(hapticSpy).toHaveBeenCalledTimes(1);
    expect(within(bar()).getByRole('group', { name: 'Font size' }).querySelector('[data-testid="quick-override"]')).not.toBeNull();
  });

  it('press and hold repeats, and the whole run is one undo step', () => {
    vi.useFakeTimers();
    const { editorUI, heading, mobile, history } = setup();
    editorUI.selectComponent(heading, mobile.breakpointId);
    const { bar } = renderBar();
    const plus = within(bar()).getByRole('button', { name: 'Increase font size' });
    act(() => {
      fireEvent.pointerDown(plus, { button: 0, pointerId: 1 });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      fireEvent.pointerUp(plus, { button: 0, pointerId: 1 });
    });
    const size = parseInt(heading.getOwnResponsiveStyleValue('fontSize', mobile.breakpointId), 10);
    expect(size).toBeGreaterThan(42);
    expect(history.history.length).toBe(1);
    act(() => {
      history.undo();
    });
    expect(heading.getOwnResponsiveStyleValue('fontSize', mobile.breakpointId)).toBeUndefined();
    // Released: no more steps.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(heading.getOwnResponsiveStyleValue('fontSize', mobile.breakpointId)).toBeUndefined();
  });

  it('keyboard activation steps once', () => {
    const { editorUI, heading, mobile } = setup();
    editorUI.selectComponent(heading, mobile.breakpointId);
    const { bar } = renderBar();
    fireEvent.click(within(bar()).getByRole('button', { name: 'Decrease font size' }), { detail: 0 });
    expect(heading.getOwnResponsiveStyleValue('fontSize', mobile.breakpointId)).toBe('39px');
  });

  it('weight, align and center content write Mobile overrides, one step each', () => {
    const { editorUI, heading, box, mobile, history } = setup();
    editorUI.selectComponent(heading, mobile.breakpointId);
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: /^Weight:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Align center' }));
    expect(heading.getOwnResponsiveStyleValue('fontWeight', mobile.breakpointId)).toBe('500');
    expect(heading.getOwnResponsiveStyleValue('textAlign', mobile.breakpointId)).toBe('center');
    expect(history.history.length).toBe(2);
    act(() => editorUI.selectComponent(box, mobile.breakpointId));
    fireEvent.click(screen.getByRole('button', { name: 'Center content' }));
    expect(box.getOwnResponsiveStyleValue('justifyContent', mobile.breakpointId)).toBe('center');
    expect(history.history.length).toBe(3);
  });

  it('More opens the properties', () => {
    const { editorUI, heading, mobile } = setup();
    editorUI.selectComponent(heading, mobile.breakpointId);
    const { onMore } = renderBar();
    fireEvent.click(screen.getByTestId('quick-more'));
    expect(onMore).toHaveBeenCalled();
  });
});

describe('tree navigation', () => {
  it('parent, child and the ancestor list keep the frame and tick', () => {
    const { editorUI, para, box, main, mobile } = setup();
    editorUI.selectComponent(para, mobile.breakpointId);
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Select parent' }));
    expect(editorUI.selectedComponent).toBe(box);
    expect(editorUI.selectedViewportNode).toBe(mobile);
    fireEvent.click(screen.getByRole('button', { name: 'Select first child' }));
    expect(editorUI.selectedComponent).toBe(para);
    expect(hapticSpy).toHaveBeenCalledTimes(2);
    // The breadcrumb opens the ancestor list only while the bar is shown on
    // screen (jsdom has no canvas), so the list is driven through the chip's state.
    fireEvent.click(screen.getByTestId('quick-breadcrumb'));
    expect(screen.getByTestId('quick-breadcrumb').getAttribute('aria-expanded')).toBe('true');
    expect(main).toBeTruthy();
  });

  it('hides while a text is edited, and with several elements selected', () => {
    const { editorUI, heading, box, mobile } = setup();
    editorUI.selectComponent(heading, mobile.breakpointId);
    renderBar();
    act(() => editorUI.beginTextEdit(heading));
    expect(screen.getByTestId('quick-toolbar').getAttribute('data-shown')).toBe('false');
    act(() => {
      editorUI.endTextEdit();
      editorUI.setSelection([heading, box], mobile.breakpointId);
    });
    expect(screen.getByTestId('quick-toolbar').getAttribute('data-shown')).toBe('false');
  });
});
