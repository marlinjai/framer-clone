/* eslint-disable @typescript-eslint/no-explicit-any */
import { types, Instance, SnapshotIn, SnapshotOut, getParent, hasParent as hasMstParent } from 'mobx-state-tree';
import { CSS_PROP_SET } from '@/lib/styles/cssPropSet';
import React from 'react';
import type {
  BindingEntry,
  BindingsRecord,
  ReadBinding,
} from '@/lib/bindings/types';
import type { Query } from '@/lib/bindings/dataSource/types';
import { resolveViewportFrameHeight } from '@/lib/canvas/viewportFrame';
import { hasStockCredit, withImageSrc, withoutStockCredit } from '@/lib/ai/pageGen/stockCredit';
import {
  isResponsiveMap,
  largestFirst,
  resetCascade,
  resolveCascade,
  writeCascade,
  type Resolved,
} from '@/lib/responsive/cascade';

export type PropsRecord = Record<string, any>;

export enum ComponentTypeEnum {
  HOST = 'host',
  FUNCTION = 'function',
}

// Framer-style node types - everything on canvas is a node
export enum CanvasNodeType {
  COMPONENT = 'component',           // Regular component in app tree
  VIEWPORT = 'viewport',             // Breakpoint viewport frame
  FLOATING_ELEMENT = 'floating',     // Floating element (image, text, etc.)
}

export type IntrinsicElementType = keyof React.JSX.IntrinsicElements;
export type IntrinsicElementProps<T extends IntrinsicElementType> = React.JSX.IntrinsicElements[T];
export type FunctionComponentType = string;
export type ComponentType = IntrinsicElementType | FunctionComponentType;

// --- helpers ---
function isObject(x: any): x is Record<string, any> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

export { CSS_PROP_SET };

/** A breakpoint of the page a component lives on: a viewport frame's id, min width and label. */
export interface PageBreakpoint {
  id: string;
  minWidth: number;
  label: string;
}

/**
 * The breakpoints of the page holding `node`, largest first, read from the
 * page's viewport frames. Walks up the tree to the first node that has
 * viewport nodes (the page); PageModel cannot be imported here (it imports
 * this file).
 */
function findPageBreakpoints(node: unknown): PageBreakpoint[] {
  let current: any = node;
  while (current && hasMstParent(current)) {
    current = getParent(current);
    if (current && typeof current === 'object' && 'canvasNodes' in current && 'viewportNodes' in current) {
      const frames = (current.viewportNodes as any[]).filter(v => v.breakpointId);
      return largestFirst(
        frames.map(v => ({
          id: v.breakpointId as string,
          minWidth: (v.breakpointMinWidth as number | undefined) ?? 0,
          label: (v.label as string | undefined) || 'Breakpoint',
        })),
      ) as PageBreakpoint[];
    }
  }
  return [];
}

// ---------- BASE MODEL (no recursion) ----------
const ComponentBase = types.model('ComponentBase', {
  id: types.identifier,
  type: types.string,
  componentType: types.enumeration(Object.values(ComponentTypeEnum)),
  props: types.optional(types.frozen<PropsRecord>(), {}),

  // Data-binding map keyed by binding-slot name (e.g. `children`, `src`,
  // `href`, `style.color`). Stored as a frozen record so MST round-trips
  // the entire object on every mutation — this matches the persisted
  // snapshot shape and avoids per-entry MST overhead. See
  // `src/lib/bindings/types.ts` for the discriminated union; Phase 1 only
  // USES `mode: 'read'` but the union reserves `'write'` and `'two-way'`
  // so a future Phase 2 snapshot round-trips through a Phase 1 client.
  bindings: types.optional(types.frozen<BindingsRecord>(), {}),

  // Framer-style: Canvas node type (determines rendering behavior)
  canvasNodeType: types.optional(types.enumeration(Object.values(CanvasNodeType)), CanvasNodeType.COMPONENT),
  
  // Canvas positioning for root-level nodes (Framer-style)
  // Used by viewport nodes and floating elements
  canvasX: types.maybe(types.number),
  canvasY: types.maybe(types.number),
  canvasScale: types.optional(types.number, 1),
  canvasRotation: types.optional(types.number, 0),
  canvasZIndex: types.optional(types.number, 0),
  
  // Universal label for all component types (replaces breakpointLabel)
  label: types.maybe(types.string),               // Display name (e.g., "Desktop", "Hero Image", "Button")
  
  // Viewport-specific properties (only used when canvasNodeType === 'viewport')
  breakpointId: types.maybe(types.string),        // Associated breakpoint ID
  breakpointMinWidth: types.maybe(types.number),  // CSS min-width for this breakpoint
  viewportWidth: types.maybe(types.number),       // Viewport frame width on canvas
  viewportHeight: types.maybe(types.number),      // Viewport frame height on canvas
  
  // Canvas-level properties
  canvasVisible: types.optional(types.boolean, true),
  canvasLocked: types.optional(types.boolean, false),
  
  // Parent relation tracking (for app tree navigation)
  parentId: types.maybe(types.string),
});

// ---------- FINAL MODEL (add recursive children + logic) ----------
const ComponentModel: any = ComponentBase
  .props({
    children: types.optional(types.array(types.late((): any => ComponentModel)), []),
  })
  // Editor-only layout state, never persisted, synced or recorded in history
  // (volatile state produces no snapshot and no patch). A viewport frame grows
  // with its page content, Framer-style: viewportHeight is the frame's MINIMUM
  // height and renderedViewportHeight is what the frame actually measures on
  // the canvas, reported by ViewportFrame's ResizeObserver. Each breakpoint
  // frame measures independently, so the phone frame can be taller than the
  // desktop one for the same page.
  .volatile(() => ({
    renderedViewportHeight: undefined as number | undefined,
  }))
  .views(self => ({
    /** The breakpoints of the page this component is on, largest first (empty when not on a page). */
    get pageBreakpoints(): PageBreakpoint[] {
      return findPageBreakpoints(self);
    },
  }))
  .views(self => ({
    /**
     * The breakpoints the cascade runs over for an edit on `breakpointId`. A
     * node that is not on a page treats that breakpoint as the only (so the
     * largest) one, and writes `base`.
     */
    cascadeBreakpoints(breakpointId?: string): PageBreakpoint[] {
      const page = self.pageBreakpoints;
      if (page.length > 0) return page;
      return breakpointId ? [{ id: breakpointId, minWidth: 0, label: '' }] : [];
    },

    /**
     * True when an edit on `breakpointId` writes the base: the page's largest
     * breakpoint, no breakpoint (floating elements) or one the page does not
     * know. Every other breakpoint writes an override.
     */
    isLargestBreakpoint(breakpointId?: string): boolean {
      if (!breakpointId) return true;
      const page = self.pageBreakpoints;
      return page.length === 0 || page[0].id === breakpointId || !page.some(b => b.id === breakpointId);
    },
  }))
  .actions(self => ({
    // Record the measured canvas height of a viewport frame (layout px, not
    // zoomed screen px). No-op when unchanged so a ResizeObserver tick does
    // not wake observers needlessly.
    setRenderedViewportHeight(height: number | undefined) {
      const next = height === undefined || !Number.isFinite(height) ? undefined : Math.round(height);
      if (self.renderedViewportHeight !== next) self.renderedViewportHeight = next;
    },

    // Swap an image's src. A different picture no longer matches a stock
    // photo's credit, so withImageSrc drops it.
    setImageSrc(nextSrc: string) {
      self.props = withImageSrc((self.props || {}) as Record<string, unknown>, nextSrc);
    },

    // Canvas positioning actions (for root components)
    setCanvasPosition(x: number, y: number) {
      self.canvasX = Math.round(x);
      self.canvasY = Math.round(y);
    },
    
    updateCanvasTransform(updates: {
      x?: number;
      y?: number;
      scale?: number;
      rotation?: number;
      zIndex?: number;
    }) {
      if (updates.x !== undefined) self.canvasX = Math.round(updates.x);
      if (updates.y !== undefined) self.canvasY = Math.round(updates.y);
      if (updates.scale !== undefined) self.canvasScale = Math.max(0.1, Math.min(10, updates.scale));
      if (updates.rotation !== undefined) self.canvasRotation = updates.rotation % 360;
      if (updates.zIndex !== undefined) self.canvasZIndex = updates.zIndex;
    },
    
    // Viewport node actions (for breakpoint viewports)
    setViewportProperties(updates: {
      breakpointId?: string;
      label?: string;
      breakpointMinWidth?: number;
      viewportWidth?: number;
      viewportHeight?: number;
    }) {
      if (updates.breakpointId !== undefined) self.breakpointId = updates.breakpointId;
      if (updates.label !== undefined) self.label = updates.label;
      if (updates.breakpointMinWidth !== undefined) self.breakpointMinWidth = updates.breakpointMinWidth;
      if (updates.viewportWidth !== undefined) self.viewportWidth = updates.viewportWidth;
      if (updates.viewportHeight !== undefined) self.viewportHeight = updates.viewportHeight;
    },
    
    // Put back a frame's stored minimum height exactly as it was, including
    // "none" (undefined); used when a frame resize gesture is cancelled.
    restoreViewportHeight(height: number | undefined) {
      self.viewportHeight = height;
    },

    // Universal label setter for all component types
    setLabel(label: string) {
      self.label = label;
    },
    
    // Set canvas node type
    setCanvasNodeType(nodeType: CanvasNodeType) {
      self.canvasNodeType = nodeType;
    },
    
    // Children management actions with parent tracking
    addChild(child: ComponentInstance, index?: number) {
      if (typeof index === 'number') {
        const clamped = Math.max(0, Math.min(index, self.children.length));
        self.children.splice(clamped, 0, child);
      } else {
        self.children.push(child);
      }
      // Update parent relation
      child.setParent(self.id);
    },
    
    addChildren(children: ComponentInstance[]) {
      children.forEach(child => {
        self.children.push(child);
        // Update parent relation
        child.setParent(self.id);
      });
    },
    
    removeChild(childId: string) {
      const index = self.children.findIndex(child => child.id === childId);
      if (index !== -1) {
        const child = self.children[index];
        // Clear parent relation
        child.clearParent();
        self.children.splice(index, 1);
      }
    },
    
    clearChildren() {
      // Clear parent relations for all children
      self.children.forEach(child => child.clearParent());
      self.children.clear();
    },
    
    // Parent relation management
    setParent(parentId: string) {
      self.parentId = parentId;
    },
    
    clearParent() {
      self.parentId = undefined;
    },
    
    // Responsive style writes, desktop-first (src/lib/responsive/cascade.ts):
    // an edit on the largest breakpoint (or without one, for floating
    // elements) writes `base`; a smaller breakpoint writes its own override;
    // an empty value there removes the override, so it inherits again. The
    // frozen props object is replaced whole (MST requirement). One action, so
    // one undo step.
    updateResponsiveStyle(property: string, value: any, breakpointId?: string) {
      const currentProps = self.props || {};
      const style: Record<string, any> = { ...(currentProps.style || {}) };
      const next = writeCascade(style[property], value, breakpointId, self.cascadeBreakpoints(breakpointId));
      if (next === undefined) delete style[property];
      else style[property] = next;
      self.props = { ...currentProps, style };
    },

    // Remove the overrides of `properties` on `breakpointId`, so each inherits
    // from the next larger breakpoint again. No-op on the largest breakpoint.
    // One action for all of them, so one undo step (a W / H row resets both).
    resetResponsiveStyles(properties: readonly string[], breakpointId: string) {
      const currentProps = self.props || {};
      const style: Record<string, any> = { ...(currentProps.style || {}) };
      const breakpoints = self.cascadeBreakpoints(breakpointId);
      let changed = false;
      for (const property of properties) {
        if (!(property in style)) continue;
        const next = resetCascade(style[property], breakpointId, breakpoints);
        if (JSON.stringify(next) === JSON.stringify(style[property])) continue;
        changed = true;
        if (next === undefined) delete style[property];
        else style[property] = next;
      }
      if (changed) self.props = { ...currentProps, style };
    },

    // Remove a stock photo's credit (data-credit-* and the hover title), when
    // the photo it describes was replaced by another picture. An action, so it
    // works on the protected tree and is one undoable step.
    clearStockCredit() {
      if (hasStockCredit(self.props)) self.props = withoutStockCredit(self.props);
    },

    // Replace the string text content of this component. Used for inline
    // editing of text / button / heading nodes. Leaves other props untouched.
    setTextContent(value: string) {
      self.props = { ...self.props, children: value };
    },

    // Merge non-style props (a form field's label, name, required flag...).
    // An `undefined` value removes the key. `style` is never touched here:
    // styles go through updateResponsiveStyle.
    setProps(patch: Record<string, unknown>) {
      const next: Record<string, unknown> = { ...(self.props as Record<string, unknown>) };
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'style') continue;
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      self.props = next;
    },

    // Canvas-level actions
    toggleCanvasVisibility() {
      self.canvasVisible = !self.canvasVisible;
    },

    toggleCanvasLock() {
      self.canvasLocked = !self.canvasLocked;
    },

    // ---------- BINDINGS (MST-WRITE) ----------
    // These three mutations are direct MST writes today. Once the
    // multiplayer track lands and Yjs becomes canonical for canvas tree
    // mutations, they MUST route through the same Yjs binding-application
    // path as `addChild` / `removeChild`. See spec
    // `data-bindings-binding-shape-on-component-model` and the
    // multiplayer track's MST-projection design.
    setBinding(slot: string, binding: BindingEntry) {
      // Replace the entire frozen record (MST requirement for frozen
      // types). Spread keeps every other slot intact.
      self.bindings = { ...self.bindings, [slot]: binding };
      // A bound src shows other pictures: a stock photo's credit no longer fits.
      if (slot === 'src' && hasStockCredit(self.props)) self.props = withoutStockCredit(self.props);
    },

    clearBinding(slot: string) {
      if (!(slot in self.bindings)) return;
      const next: BindingsRecord = { ...self.bindings };
      delete next[slot];
      self.bindings = next;
    },

    clearAllBindings() {
      self.bindings = {};
    },

    // ---------- QUERY (MST-WRITE) ----------
    // Structured filter / sort / limit for data components (Collection /
    // TableView). The QueryBuilder picker writes the whole Query object here.
    // This writes into the EXISTING frozen `props` record (NO new `.props()`
    // field on the model) by replacing the entire object, which is the MST
    // requirement for frozen types. Like setBinding / clearBinding above, this
    // is a direct MST write today and MUST route through the same Yjs
    // binding-application path once the multiplayer track lands.
    // MST-WRITE
    setQuery(query: Query) {
      self.props = { ...self.props, query };
    },
  }))
  .actions(self => ({
    /** Remove the override of one style property on `breakpointId` (it inherits again). */
    resetResponsiveStyle(property: string, breakpointId: string) {
      self.resetResponsiveStyles([property], breakpointId);
    },
  }))
  .views(self => ({
    // Views (not actions) so MobX tracks the reads for observer re-renders.

    /**
     * Where the value of a style property on `breakpointId` comes from: its
     * own value, a larger breakpoint, or nowhere (src/lib/responsive/cascade.ts).
     * A plain (non-map) value is the base, so it is the largest breakpoint's
     * own value and inherited from it everywhere smaller.
     */
    getResponsiveStyleSource(property: string, breakpointId?: string): Resolved {
      const stored = (self.props?.style || {})[property];
      const breakpoints = self.cascadeBreakpoints(breakpointId);
      const resolved = resolveCascade(stored, breakpointId, breakpoints);
      if (resolved.source.kind !== 'base') return resolved;
      const primaryId = breakpoints[0]?.id;
      return {
        value: resolved.value,
        source: self.isLargestBreakpoint(breakpointId) || !primaryId
          ? { kind: 'own' }
          : { kind: 'inherited', breakpointId: primaryId },
      };
    },

    /** The value a style property renders with on `breakpointId`: exactly what the canvas shows. */
    getResponsiveStyleValue(property: string, breakpointId?: string): any {
      return this.getResponsiveStyleSource(property, breakpointId).value;
    },

    /**
     * The value set on `breakpointId` itself (its override, or the base on the
     * largest breakpoint); undefined when it is inherited. For code that must
     * restore exactly what was stored, such as a cancelled drag: writing an
     * inherited value back would create an override that never existed.
     */
    getOwnResponsiveStyleValue(property: string, breakpointId?: string): any {
      const resolved = this.getResponsiveStyleSource(property, breakpointId);
      return resolved.source.kind === 'own' ? resolved.value : undefined;
    },

    get isHostElement() { return self.componentType === ComponentTypeEnum.HOST; },
    get isFunctionComponent() { return self.componentType === ComponentTypeEnum.FUNCTION; },
    
    // Framer-style node type checks
    get isCanvasNode(): boolean {
      return self.canvasNodeType !== CanvasNodeType.COMPONENT;
    },
    
    get isViewportNode(): boolean {
      return self.canvasNodeType === CanvasNodeType.VIEWPORT;
    },
    
    get isFloatingElement(): boolean {
      return self.canvasNodeType === CanvasNodeType.FLOATING_ELEMENT;
    },
    
    get isAppComponent(): boolean {
      return self.canvasNodeType === CanvasNodeType.COMPONENT;
    },
    
    // Check if this is a root canvas node (has canvas positioning)
    get isRootCanvasComponent(): boolean {
      return self.canvasX !== undefined && self.canvasY !== undefined;
    },
    
    // Get CSS transform for canvas positioning
    get canvasTransform(): string {
      if (!this.isRootCanvasComponent) return '';
      return `translate(${self.canvasX}px, ${self.canvasY}px) scale(${self.canvasScale}) rotate(${self.canvasRotation}deg)`;
    },
    
    // Get canvas bounds
    get canvasBounds() {
      if (!this.isRootCanvasComponent) return null;
      
      const width = self.props?.width || self.props?.style?.width || 200;
      const height = self.props?.height || self.props?.style?.height || 100;
      
      return {
        x: self.canvasX!,
        y: self.canvasY!,
        width: typeof width === 'string' ? parseInt(width) : width,
        height: typeof height === 'string' ? parseInt(height) : height,
      };
    },
    
    // Check if component is editable on canvas
    get isCanvasEditable(): boolean {
      return !self.canvasLocked && self.canvasVisible;
    },
    
    // Parent relation views
    get hasParent(): boolean {
      return !!self.parentId;
    },
    
    get isRootComponent(): boolean {
      return !self.parentId;
    },
    
    // Viewport node specific views
    get viewportBounds() {
      if (!this.isViewportNode) return null;
      // Height is the frame's real height on the canvas: at least the
      // configured minimum (viewportHeight), grown to fit the page content.
      return {
        x: self.canvasX!,
        y: self.canvasY!,
        width: self.viewportWidth || 400,
        height: resolveViewportFrameHeight(self.viewportHeight || 600, self.renderedViewportHeight),
      };
    },
    
    get breakpointInfo() {
      if (!this.isViewportNode) return null;
      return {
        id: self.breakpointId!,
        label: self.label || 'Unnamed',
        minWidth: self.breakpointMinWidth || 320,
      };
    },
    
    // Get display name for any component type
    get displayName(): string {
      if (self.label) return self.label;
      
      // Fallback based on component type
      switch (self.type) {
        case 'img': return 'Image';
        case 'div': return this.isViewportNode ? 'Viewport' : 'Container';
        case 'header': return 'Header';
        case 'main': return 'Main';
        case 'button': return 'Button';
        case 'p': return 'Paragraph';
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'Heading';
        default: return self.type.charAt(0).toUpperCase() + self.type.slice(1);
      }
    },

    // ---------- BINDINGS (read-only views) ----------
    getBinding(slot: string): BindingEntry | undefined {
      return self.bindings[slot];
    },

    get hasBindings(): boolean {
      return Object.keys(self.bindings).length > 0;
    },

    /**
     * Filtered view of bindings restricted to read-mode entries. Phase 1
     * consumers (resolver runtime, render path) only act on read bindings;
     * `'write'` and `'two-way'` entries are ignored until Phase 2 ships.
     */
    get readBindings(): Record<string, ReadBinding> {
      const out: Record<string, ReadBinding> = {};
      for (const [slot, entry] of Object.entries(self.bindings)) {
        if (entry && entry.mode === 'read') {
          out[slot] = entry;
        }
      }
      return out;
    },

    // Resolve every responsive map (top-level props and nested style) for one
    // breakpoint with the desktop-first cascade (src/lib/responsive/cascade.ts).
    // `allBreakpoints` must be all of the page's breakpoints: the primary is
    // derived from their min widths (the largest). Non-map values pass
    // through unchanged. An empty
    // breakpoint id (floating elements) reads as the largest breakpoint.
    getResolvedProps(breakpointId: string, allBreakpoints: { id: string; minWidth: number }[]) {
      const bpIds = new Set(allBreakpoints.map(bp => bp.id));
      // A map with no value at or above this breakpoint (a Tablet-only
      // paddingTop, seen from Desktop) is left out entirely, never emitted as
      // `undefined`: React clears a style key that goes from undefined to
      // absent with `paddingTop: ''`, which also wipes that side of an
      // unchanged `padding` shorthand (seen on undo in the browser).
      const assign = (target: Record<string, any>, key: string, raw: unknown) => {
        if (!isResponsiveMap(raw, bpIds)) {
          target[key] = raw;
          return;
        }
        const value = resolveCascade(raw, breakpointId, allBreakpoints).value;
        if (value !== undefined) target[key] = value;
      };

      const attributes: Record<string, any> = {};
      const style: Record<string, any> = {};

      // resolve top-level props
      for (const [key, raw] of Object.entries(self.props)) {
        if (key === 'style') continue;
        assign(CSS_PROP_SET.has(key) ? style : attributes, key, raw);
      }

      // resolve nested style
      const rawStyle = (self.props as any).style;
      if (isObject(rawStyle)) {
        for (const [sKey, sVal] of Object.entries(rawStyle)) assign(style, sKey, sVal);
      }

      return { attributes, style };
    },
  }));

export type ComponentInstance = Instance<typeof ComponentModel>;
export type ComponentSnapshotIn = SnapshotIn<typeof ComponentModel>;
export type ComponentSnapshotOut = SnapshotOut<typeof ComponentModel>;

// ---------- HELPERS ----------
export const createIntrinsicComponent = <T extends IntrinsicElementType>(
  id: string,
  type: T,
  props: PropsRecord
): ComponentInstance =>
  ComponentModel.create({
    id,
    type,
    componentType: ComponentTypeEnum.HOST,
    props,
  });

export const createFunctionComponent = (
  id: string,
  type: FunctionComponentType,
  props: PropsRecord
): ComponentInstance =>
  ComponentModel.create({
    id,
    type,
    componentType: ComponentTypeEnum.FUNCTION,
    props,
  });

// Create root canvas component with absolute positioning (Framer-style)
export const createFloatingCanvasComponent = <T extends IntrinsicElementType>(
  id: string,
  type: T,
  props: PropsRecord,
  x: number,
  y: number,
  options: {
    scale?: number;
    rotation?: number;
    zIndex?: number;
    visibleFromBreakpoint?: string;
    visibleUntilBreakpoint?: string;
  } = {}
): ComponentInstance =>
  ComponentModel.create({
    id,
    type,
    componentType: ComponentTypeEnum.HOST,
    canvasNodeType: CanvasNodeType.FLOATING_ELEMENT,
    props,
    canvasX: x,
    canvasY: y,
    canvasScale: options.scale || 1,
    canvasRotation: options.rotation || 0,
    canvasZIndex: options.zIndex || 0,
    visibleFromBreakpoint: options.visibleFromBreakpoint,
    visibleUntilBreakpoint: options.visibleUntilBreakpoint,
  });

// Create viewport node (Framer-style breakpoint viewport)
export const createViewportNode = (
  id: string,
  breakpointId: string,
  label: string,
  breakpointMinWidth: number,
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  options: {
    scale?: number;
    rotation?: number;
    zIndex?: number;
  } = {}
): ComponentInstance =>
  ComponentModel.create({
    id,
    type: 'div', // Viewport container is always a div
    componentType: ComponentTypeEnum.HOST,
    canvasNodeType: CanvasNodeType.VIEWPORT,
    label, // Universal label property
    props: {
      className: 'viewport-frame',
      style: {
        // Mirrors the canvas frame (ResponsivePageRenderer's ViewportFrame):
        // viewportHeight is a minimum, the frame grows with its content.
        width: `${viewportWidth}px`,
        minHeight: `${viewportHeight}px`,
        backgroundColor: 'white',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        overflow: 'hidden',
      }
    },
    canvasX: x,
    canvasY: y,
    canvasScale: options.scale || 1,
    canvasRotation: options.rotation || 0,
    canvasZIndex: options.zIndex || 0,
    breakpointId,
    breakpointMinWidth,
    viewportWidth,
    viewportHeight,
  });

export default ComponentModel;