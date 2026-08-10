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
    echo "> fake · scenario=prompt"
    echo "• Running rm -rf build"
    echo "  Would you like to run the following command?"
    echo "  Environment: local"
    echo "  \$ rm -rf build"
    echo "› 1. Yes, proceed (y)"
    echo "  2. Yes, and don't ask again for commands that start with \`rm -rf build\` (p)"
    echo "  3. No, and tell Codex what to do differently (esc)"
    echo "  Press enter to confirm or esc to cancel"
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
  hang)
    echo "> fake · scenario=hang"
    sleep 120
    ;;
esac
