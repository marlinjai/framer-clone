// A sandboxed custom code block in the mounted editor (plan
// docs/plans/2026-11-02-sandboxed-custom-code.md, slice C2): EditorApp with the
// real canvas and the real preview over the editor. In Select, in Interact and
// with the preview open, the block is a tile that links to the standalone
// preview, and the document holds no frame and no trace of the stored value.
// Only the chrome that draws nothing of the page (panels, bars, dialogs) is
// stood in for.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createRootStore, getDragManager, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { EditorTool } from '@/stores/EditorUIStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { CUSTOM_CODE_PREVIEW_LINK_TEXT, CUSTOM_CODE_TILE_TEXT } from '@/lib/renderer/customCode/customCodeElement';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => '/projects/site_1',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { Nothing } = vi.hoisted(() => ({ Nothing: () => null }));
vi.mock('@/components/sidebars/LeftSidebar', () => ({ default: Nothing }));
vi.mock('@/components/sidebars/RightSidebar', () => ({ default: Nothing }));
vi.mock('@/components/Toolbar', () => ({ default: Nothing }));
vi.mock('@/components/TopBar', () => ({ default: Nothing }));
vi.mock('@/components/PhoneEditorChrome', () => ({ default: Nothing }));
vi.mock('@/components/live/AgentPresenceLayer', () => ({ default: Nothing, AgentCameraFollow: Nothing }));
vi.mock('@/components/InlineFormatBar', () => ({ default: Nothing }));
vi.mock('@/components/HudSurface', () => ({ default: Nothing }));
vi.mock('@/components/SpacingHandlesLayer', () => ({ default: Nothing }));
vi.mock('@/lib/drag', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/drag')>()), DropIndicatorLayer: Nothing, DragGhostLayer: Nothing }));
vi.mock('@/components/EditorNotice', () => ({ default: Nothing }));
vi.mock('@/components/EditorAutosave', () => ({ default: Nothing }));
vi.mock('@/components/EditorLiveSync', () => ({ default: Nothing }));
vi.mock('@/components/ComponentBreadcrumb', () => ({ default: Nothing }));
vi.mock('@/components/ComponentDialogs', () => ({ default: Nothing }));
vi.mock('@/components/site/LegalTemplateNotice', () => ({ default: Nothing }));
vi.mock('@/components/ProductPreviewBar', () => ({ default: Nothing, ProductPreviewPicker: Nothing }));
vi.mock('@/components/ShopPreviewBar', () => ({ default: Nothing }));
vi.mock('@/components/EditorCommerceProvider', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/bindings/dataSource/prismaProvider', () => ({ getSharedPrismaDataSourceProvider: () => null }));
vi.mock('@/hooks/useEditorGestureGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useEditorGestureGuard')>()),
  useEditorGestureGuard: () => {},
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsPhone: () => false }));
vi.mock('mobx-devtools-mst', () => ({ default: () => {} }));

import EditorApp from '../EditorApp';

const HASH = '0123456789abcdef'.repeat(4);
const TITLE = 'Truck wash scene';

let block: ComponentInstance;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  (document as { elementsFromPoint?: Document['elementsFromPoint'] }).elementsFromPoint = () => [];
  store = createRootStore();
  render(<EditorApp />);
  const { projectStore, editorUI } = store;
  act(() => {
    projectStore.createProject('Custom code');
    const project = projectStore.findProjectByTitle('Custom code')!;
    const page = project.findPageBySlug('')!;
    editorUI.setCurrentProject(project);
    editorUI.setCurrentPage(page);
    const root = page.appComponentTree as ComponentInstance;
    const main = root.children[0] as ComponentInstance;
    main.addChildren([
      createIntrinsicComponent('cc-block', 'div', {
        customCode: { sha256: HASH, title: TITLE },
        style: { width: '320px', height: '200px' },
      }),
    ]);
    block = main.children.find((c: ComponentInstance) => c.id === 'cc-block') as ComponentInstance;
    // The fallback, and a stored frame and srcdoc a page could carry beside it.
    block.addChildren([
      createIntrinsicComponent('cc-fallback', 'p', { children: 'The fallback text' }),
      createIntrinsicComponent('cc-frame', 'iframe', { src: 'https://evil.example/', srcdoc: '<p>x</p>' }),
    ]);
    getDragManager()!.wire({
      getTransform: () => ({ panX: 0, panY: 0, zoom: 1 }),
      getPage: () => store.editorUI.currentPage,
      getHistory: () => getHistoryStore(),
      getEditorUI: () => store.editorUI,
    });
  });
});

afterEach(() => {
  getDragManager()?.cancel();
  cleanup();
  vi.restoreAllMocks();
  delete (document as { elementsFromPoint?: Document['elementsFromPoint'] }).elementsFromPoint;
});

function expectTilesAndNoFrame(where: ParentNode = document) {
  const tiles = [...where.querySelectorAll('[data-fc-custom-code-tile]')];
  expect(tiles.length).toBeGreaterThan(0);
  for (const tile of tiles) {
    expect(tile.textContent).toContain(CUSTOM_CODE_TILE_TEXT);
    expect(tile.textContent).toContain(TITLE);
    const link = tile.querySelector('a[data-fc-custom-code-preview]');
    expect(link?.getAttribute('href')).toBe(`/projects/${encodeURIComponent(store.editorUI.currentProject!.id)}/preview?page=${encodeURIComponent(store.editorUI.currentPage!.id)}`);
    expect(link?.textContent).toBe(CUSTOM_CODE_PREVIEW_LINK_TEXT);
  }
  expect(document.querySelectorAll('iframe, frame, object, embed')).toHaveLength(0);
  const html = document.documentElement.outerHTML;
  expect(html).not.toContain(HASH);
  expect(html).not.toContain('customCode');
  expect(html).not.toContain('customcode');
  expect(html).not.toContain('srcdoc');
  expect(html).not.toContain('evil.example');
  // No published mark on an editor surface.
  expect(document.querySelectorAll('[data-fc-custom-code]')).toHaveLength(0);
}

describe('a custom code block in the mounted editor', () => {
  it('is a tile on the canvas in Select, never a frame', () => {
    act(() => store.editorUI.setSelectedTool(EditorTool.SELECT));
    expectTilesAndNoFrame();
    // The tile carries the box's identity, so the canvas selects it like any box.
    const element = document.querySelector('[data-inner-component-id="cc-block"]');
    expect(element?.querySelector('[data-fc-custom-code-tile]')).not.toBeNull();
    expect(element?.getAttribute('aria-label')).toBe(`${CUSTOM_CODE_TILE_TEXT}: ${TITLE}`);
  });

  it('is a tile on the canvas in Interact, where the page runs', () => {
    act(() => store.editorUI.setSelectedTool(EditorTool.INTERACT));
    expect(store.editorUI.interactOn).toBe(true);
    expectTilesAndNoFrame();
  });

  it('is a tile in the preview over the editor too', () => {
    act(() => store.editorUI.setPreviewOpen(true));
    const overlay = document.querySelector('[data-testid="preview-overlay"]');
    expect(overlay).not.toBeNull();
    expectTilesAndNoFrame(overlay!);
  });
});
