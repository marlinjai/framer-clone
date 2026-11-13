// The editor's own key handling (EditorApp's keydown listener) with a layer of an FX scene
// picked in the Layers panel: Delete removes the LAYER and not the box, Cmd+D copies the layer,
// Escape goes back to the box, Alt+Up moves the layer, and F2 starts its rename. EditorApp is
// mounted for real on a real root store; only the heavy children that draw (canvas, panels,
// overlays, dialogs) are stood in for by empty components, because they own none of the keys.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import { EditorTool } from '@/stores/EditorUIStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { FX_PROP, parseFxProp } from '@/lib/fxScene/fxScene';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

const { Nothing } = vi.hoisted(() => ({ Nothing: () => null }));
vi.mock('@/components/Canvas', () => ({ default: Nothing }));
vi.mock('@/components/sidebars/LeftSidebar', () => ({ default: Nothing }));
vi.mock('@/components/sidebars/RightSidebar', () => ({ default: Nothing }));
vi.mock('@/components/Toolbar', () => ({ default: Nothing }));
vi.mock('@/components/TopBar', () => ({ default: Nothing }));
vi.mock('@/components/PhoneEditorChrome', () => ({ default: Nothing }));
vi.mock('@/components/HudSurface', () => ({ default: Nothing }));
vi.mock('@/components/live/AgentPresenceLayer', () => ({ default: Nothing, AgentCameraFollow: Nothing }));
vi.mock('@/components/SpacingHandlesLayer', () => ({ default: Nothing }));
vi.mock('@/components/InlineFormatBar', () => ({ default: Nothing }));
vi.mock('@/components/EditorNotice', () => ({ default: Nothing }));
vi.mock('@/components/EditorAutosave', () => ({ default: Nothing }));
vi.mock('@/components/EditorLiveSync', () => ({ default: Nothing }));
vi.mock('@/components/ComponentBreadcrumb', () => ({ default: Nothing }));
vi.mock('@/components/ComponentDialogs', () => ({ default: Nothing }));
vi.mock('@/components/site/LegalTemplateNotice', () => ({ default: Nothing }));
vi.mock('@/components/ProductPreviewBar', () => ({ default: Nothing }));
vi.mock('@/components/ShopPreviewBar', () => ({ default: Nothing }));
vi.mock('@/components/preview/PreviewOverlay', () => ({ default: Nothing, previewRequestedInLocation: () => false }));
vi.mock('@/components/EditorCommerceProvider', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/bindings/dataSource/prismaProvider', () => ({ getSharedPrismaDataSourceProvider: () => null }));
vi.mock('@/hooks/useEditorGestureGuard', () => ({ useEditorGestureGuard: () => {} }));
vi.mock('@/hooks/use-mobile', () => ({ useIsPhone: () => false }));
vi.mock('mobx-devtools-mst', () => ({ default: () => {} }));
vi.mock('@/lib/drag', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/drag')>()), DropIndicatorLayer: Nothing, DragGhostLayer: Nothing }));

import EditorApp from '../EditorApp';

let box: ComponentInstance;
const layers = () => {
  const read = parseFxProp((box.props as Record<string, unknown>)[FX_PROP]);
  if (!read.ok) throw new Error(read.message);
  return read.fx.scene.layers;
};
const ui = () => store.editorUI;
const key = (init: KeyboardEventInit & { key: string }) => fireEvent.keyDown(document.body, init);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  render(<EditorApp />);
  const page = ui().currentPage!;
  getHistoryStore()!.setTargetStore(store.projectStore);
  box = page.insertRegistryComponent('fxScene', { kind: 'appTree' })!;
  ui().setSelectedTool(EditorTool.SELECT);
  getHistoryStore()!.clear();
  act(() => ui().pickFxLayer(box, { kind: 'layer', layerId: 'bloom' }, page.sortedViewportNodes[0].breakpointId!));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the editor\'s keys with a layer of an FX scene picked', () => {
  it('Delete removes the layer, not the box; undo brings the layer back', () => {
    key({ key: 'Delete' });
    expect(ui().currentPage!.findComponent(box.id)).toBeDefined();
    expect(layers().some((l) => l.id === 'bloom')).toBe(false);
    act(() => getHistoryStore()!.undo());
    expect(layers().some((l) => l.id === 'bloom')).toBe(true);
    expect(ui().currentPage!.findComponent(box.id)).toBeDefined();
  });

  it('Backspace does the same, and a held key (repeats) walks down the layers and stops at Background without ever removing the box', () => {
    const start = layers().length;
    key({ key: 'Backspace' });
    expect(layers()).toHaveLength(start - 1);
    expect(layers().some((l) => l.id === 'bloom')).toBe(false);
    for (let i = 1; i < 12; i++) key({ key: 'Backspace', repeat: true });
    expect(ui().currentPage!.findComponent(box.id)).toBeDefined();
    expect(layers().length).toBeLessThan(start - 1);
    expect(ui().fxLayerPick).toMatchObject({ kind: 'background' });
  });

  it('Cmd+D copies the layer and the copy is picked; the box is not duplicated (with no pick it is: the control case)', () => {
    const scenes = () => {
      let count = 0;
      const walk = (n: ComponentInstance) => {
        if ((n.props as Record<string, unknown>)['data-fx'] === 'scene') count += 1;
        (n.children as ComponentInstance[]).forEach(walk);
      };
      walk(ui().currentPage!.appComponentTree as ComponentInstance);
      return count;
    };
    expect(scenes()).toBe(1);
    key({ key: 'd', metaKey: true });
    expect(layers().filter((l) => l.name.startsWith('Bloom'))).toHaveLength(2);
    expect(scenes()).toBe(1);
    expect(ui().fxLayerPick).toMatchObject({ kind: 'layer' });
    act(() => ui().clearFxLayerPick());
    key({ key: 'd', metaKey: true });
    expect(scenes()).toBe(2);
  });

  it('Escape returns to the box; the next Escape is the editor\'s own', () => {
    key({ key: 'Escape' });
    expect(ui().fxLayerPick).toBeUndefined();
    expect(ui().selectedComponent?.id).toBe(box.id);
    key({ key: 'Escape' });
    expect(ui().selectedComponent).toBeUndefined();
  });

  it('Alt+Up moves the layer within its group and F2 starts its rename', () => {
    key({ key: 'ArrowUp', altKey: true });
    const effects = layers().filter((l) => ['Bloom', 'Vignette', 'Grain'].includes(l.name)).map((l) => l.name);
    expect(effects).toEqual(['Vignette', 'Bloom', 'Grain']);
    key({ key: 'F2' });
    expect(ui().fxLayerRenaming).toEqual({ componentId: box.id, layerId: 'bloom' });
  });

  it('with the grab tool Delete and Cmd+D do nothing at all, to the layer or the box', () => {
    ui().setSelectedTool(EditorTool.GRAB);
    const before = JSON.stringify(layers());
    key({ key: 'Delete' });
    key({ key: 'd', metaKey: true });
    expect(JSON.stringify(layers())).toBe(before);
    expect(ui().currentPage!.findComponent(box.id)).toBeDefined();
  });

  it('Alt+Up and Delete typed in a text field are the field\'s, not the layer\'s', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const before = JSON.stringify(layers());
    fireEvent.keyDown(input, { key: 'Delete' });
    fireEvent.keyDown(input, { key: 'ArrowUp', altKey: true });
    expect(JSON.stringify(layers())).toBe(before);
    input.remove();
  });

  it('with no layer picked Delete keeps removing the box', () => {
    act(() => ui().clearFxLayerPick());
    key({ key: 'Delete' });
    expect(ui().currentPage!.findComponent(box.id)).toBeUndefined();
  });
});
