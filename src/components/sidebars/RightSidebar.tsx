// src/components/sidebars/RightSidebar.tsx
// Dynamic section-based properties panel, modeled after Framer's UX
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import RightSidebarHeader from './right/RightSidebarHeader';
import { getComponentCategory, SECTION_MAP, type SectionId } from './right/sectionConfig';
import { SizeSection, PositionSection, StylesSection, LayoutSection, TypographySection } from './right/sections';
import { ComponentInstance } from '@/models/ComponentModel';

const SECTION_COMPONENTS: Record<SectionId, React.ComponentType<{ component: ComponentInstance; breakpointId?: string }>> = {
  size: SizeSection,
  position: PositionSection,
  layout: LayoutSection,
  typography: TypographySection,
  styles: StylesSection,
};

/**
 * RightSidebar - Dynamic section-based properties panel
 *
 * Architecture:
 * - Section config maps component categories to ordered section lists
 * - Each section is a collapsible panel with responsive-aware controls
 * - Sections adapt based on what's selected (viewport, container, text, image, etc.)
 */
const RightSidebar = observer(() => {
  const { editorUI } = useStore();
  const isCollapsed = editorUI.rightSidebarCollapsed;
  const selectedComponent = editorUI.selectedComponent;
  const selectedViewportNode = editorUI.selectedViewportNode;

  // Determine which component to show properties for
  // Priority: selectedComponent > selectedViewportNode (when viewport itself is selected)
  const target = selectedComponent || selectedViewportNode;
  const breakpointId = selectedViewportNode?.breakpointId;

  // Get category and sections for the target
  const category = target ? getComponentCategory(target) : null;
  const sections = category ? SECTION_MAP[category] : [];

  return (
    <div className={`
      bg-white border-l border-gray-200 flex flex-col transition-all duration-300 ease-in-out h-[calc(100vh-4rem)]
      ${isCollapsed ? 'w-12' : 'w-64'}
    `}>
      {/* Header with collapse toggle and dynamic title */}
      <RightSidebarHeader />

      {/* Content - only show when not collapsed */}
      {!isCollapsed && (
        <div className="flex-1 overflow-y-auto">
          <div className="p-3">
            {target ? (
              sections.map((sectionId) => {
                const SectionComponent = SECTION_COMPONENTS[sectionId];
                return (
                  <SectionComponent
                    key={sectionId}
                    component={target}
                    breakpointId={breakpointId}
                  />
                );
              })
            ) : (
              <div className="flex items-center space-x-2 mb-3">
                <span className="text-sm text-gray-500">Select an element to edit properties</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

RightSidebar.displayName = 'RightSidebar';

export default RightSidebar;
