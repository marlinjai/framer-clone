// src/stores/EditorUIStore.ts
// UI state store - manages current selections, tools, and transient editor state
import { types, Instance } from 'mobx-state-tree';
import ProjectModel, { ProjectModelType } from '../models/ProjectModel';
import PageModel, { PageModelType } from '../models/PageModel';
import ComponentModel, { ComponentInstance } from '../models/ComponentModel';
import { LEFT_SIDEBAR_DEFAULT_WIDTH, clampLeftSidebarWidth } from '@/lib/layers/sidebarWidth';
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
  
  // Every selected component, the primary (`selectedComponent`) first.
  // Single selection keeps exactly one entry; Shift+click and the canvas
  // marquee add more. Consumers that only understand one node (the properties
  // panel, resize handles) keep reading `selectedComponent`. safeReference
  // drops an entry by itself when its node is destroyed.
  selectedComponents: types.array(types.safeReference(ComponentModel)),

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
  // Left sidebar width in px while expanded (the collapsed rail is fixed).
  // LeftSidebar loads the remembered width on mount and saves on change
  // (src/lib/layers/sidebarWidth.ts); the store only holds the live value.
  leftSidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
  // Folded Layers rows, by component id (src/lib/layers/foldState.ts).
  // Replaced, never mutated, so observers see each change. Editor-session
  // only: not saved with the project, not in undo history.
  collapsedLayerIds: new Set<string>() as ReadonlySet<string>,
  // The id of the standalone demo editor's project (`/`), built in the browser
  // and held by no company: it has no project on the server to save or
  // publish to, until "Save as a new project" creates one.
  demoProjectId: undefined as string | undefined,
  // A demo project already saved as a real project ("Save as a new project"):
  // the demo editor drops it and starts fresh instead of offering it again.
  consumedDemoProjectId: undefined as string | undefined,
  // A message for the person above the canvas (see EditorNotice), dismissable.
  editorNotice: undefined as { kind: 'changedElsewhere' | 'missingPage'; message: string } | undefined,
  isResizing: false,
  // The preview shown over the editor (PreviewOverlay), from this store: no
  // navigation and no server round trip. The editor's own keyboard shortcuts
  // stand down while it is open. Editor session only.
  previewOpen: false,
  // Phone layout (docs/plans/2026-10-24-editor-on-phones.md, "Quick toolbar"):
  // the long-press context menu, open at a finger point (screen px), and the
  // style its Copy style took (appearance properties as resolved on the frame
  // it was copied in), for Paste style. Editor session only.
  phoneContextMenu: undefined as { x: number; y: number } | undefined,
  // The menu item under a finger sliding from the long-press (slide-to-select).
  phoneContextMenuHover: undefined as string | undefined,
  copiedStyle: undefined as Record<string, string | number> | undefined,
  // The tool to return to when the held Space key (temporary pan) is
  // released. Undefined while Space is not held.
  toolBeforeTemporaryGrab: undefined as EditorTool | undefined,
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
.views(self => ({
  /** True while the editor shows the browser-only demo project. */
  get isUnsavedDemo(): boolean {
    return self.demoProjectId !== undefined && self.currentProject?.id === self.demoProjectId;
  },
}))
.actions(self => ({
  markUnsavedDemo(projectId: string) {
    self.demoProjectId = projectId;
    self.consumedDemoProjectId = undefined;
  },

  /** The demo was saved as a real project: never offer it again. */
  consumeDemo() {
    self.consumedDemoProjectId = self.demoProjectId;
    self.demoProjectId = undefined;
  },

  setEditorNotice(notice: { kind: 'changedElsewhere' | 'missingPage'; message: string } | undefined) {
    self.editorNotice = notice;
  },

  /** Shows or hides the preview over the editor (PreviewOverlay). */
  setPreviewOpen(open: boolean) {
    self.previewOpen = open;
    // Nothing that floats over the canvas outlives the switch.
    if (open) {
      self.phoneContextMenu = undefined;
      self.phoneContextMenuHover = undefined;
    }
  },

  // Project selection
  setCurrentProject(project?: ProjectModelType) {
    // Switching to another project (for example the demo at `/`, then a
    // dashboard project in the same tab) must not carry over what was being
    // edited or pointed at in the previous one. The current page and the
    // selection are set by setCurrentPage right after.
    if (self.currentProject?.id !== project?.id) {
      self.editorNotice = undefined;
      self.editingComponent = undefined;
      self.selectedViewportNode = undefined;
      self.selectedComponents.clear();
      self.hoverComponent = undefined;
    }
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
    self.selectedComponents.replace(component ? [component] : []);
    
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
    self.selectedComponents.clear();
  },

  /**
   * Replace the selection with several components (the canvas marquee). The
   * first becomes the primary selection. `breakpointId` is the frame the
   * tree nodes were picked in; it becomes the viewport context, as for a
   * click. Ancestors and descendants of an earlier entry are dropped, so a
   * parent is never selected together with its own children.
   */
  setSelection(components: ComponentInstance[], breakpointId?: string) {
    const unique = pruneNested(components);
    if (unique.length === 0) {
      this.clearSelection();
      return;
    }
    // A tree node needs its frame as viewport context (the HUD looks the
    // primary up inside that frame), so a tree node leads when there is one.
    const primary = (breakpointId && unique.find(c => !c.isFloatingElement)) || unique[0];
    const ordered = [primary, ...unique.filter(c => c !== primary)];
    self.selectedComponent = primary;
    self.selectedComponents.replace(ordered);
    self.selectedViewportNode = !primary.isFloatingElement && breakpointId && self.currentPage
      ? self.currentPage.viewportNodes.find(v => v.breakpointId === breakpointId)
      : undefined;
  },

  /**
   * Shift+click: add a component to the selection, or take it out when it is
   * already selected. Adding a node drops any selected ancestor or
   * descendant of it. Removing the primary promotes the next selected node.
   */
  toggleInSelection(component: ComponentInstance, breakpointId?: string) {
    const current = self.selectedComponents.filter((c): c is ComponentInstance => !!c);
    if (current.length === 0) {
      this.selectComponent(component, breakpointId);
      return;
    }
    if (current.some(c => c.id === component.id)) {
      const rest = current.filter(c => c.id !== component.id);
      if (rest.length === 0) {
        this.clearSelection();
        return;
      }
      const keepBreakpoint = self.selectedViewportNode?.breakpointId ?? breakpointId;
      this.setSelection(rest, keepBreakpoint);
      return;
    }
    const kept = current.filter(c => !isAncestorOf(c, component) && !isAncestorOf(component, c));
    // The primary keeps its place (the properties panel keeps showing it),
    // unless it was just dropped as an ancestor or descendant of the new node.
    this.setSelection([...kept, component], self.selectedViewportNode?.breakpointId ?? breakpointId);
  },

  /** Nothing selected: no component, no extra selection, no frame. */
  clearSelection() {
    self.selectedComponent = undefined;
    self.selectedComponents.clear();
    self.selectedViewportNode = undefined;
  },

  // Space held: pan with the left button whatever the tool, as in Framer and
  // Figma. Releasing Space returns to the tool that was active before.
  beginTemporaryGrab() {
    if (self.toolBeforeTemporaryGrab !== undefined) return; // key repeat
    self.toolBeforeTemporaryGrab = self.selectedTool as EditorTool;
    self.selectedTool = EditorTool.GRAB;
  },

  endTemporaryGrab() {
    const previous = self.toolBeforeTemporaryGrab;
    if (previous === undefined) return;
    self.toolBeforeTemporaryGrab = undefined;
    self.selectedTool = previous;
  },
  
  
  // Tool selection
  setSelectedTool(tool: EditorTool) {
    self.selectedTool = tool;
    // Picking a tool while Space is held makes that tool stick on release.
    self.toolBeforeTemporaryGrab = undefined;
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
  
  setLeftSidebarWidth(width: number) {
    self.leftSidebarWidth = clampLeftSidebarWidth(width);
  },

  setCollapsedLayerIds(ids: ReadonlySet<string>) {
    if (ids === self.collapsedLayerIds) return;
    self.collapsedLayerIds = ids;
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

  openPhoneContextMenu(point: { x: number; y: number }) {
    self.phoneContextMenu = { x: point.x, y: point.y };
    self.phoneContextMenuHover = undefined;
  },

  closePhoneContextMenu() {
    self.phoneContextMenu = undefined;
    self.phoneContextMenuHover = undefined;
  },

  setPhoneContextMenuHover(item: string | undefined) {
    if (self.phoneContextMenuHover !== item) self.phoneContextMenuHover = item;
  },

  setCopiedStyle(style: Record<string, string | number> | undefined) {
    self.copiedStyle = style;
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

  /** Every selected component, the primary first. Never holds dead nodes. */
  get selectedComponentList(): ComponentInstance[] {
    const list = self.selectedComponents.filter((c): c is ComponentInstance => !!c);
    const primary = self.selectedComponent;
    if (primary && !list.some(c => c.id === primary.id)) return [primary, ...list];
    return list;
  },

  /** True when the component is part of the selection (primary or extra). */
  isSelected(componentId: string): boolean {
    if (self.selectedComponent?.id === componentId) return true;
    return self.selectedComponents.some(c => c?.id === componentId);
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
      selectedComponentIds: self.selectedComponents.filter(c => !!c).map(c => c!.id),
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

/** True when `ancestor` is a strict ancestor of `node` in the component tree. */
function isAncestorOf(ancestor: ComponentInstance, node: ComponentInstance): boolean {
  if (ancestor.id === node.id) return false;
  const stack = [...ancestor.children] as ComponentInstance[];
  while (stack.length) {
    const next = stack.pop()!;
    if (next.id === node.id) return true;
    stack.push(...(next.children as ComponentInstance[]));
  }
  return false;
}

/** Drop duplicates and any node whose ancestor is also in the list. */
function pruneNested(components: ComponentInstance[]): ComponentInstance[] {
  const unique: ComponentInstance[] = [];
  for (const c of components) {
    if (c && !unique.some(u => u.id === c.id)) unique.push(c);
  }
  return unique.filter(c => !unique.some(other => isAncestorOf(other, c)));
}

// TypeScript types
export type EditorUIType = Instance<typeof EditorUIStore>;

export default EditorUIStore;
