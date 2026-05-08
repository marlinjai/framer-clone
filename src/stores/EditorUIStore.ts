// src/stores/EditorUIStore.ts
// UI state store - manages current selections, tools, and transient editor state
import { types, Instance } from 'mobx-state-tree';
import ProjectModel, { ProjectModelType } from '../models/ProjectModel';
import PageModel, { PageModelType } from '../models/PageModel';
import ComponentModel, { ComponentInstance } from '../models/ComponentModel';
// Removed BreakpointModel - breakpoints are now viewport nodes

// Available tools in our design editor (expanded from basic ToolStore)
export enum EditorTool {
  GRAB = 'grab',
  SELECT = 'select',
}

// EditorUI store - manages all UI state and current selections
const EditorUIStore = types.model('EditorUI', {
  // Current project selection (domain reference)
  currentProject: types.maybe(types.safeReference(ProjectModel)),
  
  // Current page selection (domain reference)  
  currentPage: types.maybe(types.safeReference(PageModel)),
  
  // Currently selected component (domain reference)
  selectedComponent: types.maybe(types.safeReference(ComponentModel)),
  
  // Currently selected viewport node (Framer-style)
  selectedViewportNode: types.maybe(types.safeReference(ComponentModel)),

  // Component currently being inline-edited (double-click to enter, blur / Enter
  // to commit, ESC to cancel). `types.maybe` holds undefined when no edit is
  // active — uses safeReference so it clears if the node is destroyed.
  editingComponent: types.maybe(types.safeReference(ComponentModel)),

  // Active tool
  selectedTool: types.optional(types.enumeration(Object.values(EditorTool)), EditorTool.SELECT),
  
  // UI panel states
  showPropertiesPanel: types.optional(types.boolean, true),
  showLayersPanel: types.optional(types.boolean, true),
  showToolbar: types.optional(types.boolean, true),
  
  // Sidebar collapse states
  leftSidebarCollapsed: types.optional(types.boolean, false),
  rightSidebarCollapsed: types.optional(types.boolean, false),
})
.volatile(() => ({
  // Transient interaction state (won't be persisted).
  // Drag state lives in DragManager (src/lib/drag/DragManager.ts).
  hoverComponent: undefined as ComponentInstance | undefined,
  isResizing: false,
  resizeData: undefined as {
    component: ComponentInstance;
    direction: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
    startPos: { x: number; y: number };         // screen px at mousedown
    startDims: { width: number; height: number }; // canvas-space px at mousedown
    startCanvasPos: { x: number; y: number };   // canvasX/Y at mousedown (floating/viewport)
    kind: 'tree' | 'floating' | 'viewport';
    breakpointId?: string;                       // set for 'tree' so we write responsive
  } | undefined,
}))
.actions(self => ({
  // Project selection
  setCurrentProject(project?: ProjectModelType) {
    self.currentProject = project;
  },
  
  // Page selection  
  setCurrentPage(page?: PageModelType) {
    self.currentPage = page;
    // Auto-select root component when switching pages
    if (page?.appComponentTree) {
      this.selectComponent(page.appComponentTree);
    } else {
      this.selectComponent(undefined);
    }
  },
  
  // Component selection with viewport context (cross-viewport highlighting)
  selectComponent(component?: ComponentInstance, breakpointId?: string) {
    console.log("🏪 EditorUIStore.selectComponent called:", {
      componentId: component?.id,
      componentLabel: component?.label,
      componentType: component?.canvasNodeType,
      breakpointId,
      hasViewportContext: !!breakpointId
    });
    
    self.selectedComponent = component;
    
    if (breakpointId && self.currentPage) {
      // Component within a viewport - find the viewport node
      const viewportNode = self.currentPage.viewportNodes.find(v => v.breakpointId === breakpointId);
      console.log("📍 Setting viewport context:", viewportNode?.label);
      self.selectedViewportNode = viewportNode;
    } else {
      // Floating element or no viewport context - clear viewport selection
      console.log("🌊 Clearing viewport context - this is a floating element");
      self.selectedViewportNode = undefined;
    }
  },
  
  // Viewport node selection (Framer-style)
  setSelectedViewportNode(viewportNode?: ComponentInstance) {
    self.selectedViewportNode = viewportNode;
    // Clear component selection when selecting a viewport
    self.selectedComponent = undefined;
  },
  
  
  // Tool selection
  setSelectedTool(tool: EditorTool) {
    self.selectedTool = tool;
  },
  
  // Panel visibility
  togglePropertiesPanel() {
    self.showPropertiesPanel = !self.showPropertiesPanel;
  },
  
  toggleLayersPanel() {
    self.showLayersPanel = !self.showLayersPanel;
  },
  
  toggleToolbar() {
    self.showToolbar = !self.showToolbar;
  },
  
  // Sidebar collapse controls
  toggleLeftSidebar() {
    self.leftSidebarCollapsed = !self.leftSidebarCollapsed;
  },
  
  toggleRightSidebar() {
    self.rightSidebarCollapsed = !self.rightSidebarCollapsed;
  },
  
  // Transient interaction state
  setHoverComponent(component?: ComponentInstance) {
    self.hoverComponent = component;
  },

  // Resize interaction. HudSurface handles
  // mouse events, this store just holds the pending resize context so other
  // consumers (e.g. the HUD itself) can observe `isResizing`.
  startResize(data: NonNullable<typeof self.resizeData>) {
    self.isResizing = true;
    self.resizeData = data;
  },

  endResize() {
    self.isResizing = false;
    self.resizeData = undefined;
  },

  beginTextEdit(component: ComponentInstance) {
    self.editingComponent = component;
  },

  endTextEdit() {
    self.editingComponent = undefined;
  },
}))
.views(self => ({
  // Selection state
  get hasProjectSelected(): boolean {
    return !!self.currentProject;
  },
  
  get hasPageSelected(): boolean {
    return !!self.currentPage;
  },
  
  get hasComponentSelected(): boolean {
    return !!self.selectedComponent;
  },

  // Current viewport node (Framer-style)
  get currentViewportNode() {
    return self.selectedViewportNode;
  },
  
  // Available viewport nodes for the current page
  get availableViewportNodes() {
    if (!self.currentPage) return [];
    return self.currentPage.viewportNodes;
  },
  

  // Tool state
  get currentCursor(): string {
    switch (self.selectedTool) {
      case EditorTool.GRAB:
        return 'grab';
      case EditorTool.SELECT:
        return 'default';
      default:
        return 'default';
    }
  },
  
  isToolSelected(tool: EditorTool): boolean {
    return self.selectedTool === tool;
  },
  
  // Export current UI state (for debugging/persistence)
  get uiState() {
    return {
      currentProjectId: self.currentProject?.id,
      currentPageId: self.currentPage?.id,
      selectedComponentId: self.selectedComponent?.id,
      selectedViewportNode: self.selectedViewportNode,
      selectedTool: self.selectedTool,
      panels: {
        properties: self.showPropertiesPanel,
        layers: self.showLayersPanel,
        toolbar: self.showToolbar
      }
    };
  }
}));

// TypeScript types
export type EditorUIType = Instance<typeof EditorUIStore>;

export default EditorUIStore;
