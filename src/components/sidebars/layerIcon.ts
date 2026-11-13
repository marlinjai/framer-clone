// src/components/sidebars/layerIcon.ts
//
// The icon a node shows in the Layers panel and in the properties panel header,
// so both name a node the same way. The kind of a node comes from the helpers
// that already sort nodes: the properties panel's categories (sectionConfig),
// the drop resolver's container tags, and the component registry, whose entry
// icons are the ones the Components palette shows. Only tags none of them
// sort (a button, a video, a list) are named here.
//
// Also home of the page body rule: the single root of a page's tree is the
// page's body (it carries page-wide styles per breakpoint), so Layers shows it
// as the breakpoint row and the header titles it "Page". Inside a component
// definition the root is the component's own element and stays a plain node.
import type { LucideIcon } from 'lucide-react';
import {
  AppWindow,
  AudioLines,
  Box,
  Blend,
  Component,
  Database,
  Image as ImageIcon,
  Info,
  Layers,
  LayoutList,
  Minus,
  Monitor,
  Palette,
  Repeat,
  Shapes,
  Sheet,
  Smartphone,
  Sparkles,
  Tablet,
  Type,
  Video,
  WandSparkles,
  Waves,
} from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { COMPONENT_REGISTRY, FORM_COMPONENTS, type ComponentRegistryEntry, type DataComponentKind } from '@/lib/componentRegistry';
import { fieldTypeOf } from '@/lib/forms/definition';
import { shopPartRoleOf, shopPartSpec } from '@/lib/commerce/parts';
import { isComponentPlaceholderType } from '@/lib/components/placement';
import { isTextNodeType } from '@/lib/renderer/textNode';
import { CONTAINER_TAGS } from '@/lib/drag/resolveDropTarget';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { getComponentCategory } from './right/sectionConfig';

/** The device a breakpoint frame stands for, read from its label. */
export function viewportIconOf(label: string | undefined): LucideIcon {
  const lower = (label ?? '').toLowerCase();
  if (lower.includes('mobile') || lower.includes('phone')) return Smartphone;
  if (lower.includes('tablet')) return Tablet;
  return Monitor;
}

// The palette's entry for each data component kind (CMS and commerce alike).
const DATA_KIND_ENTRIES: ReadonlyMap<string, ComponentRegistryEntry> = new Map(
  Object.values(COMPONENT_REGISTRY)
    .filter((entry): entry is ComponentRegistryEntry & { dataComponentKind: DataComponentKind } => !!entry.dataComponentKind)
    .map(entry => [entry.dataComponentKind, entry]),
);

// The palette's entry for each form field type (text, email, select, ...).
const FIELD_ENTRIES: ReadonlyMap<string, ComponentRegistryEntry> = new Map(
  Object.values(FORM_COMPONENTS)
    .filter(entry => typeof entry.defaultProps.fieldType === 'string')
    .map(entry => [entry.defaultProps.fieldType as string, entry]),
);

const TABLE_TAGS: ReadonlySet<string> = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col']);

/** A node whose only content is text: its own string, or text node children. */
function holdsOnlyText(component: ComponentInstance): boolean {
  const own = component.props?.children;
  if (component.children.length === 0) return typeof own === 'string' || typeof own === 'number';
  return component.children.every((child: ComponentInstance) => isTextNodeType(child.type));
}

/** A plain div holding only text: it renders as a text box, not a layout frame. */
function isTextBox(component: ComponentInstance): boolean {
  return component.type === 'div' && holdsOnlyText(component);
}

/**
 * A layout container's icon, by how it lays out its children: the palette's
 * Grid, Stack (a column) and Flex (a row) entries, else its Container.
 * `display` may differ per breakpoint, so a row in a breakpoint group passes
 * that breakpoint and the page's breakpoints.
 */
function layoutIconOf(component: ComponentInstance, at?: LayerIconBreakpoint): LucideIcon {
  const style = at
    ? component.getResolvedProps(at.breakpointId, at.breakpoints).style
    : ((component.props?.style ?? {}) as Record<string, unknown>);
  const display = style.display;
  if (display === 'grid' || display === 'inline-grid') return COMPONENT_REGISTRY.grid.icon;
  if (display === 'flex' || display === 'inline-flex') {
    const direction = style.flexDirection;
    return direction === 'column' || direction === 'column-reverse'
      ? COMPONENT_REGISTRY.stack.icon
      : COMPONENT_REGISTRY.flex.icon;
  }
  return COMPONENT_REGISTRY.container.icon;
}

/** Where a node is shown, so a per-breakpoint layout picks the right icon. */
export interface LayerIconBreakpoint {
  breakpointId: string;
  breakpoints: BreakpointRef[];
}

/** The page's breakpoints in the shape the style cascade reads. */
export function breakpointRefsOf(page: { sortedViewportNodes: ComponentInstance[] }): BreakpointRef[] {
  return page.sortedViewportNodes.map(v => ({ id: v.breakpointId ?? '', minWidth: v.breakpointMinWidth ?? 0 }));
}

/** The icon for a node, the same in the Layers panel and the properties header. */
export function layerIconOf(component: ComponentInstance, at?: LayerIconBreakpoint): LucideIcon {
  if (isTextNodeType(component.type)) return Type;
  if (component.isViewportNode) return viewportIconOf(component.label);
  if (isComponentPlaceholderType(component.type)) return Component;

  // A shop part (src/lib/commerce/parts.ts) by what it is: its tag alone would call
  // a notice whose text is the platform's an empty box.
  const shopRole = shopPartRoleOf(component.props);
  const shopSpec = shopRole ? shopPartSpec(shopRole) : undefined;
  if (shopSpec) {
    if (shopSpec.fixedText) return Info;
    if (shopSpec.repeat) return Repeat;
    if (shopSpec.tag === 'input') return shopRole === 'checkout.decline-input' ? FORM_COMPONENTS.formCheckbox.icon : FORM_COMPONENTS.formText.icon;
    if (shopSpec.dynamicText) return Type;
  }

  // A data component is a div the CMS or commerce renderer fills.
  const dataKind = component.props?.['data-component-kind'];
  if (typeof dataKind === 'string') return DATA_KIND_ENTRIES.get(dataKind)?.icon ?? Database;

  switch (getComponentCategory(component)) {
    case 'form': return FORM_COMPONENTS.form.icon;
    case 'formField': return FIELD_ENTRIES.get(fieldTypeOf(component.props?.fieldType))?.icon ?? FORM_COMPONENTS.formText.icon;
    case 'formSubmit': return FORM_COMPONENTS.formSubmit.icon;
    case 'stickyCta': return COMPONENT_REGISTRY.stickyCta.icon;
    case 'mapEmbed': return COMPONENT_REGISTRY.mapEmbed.icon;
    case 'fxScene': return COMPONENT_REGISTRY.fxScene.icon;
    case 'image': return COMPONENT_REGISTRY.image.icon;
    case 'link': return COMPONENT_REGISTRY.link.icon;
    case 'text': return Type;
    // A plain div that holds nothing but text is a text box (the seeded one is); a
    // landmark (main, section, nav, ...) stays a frame whatever it holds.
    case 'container': return isTextBox(component) ? Type : layoutIconOf(component, at);
    default: break;
  }

  // Tags the panel's categories leave generic.
  const tag = component.type.toLowerCase();
  switch (tag) {
    case 'button': return COMPONENT_REGISTRY.button.icon;
    case 'picture': return COMPONENT_REGISTRY.image.icon;
    case 'video': return Video;
    case 'audio': return AudioLines;
    case 'svg': return Shapes;
    case 'iframe': return AppWindow;
    case 'input': return FORM_COMPONENTS.formText.icon;
    case 'textarea': return FORM_COMPONENTS.formTextarea.icon;
    case 'select': return FORM_COMPONENTS.formSelect.icon;
    case 'form': return FORM_COMPONENTS.form.icon;
    case 'ul':
    case 'ol': return LayoutList;
    case 'hr': return Minus;
    default: break;
  }
  if (TABLE_TAGS.has(tag)) return holdsOnlyText(component) ? Type : Sheet;
  if (CONTAINER_TAGS.has(tag)) return isTextBox(component) ? Type : layoutIconOf(component, at);
  // A list item, a quote, a cell: text when it only holds text, a frame when it holds elements.
  if (holdsOnlyText(component)) return Type;
  if (component.children.length > 0) return layoutIconOf(component, at);
  return Box;
}

/** The page body: the root of a real page's tree (a definition's root is its component). */
export function isPageBody(
  component: ComponentInstance | undefined,
  page: { appComponentTree?: { id: string } | null } | undefined | null,
  inComponent: boolean | undefined,
): boolean {
  if (!component || inComponent || component.isViewportNode) return false;
  return !!page?.appComponentTree && page.appComponentTree.id === component.id;
}

/** The row of an FX scene's own group ("Scene"), under the box. */
export const FX_SCENE_GROUP_ICON: LucideIcon = Sparkles;
/** The sub-group of post effects ("Effects"). */
export const FX_EFFECTS_GROUP_ICON: LucideIcon = WandSparkles;
/** The pseudo-row for the scene's background colour. */
export const FX_BACKGROUND_ICON: LucideIcon = Palette;

/**
 * The icon of one layer of an FX scene, by what the layer is: a kind icon for text, noise,
 * gradient, picture and shape, one effect icon for every post effect. A layer kind
 * this table does not know falls back to the layers icon, so a new kind needs no change here.
 */
export function fxLayerIconOf(type: string, kind: 'content' | 'post' | null): LucideIcon {
  if (kind === 'post') return WandSparkles;
  switch (type) {
    case 'text': return Type;
    case 'image': return ImageIcon;
    case 'shape': return Shapes;
    case 'noiseFill': return Waves;
    case 'gradient': return Blend;
    default: return Layers;
  }
}
