#!/bin/bash
# Step 1 of three: every page in pages.ts from the live site, one short browser call at a
# time, into ~/.dev-browser/tmp. Then freeze.ts and rebuild.ts. Needs the Mac's automation
# Chrome (dev-browser-auto, headless). Never run this from a product slice: a new capture
# replaces the held-out reference, so it is the operator's call.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$(mktemp -d)/capture.js"
while read -r slug path; do
  [ -z "$slug" ] && continue
  { printf 'const SLUG="%s"; const URL_PATH="%s";\n' "$slug" "$path"; cat "$here/capture.devbrowser.txt"; } > "$script"
  # Remove any earlier capture first, so a file that exists afterwards was written by this run
  # and freeze.ts can never seal stale page data.
  rm -f "$HOME/.dev-browser/tmp/bb-$slug.json"
  # The sandbox can fail while it shuts down, after the file is written, so the exit status is
  # ignored and the fresh file is what decides.
  dev-browser-auto --timeout 170 run "$script" | tail -1 | cut -c1-300 || true
  if [ ! -s "$HOME/.dev-browser/tmp/bb-$slug.json" ]; then
    echo "capture failed: no fresh bb-$slug.json was written" >&2
    exit 1
  fi
  sleep 1
done <<'EOF'
home /de
store /de/store
search /de/store?q=bremse
category /de/categories/mercedes-benz-baumuster-309-310-313-duedos-motor
collection /de/collections/favoriten
product /de/products/11d3-32
cart-empty /de/cart
checkout-no-cart /de/checkout
privacy /de/privacy
terms /de/terms
login /de/account
request-reset /de/request-reset
shop-unavailable /de/shop-unavailable
not-found /de/search
EOF
