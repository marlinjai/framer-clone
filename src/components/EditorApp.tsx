'use client';

import { reaction } from 'mobx';
import React from 'react';
import Canvas from "@/components/Canvas";
import LeftSidebar from "@/components/sidebars/LeftSidebar";
import RightSidebar from "@/components/sidebars/RightSidebar";
import Toolbar from "@/components/Toolbar";
import TopBar from "@/components/TopBar";
import HudSurface from "@/components/HudSurface";
import { TransformProvider, useTransformContext } from '@/contexts/TransformContext';
import { DropIndicatorLayer, DragGhostLayer } from '@/lib/drag';
import makeInspectable from 'mobx-devtools-mst';
import { EditorTool } from '@/stores/EditorUIStore';
import { getUndoManager, getHistoryStore, getDragManager } from '@/stores/RootStore';
import { openProject, pageIdFromLocation, pickPage, restoreStashedDemo } from '@/stores/openProject';
import EditorNotice from './EditorNotice';
import { resolveAction } from '@/lib/keyBindings';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { getSharedPrismaDataSourceProvider } from '@/lib/bindings/dataSource/prismaProvider';
import EditorCommerceProvider from '@/components/EditorCommerceProvider';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';

import { useStore } from "@/hooks/useStore";

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

export default function EditorApp({ projectSnapshot }: { projectSnapshot?: ProjectSnapshotOut } = {}) {
  const rootStore = useStore();
  const initRef = React.useRef(false);
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
      const opened = openProject(rootStore, projectSnapshot, requestedPageId);
      missingPageId = opened.missingPageId;
      if (opened.changedElsewhere) {
        editorUI.setEditorNotice({
          kind: 'changedElsewhere',
          message:
            'This project was saved somewhere else since this tab loaded it, and this tab has unsaved changes too. Saving here overwrites the other changes; loading the newer version discards the unsaved changes in this tab.',
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
        // It exists only in this browser: Save offers "Save as a new project".
        if (demo) editorUI.markUnsavedDemo(demo.id);
      }
      // Undo history belongs to one project: a different one (or a seeded
      // demo, whose creation is not something to undo) starts it afresh.
      if (previousProjectId !== editorUI.currentProject?.id || !demoId) getHistoryStore()?.clear();
    }
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
        () => rootStore.editorUI.currentPage?.id,
        (pageId) => syncPageParam(pageId),
        { fireImmediately: true },
      ),
    [rootStore],
  );

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

      const match = resolveAction(e);
      if (!match) return;

      if (match.action === 'delete') {
        if (rootStore.editorUI.selectedTool === EditorTool.GRAB) return;
        const selected = rootStore.editorUI.selectedComponent;
        const page = rootStore.editorUI.currentPage;
        if (!selected || !page) return;
        e.preventDefault();
        page.deleteComponent(selected.id);
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

  return (
    <DataSourceProviderContext.Provider value={getSharedPrismaDataSourceProvider()}>
    <EditorCommerceProvider>
    <TransformProvider>
      <DragManagerBinding />

    <div className="relative w-screen h-screen">
      <Canvas />

      {/* Framer-style HudSurface for overlays (outside canvas) */}
      <HudSurface />

      {/* Drag overlays. Single painters shared by every drag source.
          Render nothing unless a gesture is active. */}
      <DropIndicatorLayer />
      <DragGhostLayer />

      <TopBar />
      <EditorNotice />
      <div data-editor-ui="true" className="fixed top-16 left-0 bottom-0 z-90">
        <LeftSidebar />
      </div>
      <div data-editor-ui="true" className="fixed top-16 right-0 bottom-0 z-90">
        <RightSidebar />
      </div>
      <div data-editor-ui="true" className="fixed bottom-0 left-0 right-0 z-30">
        <Toolbar editorUI={rootStore.editorUI} />
      </div>
    </div>
    </TransformProvider>
    </EditorCommerceProvider>
    </DataSourceProviderContext.Provider>
  );
}