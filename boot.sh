#!/usr/bin/env sh
# framer-clone start sequence, run by entrypoint.sh inside `infisical run`, so
# every secret (DATABASE_URL, COMMERCE_OWNER_DATABASE_URL, ...) is already in the
# environment. Kept separate from the Infisical login so the sequence can be run
# and tested on its own (`docker run --entrypoint ./boot.sh -e ...`).
#
# Order, each step failing the start loudly (set -e, non-zero exit), so Coolify
# marks the deploy failed instead of serving a half-migrated app:
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

echo "boot: prisma migrate deploy"
prisma migrate deploy --schema=./prisma/schema.prisma

echo "boot: commerce migrations"
node ./commerce-migrate.cjs

echo "boot: starting server"
exec node server.js
