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
import { revealFor, surfaceBehaviour, type PreviewValues } from '@/lib/behaviour/surfaceBehaviour';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { surfaceColorMode, surfaceColorScheme, surfaceDarkClass, type ColorScheme } from '@/lib/site/theme';
import { LiveRevealStore } from '@/lib/live/revealStore';
import { LivePlansStore } from '@/lib/live/plansStore';
import { LivePresenceStore } from '@/lib/live/presenceStore';
import { PageGenDraftStore } from '@/lib/ai/pageGen/draft';
import { FxClaim } from '@/lib/fxScene/claim';
import { FX_PROP, parseFxProp } from '@/lib/fxScene/fxScene';
// Removed BreakpointModel - breakpoints are now viewport nodes

// Available tools in our design editor (expanded from basic ToolStore)
export enum EditorTool {
  GRAB = 'grab',
  SELECT = 'select',
  // The page runs in each frame, with real pointer and focus, and nothing is selected or
  // moved on the canvas (docs/plans/2026-11-02-behaviour-model.md, "Interact").
  INTERACT = 'interact',
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
  kind: 'changedElsewhere' | 'missingPage' | 'refused' | 'previewState' | 'newPage' | 'pageDeleted';
  message: string;
  /**
   * `newPage`: the page an agent generated, which Open it shows (src/lib/projects/liveSync.ts).
   * `pageDeleted`: the page an agent deleted while it was open, which Undo brings back.
   */
  pageId?: string;
  /** `pageDeleted`: the history entry of that agent's step; Undo is offered while it is the last one applied. */
  historyEntryId?: string;
  /** `pageDeleted`: the message of a state preview that was showing, kept with its Show first values action. */
  preview?: string;
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
/** The FX scene box drawn live on the canvas, and the frame it is drawn in (see `fxLive`). */
export interface FxLive {
  componentId: string;
  frameId: string | null;
}

/**
 * The layer of an FX scene box picked in the Layers panel (`kind: 'layer'`), or the scene's
 * Background pseudo-row (`kind: 'background'`, which has no layer id). Session state: not
 * saved, not in the undo history. The box stays the primary selection; this only says what
 * the properties panel shows and what Delete, Cmd+D and Escape act on. Keyed by node id and
 * layer id, never by element, because one node is drawn in every breakpoint.
 */
export type FxLayerPick = { componentId: string; kind: 'layer'; layerId: string } | { componentId: string; kind: 'background' };

/** What the last change to a scene's layers (from a row, a menu or a key) has to say, for the Layers panel's live region. */
export interface FxLayerNotice {
  componentId: string;
  /** The stored scene the message was said about (JSON): after an undo or another change it is another scene and the message is gone. */
  about: string;
  text: string;
  problem: boolean;
}

/**
 * What the live FX scene is doing: nothing asked (`idle`), being fetched and set up
 * (`loading`), drawn (`live`), or not drawn, with the reason (`off`: the engine's own
 * failure names, `refused` for a scene the reader refuses, `engine` when the engine's
 * code did not arrive, `no-webgl` when this browser cannot draw it).
 */
export type FxLiveStatus = { state: 'idle' | 'loading' | 'live' } | { state: 'off'; reason: string };

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
  // The state each shop control shows on the canvas (src/lib/commerce/parts.ts), by
  // the control's node id; absent means its first state. Never saved with the project.
  shopPreviewStates: {} as Readonly<Record<string, string>>,
  isResizing: false,
  // A marquee rectangle is being drawn on the canvas (Canvas.tsx): the live
  // canvas's camera followers wait for it (src/lib/live/editingInProgress.ts).
  // Asks the canvas to bring the open page's frames into view (PageFitOnRequest in
  // Canvas.tsx): counted up by "Open it" on an agent's new page, which the person
  // may open while the camera looks at an empty part of the canvas.
  pageFitRequest: 0,
  marqueeActive: false,
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
  // Page state as the canvas shows it in Select, by state id: a value stands in for the
  // state's first value, so "Menu open" stays visible while it is styled
  // (src/lib/behaviour/surfaceBehaviour.ts). Replaced whole. Editor session only: never
  // saved, never in undo, and gone with the page, so a reload opens on the first values.
  previewState: {} as PreviewValues,
  // Changes each time the Interact tool starts or ends. The canvas keys its frames' content
  // on it, so whatever the page changed natively (a `details` opened, a dialog shown) is
  // drawn afresh, and every run starts from first values. Editor session only.
  interactEpoch: 0,
  // The preview shown over the editor (PreviewOverlay), from this store: no
  // navigation and no server round trip. The editor's own keyboard shortcuts
  // stand down while it is open. Editor session only.
  previewOpen: false,
  // Which of a `system` site's two modes the canvas and the preview show
  // (docs/plans/2026-11-02-theme-and-head.md, "The mode on the canvas"). A forced
  // site shows its own mode and a site with no choice shows light, whatever this
  // holds. Editor session only: never saved, never in undo history, so switching
  // changes no project byte and a reload opens on light.
  previewColorMode: 'light' as ColorScheme,
  // The way back out of the definitions open on the canvas, outermost first. A nested
  // definition adds one. Volatile on purpose: a reload opens on a real page.
  componentTrail: [] as readonly ComponentReturn[],
  // The component dialog open over the editor, if any. Editor session only.
  componentRequest: null as ComponentRequest | null,
  // The FX scene drawn live on the canvas (src/components/fx/FxLayer.tsx), if any: the
  // box, and the breakpoint frame it is drawn in (`null`: wherever the box is drawn
  // first, for a box that was not picked in a frame). The canvas shows several
  // breakpoints side by side and a browser allows only a handful of WebGL contexts,
  // so one scene is live in one frame at a time. Editor session only.
  fxLive: undefined as FxLive | undefined,
  // What that scene is doing, for the FX section of the panel.
  fxLiveStatus: { state: 'idle' } as FxLiveStatus,
  // The layer (or the Background row) of an FX scene box picked in the Layers panel.
  // Read through `fxLayerPick`, which drops a pick whose layer is gone.
  selectedFxLayer: undefined as FxLayerPick | undefined,
  // The layer row being renamed in place (F2, double-click, the row menu).
  fxLayerRenaming: undefined as { componentId: string; layerId: string } | undefined,
  // The message of the last layer change from a row or a key.
  fxLayerNotice: undefined as FxLayerNotice | undefined,
  // Which rendered element draws it: one node can be drawn many times in one frame.
  fxLiveClaim: new FxClaim(),
  // Registered by Canvas while it is mounted.
  canvasCamera: undefined as CanvasCamera | undefined,
  // The page generator's draft (src/lib/ai/pageGen/draft.ts): the sections of a
  // running generation, drawn on the canvas and never part of the project, so
  // never saved, published or in undo history. Its own observable store.
  pageGenDraft: new PageGenDraftStore(),
  // The agents working on the open site (src/lib/live/presenceStore.ts), fed by
  // the live stream: the presence frame, the activity feed and the top bar's
  // note. Never part of the project. Its own observable store.
  livePresence: new LivePresenceStore(),
  // The nodes revealing on the canvas now (src/lib/live/revealStore.ts): node id
  // to delay, after an adopted agent write or a generated result. Never part of
  // the project: never saved, never in undo history. Its own observable store.
  liveReveal: new LiveRevealStore(),
  // The skeleton plans agents announced on the open site (src/lib/live/plansStore.ts):
  // drawn by the skeleton layer until each section is created. Never part of the
  // project: never saved, never in undo history. Its own observable store.
  livePlans: new LivePlansStore(),
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

  /** The scheme the canvas and the preview show for the open site. */
  get frameColorScheme(): ColorScheme {
    return surfaceColorScheme(self.currentProject?.site.theme, self.previewColorMode);
  },

  /**
   * The mode a surface answers `prefers-color-scheme` with: the frame's scheme on a
   * forced or `system` site, undefined on a site with no choice, whose dark rules stay
   * as stored (dead on the canvas until previewed, the real system's on the preview).
   */
  get frameColorMode(): ColorScheme | undefined {
    return surfaceColorMode(self.currentProject?.site.theme, self.previewColorMode);
  },

  /** True when the frames carry `class="dark"`: only on a site that forces `dark`. */
  get frameDarkClass(): boolean {
    return surfaceDarkClass(self.currentProject?.site.theme);
  },

  /** True while a definition is open on the canvas. */
  get inComponent(): boolean {
    return self.componentTrail.length > 0;
  },

  /** The page the address names: a definition has no address, so a reload opens a real page. */
  get addressPageId(): string | undefined {
    return self.componentTrail[0]?.pageId ?? self.currentPage?.id;
  },

  /**
   * True while the page runs on the canvas: the Interact tool, also while Space held in it
   * pans for a moment, so the page keeps running under a pan.
   */
  get interactOn(): boolean {
    return self.selectedTool === EditorTool.INTERACT || self.toolBeforeTemporaryGrab === EditorTool.INTERACT;
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

  /** The state a shop control shows on the canvas (ShopPreviewBar). */
  setShopPreviewState(controlId: string, state: string) {
    if (self.shopPreviewStates[controlId] === state) return;
    self.shopPreviewStates = { ...self.shopPreviewStates, [controlId]: state };
  },

  /** Shows one rule on every copy of its node, or none. */
  setPreviewRule(preview: { componentId: string; ruleId: string } | null) {
    self.previewRule = preview;
  },

  setRuleRefusal(reason: string | null) {
    self.ruleRefusal = reason;
  },

  /** Shows a state at `value` on the canvas, or at its first value again with undefined. */
  setPreviewValue(stateId: string, value: string | number | boolean | undefined) {
    const next: Record<string, string | number | boolean> = { ...self.previewState };
    if (value === undefined) delete next[stateId];
    else next[stateId] = value;
    self.previewState = next;
  },

  /** Every state back at its first value, and the notice naming a preview gone with it. */
  clearPreviewState() {
    if (Object.keys(self.previewState).length > 0) self.previewState = {};
    if (self.editorNotice?.kind === 'previewState') self.editorNotice = undefined;
    else if (self.editorNotice?.preview) self.editorNotice = { ...self.editorNotice, preview: undefined };
  },

  /** Which mode a `system` site's frames show. Writes nothing to the project. */
  setPreviewColorMode(mode: ColorScheme) {
    self.previewColorMode = mode === 'dark' ? 'dark' : 'light';
  },

  /** Draw this FX scene box live on the canvas, in this frame (`null`: wherever it is drawn first). */
  startFxLive(componentId: string, frameId: string | null) {
    self.fxLive = { componentId, frameId };
    self.fxLiveStatus = { state: 'loading' };
  },

  /** Back to the box's own background on the canvas. */
  stopFxLive() {
    self.fxLive = undefined;
    self.fxLiveStatus = { state: 'idle' };
  },

  /**
   * Pick a layer row of an FX scene box. The box stays (or becomes) the primary selection, in
   * the frame the row was picked in (which moves Live there, as picking the box does), and
   * the pick is set after the selection, because every selection change drops a pick.
   */
  pickFxLayer(box: ComponentInstance, pick: { kind: 'layer'; layerId: string } | { kind: 'background' }, breakpointId?: string) {
    const primary = self.selectedComponent;
    const frame = self.selectedViewportNode?.breakpointId;
    if (!primary || primary.id !== box.id || self.selectedComponents.length !== 1 || (breakpointId && frame !== breakpointId)) this.selectComponent(box, breakpointId ?? frame);
    self.fxLayerRenaming = undefined;
    self.selectedFxLayer = pick.kind === 'layer' ? { componentId: box.id, kind: 'layer', layerId: pick.layerId } : { componentId: box.id, kind: 'background' };
  },

  /** Back to the box: nothing of its scene picked. */
  clearFxLayerPick() {
    self.selectedFxLayer = undefined;
    self.fxLayerRenaming = undefined;
  },

  /** `setFxLayerType` gives a layer a new id: the pick follows it. */
  followFxLayer(componentId: string, layerId: string) {
    const pick = self.selectedFxLayer;
    if (pick && pick.kind === 'layer' && pick.componentId === componentId) self.selectedFxLayer = { componentId, kind: 'layer', layerId };
  },

  startFxLayerRename(componentId: string, layerId: string) {
    self.fxLayerRenaming = { componentId, layerId };
  },

  endFxLayerRename() {
    self.fxLayerRenaming = undefined;
  },

  setFxLayerNotice(notice: FxLayerNotice | undefined) {
    self.fxLayerNotice = notice;
  },

  /** The live layer says what it is doing (src/components/fx/FxLayer.tsx). */
  reportFxLive(status: FxLiveStatus) {
    if (self.fxLive) self.fxLiveStatus = status;
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
      self.shopPreviewStates = {};
      self.editingComponent = undefined;
      self.selectedViewportNode = undefined;
      self.selectedComponents.clear();
      self.hoverComponent = undefined;
      self.componentTrail = [];
      self.componentRequest = null;
      self.fxLive = undefined;
      self.fxLiveStatus = { state: 'idle' };
      self.selectedFxLayer = undefined;
      self.fxLayerRenaming = undefined;
      self.fxLayerNotice = undefined;
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
    // The agent's new page offered by a notice, shown by any route: the notice has done its job.
    if (self.editorNotice?.kind === 'newPage' && page && self.editorNotice.pageId === page.id) self.editorNotice = undefined;
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
    // Selecting a node (the box again, or another) is back to the node: no layer of a scene is picked.
    self.selectedFxLayer = undefined;
    self.fxLayerRenaming = undefined;
    // The live FX scene follows its box to the frame it is picked in: one frame at a time.
    if (self.fxLive && target && self.fxLive.componentId === target.id && breakpointId && self.fxLive.frameId !== breakpointId) {
      self.fxLive = { componentId: target.id, frameId: breakpointId };
      self.fxLiveStatus = { state: 'loading' };
    }
    
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
    if (target) this.revealInPreview(target);
  },

  /**
   * A node a `showWhen` hides cannot be clicked on the canvas, only picked in Layers.
   * When what hides it is a plain chain of `eq`, the preview takes the values that show
   * it, and the notice names them. Otherwise the notice says what hides it. A node
   * nothing hides changes nothing, so this costs a click on the canvas only a lookup.
   */
  revealInPreview(component: ComponentInstance) {
    const page = self.currentPage;
    // The page runs in Interact, from its first values: a preview there would say otherwise.
    if (!page || self.interactOn) return;
    const roots = [page.expansion.root, ...page.expansion.floating] as ComponentNode[];
    // A page holding no behaviour has nothing that hides: the pass hands its own tree back.
    if (roots.every(root => surfaceBehaviour(root).root === root)) return;
    for (const root of roots) {
      const reveal = revealFor(root, component.id, self.previewState);
      if (!reveal) continue;
      if (reveal.blocked) {
        self.editorNotice = { kind: 'previewState', message: `This layer is hidden by ${reveal.blocked}. Change its Show when to reach it.` };
        return;
      }
      if (reveal.names.length === 0) return;
      self.previewState = { ...self.previewState, ...reveal.values };
      self.editorNotice = { kind: 'previewState', message: `Previewing ${reveal.names.join(', ')} so this layer shows. The page itself is unchanged.` };
      return;
    }
  },
  
  // Viewport node selection (Framer-style)
  setSelectedViewportNode(viewportNode?: ComponentInstance) {
    self.selectedViewportNode = viewportNode;
    // Clear component selection when selecting a viewport
    self.selectedComponent = undefined;
    self.selectedComponents.clear();
    self.selectedFxLayer = undefined;
    self.fxLayerRenaming = undefined;
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
    self.selectedFxLayer = undefined;
    self.fxLayerRenaming = undefined;
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
    self.selectedFxLayer = undefined;
    self.fxLayerRenaming = undefined;
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
    const from = self.selectedTool as EditorTool;
    // Space held in Interact still pans, and comes back to Interact: only a tool picked
    // on purpose enters or leaves it.
    const base = self.toolBeforeTemporaryGrab ?? from;
    self.selectedTool = tool;
    // Picking a tool while Space is held makes that tool stick on release.
    self.toolBeforeTemporaryGrab = undefined;
    if ((tool === EditorTool.INTERACT) === (base === EditorTool.INTERACT)) return;
    self.interactEpoch += 1;
    if (tool === EditorTool.INTERACT) {
      // The page starts from its first values, so a Select preview ends, notice and all.
      this.clearPreviewState();
      // Nothing is edited or offered on the canvas while it runs.
      self.editingComponent = undefined;
      self.phoneContextMenu = undefined;
      self.phoneContextMenuHover = undefined;
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

  requestPageFit() {
    self.pageFitRequest += 1;
  },

  setMarqueeActive(active: boolean) {
    if (self.marqueeActive !== active) self.marqueeActive = active;
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

  /**
   * The picked layer of an FX scene box, or undefined: nothing picked, the box is no longer the
   * primary selection, its scene cannot be read, or the layer is gone (an undo of its add, a
   * preset, an import, another writer's snapshot). Every reader of the pick goes through this,
   * so a pick that points at nothing falls back to the box. The Background pick has no layer
   * id and holds while the box has a readable scene.
   */
  get fxLayerPick(): FxLayerPick | undefined {
    const pick = self.selectedFxLayer;
    const box = self.selectedComponent;
    if (!pick || !box || box.id !== pick.componentId) return undefined;
    const read = parseFxProp((box.props as Record<string, unknown>)[FX_PROP]);
    if (!read.ok) return undefined;
    if (pick.kind === 'background') return pick;
    return read.fx.scene.layers.some(l => l.id === pick.layerId) ? pick : undefined;
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
    // A preview names states of one page: another page, or another project, starts from
    // first values, however the editor got there.
    addDisposer(
      self,
      reaction(
        () => [self.currentProject?.id, self.currentPage?.id],
        () => self.clearPreviewState(),
        { equals: comparer.structural },
      ),
    );
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
