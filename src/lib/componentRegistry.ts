// src/lib/componentRegistry.ts
// Central schema for components the user can drag from the ComponentsPanel
// onto a viewport or the canvas. Each entry defines the underlying HTML type,
// sensible default props (including style), and a default size used when the
// component is dropped as a floating canvas element.
//
// Per-entry `bindableSlots` declare which prop paths can be bound to a data
// source (collection field, row field, page param) and in what mode. Phase 1
// renders only `mode: 'read'` slots; the shape RESERVES `'write'` and the
// `columnTypeFilter` field on `BindableSlotMeta` so the Phase 2 picker UI can
// grow without a registry-format breaking change. See
// `docs/specs/wave-1/data-bindings-component-registry-bindable-slots.md`.

import type { LucideIcon } from 'lucide-react';
import {
  Type,
  Square,
  Image as ImageIcon,
  Container as ContainerIcon,
  Columns,
  Grid as GridIcon,
  AlignVerticalSpaceAround,
  LayoutGrid,
  List as ListIcon,
  FileText as FileTextIcon,
  Table as TableIcon,
} from 'lucide-react';
import type { IntrinsicElementType, PropsRecord } from '@/models/ComponentModel';
import type { BindableSlotMeta } from '@/lib/bindings/types';

export type ComponentCategory = 'basic' | 'layout' | 'data';

/**
 * Phase 1 data-component variants. The renderer dispatches on this field to
 * the right wave-2 handler (`data-bindings-read-only-data-components`); Phase
 * 1 ships only a dashed-box placeholder when the component is unbound.
 */
export type DataComponentKind = 'collection' | 'record-view' | 'table-view';

export interface ComponentRegistryEntry {
  id: string;
  label: string;
  category: ComponentCategory;
  icon: LucideIcon;
  iconClassName: string;
  htmlType: IntrinsicElementType;
  defaultProps: PropsRecord;
  defaultSize: { width: number; height: number };
  /**
   * Which prop paths on this component can be bound to a data source. Keyed
   * by intrinsic-prop name (`children`, `src`, `href`) — dot-paths supported
   * for style sub-properties (`style.color`). Omit the field for components
   * that cannot be bound (Phase 1 layout primitives, for instance).
   */
  bindableSlots?: Record<string, BindableSlotMeta>;
  /**
   * Marker for Phase 1 read-only data components. The renderer dispatches on
   * this field; the ComponentsPanel surfaces these under the `'Data'`
   * category. Omitted for non-data components.
   */
  dataComponentKind?: DataComponentKind;
}

export const COMPONENT_REGISTRY: Record<string, ComponentRegistryEntry> = {
  text: {
    id: 'text',
    label: 'Text',
    category: 'basic',
    icon: Type,
    iconClassName: 'bg-purple-100 text-purple-600',
    htmlType: 'p',
    defaultProps: {
      children: 'Text',
      style: {
        fontSize: '16px',
        fontFamily: 'Inter, sans-serif',
        color: '#111827',
        margin: 0,
        padding: '8px',
      },
    },
    defaultSize: { width: 200, height: 40 },
    bindableSlots: {
      children: { label: 'Text', allowedModes: ['read'], scopeHint: 'any' },
    },
  },
  button: {
    id: 'button',
    label: 'Button',
    category: 'basic',
    icon: Square,
    iconClassName: 'bg-green-100 text-green-600',
    htmlType: 'button',
    defaultProps: {
      children: 'Button',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '8px 16px',
        backgroundColor: '#111827',
        color: 'white',
        fontFamily: 'Inter, sans-serif',
        fontSize: '14px',
        fontWeight: 500,
        border: 'none',
        borderRadius: '6px',
        cursor: 'pointer',
      },
    },
    defaultSize: { width: 120, height: 40 },
    bindableSlots: {
      children: { label: 'Label', allowedModes: ['read'], scopeHint: 'any' },
    },
  },
  image: {
    id: 'image',
    label: 'Image',
    category: 'basic',
    icon: ImageIcon,
    iconClassName: 'bg-orange-100 text-orange-600',
    htmlType: 'img',
    defaultProps: {
      src: '/images/sample-image.jpg',
      alt: 'Image',
      draggable: false,
      style: {
        display: 'block',
        width: '240px',
        height: '160px',
        borderRadius: '8px',
        objectFit: 'cover',
        userSelect: 'none',
      },
    },
    defaultSize: { width: 240, height: 160 },
    bindableSlots: {
      src: { label: 'Image source', allowedModes: ['read'], scopeHint: 'any' },
      alt: { label: 'Alt text', allowedModes: ['read'], scopeHint: 'any' },
    },
  },
  container: {
    id: 'container',
    label: 'Container',
    category: 'basic',
    icon: ContainerIcon,
    iconClassName: 'bg-blue-100 text-blue-600',
    htmlType: 'div',
    defaultProps: {
      // Fluid defaults: inside a tree, Container fills its parent and grows
      // with children. As a floating element on the canvas, the GroundWrapper
      // in ResponsivePageRenderer falls back to `defaultSize` when width /
      // height aren't fixed pixels, so Container still appears as a visible
      // 240×160-ish box on empty canvas while behaving properly in the tree.
      style: {
        display: 'block',
        width: '100%',
        height: 'auto',
        minHeight: '80px',
        padding: '16px',
        backgroundColor: '#f9fafb',
        border: '1px dashed #d1d5db',
        borderRadius: '8px',
      },
    },
    defaultSize: { width: 240, height: 160 },
  },
  stack: {
    id: 'stack',
    label: 'Stack',
    category: 'layout',
    icon: AlignVerticalSpaceAround,
    iconClassName: 'bg-purple-100 text-purple-600',
    htmlType: 'div',
    defaultProps: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '16px',
        width: '240px',
        minHeight: '120px',
        backgroundColor: '#f9fafb',
        border: '1px dashed #d1d5db',
        borderRadius: '8px',
      },
    },
    defaultSize: { width: 240, height: 160 },
  },
  grid: {
    id: 'grid',
    label: 'Grid',
    category: 'layout',
    icon: GridIcon,
    iconClassName: 'bg-pink-100 text-pink-600',
    htmlType: 'div',
    defaultProps: {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: '12px',
        padding: '16px',
        width: '360px',
        minHeight: '160px',
        backgroundColor: '#f9fafb',
        border: '1px dashed #d1d5db',
        borderRadius: '8px',
      },
    },
    defaultSize: { width: 360, height: 200 },
  },
  flex: {
    id: 'flex',
    label: 'Flex',
    category: 'layout',
    icon: Columns,
    iconClassName: 'bg-cyan-100 text-cyan-600',
    htmlType: 'div',
    defaultProps: {
      style: {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: '12px',
        padding: '16px',
        width: '360px',
        minHeight: '80px',
        backgroundColor: '#f9fafb',
        border: '1px dashed #d1d5db',
        borderRadius: '8px',
      },
    },
    defaultSize: { width: 360, height: 120 },
  },
  card: {
    id: 'card',
    label: 'Card',
    category: 'layout',
    icon: LayoutGrid,
    iconClassName: 'bg-gray-100 text-gray-600',
    htmlType: 'div',
    defaultProps: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '20px',
        width: '280px',
        minHeight: '160px',
        backgroundColor: 'white',
        border: '1px solid #e5e7eb',
        borderRadius: '12px',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
      },
    },
    defaultSize: { width: 280, height: 200 },
  },

  // ---------- DATA COMPONENTS (Phase 1 placeholders) ----------
  // Registry entries only. Real rendering — collection fetch, row scope
  // propagation, template resolution — lands in the wave-2 spec
  // `data-bindings-read-only-data-components`. Phase 1 ships a dashed-box
  // placeholder via the `data-component-kind` attribute branch in
  // `createComponentElement`.
  collection: {
    id: 'collection',
    label: 'Collection',
    category: 'data',
    dataComponentKind: 'collection',
    icon: ListIcon,
    iconClassName: 'bg-emerald-100 text-emerald-600',
    htmlType: 'div',
    defaultProps: {
      // `data-component-kind` is the dispatch marker the renderer reads to
      // pick the placeholder branch. It also survives a static-HTML render
      // pass so Wave 2 hydration can find these nodes.
      'data-component-kind': 'collection',
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '16px',
        minHeight: '120px',
        border: '1px dashed #d1d5db',
        borderRadius: '8px',
        backgroundColor: '#f9fafb',
      },
    },
    defaultSize: { width: 360, height: 240 },
    bindableSlots: {
      collection: {
        label: 'Source collection',
        allowedModes: ['read'],
        scopeHint: 'collection',
      },
      // `filter`, `sort`, `limit` are transient query props the wave-2 picker
      // surfaces; declared here so the picker has them in its menu from day
      // one even though Phase 1 doesn't act on them.
      filter: { label: 'Filter', allowedModes: ['read'], scopeHint: 'collection' },
      sort: { label: 'Sort', allowedModes: ['read'], scopeHint: 'collection' },
      limit: { label: 'Limit', allowedModes: ['read'], scopeHint: 'collection' },
    },
  },
  recordView: {
    id: 'recordView',
    label: 'Record view',
    category: 'data',
    dataComponentKind: 'record-view',
    icon: FileTextIcon,
    iconClassName: 'bg-emerald-100 text-emerald-600',
    htmlType: 'div',
    defaultProps: {
      'data-component-kind': 'record-view',
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '16px',
        minHeight: '120px',
        border: '1px dashed #d1d5db',
        borderRadius: '8px',
        backgroundColor: '#f9fafb',
      },
    },
    defaultSize: { width: 320, height: 200 },
    bindableSlots: {
      // A single row selected by page route param / explicit collectionId+id.
      record: { label: 'Record', allowedModes: ['read'], scopeHint: 'row' },
    },
  },
  tableView: {
    id: 'tableView',
    label: 'Table view',
    category: 'data',
    dataComponentKind: 'table-view',
    icon: TableIcon,
    iconClassName: 'bg-emerald-100 text-emerald-600',
    htmlType: 'div',
    defaultProps: {
      'data-component-kind': 'table-view',
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '16px',
        minHeight: '160px',
        border: '1px dashed #d1d5db',
        borderRadius: '8px',
        backgroundColor: '#f9fafb',
      },
    },
    defaultSize: { width: 480, height: 280 },
    bindableSlots: {
      collection: {
        label: 'Source collection',
        allowedModes: ['read'],
        scopeHint: 'collection',
      },
      filter: { label: 'Filter', allowedModes: ['read'], scopeHint: 'collection' },
      sort: { label: 'Sort', allowedModes: ['read'], scopeHint: 'collection' },
      limit: { label: 'Limit', allowedModes: ['read'], scopeHint: 'collection' },
    },
  },
};

export const listComponentsByCategory = (
  category: ComponentCategory
): ComponentRegistryEntry[] =>
  Object.values(COMPONENT_REGISTRY).filter((entry) => entry.category === category);

export const getComponentEntry = (id: string): ComponentRegistryEntry | undefined =>
  COMPONENT_REGISTRY[id];

/**
 * Look up the bindable-slot metadata for a registry entry. Returns an empty
 * object for entries that have no `bindableSlots` declared, so the editor
 * binding picker (wave-2 spec) can call this unconditionally without a
 * null-check at every call site.
 */
export const getBindableSlotsFor = (
  componentTypeId: string
): Record<string, BindableSlotMeta> =>
  COMPONENT_REGISTRY[componentTypeId]?.bindableSlots ?? {};
