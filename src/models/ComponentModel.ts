/* eslint-disable @typescript-eslint/no-explicit-any */
import { types, Instance, SnapshotIn, SnapshotOut } from 'mobx-state-tree';
import React from 'react';

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

export const CSS_PROP_SET = new Set<string>([
  'width','height','minWidth','minHeight','maxWidth','maxHeight',
  'display','position','top','right','bottom','left','inset',
  'padding','paddingTop','paddingRight','paddingBottom','paddingLeft',
  'margin','marginTop','marginRight','marginBottom','marginLeft',
  'gap','rowGap','columnGap',
  'flex','flexGrow','flexShrink','flexBasis','flexDirection','flexWrap','alignItems','alignContent','alignSelf','justifyItems','justifySelf','justifyContent','order',
  'grid','gridTemplate','gridTemplateColumns','gridTemplateRows','gridTemplateAreas','gridArea','gridColumn','gridRow','gridAutoFlow','gridAutoRows','gridAutoColumns',
  'font','fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','textAlign','textDecoration','textTransform','whiteSpace',
  'color','background','backgroundColor','backgroundImage','backgroundSize','backgroundPosition','backgroundRepeat','backgroundClip',
  'border','borderWidth','borderStyle','borderColor','borderTop','borderRight','borderBottom','borderLeft',
  'borderRadius','borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius','boxShadow','outline',
  'opacity','filter','backdropFilter','mixBlendMode',
  'transform','transformOrigin','transition','transitionProperty','transitionDuration','transitionDelay','transitionTimingFunction',
  'overflow','overflowX','overflowY','zIndex','cursor','objectFit','objectPosition'
]);

function isResponsiveMap(v: any, breakpointIds: Set<string>): v is Record<string, any> {
  return isObject(v) && Object.keys(v).some(k => breakpointIds.has(k) || k === 'base');
}

function resolveResponsiveValue(
  map: Record<string, any>,
  breakpointId: string,
  ordered: { id: string; minWidth: number }[],
  primaryId: string
) {
  if (map[breakpointId] !== undefined) return map[breakpointId];
  if (map[primaryId] !== undefined) return map[primaryId];

  const idx = ordered.findIndex(b => b.id === breakpointId);

  // search smaller first
  for (let i = idx - 1; i >= 0; i--) {
    const id = ordered[i].id;
    if (map[id] !== undefined) return map[id];
  }

  // then search larger
  for (let i = idx + 1; i < ordered.length; i++) {
    const id = ordered[i].id;
    if (map[id] !== undefined) return map[id];
  }

  return map.base;
}

// ---------- BASE MODEL (no recursion) ----------
const ComponentBase = types.model('ComponentBase', {
  id: types.identifier,
  type: types.string,
  componentType: types.enumeration(Object.values(ComponentTypeEnum)),
  props: types.optional(types.frozen<PropsRecord>(), {}),
  
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
});

// ---------- FINAL MODEL (add recursive children + logic) ----------
const ComponentModel: any = ComponentBase
  .props({
    children: types.optional(types.array(types.late((): any => ComponentModel)), []),
  })
  .actions(self => ({
    // Canvas positioning actions (for root components)
    setCanvasPosition(x: number, y: number) {
      self.canvasX = x;
      self.canvasY = y;
    },
    
    updateCanvasTransform(updates: {
      x?: number;
      y?: number;
      scale?: number;
      rotation?: number;
      zIndex?: number;
    }) {
      if (updates.x !== undefined) self.canvasX = updates.x;
      if (updates.y !== undefined) self.canvasY = updates.y;
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
    
    // Universal label setter for all component types
    setLabel(label: string) {
      self.label = label;
    },
    
    // Set canvas node type
    setCanvasNodeType(nodeType: CanvasNodeType) {
      self.canvasNodeType = nodeType;
    },
    
    // Children management actions
    addChild(child: ComponentInstance) {
      self.children.push(child);
    },
    
    addChildren(children: ComponentInstance[]) {
      children.forEach(child => self.children.push(child));
    },
    
    removeChild(childId: string) {
      const index = self.children.findIndex(child => child.id === childId);
      if (index !== -1) {
        self.children.splice(index, 1);
      }
    },
    
    clearChildren() {
      self.children.clear();
    },
    
    // Canvas-level actions
    toggleCanvasVisibility() {
      self.canvasVisible = !self.canvasVisible;
    },
    
    toggleCanvasLock() {
      self.canvasLocked = !self.canvasLocked;
    },
  }))
  .views(self => ({
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
    
    // Viewport node specific views
    get viewportBounds() {
      if (!this.isViewportNode) return null;
      return {
        x: self.canvasX!,
        y: self.canvasY!,
        width: self.viewportWidth || 400,
        height: self.viewportHeight || 600,
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

    // In a real app, you’d traverse up to project/page to access breakpoints
    getResolvedProps(breakpointId: string, allBreakpoints: { id: string; minWidth: number }[], primaryId: string) {
      const ordered = [...allBreakpoints].sort((a,b)=>a.minWidth-b.minWidth);
      const bpIds = new Set(ordered.map(bp => bp.id));

      const attributes: Record<string, any> = {};
      const style: Record<string, any> = {};

      // resolve top-level props
      for (const [key, raw] of Object.entries(self.props)) {
        if (key === 'style') continue;

        if (isResponsiveMap(raw, bpIds)) {
          const val = resolveResponsiveValue(raw, breakpointId, ordered, primaryId);
          if (CSS_PROP_SET.has(key)) style[key] = val;
          else attributes[key] = val;
        } else {
          if (CSS_PROP_SET.has(key)) style[key] = raw;
          else attributes[key] = raw;
        }
      }

      // resolve nested style
      const rawStyle = (self.props as any).style;
      if (isObject(rawStyle)) {
        for (const [sKey, sVal] of Object.entries(rawStyle)) {
          if (isResponsiveMap(sVal, bpIds)) {
            style[sKey] = resolveResponsiveValue(sVal, breakpointId, ordered, primaryId);
          } else {
            style[sKey] = sVal;
          }
        }
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
        width: `${viewportWidth}px`,
        height: `${viewportHeight}px`,
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