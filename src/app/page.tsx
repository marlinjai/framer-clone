'use client';
// src/app/page.tsx - Main page component with wireframe layout
import Image from "next/image";
import Canvas from "@/components/Canvas";
import LeftSidebar from "@/components/LeftSidebar";
import RightSidebar from "@/components/RightSidebar";
import Toolbar from "@/components/Toolbar";
import RootStore from "../models/RootStore";
import ProjectStore from "../stores/ProjectStore";
import EditorUIStore from "../stores/EditorUIStore";
import { useResponsiveSidebars } from "../hooks/useResponsiveSidebars";

export default function Home() {
  const rootStore = RootStore.create({
    projectStore: ProjectStore.create({ projects: {} }),
    editorUI: EditorUIStore.create({}),
  });

  // Handle responsive sidebar behavior
  useResponsiveSidebars(rootStore.editorUI);

  return (
    <div className="w-full h-screen bg-gray-50 flex flex-col">
      {/* Header - wireframe style */}
      <header className="h-16 bg-white border-b border-gray-200 flex items-center px-6 z-10">
        <div className="w-32 h-8 bg-gray-300 rounded"></div>
        <div className="ml-auto flex space-x-4">
          <div className="w-16 h-8 bg-gray-300 rounded"></div>
          <div className="w-16 h-8 bg-gray-300 rounded"></div>
          <div className="w-16 h-8 bg-gray-300 rounded"></div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar - Components/Layers */}
        <LeftSidebar editorUI={rootStore.editorUI} />

        {/* Main Canvas Area */}
        <div className="flex-1 flex flex-col">
          <Canvas rootStore={rootStore} />
        </div>

        {/* Right Sidebar - Properties */}
        <RightSidebar editorUI={rootStore.editorUI} />
      </div>

      {/* Bottom Toolbar */}
      <Toolbar editorUI={rootStore.editorUI} />
    </div>
  );
}
