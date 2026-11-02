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
// written back by a Save overwrites a change made elsewhere on every page):
//   - the baseline: what this tab last loaded from, or saved to, the server;
//   - the server copy just loaded;
//   - the working copy in the store.
// Server unchanged since the baseline: keep the working copy. Server changed
// (saved in another tab, by someone else) and the working copy unchanged:
// take the server copy. Both changed: keep the working copy and report a
// conflict, so the editor can warn before a Save overwrites the other work.
// The name always follows the server (the rename action owns it).
//
// The version lock rides along: the server numbers every write of the working
// copy, and this tab remembers the number of the copy it last loaded or saved.
// Save and Publish send it as `expectedVersion`, and a server that moved on
// refuses them with 409 `site_changed` (SiteChangedDialog asks what to do). A
// moved number counts as a change on the server here too, so an untouched tab
// takes the newer copy, and a tab that keeps its own unsaved work keeps its OLD
// number: its next Save must be refused, never silently win.
//
// Undo history belongs to one project: it is cleared whenever the project
// shown changes or is (re)loaded, and loading itself is never an undo step.
//
// The page comes from `?page=<pageId>` when that page exists, else the home
// page (empty slug), else the first page; `missingPageId` reports a requested
// page that does not exist here (typically never saved, after a reload).

import { getSnapshot } from 'mobx-state-tree';
import type { ProjectSnapshotOut, ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import type { RootStoreType } from '@/stores/RootStore';
import { getHistoryStore } from '@/stores/RootStore';
import { takeStashedDemoProject } from '@/lib/projects/demoStash';
import { withDefaultViewports } from '@/lib/canvas/defaultViewports';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import { pageWithShopParts } from '@/lib/commerce/parts';

export interface OpenedProject {
  project: ProjectModelType | undefined;
  page: PageModelType | undefined;
  /** The requested page id when no such page exists in the project. */
  missingPageId?: string;
  /** True when the in-memory working copy was kept instead of the snapshot. */
  keptWorkingCopy: boolean;
  /**
   * True when the project was changed elsewhere since this tab loaded or
   * saved it, while this tab has unsaved changes too: a Save here would
   * overwrite the other work.
   */
  changedElsewhere: boolean;
  /**
   * The names of the reusable components changed elsewhere, when
   * `changedElsewhere`: a Save here would put the old ones back on every page
   * placing them, which a person cannot see by looking at the page in hand.
   */
  changedDefinitions: string[];
  /**
   * The site-wide parts changed elsewhere, when `changedElsewhere`: the theme and the
   * site's head items, which a Save here would put back as this tab holds them.
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
  const definitions = Object.entries((components ?? {}) as Record<string, unknown>);
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
// project id -> the site version (sites.version) of that same server copy.
const knownVersions = new Map<string, number>();

/**
 * Record that the server now holds exactly this project, at this site version
 * (after a load, a save or a publish).
 */
export function markServerVersion(projectId: string, project: ProjectContent, version: number): void {
  baselines.set(projectId, versionContent(project));
  knownVersions.set(projectId, version);
}

/**
 * The site version this tab's copy is based on: what Save and Publish send as
 * `expectedVersion`. Undefined when this tab never loaded the project from the
 * server (the server then refuses the write with `version_required`).
 */
export function knownServerVersion(projectId: string): number | undefined {
  return knownVersions.get(projectId);
}

/** The warning for `changedElsewhere`, naming the components and site parts a Save would overwrite. */
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
  let changedElsewhere = false;
  let changedDefinitions: string[] = [];
  let changedSite: SitePart[] = [];
  if (existing) {
    const working = getSnapshot(existing);
    const workingContent = versionContent(working);
    // An erase of personal data moves the epoch, and this tab's copy may still
    // hold the erased value anywhere (also in parts not compared here), so it
    // counts as a change on the server: an untouched tab takes the server copy,
    // and one with unsaved work is warned (its Save is refused with an older epoch).
    const erasedSince = (snapshot.metadata?.erasureEpoch ?? 0) > (working.metadata?.erasureEpoch ?? 0);
    // Any write the server numbered since this tab's copy (also one that left the
    // compared parts as they were, such as the site's description) is a change.
    const known = knownVersions.get(snapshot.id);
    const versionMoved = known !== undefined && known !== serverVersion;
    const serverChanged =
      erasedSince || versionMoved || (baseline !== undefined && !sameVersion(serverContent, baseline));
    const workingChanged = baseline === undefined || !sameVersion(workingContent, baseline);
    if (!serverChanged) keep = true; // nothing new on the server: keep this tab's work
    else if (workingChanged) {
      keep = true; // both changed: keep the work here, warn before a Save
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
    if (typeof serverName === 'string' && serverName !== existing.metadata.title) {
      untracked(() => existing.updateMetadata({ title: serverName }));
    }
    // Nothing new on the server: this copy is based on the server's version. When
    // the server DID change, the old number stays, so a Save gets the 409.
    if (!changedElsewhere) knownVersions.set(snapshot.id, serverVersion);
  } else {
    let id = snapshot.id;
    untracked(() => {
      id = rootStore.projectStore.ingestProjectSnapshot(snapshot);
    });
    project = rootStore.projectStore.getProject(id) as ProjectModelType | undefined;
    markServerVersion(snapshot.id, snapshot, serverVersion);
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
