---
name: cms-app-users-schema-design
track: cms
wave: 2
priority: P1
status: draft
depends_on: [cms-tenant-schema-bootstrap]
estimated_value: 6
estimated_cost: 2
owner: unassigned
---

# `app_users` schema design (documented, not built)

## Goal

Document the per-workspace `app_users` table schema in v1 so Phase 2 builders inherit a settled design instead of negotiating it under deadline pressure. This spec is plan Revision F.7: 1 to 2 hours of design now, trivial Phase 2 migration. The schema is OIDC-shaped from Day 1 (matching auth-brain's enterprise seam #3) so the eventual federation to auth-brain Phase 3.5 OIDC realm is a data move, not a redesign. No code lands. The deliverable is a checked-in markdown design with the SQL DDL, a documented migration path, and the open questions Phase 2 must resolve.

This is a design-only spec. It produces a markdown artifact and a draft SQL file under `migrations/tenant/_phase2_drafts/` that is NOT picked up by the migration runner.

## Scope

**In:**
- Markdown design doc at `cms-brain/docs/phase-2/app-users-schema.md`
- Draft DDL at `cms-brain/migrations/tenant/_phase2_drafts/app_users.sql` (excluded from migration runner glob)
- Schema covers: `id` (uuid), `email`, `email_verified`, `email_verified_at`, `password_hash` (nullable for OAuth-only users), `name`, `picture`, `locale`, `created_at`, `updated_at`, `last_login_at`, `mfa_enabled`, `mfa_secret_encrypted`, `mfa_recovery_codes_hash`, OAuth provider columns reserved (`oauth_provider`, `oauth_subject`)
- Auxiliary tables documented (not built): `app_user_sessions`, `app_user_audit_log`, `app_user_email_verifications`, `app_user_password_resets`
- Migration plan: when Phase 2 ships, runner picks up `0010_init_app_users.sql` (renamed from draft) and applies to all tenant schemas
- Federation plan: when auth-brain Phase 3.5 OIDC realm lands, customers can opt to federate. The `app_users` table becomes the local user store; auth-brain becomes the OIDC IdP. Documented as a flag on `tenant_schemas.federated_oidc: bool`
- Cross-references to plan Revision C (auth timeline correction, 8 to 11 weeks for end-user auth) so future readers know the build is non-trivial

**Out (explicitly deferred):**
- Any code (this is design-only)
- The 8-to-11-week end-user auth build (Phase 2)
- OAuth provider integrations (Phase 2)
- MFA flow (Phase 2 v2)
- Per-customer-app token issuance (separate Phase 2 spec, addressing plan Revision H)
- API endpoints for app_users CRUD (Phase 2)
- Build-vs-buy evaluation (Clerk / Supabase Auth) is open question per handover, separate research session

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `projects/lumitra-infra/cms-brain/docs/phase-2/app-users-schema.md` | new | Design doc |
| `projects/lumitra-infra/cms-brain/migrations/tenant/_phase2_drafts/app_users.sql` | new | Draft DDL, NOT picked up by runner |
| `projects/lumitra-infra/cms-brain/migrations/tenant/_phase2_drafts/README.md` | new | "These migrations are Phase 2 drafts and intentionally excluded from the runner glob." |

## API surface

```ts
// No code. Design only.
// The eventual API surface (Phase 2):
//   POST   /v1/auth/signup
//   POST   /v1/auth/login
//   POST   /v1/auth/logout
//   POST   /v1/auth/verify-email
//   POST   /v1/auth/forgot-password
//   POST   /v1/auth/reset-password
//   GET    /v1/auth/me
//   POST   /v1/auth/refresh
// All scoped to the customer-built app's workspace via the per-customer-app token (plan Revision H).
```

## Data shapes

```sql
-- Phase 2 DDL draft. Lives under tenant_<id> schema.

CREATE TABLE app_users (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                       CITEXT NOT NULL,
  email_verified              BOOLEAN NOT NULL DEFAULT false,
  email_verified_at           TIMESTAMPTZ,
  password_hash               TEXT,                              -- nullable for OAuth-only
  name                        TEXT,
  picture                     TEXT,
  locale                      TEXT,                              -- BCP 47
  oauth_provider              TEXT,                              -- 'google', 'github', etc., null in v1
  oauth_subject               TEXT,
  mfa_enabled                 BOOLEAN NOT NULL DEFAULT false,
  mfa_secret_encrypted        TEXT,
  mfa_recovery_codes_hash     TEXT[],
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at               TIMESTAMPTZ,
  deleted_at                  TIMESTAMPTZ,                       -- soft delete

  CONSTRAINT app_users_email_unique UNIQUE (email),
  CONSTRAINT app_users_oauth_unique UNIQUE (oauth_provider, oauth_subject)
);

CREATE INDEX app_users_email_idx ON app_users (email) WHERE deleted_at IS NULL;
CREATE INDEX app_users_oauth_idx ON app_users (oauth_provider, oauth_subject) WHERE oauth_subject IS NOT NULL;

CREATE TABLE app_user_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,                                 -- never store plaintext
  ip              INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,

  CONSTRAINT app_user_sessions_token_unique UNIQUE (token_hash)
);

CREATE INDEX app_user_sessions_user_idx ON app_user_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX app_user_sessions_token_idx ON app_user_sessions (token_hash);

CREATE TABLE app_user_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES app_users(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,        -- 'login', 'logout', 'password_reset', etc.
  ip              INET,
  user_agent      TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX app_user_audit_user_idx ON app_user_audit_log (user_id, created_at DESC);

CREATE TABLE app_user_email_verifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,

  CONSTRAINT email_verif_token_unique UNIQUE (token_hash)
);

CREATE TABLE app_user_password_resets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,

  CONSTRAINT pw_reset_token_unique UNIQUE (token_hash)
);
```

## Test plan

- [ ] Manual: design doc reviewed by Marlin, sign-off on schema shape
- [ ] Manual: draft DDL is syntactically valid (`psql --dry-run` against a scratch schema)
- [ ] Manual: confirm draft files are excluded from migration-runner glob (write a test for the glob)

## Definition of done

- [ ] Design doc shipped at `cms-brain/docs/phase-2/app-users-schema.md`
- [ ] Draft DDL syntactically valid
- [ ] `_phase2_drafts/` directory excluded from `cms-brain/migrations/tenant/*` glob in `migration-loader.ts`
- [ ] All open questions surfaced in the design doc, NOT silently resolved
- [ ] Status moved to `done` in STATUS.md

## Open questions

- **Build vs buy on end-user auth:** Clerk and Supabase Auth could shortcut the 8 to 11 weeks. Vendor lock-in vs in-house control. Per handover, this needs its own Phase 2 research session before commitment. If "buy" wins, this schema may not ship at all (replaced by vendor identity).
- **Email column case-sensitivity:** `CITEXT` (Postgres extension) vs `TEXT` with normalize-on-write. CITEXT requires `CREATE EXTENSION citext` in each tenant schema, which is annoying. Recommended: TEXT with lowercased-on-write and a unique index on `lower(email)`. Update DDL accordingly.
- **OAuth provider table layout:** subject-per-row table vs columns on `app_users`? If a user can link multiple providers (Google + GitHub), it's a separate table. v1 spec is single-provider. Recommended: separate `app_user_oauth_identities` table from Day 1 to avoid retrofit.
- **`_phase2_drafts/` exclusion:** confirm the migration runner glob in `cms-migration-runner` excludes underscore-prefixed dirs. Add a test.
- **Federation flag location:** `tenant_schemas.federated_oidc` (CMS service knowledge) vs auth-brain's tenant config? Recommended: auth-brain owns the flag, CMS reads it via session claim. Phase 2 detail.
- **Per-customer-app token shape (plan Revision H):** specifically how does the runtime read `app_users` for its bound workspace only? JWT signed by auth-brain with `aud: workspace_id`? Recommended: define in a separate Phase 2 spec, NOT here. This spec is just the schema.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Revisions C, F.7, H; Recommendation paragraph 3)
- Auth-brain spec: `projects/lumitra-infra/auth-brain/docs/superpowers/specs/2026-05-06-auth-brain-design.md` (enterprise seam #3, section 6.1 Phase 3.5 OIDC)
- Open architectural decision: build-vs-buy on end-user auth (handover)
- Memory: `memory/project_strategic_thesis_bubble_killer.md`
