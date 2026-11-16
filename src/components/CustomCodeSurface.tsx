// src/components/CustomCodeSurface.tsx
//
// Tells a custom code block on the editor's surfaces (src/lib/renderer/customCode)
// where its standalone preview is: the tile on the canvas and in the preview over
// the editor links there, since that is the one place of the editor host that will
// run a block (slice C3). The browser-only demo project has no site, so no block of
// it can run anywhere and its tile has no link.
'use client';
import React, { useMemo } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { customCodePreviewHref } from '@/lib/customCode/customCode';
import { CustomCodeSurfaceContext, type CustomCodeSurfaceInfo } from '@/lib/renderer/customCode/customCodeElement';

const EditorCustomCodeSurface = observer(({ children }: { children: React.ReactNode }) => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const pageId = editorUI.currentPage?.id ?? null;
  const previewHref = project && !editorUI.isUnsavedDemo ? customCodePreviewHref(project.id, pageId) : null;
  const value = useMemo<CustomCodeSurfaceInfo>(() => ({ standalone: false, previewHref }), [previewHref]);
  return <CustomCodeSurfaceContext.Provider value={value}>{children}</CustomCodeSurfaceContext.Provider>;
});

EditorCustomCodeSurface.displayName = 'EditorCustomCodeSurface';
export default EditorCustomCodeSurface;

/** What the standalone preview route says: the box and its fallback, never the tile. */
export const STANDALONE_CUSTOM_CODE_SURFACE: CustomCodeSurfaceInfo = Object.freeze({ standalone: true, previewHref: null });
