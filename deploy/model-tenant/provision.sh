#!/usr/bin/env bash
# Provision (or check) the dedicated Storage Brain service tenant for customers' 3D models.
#
# Decision D3 (Marlin, 2026-11-14): 50 GB quota, alert at 80 percent, per-site caps unchanged.
# Decision D2 (2026-11-12): a dedicated per-app tenant, reached with an Auth Brain key carrying the `storage` grant.
#
# This script NEVER prints a secret. Run it only through the secrets proxy (execute_with_secrets), so the admin key is
# injected server-side and output is redacted. Subcommands:
#   plan    (default) prints what would be created, touches nothing, needs no secret
#   apply   creates the tenant if absent, then discards the legacy key (see below). Idempotent: a second run changes nothing
#   status  prints used bytes, quota bytes and percent for the tenant; exits 3 at or above the alert threshold
#
# Required environment for apply and status (never printed):
#   STORAGE_BRAIN_ADMIN_KEY   Storage Brain's admin key
#   STORAGE_BRAIN_URL         base address, no trailing slash
# Required for apply:
#   AUTH_BRAIN_TENANT_ID      the Auth Brain company the service key is minted for (binds the tenant to it)
set -euo pipefail

NAME="framer-site-models"
QUOTA_BYTES=50000000000        # 50 GB, decimal, the unit R2 bills in
ALERT_PERCENT=80
TYPES='["model/gltf-binary","model/gltf+json"]'

cmd="${1:-plan}"

if [ "$cmd" = "plan" ]; then
  echo "tenant name:        $NAME"
  echo "quota bytes:        $QUOTA_BYTES (50 GB)"
  echo "allowed file types: $TYPES"
  echo "alert at:           ${ALERT_PERCENT} percent (status exits 3)"
  echo "binds to:           the Auth Brain company in AUTH_BRAIN_TENANT_ID (apply refuses to run without it)"
  echo "nothing was created"
  exit 0
fi

: "${STORAGE_BRAIN_ADMIN_KEY:?not set}"
: "${STORAGE_BRAIN_URL:?not set}"
base="${STORAGE_BRAIN_URL%/}/api/v1/admin"

# Every call keeps the key out of argv (a header file on stdin) and the body out of the output.
call() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS --fail-with-body --max-time 30 --proto '=https' -X "$method" -H @- -H 'Content-Type: application/json')
  [ -n "$body" ] && args+=(--data "$body")
  printf 'Authorization: Bearer %s\n' "$STORAGE_BRAIN_ADMIN_KEY" | curl "${args[@]}" "$base$path"
}

find_tenant() { call GET "/tenants?limit=100" | jq -r --arg n "$NAME" '.tenants[] | select(.name == $n) | .id' | head -n 1; }

case "$cmd" in
  apply)
    : "${AUTH_BRAIN_TENANT_ID:?not set}"
    id="$(find_tenant)"
    if [ -n "$id" ]; then
      echo "tenant $NAME already exists ($id); no change"
      exit 0
    fi
    body="$(jq -nc --arg n "$NAME" --argjson q "$QUOTA_BYTES" --argjson t "$TYPES" --arg a "$AUTH_BRAIN_TENANT_ID" \
      '{name:$n, quotaBytes:$q, allowedFileTypes:$t, authTenantId:$a}')"
    # The create answer carries a one-time legacy API key. Keep only the id; the key is dropped here and never stored.
    id="$(call POST /tenants "$body" | jq -r '.id')"
    [ -n "$id" ] && [ "$id" != "null" ] || { echo "create returned no id" >&2; exit 1; }
    # Replace the legacy key with one nobody has seen, so the tenant is reachable only through Auth Brain.
    call POST "/tenants/$id/regenerate-key" >/dev/null
    echo "created tenant $NAME ($id), quota $QUOTA_BYTES bytes, legacy key discarded"
    ;;
  status)
    id="$(find_tenant)"
    [ -n "$id" ] || { echo "tenant $NAME not found" >&2; exit 1; }
    q="$(call GET "/tenants/$id/quota")"
    echo "$q" | jq -r '"used \(.usedBytes) of \(.quotaBytes) bytes, \(.usagePercent) percent"'
    pct="$(echo "$q" | jq -r '.usagePercent')"
    [ "$pct" -lt "$ALERT_PERCENT" ] || { echo "at or above the ${ALERT_PERCENT} percent alert threshold" >&2; exit 3; }
    ;;
  *) echo "usage: $0 [plan|apply|status]" >&2; exit 2 ;;
esac
