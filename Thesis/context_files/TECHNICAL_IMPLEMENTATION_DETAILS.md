# Technical Implementation Details: Code Architecture and Patterns

## Overview

This document provides detailed technical analysis of the implemented visual application builder, focusing on specific code patterns, architectural decisions, and implementation strategies that enable real-time visual editing with React runtime architecture.

## 1. MobX State Tree Implementation

### 1.1 Component Model Architecture

The system implements a unified component model that serves both hierarchical component trees and floating canvas elements:

#### Core ComponentModel Structure
```typescript
// src/models/ComponentModel.ts
const ComponentBase = types.model('ComponentBase', {
  // Core identity and type
  id: types.identifier,
  type: types.string,
  componentType: types.enumeration(['HOST', 'FUNCTION']),
  props: types.optional(types.frozen<PropsRecord>(), {}),
  
  // Canvas positioning for root-level components (Framer-style)
  canvasX: types.maybe(types.number),
  canvasY: types.maybe(types.number), 
  canvasScale: types.optional(types.number, 1),
  canvasRotation: types.optional(types.number, 0),
  canvasZIndex: types.optional(types.number, 0),
  
  // Breakpoint visibility constraints
  visibleFromBreakpoint: types.maybe(types.string),
  visibleUntilBreakpoint: types.maybe(types.string),
  
  // Canvas-level properties
  canvasVisible: types.optional(types.boolean, true),
  canvasLocked: types.optional(types.boolean, false),
});

const ComponentModel = ComponentBase
  .props({
    children: types.optional(types.array(types.late(() => ComponentModel)), [])
  })
  .actions(self => ({
    // Canvas positioning actions
    updateCanvasTransform(updates: {
      x?: number; y?: number; scale?: number; 
      rotation?: number; zIndex?: number;
    }) {
      if (updates.x !== undefined) self.canvasX = updates.x;
      if (updates.y !== undefined) self.canvasY = updates.y;
      if (updates.scale !== undefined) 
        self.canvasScale = Math.max(0.1, Math.min(10, updates.scale));
      if (updates.rotation !== undefined) 
        self.canvasRotation = updates.rotation % 360;
      if (updates.zIndex !== undefined) 
        self.canvasZIndex = updates.zIndex;
    }
  }))
  .views(self => ({
    get isRootCanvasComponent(): boolean {
      return self.canvasX !== undefined && self.canvasY !== undefined;
    },
    
    get canvasTransform(): string {
      if (!this.isRootCanvasComponent) return '';
      return `translate(${self.canvasX}px, ${self.canvasY}px) scale(${self.canvasScale}) rotate(${self.canvasRotation}deg)`;
    },
    
    get canvasBounds() {
      if (!this.isRootCanvasComponent) return null;
      const width = self.props?.width || 200;
      const height = self.props?.height || 100;
      return {
        x: self.canvasX!,
        y: self.canvasY!,
        width: typeof width === 'string' ? parseInt(width) : width,
        height: typeof height === 'string' ? parseInt(height) : height,
      };
    }
  }));
```

#### Key Design Decisions

1. **Unified Model**: Both hierarchical components and floating elements use the same model
2. **Optional Canvas Properties**: Canvas positioning only applies to root-level components
3. **Computed Properties**: Transform strings and bounds calculated on-demand
4. **Type Safety**: MST provides runtime type checking and TypeScript integration

### 1.2 Responsive Property Resolution

The system implements sophisticated responsive property resolution with breakpoint inheritance:

```typescript
// src/models/ComponentModel.ts
function resolveResponsiveValue(
  map: Record<string, any>,
  breakpointId: string,
  ordered: { id: string; minWidth: number }[],
  primaryId: string
) {
  // Direct match
  if (map[breakpointId] !== undefined) return map[breakpointId];
  
  // Primary breakpoint fallback
  if (map[primaryId] !== undefined) return map[primaryId];

  const idx = ordered.findIndex(b => b.id === breakpointId);

  // Search smaller breakpoints first (mobile-first approach)
  for (let i = idx - 1; i >= 0; i--) {
    const id = ordered[i].id;
    if (map[id] !== undefined) return map[id];
  }

  // Then search larger breakpoints
  for (let i = idx + 1; i < ordered.length; i++) {
    const id = ordered[i].id;
    if (map[id] !== undefined) return map[id];
  }

  return map.base; // Final fallback
}

// Usage in component rendering
getResolvedProps(breakpointId: string, allBreakpoints: BreakpointType[], primaryId: string) {
  const ordered = [...allBreakpoints].sort((a,b) => a.minWidth - b.minWidth);
  const bpIds = new Set(ordered.map(bp => bp.id));
  
  const attributes: Record<string, any> = {};
  const style: Record<string, any> = {};

  // Resolve top-level props
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

  return { attributes, style };
}
```

### 1.3 Page and Project Models

#### PageModel Structure
```typescript
// src/models/PageModel.ts
const PageModel = PageBase
  .props({
    rootComponent: types.late(() => ComponentModel),
    rootCanvasComponents: types.optional(types.map(ComponentModel), {})
  })
  .actions(self => ({
    addRootCanvasComponent(component: ComponentInstance | ComponentSnapshotIn) {
      self.rootCanvasComponents.set(component.id, component);
      self.updatedAt = new Date();
    },
    
    removeRootCanvasComponent(componentId: string) {
      self.rootCanvasComponents.delete(componentId);
      self.updatedAt = new Date();
    }
  }))
  .views(self => ({
    get rootCanvasComponentsArray(): ComponentInstance[] {
      return Array.from(self.rootCanvasComponents.values());
    },
    
    get visibleRootCanvasComponents(): ComponentInstance[] {
      return this.rootCanvasComponentsArray.filter(comp => comp.canvasVisible);
    }
  }));
```

#### ProjectModel with Breakpoint Management
```typescript
// src/models/ProjectModel.ts
export const ProjectModel = types
  .model('Project', {
    id: types.identifier,
    metadata: ProjectMetadataModel,
    breakpoints: types.map(BreakpointModel),
    primaryBreakpoint: types.reference(BreakpointModel),
    pages: types.map(PageModel),
  })
  .actions(self => ({
    addBreakpoint(label: string, minWidth: number): BreakpointType {
      const breakpointId = uuidv4();
      self.breakpoints.set(breakpointId, {
        id: breakpointId, label, minWidth
      });
      return self.breakpoints.get(breakpointId)!;
    },
    
    updateBreakpoint(breakpointId: string, updates: Partial<BreakpointSnapshotIn>) {
      const breakpoint = self.breakpoints.get(breakpointId);
      if (breakpoint) {
        applySnapshot(breakpoint, { ...getSnapshot(breakpoint), ...updates });
      }
    }
  }));
```

## 2. High-Performance Canvas Implementation

### 2.1 TransformContext Architecture

The canvas implements a sophisticated ref + subscription pattern for zero-React-render transforms:

```typescript
// src/contexts/TransformContext.tsx
export const TransformProvider: React.FC<TransformProviderProps> = ({ children }) => {
  // Transform state as ref - single source of truth
  const transformState = useRef<CanvasTransform>({
    zoom: 1, panX: 0, panY: 0
  });
  
  // Subscriber management
  const subscribers = useRef<Set<() => void>>(new Set());
  
  const subscribe = (callback: () => void): (() => void) => {
    subscribers.current.add(callback);
    return () => subscribers.current.delete(callback);
  };
  
  const notifySubscribers = () => {
    subscribers.current.forEach(callback => callback());
  };
  
  return (
    <TransformContext.Provider value={{
      state: transformState,
      subscribe,
      notifySubscribers // Exposed for Canvas
    }}>
      {children}
    </TransformContext.Provider>
  );
};
```

### 2.2 Canvas Transform Application

The canvas applies transforms with maximum performance optimization:

```typescript
// src/components/Canvas.tsx
const applyTransform = useCallback(() => {
  if (cameraRef.current) {
    const { zoom, panX, panY } = transformState.current;
    
    // Direct CSS transform - fastest approach
    const transformString = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    cameraRef.current.style.transform = transformString;
    
    // Data attribute for debugging
    cameraRef.current.setAttribute('data-camera-transform', 
      `${panX},${panY},${zoom}`);
    
    // Notify subscribers for overlay updates
    notifySubscribers();
  }
}, [notifySubscribers, transformState]);

// Mouse wheel handling with cursor-centered zoom
const handleWheel = useCallback((e: WheelEvent) => {
  e.preventDefault();
  
  const isZoomModifier = e.metaKey || e.ctrlKey;
  
  if (isZoomModifier) {
    // Cursor-centered zoom algorithm
    const rect = groundRef.current!.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const scaleFactor = 1.1;
    const zoomDirection = e.deltaY > 0 ? -1 : 1;
    const factor = Math.pow(scaleFactor, zoomDirection);
    const newZoom = Math.max(0.1, Math.min(5, transformState.current.zoom * factor));
    
    // Convert mouse position to world coordinates
    const worldX = (mouseX - transformState.current.panX) / transformState.current.zoom;
    const worldY = (mouseY - transformState.current.panY) / transformState.current.zoom;
    
    // Apply zoom transformation
    const newPanX = mouseX - worldX * newZoom;
    const newPanY = mouseY - worldY * newZoom;
    
    transformState.current.zoom = newZoom;
    transformState.current.panX = newPanX;
    transformState.current.panY = newPanY;
  } else {
    // Pan mode
    transformState.current.panX -= e.deltaX;
    transformState.current.panY -= e.deltaY;
  }
  
  applyTransform();
}, [applyTransform, transformState]);
```

### 2.3 GroundWrapper Implementation

Each canvas element gets its own positioning wrapper:

```typescript
// src/components/GroundWrapper.tsx
const GroundWrapper = observer(forwardRef<HTMLDivElement, GroundWrapperProps>(
  function GroundWrapper({ id, x, y, scale = 1, rotation = 0, zIndex = 0, 
                          width, height, className = '', children, onClick, 
                          visible = true }, ref) {
    
    const transform = `translate(${x}px, ${y}px) scale(${scale}) rotate(${rotation}deg)`;
    
    const style: React.CSSProperties = {
      position: 'absolute',
      top: 0, left: 0,
      transform,
      transformOrigin: 'left top', // Critical for predictable transforms
      willChange: 'transform',     // GPU layer hint
      isolation: 'isolate',        // Stacking context
      contain: 'layout style',     // Performance optimization
      zIndex,
      display: visible ? 'block' : 'none',
      width: width ? `${width}px` : 'auto',
      height: height ? `${height}px` : 'auto',
    };

    return (
      <div
        ref={ref}
        id={`ground-wrapper-${id}`}
        className={`ground-wrapper ${className}`}
        style={style}
        onClick={onClick}
        data-ground-wrapper-id={id}
      >
        <div
          id={`ground-inner-${id}`}
          className="ground-inner"
          style={{
            transformOrigin: 'left top',
            width: '100%', height: '100%',
            overflow: 'visible'
          }}
        >
          {children}
        </div>
      </div>
    );
  }
));
```

## 3. Selection Overlay System

### 3.1 HudSurface Architecture

The selection overlay system handles dual coordinate systems with high performance:

```typescript
// src/components/HudSurface.tsx
const HudSurface = observer(() => {
  const { editorUI } = useStore();
  const { state: transformState, subscribe } = useTransformContext();
  
  const [canvasContainerRect, setCanvasContainerRect] = useState<DOMRect | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Direct DOM overlay update function
  const updateOverlayPosition = useCallback(() => {
    if (!overlayRef.current || !canvasContainerRect) return;
    
    const overlay = overlayRef.current;
    const { panX, panY, zoom } = transformState.current;

    if (editorUI.selectedTool !== EditorTool.SELECT) {
      overlay.style.display = 'none';
      return;
    }

    // Case 1: Real DOM elements (components in breakpoints)
    if (editorUI.selectedComponent && editorUI.selectedBreakpoint) {
      const breakpointComponentId = `${editorUI.selectedBreakpoint.id}-${editorUI.selectedComponent.id}`;
      const element = document.querySelector(`[data-component-id="${breakpointComponentId}"]`) as HTMLElement;

      if (element) {
        const rect = element.getBoundingClientRect();
        const x = rect.left - 2;
        const y = rect.top - 2;

        overlay.style.display = 'block';
        overlay.style.transform = `translate(${x}px, ${y}px)`;
        overlay.style.width = `${rect.width + 4}px`;
        overlay.style.height = `${rect.height + 4}px`;
        return;
      }
    }

    // Case 2: Virtual canvas elements (floating components)
    if (editorUI.selectedRootCanvasComponent?.isRootCanvasComponent) {
      const bounds = editorUI.selectedRootCanvasComponent.canvasBounds;
      if (bounds) {
        // Transform canvas coordinates to screen coordinates
        const screenX = (bounds.x * zoom) + panX + canvasContainerRect.left;
        const screenY = (bounds.y * zoom) + panY + canvasContainerRect.top;
        
        const x = screenX - 2;
        const y = screenY - 2;
        const scaledWidth = bounds.width * zoom;
        const scaledHeight = bounds.height * zoom;

        overlay.style.display = 'block';
        overlay.style.transform = `translate(${x}px, ${y}px)`;
        overlay.style.width = `${scaledWidth + 4}px`;
        overlay.style.height = `${scaledHeight + 4}px`;
        return;
      }
    }

    overlay.style.display = 'none';
  }, [editorUI, canvasContainerRect, transformState]);

  // Subscribe to transform updates (no React re-renders)
  useEffect(() => {
    const unsubscribe = subscribe(() => {
      updateOverlayPosition(); // Direct DOM update
    });
    return unsubscribe;
  }, [subscribe, updateOverlayPosition]);

  // React-based updates (only when selection changes)
  useEffect(() => {
    updateOverlayPosition();
  }, [updateOverlayPosition]);

  return (
    <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 10 }}>
      <div ref={overlayRef} className="absolute pointer-events-none" style={{ display: 'none' }}>
        {/* Selection handles */}
        <div className="absolute -top-1 -left-1 w-2 h-2 bg-blue-500 rounded-full" />
        <div className="absolute -top-1 left-1/2 transform -translate-x-1/2 w-2 h-2 bg-blue-500 rounded-full" />
        {/* ... additional handles ... */}
      </div>
    </div>
  );
});
```

### 3.2 Coordinate Transformation Logic

The system handles two distinct coordinate systems:

#### Real DOM Elements
```typescript
// Elements within breakpoint viewports
const rect = element.getBoundingClientRect();
const x = rect.left - 2; // Direct screen coordinates
const y = rect.top - 2;
```

#### Virtual Canvas Elements  
```typescript
// Floating elements positioned on canvas
const screenX = (bounds.x * zoom) + panX + canvasContainerRect.left;
const screenY = (bounds.y * zoom) + panY + canvasContainerRect.top;

// Formula: screenPos = (canvasPos * zoom) + pan + containerOffset
```

## 4. Component Rendering System

### 4.1 Recursive Component Renderer

The system renders MST components to React elements recursively:

```typescript
// src/components/ComponentRenderer.tsx
const ComponentRenderer = observer(({ component, breakpointId, allBreakpoints, primaryId }) => {
  const { editorUI } = useStore();
  
  // Resolve responsive properties for current breakpoint
  const { attributes, style } = component.getResolvedProps(breakpointId, allBreakpoints, primaryId);

  const finalProps: Record<string, unknown> = {
    ...attributes,
    style: Object.keys(style).length ? style : undefined,
    'data-component-id': `${breakpointId}-${component.id}`,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      if (editorUI.selectedTool === EditorTool.SELECT) {
        editorUI.selectComponent(component, breakpointId);
      }
    }
  };

  const children = component.children.map(child =>
    <ComponentRenderer
      key={child.id}
      component={child}
      breakpointId={breakpointId}
      allBreakpoints={allBreakpoints}
      primaryId={primaryId}
    />
  );

  // Host elements (div, button, etc.)
  if (component.isHostElement) {
    return React.createElement(component.type, finalProps, 
      children.length ? children : attributes.children);
  }

  // Function components (custom components)
  const Impl = (window as any).__componentRegistry?.[component.type];
  if (Impl) {
    return <Impl {...finalProps}>{children}</Impl>;
  }

  // Fallback for unknown components
  return (
    <div style={{ border: '1px dashed orange', padding: 8 }}>
      Unknown component: {component.type}
      {children}
    </div>
  );
});
```

### 4.2 Root Canvas Component Rendering

Floating elements use the GroundWrapper system:

```typescript
// src/components/RootCanvasComponentRenderer.tsx
const RootCanvasComponentRenderer = observer(({ component, allBreakpoints, primaryBreakpointId }) => {
  const { editorUI } = useStore();
  
  if (!component.isRootCanvasComponent) return null;
  
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (editorUI.selectedTool === EditorTool.SELECT) {
      editorUI.setSelectedRootCanvasComponent(component);
    }
  };
  
  const bounds = component.canvasBounds;
  const width = bounds?.width || 200;
  const height = bounds?.height || 100;

  return (
    <GroundWrapper
      id={component.id}
      x={component.canvasX!}
      y={component.canvasY!}
      scale={component.canvasScale}
      rotation={component.canvasRotation}
      zIndex={component.canvasZIndex}
      width={width}
      height={height}
      visible={component.canvasVisible}
      onClick={handleClick}
      className={`root-canvas-component root-canvas-component-${component.type}`}
    >
      <ComponentRenderer
        component={component}
        breakpointId={primaryBreakpointId}
        allBreakpoints={allBreakpoints}
        primaryId={primaryBreakpointId}
      />
    </GroundWrapper>
  );
});
```

## 5. Editor State Management

### 5.1 EditorUIStore Architecture

The UI store manages transient editor state:

```typescript
// src/stores/EditorUIStore.ts
const EditorUIStore = types.model('EditorUI', {
  // Current selections
  currentProject: types.maybe(types.safeReference(ProjectModel)),
  currentPage: types.maybe(types.safeReference(PageModel)),
  selectedComponent: types.maybe(types.safeReference(ComponentModel)),
  selectedBreakpoint: types.maybe(types.safeReference(BreakpointModel)),
  selectedRootCanvasComponentId: types.maybe(types.string),

  // Active tool
  selectedTool: types.optional(types.enumeration(Object.values(EditorTool)), EditorTool.SELECT),
  
  // UI panel states
  leftSidebarCollapsed: types.optional(types.boolean, false),
  rightSidebarCollapsed: types.optional(types.boolean, false),
})
.actions(self => ({
  // Component selection with breakpoint context
  selectComponent(component?: ComponentInstance, breakpointId?: string) {
    self.selectedComponent = component;
    if (breakpointId) {
      self.selectedBreakpoint = self.currentProject?.breakpoints.get(breakpointId);
    }
  },
  
  // Root canvas component selection
  setSelectedRootCanvasComponent(component?: ComponentInstance) {
    self.selectedRootCanvasComponentId = component?.id;
    // Clear other selections
    self.selectedComponent = undefined;
    self.selectedBreakpoint = undefined;
  },
  
  // Breakpoint selection
  setSelectedBreakpoint(breakpoint?: BreakpointType) {
    self.selectedBreakpoint = breakpoint;
    // Clear component selections
    self.selectedComponent = undefined;
    self.selectedRootCanvasComponentId = undefined;
  }
}));
```

### 5.2 Store Composition

The root store composes domain and UI stores:

```typescript
// src/stores/RootStore.ts
export const RootStore = types.model('RootStore', {
  // Domain stores (persistent business logic)
  projectStore: ProjectStore,
  
  // UI stores (transient editor state)
  editorUI: EditorUIStore,
});

export function createRootStore(): RootStoreType {
  return RootStore.create({
    projectStore: ProjectStore.create({ projects: {} }),
    editorUI: EditorUIStore.create({}),
  });
}
```

## 6. Performance Optimizations

### 6.1 Canvas Transform Optimizations

1. **Direct DOM Manipulation**: Bypasses React reconciliation
2. **String Interpolation**: Faster than template literals or DOMMatrix
3. **GPU Layer Hints**: `will-change: transform` for immediate GPU layers
4. **Transform Origin**: `top left` for predictable coordinate math

### 6.2 MobX Reactivity Optimizations

1. **Fine-Grained Observers**: Only affected components re-render
2. **Computed Properties**: Cached until dependencies change
3. **Action Boundaries**: Batch multiple mutations for efficiency
4. **Snapshot Serialization**: Built-in for persistence and history

### 6.3 Overlay System Optimizations

1. **Subscription Pattern**: Direct DOM updates without React
2. **Cached Container Rect**: Avoid repeated DOM queries
3. **Conditional Rendering**: Early returns for non-select tools
4. **Fixed Positioning**: Overlays positioned relative to viewport

## 7. Key Implementation Patterns

### 7.1 Meta-Programming Pattern
- Component configurations as serializable data structures
- Runtime transformation to React elements via `createElement`
- Dynamic property resolution based on breakpoint context

### 7.2 Dual-Reactivity Pattern
- Editor reactivity via MobX for real-time UI updates
- Runtime interactivity preserved through React component model
- Clean separation between editing and runtime concerns

### 7.3 Ref + Subscription Pattern
- High-frequency state in refs to avoid React re-renders
- Subscription system for components needing updates
- Direct DOM manipulation for maximum performance

### 7.4 Unified Component Pattern
- Single model for both hierarchical and floating elements
- Canvas positioning properties for absolute-positioned elements
- Consistent serialization and rendering approach

This implementation successfully demonstrates how modern React applications can achieve native-level performance while maintaining clean, maintainable architecture suitable for complex visual editing workflows.
