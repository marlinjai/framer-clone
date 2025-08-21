// src/stores/EditorUIStore.ts
// UI state store - manages current selections, tools, and transient editor state
import { types, Instance } from 'mobx-state-tree';
import ProjectModel, { ProjectModelType } from '../models/ProjectModel';
import PageModel, { PageModelType } from '../models/PageModel';
import ComponentModel, { ComponentInstance } from '../models/ComponentModel';

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
  
  // Active tool
  selectedTool: types.optional(types.enumeration(Object.values(EditorTool)), EditorTool.GRAB),
  
  // Canvas settings
  zoom: types.optional(types.number, 1),
  canvasOffset: types.optional(types.frozen<{ x: number; y: number }>(), { x: 0, y: 0 }),
  
  // Current viewport width for responsive preview
  viewportWidth: types.optional(types.number, 1024),
  
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
    // Auto-select first page when switching projects
    if (project?.hasPages) {
      this.setCurrentPage(project.firstPage);
    } else {
      this.setCurrentPage(undefined);
    }
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
  
  // Component selection
  selectComponent(component?: ComponentInstance) {
    self.selectedComponent = component;
  },
  
  // Tool selection
  setSelectedTool(tool: EditorTool) {
    self.selectedTool = tool;
  },
  
  // Canvas controls
  setZoom(zoom: number) {
    self.zoom = Math.max(0.1, Math.min(5, zoom)); // Clamp between 0.1x and 5x
  },
  
  zoomIn() {
    this.setZoom(self.zoom * 1.2);
  },
  
  zoomOut() {
    this.setZoom(self.zoom / 1.2);
  },
  
  resetZoom() {
    this.setZoom(1);
  },
  
  setCanvasOffset(offset: { x: number; y: number }) {
    self.canvasOffset = offset;
  },
  
  // Responsive preview
  setViewportWidth(width: number) {
    self.viewportWidth = Math.max(320, width); // Minimum mobile width
    
    // Auto-collapse sidebars on smaller screens
    if (width < 1024) {
      self.leftSidebarCollapsed = true;
      self.rightSidebarCollapsed = true;
    } else if (width < 1280) {
      // On medium screens, collapse right sidebar by default
      self.rightSidebarCollapsed = true;
    }
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
  
  setLeftSidebarCollapsed(collapsed: boolean) {
    self.leftSidebarCollapsed = collapsed;
  },
  
  setRightSidebarCollapsed(collapsed: boolean) {
    self.rightSidebarCollapsed = collapsed;
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
  
  // Current breakpoint based on viewport width
  get currentBreakpoint() {
    return self.currentPage?.getActiveBreakpoint(self.viewportWidth);
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
  
  // Component hierarchy helpers
  get selectedComponentPath(): string {
    if (!self.selectedComponent) return '';
    
    const path: string[] = [];
    let current: ComponentInstance | undefined = self.selectedComponent;
    
    // Build path from selected component to root
    while (current) {
      path.unshift(current.type);
      // Find parent (simplified - in real implementation you'd traverse the tree)
      current = undefined; // TODO: implement parent traversal
    }
    
    return path.join(' > ');
  },
  
  // Canvas calculations
  get effectiveZoom(): number {
    return Math.max(0.1, Math.min(5, self.zoom));
  },
  
  // Panel layout
  get layoutClasses(): string {
    const classes: string[] = ['editor-layout'];
    
    if (!self.showPropertiesPanel) classes.push('no-properties');
    if (!self.showLayersPanel) classes.push('no-layers');
    if (!self.showToolbar) classes.push('no-toolbar');
    
    return classes.join(' ');
  },
  
  // Export current UI state (for debugging/persistence)
  get uiState() {
    return {
      currentProjectId: self.currentProject?.id,
      currentPageId: self.currentPage?.id,
      selectedComponentId: self.selectedComponent?.id,
      selectedTool: self.selectedTool,
      zoom: self.zoom,
      canvasOffset: self.canvasOffset,
      viewportWidth: self.viewportWidth,
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
