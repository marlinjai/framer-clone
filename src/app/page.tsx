'use client';
// src/app/page.tsx - Main page component with wireframe layout

import Canvas from "@/components/Canvas";
import LeftSidebar from "@/components/LeftSidebar";
import RightSidebar from "@/components/RightSidebar";
import Toolbar from "@/components/Toolbar";
import { useResponsiveSidebars } from "../hooks/useResponsiveSidebars";
import { useStore } from "@/hooks/useStore";
import { getSnapshot } from "mobx-state-tree";
import { samplePage } from "@/models/SamplePage";

export default function Home() {
  const rootStore = useStore();

  // Create a sample project with the component tree
  const sampleProject = rootStore.projectStore.createProject(
    'sample-project',
    'Framer Clone Demo',
    'Sample project with component tree'
  );

  // Create fresh snapshots to avoid MST reuse issues
  const samplePageSnapshot = getSnapshot(samplePage);

  // Add the page using snapshot
  sampleProject.addPage(samplePageSnapshot);
  
  // Set this project as current in the editor
  rootStore.editorUI.setCurrentProject(sampleProject);

  // Handle responsive sidebar behavior
  useResponsiveSidebars(rootStore.editorUI);

  return (
    <div className="relative w-screen h-screen">
      {/* Full-viewport Canvas - base layer */}
      <Canvas rootStore={rootStore} />
      
      {/* Floating UI Elements - positioned on top */}
      
      {/* Header - wireframe style */}
      <header className="fixed top-0 left-0 right-0 h-16 bg-white border-b border-gray-200 flex items-center px-6 z-90">
        <div className="w-32 h-8 bg-gray-300 rounded"></div>
        <div className="ml-auto flex space-x-4">
          <div className="w-16 h-8 bg-gray-300 rounded"></div>
          <div className="w-16 h-8 bg-gray-300 rounded"></div>
          <div className="w-16 h-8 bg-gray-300 rounded"></div>
        </div>
      </header>

      {/* Left Sidebar - Components/Layers */}
      <div className="fixed top-16 left-0 bottom-0 z-90">
        <LeftSidebar editorUI={rootStore.editorUI} />
      </div>

      {/* Right Sidebar - Properties */}
      <div className="fixed top-16 right-0 bottom-0 z-90">
        <RightSidebar editorUI={rootStore.editorUI} />
      </div>

      {/* Bottom Toolbar */}
      <div className="fixed bottom-0 left-0 right-0 z-30">
        <Toolbar editorUI={rootStore.editorUI} />
      </div>
    </div>
  );
}
