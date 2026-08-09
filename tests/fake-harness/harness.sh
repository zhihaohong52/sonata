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
    echo "> fake · scenario=prompt"
    echo "Allow bash to run rm -rf build? (y/n)"
    sleep 30
    ;;
  crash)
    echo "> fake · scenario=crash"
    echo "segmentation fault"
    echo 139 > "$RUN_DIR/exit"
    ;;
  noreport)
    echo "> fake · scenario=noreport"
    echo "finished without writing anything"
    echo 0 > "$RUN_DIR/exit"
    ;;
esac
