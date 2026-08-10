import type { HarnessAdapter, LaunchPlan, PlanInput } from './types.js';
import { isReadOnlyRole } from '../config.js';

/**
 * Empty, and that is the finding rather than an omission.
 *
 * `opencode run` has no approval UI. Probed against opencode 1.18 with
 * `--interactive` and `permission = { bash = "ask" }`, a tool call that needs
 * approval is not offered to the user at all — it is refused outright:
 *
 *     ! permission requested: bash (rm file.txt); auto-rejecting
 *     ✗ rm file.txt failed
 *
 * See tests/fixtures/panes/opencode-auto-reject.txt. So a `run` invocation is
 * never PAUSED: it either proceeds unasked or fails. The earlier patterns here
 * were invented rather than observed and matched none of this.
 */
const PROMPT_PATTERNS: RegExp[] = [];

function agentFor(input: PlanInput): string {
  if (input.mode === 'plan') return 'plan';
  if (input.role === 'explore') return 'explore';
  if (isReadOnlyRole(input.role)) return 'plan';
  return 'build';
}

function buildScript(input: PlanInput): LaunchPlan {
  const readOnly = isReadOnlyRole(input.role);

  // `default` means "ask before doing anything irreversible". OpenCode cannot
  // ask — it either proceeds unprompted or auto-rejects — so honouring the mode
  // is impossible. Running anyway would make a sonata subagent more permissive
  // than the session that dispatched it, silently. Refuse instead, and say why.
  //
  // Read-only roles are exempt: there is nothing for them to ask about.
  if (input.mode === 'default' && !readOnly) {
    throw new Error(
      'sonata: opencode cannot ask for approval, so it cannot honour `default` ' +
      'permission mode. Re-dispatch in acceptEdits or bypassPermissions to run ' +
      'it ungated, or use a codex model, whose TUI does prompt.',
    );
  }

  const auto = !readOnly && (input.mode === 'acceptEdits' || input.mode === 'bypassPermissions');
  const agent = agentFor(input);

  // `--interactive` selects opencode's split-footer renderer, which streams the
  // run into the pane. It does NOT make the run answerable: opencode auto-
  // rejects permission requests in `run` mode either way, so the plan reports
  // interactive: false and sonata never waits for an approval that cannot come.
  const flags = ['run', `--agent ${agent}`, `-m opencode/${input.modelId}`, '--interactive'];
  if (auto) flags.push('--auto');

  // `-f` is declared as an array option, so it greedily consumes any following
  // positional. The message MUST come before `-f` or opencode treats the prompt
  // text as a second filename and exits with "File not found".
  const script = [
    '#!/bin/bash',
    'set -o pipefail',
    'export PATH="$HOME/.opencode/bin:$PATH"',
    `cd '${input.cwd}' || exit 97`,
    `opencode ${flags.join(' ')} 'Follow the attached instructions.' -f '${input.instructionsPath}' 2>&1 | tee -a '${input.runDir}/harness.log'`,
    `echo $? > '${input.runDir}/exit'`,
    '',
  ].join('\n');

  return { script, interactive: false };
}

export const openCodeAdapter: HarnessAdapter = {
  name: 'opencode',
  versionCommand: ['opencode', '--version'],
  supportedVersions: '>=1.18.0 <2.0.0',
  pathPrepend: ['$HOME/.opencode/bin'],
  plan: buildScript,
  canPromptForApproval: false,
  promptPatterns: PROMPT_PATTERNS,
  describePrompt(): string | null {
    return null;
  },
  /** Nothing to send: `opencode run` never waits for an answer. */
  approveKeys: { yes: [], no: [] },
};
