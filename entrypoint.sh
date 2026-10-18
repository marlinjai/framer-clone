#!/usr/bin/env sh
set -e

# framer-clone container entrypoint (Coolify/Hetzner).
#
# Responsibilities:
#   1. Authenticate to Infisical via a Universal Auth machine identity. Coolify
#      provides ONLY three plain env vars on the app:
#        - INFISICAL_UNIVERSAL_AUTH_CLIENT_ID
#        - INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
#        - INFISICAL_PROJECT_ID   (the framer-clone Infisical project id, created
#                                  by Terraform during provisioning)
#      Every other secret (DATABASE_URL, ANTHROPIC_API_KEY, AUTH_BRAIN_URL,
#      ANALYTICS_*, EDITOR_HOST, PUBLIC_SITE_BASE_HOST,
#      COMMERCE_APP_DATABASE_URL, COMMERCE_OWNER_DATABASE_URL, ...) is fetched via
#      `infisical run` at boot, never baked into the image.
#   2. Run boot.sh inside `infisical run`: Prisma migrations, then the commerce
#      public and tenant migrations as the owner role, then the Next.js server.
#      Any failing step fails the boot, so Coolify marks the deploy failed
#      instead of serving a broken app. See boot.sh for the sequence.
#
# HOSTNAME=0.0.0.0 is set in the Dockerfile so the standalone server is reachable
# by Coolify's loopback healthcheck.

DOMAIN="https://infisical.lumitra.co"
ENVIRONMENT="prod"
SECRETS_PATH="/"

# Fail loud on missing wiring rather than booting into a confusing auth error.
if [ -z "$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" ] || [ -z "$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" ]; then
  echo "entrypoint: INFISICAL_UNIVERSAL_AUTH_CLIENT_ID / _SECRET are required (set them on the Coolify app)." >&2
  exit 1
fi
if [ -z "$INFISICAL_PROJECT_ID" ]; then
  echo "entrypoint: INFISICAL_PROJECT_ID is required (the framer-clone Infisical project id)." >&2
  exit 1
fi

# 1. Authenticate with Infisical via Universal Auth (machine identity).
INFISICAL_TOKEN=$(infisical login \
  --method=universal-auth \
  --client-id="$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" \
  --client-secret="$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" \
  --domain "$DOMAIN" \
  --silent --plain)

# Pass the token via the environment, NOT --token: argv is visible to every
# process in the container (ps, /proc/*/cmdline). `env -u` strips it from the
# app process again so it lives only in the infisical wrapper.
export INFISICAL_TOKEN

# 2. Pull all secrets into the environment and hand over to boot.sh, which
# runs the migrations and then execs the Next.js standalone server. `exec`
# replaces this shell with `infisical run`, the direct child of tini (PID 1).
# infisical forwards SIGTERM to node and waits for it to exit, so node can drain.
exec infisical run \
  --env="$ENVIRONMENT" \
  --projectId="$INFISICAL_PROJECT_ID" \
  --path="$SECRETS_PATH" \
  --domain "$DOMAIN" \
  -- env -u INFISICAL_TOKEN ./boot.sh
