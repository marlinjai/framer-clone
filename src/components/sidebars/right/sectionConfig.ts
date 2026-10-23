import { ComponentInstance } from '@/models/ComponentModel';

export type ComponentCategory = 'viewport' | 'container' | 'text' | 'image' | 'generic';
export type SectionId = 'size' | 'position' | 'layout' | 'typography' | 'image' | 'styles' | 'effects';

// Exported so the AI page generator's schema docs (src/lib/ai/pageGen/schema.ts)
// offer exactly the tags this properties panel knows how to edit.
export const CONTAINER_TYPES: ReadonlySet<string> = new Set(['div', 'section', 'header', 'main', 'footer', 'nav', 'article', 'aside']);
export const TEXT_TYPES: ReadonlySet<string> = new Set(['p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'label', 'strong', 'em']);

export function getComponentCategory(component: ComponentInstance): ComponentCategory {
  if (component.isViewportNode) return 'viewport';
  if (component.type === 'img') return 'image';
  if (TEXT_TYPES.has(component.type)) return 'text';
  if (CONTAINER_TYPES.has(component.type)) return 'container';
  return 'generic';
}

export const SECTION_MAP: Record<ComponentCategory, SectionId[]> = {
  viewport:  ['size', 'layout', 'styles'],
  container: ['size', 'position', 'layout', 'image', 'styles', 'effects'],
  text:      ['size', 'position', 'typography', 'styles', 'effects'],
  image:     ['size', 'position', 'image', 'styles', 'effects'],
  generic:   ['size', 'position', 'styles', 'effects'],
};
