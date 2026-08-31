#!/bin/bash
# Remove everything the evaluation owns, and FAIL if anything survives.
#
#   scripts/eval/teardown.sh [evalRoot]
#
# Three kinds of residue, each verified rather than assumed:
#
#   1. the trial servers        -- exact owned pids, checked to still be OUR
#                                  serve.js before being signalled, and confirmed
#                                  gone afterwards
#   2. the baseline worktree    -- REGISTERED INSIDE THE USER'S REPOSITORY, so it
#                                  is removed by its exact path with `git worktree
#                                  remove` and its de-registration is confirmed in
#                                  `git worktree list`. NEVER pruned: prune would
#                                  act on worktrees this harness did not create.
#                                  Never `rm -rf`'d while still registered, which
#                                  would leave a stale entry and look like success.
#   3. the eval root            -- removed only at the exact owned path, and only
#                                  after a sanity check on the path itself
#
# Machine-independent: the repository comes from this script's own location, the
# eval root defaults under $TMPDIR. Exits non-zero if any step could not be
# verified, because a cleanup that cannot prove itself is a failed cleanup.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TMP="${TMPDIR:-/tmp}"; TMP="${TMP%/}"
EVAL_ROOT="${1:-${STACKI_EVAL_ROOT:-$TMP/stacki-eval}}"
EVAL_ROOT="${EVAL_ROOT%/}"
BASELINE_REPO="$EVAL_ROOT/baseline-main"
OUT="$EVAL_ROOT/trials"

problems=0
fail() { echo "CLEANUP FAILURE: $*"; problems=$((problems+1)); }

# git records worktrees by their REAL path: on macOS $TMPDIR is under a symlink,
# so the path we were handed and the path in `git worktree list` are spelled
# differently and a naive string compare would report "not registered" for a
# worktree that is still very much registered. Resolve without requiring the leaf
# to exist, so the check still works after the directory is gone.
realpath_of() {
  local d b
  d=$(dirname "$1"); b=$(basename "$1")
  if [ -d "$d" ]; then printf '%s/%s\n' "$(cd "$d" && pwd -P)" "$b"; else printf '%s\n' "$1"; fi
}
BASELINE_REAL=$(realpath_of "$BASELINE_REPO")

echo "repo:      $REPO"
echo "eval root: $EVAL_ROOT"

# A path this script is willing to delete: absolute, at least two components deep,
# not the repository, not $HOME, not /.
case "$EVAL_ROOT" in
  /|/Users|/Users/*/|"$HOME"|"$REPO"|"$REPO"/*|*/..*|"")
    echo "refusing to treat '$EVAL_ROOT' as an eval root"; exit 2;;
  /*/*) ;;
  *) echo "eval root must be an absolute path, got '$EVAL_ROOT'"; exit 2;;
esac

# 1. THE SERVERS. Exact pids only, and only if that pid is still one of ours --
# a recycled pid belongs to somebody else and must not be signalled.
if [ -d "$OUT" ]; then
  for p in "$OUT"/*/serve.pid; do
    [ -f "$p" ] || continue
    pid=$(cat "$p" 2>/dev/null)
    case "$pid" in ''|*[!0-9]*) continue;; esac
    kill -0 "$pid" 2>/dev/null || continue
    if ! ps -o command= -p "$pid" 2>/dev/null | grep -q 'scripts/eval/serve.js'; then
      echo "pid $pid is no longer our serve.js; leaving it alone"
      continue
    fi
    echo "stopping eval server $pid"
    kill -TERM "$pid" 2>/dev/null
  done

  # Confirm each one actually went away.
  for p in "$OUT"/*/serve.pid; do
    [ -f "$p" ] || continue
    pid=$(cat "$p" 2>/dev/null)
    case "$pid" in ''|*[!0-9]*) continue;; esac
    waited=0
    while [ "$waited" -lt 15 ] && kill -0 "$pid" 2>/dev/null; do
      sleep 1; waited=$((waited+1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      if ps -o command= -p "$pid" 2>/dev/null | grep -q 'scripts/eval/serve.js'; then
        kill -KILL "$pid" 2>/dev/null; sleep 1
        fail "eval server $pid ignored SIGTERM for 15s (killed, but the run is not clean)"
      fi
    fi
  done
fi

# 2. THE WORKTREE. By name, verified, never pruned.
if [ -e "$BASELINE_REPO" ]; then
  echo "removing the baseline worktree at $BASELINE_REPO"
  if ! git -C "$REPO" worktree remove --force "$BASELINE_REPO"; then
    fail "git worktree remove refused $BASELINE_REPO -- left in place deliberately"
  fi
fi
[ -e "$BASELINE_REPO" ] && fail "$BASELINE_REPO still exists after removal"
registered=$(git -C "$REPO" worktree list --porcelain | grep '^worktree ' | cut -d' ' -f2-)
if printf '%s\n' "$registered" | grep -qxF "$BASELINE_REPO" \
  || printf '%s\n' "$registered" | grep -qxF "$BASELINE_REAL"; then
  fail "$BASELINE_REPO is still registered in git worktree list"
fi

# 3. THE EVAL ROOT -- but only if the worktree really did come out.
#
# The baseline checkout lives inside this directory. Deleting it while it is still
# registered would swap one kind of residue for a worse one: a stale entry in the
# user's `git worktree list` pointing at nothing, and a teardown that looked like
# it worked. If anything above failed, the directory stays and so does the
# evidence.
if [ "$problems" -ne 0 ]; then
  echo "leaving $EVAL_ROOT in place: cleanup already failed and the directory is the evidence"
elif [ -d "$EVAL_ROOT" ]; then
  rm -rf "$EVAL_ROOT"
  [ -e "$EVAL_ROOT" ] && fail "$EVAL_ROOT still exists after removal"
fi

echo "worktrees now:"
git -C "$REPO" worktree list

if [ "$problems" -ne 0 ]; then
  echo "teardown left $problems problem(s)"
  exit 1
fi
echo "teardown clean"
