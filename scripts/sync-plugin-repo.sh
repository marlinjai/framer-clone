#!/usr/bin/env bash
# Sync (or verify) the PUBLIC Lumitra Sites plugin mirror against this repo.
#
# The mirror repository marlinjai/lumitra-sites-plugin is generated: its tree is
# plugin/lumitra-sites (the Agent Plugins payload: plugin.json, mcp.json,
# README.md, skills/) plus plugin/lumitra-sites-mirror (the Claude Code files the
# spec does not define: .claude-plugin/plugin.json, .claude-plugin/marketplace.json,
# .mcp.json, LICENSE), laid into one directory. Both folders are the single
# source of truth; nothing in the mirror is hand-edited, so unlike Lumitra
# Studio's mirror there is no list of mirror-owned files that could drift.
#
#   scripts/sync-plugin-repo.sh --check-payload  # validator + versions agree; no network (pull request CI)
#   scripts/sync-plugin-repo.sh --check          # exit 1 if the mirror has drifted
#   scripts/sync-plugin-repo.sh                  # push this repo's payload to the mirror
#
# Exit codes: 0 in sync (or pushed), 1 drift or an invalid payload, 2 the mirror
# cannot be cloned, 3 the mirror repository does not exist yet (only with
# PLUGIN_MIRROR_ALLOW_MISSING=1, which the sync workflow sets so it stays green
# until the repository is created), 64 bad usage.
#
# The mirror is synced from `main` after every merge that touches the payload
# (.github/workflows/sync-plugin-mirror.yml), never from a pull request: Studio
# learned that a mirror synced from one open pull request makes main and every
# other pull request fail a comparison (lumitra-studio #433, 2026-10-22).
#
# PLUGIN_MIRROR_URL overrides the clone and push address (the workflow uses the
# SSH address with a deploy key). Without it the HTTPS address is used, which
# works with a local `gh` login.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${PLUGIN_MIRROR_REPO:-marlinjai/lumitra-sites-plugin}"
MIRROR_URL="${PLUGIN_MIRROR_URL:-https://github.com/${REPO}.git}"
PAYLOAD_DIR="$ROOT/plugin/lumitra-sites"
MIRROR_FILES_DIR="$ROOT/plugin/lumitra-sites-mirror"
# GitHub answers a repository that does not exist (or is private) over HTTPS
# with a credential prompt; fail instead of waiting on a terminal.
export GIT_TERMINAL_PROMPT=0

if [[ $# -gt 1 ]]; then
  echo "usage: scripts/sync-plugin-repo.sh [--check | --check-payload] (one argument at most)" >&2
  exit 64
fi
mode=sync
case "${1:-}" in
  "") ;;
  --check) mode=check ;;
  --check-payload) mode=payload ;;
  *)
    echo "usage: scripts/sync-plugin-repo.sh [--check | --check-payload]" >&2
    exit 64
    ;;
esac

# Every mode starts with the local checks, without the network: the payload is a
# valid Agent Plugin, and the mirror files carry the payload's version, address
# and headers (plugin/validate.mjs validates both).
node "$ROOT/plugin/validate.mjs" "$PAYLOAD_DIR" "$MIRROR_FILES_DIR"
version="$(node -p "require('${PAYLOAD_DIR}/plugin.json').version")"

if [[ "$mode" == payload ]]; then
  echo "sync-plugin-repo: the payload and the mirror files are valid and carry version ${version}"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The tree the mirror must hold.
mkdir -p "$work/expected"
cp -R "$PAYLOAD_DIR/." "$work/expected/"
cp -R "$MIRROR_FILES_DIR/." "$work/expected/"

# git's own error is kept: it says whether the address, the key, the host key
# or the network failed. It carries no secret (a deploy key is read from a file
# and never echoed; the default address is plain HTTPS without credentials).
if ! git clone --quiet --depth 1 "$MIRROR_URL" "$work/mirror"; then
  if [[ "${PLUGIN_MIRROR_ALLOW_MISSING:-}" == 1 ]] && ! git ls-remote --exit-code "https://github.com/${REPO}.git" >/dev/null 2>&1; then
    echo "sync-plugin-repo: ${REPO} does not exist yet; nothing to sync" >&2
    exit 3
  fi
  echo "sync-plugin-repo: cannot clone ${REPO} from ${MIRROR_URL} (private, renamed, no access, or no network; git's error is above)" >&2
  exit 2
fi

drift=0
while IFS= read -r -d '' file; do
  rel="${file#"$work/expected"/}"
  if ! diff -q "$file" "$work/mirror/$rel" >/dev/null 2>&1; then
    echo "drift: $rel"
    drift=1
    if [[ "$mode" == sync ]]; then
      mkdir -p "$(dirname "$work/mirror/$rel")"
      cp "$file" "$work/mirror/$rel"
    fi
  fi
done < <(find "$work/expected" -type f -print0)

# A file deleted here must disappear there too, or the mirror keeps shipping it.
while IFS= read -r -d '' file; do
  rel="${file#"$work/mirror"/}"
  [[ "$rel" == .git/* ]] && continue
  if [[ ! -f "$work/expected/$rel" ]]; then
    echo "drift: $rel exists in the mirror but not here"
    drift=1
    [[ "$mode" == sync ]] && rm "$file"
  fi
done < <(find "$work/mirror" -type f -print0)

if [[ $drift -eq 0 ]]; then
  echo "sync-plugin-repo: ${REPO} matches plugin/lumitra-sites and plugin/lumitra-sites-mirror (version ${version})"
  exit 0
fi

if [[ "$mode" == check ]]; then
  echo "sync-plugin-repo: the mirror has drifted. Run scripts/sync-plugin-repo.sh (or the \"Sync plugin mirror\" workflow) to push this repo's payload." >&2
  exit 1
fi

source_commit="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
cd "$work/mirror"
# The Actions runner has no git identity; locally the person's own is used.
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  export GIT_AUTHOR_NAME="github-actions[bot]" GIT_COMMITTER_NAME="github-actions[bot]"
  export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
  export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
fi
git add -A
git commit -q -m "sync plugin payload ${version} from framer-clone${source_commit:+ ${source_commit}}"
git push -q origin HEAD:main
echo "sync-plugin-repo: pushed version ${version} to ${REPO}"
