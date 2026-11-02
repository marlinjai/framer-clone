// src/lib/rules/CanvasRuleStyles.tsx
//
// The rule sheet of the two editor surfaces, one <style> element each. On the canvas
// it sits at the root, beside PageFontFaces and not beside a node, because a <style>
// next to an element counts as a sibling and would shift `:nth-child` and
// `:first-child`, the rows it is there to show. Observers: they re-render when a
// node's props are replaced, each rule's text is kept (surfaceSheet.ts), and React
// leaves the element alone while the text stays the same.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import type { SurfaceMemo } from '@/lib/responsive/responsiveCss';
import { surfaceSheet, type SurfaceFrameInput, type SurfaceNode, type SurfaceProblem, type SurfaceSheetInput } from './surfaceSheet';

/** One warning per distinct set of problems, never one per rebuild: a sheet rebuilds on every edit. */
function useProblemWarning(problems: readonly SurfaceProblem[]): void {
  const key = problems.length > 0 ? JSON.stringify(problems) : '';
  React.useEffect(() => {
    if (key) console.warn('A rule on this page does not show:', JSON.parse(key));
  }, [key]);
}

function useSheet(input: Omit<SurfaceSheetInput, 'memo' | 'onProblem'>): string {
  const memo = React.useRef<SurfaceMemo>(new WeakMap());
  const problems: SurfaceProblem[] = [];
  const css = surfaceSheet({ ...input, memo: memo.current, onProblem: (problem) => problems.push(problem) });
  useProblemWarning(problems);
  return css;
}

export interface CanvasRuleStylesProps {
  tree: SurfaceNode | null | undefined;
  definitionTree?: boolean;
  floating: readonly SurfaceNode[];
  frames: readonly SurfaceFrameInput[];
  breakpoints: readonly BreakpointRef[];
}

export const CanvasRuleStyles = observer(({ tree, definitionTree, floating, frames, breakpoints }: CanvasRuleStylesProps) => {
  const { editorUI } = useStore();
  const css = useSheet({ kind: 'canvas', tree, definitionTree, floating, frames, breakpoints, previewRule: editorUI.previewRule });
  if (!css) return null;
  // The parser and the emitter's guards have read every stored character of this.
  return <style data-fc-rules="canvas" dangerouslySetInnerHTML={{ __html: css }} />;
});

export interface PreviewRuleStylesProps {
  tree: SurfaceNode | null | undefined;
  definitionTree?: boolean;
  frame: SurfaceFrameInput;
  breakpoints: readonly BreakpointRef[];
}

export const PreviewRuleStyles = observer(({ tree, definitionTree, frame, breakpoints }: PreviewRuleStylesProps) => {
  const css = useSheet({ kind: 'preview', tree, definitionTree, frames: [frame], breakpoints });
  if (!css) return null;
  return <style data-fc-rules="preview" dangerouslySetInnerHTML={{ __html: css }} />;
});

CanvasRuleStyles.displayName = 'CanvasRuleStyles';
PreviewRuleStyles.displayName = 'PreviewRuleStyles';
