// src/lib/siteMerge/validate.ts
//
// A merged document must be a valid site before anything is written (docs/plans/2026-11-10-site-branches.md,
// section 5, "The merged document must be a valid site"): it loads on a scratch copy (`ProjectModel.create`)
// and passes what a save checks, against what the site it is written to stores today:
//
// - the address rules (`findProjectSlugProblem`): an unchanged address is grandfathered, a new one must be
//   valid and unique, the home page keeps the root;
// - the theme's caps (`themeBoundsErrors`): a count over a cap may stay, never grow;
// - the size limit of every reusable component (one already too big may stay so, never grow), as the
//   live replay's dry run checks it (`./shared.ts`);
// - behaviour that still reads, in every tree (pages, components, canvas nodes): no node's behaviour refused
//   that the stored site ran;
// - no node id on two pages or components (decision 36: a node moved to another page on one side and kept on
//   the other);
// - the body limit of a save.
//
// The document is turned into an editor project by the caller (the server's `persistedToProjectSnapshot`,
// which also repairs what a load repairs), so this module stays free of server code.
//
// PURE: client and server safe.

import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectSnapshotIn } from '@/models/ProjectModel';
import { findProjectSlugProblem } from '@/lib/pages/slug';
import { normalizeTheme, themeBoundsErrors } from '@/lib/site/theme';
import { readBehaviourTree } from '@/lib/behaviour/format';
import { serializedBytes } from '@/lib/components/placement';
import { PROJECT_BODY_MAX_BYTES } from '@/lib/api/respond';
import { isPlainObject } from './value';
import { outgrewLimit } from './shared';
import { documentBodies, treesOf, walkNodes } from './references';
import type { MergeDocument } from './document';

export interface MergeProblem {
  code: 'slug' | 'theme' | 'component_too_large' | 'behaviour' | 'duplicate_id' | 'too_large' | 'does_not_load';
  message: string;
  /** The page or component definition it is about, when it is about one. */
  pageId?: string;
  componentId?: string;
}

export type ToProject = (doc: MergeDocument) => ProjectSnapshotIn;

/**
 * The problems of writing `merged` over `stored` (the site the merge writes to, as it is now). Empty: valid.
 */
export function mergedDocumentProblems(merged: MergeDocument, stored: MergeDocument, toProject: ToProject): MergeProblem[] {
  const problems: MergeProblem[] = [];

  const storedSlugs = new Map(stored.pages.map((p) => [p.pageId, p.slug]));
  const slug = findProjectSlugProblem(
    merged.pages.map((p) => ({ pageId: p.pageId, slug: p.slug, title: titleOf(p.snapshot) })),
    storedSlugs,
  );
  if (slug) problems.push({ code: 'slug', message: slug.message, pageId: slug.pageId });

  const theme = (doc: MergeDocument) => normalizeTheme(isPlainObject(doc.siteSettings) ? doc.siteSettings.theme : undefined);
  for (const message of themeBoundsErrors(theme(merged), theme(stored))) problems.push({ code: 'theme', message });

  // A node id held by two pages or components: what the merge gives when a node moved to another page on one
  // side and was kept where it was on the other (decision 36). Like the other rules, one the site already had
  // may stay.
  const shared = (doc: MergeDocument) => {
    const owner = new Map<string, string>();
    const twice = new Set<string>();
    for (const [container, body] of documentBodies(doc)) {
      const here = new Set<string>();
      for (const node of walkNodes(treesOf(body))) if (typeof node.id === 'string') here.add(node.id);
      for (const id of here) {
        const first = owner.get(id);
        if (first === undefined) owner.set(id, container);
        else twice.add(id);
      }
    }
    return { owner, twice };
  };
  const stillShared = shared(stored).twice;
  const { owner, twice } = shared(merged);
  for (const id of [...twice].sort()) {
    if (stillShared.has(id)) continue;
    const container = owner.get(id)!;
    const at = container.startsWith('page:') ? { pageId: container.slice(5) } : { componentId: container.slice(10) };
    problems.push({ code: 'duplicate_id', message: `node ${id} is on two pages or components at once`, ...at });
  }

  let project: ProjectSnapshotIn;
  try {
    project = toProject(merged);
  } catch (err) {
    return [...problems, { code: 'does_not_load', message: messageOf(err) }];
  }
  if (new TextEncoder().encode(JSON.stringify(project)).length > PROJECT_BODY_MAX_BYTES) {
    problems.push({ code: 'too_large', message: `the merged site is larger than a save may be (${PROJECT_BODY_MAX_BYTES} bytes)` });
  }

  let scratch: ReturnType<typeof ProjectModel.create>;
  try {
    scratch = ProjectModel.create(project);
  } catch (err) {
    return [...problems, { code: 'does_not_load', message: messageOf(err) }];
  }

  // `stored` is normalised through the editor model like `merged` (decision 35), so both sizes are of the same
  // shape: a definition does not grow over its limit by defaults alone.
  for (const [id, definition] of scratch.components) {
    const after = serializedBytes(getSnapshot(definition));
    const before = isPlainObject(stored.components?.[id]) ? serializedBytes(stored.components[id]) : 0;
    if (outgrewLimit(after, before)) {
      problems.push({ code: 'component_too_large', message: `the reusable component "${definition.name}" is over its size limit`, componentId: id });
    }
  }

  const refusedNodes = (doc: MergeDocument) => {
    const out = new Set<string>();
    // Every tree: each page's and component's own, and the canvas nodes beside it.
    for (const [container, body] of documentBodies(doc)) {
      for (const root of treesOf(body)) {
        if (!isPlainObject(root)) continue;
        for (const refused of readBehaviourTree(root as never).refused) out.add(`${container}|${refused.nodeId ?? ''}|${refused.reason ?? ''}`);
      }
    }
    return out;
  };
  const before = refusedNodes(stored);
  for (const key of refusedNodes(merged)) {
    if (before.has(key)) continue;
    const [container, nodeId] = key.split('|');
    const [kind, id] = [container.slice(0, container.indexOf(':')), container.slice(container.indexOf(':') + 1)];
    problems.push({
      code: 'behaviour',
      message: `a behaviour on node ${nodeId || '(unnamed)'} no longer reads`,
      ...(kind === 'page' ? { pageId: id } : { componentId: id }),
    });
  }

  return problems;
}

function titleOf(snapshot: Record<string, unknown>): string | undefined {
  const metadata = snapshot.metadata;
  return isPlainObject(metadata) && typeof metadata.title === 'string' ? metadata.title : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 500) : 'the merged site does not load';
}
