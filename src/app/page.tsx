// src/app/page.tsx - Main page component with wireframe layout
import Image from "next/image";
import Canvas from "@components/Canvas";

export default function Home() {
  return (
    <div className="w-full h-screen bg-gray-50 flex flex-col">
      {/* Header - wireframe style */}
      <header className="h-16 bg-white border-b-2 border-gray-300 flex items-center px-6">
        <div className="w-32 h-8 bg-gray-300 rounded"></div>
        <div className="ml-auto flex space-x-4">
          <div className="w-16 h-8 bg-gray-300 rounded"></div>
          <div className="w-16 h-8 bg-gray-300 rounded"></div>
          <div className="w-16 h-8 bg-gray-300 rounded"></div>
        </div>
      </header>

      <div className="flex flex-1">
        {/* Sidebar - wireframe style */}
        <aside className="w-64 bg-white border-r-2 border-gray-300 p-4">
          <div className="space-y-4">
            <div className="w-full h-10 bg-gray-300 rounded"></div>
            <div className="w-full h-8 bg-gray-200 rounded"></div>
            <div className="w-full h-8 bg-gray-200 rounded"></div>
            <div className="w-full h-8 bg-gray-200 rounded"></div>
            
            {/* Separator line */}
            <div className="border-t border-gray-300 my-6"></div>
            
            <div className="w-full h-6 bg-gray-200 rounded"></div>
            <div className="w-3/4 h-6 bg-gray-200 rounded"></div>
            <div className="w-1/2 h-6 bg-gray-200 rounded"></div>
          </div>
        </aside>

        {/* Canvas Area - main content */}
        <Canvas />
      </div>
    </div>
  );
}
