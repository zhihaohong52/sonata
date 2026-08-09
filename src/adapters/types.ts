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
}

export interface HarnessAdapter {
  name: string;
  versionCommand: string[];
  supportedVersions: string;
  /** Extra PATH entries prepended before invoking the harness. */
  pathPrepend: string[];
  plan(input: PlanInput): LaunchPlan;
  /** Patterns indicating the harness is blocked awaiting approval. */
  promptPatterns: RegExp[];
  /** Extracts a human-readable pending action from cleaned pane lines. */
  describePrompt(lines: string[]): string | null;
  approveKeys: { yes: string; no: string };
}
