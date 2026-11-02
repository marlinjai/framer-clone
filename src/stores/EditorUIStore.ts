// src/stores/EditorUIStore.ts
// UI state store - manages current selections, tools, and transient editor state
import { types, Instance, addDisposer, getParentOfType, hasParentOfType } from 'mobx-state-tree';
import { comparer, reaction } from 'mobx';
import ProjectModel, { ProjectModelType } from '../models/ProjectModel';
import PageModel, { PageModelType } from '../models/PageModel';
import ComponentModel, { ComponentInstance } from '../models/ComponentModel';
import { LEFT_SIDEBAR_DEFAULT_WIDTH, clampLeftSidebarWidth } from '@/lib/layers/sidebarWidth';
import { isTextNodeType } from '@/lib/renderer/textNode';
import type { InputDefinition } from '@/lib/components/inputs';
import { isDefinitionRule, storedRulesOf } from '@/lib/rules/rules';
import { findRuleIndex, namedState, ruleLabel } from '@/lib/rules/states';
// Removed BreakpointModel - breakpoints are now viewport nodes

// Available tools in our design editor (expanded from basic ToolStore)
export enum EditorTool {
  GRAB = 'grab',
  SELECT = 'select',
}

/**
 * What selecting `component` selects. A text node has no element, so every
 * consumer of the selection (overlays, handles, the phone toolbar, style
 * sections) would have nothing to act on: its element stands in, and that
 * element's Text section edits it. Marks the one place this is decided.
 */
function selectionTarget(component: ComponentInstance): ComponentInstance {
  if (!isTextNodeType(component.type) || !hasParentOfType(component, ComponentModel)) return component;
  return getParentOfType(component, ComponentModel) as ComponentInstance;
}

// True while the panel itself writes into the active state.
let panelWritesRule = false;

/**
 * Runs a write of the state switch's panel. The reset of a state's last value takes
 * its rule with it and stays on that state, which is how to tell it from the rule
 * going any other way (undo, a collaborator): those return to Normal.
 */
export function whilePanelWritesRule<T>(write: () => T): T {
  panelWritesRule = true;
  try {
    return write();
  } finally {
    panelWritesRule = false;
  }
}

/** 'refused': an action the editor would not carry out, and why. */
export interface EditorNoticeState {
  kind: 'changedElsewhere' | 'missingPage' | 'refused';
  message: string;
}

/** The canvas position, read and written through Canvas, which owns it. */
export interface CameraPosition {
  zoom: number;
  panX: number;
  panY: number;
}

export interface CanvasCamera {
  read(): CameraPosition;
  write(position: CameraPosition): void;
}

/**
 * A component dialog that is open (src/components/ComponentDialogs.tsx): naming a new
 * component, renaming one, or confirming a delete or a detach. Ids, so a node or a
 * definition that goes away while the dialog is open shows as gone rather than stale.
 */
export type ComponentRequest =
  | { kind: 'create'; pageId: string; nodeIds: readonly string[] }
  | { kind: 'rename'; definitionId: string }
  | { kind: 'delete'; definitionId: string }
  | { kind: 'detach'; pageId: string; placementId: string }
  // A change to an input's type or options that takes values or connections with it.
  | { kind: 'editInput'; definitionId: string; next: InputDefinition; defaultDropped: boolean };

/** Where to go back to from a definition. Ids, so a reloaded project still resolves it. */
export interface ComponentReturn {
  pageId: string;
  placementId?: string;
  breakpointId?: string;
  camera?: CameraPosition;
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
  editorNotice: undefined as EditorNoticeState | undefined,
  // The product a product page shows while designing (src/lib/commerce/productPreview.tsx),
  // by handle; undefined means the first in the catalogue. Never saved with the project.
  previewProductHandle: undefined as string | undefined,
  isResizing: false,
  // One rule shown on every copy of its node as though it applied (a state on
  // the canvas is otherwise dead). `ruleId` is a stored rule's id or a named state,
  // and the sheet expands it through src/lib/rules/states.ts, so Pressed shows Hover
  // too. Editor session only: not saved with the project, not in undo history.
  previewRule: null as { componentId: string; ruleId: string } | null,
  // The state the properties panel edits, beside the selection: a named state (which
  // needs no rule until its first value) or a stored rule's id. Null is Normal. The
  // switch sets previewRule with it, so the canvas shows what is being edited. Editor
  // session only, so a reload opens on Normal with every rule intact.
  activeRule: null as string | null,
  // Why the last write into that state was refused, for the line under the switch.
  ruleRefusal: null as string | null,
  // The preview shown over the editor (PreviewOverlay), from this store: no
  // navigation and no server round trip. The editor's own keyboard shortcuts
  // stand down while it is open. Editor session only.
  previewOpen: false,
  // The way back out of the definitions open on the canvas, outermost first. A nested
  // definition adds one. Volatile on purpose: a reload opens on a real page.
  componentTrail: [] as readonly ComponentReturn[],
  // The component dialog open over the editor, if any. Editor session only.
  componentRequest: null as ComponentRequest | null,
  // Registered by Canvas while it is mounted.
  canvasCamera: undefined as CanvasCamera | undefined,
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

  /** True while a definition is open on the canvas. */
  get inComponent(): boolean {
    return self.componentTrail.length > 0;
  },

  /** The page the address names: a definition has no address, so a reload opens a real page. */
  get addressPageId(): string | undefined {
    return self.componentTrail[0]?.pageId ?? self.currentPage?.id;
  },

  /** The name of the nearest page or definition to go back to. */
  get leaveTarget(): string {
    const pageId = self.componentTrail[self.componentTrail.length - 1]?.pageId;
    return (pageId && self.currentProject?.pageName(pageId)) || 'the page';
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

  setEditorNotice(notice: EditorNoticeState | undefined) {
    self.editorNotice = notice;
  },

  setComponentRequest(request: ComponentRequest | null) {
    self.componentRequest = request;
  },

  setPreviewProductHandle(handle: string | undefined) {
    self.previewProductHandle = handle;
  },

  /** Shows one rule on every copy of its node, or none. */
  setPreviewRule(preview: { componentId: string; ruleId: string } | null) {
    self.previewRule = preview;
  },

  setRuleRefusal(reason: string | null) {
    self.ruleRefusal = reason;
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
      self.previewProductHandle = undefined;
      self.editingComponent = undefined;
      self.selectedViewportNode = undefined;
      self.selectedComponents.clear();
      self.hoverComponent = undefined;
      self.componentTrail = [];
      self.componentRequest = null;
    }
    self.currentProject = project;
  },

  setCanvasCamera(camera: CanvasCamera | undefined) {
    self.canvasCamera = camera;
  },

  /** Opens a definition on the canvas. Everything that edits a page then edits it. */
  enterComponent(definitionId: string, placementId?: string) {
    const definition = self.currentProject?.components.get(definitionId);
    const from = self.currentPage;
    if (!definition || !from || definition.page === from) return;
    self.componentTrail = [...self.componentTrail, {
      pageId: from.id,
      placementId,
      breakpointId: self.selectedViewportNode?.breakpointId,
      camera: self.canvasCamera?.read(),
    }];
    self.currentPage = definition.page as PageModelType;
    this.selectComponent(definition.page.appComponentTree as ComponentInstance);
  },

  /** Back to the record at `depth`, the nearest by default, or the nearest further out that still exists. */
  leaveComponent(depth = self.componentTrail.length - 1): boolean {
    for (let index = depth; index >= 0; index--) {
      const back = self.componentTrail[index];
      const page = self.currentProject?.findPageById(back.pageId) as PageModelType | undefined;
      if (!page) continue;
      self.componentTrail = self.componentTrail.slice(0, index);
      self.currentPage = page;
      const placement = back.placementId ? page.findComponent(back.placementId) : undefined;
      this.selectComponent(placement ?? (page.appComponentTree as ComponentInstance), placement ? back.breakpointId : undefined);
      if (back.camera) self.canvasCamera?.write(back.camera);
      return true;
    }
    self.componentTrail = [];
    return false;
  },

  // The definition open on the canvas went away: this tab deleted it, an undo took
  // it, or another tab's save did. The canvas must not be left empty.
  returnFromLostComponent() {
    if (!this.leaveComponent()) return;
    const name = self.currentProject?.pageName(self.currentPage?.id ?? '') ?? 'the page';
    self.editorNotice = { kind: 'missingPage', message: `That component no longer exists, so you are back on ${name}.` };
  },

  // Page selection
  setCurrentPage(page?: PageModelType) {
    // Leaving a definition from the Pages panel: its own page comes back as it was.
    if (self.componentTrail.length > 0) {
      if (page?.id === self.componentTrail[0].pageId) {
        this.leaveComponent(0);
        return;
      }
      self.componentTrail = [];
    }
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
    
    const target = component && selectionTarget(component);
    self.selectedComponent = target;
    self.selectedComponents.replace(target ? [target] : []);
    
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
    const unique = pruneNested([...new Set(components.map(selectionTarget))]);
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
  toggleInSelection(picked: ComponentInstance, breakpointId?: string) {
    const component = selectionTarget(picked);
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

  afterCreate() {
    addDisposer(self, reaction(
      () => self.currentPage,
      page => {
        if (!page && self.componentTrail.length > 0) (self as unknown as { returnFromLostComponent(): void }).returnFromLostComponent();
      },
    ));
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

  /** The one node the state switch works on, if the selection is such a node. */
  get ruleTarget(): ComponentInstance | undefined {
    const list = this.selectedComponentList;
    return list.length === 1 && list[0].holdsRules ? list[0] : undefined;
  },

  /** The name of the state being edited, or undefined on Normal. */
  get activeRuleLabel(): string | undefined {
    const id = self.activeRule;
    if (!id) return undefined;
    const rules = this.ruleTarget ? storedRulesOf(this.ruleTarget.props) : [];
    const rule = rules[findRuleIndex(rules, id)];
    return rule ? ruleLabel(rule) : namedState(id)?.label;
  },

  /** True when the state being edited is a definition, which opens as text. */
  get activeRuleIsDefinition(): boolean {
    const id = self.activeRule;
    if (!id || !this.ruleTarget) return false;
    const rules = storedRulesOf(this.ruleTarget.props);
    const rule = rules[findRuleIndex(rules, id)];
    return !!rule && isDefinitionRule(rule);
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
}))
.actions(self => ({
  /** Picks the state the panel edits and shows it on the canvas. Null is Normal. */
  setActiveRule(ruleId: string | null) {
    const target = self.ruleTarget;
    const next = target ? ruleId : null;
    self.activeRule = next;
    self.previewRule = target && next ? { componentId: target.id, ruleId: next } : null;
    self.ruleRefusal = null;
  },
}))
.actions(self => ({
  // The state only lasts while there is something for it to point at, however that
  // ended: another selection, the node gone, a rule undone or deleted. Reading the
  // outcome rather than each way there covers the ways nobody listed. Another frame
  // of the same node keeps the state.
  afterCreate() {
    addDisposer(
      self,
      reaction(
        () => {
          const id = self.activeRule;
          if (!id) return null;
          const target = self.ruleTarget;
          return { id, target: target?.id, exists: !!target && findRuleIndex(storedRulesOf(target.props), id) !== -1 };
        },
        (now, before) => {
          if (!now) return;
          const lostTarget = now.target === undefined || now.target !== self.previewRule?.componentId;
          // A named state is fine with no rule, until its rule existed and went some way other than the panel.
          const lostRule = !now.exists && (!namedState(now.id) || (before?.id === now.id && before.exists && !panelWritesRule));
          if (lostTarget || lostRule) self.setActiveRule(null);
        },
        { equals: comparer.structural },
      ),
    );
  },
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
