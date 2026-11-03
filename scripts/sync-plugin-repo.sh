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
# cannot be read or cloned, 64 bad usage. Missing repositories, authorization
# failures and network failures all fail; a Git transport error cannot prove
# that a repository is absent. The workflow skips only before a key is set up.
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
clone_args=(--quiet --depth 1)
main_missing=0
# Always base the sync on the branch we push, even when remote HEAD is stale.
if git ls-remote --exit-code --heads "$MIRROR_URL" main >/dev/null; then
  clone_args+=(--branch main)
else
  probe_status=$?
  if [[ "$probe_status" -ne 2 ]]; then
    echo "sync-plugin-repo: cannot read branches of ${REPO}" >&2
    exit 2
  fi
  # Exit 2 means no matching branch. An empty mirror can bootstrap main from
  # remote HEAD; set its default branch to main before the first sync.
  main_missing=1
fi
if ! git clone "${clone_args[@]}" "$MIRROR_URL" "$work/mirror"; then
  echo "sync-plugin-repo: cannot clone ${REPO} from ${MIRROR_URL} (private, renamed, no access, or no network; git's error is above)" >&2
  exit 2
fi

drift=$main_missing
if [[ "$main_missing" -eq 1 ]]; then
  echo "drift: main does not exist in the mirror"
fi
# Clean mirror-only files first, including dangling and directory symlinks.
# The payload contains regular files. Unlink every mirror symlink in the
# temporary clone even in check mode, so comparison and copying never follow
# one outside that clone. Neither mode changes the remote until the push.
while IFS= read -r -d '' file; do
  rel="${file#"$work/mirror"/}"
  if [[ -L "$file" ]]; then
    echo "drift: $rel is a symlink in the mirror"
    drift=1
    rm "$file"
  elif [[ ! -f "$work/expected/$rel" ]]; then
    echo "drift: $rel exists in the mirror but not here"
    drift=1
    [[ "$mode" == sync ]] && rm "$file"
  fi
done < <(find "$work/mirror" -path "$work/mirror/.git" -prune -o \( -type f -o -type l \) -print0)

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
if ! git diff --cached --quiet; then
  git commit -q -m "sync plugin payload ${version} from framer-clone${source_commit:+ ${source_commit}}"
fi
git push -q origin HEAD:main
echo "sync-plugin-repo: pushed version ${version} to ${REPO}"
