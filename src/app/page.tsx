'use client';
// src/app/page.tsx - Main page component with wireframe layout

import Canvas from "@/components/Canvas";
import LeftSidebar from "@/components/LeftSidebar";
import RightSidebar from "@/components/RightSidebar";
import Toolbar from "@/components/Toolbar";
import { useResponsiveSidebars } from "../hooks/useResponsiveSidebars";
import { useStore } from "@/hooks/useStore";
import { ComponentTypeEnum } from "@/models/ComponentModel";

export default function Home() {
  const rootStore = useStore();

  // Create a sample project with the component tree
  const sampleProject = rootStore.projectStore.createProject(
    'sample-project',
    'Framer Clone Demo',
    'Sample project with component tree'
  );

  // Get the default home page and set our sample component tree
  const homePage = sampleProject.firstPage;
  if (homePage) {
    // Create component tree using snapshots (MST-compatible)

    
    const componentTreeSnapshot = {
      id: "root",
      type: "div",
      componentType: ComponentTypeEnum.HOST,
      props: {
        className: "app-container",
        style: {
          width: "100%",
          height: "100vh",
          backgroundColor: "#f5f5f5",
          padding: "20px",
          fontFamily: "Arial, sans-serif"
        }
      },
      children: [
        {
          id: "header",
          type: "header",
          componentType: ComponentTypeEnum.HOST,
          props: {
            className: "app-header",
            style: {
              backgroundColor: "#2563eb",
              color: "white",
              padding: "16px",
              borderRadius: "8px",
              marginBottom: "20px"
            }
          },
          children: [
            {
              id: "title",
              type: "h1",
              componentType: ComponentTypeEnum.HOST,
              props: {
                style: {
                  margin: "0",
                  fontSize: "24px",
                  fontWeight: "bold"
                },
                children: "Framer Clone - Selection Test"
              },
              children: []
            }
          ]
        },
        {
          id: "main-content",
          type: "main",
          componentType: ComponentTypeEnum.HOST,
          props: {
            className: "main-content",
            style: {
              display: "flex",
              gap: "20px",
              flexWrap: "wrap",
              marginTop: "20px"
            }
          },
          children: [
            {
              id: "card-1",
              type: "div",
              componentType: ComponentTypeEnum.HOST,
              props: {
                className: "card",
                style: {
                  backgroundColor: "white",
                  padding: "20px",
                  borderRadius: "8px",
                  boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                  border: "1px solid #e5e7eb",
                  cursor: "pointer",
                  transition: "all 0.2s"
                }
              },
              children: [
                {
                  id: "card-title",
                  type: "h3",
                  componentType: ComponentTypeEnum.HOST,
                  props: {
                    style: {
                      margin: "0 0 8px 0",
                      fontSize: "18px",
                      fontWeight: "600"
                    },
                    children: "Clickable Card"
                  },
                  children: []
                },
                {
                  id: "card-description",
                  type: "p",
                  componentType: ComponentTypeEnum.HOST,
                  props: {
                    style: {
                      margin: "0",
                      color: "#6b7280",
                      fontSize: "14px"
                    },
                    children: "Click me to test selection!"
                  },
                  children: []
                }
              ]
            },
            {
              id: "button-section",
              type: "div",
              componentType: ComponentTypeEnum.HOST,
              props: {
                style: {
                  display: "flex",
                  gap: "12px"
                }
              },
              children: [
                {
                  id: "primary-btn",
                  type: "button",
                  componentType: ComponentTypeEnum.HOST,
                  props: {
                    style: {
                      padding: "12px 24px",
                      backgroundColor: "#3b82f6",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      fontSize: "14px",
                      fontWeight: "500",
                      cursor: "pointer"
                    },
                    children: "Primary Button"
                  },
                  children: []
                },
                {
                  id: "secondary-btn",
                  type: "button",
                  componentType: ComponentTypeEnum.HOST,
                  props: {
                    style: {
                      padding: "12px 24px",
                      backgroundColor: "#f3f4f6",
                      color: "#374151",
                      border: "1px solid #d1d5db",
                      borderRadius: "6px",
                      fontSize: "14px",
                      fontWeight: "500",
                      cursor: "pointer"
                    },
                    children: "Secondary Button"
                  },
                  children: []
                }
              ]
            }
          ]
        }
      ]
    };

    // Set the root component using snapshot
    homePage.setRootComponent(componentTreeSnapshot);
    
    // Set this project as current in the editor
    rootStore.editorUI.setCurrentProject(sampleProject);
  }

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
