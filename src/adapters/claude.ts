import type { HarnessAdapter, LaunchPlan, PlanInput } from './types.js';
import { isReadOnlyRole, loadConfig } from '../config.js';
import { homedir } from 'node:os';

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

  // Resolve the actual router URL from config rather than inheriting from
  // the parent env — the parent is typically an unproxied session where
  // ANTHROPIC_BASE_URL is unset.
  let routerUrl = '';
  let contextWindow = '';
  try {
    const config = loadConfig(input.cwd, homedir());
    if (config.native) {
      routerUrl = `http://localhost:${config.native.ports.router}`;
      const windows = Object.values(config.native.models).map(m => m.contextWindow);
      if (windows.length > 0) contextWindow = String(Math.min(...windows));
    }
  } catch {
    // No config or no native table — the script will run claude without
    // proxy routing, which means the API rejects the unknown model id.
    // That failure is legible; swallowing here keeps the adapter from
    // crashing before it can produce it.
  }

  const envLines = routerUrl
    ? [
      `export ANTHROPIC_BASE_URL=${shellQuote(routerUrl)}`,
      ...(contextWindow ? [`export CLAUDE_CODE_MAX_CONTEXT_TOKENS=${shellQuote(contextWindow)}`] : []),
    ]
    : [];

  const script = [
    '#!/bin/bash',
    'set -o pipefail',
    ...envLines,
    `cd ${shellQuote(input.cwd)} || exit 97`,
    // No tee — both anomalies observed on this adapter (a hang, and a run
    // that fabricated instead of calling tools) happened with claude -p piped
    // through tee, and neither reproduced without it. Stdout also must NOT be
    // report.md: the instructions ask the model to Write report.md itself, and
    // two writers to one file corrupt whichever finishes second. The final
    // message lands in last-message.txt as the fallback report instead.
    `claude ${flags.join(' ')} "$(cat ${shellQuote(input.instructionsPath)})" > ${shellQuote(`${input.runDir}/last-message.txt`)} 2>&1`,
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
  fallbackReportFile: 'last-message.txt',
};
