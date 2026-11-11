// The merge on the real stored format (site branches plan, S2): documents built from an editor project
// the way the server stores them (`projectToPersisted`, `buildRevisionDocument`) and read back through the
// real schema (`parseRevisionDocument`), not only hand-written fixtures. Plus the plan's properties, on
// generated trees: merging a document with itself changes nothing; changes on disjoint nodes always merge
// without a conflict and the result holds both; the result always loads as a project.

import { describe, expect, it } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectSnapshotOut } from '@/models/ProjectModel';
import { buildEmptyDraftSnapshot } from '@/lib/projects/newProject';
import { projectToPersisted, persistedToProjectSnapshot } from '@/server/sites/snapshot';
import { buildRevisionDocument, parseRevisionDocument } from '@/server/sites/revision';
import { mergeDocuments, type MergeDocument } from '../document';
import { mergedDocumentProblems } from '../validate';
import { jsonEqual } from '../value';

/** A stored document of a project, as the server freezes one and reads it back. */
function stored(project: ProjectSnapshotOut): MergeDocument {
  const persisted = projectToPersisted(project);
  const written = buildRevisionDocument({ ...persisted, redirects: [], components: persisted.components ?? {} });
  return JSON.parse(JSON.stringify(parseRevisionDocument(JSON.parse(JSON.stringify(written))))) as unknown as MergeDocument;
}

/** A document as an editor project, the way a load builds one. */
const toProject = (doc: MergeDocument) =>
  persistedToProjectSnapshot({
    id: 'site-1',
    name: doc.name,
    description: doc.description,
    analyticsProjectId: doc.analyticsProjectId,
    ingestionEndpoint: doc.ingestionEndpoint,
    apiKeyRef: doc.apiKeyRef,
    lumitraEnabled: doc.lumitraEnabled,
    siteSettings: doc.siteSettings,
    components: doc.components,
    projectCreatedAt: new Date(0),
    projectUpdatedAt: new Date(0),
    pages: doc.pages.map((p) => ({ pageId: p.pageId, snapshot: p.snapshot })),
  });

/** Load a document into the editor model and store it again, as a tab's save would. */
function loadedAndSaved(doc: MergeDocument): MergeDocument {
  return stored(getSnapshot(ProjectModel.create(toProject(doc))) as ProjectSnapshotOut);
}

/** A small deterministic generator (mulberry32), so a failing case can be replayed by its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Node = { id: string; type: string; componentType: string; props: Record<string, unknown>; children: Node[] };

/** A site whose home page holds a generated tree of `size` nodes. */
function generatedSite(seed: number, size: number): MergeDocument {
  const random = rng(seed);
  const project = buildEmptyDraftSnapshot('site-1', 'Bakery', 1_700_000_000_000);
  const home = Object.values(project.pages)[0];
  const root = home.appComponentTree as unknown as Node;
  const all: Node[] = [root];
  for (let i = 0; i < size; i++) {
    const node: Node = { id: `n${seed}-${i}`, type: 'div', componentType: 'host', props: { children: `text ${i}`, style: { color: 'red' } }, children: [] };
    all[Math.floor(random() * all.length)].children.push(node);
    all.push(node);
  }
  // Through the editor model once, as every real save is: the nodes carry the model's defaults.
  return loadedAndSaved(stored(project));
}

function homeTree(doc: MergeDocument): Node {
  return doc.pages[0].snapshot.appComponentTree as unknown as Node;
}

function nodesOfTree(root: Node): Node[] {
  return [root, ...root.children.flatMap(nodesOfTree)];
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('the real stored format', () => {
  it('a document read back through the schema, loaded and saved again, merges as unchanged', () => {
    const base = generatedSite(1, 20);
    const again = loadedAndSaved(base);
    const merged = mergeDocuments(base, base, again);
    expect(merged.conflicts).toEqual([]);
    expect(mergedDocumentProblems(merged.document, base, toProject)).toEqual([]);
    // A page stored by a save loads and saves to the same document: nothing to merge.
    expect(jsonEqual(again.pages, base.pages)).toBe(true);
  });

  it('a side written without the model\u2019s defaults merges with a saved one without conflicts', () => {
    const base = generatedSite(3, 10);
    // Main written by hand (an import, an old tool): a new node without the defaults, an edit.
    const main = clone(base);
    const raw: Node = { id: 'raw', type: 'p', componentType: 'host', props: { children: 'raw' }, children: [] };
    homeTree(main).children.push(raw);
    nodesOfTree(homeTree(main))[2].props.children = 'main';
    // The branch: the same node arriving through a load and save (defaults added), another edit.
    const branch = loadedAndSaved(main);
    nodesOfTree(homeTree(branch))[4].props.children = 'branch';
    const merged = mergeDocuments(main, main, branch);
    expect(merged.conflicts).toEqual([]);
    const result = nodesOfTree(homeTree(merged.document));
    expect(result[2].props.children).toBe('main');
    expect(result[4].props.children).toBe('branch');
  });

  it('a page added in the editor on the branch and a text edited on main both land, and the result loads', () => {
    const base = generatedSite(2, 10);
    const main = clone(base);
    nodesOfTree(homeTree(main))[3].props.children = 'edited on main';
    const project = ProjectModel.create(toProject(base));
    project.addPage({
      id: 'team-page',
      slug: 'team',
      metadata: { title: 'Team', description: '' },
      appComponentTree: { id: 'root-team', type: 'div', componentType: 'host', props: {} },
      canvasNodes: {},
    } as never);
    const branch = stored(getSnapshot(project) as ProjectSnapshotOut);
    const merged = mergeDocuments(base, main, branch);
    expect(merged.conflicts).toEqual([]);
    expect(merged.document.pages.length).toBe(branch.pages.length);
    expect(nodesOfTree(homeTree(merged.document))[3].props.children).toBe('edited on main');
    expect(mergedDocumentProblems(merged.document, branch, toProject)).toEqual([]);
  });
});

describe('edits made through the editor model', () => {
  it('main and the branch editing one page on different nodes: no conflict, timestamps included', () => {
    const base = generatedSite(4, 12);
    const ids = nodesOfTree(homeTree(base)).map((n) => n.id);
    const edit = (change: (page: ReturnType<typeof pageOf>) => void, at: number) => {
      const project = ProjectModel.create(toProject(base));
      change(pageOf(project));
      const out = stored(getSnapshot(project) as ProjectSnapshotOut);
      // The page's own timestamp is the time of the edit (the model sets it from the clock).
      out.pages[0].snapshot.updatedAt = at;
      return out;
    };
    const main = edit((page) => page.findComponent(ids[3])!.setProps({ children: 'main' }), 1_800_000_000_000);
    const branch = edit((page) => {
      page.findComponent(ids[5])!.setProps({ children: 'branch' });
      page.updateMetadata({ description: 'From the branch' });
    }, 1_800_000_500_000);
    const merged = mergeDocuments(base, main, branch);
    expect(merged.conflicts).toEqual([]);
    const result = nodesOfTree(homeTree(merged.document));
    expect(result.find((n) => n.id === ids[3])?.props.children).toBe('main');
    expect(result.find((n) => n.id === ids[5])?.props.children).toBe('branch');
    expect((merged.document.pages[0].snapshot.metadata as Record<string, unknown>).description).toBe('From the branch');
    // The later of the two edits, compared as times (both are epoch numbers).
    expect(merged.document.pages[0].snapshot.updatedAt).toBe(1_800_000_500_000);
    expect(mergedDocumentProblems(merged.document, main, toProject)).toEqual([]);
  });
});

function pageOf(project: ReturnType<typeof ProjectModel.create>) {
  return [...project.pages.values()][0];
}

describe('properties, on generated sites', () => {
  const seeds = Array.from({ length: 40 }, (_, i) => i + 100);

  it.each(seeds)('seed %i: a document merged with itself is the same document', (seed) => {
    const doc = generatedSite(seed, 30);
    const merged = mergeDocuments(doc, doc, doc);
    expect(merged.conflicts).toEqual([]);
    expect(merged.document).toEqual(doc);
  });

  it.each(seeds)('seed %i: changes on disjoint nodes merge without conflict, hold both, and load', (seed) => {
    const random = rng(seed * 7);
    const base = generatedSite(seed, 30);
    const main = clone(base);
    const branch = clone(base);
    const ids = nodesOfTree(homeTree(base)).slice(1).map((n) => n.id);
    // Each node goes to one side at most: an edit, a new child, or a removal of a leaf.
    const owner = new Map<string, 'main' | 'branch'>();
    for (const id of ids) {
      const r = random();
      if (r < 0.3) owner.set(id, 'main');
      else if (r < 0.6) owner.set(id, 'branch');
    }
    const expected: Array<[string, unknown]> = [];
    let added = 0;
    for (const [id, side] of owner) {
      const doc = side === 'main' ? main : branch;
      const node = nodesOfTree(homeTree(doc)).find((n) => n.id === id)!;
      const action = random();
      if (action < 0.5) {
        node.props = { ...node.props, children: `${side} ${id}`, style: { color: side === 'main' ? 'green' : 'blue' } };
        expected.push([id, node.props]);
      } else {
        const child: Node = { id: `${side}-new-${added++}`, type: 'span', componentType: 'host', props: { children: 'new' }, children: [] };
        node.children.push(child);
        expected.push([child.id, child.props]);
      }
    }
    const merged = mergeDocuments(base, main, branch);
    expect(merged.conflicts).toEqual([]);
    const result = new Map(nodesOfTree(homeTree(merged.document)).map((n) => [n.id, n]));
    for (const [id, props] of expected) expect(result.get(id)?.props).toEqual(props);
    expect(mergedDocumentProblems(merged.document, base, toProject)).toEqual([]);
    // Changing only one side gives that side back.
    expect(mergeDocuments(base, base, branch).document.pages).toEqual(branch.pages);
    expect(mergeDocuments(base, main, base).document.pages).toEqual(main.pages);
  });

  it.each(seeds)('seed %i: with conflicts, every answer either way still loads', (seed) => {
    const random = rng(seed * 13);
    const base = generatedSite(seed, 25);
    const main = clone(base);
    const branch = clone(base);
    const mainNodes = nodesOfTree(homeTree(main));
    const branchNodes = nodesOfTree(homeTree(branch));
    for (let i = 1; i < mainNodes.length; i++) {
      const r = random();
      if (r < 0.3) mainNodes[i].props = { ...mainNodes[i].props, children: `m${i}` };
      if (r > 0.15 && r < 0.45) branchNodes[i].props = { ...branchNodes[i].props, children: `b${i}` };
    }
    // A removal on main of a subtree the branch edited inside.
    const victim = homeTree(main).children[0];
    if (victim) homeTree(main).children = homeTree(main).children.slice(1);
    const first = mergeDocuments(base, main, branch);
    for (const pick of ['main', 'branch'] as const) {
      const answers = Object.fromEntries(first.conflicts.map((c) => [c.id, { fingerprint: c.fingerprint, pick }]));
      const answered = mergeDocuments(base, main, branch, answers);
      expect(answered.conflicts).toEqual([]);
      expect(mergedDocumentProblems(answered.document, branch, toProject)).toEqual([]);
    }
  });
});
