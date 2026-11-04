// Cmd/Ctrl+S while typing (review of 2026-11-04): the canvas's inline text
// editor and the properties panel's text field stop every keydown from
// bubbling, so the shortcut listens in the capture phase. It must keep the
// browser's "save page" dialog away there too, and the save must carry the
// text being typed (committed first, src/lib/projects/openDrafts.ts). Typing
// not committed yet also counts for the unload warning.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';
import { markServerVersion } from '@/stores/openProject';
import { autosaveFor, resetAutosaveForTests } from '@/lib/projects/autosave';
import type { ProjectWriteResult } from '@/lib/projects/projectWrite';
import { installSaveShortcut } from '@/lib/projects/saveShortcut';
import { hasOpenDrafts } from '@/lib/projects/openDrafts';
import ComponentRenderer from '../ComponentRenderer';
import { TextContentField } from '../sidebars/right/sections/TextContentSection';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

const sent: ProjectSnapshotOut[] = [];
const write = vi.fn(async (snapshot: unknown, expectedVersion: number | undefined): Promise<ProjectWriteResult> => {
  sent.push(snapshot as ProjectSnapshotOut);
  return { kind: 'ok', version: (expectedVersion ?? 0) + 1, payload: {} };
});

let heading: ComponentInstance;
let uninstall: () => void = () => {};

function pressSave(target: Element): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const sentText = () => JSON.stringify(sent.at(-1)?.pages ?? {});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  sent.length = 0;
  write.mockClear();
  resetAutosaveForTests({ write });
  store = createRootStore();
  store.projectStore.createProject('Typing');
  const project = store.projectStore.findProjectByTitle('Typing')!;
  const page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  heading = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
  heading.setProps({ children: 'Old words' });
  // Loaded from the server at version 1, watched by autosave.
  markServerVersion(project.id, getSnapshot(project), 1);
  autosaveFor(project.id).attach(project);
  uninstall = installSaveShortcut(window, store.editorUI);
});
afterEach(() => {
  uninstall();
  cleanup();
  resetAutosaveForTests();
  vi.restoreAllMocks();
});

describe('Cmd+S in the inline canvas editor', () => {
  it('prevents the browser dialog and saves the text being typed', () => {
    const page = store.editorUI.currentPage!;
    const breakpoints = page.sortedViewportNodes.map((v) => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth ?? 0 }));
    render(<ComponentRenderer component={page.appComponentTree as ComponentInstance} breakpointId={breakpoints[0].id} allBreakpoints={breakpoints} />);
    act(() => store.editorUI.beginTextEdit(heading));
    const box = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
    expect(box).toBeTruthy();
    box.focus();
    box.textContent = 'New words';
    expect(hasOpenDrafts()).toBe(true); // the unload warning counts it
    // The box's own keydown handler stops the key from bubbling; capture sees it first.
    const event = pressSave(box);
    expect(event.defaultPrevented).toBe(true);
    expect(heading.props.children).toBe('New words');
    expect(write).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('New words');
    expect(hasOpenDrafts()).toBe(false);
  });
});

describe('Cmd+S in the properties panel text field', () => {
  it('prevents the browser dialog and saves the typed draft', () => {
    const { getByLabelText } = render(<TextContentField node={heading} />);
    const field = getByLabelText('Text content') as HTMLTextAreaElement;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'Typed in the panel' } });
    expect(heading.props.children).toBe('Old words');
    expect(hasOpenDrafts()).toBe(true);
    const event = pressSave(field);
    expect(event.defaultPrevented).toBe(true);
    expect(heading.props.children).toBe('Typed in the panel');
    expect(write).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('Typed in the panel');
    expect(hasOpenDrafts()).toBe(false);
  });

  it('nothing typed: the dialog is still kept away and nothing is sent', () => {
    const { getByLabelText } = render(<TextContentField node={heading} />);
    const event = pressSave(getByLabelText('Text content'));
    expect(event.defaultPrevented).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
});
