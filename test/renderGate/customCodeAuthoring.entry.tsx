// The page side of customCodeAuthoring.gate.ts: the real editor (EditorApp, its store, the
// Components panel, Layers and the properties panel with the Custom code section and its
// CodeMirror field), opened on a server project as the editor route opens one (EditorMount),
// with custom code authoring available. The gate stands in for the server through routes.

import React from 'react';
import { createRoot } from 'react-dom/client';
import EditorApp from '@/components/EditorApp';
import { CustomCodeAuthoringProvider } from '@/components/customCode/CustomCodeAuthoring';
import { useStore as editorStore } from '@/hooks/useStore';
import type { ProjectSnapshotOut } from '@/models/ProjectModel';

interface GateWindow {
  __mount(snapshot: ProjectSnapshotOut, version: number): void;
  __customCodeOf(nodeId: string): unknown;
  __selectedId(): string | undefined;
  __pageId(): string | undefined;
}

const w = window as unknown as GateWindow;

w.__mount = (snapshot, version) => {
  createRoot(document.getElementById('root')!).render(
    <CustomCodeAuthoringProvider available projectId={snapshot.id}>
      <EditorApp projectSnapshot={snapshot} projectVersion={version} />
    </CustomCodeAuthoringProvider>,
  );
};

const find = (node: { id: string; props: unknown; children: unknown[] } | undefined, id: string): { props: unknown } | undefined => {
  if (!node) return undefined;
  if (node.id === id) return node;
  for (const child of node.children as { id: string; props: unknown; children: unknown[] }[]) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return undefined;
};

w.__customCodeOf = (nodeId) => {
  const page = editorStore().editorUI.currentPage;
  const node = find(page?.appComponentTree as never, nodeId);
  return node ? (node.props as Record<string, unknown>).customCode : 'missing';
};
w.__selectedId = () => editorStore().editorUI.selectedComponent?.id;
w.__pageId = () => editorStore().editorUI.currentPage?.id;
