// src/lib/site/PageBaseStyles.tsx
//
// The page base on an editor surface (pageBase.ts), so the canvas and the preview show
// what the published page shows. It renders beside the rule sheet, not beside a node,
// for the reason in CanvasRuleStyles.tsx.
import React from 'react';
import { surfacePageBaseSheet, type PageBase } from './pageBase';

export interface PageBaseStylesProps {
  base: PageBase;
  /** The selectors of the frames a page shows in. */
  roots: readonly string[];
}

export function PageBaseStyles({ base, roots }: PageBaseStylesProps) {
  const css = surfacePageBaseSheet(base, roots);
  if (!css) return null;
  // Constant text: the base is one of two names, and the roots are constants.
  return <style data-fc-page-base="" dangerouslySetInnerHTML={{ __html: css }} />;
}
