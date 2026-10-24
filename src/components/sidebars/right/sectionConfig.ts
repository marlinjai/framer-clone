import { ComponentInstance } from '@/models/ComponentModel';
import { formKindOf } from '@/lib/forms/definition';
import { isStickyCta } from '@/lib/stickyCta/stickyCta';

export type ComponentCategory = 'viewport' | 'container' | 'text' | 'image' | 'generic' | 'form' | 'formField' | 'formSubmit' | 'stickyCta';
export type SectionId = 'size' | 'position' | 'layout' | 'typography' | 'image' | 'styles' | 'effects' | 'form' | 'stickyCta';

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
  // The sticky call to action bar is a div, but not a layout container.
  if (isStickyCta(component.props)) return 'stickyCta';
  if (component.type === 'img') return 'image';
  if (TEXT_TYPES.has(component.type)) return 'text';
  if (CONTAINER_TYPES.has(component.type)) return 'container';
  return 'generic';
}

export const SECTION_MAP: Record<ComponentCategory, SectionId[]> = {
  viewport:  ['size', 'layout', 'styles'],
  // Typography on a container sets the font its text inherits (a section's
  // body family, which is how generated pages set fonts).
  container: ['size', 'position', 'layout', 'typography', 'image', 'styles', 'effects'],
  text:      ['size', 'position', 'typography', 'styles', 'effects'],
  image:     ['size', 'position', 'image', 'styles', 'effects'],
  generic:   ['size', 'position', 'styles', 'effects'],
  // A form may reveal like any section; single fields and the submit button
  // do not animate (hover-everything is one of the design tells).
  form:       ['form', 'size', 'position', 'layout', 'styles', 'effects'],
  formField:  ['form', 'size', 'position', 'typography', 'styles'],
  formSubmit: ['form', 'size', 'position', 'typography', 'styles'],
  // Pinned by the published page, so no size, position or effects; the bar's
  // look is the Styles section, the font of its label Typography.
  stickyCta:  ['stickyCta', 'typography', 'styles'],
};
