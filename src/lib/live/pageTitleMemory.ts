// src/lib/live/pageTitleMemory.ts
//
// The titles of the pages this editor has seen, per open project, so the
// activity feed can name a page an agent deleted ("Deleted the page ‘About’")
// after the page left the open copy. A title is content and never travels on
// the live stream (src/lib/projects/liveEvents.ts): only what this editor saw
// itself is remembered, in memory, for this tab. Keyed by the project's id, so
// an adoption that replaces the project's model keeps what was remembered. A page deleted before this
// editor saw it has no title here, and the feed says "Deleted a page".

const memory = new Map<string, Map<string, string>>();

/** How many titles are kept per project (the most recently seen): enough for every page a feed can name. */
export const PAGE_TITLES_MAX = 500;

interface TitledPage {
  id: string;
  metadata?: { title?: string };
}

/** Remember the current titles of these pages of a project. */
export function rememberPageTitles(project: { id: string }, pages: Iterable<TitledPage>): void {
  let titles = memory.get(project.id);
  if (!titles) {
    titles = new Map();
    memory.set(project.id, titles);
  }
  for (const page of pages) {
    const title = page.metadata?.title;
    // Seen again: it moves to the newest end. A title cleared is forgotten, never shown stale.
    titles.delete(page.id);
    if (typeof title === 'string' && title.trim()) titles.set(page.id, title);
  }
  while (titles.size > PAGE_TITLES_MAX) titles.delete(titles.keys().next().value as string);
}

/** Forget every remembered title (the live sync stopped: another site opened, the editor left). */
export function forgetPageTitles(): void {
  memory.clear();
}

/** The last title this editor saw for a page of a project, if any. */
export function rememberedPageTitle(project: { id: string }, pageId: string): string | undefined {
  return memory.get(project.id)?.get(pageId);
}
