// src/lib/live/pageTitleMemory.ts
//
// The titles of the pages this editor has seen, per open project, so the
// activity feed can name a page an agent deleted ("Deleted the page ‘About’")
// after the page left the open copy. A title is content and never travels on
// the live stream (src/lib/projects/liveEvents.ts): only what this editor saw
// itself is remembered, in memory, for this tab. A page deleted before this
// editor saw it has no title here, and the feed says "Deleted a page".

const memory = new WeakMap<object, Map<string, string>>();

interface TitledPage {
  id: string;
  metadata?: { title?: string };
}

/** Remember the current titles of these pages of a project. */
export function rememberPageTitles(project: object, pages: Iterable<TitledPage>): void {
  let titles = memory.get(project);
  if (!titles) {
    titles = new Map();
    memory.set(project, titles);
  }
  for (const page of pages) {
    const title = page.metadata?.title;
    if (typeof title === 'string' && title.trim()) titles.set(page.id, title);
  }
}

/** The last title this editor saw for a page of a project, if any. */
export function rememberedPageTitle(project: object, pageId: string): string | undefined {
  return memory.get(project)?.get(pageId);
}
