// src/server/sites/branches/switch.ts
//
// The per-company switch for site branches (plan docs/plans/2026-11-10-site-branches.md, section 9). The
// repository has no feature flag mechanism, so this is the smallest one: a server-side environment variable,
// read here and nowhere else.
//
//   SITE_BRANCHES_COMPANIES   unset or empty: off for everyone (the default)
//                             `*`: on for every company
//                             a comma separated list of auth-brain company ids: on for those
//
// Off hides the branch switcher and answers the branch routes and MCP tools with 404. It gates only what a
// person or an agent can START: the guards that keep a branch unpublishable, out of the site listings, its
// images on main and its copies inside an erase of personal data hold with the switch off, so turning it off
// never fails open. Turning it off later hides branches without deleting them.

/** Whether site branches are on for `companyId` (the session's active company, or the site's own). */
export function siteBranchesEnabled(companyId: string | null | undefined, raw: string | undefined = process.env.SITE_BRANCHES_COMPANIES): boolean {
  if (!companyId || !raw) return false;
  const entries = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return entries.includes('*') || entries.includes(companyId);
}
