#!/usr/bin/env bash
# The one check command of this repository: `pnpm verify`.
#
# Runs every step of the `verify` and `roadmap-check` jobs of .github/workflows/ci.yml in the same order and prints
# one line per stage, PASS or FAIL with its time. A failed stage's output ends are printed and its log is kept.
# The `docker-build`, `render-gate` and `behaviour` jobs (a production image, real browsers) stay with CI;
# run `pnpm test:render-gate` or `pnpm test:behaviour` for a change they cover.
#
# The integration tests start their own throwaway Postgres in Docker. VERIFY_SKIP_INSTALL=1 skips the install.
set -u
cd "$(dirname "$0")/.."

LOGS="$(mktemp -d "${TMPDIR:-/tmp}/sites-verify.XXXXXX")"
FAILED=0

stage() {
  local name="$1"
  shift
  local log="$LOGS/${name// /-}.log"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    printf 'PASS  %-34s %4ss\n' "$name" "$((SECONDS - start))"
    return 0
  fi
  printf 'FAIL  %-34s %4ss  (log: %s)\n' "$name" "$((SECONDS - start))" "$log"
  tail -n 40 "$log" | sed 's/^/      | /'
  FAILED=1
  return 1
}

# The dummy connection string CI gives the steps that only need the generated client or the build.
export DATABASE_URL="${DATABASE_URL:-postgresql://ci:ci@localhost:5432/framer_clone_ci}"

stage "tenant isolation guards" pnpm lint:guards
stage "agent plugin" ./scripts/sync-plugin-repo.sh --check-payload
if [ "${VERIFY_SKIP_INSTALL:-}" != "1" ]; then
  stage "install" pnpm install --frozen-lockfile
fi
stage "prisma generate" pnpm exec prisma generate
stage "score floor" pnpm check:score-floor --sound-only
stage "typecheck" pnpm exec tsc --noEmit
stage "lint" pnpm lint
stage "unit tests" pnpm test
stage "build" pnpm build
stage "integration tests" pnpm test:integration
stage "database types" bash -c 'pnpm db:codegen-commerce && git diff --exit-code src/server/commerce/db-types.ts'
stage "roadmap check" npx --yes github:marlinjai/actions-shared#roadmap-check-v1 --root .

if [ "$FAILED" -eq 0 ]; then
  echo "verify: all stages passed"
else
  echo "verify: FAILED (logs in $LOGS)"
fi
exit "$FAILED"
