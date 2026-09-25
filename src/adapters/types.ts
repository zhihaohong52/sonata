import type { PermissionMode } from '../types.js';
import type { Effort } from '../effort.js';
import type { UsageTokens } from '../native/usage.js';

export interface PlanInput {
  modelId: string;
  role: string;
  mode: PermissionMode;
  cwd: string;
  runDir: string;
  instructionsPath: string;
  /**
   * The reasoning-effort level this tier candidate is pinned to, from the
   * `<key>@<effort>` grammar. Absent means the candidate states none and the
   * harness runs at its own default — exactly today's request.
   */
  effort?: Effort;
  /**
   * A session id sonata chose for this run. A harness that accepts one
   * (claude's `--session-id`) passes it on, so the run's usage can be found
   * by id rather than guessed from a directory and a time window.
   */
  sessionId?: string;
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
  /**
   * True when the harness produces no terminal output until it exits —
   * headless `claude -p` redirects its stdout to last-message.txt, so the
   * pane never changes while the run works. Pane silence is then the
   * expected shape of a healthy run, not evidence of a hang, and the stall
   * detector must not fire; the run_timeout watchdog remains the backstop.
   */
  silentUntilExit?: boolean;
  /**
   * Whether this plan actually sends `PlanInput.effort` to the harness.
   *
   * Required, not optional, because accepting the `<key>@<effort>` grammar
   * while quietly ignoring the level is the silent mismatch the whole design
   * exists to prevent — a new adapter must answer rather than inherit a
   * default. It reports a property of the HARNESS, so it is answered whether
   * or not a level was asked for; `cmdTail` reads it only when one was, and
   * annotates the report when the answer is false.
   *
   * It claims the level reaches the harness's command line, NOT that the model
   * has that level. opencode accepts an unknown `--variant` silently and
   * LiteLLM's `drop_params` drops an unsupported `reasoning_effort` the same
   * way; sonata cannot tell "honoured" from "dropped" downstream of the flag,
   * and reports what it can see rather than assuming the rest.
   */
  effortHonoured: boolean;
}

/**
 * What a finished run's usage reader is given: where and when the harness ran.
 *
 * `startMs`/`endMs` bound the run — launch, and the exit sentinel's mtime,
 * never the moment tail happened to notice the exit. `cwd` is the directory
 * the harness was launched in, already canonicalised by the caller.
 */
export interface UsageQuery {
  home: string;
  cwd: string;
  runDir: string;
  startMs: number;
  endMs: number;
  /** The harness's own model id, as the adapter's `plan` received it. */
  modelId: string;
  /** Set when sonata told the harness which session id to use (claude). */
  sessionId?: string;
}

/** One request's (or one cumulative session's) usage, as the harness recorded it. */
export interface UsageRecord {
  ts: string;
  /** The model the harness says served it, when it says. */
  model?: string;
  tokens: UsageTokens;
  /**
   * The cost the harness itself computed, in USD, when it reports one and
   * reports it completely. Absent is unknown, never zero.
   */
  costUsd?: number;
}

/**
 * The answer every adapter must give about a finished run's tokens.
 *
 * - `observed`: the harness's own store held this run's usage.
 * - `router`: the run's requests went through sonata's router, whose ledger
 *   already recorded them — reading the harness's files too would count
 *   every token twice.
 * - `unobservable`: sonata could not attribute usage to this run, and says
 *   why. Never folded in as zero: an unknown is not a free run.
 */
export type UsageResult =
  | { kind: 'observed'; records: UsageRecord[]; session?: string }
  | { kind: 'router'; session?: string }
  | { kind: 'unobservable'; reason: string };

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
  /**
   * The tokens a finished run spent, read from the harness's own store.
   *
   * Required, like `effortHonoured`: a new adapter must answer rather than
   * inherit a silent "nothing". Harness knowledge — file layout, field names,
   * cumulative vs per-request counters — lives here and nowhere else.
   * Synchronous and never throwing: a store sonata cannot read is
   * `unobservable`, not a failed run.
   */
  usage(query: UsageQuery): UsageResult;
}

export interface HarnessProblem {
  severity: 'error' | 'warn';
  message: string;
  fix?: string;
}
