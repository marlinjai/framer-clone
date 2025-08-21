// src/hooks/useResponsiveSidebars.ts
// Hook to handle responsive sidebar behavior
'use client';

import { useEffect } from 'react';
import { EditorUIInstance } from '../stores/EditorUIStore';

export const useResponsiveSidebars = (editorUI: EditorUIInstance) => {
  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      
      // Auto-collapse sidebars based on screen size
      if (width < 1024) {
        // Mobile/tablet - collapse both sidebars
        editorUI.setLeftSidebarCollapsed(true);
        editorUI.setRightSidebarCollapsed(true);
      } else if (width < 1280) {
        // Medium desktop - keep left open, collapse right
        editorUI.setLeftSidebarCollapsed(false);
        editorUI.setRightSidebarCollapsed(true);
      } else {
        // Large desktop - show both sidebars
        editorUI.setLeftSidebarCollapsed(false);
        editorUI.setRightSidebarCollapsed(false);
      }
      
      // Update viewport width for responsive preview
      editorUI.setViewportWidth(width);
    };

    // Set initial state
    handleResize();

    // Add resize listener
    window.addEventListener('resize', handleResize);
    
    // Cleanup
    return () => window.removeEventListener('resize', handleResize);
  }, [editorUI]);
};