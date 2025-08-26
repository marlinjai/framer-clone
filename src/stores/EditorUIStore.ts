// src/stores/EditorUIStore.ts
// UI state store - manages current selections, tools, and transient editor state
import { types, Instance } from 'mobx-state-tree';
import ProjectModel, { ProjectModelType } from '../models/ProjectModel';
import PageModel, { PageModelType } from '../models/PageModel';
import ComponentModel, { ComponentInstance } from '../models/ComponentModel';
import { BreakpointModel, BreakpointType } from '@/models/BreakpointModel';

// Available tools in our design editor (expanded from basic ToolStore)
export enum EditorTool {
  GRAB = 'grab',
  SELECT = 'select',
  FRAME = 'frame',
  TEXT = 'text',
  MOVE = 'move',
  RESIZE = 'resize'
}

// EditorUI store - manages all UI state and current selections
const EditorUIStore = types.model('EditorUI', {
  // Current project selection (domain reference)
  currentProject: types.maybe(types.safeReference(ProjectModel)),
  
  // Current page selection (domain reference)  
  currentPage: types.maybe(types.safeReference(PageModel)),
  
  // Currently selected component (domain reference)
  selectedComponent: types.maybe(types.safeReference(ComponentModel)),
  
  // Explicit selected breakpoint (decoupled from viewport width)
  selectedBreakpoint: types.maybe(types.safeReference(BreakpointModel)),
  
  // Currently selected root canvas component ID (for floating elements)
  selectedRootCanvasComponentId: types.maybe(types.string),

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
  // Transient interaction state (won't be persisted)
  hoverComponent: undefined as ComponentInstance | undefined,
  isDragging: false,
  dragData: undefined as { 
    component: ComponentInstance; 
    startPos: { x: number; y: number };
    currentPos: { x: number; y: number };
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
    if (page?.rootComponent) {
      this.selectComponent(page.rootComponent);
    } else {
      this.selectComponent(undefined);
    }
  },
  
  // Component selection with optional breakpoint context
  selectComponent(component?: ComponentInstance, breakpointId?: string) {
    self.selectedComponent = component;
    if (breakpointId) {
      self.selectedBreakpoint = self.currentProject?.breakpoints.get(breakpointId);
    }
  },
  
  // Breakpoint selection
  setSelectedBreakpoint(breakpoint?: BreakpointType) {
    self.selectedBreakpoint = breakpoint;
    // Clear component and root canvas component selection when selecting a breakpoint
    self.selectedComponent = undefined;
    self.selectedRootCanvasComponentId = undefined;
  },
  
  // Root canvas component selection (floating elements)
  setSelectedRootCanvasComponent(component?: ComponentInstance) {
    console.log('EditorUIStore: setSelectedRootCanvasComponent called with ID:', component?.id);
    self.selectedRootCanvasComponentId = component?.id;
    // Clear component and breakpoint selection when selecting a root canvas component
    self.selectedComponent = undefined;
    self.selectedBreakpoint = undefined;
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
  
  startDrag(component: ComponentInstance, startPos: { x: number; y: number }) {
    self.isDragging = true;
    self.dragData = {
      component,
      startPos,
      currentPos: startPos
    };
  },
  
  updateDrag(currentPos: { x: number; y: number }) {
    if (self.dragData) {
      self.dragData.currentPos = currentPos;
    }
  },
  
  endDrag() {
    self.isDragging = false;
    self.dragData = undefined;
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
  
  get selectedRootCanvasComponent() {
    if (!self.selectedRootCanvasComponentId || !self.currentPage) return undefined;
    return self.currentPage.getRootCanvasComponent(self.selectedRootCanvasComponentId);
  },
  
  // Current breakpoint based on viewport width
  get currentBreakpoint() {
    return self.selectedBreakpoint;
  },
  
  // Available breakpoints for the current page
  get availableBreakpoints() {
    if (!self.currentProject) return [];
    return self.currentProject.breakpoints;
  },
  

  // Tool state
  get currentCursor(): string {
    switch (self.selectedTool) {
      case EditorTool.GRAB:
        return self.isDragging ? 'grabbing' : 'grab';
      case EditorTool.SELECT:
        return 'default';
      case EditorTool.MOVE:
        return 'move';
      case EditorTool.RESIZE:
        return 'nw-resize';
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
      selectedBreakpoint: self.selectedBreakpoint,
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
