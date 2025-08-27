// src/utils/crossViewportHighlighting.ts
// Cross-viewport highlighting utilities inspired by Framer's architecture

import { ComponentInstance } from '@/models/ComponentModel';

/**
 * Represents a render instance of a component in a specific viewport
 * Based on Framer's render instance system
 */
export interface ComponentRenderInstance {
  componentId: string;
  breakpointId: string;
  renderId: string;
  domElement?: HTMLElement;
  rect?: DOMRect;
}

/**
 * Cross-viewport selection state
 * Tracks a component across all its viewport appearances
 */
export interface CrossViewportSelection {
  selectedComponent: ComponentInstance;
  primaryViewport: ComponentInstance; // The viewport node where selection happened
  renderInstances: ComponentRenderInstance[];
}

/**
 * Find all DOM render instances of a component across viewports
 * This replicates Framer's approach of finding the same component in multiple contexts
 */
export function findAllRenderInstances(
  component: ComponentInstance,
  viewportNodes: ComponentInstance[]
): ComponentRenderInstance[] {
  const instances: ComponentRenderInstance[] = [];

  viewportNodes.forEach(viewport => {
    if (!viewport.isViewportNode) return;
    
    const renderId = `${viewport.breakpointId}-${component.id}`;
    const domElement = document.querySelector(
      `[data-component-id="${renderId}"]`
    ) as HTMLElement;

    if (domElement) {
      instances.push({
        componentId: component.id,
        breakpointId: viewport.breakpointId!,
        renderId,
        domElement,
        rect: domElement.getBoundingClientRect(),
      });
    }
  });

  return instances;
}

/**
 * Create cross-viewport selection state
 * This is the core data structure for managing cross-viewport highlighting
 */
export function createCrossViewportSelection(
  component: ComponentInstance,
  primaryViewport: ComponentInstance,
  viewportNodes: ComponentInstance[]
): CrossViewportSelection {
  const renderInstances = findAllRenderInstances(component, viewportNodes);
  
  return {
    selectedComponent: component,
    primaryViewport,
    renderInstances,
  };
}

/**
 * Check if a component has multiple viewport appearances
 * This determines whether cross-viewport highlighting should be active
 */
export function hasMultipleViewportAppearances(
  component: ComponentInstance,
  viewportNodes: ComponentInstance[]
): boolean {
  const instances = findAllRenderInstances(component, viewportNodes);
  return instances.length > 1;
}

/**
 * Get secondary render instances (excluding the primary one)
 * These are the instances that get subtle highlighting
 */
export function getSecondaryRenderInstances(
  selection: CrossViewportSelection
): ComponentRenderInstance[] {
  return selection.renderInstances.filter(
    instance => instance.breakpointId !== selection.primaryViewport.breakpointId
  );
}

/**
 * Get the primary render instance (where selection happened)
 * This gets the bold highlighting with selection handles
 */
export function getPrimaryRenderInstance(
  selection: CrossViewportSelection
): ComponentRenderInstance | undefined {
  return selection.renderInstances.find(
    instance => instance.breakpointId === selection.primaryViewport.breakpointId
  );
}

/**
 * Highlight style configuration for different selection types
 */
export const HIGHLIGHT_STYLES = {
  primary: {
    border: 'border-2 border-green-500',
    background: 'bg-green-500/10',
    zIndex: 'z-10',
    showHandles: true,
  },
  secondary: {
    border: 'border-2 border-green-300',
    background: 'bg-green-300/5',
    zIndex: 'z-[9]',
    showHandles: false,
    animation: 'animate-pulse',
  },
  floating: {
    border: 'border-2 border-green-500',
    background: 'bg-green-500/10',
    zIndex: 'z-[11]',
    showHandles: true,
  },
} as const;
