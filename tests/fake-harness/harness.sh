#!/bin/bash
# Scripted stand-in for a real harness. $1 = scenario, $2 = run dir.
SCENARIO="$1"
RUN_DIR="$2"

case "$SCENARIO" in
  normal)
    echo "> fake · scenario=normal"
    echo "read src/parser.ts"
    sleep 0.3
    echo "edit src/parser.ts"
    printf 'Refactored the parser. Tests pass.\n' > "$RUN_DIR/report.md"
    echo 0 > "$RUN_DIR/exit"
    ;;
  prompt)
    # Reproduces a real codex approval, captured in
    # tests/fixtures/panes/codex-approve-command.txt. Keep it verbatim: the
    # point of this scenario is that detection is tested against text codex
    # actually prints, not against text invented to match the regexes.
    #
    # One write, as codex paints it: the TUI draws the approval card as a
    # frame. Nine separate echos let a tail poll land between them under load
    # and read a half-drawn card — PAUSED with only the question, not the
    # command — which is this script's artefact, not codex's behaviour.
    cat <<'CARD'
> fake · scenario=prompt
• Running rm -rf build
  Would you like to run the following command?
  Environment: local
  $ rm -rf build
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `rm -rf build` (p)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel
CARD
    sleep 30
    ;;
  crash)
    echo "> fake · scenario=crash"
    echo "segmentation fault"
    echo 139 > "$RUN_DIR/exit"
    ;;
  fallback)
    echo "> fake · scenario=fallback"
    echo "worked, but wrote no report of its own"
    printf 'Final message written by the harness itself.\n' > "$RUN_DIR/last-message.txt"
    echo 0 > "$RUN_DIR/exit"
    ;;
  noreport)
    echo "> fake · scenario=noreport"
    echo "finished without writing anything"
    echo 0 > "$RUN_DIR/exit"
    ;;
  burst)
    # More than a screen in one go, teed to harness.log the way every
    # non-interactive adapter's script does — the case the live, one-screen-
    # per-poll event log cannot keep.
    {
      echo "> fake · scenario=burst"
      seq -f 'burst-%g' 1 3000
      printf '\033[1mbold summary\033[0m\n'
    } 2>&1 | tee -a "$RUN_DIR/harness.log"
    printf 'Done.\n' > "$RUN_DIR/report.md"
    echo 0 > "$RUN_DIR/exit"
    ;;
  hang)
    echo "> fake · scenario=hang"
    sleep 120
    ;;
esac
