'use client';

import { reaction } from 'mobx';
import React from 'react';
import Canvas from "@/components/Canvas";
import LeftSidebar from "@/components/sidebars/LeftSidebar";
import RightSidebar from "@/components/sidebars/RightSidebar";
import Toolbar from "@/components/Toolbar";
import TopBar from "@/components/TopBar";
import PhoneEditorChrome from "@/components/PhoneEditorChrome";
import { useIsPhone } from "@/hooks/use-mobile";
import HudSurface from "@/components/HudSurface";
import AgentPresenceLayer, { AgentCameraFollow } from "@/components/live/AgentPresenceLayer";
import SpacingHandlesLayer from "@/components/SpacingHandlesLayer";
import { TransformProvider, useTransformContext } from '@/contexts/TransformContext';
import { DropIndicatorLayer, DragGhostLayer } from '@/lib/drag';
import makeInspectable from 'mobx-devtools-mst';
import { EditorTool } from '@/stores/EditorUIStore';
import { getUndoManager, getHistoryStore, getDragManager } from '@/stores/RootStore';
import { changedElsewhereMessage, openProject, pageIdFromLocation, pickPage, restoreStashedDemo } from '@/stores/openProject';
import EditorNotice from './EditorNotice';
import EditorAutosave from './EditorAutosave';
import EditorLiveSync from './EditorLiveSync';
import ComponentBreadcrumb from './ComponentBreadcrumb';
import ComponentDialogs from './ComponentDialogs';
import { requestCreateComponent } from '@/lib/components/editorCommands';
import { isPlacementType, type PlacementProps } from '@/lib/components/placement';
import InlineFormatBar from './InlineFormatBar';
import LegalTemplateNotice from './site/LegalTemplateNotice';
import { resolveAction } from '@/lib/keyBindings';
import { installSaveShortcut } from '@/lib/projects/saveShortcut';
import { bindSpacePan, isActivatableControl } from '@/lib/canvas/spacePan';
import { pageContentOf } from '@/lib/canvas/interactShim';
import { deleteSelection, routeFxLayerShortcut } from '@/lib/canvas/deleteSelection';
import { duplicateLayer } from '@/lib/layers/layerActions';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { getSharedPrismaDataSourceProvider } from '@/lib/bindings/dataSource/prismaProvider';
import EditorCommerceProvider from '@/components/EditorCommerceProvider';
import ProductPreviewBar from '@/components/ProductPreviewBar';
import ShopPreviewBar from '@/components/ShopPreviewBar';
import PreviewOverlay, { previewRequestedInLocation } from '@/components/preview/PreviewOverlay';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';

import { useStore } from "@/hooks/useStore";
import { useEditorGestureGuard } from '@/hooks/useEditorGestureGuard';

// Wires the DragManager with runtime dependencies. Must mount inside
// TransformProvider to reach the transform ref. Returns null to stay out of
// the DOM.
const DragManagerBinding: React.FC = () => {
  const rootStore = useStore();
  const { state: transformState } = useTransformContext();

  React.useEffect(() => {
    const manager = getDragManager();
    if (!manager) return;
    manager.wire({
      getTransform: () => transformState.current,
      getPage: () => rootStore.editorUI.currentPage,
      getHistory: () => getHistoryStore(),
      getEditorUI: () => rootStore.editorUI,
    });
  }, [rootStore, transformState]);

  return null;
};

/** Write `?page=<id>` into the current address without navigating. */
function syncPageParam(pageId: string | undefined) {
  if (!pageId || typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (url.searchParams.get('page') === pageId) return;
  url.searchParams.set('page', pageId);
  window.history.replaceState(window.history.state, '', url.toString());
}

/**
 * A server-loaded project comes with the site version read alongside it (the
 * version lock, see openProject); the demo editor at `/` passes neither.
 */
type EditorAppProps =
  | { projectSnapshot: ProjectSnapshotOut; projectVersion: number }
  | { projectSnapshot?: undefined; projectVersion?: undefined };

export default function EditorApp({ projectSnapshot, projectVersion }: EditorAppProps = {}) {
  const rootStore = useStore();
  // Browser page zoom off inside the editor; the canvas has its own.
  useEditorGestureGuard();
  const initRef = React.useRef(false);
  // Phones get the canvas-first layout: a bottom bar and the panels as sheets
  // (plan docs/plans/2026-10-24-editor-on-phones.md).
  const isPhone = useIsPhone();
  makeInspectable(rootStore);
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    (window as unknown as { __rootStore?: typeof rootStore }).__rootStore = rootStore;
  }

  if (!initRef.current) {
    const { editorUI, projectStore } = rootStore;
    // Which page to open: `?page=<id>` (Preview's "Editor" link carries it),
    // else the home page.
    const requestedPageId = pageIdFromLocation();
    const previousProjectId = editorUI.currentProject?.id;
    let missingPageId: string | undefined;
    if (projectSnapshot) {
      // Hydration path (MT-08 / MT-10), see src/stores/openProject.ts: the
      // server snapshot, or this tab's working copy when the server has
      // nothing newer (unsaved work, such as a page just generated, survives
      // a trip to Preview). openProject also owns the undo-history rules.
      const opened = openProject(rootStore, projectSnapshot, requestedPageId, projectVersion);
      missingPageId = opened.missingPageId;
      if (opened.changedElsewhere) {
        editorUI.setEditorNotice({
          kind: 'changedElsewhere',
          message: changedElsewhereMessage(opened.changedDefinitions, opened.changedSiteParts),
        });
      }
    } else {
      // The standalone demo editor (`/`).
      const consumed = editorUI.consumedDemoProjectId;
      if (consumed) {
        // Already saved as a real project: start over with a fresh demo.
        projectStore.removeProject(consumed);
      }
      const demoId = editorUI.demoProjectId;
      if (demoId && projectStore.getProject(demoId)) {
        // Back from its preview, or from elsewhere in this tab: keep the demo
        // project and everything done in it, never seed a second one.
        const project = projectStore.getProject(demoId);
        editorUI.setCurrentProject(project);
        const picked = pickPage(project, requestedPageId);
        missingPageId = picked.missingPageId;
        editorUI.setCurrentPage(picked.page);
      } else if (!restoreStashedDemo(rootStore, requestedPageId)) {
        // Nothing to come back to (the stash covers a trip through sign-in or
        // the company chooser): seed the demo project.
        projectStore.createProject('Framer Clone Demo', 'Sample project with component tree');
        const demo = projectStore.findProjectByTitle('Framer Clone Demo');
        editorUI.setCurrentProject(demo);
        editorUI.setCurrentPage(demo?.findPageBySlug(''));
        // It exists only in this browser: the top bar offers "Keep as project".
        if (demo) editorUI.markUnsavedDemo(demo.id);
      }
      // Undo history belongs to one project: a different one (or a seeded
      // demo, whose creation is not something to undo) starts it afresh.
      if (previousProjectId !== editorUI.currentProject?.id || !demoId) getHistoryStore()?.clear();
    }
    // A reload with the preview open (`?preview=1`) comes back to it.
    if (previewRequestedInLocation()) editorUI.setPreviewOpen(true);
    if (missingPageId) {
      editorUI.setEditorNotice({
        kind: 'missingPage',
        message: 'The page in the address is not in this project (it may not have been saved), so the home page is open.',
      });
    }
    initRef.current = true;
  }

  // Keep `?page=` in the address in step with the page shown, so a reload
  // or a shared link opens the same page (without a server round trip).
  React.useEffect(
    () =>
      reaction(
        () => rootStore.editorUI.addressPageId,
        (pageId) => syncPageParam(pageId),
        { fireImmediately: true },
      ),
    [rootStore],
  );

  // Shift+Escape leaves Interact from anywhere: at the window, in capture, before the page
  // or a modal it opened hears it, also with focus held in a frame. It never yields.
  React.useEffect(() => {
    const ui = rootStore.editorUI;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || !ui.interactOn) return;
      e.preventDefault();
      e.stopPropagation();
      ui.setSelectedTool(EditorTool.SELECT);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [rootStore.editorUI]);

  // Single keydown listener dispatching through the keybindings registry. The
  // registry (src/lib/keyBindings.ts) owns the key → action mapping so a future
  // settings page can rebind without touching this file.
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Suppress editor shortcuts while a drag gesture is active so the user
      // can't accidentally delete the source mid-drag or undo into inconsistent
      // state. DragManager's own Escape handler still fires (it listens with
      // capture, so it sees the event before bubbling).
      if (getDragManager()?.isActive) return;
      // The preview over the editor has its own keys (PreviewOverlay).
      if (rootStore.editorUI.previewOpen) return;
      // In Interact a key in a frame is the page's: Escape closes its dialog, a letter is typed.
      if (rootStore.editorUI.interactOn && pageContentOf(e.target)) return;

      const match = resolveAction(e);
      if (!match) return;

      if (match.action === 'delete') {
        if (rootStore.editorUI.selectedTool === EditorTool.GRAB) return;
        const page = rootStore.editorUI.currentPage;
        if (!page || rootStore.editorUI.selectedComponentList.length === 0) return;
        e.preventDefault();
        // A picked layer of an FX scene is deleted instead of the box.
        if (routeFxLayerShortcut('delete', rootStore.editorUI)) return;
        // Every selected node, as one undo step.
        deleteSelection(page, rootStore.editorUI, getHistoryStore());
        return;
      }

      if (match.action === 'duplicate') {
        // Always swallow Cmd+D so the browser never opens its bookmark dialog.
        e.preventDefault();
        if (rootStore.editorUI.selectedTool === EditorTool.GRAB) return;
        const page = rootStore.editorUI.currentPage;
        if (!page || rootStore.editorUI.selectedComponentList.length === 0) return;
        // A picked layer of an FX scene is copied instead of the box.
        if (routeFxLayerShortcut('duplicate', rootStore.editorUI)) return;
        // Every selected node, as one undo step; the copies become the selection.
        duplicateLayer(page, rootStore.editorUI, getHistoryStore());
        return;
      }

      if (match.action === 'clearSelection') {
        const ui = rootStore.editorUI;
        // A dialog, menu or gesture that handled Escape itself has the last
        // word; so does an active resize (its own Escape restores the size).
        if (e.defaultPrevented || ui.isResizing) return;
        // A picked layer of an FX scene: Escape is back to the box.
        if (routeFxLayerShortcut('clearSelection', ui)) return;
        // With focus outside every frame, Escape ends Interact.
        if (ui.interactOn) {
          ui.setSelectedTool(EditorTool.SELECT);
          return;
        }
        // In a definition, Escape first lets go of what was picked, as everywhere,
        // and then leaves. Opening one selects its root, which counts as nothing
        // picked, so Escape straight after entering goes back out.
        const picked = ui.selectedComponentList.some(node => node !== ui.currentPage?.appComponentTree);
        if (ui.inComponent && !picked) {
          ui.leaveComponent();
          return;
        }
        if (!ui.selectedComponent && !ui.selectedViewportNode && ui.selectedComponentList.length === 0) return;
        ui.clearSelection();
        return;
      }

      if (match.action === 'fxLayerForward' || match.action === 'fxLayerBackward' || match.action === 'renameLayer') {
        // Only with a layer of an FX scene picked; otherwise the key is not ours.
        if (rootStore.editorUI.selectedTool === EditorTool.GRAB || e.defaultPrevented) return;
        if (routeFxLayerShortcut(match.action, rootStore.editorUI)) e.preventDefault();
        return;
      }

      if (match.action === 'enterComponent') {
        const ui = rootStore.editorUI;
        const selected = ui.selectedComponent;
        // A focused control keeps its own Enter.
        if (e.defaultPrevented || !selected || !isPlacementType(selected.type) || ui.selectedTool !== EditorTool.SELECT) return;
        if (isActivatableControl(e.target)) return;
        e.preventDefault();
        ui.enterComponent((selected.props as Partial<PlacementProps>).component ?? '', selected.id);
        return;
      }

      if (match.action === 'createComponent') {
        e.preventDefault();
        if (rootStore.editorUI.selectedTool === EditorTool.GRAB || rootStore.editorUI.componentRequest) return;
        requestCreateComponent(rootStore.editorUI);
        return;
      }

      if (match.action === 'selectTool' || match.action === 'grabTool') {
        e.preventDefault();
        rootStore.editorUI.setSelectedTool(match.action === 'selectTool' ? EditorTool.SELECT : EditorTool.GRAB);
        return;
      }

      if (match.action === 'undo') {
        const um = getUndoManager();
        if (um?.canUndo) {
          e.preventDefault();
          um.undo();
        }
        return;
      }

      if (match.action === 'redo') {
        const um = getUndoManager();
        if (um?.canRedo) {
          e.preventDefault();
          um.redo();
        }
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rootStore.editorUI]);

  // Cmd/Ctrl+S in the capture phase, before any field can stop the key: the
  // browser's "save page" dialog must never open over the editor (also
  // mid-drag, in the preview or while typing). It saves at once
  // (src/lib/projects/saveShortcut.ts).
  React.useEffect(() => installSaveShortcut(window, rootStore.editorUI), [rootStore.editorUI]);

  // Hold Space to pan; a focused control, a field, a dialog or a menu keeps
  // its own Space (src/lib/canvas/spacePan.ts).
  React.useEffect(
    () => bindSpacePan(rootStore.editorUI, window, () => !!getDragManager()?.isActive),
    [rootStore.editorUI],
  );

  return (
    <DataSourceProviderContext.Provider value={getSharedPrismaDataSourceProvider()}>
    <EditorCommerceProvider>
    <TransformProvider>
      {/* First in the shell: the autosave lifetime (watching the project,
          committing typed text and saving when the editor closes). */}
      <EditorAutosave />
      {/* The open site followed live: other writers' versions adopted as undo steps. */}
      <EditorLiveSync />
      <DragManagerBinding />
      <ComponentDialogs />

    <div className="relative w-screen h-screen">
      <Canvas />

      {/* Where an agent works (live agent canvas): its frame and label, under the
          selection's overlays, and the camera following it. */}
      <AgentPresenceLayer />
      <AgentCameraFollow />

      {/* Framer-style HudSurface for overlays (outside canvas) */}
      <HudSurface />

      {/* Padding, margin and gap bands with drag handles for the selection */}
      <SpacingHandlesLayer />

      {/* Drag overlays. Single painters shared by every drag source.
          Render nothing unless a gesture is active. */}
      <DropIndicatorLayer />
      <DragGhostLayer />
      <InlineFormatBar />

      <TopBar />
      {/* Notices stack under the top bar (48px on a phone, 64px otherwise),
          centred, each at most 640px and never wider than the screen. */}
      <div className="pointer-events-none fixed inset-x-0 top-16 z-90 mt-2 flex flex-col items-center gap-2 px-4 phone:top-12">
        <ComponentBreadcrumb />
        <EditorNotice />
        <LegalTemplateNotice />
        <ProductPreviewBar />
        <ShopPreviewBar />
      </div>
      {isPhone ? (
        <PhoneEditorChrome editorUI={rootStore.editorUI} />
      ) : (
        <>
          {/* Docked panels and the floating toolbar. `phone:hidden` keeps them
              off a phone's screen during the server render and hydration,
              before useIsPhone can report the real width. */}
          <div data-editor-ui="true" data-editor-chrome="left" className="fixed top-16 left-0 bottom-0 z-90 phone:hidden">
            <LeftSidebar />
          </div>
          <div data-editor-ui="true" data-editor-chrome="right" className="fixed top-16 right-0 bottom-0 z-90 phone:hidden">
            <RightSidebar />
          </div>
          <div data-editor-ui="true" className="fixed bottom-0 left-0 right-0 z-30 phone:hidden">
            <Toolbar editorUI={rootStore.editorUI} />
          </div>
        </>
      )}
      {/* Preview over the editor, from this store (PreviewOverlay). */}
      <PreviewOverlay />
    </div>
    </TransformProvider>
    </EditorCommerceProvider>
    </DataSourceProviderContext.Provider>
  );
}