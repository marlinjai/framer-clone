// src/lib/projects/tabId.ts
//
// A random id for this editor tab, made once per page load. Every save and
// publish of this tab sends it (`originTab`, src/lib/projects/projectWrite.ts),
// and the site's live stream sends it back with the `site:version` of that write
// (src/lib/projects/liveEvents.ts), so the tab knows the version is its own and
// does not fetch and adopt it again (src/lib/projects/liveSync.ts). It names a
// tab, never a person, and the server trusts it for nothing else.

let id: string | undefined;

function makeId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

/** This tab's id (16 to 32 characters of [A-Za-z0-9]). */
export function editorTabId(): string {
  id ??= makeId();
  return id;
}
