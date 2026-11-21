'use client';

// src/lib/renderer/customCode/customCodeSurfaceContext.tsx
//
// The surface a block is drawn on, as a React context. Kept apart from
// customCodeElement.tsx, which the published-page renderer (a Server Component
// graph) imports: createContext may not run there.

import React from 'react';
import {
  createCustomCodeElement,
  type CustomCodeElementInput,
  type CustomCodeSurface,
} from './customCodeElement';

/**
 * What the editor surfaces tell a block about where it is drawn. The default is
 * the safe one: a tile, without a link. The editor gives the link to the page's
 * standalone preview; only the standalone preview route says `standalone`.
 */
export interface CustomCodeSurfaceInfo {
  standalone: boolean;
  previewHref: string | null;
}

export const CustomCodeSurfaceContext = React.createContext<CustomCodeSurfaceInfo>({ standalone: false, previewHref: null });

/**
 * A block on the editor's surfaces, as createComponentElement draws it: the canvas
 * is always the tile; the preview is the tile too, unless the standalone preview
 * route says otherwise through CustomCodeSurfaceContext.
 */
export function CustomCodeOnEditorSurface({ mode, ...input }: CustomCodeElementInput & { mode: 'editor' | 'preview' }): React.ReactElement | null {
  const info = React.useContext(CustomCodeSurfaceContext);
  const surface: CustomCodeSurface = mode === 'editor' ? 'editor' : info.standalone ? 'standalone' : 'preview';
  return createCustomCodeElement(surface, { ...input, previewHref: info.previewHref });
}
