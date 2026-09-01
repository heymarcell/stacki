#!/bin/bash
# Start one batch of evaluation trials: every task, both arms, one trial number.
#
#   scripts/eval/launch.sh <trial> [evalRoot]
#
# Each trial gets its OWN Stacki, its OWN Astro fixture and its OWN port, so they
# can run at the same time without touching each other. The baseline arm is
# served from an owned worktree at origin/main -- real Phase-A code, not a
# simulation of it.
#
# NOTHING HERE KNOWS WHOSE MACHINE IT IS ON. The repository is derived from this
# script's own location and the eval root defaults under $TMPDIR, so a checkout
# anywhere works. Override with the second argument or STACKI_EVAL_ROOT.
#
# Prints one workspace path per line once every server says READY.
set -u
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
export STACKI_NO_DIALOGS=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TMP="${TMPDIR:-/tmp}"; TMP="${TMP%/}"
EVAL_ROOT="${2:-${STACKI_EVAL_ROOT:-$TMP/stacki-eval}}"
EVAL_ROOT="${EVAL_ROOT%/}"
BASELINE_REPO="$EVAL_ROOT/baseline-main"

TRIAL="${1:-1}"
OUT="$EVAL_ROOT/trials"
# `review` is absent: a review pin needs a canvas selection and this rig has
# none. See scripts/eval/tasks.js for the full record of why it was withdrawn.
# STACKI_EVAL_TASKS narrows the set -- used by the harness's own smoke test, which
# needs one pair of rigs rather than twelve.
TASKS="${STACKI_EVAL_TASKS:-understand text style component content auditfix}"

mkdir -p "$OUT"
echo "repo:      $REPO"
echo "eval root: $EVAL_ROOT"

# THE BASELINE CHECKOUT, CREATED HERE AND REMOVED BY teardown.sh.
#
# It used to be made by hand, which left a worktree registered inside the user's
# repository that nothing in the repository knew about or cleaned up. It is a
# detached worktree at origin/main with its OWN node_modules -- an APFS clone, so
# it costs seconds and almost no disk. Its own, not a symlink: the agent harness
# caches a bundle of src/App.jsx under node_modules, and a shared one would have
# the two arms comparing one Stacki against itself.
if [ ! -e "$BASELINE_REPO/.git" ]; then
  echo "creating the baseline worktree at origin/main..."
  git -C "$REPO" worktree add --detach "$BASELINE_REPO" origin/main || exit 1
fi
if [ ! -d "$BASELINE_REPO/node_modules" ]; then
  cp -Rc "$REPO/node_modules" "$BASELINE_REPO/node_modules" 2>/dev/null \
    || cp -R "$REPO/node_modules" "$BASELINE_REPO/node_modules" || exit 1
fi
echo "baseline:  $(git -C "$BASELINE_REPO" rev-parse HEAD)"

# ONE RIG PER ARM FIRST. The harness caches a bundle of src/App.jsx under
# node_modules; seven rigs starting together all find it missing, all write it,
# and the loser reads a half-written file. Building it once serially removes the
# race rather than hoping to lose it less often.
echo "prewarming both arms..."
node "$REPO/scripts/eval/prewarm.js" "$REPO" || exit 1
node "$REPO/scripts/eval/prewarm.js" "$BASELINE_REPO" || exit 1

for task in $TASKS; do
  for arm in baseline candidate; do
    ws="$OUT/t${TRIAL}-${task}-${arm}"
    rm -rf "$ws"; mkdir -p "$ws"
    repo="$REPO"
    [ "$arm" = "baseline" ] && repo="$BASELINE_REPO"
    # serve.js always runs from the candidate checkout (it is the harness), but
    # loads the Stacki under test out of --repo. That is what makes the baseline
    # arm actually Phase A.
    nohup node "$REPO/scripts/eval/serve.js" \
      --arm="$arm" --task="$task" --trial="$TRIAL" \
      --workspace="$ws" --repo="$repo" --timeout=2400 \
      > "$ws/serve.log" 2>&1 &
    echo "$!" > "$ws/serve.pid"
  done
done

# Wait for every server to be ready, or say which never was.
deadline=$(( $(date +%s) + 420 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  missing=0
  for task in $TASKS; do
    for arm in baseline candidate; do
      [ -f "$OUT/t${TRIAL}-${task}-${arm}/READY" ] || missing=$((missing+1))
    done
  done
  [ "$missing" -eq 0 ] && break
  sleep 5
done

failed=0
for task in $TASKS; do
  for arm in baseline candidate; do
    ws="$OUT/t${TRIAL}-${task}-${arm}"
    if [ -f "$ws/READY" ]; then
      echo "READY $ws"
    else
      echo "FAILED $ws"; failed=$((failed+1))
    fi
  done
done

# A rig that never came up is a hole in the trial, not a detail: exit non-zero so
# a caller cannot read "some of them started" as "the batch started".
if [ "$failed" -ne 0 ]; then
  echo "$failed rig(s) never became READY -- see their serve.log"
  exit 1
fi
