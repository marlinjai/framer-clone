// The site's theme on the editor surfaces (docs/plans/2026-11-02-theme-and-head.md,
// "Canvas and preview", slice T3): the sheet, the frame's ground, the font faces, the
// switch, and the attributes on the mounted canvas and preview. What a browser computes
// from them is measured in Chromium by test/score/pageItems.canvas.score.ts.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ProjectModelType } from '@/models/ProjectModel';
import { surfaceColorMode, surfaceColorScheme, surfaceDarkClass, themeCss, themeFontFamilies, type SiteTheme, type ThemeMode } from '../theme';
import { surfaceFrameAttributes, surfaceThemeSheet } from '../surfaceTheme';
import { SurfaceThemeStyles } from '../SurfaceThemeStyles';
import PageFontFaces from '@/lib/fonts/PageFontFaces';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

// Imported after the mock, so the components read this test's store.
const { default: ColorModeSwitch } = await import('@/components/ColorModeSwitch');
const { default: ResponsivePageRenderer } = await import('@/components/ResponsivePageRenderer');
const { default: PreviewFrame } = await import('@/components/preview/PreviewFrame');

const ID = { ink: 'in000001', ground: 'gr000002', font: 'fo000003', gone: 'go000004' };
const ref = (id: string) => `var(--fc-t-${id})`;

function themeOf(mode: ThemeMode | undefined, document: SiteTheme['document'] = {}): SiteTheme {
  return {
    ...(mode ? { mode } : {}),
    tokens: [
      { id: ID.ink, name: 'Ink', kind: 'color', light: '#111111', dark: '#eeeeee' },
      { id: ID.ground, name: 'Ground', kind: 'color', light: '#ffffff', dark: '#000000' },
      { id: ID.font, name: 'Display', kind: 'font', family: 'fraunces' },
      { id: ID.gone, name: 'Old', kind: 'font', family: 'newsreader', deleted: true },
    ],
    document,
  };
}
const EMPTY: SiteTheme = { tokens: [], document: {} };

describe('the scheme a surface shows', () => {
  it('follows the site, and the switch only on a system site', () => {
    const table: Array<[ThemeMode | undefined, 'light' | 'dark', 'light' | 'dark', 'light' | 'dark' | undefined, boolean]> = [
      [undefined, 'light', 'light', undefined, false],
      [undefined, 'dark', 'light', undefined, false],
      ['system', 'light', 'light', 'light', false],
      ['system', 'dark', 'dark', 'dark', false],
      ['light', 'dark', 'light', 'light', false],
      ['dark', 'light', 'dark', 'dark', true],
    ];
    for (const [mode, previewed, scheme, answered, dark] of table) {
      expect(surfaceColorScheme(themeOf(mode), previewed), `${mode} ${previewed}`).toBe(scheme);
      expect(surfaceColorMode(themeOf(mode), previewed), `${mode} ${previewed}`).toBe(answered);
      expect(surfaceDarkClass(themeOf(mode)), `${mode}`).toBe(dark);
    }
    expect(surfaceColorScheme(undefined, 'dark')).toBe('light');
    expect(surfaceColorScheme({ mode: 'sepia' } as never, 'dark')).toBe('light');
  });
});

describe('surfaceThemeSheet', () => {
  it('is empty for a site with no theme, so nothing on the surface changes', () => {
    expect(surfaceThemeSheet(EMPTY, 'reset')).toBe('');
    expect(surfaceThemeSheet(EMPTY, 'browser')).toBe('');
  });

  it('writes the ground first, then the theme on the attribute, never on :root, html or body', () => {
    const theme = themeOf('system', { backgroundColor: ref(ID.ground) });
    const css = surfaceThemeSheet(theme, 'reset');
    expect(css.startsWith('[data-fc-theme=frame]:where(.dark){background-color:var(--background);color:var(--foreground)}')).toBe(true);
    expect(css.endsWith(themeCss(theme, { scope: 'surface' }))).toBe(true);
    expect(css).not.toMatch(/(^|[}\s,]):root|(^|[}\s,])html|(^|[}\s,])body/);
    expect(css).not.toContain('@font-face');
  });

  it('grounds a frame per base and mode, before the theme so the document block still wins', () => {
    const browserGround = '[data-fc-theme=frame]{background-color:Canvas;color:CanvasText}';
    const resetGround = '[data-fc-theme=frame]:where(.dark){background-color:var(--background);color:var(--foreground)}';
    for (const mode of [undefined, 'system', 'light', 'dark'] as const) {
      const browser = surfaceThemeSheet(themeOf(mode, { color: ref(ID.ink) }), 'browser');
      const reset = surfaceThemeSheet(themeOf(mode, { color: ref(ID.ink) }), 'reset');
      expect(browser.startsWith(browserGround), `browser ${mode}`).toBe(true);
      expect(reset.startsWith(resetGround), `reset ${mode}`).toBe(true);
      // The document block's colour comes after the ground at the same specificity.
      for (const sheet of [browser, reset]) expect(sheet.indexOf('color:var(--fc-t-in000001)')).toBeGreaterThan(sheet.indexOf('}'));
    }
  });

  it('gives a forced dark frame its dark values and a system frame both, by attribute', () => {
    expect(surfaceThemeSheet(themeOf('dark'), 'reset')).toContain('[data-fc-theme]{--fc-t-in000001:#eeeeee');
    const system = surfaceThemeSheet(themeOf('system'), 'reset');
    expect(system).toContain('[data-fc-theme]{--fc-t-in000001:#111111');
    expect(system).toContain('[data-fc-theme][data-fc-theme-mode=dark]{--fc-t-in000001:#eeeeee');
  });

  it('names a frame and a floating element apart', () => {
    expect(surfaceFrameAttributes('frame', 'dark')).toEqual({ 'data-fc-theme': 'frame', 'data-fc-theme-mode': 'dark' });
    expect(surfaceFrameAttributes('floating', 'light')).toEqual({ 'data-fc-theme': 'floating', 'data-fc-theme-mode': 'light' });
  });
});

describe('the font faces of a theme', () => {
  it('lists every font token the sheet holds, tombstones too, once, and only library families', () => {
    expect(themeFontFamilies(themeOf(undefined))).toEqual(['fraunces', 'newsreader']);
    const odd: SiteTheme = { tokens: [{ id: 'xx000001', name: 'A', kind: 'font', family: 'nope' }, { id: 'xx000002', name: 'B', kind: 'font', family: 'system' }], document: {} };
    expect(themeFontFamilies(odd)).toEqual([]);
    expect(themeFontFamilies(null as never)).toEqual([]);
  });

  it('PageFontFaces declares them beside the page\'s own', () => {
    const { container } = render(<PageFontFaces roots={[]} theme={themeOf(undefined)} />);
    const css = container.querySelector('style[data-fc-fonts]')?.textContent ?? '';
    expect(css).toMatch(/font-family:\s*'?Fraunces/);
    expect(css).toMatch(/font-family:\s*'?Newsreader/);
    cleanup();
    expect(render(<PageFontFaces roots={[]} />).container.querySelector('style')).toBeNull();
  });
});

describe('on the mounted surfaces', () => {
  let project: ProjectModelType;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    store = createRootStore();
    store.projectStore.createProject('Surface test');
    project = store.projectStore.findProjectByTitle('Surface test')!;
    store.editorUI.setCurrentProject(project);
    store.editorUI.setCurrentPage(project.findPageBySlug('')!);
    getHistoryStore()!.setTargetStore(project);
  });
  afterEach(() => cleanup());

  const setTheme = (theme: SiteTheme) => {
    const result = project.updateTheme(theme);
    if (!result.ok) throw new Error(result.errors.join('; '));
  };

  it('writes no sheet and no class for a site with no theme', () => {
    const { container } = render(<ResponsivePageRenderer />);
    expect(container.querySelector('style[data-fc-theme-sheet]')).toBeNull();
    for (const box of container.querySelectorAll('[data-viewport-content-id]')) {
      expect(box.getAttribute('data-fc-theme')).toBe('frame');
      expect(box.classList.contains('dark')).toBe(false);
    }
  });

  it('marks each frame\'s page box, never its label, and repaints on a token edit with no reload', () => {
    setTheme(themeOf('system', { color: ref(ID.ink) }));
    const { container } = render(<ResponsivePageRenderer />);
    const sheet = () => container.querySelector('style[data-fc-theme-sheet="surface"]')?.textContent ?? '';
    expect(sheet()).toContain('--fc-t-in000001:#111111');
    const boxes = [...container.querySelectorAll('[data-viewport-content-id]')];
    expect(boxes.length).toBeGreaterThan(1);
    for (const box of boxes) {
      expect(box.getAttribute('data-fc-theme')).toBe('frame');
      expect(box.getAttribute('data-fc-theme-mode')).toBe('light');
      // The frame's chrome and label sit outside the themed box.
      expect(box.closest('[data-viewport-id]')?.hasAttribute('data-fc-theme')).toBe(false);
    }
    act(() => setTheme({ ...themeOf('system', { color: ref(ID.ink) }), tokens: themeOf('system').tokens.map((t) => (t.id === ID.ink ? { ...t, light: '#222222' } : t)) }));
    expect(sheet()).toContain('--fc-t-in000001:#222222');
    act(() => store.editorUI.setPreviewColorMode('dark'));
    for (const box of container.querySelectorAll('[data-viewport-content-id]')) expect(box.getAttribute('data-fc-theme-mode')).toBe('dark');
    // Emptied live (each token deleted, then Clean up), the sheet goes.
    act(() => setTheme({ ...EMPTY, tokens: project.site.theme.tokens.map((t) => ({ ...t, deleted: true as const })) }));
    expect(sheet()).toContain('--fc-t-in000001:#222222');
    act(() => setTheme(EMPTY));
    expect(container.querySelector('style[data-fc-theme-sheet]')).toBeNull();
  });

  it('carries the dark class only on a site that forces dark, and floating elements never take a page', () => {
    setTheme(themeOf('dark', { backgroundColor: ref(ID.ground) }));
    const page = project.findPageBySlug('')!;
    const floatingBefore = page.floatingElements.length;
    page.addCanvasNode({ id: 'float1', type: 'div', componentType: 'host', canvasNodeType: 'floating', canvasX: 0, canvasY: 900, props: {}, children: [] } as never);
    expect(page.floatingElements).toHaveLength(floatingBefore + 1);
    const { container } = render(<ResponsivePageRenderer />);
    for (const box of container.querySelectorAll('[data-viewport-content-id]')) {
      expect(box.classList.contains('dark')).toBe(true);
      expect(box.getAttribute('data-fc-theme-mode')).toBe('dark');
    }
    const floating = [...container.querySelectorAll('[data-floating-root-id]')];
    expect(floating).toHaveLength(floatingBefore + 1);
    for (const box of floating) {
      expect(box.getAttribute('data-fc-theme')).toBe('floating');
      expect(box.classList.contains('dark')).toBe(true);
    }
    act(() => setTheme(themeOf('system', { backgroundColor: ref(ID.ground) })));
    act(() => store.editorUI.setPreviewColorMode('dark'));
    for (const box of container.querySelectorAll('[data-viewport-content-id]')) expect(box.classList.contains('dark')).toBe(false);
  });

  it('the preview frame takes the same attributes, sheet and font faces', () => {
    setTheme(themeOf('dark', { fontFamily: ref(ID.font) }));
    const page = project.findPageBySlug('')!;
    const { container } = render(<PreviewFrame page={page} width={1280} height={800} theme={project.site.theme} />);
    const frame = container.querySelector('[data-preview-frame]')!;
    expect(frame.getAttribute('data-fc-theme')).toBe('frame');
    expect(frame.getAttribute('data-fc-theme-mode')).toBe('dark');
    expect(frame.classList.contains('dark')).toBe(true);
    expect(frame.querySelector('style[data-fc-theme-sheet="surface"]')?.textContent).toContain('font-family:var(--fc-t-fo000003)');
    expect(frame.querySelector('style[data-fc-fonts]')?.textContent).toMatch(/Fraunces/);
  });

  it('SurfaceThemeStyles writes nothing for no theme', () => {
    expect(render(<SurfaceThemeStyles theme={undefined} base="reset" />).container.innerHTML).toBe('');
  });
});

describe('the switch', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    store = createRootStore();
    store.projectStore.createProject('Switch test');
    const project = store.projectStore.findProjectByTitle('Switch test')!;
    store.editorUI.setCurrentProject(project);
    store.editorUI.setCurrentPage(project.findPageBySlug('')!);
  });
  afterEach(() => cleanup());

  const setMode = (mode: ThemeMode | undefined) => {
    const project = store.editorUI.currentProject!;
    const result = project.updateTheme({ ...project.site.theme, ...(mode ? { mode } : {}), ...(mode ? {} : { mode: undefined }) });
    if (!result.ok) throw new Error(result.errors.join('; '));
  };

  it('shows only on a system site, and pressing it writes nothing to the project', () => {
    const { container, rerender } = render(<ColorModeSwitch />);
    expect(container.innerHTML).toBe('');
    act(() => setMode('dark'));
    rerender(<ColorModeSwitch />);
    expect(container.innerHTML).toBe('');
    act(() => setMode('system'));
    rerender(<ColorModeSwitch />);
    const dark = screen.getByRole('button', { name: 'Dark' });
    const light = screen.getByRole('button', { name: 'Light' });
    expect(light.getAttribute('aria-pressed')).toBe('true');
    expect(dark.getAttribute('aria-pressed')).toBe('false');
    const before = JSON.stringify(store.editorUI.currentProject!.site);
    fireEvent.click(dark);
    expect(store.editorUI.previewColorMode).toBe('dark');
    expect(dark.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.stringify(store.editorUI.currentProject!.site)).toBe(before);
  });
});
