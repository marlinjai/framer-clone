#!/usr/bin/env sh
# framer-clone start sequence, run by entrypoint.sh inside `infisical run`, so
# every secret (DATABASE_URL, COMMERCE_OWNER_DATABASE_URL, ...) is already in the
# environment. Kept separate from the Infisical login so the sequence can be run
# and tested on its own (`docker run --entrypoint ./boot.sh -e ...`).
#
# Order, each step failing the start loudly (set -e, non-zero exit), so Coolify
# marks the deploy failed instead of serving a half-migrated app:
#   0. EDITOR_HOST must be set in production (else exit 1 before migrating).
#   1. Prisma migrations on DATABASE_URL (sites, CMS, data tables).
#   2. Commerce public migrations and the tenant fleet migration, as the OWNER
#      role on COMMERCE_OWNER_DATABASE_URL (commerce_ddl). The script refuses to
#      run as the app role commerce_app. Both are idempotent and advisory-locked,
#      so a rolling deploy with an old container still up is safe.
#   3. The Next.js standalone server. `exec` replaces this shell with node, so
#      no shell sits between node and its parent. On `docker stop`, tini (PID 1)
#      sends SIGTERM to `infisical run`, which forwards it to node and waits;
#      node finishes the requests in flight and exits.
set -e

# 0. Refuse to start a production container without an editor host. With
#    EDITOR_HOST unset or blank every host counts as a published site, the
#    editor included (src/lib/editorHost.ts). Checked before any migration so a
#    misconfigured deploy fails at once. The Next.js server repeats the check
#    (src/instrumentation.ts) for a start that bypasses this script.
if [ "${NODE_ENV:-}" = "production" ] && [ -z "$(printf '%s' "${EDITOR_HOST:-}" | tr -d '[:space:]')" ]; then
  echo "boot: EDITOR_HOST is not set (or is blank) while NODE_ENV=production." >&2
  echo "boot: refusing to start: every host would be treated as a published site, the editor included." >&2
  echo "boot: set EDITOR_HOST to the editor hostname (app.lumitra.co in production), see deploy/README.md." >&2
  exit 1
fi

echo "boot: prisma migrate deploy"
prisma migrate deploy --schema=./prisma/schema.prisma

echo "boot: commerce migrations"
node ./commerce-migrate.cjs

echo "boot: starting server"
exec node server.js
