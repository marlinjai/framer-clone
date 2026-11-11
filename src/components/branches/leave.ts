// src/components/branches/leave.ts
//
// Before the editor goes to another branch (or main) it saves this tab's work: a branch's address is its own
// site, so leaving with unsaved changes would leave them behind. Answers false when the work could not be saved
// (the save status then says why), and the caller stays.

import { abandonWorkingCopy, existingAutosave } from '@/lib/projects/autosave';

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

/**
 * Leave a branch that was just merged or discarded. Its working copy is given up first: the branch holds no
 * content any more, so a save on the way out (or an "unsaved changes" warning) would only meet 410.
 */
export function leaveClosedBranch(branchId: string, mainSiteId: string): void {
  abandonWorkingCopy(branchId);
  openSite(mainSiteId);
}
