'use client';

import React from 'react';
import Canvas from "@/components/Canvas";
import LeftSidebar from "@/components/sidebars/LeftSidebar";
import RightSidebar from "@/components/sidebars/RightSidebar";
import Toolbar from "@/components/Toolbar";
import HudSurface from "@/components/HudSurface";
import { TransformProvider } from '@/contexts/TransformContext';
import makeInspectable from 'mobx-devtools-mst';

import { useStore } from "@/hooks/useStore";

export default function EditorApp() {
  const rootStore = useStore();
  const initRef = React.useRef(false);
  makeInspectable(rootStore);

  if (!initRef.current) {
rootStore.projectStore.createProject(
      'Framer Clone Demo',
      'Sample project with component tree'
    );

  // Set this project as current in the editor
    rootStore.editorUI.setCurrentProject(rootStore.projectStore.findProjectByTitle('Framer Clone Demo'));
    rootStore.editorUI.setCurrentPage(rootStore.editorUI.currentProject?.findPageBySlug(''));
    initRef.current = true;
  }

  return (
    <TransformProvider>

    <div className="relative w-screen h-screen">
      <Canvas />
      
      {/* Framer-style HudSurface for overlays (outside canvas) */}
      <HudSurface />
      
      <header className="fixed top-0 left-0 right-0 h-16 bg-white border-b border-gray-200 flex items-center px-6 z-90">
        <div className="w-32 h-8 bg-gray-300 rounded" />
        <div className="ml-auto flex space-x-4">
          <div className="w-16 h-8 bg-gray-300 rounded" />
          <div className="w-16 h-8 bg-gray-300 rounded" />
          <div className="w-16 h-8 bg-gray-300 rounded" />
        </div>
      </header>
      <div className="fixed top-16 left-0 bottom-0 z-90">
        <LeftSidebar />
      </div>
      <div className="fixed top-16 right-0 bottom-0 z-90">
        <RightSidebar />
      </div>
      <div className="fixed bottom-0 left-0 right-0 z-30">
        <Toolbar editorUI={rootStore.editorUI} />
      </div>
    </div>
    </TransformProvider>
  );
}