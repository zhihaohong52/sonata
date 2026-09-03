export type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';

export type TailState = 'PROGRESS' | 'PAUSED' | 'DONE' | 'STALLED';

export type ProviderHarness = 'opencode' | 'pi' | 'codex' | 'reasonix';

/**
 * One `provider/model` pair a harness can actually run.
 *
 * `ref` is what reaches `-m` / `--model` verbatim. `id` may itself contain
 * slashes — openrouter nests an org segment — so it is never re-split.
 */
export interface ModelRef {
  harness: ProviderHarness;
  provider: string;
  id: string;
  ref: string;
  name?: string;
}

export interface RunMeta {
  id: string;
  role: string;
  model: string;
  harness: string;
  mode: PermissionMode;
  interactive: boolean;
  /**
   * False when the harness configuration physically cannot write the report
   * file — a strict read-only tool allowlist blocks the model's own writes.
   * Such a run is not degraded merely for lacking a report; its terminal
   * output is the report. Absent means true, for runs recorded before this.
   */
  canWriteReport?: boolean;
  /**
   * True when the harness writes nothing to the terminal until it exits
   * (headless `claude -p`). Pane silence is then expected, so tail must not
   * report such a run STALLED. Absent means false, for runs recorded before
   * this field existed.
   */
  silentUntilExit?: boolean;
  /**
   * The working tree's fingerprint when the run launched (`src/worktree.ts`),
   * against which tail compares at exit to tell a run that did nothing from one
   * that did something. Absent means the comparison is unavailable, not that
   * the tree was empty: `cwd` is not a git repository, or the run predates this
   * field. Write-capable roles only — a read-only run is not expected to leave
   * a mark, so flagging one would be noise rather than a finding.
   */
  worktreeAtLaunch?: string;
  session: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  degraded?: boolean;
}
