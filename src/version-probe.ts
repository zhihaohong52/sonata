/**
 * How long any `--version` probe may take.
 *
 * Only opencode's was bounded, so a pi, codex, reasonix or tmux binary that
 * hung on `--version` hung `sonata init` and `sonata doctor` outright. Its own
 * module, with no imports, so `tmux.ts`, `detect.ts` and `doctor.ts` can all
 * use it without `tmux.ts` pulling in the detector (which imports doctor).
 */
export const VERSION_PROBE_TIMEOUT_MS = 10_000;
