// src/server/commerce/provisioning/assignSitesArgs.ts
//
// The command line of `pnpm catalogue:assign-sites` (scripts/catalogue-assign-sites.ts), apart so it is tested.

export interface AssignSitesArgs {
  tenantGroupId: string;
  companyId: string | undefined;
  /** False: a dry run. */
  apply: boolean;
}

/** `<tenant group id> [--company <id>] [--apply]`, in any order; null for anything else. */
export function parseAssignSitesArgs(args: readonly string[]): AssignSitesArgs | null {
  let tenantGroupId: string | undefined;
  let companyId: string | undefined;
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--company') {
      const value = args[++i];
      if (companyId !== undefined || !value || value.startsWith('--')) return null;
      companyId = value;
    } else if (!arg || arg.startsWith('--') || tenantGroupId !== undefined) {
      return null;
    } else {
      tenantGroupId = arg;
    }
  }
  return tenantGroupId ? { tenantGroupId, companyId, apply } : null;
}
