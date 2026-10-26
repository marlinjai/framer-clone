// src/components/sidebars/RightSidebar.tsx
// Dynamic section-based properties panel, modeled after Framer's UX
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import RightSidebarHeader from './right/RightSidebarHeader';
import { getComponentCategory, SECTION_MAP, type SectionId } from './right/sectionConfig';
import { SizeSection, PositionSection, StylesSection, LayoutSection, TypographySection, ImageSection, DataSourceSection, EffectsSection, FormSection, StickyCtaSection, TextContentSection, LinkSection } from './right/sections';
import { ComponentInstance } from '@/models/ComponentModel';

const SECTION_COMPONENTS: Record<SectionId, React.ComponentType<{ component: ComponentInstance; breakpointId?: string }>> = {
  size: SizeSection,
  position: PositionSection,
  layout: LayoutSection,
  typography: TypographySection,
  image: ImageSection,
  styles: StylesSection,
  effects: EffectsSection,
  form: FormSection,
  stickyCta: StickyCtaSection,
  link: LinkSection,
};

/**
 * RightSidebar - Dynamic section-based properties panel
 *
 * Architecture:
 * - Section config maps component categories to ordered section lists
 * - Each section is a collapsible panel with responsive-aware controls
 * - Sections adapt based on what's selected (viewport, container, text, image, etc.)
 */
export interface RightSidebarProps {
  /**
   * 'docked' (default): the desktop side panel. 'sheet': fills a phone bottom
   * sheet (plan docs/plans/2026-10-24-editor-on-phones.md), always expanded,
   * never reading or writing the desktop collapse state.
   */
  variant?: 'docked' | 'sheet';
}

const RightSidebar = observer(({ variant = 'docked' }: RightSidebarProps) => {
  const { editorUI } = useStore();
  const isSheet = variant === 'sheet';
  const isCollapsed = isSheet ? false : editorUI.rightSidebarCollapsed;
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
    <div className={isSheet ? 'bg-background flex flex-col h-full w-full' : `
      bg-background border-l border-border flex flex-col transition-all duration-300 ease-in-out h-[calc(100vh-4rem)]
      ${isCollapsed ? 'w-12' : 'w-[272px]'}
    `}>
      {/* Header with collapse toggle (docked only) and dynamic title */}
      <RightSidebarHeader variant={variant} />

      {/* Content - only show when not collapsed */}
      {!isCollapsed && (
        // overflow-x-hidden is only the last guard: rows are built to fit
        // (PropertyRow's minmax(0,1fr) track), sections own their 12px inset.
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="min-w-0">
            {target ? (
              <>
                {/* Text first for every element that holds its own text: on a
                    phone this field is the dependable way to change text (a
                    form field always opens the keyboard). Null otherwise. */}
                <TextContentSection component={target} breakpointId={breakpointId} />
                {sections.map((sectionId) => {
                  const SectionComponent = SECTION_COMPONENTS[sectionId];
                  return (
                    <SectionComponent
                      key={sectionId}
                      component={target}
                      breakpointId={breakpointId}
                    />
                  );
                })}
                {/* Data section: renders only when the node has bindable slots
                    (text / button / image / data components); null otherwise. */}
                <DataSourceSection component={target} breakpointId={breakpointId} />
              </>
            ) : (
              <p className="p-3 text-[12px] text-muted-foreground">Select an element to edit its properties.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

RightSidebar.displayName = 'RightSidebar';

export default RightSidebar;
