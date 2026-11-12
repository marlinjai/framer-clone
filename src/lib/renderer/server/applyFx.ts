// applyFx: finds the FX scene boxes of a published page (src/lib/fxScene) and
// turns each stored scene into an entry of the page's FX program, which FxIsland
// draws on the client. On the tree it leaves only a mark:
//
//   - a box whose scene reads cleanly gets `data-fc-fx="<index>"`, its place in
//     the program;
//   - `fx` is taken off EVERY node (but an SVG `radialGradient`, where it is the
//     gradient's focal point), refused scenes and nodes that are no FX box included: some islands receive whole nodes as props, and stored scene data
//     has no business in the page's HTML or its flight payload;
//   - the marks only this step may write (`data-fc-fx`, `data-fc-fx-state`) are
//     dropped from every stored node, so nothing stored can pose as a scene.
//
// The program holds what the strict reader gives back (`toStoredFx`), never the
// stored prop: values only, every field rebuilt, image addresses checked.
//
// A box whose scene is refused keeps its marker and is otherwise an ordinary box:
// its own CSS background and its children are what a visitor sees, which is also
// what every FX box shows until (and unless) its scene is drawn.
//
// Runs on the hydrated tree, so a scene inside a collection row is found once per
// row. PURE: no React, no DOM, and no three.js (the engine's render-free entry).

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { readFxScene, storedFxProp, type StoredFx } from '@/lib/fxScene/fxScene';
import { FX_INDEX_ATTR, isFxIssuedAttribute, isFxSceneProp } from '@/lib/fxScene/marker';

export interface FxResult {
  /** The rewritten tree (a new tree; the input is not mutated). */
  root: ComponentNode;
  /** One entry per FX box that reads cleanly, in document order. Empty on a page without one. */
  program: StoredFx[];
}

export function applyFx(root: ComponentNode): FxResult {
  const program: StoredFx[] = [];

  const visit = (node: ComponentNode): ComponentNode => {
    const next: ComponentNode = { ...node };
    const stored = node.props as Record<string, unknown> | undefined;
    if (stored) {
      const props: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(stored)) {
        if (!isFxSceneProp(name, node.type) && !isFxIssuedAttribute(name)) props[name] = value;
      }
      const scene = readFxScene(stored, node.type);
      if (scene.ok) {
        props[FX_INDEX_ATTR] = String(program.length);
        program.push(storedFxProp(scene.fx));
      }
      next.props = props as ComponentNode['props'];
    }
    if (node.children) next.children = node.children.map(visit);
    return next;
  };

  return { root: visit(root), program };
}
