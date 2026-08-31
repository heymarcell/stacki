#!/bin/bash
# Remove everything the evaluation owns.
#
#   scripts/eval/teardown.sh [outdir]
#
# The baseline checkout is a git worktree REGISTERED INSIDE THE USER'S REPOSITORY.
# Leaving it there is residue in somebody else's `git worktree list`, so it is
# removed by name -- never by pruning, which would touch worktrees this harness
# did not create.
set -u
REPO=/Users/heymarcell/DEV/stacki
SP=/private/tmp/claude-501/-Users-heymarcell-DEV-stacki/7f2a655b-19f7-4832-b296-ee72b7ea9948/scratchpad
BASELINE_REPO="$SP/baseline-main"
OUT="${1:-$SP/eval}"

# Any server still holding a rig, by the pid it wrote down. Exact identities only.
if [ -d "$OUT" ]; then
  for p in "$OUT"/*/serve.pid; do
    [ -f "$p" ] || continue
    pid=$(cat "$p")
    if kill -0 "$pid" 2>/dev/null; then
      echo "stopping eval server $pid"
      kill -TERM "$pid" 2>/dev/null
    fi
  done
  sleep 3
fi

if [ -d "$BASELINE_REPO" ]; then
  echo "removing the baseline worktree"
  git -C "$REPO" worktree remove --force "$BASELINE_REPO" 2>/dev/null || rm -rf "$BASELINE_REPO"
fi

echo "worktrees now:"
git -C "$REPO" worktree list
