#!/usr/bin/env bash
# deploy/custom-domains/sync-traefik.sh
#
# Runs ON THE SHARED SERVER (from a hardened systemd unit, every minute), never
# inside the app container. It turns the app's list of verified custom
# hostnames into a Traefik file-provider configuration, so Traefik routes each
# hostname to framer-clone and requests a Let's Encrypt certificate for it
# through the existing HTTP-01 resolver, without a Coolify redeploy per domain.
#
# THE SECURITY BOUNDARY: the app supplies data (hostnames, one per line), this
# script owns the configuration. The script trusts nothing it fetched:
#
#   - the response must be HTTP 200 with content-type text/plain, and its body
#     must match the x-content-sha256 and x-hostname-count headers (a login
#     page, an error page or a truncated body is refused);
#   - EVERY line must be a plain hostname (DNS labels of lowercase letters,
#     digits and inner hyphens, at most 253 characters, at least two labels,
#     an alphabetic or punycode top-level label, not a reserved test or local
#     ending, not under lumitra.co or a BLOCKED_ZONES entry); one bad line
#     refuses the WHOLE feed, since it means the source is not the app's feed;
#   - a large DROP in routes is held back: when the feed has more than
#     DROP_FLOOR (5) fewer routes than the high-water mark AND fewer than half
#     of it, the removals are not applied. The high-water mark is the largest
#     route count written in the last HWM_WINDOW seconds (24 h), kept in
#     $STATE_DIR/high-water, so a slow drip of small drops cannot add up to an
#     outage either. While a drop is held, ADDITIONS still go live: the file
#     gets the union of the current and the new routes, and the script exits 3
#     so the journal shows it. An operator confirms a genuine drop once by
#     creating $STATE_DIR/force-once, which the next run consumes and deletes.
#
# On any refusal of the feed itself the current file stays as it is (the
# routes that work keep working), the reason is logged and the exit code is 1.
# A hostname that passes cannot carry Traefik rule syntax, so the app can never
# write arbitrary proxy configuration: at worst it adds Host() routes to its
# own service, at priority 1 so every router Coolify defines (whose default
# priority is its rule length) wins.
#
# The file is written to a temporary name in the same directory and renamed,
# and only when its content changed. The staged name ends in .tmp on purpose:
# Traefik's file provider only parses .yml, .yaml and .toml, so it never reads
# the half-written file.
#
# Configuration (environment, set in the systemd unit):
#   FEED_URL         https://app.lumitra.co/api/internal/custom-domains/hostnames
#   TOKEN_FILE       file holding exactly: Authorization: Bearer <token>
#                    (read by curl with -H @file, so the token never sits in
#                    argv); must be owned by TOKEN_OWNER_UID (default 0, root)
#                    with mode 0600, or the script refuses to run
#   TRAEFIK_SERVICE  the app's Traefik service, e.g. http-0-<app-uuid>@docker
#   OUTPUT_FILE      default /data/coolify/proxy/dynamic/framer-clone-custom-domains.yml
#   CERT_RESOLVER    default letsencrypt
#   MAX_HOSTNAMES    default 1000
#   BLOCKED_ZONES    optional, comma-separated zones never routed (besides
#                    lumitra.co), e.g. other products' domains on this server
#   STATE_DIR        default /var/lib/framer-clone-custom-domains (systemd
#                    StateDirectory): high-water mark and the force-once flag.
#                    Not under /etc on purpose: the unit keeps /etc read-only.
#   HWM_WINDOW       seconds a high-water mark counts, default 86400 (24 h)
#   DROP_FLOOR       drops of this many routes or fewer always apply, default 5
#   FETCH            tests only: a command that writes the body to $1 and the
#                    response headers to $2 and prints the HTTP status

set -euo pipefail
export LC_ALL=C

log() { printf '[custom-domains] %s\n' "$*" >&2; }
refuse() { log "REFUSED: $*; keeping the current file"; exit 1; }

: "${FEED_URL:?FEED_URL is required}"
: "${TRAEFIK_SERVICE:?TRAEFIK_SERVICE is required (the app service, e.g. http-0-<uuid>@docker)}"
OUTPUT_FILE="${OUTPUT_FILE:-/data/coolify/proxy/dynamic/framer-clone-custom-domains.yml}"
CERT_RESOLVER="${CERT_RESOLVER:-letsencrypt}"
MAX_HOSTNAMES="${MAX_HOSTNAMES:-1000}"
BLOCKED_ZONES="${BLOCKED_ZONES:-}"
STATE_DIR="${STATE_DIR:-/var/lib/framer-clone-custom-domains}"
HWM_WINDOW="${HWM_WINDOW:-86400}"
DROP_FLOOR="${DROP_FLOOR:-5}"
STATE_FILE="$STATE_DIR/high-water"
FORCE_FILE="$STATE_DIR/force-once"
TOKEN_OWNER_UID="${TOKEN_OWNER_UID:-0}"

if ! [[ "$TRAEFIK_SERVICE" =~ ^[A-Za-z0-9._-]+@[a-z]+$ ]]; then
  log "TRAEFIK_SERVICE has an unexpected shape, refusing"; exit 2
fi
if ! [[ "$CERT_RESOLVER" =~ ^[A-Za-z0-9_-]+$ ]]; then
  log "CERT_RESOLVER has an unexpected shape, refusing"; exit 2
fi
for n in MAX_HOSTNAMES HWM_WINDOW DROP_FLOOR; do
  if ! [[ "${!n}" =~ ^[0-9]+$ ]]; then log "$n must be a number, refusing"; exit 2; fi
done

# The zones never routed: the platform's own, plus the operator's list.
zones="lumitra.co"
IFS=',' read -r -a extra_zones <<< "$BLOCKED_ZONES"
for z in ${extra_zones[@]+"${extra_zones[@]}"}; do
  z="$(printf '%s' "$z" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  z="${z%.}"
  [[ -z "$z" ]] && continue
  if ! [[ "$z" =~ ^[a-z0-9.-]+$ ]]; then
    log "BLOCKED_ZONES entry has an unexpected shape, refusing"; exit 2
  fi
  zones="$zones $z"
done

# Mirrors RESERVED_TOP_LEVEL in src/server/domains/hostname.ts.
reserved_tlds=" localhost local test example invalid internal onion arpa lan home corp intranet private "

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
sha256_text() { printf '%s' "$1" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | cut -d' ' -f1; }

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
body="$workdir/body"
headers="$workdir/headers"
: > "$headers"

if [[ -n "${FETCH:-}" ]]; then
  status="$($FETCH "$body" "$headers")" || refuse "the fetch command failed"
else
  : "${TOKEN_FILE:?TOKEN_FILE is required}"
  [[ -f "$TOKEN_FILE" ]] || { log "TOKEN_FILE does not exist, refusing"; exit 2; }
  if stat -c '%u %a' "$TOKEN_FILE" >/dev/null 2>&1; then
    read -r owner mode < <(stat -c '%u %a' "$TOKEN_FILE")
  else
    read -r owner mode < <(stat -f '%u %Lp' "$TOKEN_FILE")
  fi
  if [[ "$owner" != "$TOKEN_OWNER_UID" || "$mode" != "600" ]]; then
    log "TOKEN_FILE must be owned by uid $TOKEN_OWNER_UID with mode 0600 (found uid $owner, mode $mode), refusing"
    exit 2
  fi
  status="$(curl --silent --show-error --max-time 20 --proto '=https' \
    -H @"$TOKEN_FILE" -D "$headers" -o "$body" -w '%{http_code}' "$FEED_URL")" \
    || refuse "the feed could not be fetched"
fi
[[ "$status" == "200" ]] || refuse "the feed answered HTTP $status"

header() {
  # The value of header $1 (case-insensitive), last occurrence, CR stripped.
  awk -v want="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" '
    { line = $0; sub(/\r$/, "", line)
      i = index(line, ":"); if (i == 0) next
      name = tolower(substr(line, 1, i - 1))
      if (name == want) { v = substr(line, i + 1); sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v); val = v } }
    END { print val }' "$headers"
}

content_type="$(header content-type | tr '[:upper:]' '[:lower:]')"
[[ "$content_type" == text/plain* ]] || refuse "content-type is '${content_type:-missing}', not text/plain"

want_sha="$(header x-content-sha256 | tr '[:upper:]' '[:lower:]')"
[[ "$want_sha" =~ ^[0-9a-f]{64}$ ]] || refuse "x-content-sha256 is missing or malformed"
[[ "$(sha256_of "$body")" == "$want_sha" ]] || refuse "the body does not match x-content-sha256"

want_count="$(header x-hostname-count)"
[[ "$want_count" =~ ^[0-9]+$ ]] || refuse "x-hostname-count is missing or malformed"

if [[ "$(header x-hostname-truncated)" == "true" ]]; then
  log "the app reports its hostname cap was reached; some verified domains get no route"
fi

label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
valid_re="^(${label}\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$"

hosts=()
seen=$'\n'
lineno=0
while IFS= read -r line || [[ -n "$line" ]]; do
  lineno=$((lineno + 1))
  line="${line%$'\r'}"
  [[ -z "$line" ]] && refuse "line $lineno is empty"
  if (( ${#line} > 253 )) || ! [[ "$line" =~ $valid_re ]]; then
    refuse "line $lineno is not a plain hostname"
  fi
  tld="${line##*.}"
  [[ "$reserved_tlds" == *" $tld "* ]] && refuse "line $lineno uses the reserved ending .$tld"
  for z in $zones; do
    if [[ "$line" == "$z" || "$line" == *".$z" ]]; then
      refuse "line $lineno is under the blocked zone $z"
    fi
  done
  [[ "$seen" == *$'\n'"$line"$'\n'* ]] && refuse "line $lineno repeats $line"
  seen+="$line"$'\n'
  hosts+=("$line")
done < "$body"

(( ${#hosts[@]} == want_count )) || refuse "x-hostname-count says $want_count, the body has ${#hosts[@]}"
(( ${#hosts[@]} <= MAX_HOSTNAMES )) || refuse "${#hosts[@]} hostnames exceed MAX_HOSTNAMES ($MAX_HOSTNAMES)"

# The current routes, from the marker lines this script writes.
current_hosts=()
if [[ -f "$OUTPUT_FILE" ]]; then
  while IFS= read -r m; do current_hosts+=("${m#\# hostname: }"); done \
    < <(grep '^# hostname: ' "$OUTPUT_FILE" || true)
fi
current=${#current_hosts[@]}
new=${#hosts[@]}

# The high-water mark: the largest count written within HWM_WINDOW.
now_epoch="$(date +%s)"
hwm=0
if [[ -f "$STATE_FILE" ]]; then
  read -r hwm_count hwm_epoch < "$STATE_FILE" || true
  if [[ "${hwm_count:-}" =~ ^[0-9]+$ && "${hwm_epoch:-}" =~ ^[0-9]+$ ]] \
     && (( now_epoch - hwm_epoch <= HWM_WINDOW )); then
    hwm=$hwm_count
  fi
fi
baseline=$(( current > hwm ? current : hwm ))

forced=0
if [[ -e "$FORCE_FILE" ]]; then
  forced=1
  rm -f "$FORCE_FILE"
  log "force-once flag found and consumed: any drop is accepted this run"
fi

held=0
final_hosts=(${hosts[@]+"${hosts[@]}"})
drop=$(( baseline - new ))
if (( forced == 0 && drop > DROP_FLOOR && new * 2 < baseline )); then
  held=1
  # Keep every current route (the removals wait for confirmation), add the new ones.
  joined=$'\n'
  for h in ${hosts[@]+"${hosts[@]}"}; do joined+="$h"$'\n'; done
  for h in ${current_hosts[@]+"${current_hosts[@]}"}; do
    [[ "$joined" == *$'\n'"$h"$'\n'* ]] && continue
    joined+="$h"$'\n'
    final_hosts+=("$h")
  done
fi
final=${#final_hosts[@]}

router_id() { printf 'fc-cd-%s' "$(sha256_text "$1" | cut -c1-16)"; }

tmp="$workdir/out.yml"
{
  printf '# Generated by framer-clone deploy/custom-domains/sync-traefik.sh. Do not edit.\n'
  printf '# %d custom hostname(s).\n' "$final"
  for h in ${final_hosts[@]+"${final_hosts[@]}"}; do printf '# hostname: %s\n' "$h"; done
  printf 'http:\n'
  printf '  middlewares:\n'
  printf '    fc-cd-redirect-https:\n'
  printf '      redirectScheme:\n'
  printf '        scheme: https\n'
  printf '        permanent: true\n'
  if (( final > 0 )); then
    printf '  routers:\n'
    for h in ${final_hosts[@]+"${final_hosts[@]}"}; do
      id="$(router_id "$h")"
      printf '    %s-http:\n' "$id"
      printf '      rule: "Host(`%s`)"\n' "$h"
      printf '      priority: 1\n'
      printf '      entryPoints: [http]\n'
      printf '      middlewares: [fc-cd-redirect-https]\n'
      printf '      service: %s\n' "$TRAEFIK_SERVICE"
      printf '    %s-https:\n' "$id"
      printf '      rule: "Host(`%s`)"\n' "$h"
      printf '      priority: 1\n'
      printf '      entryPoints: [https]\n'
      printf '      service: %s\n' "$TRAEFIK_SERVICE"
      printf '      tls:\n'
      printf '        certResolver: %s\n' "$CERT_RESOLVER"
    done
  fi
} > "$tmp"

if ! { [[ -f "$OUTPUT_FILE" ]] && cmp -s "$tmp" "$OUTPUT_FILE"; }; then
  staged="${OUTPUT_FILE}.tmp"
  install -m 0644 "$tmp" "$staged"
  mv -f "$staged" "$OUTPUT_FILE"
  log "wrote $final hostname(s) to $OUTPUT_FILE (was $current)"
fi

# Record the high-water mark: reset by a confirmed drop or an expired window,
# raised by a larger count, untouched while a drop is held.
if (( held == 0 )) && { (( forced == 1 )) || (( hwm == 0 )) || (( final >= hwm )); }; then
  mkdir -p "$STATE_DIR"
  printf '%d %d\n' "$final" "$now_epoch" > "$STATE_FILE.tmp"
  mv -f "$STATE_FILE.tmp" "$STATE_FILE"
fi

if (( held == 1 )); then
  log "HELD: the feed would drop from $baseline to $new routes (more than $DROP_FLOOR and more than half of the 24 h high-water mark); kept the $((final - new)) missing route(s), applied additions. If the drop is genuine: touch $FORCE_FILE"
  exit 3
fi
