export type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';

export type TailState = 'PROGRESS' | 'PAUSED' | 'DONE' | 'STALLED';

export type ProviderHarness = 'opencode' | 'pi' | 'codex';

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
  session: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  degraded?: boolean;
}
