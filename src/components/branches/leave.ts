// src/components/branches/leave.ts
//
// Before the editor goes to another branch (or main) it saves this tab's work: a branch's address is its own
// site, so leaving with unsaved changes would leave them behind. Answers false when the work could not be saved
// (the save status then says why), and the caller stays.

import { existingAutosave } from '@/lib/projects/autosave';

export async function savedBeforeLeaving(siteId: string): Promise<boolean> {
  const autosave = existingAutosave(siteId);
  if (!autosave) return true;
  await autosave.flush();
  return !autosave.hasUnsavedWork();
}

/** Open another site's editor. A full navigation: each site's editor is its own store, history and stream. */
export function openSite(siteId: string): void {
  window.location.assign(`/projects/${encodeURIComponent(siteId)}`);
}
