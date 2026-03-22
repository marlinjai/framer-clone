import { ComponentInstance } from '@/models/ComponentModel';

export type ComponentCategory = 'viewport' | 'container' | 'text' | 'image' | 'generic';
export type SectionId = 'size' | 'position' | 'layout' | 'typography' | 'styles';

const CONTAINER_TYPES = new Set(['div', 'section', 'header', 'main', 'footer', 'nav', 'article', 'aside']);
const TEXT_TYPES = new Set(['p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'label', 'strong', 'em']);

export function getComponentCategory(component: ComponentInstance): ComponentCategory {
  if (component.isViewportNode) return 'viewport';
  if (component.type === 'img') return 'image';
  if (TEXT_TYPES.has(component.type)) return 'text';
  if (CONTAINER_TYPES.has(component.type)) return 'container';
  return 'generic';
}

export const SECTION_MAP: Record<ComponentCategory, SectionId[]> = {
  viewport:  ['size', 'layout', 'styles'],
  container: ['size', 'position', 'layout', 'styles'],
  text:      ['size', 'position', 'typography', 'styles'],
  image:     ['size', 'position', 'styles'],
  generic:   ['size', 'position', 'styles'],
};
