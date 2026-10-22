// src/lib/projects/demoStash.ts
//
// A copy of the browser-only demo project (`/`) in this tab's sessionStorage,
// written when the person follows a "Save as a new project" next step that
// leaves the page (sign in again, choose a company), and only then. The demo editor
// restores it on its next mount, so the work (an AI generation, say) is not
// lost on a full-page navigation. Best effort: storage can be unavailable
// (private mode, a full quota), and nothing depends on it.

const KEY = 'framer-clone:demo-project';

export interface DemoStash {
  snapshot: unknown;
  /** The page that was open, to come back to it. */
  pageId?: string;
}

export function stashDemoProject(snapshot: unknown, pageId?: string): void {
  try {
    const stash: DemoStash = { snapshot, pageId };
    window.sessionStorage.setItem(KEY, JSON.stringify(stash));
  } catch {
    // Unavailable or full: the in-memory copy is still there for a soft navigation.
  }
}

/** The stashed demo project, removed from storage as it is taken. */
export function takeStashedDemoProject(): DemoStash | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as Partial<DemoStash> | null;
    if (!parsed || typeof parsed !== 'object' || !('snapshot' in parsed)) return null;
    return { snapshot: parsed.snapshot, pageId: typeof parsed.pageId === 'string' ? parsed.pageId : undefined };
  } catch {
    return null;
  }
}

export function clearStashedDemoProject(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
