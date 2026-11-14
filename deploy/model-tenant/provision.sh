#!/usr/bin/env bash
# Provision the dedicated Storage Brain service tenant for customers' 3D models, and its Auth Brain service key.
#
# Decisions: D2 (a dedicated per-app tenant, reached by an Auth Brain key with the `storage` grant, on the Lumitra
# company; 2026-11-12 and 2026-11-14) and D3 (50 GB quota, alert at 80 percent; 2026-11-14).
#
# WHY A WORKSPACE, NOT THE COMPANY: Storage Brain maps a company-scoped key to ONE tenant (auth_tenant_id is unique) and a
# workspace-scoped key to the tenant bound to that workspace (middleware/auth.ts). Binding this tenant to the whole Lumitra
# company would make every Lumitra company key resolve here and would claim the company's single slot. The company
# carries the `storage` grant and a workspace inherits it, so the tenant is bound to its own workspace `site-models` of
# the company: one credential, one tenant, nothing else reaches it (blast-radius isolation per app, as D2 intends).
#
# THIS SCRIPT NEVER PRINTS A SECRET. Run it only through the secrets proxy, which injects the secrets of ONE Infisical
# project per call, so the steps are split by which project holds the admin key they need. Every step is idempotent.
# It is tested against fake services (src/server/models/__tests__/provisionTenant.test.ts); do not change it without
# running that test.
#
#   plan            prints the plan, touches nothing, needs no secret
#   resolve-company [Auth Brain project] finds the company by slug and keeps its id in the state directory (never printed)
#   ensure-workspace [Auth Brain project] finds or creates the company's workspace `site-models`, keeps its id
#   grant-storage   [Auth Brain project] grants the `storage` app to the company if it lacks it (idempotent, reversible)
#   create-tenant   [Storage Brain project] creates the tenant bound to that workspace, then discards its legacy key
#   mint-key        [Auth Brain project] creates the workspace-scoped service account and its key; the key goes only to
#                   $CAPTURE_DIR/STORAGE_BRAIN_API_KEY, which the proxy stores in Infisical (declared as a capture)
#   verify-key      [framer-clone project] uses the stored key: it must resolve to this tenant with the decided quota
#   status          [Storage Brain project] used and quota bytes; exits 3 at or above the alert threshold
#
# Environment (values never printed):
#   resolve-company: ADMIN_API_KEY, AUTH_BRAIN_URL, COMPANY_SLUG (default lumitra-core)
#   create-tenant:   STORAGE_BRAIN_ADMIN_KEY, STORAGE_BRAIN_URL
#   ensure-workspace: ADMIN_API_KEY, AUTH_BRAIN_URL, ACTOR_EMAIL (the person the audit trail names; an existing Auth Brain user).
#                    SIDE EFFECT of Auth Brain's workspace creation: that person becomes admin member of the new workspace
#                    (revoke it through the memberships route if nobody should hold standing access)
#   grant-storage:   ADMIN_API_KEY, AUTH_BRAIN_URL, ACTOR_EMAIL
#   mint-key:        ADMIN_API_KEY, AUTH_BRAIN_URL, ACTOR_EMAIL, CAPTURE_DIR
#   verify-key:      STORAGE_BRAIN_API_KEY, STORAGE_BRAIN_URL
#   status:          STORAGE_BRAIN_ADMIN_KEY, STORAGE_BRAIN_URL
#   all:             STATE_DIR (default $SECRETS_SCRATCH_DIR) holds the company id between calls
# Plain http is accepted only for a loopback address (the fake services in the test).
set -euo pipefail
umask 077

NAME="framer-site-models"
QUOTA_BYTES=50000000000        # 50 GB, decimal, the unit R2 bills in
ALERT_PERCENT=80
TYPES='["model/gltf-binary","model/gltf+json"]'
KEY_ROLE="member"              # Storage Brain checks the key's storage grant, not its role: least privilege
COMPANY_SLUG="${COMPANY_SLUG:-lumitra-core}"
WORKSPACE_SLUG="site-models"
STATE_DIR="${STATE_DIR:-${SECRETS_SCRATCH_DIR:-}}"

cmd="${1:-plan}"; shift || true

fail() { echo "$*" >&2; exit "${2:-1}"; }

proto_for() { # url -> curl --proto value
  case "$1" in
    http://127.0.0.1:*|http://127.0.0.1/*|http://localhost:*|http://localhost/*) echo '=http' ;;
    https://*) echo '=https' ;;
    *) fail "refusing a non-https address" 2 ;;
  esac
}

# One authenticated call. The bearer key travels in a header file on stdin (never argv, never output); the body is
# printed to stdout for the caller to parse; a failure prints the status code only (never the response body).
api() { # key base method path [json-body]
  local key="$1" base="$2" method="$3" path="$4" body="${5:-}" out code proto
  proto="$(proto_for "$base")" || return 2
  local args=(-sS --max-time 30 --proto "$proto" -o - -w '\n%{http_code}' -X "$method" -H @- -H 'Content-Type: application/json')
  [ -n "$body" ] && args+=(--data "$body")
  # return, not exit: a caller may handle the failure (`|| fail ... 4`) and a function exit would end the whole script.
  out="$(printf 'Authorization: Bearer %s\n' "$key" | curl "${args[@]}" "${base%/}$path")" || { echo "request failed: $method $path (no response)" >&2; return 1; }
  code="${out##*$'\n'}"
  case "$code" in 2??) printf '%s' "${out%$'\n'*}" ;; *) echo "request failed: $method $path answered $code" >&2; return 1 ;; esac
}

state_file() { [ -n "$STATE_DIR" ] || fail "STATE_DIR is not set" 2; echo "$STATE_DIR/model-tenant-company-id"; }
keep() { local f; f="$(state_file)"; printf '%s' "$2" > "${f%-company-id}-$1-id"; }

kept() { # name -> the id a previous step kept (never printed to a log)
  local f; f="$(state_file)"; f="${f%-company-id}-$1-id"
  [ -s "$f" ] || fail "no $1 id: run the earlier step first" 2
  cat "$f"
}
company_id() { kept company; }
workspace_id() { kept workspace; }
has_storage_grant() { # company id -> exit 0 when the company carries the storage app grant
  local g; g="$(api "$ADMIN_API_KEY" "$AUTH_BRAIN_URL" GET "/api/admin/machine/app-grants?tenant_id=$1")" || fail "could not read the app grants" 1
  # The per-company answer is {tenant_id, app_grants: [slug, ...]} (app-grants/route.ts), not an items list.
  printf '%s' "$g" | jq -e '(.app_grants // []) | index("storage") != null' >/dev/null
}

case "$cmd" in
  plan)
    echo "storage grant:      the storage app on that company, added only if absent"
    echo "auth workspace:     $WORKSPACE_SLUG, under the company with slug $COMPANY_SLUG (created only if absent); the acting person becomes its admin member"
    echo "storage tenant:     $NAME, quota $QUOTA_BYTES bytes (50 GB), types $TYPES, bound to that workspace"
    echo "auth service key:   service account $NAME at that workspace, role $KEY_ROLE, one key, stored only by the proxy as STORAGE_BRAIN_API_KEY"
    echo "alert at:           ${ALERT_PERCENT} percent (status exits 3)"
    echo "nothing was created"
    ;;

  resolve-company)
    : "${ADMIN_API_KEY:?not set}" "${AUTH_BRAIN_URL:?not set}"
    json="$(api "$ADMIN_API_KEY" "$AUTH_BRAIN_URL" GET "/api/admin/machine/tenants?limit=100&query=$COMPANY_SLUG")"
    [ "$(printf '%s' "$json" | jq -r '.next_cursor // empty')" = "" ] || fail "company list is paged: refusing to guess" 1
    ids="$(printf '%s' "$json" | jq -r --arg s "$COMPANY_SLUG" '[.items[]? | select(.slug == $s) | .id] | .[]')"
    [ "$(printf '%s\n' "$ids" | grep -c .)" -eq 1 ] || fail "company slug $COMPANY_SLUG matched no company or more than one" 1
    keep company "$ids"
    echo "resolved company $COMPANY_SLUG (id kept for the next step)"
    ;;

  grant-storage)
    : "${ADMIN_API_KEY:?not set}" "${AUTH_BRAIN_URL:?not set}" "${ACTOR_EMAIL:?not set}"
    cid="$(company_id)"
    if has_storage_grant "$cid"; then echo "company already carries the storage grant; no change"; exit 0; fi
    body="$(jq -nc --arg e "$ACTOR_EMAIL" --arg c "$cid" '{actor_email:$e, app_slug:"storage", tenant_id:$c}')"
    api "$ADMIN_API_KEY" "$AUTH_BRAIN_URL" POST /api/admin/machine/app-grants "$body" >/dev/null
    has_storage_grant "$cid" || fail "the grant was written but is not listed" 1
    echo "granted the storage app to company $COMPANY_SLUG"
    ;;

  ensure-workspace)
    : "${ADMIN_API_KEY:?not set}" "${AUTH_BRAIN_URL:?not set}" "${ACTOR_EMAIL:?not set}"
    cid="$(company_id)"
    json="$(api "$ADMIN_API_KEY" "$AUTH_BRAIN_URL" GET "/api/admin/machine/workspaces?tenant_id=$cid&limit=200")"
    [ "$(printf '%s' "$json" | jq -r '.next_cursor // empty')" = "" ] || fail "workspace list is paged: refusing to guess whether $WORKSPACE_SLUG exists" 1
    wid="$(printf '%s' "$json" | jq -r --arg s "$WORKSPACE_SLUG" '[.items[]? | select(.slug == $s) | .id] | first // empty')"
    if [ -n "$wid" ]; then
      keep workspace "$wid"; echo "workspace $WORKSPACE_SLUG already exists; no change"; exit 0
    fi
    body="$(jq -nc --arg e "$ACTOR_EMAIL" --arg c "$cid" --arg n "Site models" --arg s "$WORKSPACE_SLUG" '{owner_email:$e, tenant_id:$c, name:$n, slug:$s}')"
    wid="$(api "$ADMIN_API_KEY" "$AUTH_BRAIN_URL" POST /api/admin/machine/workspaces "$body" | jq -r '.workspace.id // empty')"
    [ -n "$wid" ] || fail "workspace create answered without an id" 1
    keep workspace "$wid"
    echo "created workspace $WORKSPACE_SLUG (id kept for the next steps)"
    ;;

  create-tenant)
    : "${STORAGE_BRAIN_ADMIN_KEY:?not set}" "${STORAGE_BRAIN_URL:?not set}"
    base="${STORAGE_BRAIN_URL%/}/api/v1/admin"
    wid="$(workspace_id)"
    list="$(api "$STORAGE_BRAIN_ADMIN_KEY" "$base" GET "/tenants?limit=100")"
    total="$(printf '%s' "$list" | jq -r '.total // 0')"; shown="$(printf '%s' "$list" | jq -r '.tenants | length')"
    [ "$total" -le "$shown" ] || fail "tenant list is paged ($shown of $total shown): refusing to guess whether the tenant exists" 1
    id="$(printf '%s' "$list" | jq -r --arg n "$NAME" '.tenants[]? | select(.name == $n) | .id' | head -n 1)"
    if [ -n "$id" ]; then
      # The admin API does not show a tenant's binding, so an existing tenant is not re-bound or checked here: verify-key
      # proves the stored key resolves to it. A rerun does rotate the legacy key again (nobody holds it; this closes the
      # gap when an earlier run was cut off between the create and the rotation).
      api "$STORAGE_BRAIN_ADMIN_KEY" "$base" POST "/tenants/$id/regenerate-key" >/dev/null || fail "tenant $NAME exists but its legacy key could not be rotated" 4
      echo "tenant $NAME already exists; legacy key rotated again, nothing else changed (its binding is proven by verify-key)"
      exit 0
    fi
    body="$(jq -nc --arg n "$NAME" --argjson q "$QUOTA_BYTES" --argjson t "$TYPES" --arg a "$wid" '{name:$n, quotaBytes:$q, allowedFileTypes:$t, authWorkspaceId:$a}')"
    # The create answer carries a one-time legacy API key. Only the id is kept; the key is dropped here, never stored.
    created="$(api "$STORAGE_BRAIN_ADMIN_KEY" "$base" POST /tenants "$body")"
    id="$(printf '%s' "$created" | jq -r '.id // empty')"; unset created
    [ -n "$id" ] || fail "create answered without an id: the tenant may exist, run create-tenant again (it rotates the legacy key of an existing tenant)" 4
    # Replace the legacy key with one nobody has seen, so the tenant is reachable only through Auth Brain. If this fails the
    # tenant exists with an unseen legacy key; a second run reports "already exists", so rotate it by hand (see the README).
    api "$STORAGE_BRAIN_ADMIN_KEY" "$base" POST "/tenants/$id/regenerate-key" >/dev/null \
      || fail "tenant $NAME was created but its legacy key was NOT rotated: run the rotation step in the README before anything else" 4
    echo "created tenant $NAME, quota $QUOTA_BYTES bytes, legacy key discarded"
    ;;

  mint-key)
    : "${ADMIN_API_KEY:?not set}" "${AUTH_BRAIN_URL:?not set}" "${ACTOR_EMAIL:?not set}" "${CAPTURE_DIR:?not set}"
    reissue=0; [ "${1:-}" = "--reissue" ] && reissue=1
    wid="$(workspace_id)"
    has_storage_grant "$(company_id)" || fail "the company lacks the storage grant: run grant-storage first (a key minted now would be refused with a 403)" 5
    sas="$(api "$ADMIN_API_KEY" "$AUTH_BRAIN_URL" GET "/api/admin/machine/service-accounts?workspace_id=$wid")"
    sa="$(printf '%s' "$sas" | jq -r --arg n "$NAME" '[.items[]? | select(.name == $n) | .id] | first // empty')"
    if [ -n "$sa" ] && [ "$reissue" -eq 0 ]; then
      fail "service account $NAME already exists, so a key may already exist and a second one is not minted by accident. If the key is lost or the earlier run stopped before the key was stored, run mint-key --reissue (the old key stays valid until revoked in Auth Brain)" 4
    fi
    if [ -z "$sa" ]; then
      body="$(jq -nc --arg e "$ACTOR_EMAIL" --arg c "$wid" --arg n "$NAME" --arg r "$KEY_ROLE" '{actor_email:$e, scope:{workspace_id:$c}, name:$n, role:$r}')"
      sa="$(api "$ADMIN_API_KEY" "$AUTH_BRAIN_URL" POST /api/admin/machine/service-accounts "$body" | jq -r '.service_account_id // empty')"
      [ -n "$sa" ] || fail "service account create answered without an id" 1
    fi
    kbody="$(jq -nc --arg e "$ACTOR_EMAIL" --arg n "$NAME" '{actor_email:$e, name:$n}')"
    issued="$(api "$ADMIN_API_KEY" "$AUTH_BRAIN_URL" POST "/api/admin/machine/service-accounts/$sa/keys" "$kbody")" \
      || fail "the service account exists but no key was issued: run mint-key --reissue" 4
    # First action once the value exists: straight into the capture file, never a variable that is echoed.
    if ! printf '%s' "$issued" | jq -j '.api_key // empty' > "$CAPTURE_DIR/STORAGE_BRAIN_API_KEY"; then
      rm -f "$CAPTURE_DIR/STORAGE_BRAIN_API_KEY"; fail "a key was issued but its answer could not be read: run mint-key --reissue (the unseen key stays valid until revoked in Auth Brain)" 4
    fi
    unset issued
    [ -s "$CAPTURE_DIR/STORAGE_BRAIN_API_KEY" ] || { rm -f "$CAPTURE_DIR/STORAGE_BRAIN_API_KEY"; fail "the key answer carried no api_key: run mint-key --reissue" 4; }
    echo "minted one key for service account $NAME; handed to the proxy's capture, not printed"
    ;;

  verify-key)
    : "${STORAGE_BRAIN_API_KEY:?not set}" "${STORAGE_BRAIN_URL:?not set}"
    base="${STORAGE_BRAIN_URL%/}/api/v1/tenant"
    info="$(api "$STORAGE_BRAIN_API_KEY" "$base" GET /info)" || fail "the stored key does not authenticate (a 403 means the company lacks the storage grant)" 1
    quota="$(api "$STORAGE_BRAIN_API_KEY" "$base" GET /quota)" || fail "the stored key authenticates but the quota call failed" 1
    [ "$(printf '%s' "$info" | jq -r '.name')" = "$NAME" ] || fail "the key resolves to a different tenant: refusing" 1
    [ "$(printf '%s' "$info" | jq -c '.allowedFileTypes | sort')" = "$(printf '%s' "$TYPES" | jq -c 'sort')" ] || fail "the tenant's allowed file types are not the decided ones" 1
    [ "$(printf '%s' "$quota" | jq -r '.quotaBytes')" = "$QUOTA_BYTES" ] || fail "the tenant's quota is not the decided $QUOTA_BYTES bytes" 1
    echo "the stored key resolves to tenant $NAME: quota $QUOTA_BYTES bytes, the decided file types"
    ;;

  status)
    : "${STORAGE_BRAIN_ADMIN_KEY:?not set}" "${STORAGE_BRAIN_URL:?not set}"
    base="${STORAGE_BRAIN_URL%/}/api/v1/admin"
    list="$(api "$STORAGE_BRAIN_ADMIN_KEY" "$base" GET "/tenants?limit=100")"
    id="$(printf '%s' "$list" | jq -r --arg n "$NAME" '.tenants[]? | select(.name == $n) | .id' | head -n 1)"
    [ -n "$id" ] || fail "tenant $NAME not found" 1
    q="$(api "$STORAGE_BRAIN_ADMIN_KEY" "$base" GET "/tenants/$id/quota")"
    printf '%s' "$q" | jq -r '"used \(.usedBytes) of \(.quotaBytes) bytes, \(.usagePercent) percent"'
    [ "$(printf '%s' "$q" | jq -r '.usagePercent')" -lt "$ALERT_PERCENT" ] || fail "at or above the ${ALERT_PERCENT} percent alert threshold" 3
    ;;

  *) fail "usage: $0 [plan|resolve-company|grant-storage|ensure-workspace|create-tenant|mint-key [--reissue]|verify-key|status]" 2 ;;
esac
