import 'server-only';

// src/server/sites/index.ts
//
// Server barrel for the site-persistence tier (P1b). The import surface for
// editor/API routes that load and save sites. Everything here is server-only
// and React-free; the pure MST <-> persistence mapping (snapshot.ts) is exposed
// too so non-server callers (the editor store) can reuse the same translation.

export {
  SiteRepository,
  getSiteRepository,
  type TenantScope,
  type SiteSummary,
} from './repository';

export {
  SiteRepositoryError,
  SiteNotFoundError,
  SiteNameConflictError,
  InvalidTenantScopeError,
  InvalidPageSlugError,
  siteRepositoryErrorResponse,
} from './errors';

export {
  SITES_APP,
  resolveScopeForWorkspace,
  resolveScopeForCompanyWorkspace,
  resolveActiveScope,
  resolveActiveCompany,
  companyWorkspaceId,
  listCompanyChoices,
  grantedCompaniesWithoutWorkspace,
  sitesGrantedCompanyIds,
  activeScopeDenial,
  type CompanyChoice,
  type CompanySelectors,
  type CompanyResolution,
  type CompanySource,
  type ActiveScopeResult,
  type ScopeResult,
  type ScopeResolutionError,
} from './scope';

// Pure mapping (no server-only dependency) — re-exported for convenience.
export {
  projectToPersisted,
  persistedToProjectSnapshot,
  type PersistedSite,
  type PersistedPage,
  type SiteRowData,
} from './snapshot';
