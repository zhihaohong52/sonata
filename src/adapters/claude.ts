import type { HarnessAdapter, LaunchPlan, PlanInput } from './types.js';
import { isReadOnlyRole } from '../config.js';

const PROMPT_PATTERNS: RegExp[] = [];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildScript(input: PlanInput): LaunchPlan {
  const readOnly = isReadOnlyRole(input.role);
  const permissionMode = readOnly ? 'plan' : input.mode;
  const flags = [
    '-p',
    `--model ${shellQuote(input.modelId)}`,
    `--permission-mode ${permissionMode}`,
  ];
  if (readOnly) flags.push('--allowedTools Read,Grep,Glob,Bash');

  // `sonata code` supplies these values for the configured native route. Keep
  // them explicit here so the detached harness process retains that routing.
  const script = [
    '#!/bin/bash',
    'set -o pipefail',
    'export ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL"',
    'export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$CLAUDE_CODE_MAX_CONTEXT_TOKENS"',
    `cd ${shellQuote(input.cwd)} || exit 97`,
    `claude ${flags.join(' ')} "$(cat ${shellQuote(input.instructionsPath)})" 2>&1 | tee -a ${shellQuote(`${input.runDir}/harness.log`)} ${shellQuote(`${input.runDir}/report.md`)}`,
    `echo $? > ${shellQuote(`${input.runDir}/exit`)}`,
    '',
  ].join('\n');

  return { script, interactive: false, canWriteReport: !readOnly };
}

export const claudeAdapter: HarnessAdapter = {
  name: 'claude',
  versionCommand: ['claude', '--version'],
  supportedVersions: '>=2.1.0 <3.0.0',
  pathPrepend: [],
  plan: buildScript,
  canPromptForApproval: false,
  promptPatterns: PROMPT_PATTERNS,
  describePrompt(): string | null {
    return null;
  },
  approveKeys: { yes: [], no: [] },
};
