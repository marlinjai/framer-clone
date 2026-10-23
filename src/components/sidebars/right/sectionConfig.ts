import { ComponentInstance } from '@/models/ComponentModel';
import { formKindOf } from '@/lib/forms/definition';

export type ComponentCategory = 'viewport' | 'container' | 'text' | 'image' | 'generic' | 'form' | 'formField' | 'formSubmit';
export type SectionId = 'size' | 'position' | 'layout' | 'typography' | 'image' | 'styles' | 'form';

// Exported so the AI page generator's schema docs (src/lib/ai/pageGen/schema.ts)
// offer exactly the tags this properties panel knows how to edit.
export const CONTAINER_TYPES: ReadonlySet<string> = new Set(['div', 'section', 'header', 'main', 'footer', 'nav', 'article', 'aside']);
export const TEXT_TYPES: ReadonlySet<string> = new Set(['p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'label', 'strong', 'em']);

export function getComponentCategory(component: ComponentInstance): ComponentCategory {
  if (component.isViewportNode) return 'viewport';
  // Form components first: their tags (div, button) would read as a plain container or generic node.
  const formKind = formKindOf(component.props as Record<string, unknown>);
  if (formKind === 'form') return 'form';
  if (formKind === 'form-field') return 'formField';
  if (formKind === 'form-submit') return 'formSubmit';
  if (component.type === 'img') return 'image';
  if (TEXT_TYPES.has(component.type)) return 'text';
  if (CONTAINER_TYPES.has(component.type)) return 'container';
  return 'generic';
}

export const SECTION_MAP: Record<ComponentCategory, SectionId[]> = {
  viewport:  ['size', 'layout', 'styles'],
  container: ['size', 'position', 'layout', 'image', 'styles'],
  text:      ['size', 'position', 'typography', 'styles'],
  image:     ['size', 'position', 'image', 'styles'],
  generic:   ['size', 'position', 'styles'],
  form:       ['form', 'size', 'position', 'layout', 'styles'],
  formField:  ['form', 'size', 'position', 'typography', 'styles'],
  formSubmit: ['form', 'size', 'position', 'typography', 'styles'],
};
