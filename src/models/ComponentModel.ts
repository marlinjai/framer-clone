/* eslint-disable @typescript-eslint/no-explicit-any */
import { types, Instance, SnapshotIn, SnapshotOut } from 'mobx-state-tree';
import React from 'react';

export type PropsRecord = Record<string, any>;

export enum ComponentTypeEnum {
  HOST = 'host',
  FUNCTION = 'function',
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
  
  // Canvas positioning for root-level components (Framer-style)
  // Only used when component has no parent (is a root canvas component)
  canvasX: types.maybe(types.number),
  canvasY: types.maybe(types.number),
  canvasScale: types.optional(types.number, 1),
  canvasRotation: types.optional(types.number, 0),
  canvasZIndex: types.optional(types.number, 0),
  
  // Breakpoint visibility constraints (like Framer)
  visibleFromBreakpoint: types.maybe(types.string), // breakpoint ID
  visibleUntilBreakpoint: types.maybe(types.string), // breakpoint ID
  
  // Canvas-level properties
  canvasVisible: types.optional(types.boolean, true),
  canvasLocked: types.optional(types.boolean, false),
});

// ---------- FINAL MODEL (add recursive children + logic) ----------
const ComponentModel = ComponentBase
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
    
    // Breakpoint visibility actions
    setBreakpointVisibility(fromBreakpoint?: string, untilBreakpoint?: string) {
      self.visibleFromBreakpoint = fromBreakpoint;
      self.visibleUntilBreakpoint = untilBreakpoint;
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
    
    // Check if this is a root canvas component (has canvas positioning)
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
export const createRootCanvasComponent = <T extends IntrinsicElementType>(
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
    props,
    canvasX: x,
    canvasY: y,
    canvasScale: options.scale || 1,
    canvasRotation: options.rotation || 0,
    canvasZIndex: options.zIndex || 0,
    visibleFromBreakpoint: options.visibleFromBreakpoint,
    visibleUntilBreakpoint: options.visibleUntilBreakpoint,
  });

export default ComponentModel;