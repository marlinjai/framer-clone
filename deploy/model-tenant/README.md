# Storage Brain tenant for customers' 3D models (prepared, not run)

Plan: `docs/plans/2026-11-02-3d-scene-primitive.md`, decisions D2 (a dedicated per-app tenant, reached by an Auth Brain key with the `storage` grant) and D3 (50 GB quota, alert at 80 percent, per-site caps unchanged; Marlin, 2026-11-14).

Nothing here is enabled. Uploads, serving and cleanup routes do not exist, and the flag stays unset everywhere. This folder only makes the credential step safe and repeatable.

## Steps, in order

1. **Pick the Auth Brain company** that holds the service key (the one whose id goes into `AUTH_BRAIN_TENANT_ID`). It must carry the `storage` app grant. Recommendation: the Lumitra company, as Studio does for its assets. Needs the owner's yes because it binds a credential to a company.
2. **Create the Storage Brain tenant.** Through the secrets proxy (`execute_with_secrets`, so the admin key never enters a session), run `deploy/model-tenant/provision.sh plan` first, then `apply` with `STORAGE_BRAIN_ADMIN_KEY`, `STORAGE_BRAIN_URL` and `AUTH_BRAIN_TENANT_ID` injected. It is idempotent, prints only the tenant id, and discards the legacy key Storage Brain returns at creation, so the tenant is reachable only through Auth Brain.
3. **Mint the service key in Auth Brain** (Settings, Companies, API keys, for the company of step 1). The value is shown once in the browser; the person minting it pastes it straight into Infisical (project `framer-clone`, env `prod`, name `STORAGE_BRAIN_API_KEY`) and never into a chat or a file. Nothing in a session reads it.
4. **Verify without reading.** `provision.sh status` through the proxy (prints used and quota bytes only), then one authenticated listing call from the app's environment answering 200 rather than 401 or 403.
5. **Alert.** `provision.sh status` exits 3 at 80 percent used. Scheduling it belongs to the release gate below.

## Rollback

Delete the tenant with Storage Brain's admin delete only while it holds no files (it holds none until uploads are enabled), remove `STORAGE_BRAIN_API_KEY` from Infisical and revoke the Auth Brain key. Before any upload exists nothing else depends on it.

## Still behind the separate release gate

Upload, serving, listing and delete routes, the middleware matcher and `next.config.ts` changes, scheduling the reaper, the reconciler and the quota alert, company erasure wiring, upload rate limiting, a container memory limit, and applying the seventh migration (`20261112300000_site_model_coordination`) with the next authorized deploy.
