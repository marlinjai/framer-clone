// The mode the canvas and the preview show (docs/plans/2026-11-02-theme-and-head.md,
// "The mode on the canvas", slice T3), through the four paths of the stateful flow
// standard. A switch is editor state only: it writes no project byte and no undo step.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '../RootStore';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { SiteTheme, ThemeMode } from '@/lib/site/theme';

let store: RootStoreType;
let project: ProjectModelType;

const ui = () => store.editorUI;
const INK = 'in000001';

function themeOf(mode: ThemeMode | undefined): SiteTheme {
  return { ...(mode ? { mode } : {}), tokens: [{ id: INK, name: 'Ink', kind: 'color', light: '#111111', dark: '#eeeeee' }], document: {} };
}

function setMode(mode: ThemeMode | undefined): void {
  const result = project.updateTheme(themeOf(mode));
  if (!result.ok) throw new Error(result.errors.join('; '));
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('Mode test');
  project = store.projectStore.findProjectByTitle('Mode test')!;
  ui().setCurrentProject(project);
  ui().setCurrentPage(project.findPageBySlug('')!);
  getHistoryStore()!.setTargetStore(project);
});

describe('forward', () => {
  it('a system site shows the mode the switch picks', () => {
    setMode('system');
    expect(ui().frameColorScheme).toBe('light');
    expect(ui().frameColorMode).toBe('light');
    ui().setPreviewColorMode('dark');
    expect(ui().frameColorScheme).toBe('dark');
    expect(ui().frameColorMode).toBe('dark');
    expect(ui().frameDarkClass).toBe(false);
  });

  it('a forced site shows its own mode, whatever the switch holds', () => {
    ui().setPreviewColorMode('dark');
    setMode('light');
    expect(ui().frameColorScheme).toBe('light');
    expect(ui().frameColorMode).toBe('light');
    ui().setPreviewColorMode('light');
    setMode('dark');
    expect(ui().frameColorScheme).toBe('dark');
    expect(ui().frameColorMode).toBe('dark');
    expect(ui().frameDarkClass).toBe(true);
  });

  it('a site with no choice shows light and answers no colour scheme rule', () => {
    ui().setPreviewColorMode('dark');
    setMode(undefined);
    expect(ui().frameColorScheme).toBe('light');
    expect(ui().frameColorMode).toBeUndefined();
    expect(ui().frameDarkClass).toBe(false);
  });
});

describe('backtrack', () => {
  it('switching changes no project byte and adds no undo step', () => {
    setMode('system');
    const before = JSON.stringify(getSnapshot(project));
    const steps = getHistoryStore()!.history.length;
    ui().setPreviewColorMode('dark');
    ui().setPreviewColorMode('light');
    ui().setPreviewColorMode('dark');
    expect(JSON.stringify(getSnapshot(project))).toBe(before);
    expect(getHistoryStore()!.history.length).toBe(steps);
  });

  it('a site that goes from system to forced and back shows the switch again', () => {
    setMode('system');
    ui().setPreviewColorMode('dark');
    setMode('light');
    expect(ui().frameColorScheme).toBe('light');
    setMode('system');
    expect(ui().frameColorScheme).toBe('dark');
  });

  it('refuses anything but the two modes', () => {
    ui().setPreviewColorMode('sepia' as never);
    expect(ui().previewColorMode).toBe('light');
  });
});

describe('resume', () => {
  it('is never part of the saved editor state, so a reload opens on light', () => {
    setMode('system');
    ui().setPreviewColorMode('dark');
    expect(JSON.stringify(getSnapshot(ui()))).not.toContain('previewColorMode');
    const fresh = createRootStore();
    expect(fresh.editorUI.previewColorMode).toBe('light');
  });
});

describe('re-entry', () => {
  it('keeps the choice across leaving the preview and coming back', () => {
    setMode('system');
    ui().setPreviewColorMode('dark');
    ui().setPreviewOpen(true);
    expect(ui().frameColorScheme).toBe('dark');
    ui().setPreviewOpen(false);
    ui().setPreviewOpen(true);
    expect(ui().frameColorScheme).toBe('dark');
  });

  it('a theme emptied live returns to no choice', () => {
    setMode('dark');
    const result = project.updateTheme({ tokens: themeOf(undefined).tokens, document: {} });
    expect(result.ok).toBe(true);
    expect(ui().frameDarkClass).toBe(false);
    expect(ui().frameColorMode).toBeUndefined();
  });
});
