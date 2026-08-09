import type { HarnessAdapter, LaunchPlan, PlanInput } from './types.js';

const PROMPT_PATTERNS: RegExp[] = [
  /\(y\/n\)/i,
  /\[y\/N\]/,
  /allow .* to /i,
  /permission denied.*approve/i,
  /press enter to continue/i,
];

function agentFor(input: PlanInput): string {
  if (input.mode === 'plan') return 'plan';
  if (input.role === 'review') return 'plan';
  return 'build';
}

function buildScript(input: PlanInput): LaunchPlan {
  const interactive = input.mode === 'default';
  const auto = input.mode === 'acceptEdits' || input.mode === 'bypassPermissions';
  const agent = agentFor(input);

  const flags = ['run', `--agent ${agent}`, `-m opencode/${input.modelId}`];
  if (auto) flags.push('--auto');
  if (interactive) flags.push('--interactive');

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

  return { script, interactive };
}

export const openCodeAdapter: HarnessAdapter = {
  name: 'opencode',
  versionCommand: ['opencode', '--version'],
  supportedVersions: '>=1.18.0 <2.0.0',
  pathPrepend: ['$HOME/.opencode/bin'],
  plan: buildScript,
  promptPatterns: PROMPT_PATTERNS,
  describePrompt(lines: string[]): string | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (PROMPT_PATTERNS.some((re) => re.test(lines[i]))) return lines[i];
    }
    return null;
  },
  approveKeys: { yes: 'y', no: 'n' },
};
