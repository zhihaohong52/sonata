export type PermissionMode = 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';

export type TailState = 'PROGRESS' | 'PAUSED' | 'DONE' | 'STALLED';

export interface RunMeta {
  id: string;
  role: string;
  model: string;
  harness: string;
  mode: PermissionMode;
  interactive: boolean;
  session: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  degraded?: boolean;
}
