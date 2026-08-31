#!/bin/bash
# Start one batch of evaluation trials: every task, both arms, one trial number.
#
#   scripts/eval/launch.sh <trial> <outdir>
#
# Each trial gets its OWN Stacki, its OWN Astro fixture and its OWN port, so they
# can run at the same time without touching each other. The baseline arm is
# served from an owned worktree at origin/main -- real Phase-A code, not a
# simulation of it.
#
# Prints one workspace path per line once every server says READY.
set -u
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
export STACKI_NO_DIALOGS=1

REPO=/Users/heymarcell/DEV/stacki
SP=/private/tmp/claude-501/-Users-heymarcell-DEV-stacki/7f2a655b-19f7-4832-b296-ee72b7ea9948/scratchpad
BASELINE_REPO="$SP/baseline-main"

TRIAL="${1:-1}"
OUT="${2:-$SP/eval}"
# `review` is absent: a review pin needs a canvas selection and this rig has
# none. See scripts/eval/tasks.js for the full record of why it was withdrawn.
TASKS="understand text style component content auditfix"

mkdir -p "$OUT"

# THE BASELINE CHECKOUT, CREATED HERE AND REMOVED BY teardown.sh.
#
# It used to be made by hand, which left a worktree registered inside the user's
# repository that nothing in the repository knew about or cleaned up. It is a
# detached worktree at origin/main with its OWN node_modules -- an APFS clone, so
# it costs seconds and almost no disk. Its own, not a symlink: the agent harness
# caches a bundle of src/App.jsx under node_modules, and a shared one would have
# the two arms comparing one Stacki against itself.
if [ ! -d "$BASELINE_REPO/.git" ] && [ ! -f "$BASELINE_REPO/.git" ]; then
  echo "creating the baseline worktree at origin/main..."
  git -C "$REPO" worktree add --detach "$BASELINE_REPO" origin/main || exit 1
fi
if [ ! -d "$BASELINE_REPO/node_modules" ]; then
  cp -Rc "$REPO/node_modules" "$BASELINE_REPO/node_modules" 2>/dev/null \
    || cp -R "$REPO/node_modules" "$BASELINE_REPO/node_modules" || exit 1
fi
echo "baseline is $(git -C "$BASELINE_REPO" rev-parse HEAD)"

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

for task in $TASKS; do
  for arm in baseline candidate; do
    ws="$OUT/t${TRIAL}-${task}-${arm}"
    if [ -f "$ws/READY" ]; then echo "READY $ws"; else echo "FAILED $ws"; fi
  done
done
