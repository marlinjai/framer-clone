// The browser side of the mounted canvas probe: the real EditorApp with its real
// root store, keyboard listeners, drag manager and Canvas, in real Chromium. Only
// the server edge is stubbed (see lib/canvasBundle.ts). `window.__placeTree` puts a
// tree on the home page, alone, and by default leaves one breakpoint frame, so a
// contract finds one copy of each element. `window.__editor` is what a contract
// about the editor itself needs from the store.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { applySnapshot, getSnapshot } from 'mobx-state-tree';
import EditorApp from '@/components/EditorApp';
// Named for what it is here: the singleton getter behind the hook, called outside React.
import { useStore as editorStore } from '@/hooks/useStore';
import { getUndoManager } from '@/stores/RootStore';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import type { PageBase } from '@/lib/site/pageBase';
import type { ColorScheme, SiteTheme } from '@/lib/site/theme';

interface PlaceOptions {
  /** Keep every breakpoint frame, for a contract that compares them. */
  allFrames?: boolean;
  /** Snapshots placed on the canvas outside any frame. */
  floating?: Record<string, unknown>[];
}

interface ProbeWindow {
  __placeTree: (snapshot: unknown, options?: PlaceOptions) => void;
  __editor: {
    frames: () => { breakpointId: string; label: string }[];
    setPreviewRule: (preview: { componentId: string; ruleId: string } | null) => void;
    setPreviewOpen: (open: boolean) => void;
    setPageBase: (base: PageBase) => void;
    setTheme: (theme: SiteTheme) => void;
    setPreviewColorMode: (mode: ColorScheme) => void;
    setRuleStyle: (componentId: string, ruleId: string, style: Record<string, unknown>) => void;
    setStyle: (componentId: string, style: Record<string, unknown>) => void;
    toggleLock: (componentId: string) => void;
    selectedId: () => string | undefined;
    editingId: () => string | undefined;
    propsOf: (componentId: string) => Record<string, unknown> | undefined;
    setBehaviour: (componentId: string, behaviour: Record<string, unknown> | undefined) => void;
    undo: () => void;
    previewState: () => Record<string, unknown>;
    undoLevels: () => number;
    setPreviewValue: (stateId: string, value: string | number | boolean | undefined) => void;
    tool: () => string;
    select: (componentId: string) => void;
    /** The open project as stored, to show nothing reached it. */
    projectJson: () => string;
    /** A second page of the project, with this slug. */
    addPage: (title: string) => string;
    pageSlug: () => string | undefined;
    notice: () => string | undefined;
  };
}

const root = document.getElementById('root');
if (!root) throw new Error('the probe page has no root element');

flushSync(() => createRoot(root).render(<EditorApp />));

const openPage = () => {
  const page = editorStore().editorUI.currentPage;
  if (!page) throw new Error('the editor opened no page');
  return page;
};

const find = (node: ComponentInstance, id: string): ComponentInstance | undefined =>
  node.id === id ? node : (node.children as ComponentInstance[]).map((child) => find(child, id)).find(Boolean);

const nodeById = (id: string): ComponentInstance | undefined => {
  const page = openPage();
  return [page.appComponentTree, ...page.floatingElements].map((root) => find(root as ComponentInstance, id)).find(Boolean);
};

(window as unknown as ProbeWindow).__placeTree = (snapshot, options = {}) => {
  const page = openPage();
  const [first] = page.sortedViewportNodes;
  const nodes = getSnapshot(page.canvasNodes) as Record<string, unknown>;
  const kept = options.allFrames
    ? Object.fromEntries(page.sortedViewportNodes.map((viewport: ComponentInstance) => [viewport.id, nodes[viewport.id]]))
    : { [first.id]: nodes[first.id] };
  const floating = Object.fromEntries((options.floating ?? []).map((node) => [node.id as string, { canvasNodeType: 'floating', canvasX: 40, canvasY: 900, ...node }]));
  applySnapshot(page.canvasNodes, { ...kept, ...floating } as never);
  // The tree sits directly under a plain root. The demo page's own header and main
  // would be its ancestors and change what its landmarks mean.
  // A rule on `:root` belongs to the page root, which the tree is on a published page:
  // the plain root takes it, so the canvas is asked what it shows for the same page.
  const props = ((snapshot as { props?: Record<string, unknown> }).props ?? {}) as Record<string, unknown>;
  const stored = Array.isArray(props.rules) ? (props.rules as { selector?: unknown }[]) : [];
  const onDocument = stored.filter((rule) => rule.selector === ':root');
  const nodeRules = stored.filter((rule) => rule.selector !== ':root');
  const tree = onDocument.length === 0 ? snapshot : { ...(snapshot as object), props: { ...props, ...(nodeRules.length > 0 ? { rules: nodeRules } : {}) } };
  if (nodeRules.length === 0 && onDocument.length > 0) delete (tree as { props: Record<string, unknown> }).props.rules;
  const root = page.appComponentTree as ComponentInstance;
  applySnapshot(root, { ...(getSnapshot(root) as object), type: 'div', props: onDocument.length > 0 ? { rules: onDocument } : {}, children: [] } as never);
  root.addChildren([ComponentModel.create(tree as never)]);
};

(window as unknown as ProbeWindow).__editor = {
  frames: () => openPage().sortedViewportNodes.map((viewport: ComponentInstance) => ({ breakpointId: viewport.breakpointId!, label: viewport.label! })),
  setPreviewRule: (preview) => editorStore().editorUI.setPreviewRule(preview),
  setPreviewOpen: (open) => editorStore().editorUI.setPreviewOpen(open),
  setPageBase: (base) => {
    const project = editorStore().editorUI.currentProject;
    if (!project) throw new Error('the editor opened no project');
    const result = project.updateSiteSettings({ ...project.site, pageBase: base });
    if (!result.ok) throw new Error(`the settings were refused: ${JSON.stringify(result.errors)}`);
  },
  setTheme: (theme) => {
    const project = editorStore().editorUI.currentProject;
    if (!project) throw new Error('the editor opened no project');
    const result = project.updateTheme(theme);
    if (!result.ok) throw new Error(`the theme was refused: ${JSON.stringify(result.errors)}`);
  },
  setPreviewColorMode: (mode) => editorStore().editorUI.setPreviewColorMode(mode),
  setRuleStyle: (componentId, ruleId, style) => {
    const node = nodeById(componentId);
    if (!node) throw new Error(`no node ${componentId}`);
    const rules = (node.props.rules as { id: string }[]).map((rule) => (rule.id === ruleId ? { ...rule, style } : rule));
    node.setProps({ ...node.props, rules });
  },
  setStyle: (componentId, style) => {
    const node = nodeById(componentId);
    if (!node) throw new Error(`no node ${componentId}`);
    for (const [key, value] of Object.entries(style)) node.updateResponsiveStyle(key, value);
  },
  toggleLock: (componentId) => nodeById(componentId)?.toggleCanvasLock(),
  selectedId: () => editorStore().editorUI.selectedComponent?.id,
  editingId: () => editorStore().editorUI.editingComponent?.id,
  propsOf: (componentId) => nodeById(componentId)?.props as Record<string, unknown> | undefined,
  setBehaviour: (componentId, behaviour) => {
    const node = nodeById(componentId);
    if (!node) throw new Error(`no node ${componentId}`);
    const written = node.setBehaviour(behaviour);
    if (!written.ok) throw new Error(`the behaviour was refused: ${written.reason}`);
  },
  undo: () => getUndoManager()?.undo(),
  previewState: () => ({ ...editorStore().editorUI.previewState }),
  undoLevels: () => getUndoManager()?.undoIdx ?? 0,
  setPreviewValue: (stateId, value) => editorStore().editorUI.setPreviewValue(stateId, value),
  tool: () => editorStore().editorUI.selectedTool,
  select: (componentId) => {
    const node = nodeById(componentId);
    if (!node) throw new Error(`no node ${componentId}`);
    editorStore().editorUI.selectComponent(node, openPage().sortedViewportNodes[0]?.breakpointId);
  },
  projectJson: () => {
    const project = editorStore().editorUI.currentProject;
    if (!project) throw new Error('the editor opened no project');
    return JSON.stringify(getSnapshot(project));
  },
  addPage: (title) => {
    const project = editorStore().editorUI.currentProject;
    if (!project) throw new Error('the editor opened no project');
    return project.createPage(title).slug;
  },
  pageSlug: () => editorStore().editorUI.currentPage?.slug,
  notice: () => editorStore().editorUI.editorNotice?.message,
};
