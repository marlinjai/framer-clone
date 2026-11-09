// src/stores/openProject.ts
//
// How the editor (/projects/<id>) and Preview (/projects/<id>/preview) put a
// project into the shared in-browser store and pick the page to show.
//
// The store is a module singleton that survives client-side navigation, so
// going Editor -> Preview -> Editor can keep one working copy, including work
// not saved yet (a page just generated with AI). Whether it does is decided by
// comparing three versions of the project's PAGES, reusable COMPONENTS, and the
// site's THEME and HEAD items (each reaches every page, so a stale copy of one
// written back by a save overwrites a change made elsewhere on every page):
//   - the baseline: what this tab last loaded from, or saved to, the server;
//   - the server copy just loaded;
//   - the working copy in the store.
// Server unchanged since the baseline: keep the working copy. Server changed
// (saved in another tab, by someone else) and the working copy unchanged:
// take the server copy. Both changed: keep the working copy and report a
// conflict, so the editor can warn before a save overwrites the other work.
// The name always follows the server (the rename action owns it).
//
// The version lock rides along: the server numbers every write of the working
// copy, and this tab remembers the number of the copy it last loaded or saved.
// A save (autosave) and Publish send it as `expectedVersion`, and a server that moved on
// refuses them with 409 `site_changed` (SiteChangedDialog asks what to do). A
// moved number counts as a change on the server here too, so an untouched tab
// takes the newer copy, and a tab that keeps its own unsaved work keeps its OLD
// number: its next save must be refused, never silently win. Versions only go
// up, so a LOWER number than this tab's is a stale read (the client router
// cache replaying an older editor payload, on Back after Preview): nothing of
// it is adopted, neither the content nor the number.
//
// Autosave (src/lib/projects/autosave.ts) asks this file two more things:
// whether the working copy still equals what the server holds (`isSaved`,
// comparing every saved part, not only the ones a load compares), and whether
// a change it sees came from a load putting the server copy in place
// (`isApplyingServerCopy`), which is never a change to save.
//
// Undo history belongs to one project: it is cleared whenever the project
// shown changes or is (re)loaded, and loading itself is never an undo step.
//
// The page comes from `?page=<pageId>` when that page exists, else the home
// page (empty slug), else the first page; `missingPageId` reports a requested
// page that does not exist here (typically never saved, after a reload).

import { runInAction } from 'mobx';
import { getSnapshot } from 'mobx-state-tree';
import type { ProjectSnapshotOut, ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import type { RootStoreType } from '@/stores/RootStore';
import { getHistoryStore } from '@/stores/RootStore';
import { takeStashedDemoProject } from '@/lib/projects/demoStash';
import { withDefaultViewports } from '@/lib/canvas/defaultViewports';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import { componentsWithShopParts, pageWithShopParts } from '@/lib/commerce/parts';
import { shareUnchanged } from '@/lib/projects/structuralSharing';

export interface OpenedProject {
  project: ProjectModelType | undefined;
  page: PageModelType | undefined;
  /** The requested page id when no such page exists in the project. */
  missingPageId?: string;
  /** True when the in-memory working copy was kept instead of the snapshot. */
  keptWorkingCopy: boolean;
  /**
   * True when the project was changed elsewhere since this tab loaded or
   * saved it, while this tab has unsaved changes too: a save here would
   * overwrite the other work.
   */
  changedElsewhere: boolean;
  /**
   * The names of the reusable components changed elsewhere, when
   * `changedElsewhere`: a save here would put the old ones back on every page
   * placing them, which a person cannot see by looking at the page in hand.
   */
  changedDefinitions: string[];
  /**
   * The site-wide parts changed elsewhere, when `changedElsewhere`: the theme and the
   * site's head items, which a save here would put back as this tab holds them.
   */
  changedSiteParts: SitePart[];
}

/** The site-wide parts of Site settings this file compares on their own. */
export type SitePart = 'theme' | 'head';

const SITE_PART_LABELS: Record<SitePart, string> = {
  theme: 'the site theme (colours, fonts and colour mode)',
  head: "the site's head items",
};

/** The parts of a project this file compares. */
export interface ProjectContent {
  pages?: unknown;
  components?: unknown;
  /** Only its `theme` and `head` are compared; the rest follows the dialog's own save. */
  siteSettings?: unknown;
  /** Compared by `isSaved` only (autosave), with the analytics binding and the description. */
  lumitra?: unknown;
  metadata?: unknown;
}

/** Key-order independent JSON, so a database round trip compares equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The content compared: every page, as the server's load path repairs it (frames, shop parts). */
function pagesContent(pages: unknown, language: string): string {
  const repaired: Record<string, unknown> = {};
  for (const [id, page] of Object.entries((pages ?? {}) as Record<string, object>)) {
    repaired[id] = pageWithShopParts(withDefaultViewports(page as { id?: unknown; canvasNodes?: unknown }), language);
  }
  return stableJson(repaired);
}

/** One version of a project: its pages, each definition on its own, by id, and the site parts. */
interface VersionContent {
  pages: string;
  components: Record<string, string>;
  site: Record<SitePart, string>;
}

function versionContent({ pages, components, siteSettings }: ProjectContent): VersionContent {
  const definitions = Object.entries(componentsWithShopParts((components ?? {}) as Record<string, unknown>, normalizeSiteSettings(siteSettings).language));
  // Normalized, as the server stores it, so a database round trip compares equal.
  const settings = normalizeSiteSettings(siteSettings);
  return {
    pages: pagesContent(pages, settings.language),
    components: Object.fromEntries(definitions.map(([id, definition]) => [id, stableJson(definition)])),
    site: { theme: stableJson(settings.theme), head: stableJson(settings.head) },
  };
}

/** The site parts that differ between two versions, in a fixed order. */
function changedSiteParts(from: VersionContent, to: VersionContent): SitePart[] {
  return (['theme', 'head'] as const).filter((part) => from.site[part] !== to.site[part]);
}

/** The ids of the definitions added, removed or changed between two versions. */
function changedDefinitionIds(from: VersionContent, to: VersionContent): string[] {
  const ids = new Set([...Object.keys(from.components), ...Object.keys(to.components)]);
  return [...ids].filter((id) => from.components[id] !== to.components[id]);
}

function sameVersion(a: VersionContent, b: VersionContent): boolean {
  return a.pages === b.pages && changedDefinitionIds(a, b).length === 0 && changedSiteParts(a, b).length === 0;
}

/** A definition's name in a snapshot, if it holds that definition. */
function definitionName(components: unknown, id: string): string | undefined {
  return (components as Record<string, { name?: string }> | undefined)?.[id]?.name;
}

// project id -> content of the last server version this tab knows.
const baselines = new Map<string, VersionContent>();
// project id -> the page ids of that same server copy (what another writer can have deleted).
const serverPageIds = new Map<string, ReadonlySet<string>>();
// project id -> the site version (sites.version) of that same server copy.
const knownVersions = new Map<string, number>();
// project id -> every saved part of that same server copy, as `savedContentKey`
// writes it: what autosave compares the working copy with.
const savedKeys = new Map<string, string>();
// project id -> the server version a load found while this tab kept unsaved
// work of its own (`changedElsewhere`): autosave stays paused until one write
// is chosen on purpose, instead of meeting the refusal 1.5 s later.
const openedChangedElsewhere = new Map<string, number>();
// Above zero while a load puts the server copy into the store.
let applyingServerCopy = 0;
// project id -> writes of this tab (autosave, Publish) out right now. A load
// meanwhile (Preview mounting, coming back to the editor) may already see the
// version that write produces: that is no change made elsewhere.
const writesInFlight = new Map<string, number>();

// project ids whose working copy this tab gave up on purpose ("Save mine as a
// new project" kept it elsewhere): the next load takes the server copy.
const discardedCopies = new Set<string>();

/**
 * Forget this tab's working copy of a project: it now lives on as another
 * project, so coming back opens the server's copy, without a warning.
 */
export function discardWorkingCopy(projectId: string): void {
  discardedCopies.add(projectId);
  openedChangedElsewhere.delete(projectId);
}

/** True while a write of this tab (autosave, Publish) is out for the project. */
export function hasWriteInFlight(projectId: string): boolean {
  return (writesInFlight.get(projectId) ?? 0) > 0;
}

// Told when the last write of this tab for a project settled (src/lib/projects/liveSync.ts).
const writeSettledListeners = new Set<(projectId: string) => void>();

/**
 * Hear when no write of this tab is out any more for a project: a newer version
 * held while it was out may be adoptable now (its answer moved the known version
 * without a 409). Answers the unsubscribe.
 */
export function onWritesSettled(listener: (projectId: string) => void): () => void {
  writeSettledListeners.add(listener);
  return () => {
    writeSettledListeners.delete(listener);
  };
}

/** Autosave and Publish report a write of this tab starting (true) and ending (false). */
export function noteWriteInFlight(projectId: string, inFlight: boolean): void {
  const count = (writesInFlight.get(projectId) ?? 0) + (inFlight ? 1 : -1);
  if (count > 0) writesInFlight.set(projectId, count);
  else {
    writesInFlight.delete(projectId);
    // After the writer's own bookkeeping for the answer (it runs right after this call).
    if (!inFlight) queueMicrotask(() => {
      for (const listener of [...writeSettledListeners]) listener(projectId);
    });
  }
}

/**
 * Every part of a project a save writes, except the name (the rename route
 * owns it) and volatile state (never in a snapshot): the compared parts as a
 * load compares them, plus the whole site settings, the analytics binding and
 * the description.
 */
function savedContentKey(project: ProjectContent, version: VersionContent = versionContent(project)): string {
  const metadata = (project.metadata ?? {}) as { description?: unknown };
  return stableJson({
    pages: version.pages,
    components: version.components,
    settings: stableJson(normalizeSiteSettings(project.siteSettings)),
    lumitra: stableJson(project.lumitra ?? null),
    description: metadata.description ?? '',
  });
}

/**
 * What a project is compared by, computed once: autosave takes it when the
 * debounce fires and hands the same value to `isSaved` and, after the write,
 * to `markServerVersion`, so a large project is serialised once per save.
 */
export interface SavedContent {
  readonly version: VersionContent;
  readonly key: string;
}

export function savedContentOf(project: ProjectContent): SavedContent {
  const version = versionContent(project);
  return { version, key: savedContentKey(project, version) };
}

/**
 * Record that the server now holds exactly this project, at this site version
 * (after a load, a save or a publish). `content` is `savedContentOf(project)`
 * when the caller already has it.
 */
export function markServerVersion(
  projectId: string,
  project: ProjectContent,
  version: number,
  content: SavedContent = savedContentOf(project),
): void {
  baselines.set(projectId, content.version);
  serverPageIds.set(projectId, new Set(Object.keys((project.pages ?? {}) as Record<string, unknown>)));
  knownVersions.set(projectId, version);
  savedKeys.set(projectId, content.key);
  openedChangedElsewhere.delete(projectId);
}

/**
 * True when the working copy holds exactly what the server last held for this
 * tab (loaded, saved or published), name and volatile state aside. False when
 * this tab never had a server copy of the project. Takes the project or its
 * `savedContentOf`.
 */
export function isSaved(projectId: string, project: ProjectContent | SavedContent): boolean {
  const saved = savedKeys.get(projectId);
  if (saved === undefined) return false;
  const key = 'key' in project && typeof project.key === 'string' ? project.key : savedContentKey(project as ProjectContent);
  return saved === key;
}

/**
 * The server version a load reported while this tab kept its own unsaved work
 * over a newer server copy (`OpenedProject.changedElsewhere`), until a write
 * of this tab succeeds. Undefined otherwise.
 */
export function changedElsewhereVersion(projectId: string): number | undefined {
  return openedChangedElsewhere.get(projectId);
}

/** True while a load puts the server copy into the store (not a change to save). */
export function isApplyingServerCopy(): boolean {
  return applyingServerCopy > 0;
}

function applyingServer(fn: () => void) {
  applyingServerCopy++;
  try {
    untracked(fn);
  } finally {
    applyingServerCopy--;
  }
}

/** The page ids of the last server copy this tab knows (loaded, saved, adopted), if any. */
export function knownServerPageIds(projectId: string): ReadonlySet<string> | undefined {
  return serverPageIds.get(projectId);
}

/**
 * The site version this tab's copy is based on: what a save and Publish send as
 * `expectedVersion`. Undefined when this tab never loaded the project from the
 * server (the server then refuses the write with `version_required`).
 */
export function knownServerVersion(projectId: string): number | undefined {
  return knownVersions.get(projectId);
}

/** The warning for `changedElsewhere`, naming the components and site parts a save would overwrite. */
export function changedElsewhereMessage(
  changedDefinitions: readonly string[],
  changedSite: readonly SitePart[] = [],
): string {
  const components = changedDefinitions.length > 0 ? ` Components changed there: ${changedDefinitions.join(', ')}.` : '';
  const site = changedSite.length > 0
    ? ` Also changed there, for every page: ${changedSite.map((part) => SITE_PART_LABELS[part]).join(' and ')}.`
    : '';
  return `This project was saved somewhere else since this tab loaded it, and this tab has unsaved changes too.${components}${site} Saving here overwrites the other changes; loading the newer version discards the unsaved changes in this tab.`;
}

/** The page to show: the requested one if it exists, else home, else the first. */
export function pickPage(
  project: ProjectModelType | undefined,
  requestedPageId: string | null | undefined,
): { page: PageModelType | undefined; missingPageId?: string } {
  if (!project) return { page: undefined };
  const fallback = project.findPageBySlug('') ?? project.pagesArray[0];
  if (!requestedPageId) return { page: fallback };
  const requested = project.getPage(requestedPageId);
  if (requested) return { page: requested };
  return { page: fallback, missingPageId: requestedPageId };
}

function untracked(fn: () => void) {
  const history = getHistoryStore();
  if (history) history.runUntracked(fn);
  else fn();
}

export function openProject(
  rootStore: RootStoreType,
  snapshot: ProjectSnapshotOut,
  requestedPageId: string | null | undefined,
  /** The site version the loader read together with `snapshot`. */
  serverVersion: number,
): OpenedProject {
  const previousProjectId = rootStore.editorUI.currentProject?.id;
  const existing = rootStore.projectStore.getProject(snapshot.id) as ProjectModelType | undefined;
  const serverContent = versionContent(snapshot);
  const baseline = baselines.get(snapshot.id);

  let keep = false;
  // A working copy given up on purpose is never kept.
  const discarded = discardedCopies.delete(snapshot.id);
  let ownWrite = false;
  let staleRead = false;
  let changedElsewhere = false;
  let changedDefinitions: string[] = [];
  let changedSite: SitePart[] = [];
  if (existing && !discarded) {
    const working = getSnapshot(existing);
    const workingContent = versionContent(working);
    // An erase of personal data moves the epoch, and this tab's copy may still
    // hold the erased value anywhere (also in parts not compared here), so it
    // counts as a change on the server: an untouched tab takes the server copy,
    // and one with unsaved work is warned (its save is refused with an older epoch).
    const erasedSince = (snapshot.metadata?.erasureEpoch ?? 0) > (working.metadata?.erasureEpoch ?? 0);
    // Any write the server numbered since this tab's copy (also one that left the
    // compared parts as they were, such as the site's description) is a change.
    const known = knownVersions.get(snapshot.id);
    // Versions only go up: a lower one is an old read, never news.
    staleRead = known !== undefined && serverVersion < known;
    const versionMoved = known !== undefined && known !== serverVersion;
    const serverChanged =
      erasedSince || versionMoved || (baseline !== undefined && !sameVersion(serverContent, baseline));
    // Every part a save writes counts (also legal details, sharing texts, the
    // language, the analytics binding, the description), not only the parts
    // compared with the server: a load must never drop an unsaved edit of them.
    const workingChanged = baseline === undefined || !sameVersion(workingContent, baseline) || !isSaved(snapshot.id, working);
    // This tab's own write is out: what the load read may be that write. Keep
    // the work and the version as they are; the write's answer sets the new
    // version, and if someone else wrote instead, that answer is the 409.
    ownWrite = (writesInFlight.get(snapshot.id) ?? 0) > 0 && !erasedSince;
    if (staleRead && !erasedSince) keep = true; // an old read: this tab's copy and number stand
    else if (ownWrite || !serverChanged) keep = true; // nothing new on the server: keep this tab's work
    else if (workingChanged) {
      keep = true; // both changed: keep the work here, warn before a save
      changedElsewhere = true;
      // A definition deleted over there is only named by this tab's copy.
      // Compared with this tab's baseline; without one (only an erase tells the
      // versions apart) nothing more specific can be named.
      if (baseline !== undefined) {
        changedDefinitions = changedDefinitionIds(baseline, serverContent)
          .map((id) => definitionName(snapshot.components, id) ?? definitionName(working.components, id) ?? id)
          .sort((a, b) => a.localeCompare(b));
        changedSite = changedSiteParts(baseline, serverContent);
      }
    }
  }

  let project: ProjectModelType | undefined;
  if (keep && existing) {
    project = existing;
    const serverName = snapshot.metadata?.title;
    if (!staleRead && typeof serverName === 'string' && serverName !== existing.metadata.title) {
      applyingServer(() => existing.updateMetadata({ title: serverName }));
    }
    // Nothing new on the server: this copy is based on the server's version. When
    // the server DID change, the old number stays, so its next save gets the 409.
    if (ownWrite || staleRead) {
      // Neither adopted nor flagged: the write in flight decides, or the read was old.
    } else if (!changedElsewhere) knownVersions.set(snapshot.id, serverVersion);
    else openedChangedElsewhere.set(snapshot.id, serverVersion);
  } else {
    let id = snapshot.id;
    applyingServer(() => {
      id = rootStore.projectStore.ingestProjectSnapshot(snapshot);
    });
    project = rootStore.projectStore.getProject(id) as ProjectModelType | undefined;
    markServerVersion(snapshot.id, snapshot, serverVersion);
    // What autosave compares with is the copy as the store holds it (with the
    // defaults and repairs the model adds on the way in), so opening a project
    // never reads as a change.
    if (project) savedKeys.set(snapshot.id, savedContentKey(getSnapshot(project)));
  }

  rootStore.editorUI.setCurrentProject(project);
  const { page, missingPageId } = pickPage(project, requestedPageId);
  rootStore.editorUI.setCurrentPage(page);
  // One project's undo steps never apply to another, and a (re)load is not
  // something to undo.
  if (!keep || previousProjectId !== project?.id) getHistoryStore()?.clear();
  return {
    project,
    page,
    missingPageId,
    keptWorkingCopy: keep,
    changedElsewhere,
    changedDefinitions,
    changedSiteParts: changedSite,
  };
}

/**
 * Measurement only (src/lib/projects/__tests__/adoption.perf.test.ts): told how
 * long each phase of an adoption took, in milliseconds. Unset in the editor, where
 * the phases cost one comparison each.
 */
export type AdoptionProfiler = (phase: string, ms: number) => void;
let adoptionProfiler: AdoptionProfiler | undefined;

export function setAdoptionProfilerForTests(profiler: AdoptionProfiler | undefined): void {
  adoptionProfiler = profiler;
}

function timed<T>(phase: string, fn: () => T): T {
  if (!adoptionProfiler) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    adoptionProfiler(phase, performance.now() - start);
  }
}

/** What an adoption changed, for presence and the reveal (later slices). */
export interface AdoptedVersion {
  /** Node ids in the adopted copy that the copy before did not have, in document order. */
  created: string[];
  /** Node ids in both whose own content (not their children) changed. */
  changed: string[];
  /** False when the adopted copy equalled the store's (nothing to undo). */
  recorded: boolean;
}

/** Each node of a project's pages by id, as its snapshot object, in document order. */
function nodesById(project: { pages?: unknown }): Map<string, Record<string, unknown>> {
  const nodes = new Map<string, Record<string, unknown>>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const own = node as { id?: unknown; children?: unknown };
    if (typeof own.id === 'string') nodes.set(own.id, node as Record<string, unknown>);
    if (Array.isArray(own.children)) for (const child of own.children) visit(child);
  };
  for (const page of Object.values((project.pages ?? {}) as Record<string, { appComponentTree?: unknown; canvasNodes?: unknown }>)) {
    visit(page?.appComponentTree);
    for (const node of Object.values((page?.canvasNodes ?? {}) as Record<string, unknown>)) visit(node);
  }
  return nodes;
}

/** A node's own content (its children by id only), for telling a changed node from one whose descendant changed. */
function ownKey(node: Record<string, unknown>): string {
  const { children, ...own } = node;
  const kids = Array.isArray(children) ? children : [];
  return stableJson({ ...own, children: kids.map((child) => (child as { id?: unknown })?.id) });
}

/**
 * The nodes created and changed between two snapshots of a project. The adoption
 * keeps every unchanged node's snapshot object (structural sharing), so only
 * nodes whose object differs are serialised to compare their own content.
 */
function nodeChanges(before: { pages?: unknown }, after: { pages?: unknown }): { created: string[]; changed: string[] } {
  const old = nodesById(before);
  const created: string[] = [];
  const changed: string[] = [];
  for (const [id, node] of nodesById(after)) {
    const prev = old.get(id);
    if (!prev) created.push(id);
    else if (prev !== node && ownKey(prev) !== ownKey(node)) changed.push(id);
  }
  return { created, changed };
}

/**
 * Adopt a newer server copy into the open project while the editor stays open
 * (plan docs/plans/2026-11-08-live-agent-canvas.md, section 1): an agent's or
 * another person's write, heard on the site's live stream. Never the load path
 * above: a load clears the undo history and is no undo step, while an adoption
 * keeps the history and adds exactly one entry, labelled by `label`, so undoing
 * past it restores this tab's copy from before (and autosave then writes that,
 * on the adopted version: the person has the last word).
 *
 * What it borrows from the load path is the bookkeeping: it runs as a server
 * copy being put in place (autosave sees no edit to save), and the saved
 * baseline and the known version move to the adopted copy at the same moment,
 * so the next save of this tab is not refused against a write it already holds.
 *
 * The caller decides WHEN: only while the working copy is saved and no write
 * of this tab is out, or when the person chose "Load the newer version" (their
 * unsaved edits are dropped, as the dialog says). The reconcile goes through
 * the project's identifiers, so unchanged nodes keep their identity: the
 * selection, the open page and the panels survive. Answers null for a copy not
 * newer than the version this tab knows (versions only go up), or a project
 * that is not in the store.
 */
export function adoptServerCopy(
  rootStore: RootStoreType,
  snapshot: ProjectSnapshotOut,
  version: number,
  label: string,
): AdoptedVersion | null {
  const known = knownVersions.get(snapshot.id);
  if (known !== undefined && version <= known) return null;
  const existing = rootStore.projectStore.getProject(snapshot.id) as ProjectModelType | undefined;
  if (!existing) return null;
  // One MobX batch for the whole adoption (LiveSync already runs it in one; a
  // direct call gets its own): inside a batch every node's snapshot is computed
  // once and stays the same object, so the reconcile skips each subtree the
  // shared copy hands back unchanged (MobX-State-Tree compares a node's current
  // snapshot with the incoming one by reference first).
  return runInAction(() => adoptObserved(rootStore, existing, snapshot, version, label));
}

function adoptObserved(
  rootStore: RootStoreType,
  existing: ProjectModelType,
  snapshot: ProjectSnapshotOut,
  version: number,
  label: string,
): AdoptedVersion {
  const beforeSnapshot = getSnapshot(existing);
  const history = getHistoryStore();
  // An erasure of personal data since this copy: undoing past it would put the
  // erased values back on screen (and a save of them is refused anyway). It is
  // adopted like a load: no undo step, and the steps before it go too.
  const erasedSince = (snapshot.metadata?.erasureEpoch ?? 0) > (beforeSnapshot.metadata?.erasureEpoch ?? 0);
  let recorded = false;
  applyingServerCopy++;
  try {
    // The open copy's own objects wherever the content is unchanged: the reconcile
    // then patches only what the writer changed (src/lib/projects/structuralSharing.ts).
    const shared = timed('share', () => shareUnchanged(beforeSnapshot, snapshot));
    const put = () => {
      timed('ingest', () => rootStore.projectStore.adoptProjectSnapshot(shared, beforeSnapshot as never));
    };
    if (history && erasedSince) {
      history.runUntracked(put);
      history.clear();
    } else if (history) recorded = timed('applyRemote', () => history.applyRemote(label, put));
    else put();
  } finally {
    applyingServerCopy--;
  }
  const project = rootStore.projectStore.getProject(snapshot.id) as ProjectModelType | undefined;
  const afterSnapshot = project ? getSnapshot(project) : undefined;
  // A reconcile can emit patches that change nothing (a value replaced by an
  // equal one): a version with this tab's content is no step to undo. Every
  // unchanged part is the same object, so this walk serialises nothing.
  if (recorded && afterSnapshot && timed('noopCompare', () => shareUnchanged(beforeSnapshot, afterSnapshot) === beforeSnapshot)) {
    history?.forgetLastEntry();
    recorded = false;
  }
  timed('markServerVersion', () => markServerVersion(snapshot.id, snapshot, version));
  discardedCopies.delete(snapshot.id);
  // As on a load: what autosave compares with is the copy as the store holds it.
  if (afterSnapshot) timed('savedKey', () => savedKeys.set(snapshot.id, savedContentKey(afterSnapshot)));
  // The page on screen may be gone (deleted over there): show another one.
  if (project && rootStore.editorUI.currentProject?.id === project.id && !rootStore.editorUI.currentPage) {
    rootStore.editorUI.setCurrentPage(pickPage(project, null).page);
  }
  const { created, changed } = afterSnapshot
    ? timed('nodeChanges', () => nodeChanges(beforeSnapshot, afterSnapshot))
    : { created: [], changed: [] };
  return { created, changed, recorded };
}

/** `?page=` of the current address (client only; null on the server). */
export function pageIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('page');
}

/**
 * Bring back a demo project stashed in this tab (src/lib/projects/demoStash.ts).
 * A stash that is not a valid project is dropped. Returns true when restored.
 */
export function restoreStashedDemo(rootStore: RootStoreType, requestedPageId: string | null): boolean {
  const stash = takeStashedDemoProject();
  const stashed = stash?.snapshot;
  if (!stashed || typeof stashed !== 'object' || typeof (stashed as { id?: unknown }).id !== 'string') return false;
  try {
    let id = (stashed as { id: string }).id;
    untracked(() => {
      id = rootStore.projectStore.ingestProjectSnapshot(stashed as ProjectSnapshotOut);
    });
    const project = rootStore.projectStore.getProject(id);
    if (!project) return false;
    rootStore.editorUI.setCurrentProject(project);
    // The page from the address, else the page that was open when it was stashed.
    rootStore.editorUI.setCurrentPage(pickPage(project, requestedPageId ?? stash?.pageId).page);
    rootStore.editorUI.markUnsavedDemo(id);
    return true;
  } catch (err) {
    console.error('[editor] the stashed demo project could not be restored:', err);
    return false;
  }
}
