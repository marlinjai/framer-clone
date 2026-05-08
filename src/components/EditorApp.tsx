'use client';

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
import { resolveAction } from '@/lib/keyBindings';

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

export default function EditorApp() {
  const rootStore = useStore();
  const initRef = React.useRef(false);
  makeInspectable(rootStore);
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    (window as unknown as { __rootStore?: typeof rootStore }).__rootStore = rootStore;
  }

  if (!initRef.current) {
rootStore.projectStore.createProject(
      'Framer Clone Demo',
      'Sample project with component tree'
    );

  // Set this project as current in the editor
    rootStore.editorUI.setCurrentProject(rootStore.projectStore.findProjectByTitle('Framer Clone Demo'));
    rootStore.editorUI.setCurrentPage(rootStore.editorUI.currentProject?.findPageBySlug(''));
    initRef.current = true;
    // Drop the seed/demo actions from history so "Initial state" = seeded project,
    // not literally-empty. Undoing past project creation would destroy the page
    // that selection / UI references point at.
    getHistoryStore()?.clear();
  }

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
  );
}