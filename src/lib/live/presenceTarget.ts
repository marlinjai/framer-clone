// src/lib/live/presenceTarget.ts
//
// Where the presence frame of an agent goes (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 2): around the SECTION the agent works on, the top-level child of the
// page root that contains the call's nodes, never around each node (a frame
// jumping between dozens of leaves per second reads as noise). A call that
// touches several sections frames the first in document order. A call that
// names a page and no node (createPage, get_page, an insert into the page root)
// frames the page. A call whose nodes are all gone (deleted by the person, or by
// the agent's own later write) frames nothing: derived state keyed to nodes
// that no longer exist is dropped.
//
// Pure and client-safe: it reads plain trees, so tests need no editor.

/** The part of a component tree this module reads. */
export interface PresenceTreeNode {
  id: string;
  children: readonly PresenceTreeNode[] | Iterable<PresenceTreeNode>;
}

/** The part of a page this module reads. */
export interface PresencePage {
  id: string;
  appComponentTree: PresenceTreeNode;
}

/** What a frame is drawn around: a section of a page, or the page itself. */
export type PresenceTarget = { kind: 'section'; pageId: string; sectionId: string } | { kind: 'page'; pageId: string };

function childrenOf(node: PresenceTreeNode): PresenceTreeNode[] {
  return Array.from(node.children as Iterable<PresenceTreeNode>);
}

function contains(node: PresenceTreeNode, ids: ReadonlySet<string>): boolean {
  if (ids.has(node.id)) return true;
  for (const child of childrenOf(node)) if (contains(child, ids)) return true;
  return false;
}

/** Whether any of the ids is in the tree (the root included). */
export function treeHasAny(root: PresenceTreeNode, ids: ReadonlySet<string>): boolean {
  return contains(root, ids);
}

/**
 * The first top-level child of `root` (in document order) that is or contains
 * one of `nodeIds`; undefined when none does (the ids name the root itself, or
 * nothing on this page).
 */
export function sectionOf(root: PresenceTreeNode, nodeIds: readonly string[]): string | undefined {
  if (nodeIds.length === 0) return undefined;
  const ids = new Set(nodeIds);
  for (const child of childrenOf(root)) if (contains(child, ids)) return child.id;
  return undefined;
}

/**
 * The frame's target for a focus (a page id and node ids) in a project's
 * pages. Nodes win over the page: the page named or, when none is, the first
 * page holding one of the nodes.
 */
export function presenceTarget(
  pages: Iterable<PresencePage>,
  focus: { pageId?: string; nodeIds: readonly string[] },
): PresenceTarget | undefined {
  const all = Array.from(pages);
  const named = focus.pageId ? all.find((p) => p.id === focus.pageId) : undefined;
  if (focus.nodeIds.length > 0) {
    const ids = new Set(focus.nodeIds);
    const candidates = named ? [named, ...all.filter((p) => p !== named)] : all;
    for (const page of candidates) {
      if (!treeHasAny(page.appComponentTree, ids)) continue;
      const sectionId = sectionOf(page.appComponentTree, focus.nodeIds);
      return sectionId ? { kind: 'section', pageId: page.id, sectionId } : { kind: 'page', pageId: page.id };
    }
    // Every node it named is gone: nothing to frame.
    return undefined;
  }
  return named ? { kind: 'page', pageId: named.id } : undefined;
}

/** The page an agent works on, for the Pages panel's dot (the target's page, else the page it names). */
export function presencePageId(pages: Iterable<PresencePage>, focus: { pageId?: string; nodeIds: readonly string[] }): string | undefined {
  return presenceTarget(pages, focus)?.pageId;
}
