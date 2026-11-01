// The browser side of the mounted canvas probe: the real EditorApp with its real
// root store, keyboard listeners, drag manager and Canvas, in real Chromium. Only
// the server edge is stubbed (see lib/canvasBundle.ts). `window.__placeTree` puts a
// tree on the home page, alone, and leaves one breakpoint frame, so a contract
// finds one copy of each element.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { applySnapshot, getSnapshot } from 'mobx-state-tree';
import EditorApp from '@/components/EditorApp';
// Named for what it is here: the singleton getter behind the hook, called outside React.
import { useStore as editorStore } from '@/hooks/useStore';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';

interface ProbeWindow {
  __placeTree: (snapshot: unknown) => void;
}

const root = document.getElementById('root');
if (!root) throw new Error('the probe page has no root element');

flushSync(() => createRoot(root).render(<EditorApp />));

(window as unknown as ProbeWindow).__placeTree = (snapshot) => {
  const { editorUI } = editorStore();
  const page = editorUI.currentPage;
  if (!page) throw new Error('the editor opened no page');
  const [first] = page.sortedViewportNodes;
  const nodes = getSnapshot(page.canvasNodes) as Record<string, unknown>;
  applySnapshot(page.canvasNodes, { [first.id]: nodes[first.id] });
  // The tree sits directly under a plain root. The demo page's own header and main
  // would be its ancestors and change what its landmarks mean.
  const root = page.appComponentTree as ComponentInstance;
  applySnapshot(root, { ...(getSnapshot(root) as object), type: 'div', props: {}, children: [] } as never);
  root.addChildren([ComponentModel.create(snapshot as never)]);
};
