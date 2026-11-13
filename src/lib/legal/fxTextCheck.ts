// src/lib/legal/fxTextCheck.ts
//
// The publish warning for scene text. A `text` (lockup) or `textBox` layer of an FX scene is
// drawn as pixels into the scene. Without WebGL, before the scene starts, and under reduced
// motion with the "box background" choice, a visitor sees none of it, and neither do search
// engines and screen readers. The box's own HTML children are what everyone reads then.
// So a scene with such a layer whose box holds no HTML text gets a warning (never a gate).
// PURE: no React, no DOM.

import { FX_PROP, isFxScene } from '@/lib/fxScene/marker';
import { parseFxProp } from '@/lib/fxScene/fxScene';

interface TreeNode {
  type?: unknown;
  props?: Record<string, unknown> | null;
  /** Data bindings of the node: a heading bound to data has no literal text, but it is text. */
  bindings?: Record<string, unknown> | null;
  children?: TreeNode[] | null;
}

/** Layer kinds that draw text into the scene as pixels. */
const TEXT_KINDS = new Set(['text', 'textBox']);

function holdsHtmlText(box: TreeNode): boolean {
  const stack: TreeNode[] = [...(box.children ?? [])];
  let seen = 0;
  while (stack.length > 0 && seen < 20000) {
    const node = stack.pop()!;
    seen++;
    const text = node.props?.children;
    if (typeof text === 'string' && text.trim() !== '') return true;
    if (typeof text === 'number' || node.bindings?.children) return true;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return false;
}

/** How many FX scene boxes in the tree draw text layers while the box holds no HTML text. */
export function countFxBoxesWithoutHtmlText(root: unknown): number {
  let count = 0;
  const stack: TreeNode[] = root && typeof root === 'object' ? [root as TreeNode] : [];
  let seen = 0;
  while (stack.length > 0 && seen < 20000) {
    const node = stack.pop()!;
    seen++;
    if (isFxScene(node.props, node.type)) {
      const read = parseFxProp(node.props?.[FX_PROP]);
      if (read.ok && read.fx.scene.layers.some((l) => TEXT_KINDS.has(l.type)) && !holdsHtmlText(node)) count++;
    }
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return count;
}

/** The warning text, or null when the page is fine. */
export function fxTextWarning(root: unknown): string | null {
  const n = countFxBoxesWithoutHtmlText(root);
  if (n === 0) return null;
  return `${n === 1 ? 'an FX scene has' : `${n} FX scenes have`} text drawn inside the scene but no text in ${n === 1 ? 'its box' : 'their boxes'}, so a visitor without WebGL or with reduced motion, search engines and screen readers see no text there. Add the headline as ordinary text inside the box`;
}
