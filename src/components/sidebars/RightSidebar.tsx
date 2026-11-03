// src/components/sidebars/RightSidebar.tsx
// Dynamic section-based properties panel, modeled after Framer's UX
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import RightSidebarHeader from './right/RightSidebarHeader';
import StateSwitch from './right/StateSwitch';
import { getComponentCategory, SECTION_MAP, type SectionId } from './right/sectionConfig';
import { SizeSection, PositionSection, StylesSection, LayoutSection, TypographySection, ImageSection, DataSourceSection, EffectsSection, FormSection, StickyCtaSection, MapEmbedSection, TextContentSection, LinkSection, CustomSection, ComponentSection } from './right/sections';
import { ComponentInstance } from '@/models/ComponentModel';
import { InputsSection } from './right/sections/InputsSection';
import { RepeatSection } from './right/sections/RepeatSection';
import { ShopPartNote, ShopStyleNote, isLockedShopText } from './right/sections/ShopPartNote';

const SECTION_COMPONENTS: Record<SectionId, React.ComponentType<{ component: ComponentInstance; breakpointId?: string }>> = {
  component: ComponentSection,
  size: SizeSection,
  position: PositionSection,
  layout: LayoutSection,
  typography: TypographySection,
  image: ImageSection,
  styles: StylesSection,
  effects: EffectsSection,
  form: FormSection,
  stickyCta: StickyCtaSection,
  mapEmbed: MapEmbedSection,
  link: LinkSection,
  custom: CustomSection,
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

  // A definition is text, and the switch holds its editor: no size field means anything for it.
  const editsDefinition = editorUI.activeRuleIsDefinition;

  // The root of a component open on the canvas holds the component's Inputs list.
  const page = editorUI.currentPage;
  const definitionOnCanvas = page ? Array.from(editorUI.currentProject?.components.values() ?? []).find((definition) => definition.page === page) : undefined;
  const openDefinition = definitionOnCanvas && target === page?.appComponentTree ? definitionOnCanvas : undefined;
  // Any other element of it may repeat for one of its lists.
  const repeatable = definitionOnCanvas && target && !openDefinition && !target.isViewportNode && target.type !== '#text'
    ? definitionOnCanvas
    : undefined;

  return (
    <div className={isSheet ? 'bg-background flex flex-col h-full w-full' : `
      bg-background border-l border-border flex flex-col transition-all duration-300 ease-in-out h-[calc(100vh-4rem)]
      ${isCollapsed ? 'w-12' : 'w-[272px]'}
    `}>
      {/* Header with collapse toggle (docked only) and dynamic title */}
      <RightSidebarHeader variant={variant} />

      {/* Under the name and outside the scroll: it says what every row below edits. */}
      {!isCollapsed && <StateSwitch variant={variant} />}

      {/* Content - only show when not collapsed */}
      {!isCollapsed && (
        // overflow-x-hidden is only the last guard: rows are built to fit
        // (PropertyRow's minmax(0,1fr) track), sections own their 12px inset.
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="min-w-0">
            {editsDefinition ? null : target ? (
              <>
                {openDefinition && <InputsSection definition={openDefinition} />}
                {repeatable && target && <RepeatSection definition={repeatable} node={target} />}
                {/* Text first for every element that holds its own text: on a
                    phone this field is the dependable way to change text (a
                    form field always opens the keyboard). Null otherwise. */}
                {isLockedShopText(target) ? (
                  <ShopPartNote component={target} />
                ) : (
                  category !== 'placement' && <TextContentSection component={target} breakpointId={breakpointId} />
                )}
                <ShopStyleNote component={target} />
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
                {category !== 'placement' && <DataSourceSection component={target} breakpointId={breakpointId} />}
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
