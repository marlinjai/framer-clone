// src/stores/openProject.ts
//
// How the editor (/projects/<id>) and Preview (/projects/<id>/preview) put a
// project into the shared in-browser store and pick the page to show.
//
// The store is a module singleton that survives client-side navigation, so
// going Editor -> Preview -> Editor can keep one working copy, including work
// not saved yet (a page just generated with AI). Whether it does is decided by
// comparing three versions of the project's PAGES:
//   - the baseline: what this tab last loaded from, or saved to, the server;
//   - the server copy just loaded;
//   - the working copy in the store.
// Server unchanged since the baseline: keep the working copy. Server changed
// (saved in another tab, by someone else) and the working copy unchanged:
// take the server copy. Both changed: keep the working copy and report a
// conflict, so the editor can warn before a Save overwrites the other work.
// The name always follows the server (the rename action owns it).
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

/** The content compared: every page, as the server would store it. */
function pagesContent(pages: unknown): string {
  const repaired: Record<string, unknown> = {};
  for (const [id, page] of Object.entries((pages ?? {}) as Record<string, object>)) {
    repaired[id] = withDefaultViewports(page as { id?: unknown; canvasNodes?: unknown });
  }
  return stableJson(repaired);
}

// project id -> pages content of the last server version this tab knows.
const baselines = new Map<string, string>();

/** Record that the server now holds exactly these pages (after a load or a save). */
export function markServerVersion(projectId: string, pages: unknown): void {
  baselines.set(projectId, pagesContent(pages));
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
  requestedPageId?: string | null,
): OpenedProject {
  const previousProjectId = rootStore.editorUI.currentProject?.id;
  const existing = rootStore.projectStore.getProject(snapshot.id) as ProjectModelType | undefined;
  const serverContent = pagesContent(snapshot.pages);
  const baseline = baselines.get(snapshot.id);

  let keep = false;
  let changedElsewhere = false;
  if (existing) {
    const workingContent = pagesContent(getSnapshot(existing).pages);
    const serverChanged = baseline !== undefined && serverContent !== baseline;
    const workingChanged = baseline === undefined || workingContent !== baseline;
    if (!serverChanged) keep = true; // nothing new on the server: keep this tab's work
    else if (workingChanged) {
      keep = true; // both changed: keep the work here, warn before a Save
      changedElsewhere = true;
    }
  }

  let project: ProjectModelType | undefined;
  if (keep && existing) {
    project = existing;
    const serverName = snapshot.metadata?.title;
    if (typeof serverName === 'string' && serverName !== existing.metadata.title) {
      untracked(() => existing.updateMetadata({ title: serverName }));
    }
  } else {
    let id = snapshot.id;
    untracked(() => {
      id = rootStore.projectStore.ingestProjectSnapshot(snapshot);
    });
    project = rootStore.projectStore.getProject(id) as ProjectModelType | undefined;
    markServerVersion(snapshot.id, snapshot.pages);
  }

  rootStore.editorUI.setCurrentProject(project);
  const { page, missingPageId } = pickPage(project, requestedPageId);
  rootStore.editorUI.setCurrentPage(page);
  // One project's undo steps never apply to another, and a (re)load is not
  // something to undo.
  if (!keep || previousProjectId !== project?.id) getHistoryStore()?.clear();
  return { project, page, missingPageId, keptWorkingCopy: keep, changedElsewhere };
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
