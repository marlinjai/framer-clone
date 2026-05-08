// src/lib/componentRegistry.ts
// Central schema for components the user can drag from the ComponentsPanel
// onto a viewport or the canvas. Each entry defines the underlying HTML type,
// sensible default props (including style), and a default size used when the
// component is dropped as a floating canvas element.

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
} from 'lucide-react';
import type { IntrinsicElementType, PropsRecord } from '@/models/ComponentModel';

export type ComponentCategory = 'basic' | 'layout';

export interface ComponentRegistryEntry {
  id: string;
  label: string;
  category: ComponentCategory;
  icon: LucideIcon;
  iconClassName: string;
  htmlType: IntrinsicElementType;
  defaultProps: PropsRecord;
  defaultSize: { width: number; height: number };
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
};

export const listComponentsByCategory = (
  category: ComponentCategory
): ComponentRegistryEntry[] =>
  Object.values(COMPONENT_REGISTRY).filter((entry) => entry.category === category);

export const getComponentEntry = (id: string): ComponentRegistryEntry | undefined =>
  COMPONENT_REGISTRY[id];
