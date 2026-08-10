import type { PermissionMode } from '../types.js';

export interface PlanInput {
  modelId: string;
  role: string;
  mode: PermissionMode;
  cwd: string;
  runDir: string;
  instructionsPath: string;
}

export interface LaunchPlan {
  /** Full bash script content, written to runDir/cmd.sh and sent via send-keys. */
  script: string;
  /** True when the harness runs a TUI that can surface approval prompts. */
  interactive: boolean;
  /**
   * False when this configuration cannot write `report.md` at all. Pi's
   * read-only tool allowlist is real enforcement: it removes the write tool,
   * which stops the model writing to the repo AND to its own report. Sonata
   * must not then call a clean run degraded — nothing went wrong.
   * Omitted means the run is expected to write a report.
   */
  canWriteReport?: boolean;
}

export interface HarnessAdapter {
  name: string;
  versionCommand: string[];
  supportedVersions: string;
  /** Extra PATH entries prepended before invoking the harness. */
  pathPrepend: string[];
  plan(input: PlanInput): LaunchPlan;
  /**
   * Whether the harness can stop and ask a human to approve an action. False
   * for opencode (auto-rejects) and pi (no permission popups by design), which
   * is why both refuse `default` mode for write-capable roles.
   */
  canPromptForApproval: boolean;
  /** Patterns indicating the harness is blocked awaiting approval. */
  promptPatterns: RegExp[];
  /** Extracts a human-readable pending action from cleaned pane lines. */
  describePrompt(lines: string[]): string | null;
  /**
   * tmux key sequences that answer a pending prompt. These are full sequences,
   * not single keys followed by an implied Enter: codex's selection lists act
   * on the accelerator immediately, and a trailing Enter would fall through to
   * the composer and submit an empty message.
   */
  approveKeys: { yes: string[]; no: string[] };
  /**
   * File inside the run directory where the harness itself writes its final
   * message, if it can. Used as a report fallback before resorting to the pane.
   */
  fallbackReportFile?: string;
  /**
   * Extra runtime checks beyond "is the binary present at a supported
   * version" — authentication, reachable endpoints, and so on. Reported by
   * `sonata doctor`.
   */
  health?(env: { home: string; cwd: string }): Promise<HarnessProblem[]>;
}

export interface HarnessProblem {
  severity: 'error' | 'warn';
  message: string;
  fix?: string;
}
