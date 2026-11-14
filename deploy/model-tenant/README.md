# Storage Brain tenant for customers' 3D models (provisioned 2026-11-14; nothing enabled)

Plan: `docs/plans/2026-11-02-3d-scene-primitive.md`, decisions D2 (a dedicated per-app tenant, reached by an Auth Brain key with the `storage` grant, on the Lumitra company as Studio does) and D3 (50 GB quota, alert at 80 percent, per-site caps unchanged; Marlin, 2026-11-14).

Nothing here is enabled. Uploads, serving and cleanup routes do not exist, and the flag stays unset everywhere. This folder only makes the credential step safe and repeatable.

## What was done in production (2026-11-14, through the secrets proxy, no value read by anyone)

Run from the committed script (its sha256 compared in the proxy with the tested commit), after 21 fake-service tests, an independent review and the mutation checks below:

1. `resolve-company`: the Lumitra company (slug `lumitra-core`).
2. `grant-storage`: the company did not carry the `storage` app grant (only one other company does), so it was granted (idempotent, reversible with a DELETE on the same machine route). Workspaces inherit it.
3. `ensure-workspace`: workspace `site-models` created under the company. Side effect of Auth Brain's workspace creation: the acting person (the existing Auth Brain user of Marlin's account, found in an earlier authorized machine run and matching the account identity) became its admin member. Kept, since it is Marlin's own company; revoke through the memberships route if nobody should hold standing access.
4. `create-tenant`: Storage Brain tenant `framer-site-models`, 50,000,000,000 bytes, types `model/gltf-binary` and `model/gltf+json`, bound to the workspace, legacy key rotated and never seen.
5. `mint-key`: workspace-scoped service account `framer-site-models` (role `member`) and one key, stored by the proxy's capture in Infisical `framer-clone`, env `prod`, `/`, as `STORAGE_BRAIN_API_KEY` (fingerprint `53a45af858a7`). The key was never printed or placed in a session.
6. `verify-key` with the stored key: resolves to the tenant with the decided quota and both file types.
7. Reruns: `resolve-company`, `grant-storage`, `ensure-workspace` change nothing; `create-tenant` creates nothing and rotates the legacy key again; `mint-key` refuses (exit 4) and writes no capture; `status` reads 0 of 50,000,000,000 bytes, 0 percent, with exactly one tenant of that name.

Two real contract errors were found by this process and fixed before the final run: Storage Brain maps a company key to ONE tenant (`auth_tenant_id` is unique), so the tenant is bound to its own workspace rather than to the company; and Auth Brain's per-company grants list answers `{tenant_id, app_grants: [slugs]}`, which the first draft (and its fake) had wrong. The first `grant-storage` call wrote the grant and then reported it unlisted for that reason; the second run confirmed it.

## What exists

`provision.sh` has the subcommands `plan`, `resolve-company`, `grant-storage`, `ensure-workspace`, `create-tenant`, `mint-key [--reissue]`, `verify-key` and `status`. It never prints a secret, keeps both admin keys out of the command line, accepts plain http only for a loopback address, and every step is idempotent. `src/server/models/__tests__/provisionTenant.test.ts` runs it against fake Storage Brain and Auth Brain services (21 tests: creation, idempotency, wrong company binding, paged tenant lists, wrong admin keys, failed legacy key rotation, failed key issue after the account exists, a key answer without a key, no secret in output or in the arguments passed to curl, the 80 percent exit). Five deliberate mutations of the script (print the create answer, put the key on the command line, drop idempotency, swallow a rotation failure, accept an empty key file) are each caught by the test. Run it after any change to the script.

## Where the credentials are (found by names and proxy authorization only, no value read)

| Need | Infisical project | Name | Checked |
| --- | --- | --- | --- |
| Storage Brain admin key | Storage Brain, `86dcae14-6cb2-473b-8b2d-43b37977f04e`, env `prod` | `STORAGE_BRAIN_ADMIN_KEY` (also `ADMIN_API_KEY`, the service's own) | A read-only tenant listing answered 200 with each, through the proxy |
| Storage Brain address | same project | `STORAGE_BRAIN_URL` | used by the check above |
| Auth Brain admin key and address | Auth Brain, `97c4971e-78c1-4adf-83e1-6c0b5f13375c`, env `prod` | `ADMIN_API_KEY`, `APP_BASE_URL` (the script's `AUTH_BRAIN_URL`) | the company list answered, through the proxy |
| Where the service key lands | `framer-clone`, env `prod`, path `/` | `STORAGE_BRAIN_API_KEY` (new) | not created |

The proxy injects one project's secrets per call, so the steps alternate between the two projects. The Lumitra company is the Auth Brain company with slug `lumitra-core`; `resolve-company` finds its id by slug inside the proxy and keeps it in `$STATE_DIR` (the proxy treats ids as secrets and redacts them, so nobody needs to read it).

## Machine-sourced key minting (found, so no hand-off to Marlin is needed for the value)

Auth Brain's browser route for a company key needs a signed-in session, a CSRF token and a recent re-authentication, which only a person can give. The machine surface does not: with the Auth Brain admin key, `POST /api/admin/machine/service-accounts` creates a tenant-scoped service account and `POST /api/admin/machine/service-accounts/:id/keys` issues its key, returned once. `mint-key` does both, writes the key as its first action to `$CAPTURE_DIR/STORAGE_BRAIN_API_KEY`, and the proxy's `captures` feature stores it at the declared Infisical destination and returns only a fingerprint. The value never enters a session. The role is `member`, the least privilege (Storage Brain checks the key's `storage` grant, not its role). Both machine calls name an acting person for the audit trail (`ACTOR_EMAIL`), which must be an existing Auth Brain user; it is an audit attribution, not a secret, and someone with the authority supplies it.

## Order for a repeat or a new environment (each call through `execute_with_secrets`)

Auth Brain project (`resolve-company`, `grant-storage`, `ensure-workspace`), Storage Brain project (`create-tenant`), Auth Brain project (`mint-key` with `ACTOR_EMAIL`, `AUTH_BRAIN_URL` set to its `APP_BASE_URL`, `CAPTURE_DIR` to `$SECRETS_CAPTURE_DIR`, and a capture declared for `STORAGE_BRAIN_API_KEY` to `framer-clone`, `production`, `/`, overwrite false; nothing after it in that call), then `verify-key` in the `framer-clone` project and `status` in the Storage Brain project. The script is run with `bash`, never `sh`. The state directory (the company and workspace ids) is the proxy's scratch directory, shared across projects. `mint-key` exit 4 means a service account exists; use `--reissue` only if the key was never stored (the old key stays valid until revoked in Auth Brain). `status` exits 3 at 80 percent used.

## Rollback

Delete the tenant with Storage Brain's admin delete only while it holds no files (none until uploads are enabled), delete `STORAGE_BRAIN_API_KEY` from Infisical, revoke the key and delete the service account `framer-site-models` and the workspace `site-models` in Auth Brain, and revoke the `storage` grant on the Lumitra company if nothing else needs it. Before any upload exists nothing else depends on them.

## Still behind the separate release gate

Upload, serving, listing and delete routes, the middleware matcher and `next.config.ts` changes, scheduling the reaper, the reconciler and the quota alert, company erasure wiring, upload rate limiting, a container memory limit, and applying the seventh migration (`20261112300000_site_model_coordination`) with the next authorized deploy.
