import { join } from 'node:path';
import type { HarnessAdapter, LaunchPlan, PlanInput, UsageQuery, UsageRecord, UsageResult } from './types.js';
import { asRecord, count, epochMs, filesIn, readJsonl } from './usage-files.js';
import { isAnthropicRoutedName, isReadOnlyRole, loadConfig } from '../config.js';
import { joinCandidate } from '../effort.js';
import { homedir } from 'node:os';
import { routerPorts } from '../commands/ports.js';

const PROMPT_PATTERNS: RegExp[] = [];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildScript(input: PlanInput): LaunchPlan {
  const readOnly = isReadOnlyRole(input.role);
  const permissionMode = readOnly ? 'plan' : input.mode;
  // The level travels in the model name, not in a flag of its own. The claude
  // harness routes through sonata's router, whose `routeRequest` already
  // splits `<key>@<effort>` off a bare model name and injects
  // `reasoning_effort` (PR 2) — so the wire path exists and a second mechanism
  // here would be one more place for the two to disagree.
  //
  // Except for an Anthropic-routed name, where that split does NOT happen:
  // `routeRequest` skips it for a `claude-` model, because such a request is
  // forwarded byte-identical to Anthropic by contract. Appending a level there
  // would not reach the splitter, it would reach Anthropic as part of the
  // model name, which rejects it — turning a working Claude dispatch into a
  // 404 for asking a question sonata cannot answer anyway. Effort for Claude
  // models is out of scope by design: Claude Code's own setting governs them.
  // So the name stays bare and the plan says the level went unhonoured, which
  // is what makes `sonata tail` annotate the report instead of lying about it.
  const anthropicRouted = isAnthropicRoutedName(input.modelId);
  const effortHonoured = !anthropicRouted;
  const flags = [
    '-p',
    `--model ${shellQuote(anthropicRouted ? input.modelId : joinCandidate(input.modelId, input.effort))}`,
    `--permission-mode ${permissionMode}`,
  ];
  // `--allowedTools <value>` (space form) is variadic in claude's own CLI
  // parser: it keeps consuming every subsequent bare argument — including
  // the prompt itself — until the next `--flag`. Probed directly: the
  // prompt text ended up split on commas/whitespace into garbage
  // "allowedTools" rules, and `-p` then had no prompt argument left at all.
  // The `=` form binds exactly one value and does not swallow what follows.
  if (readOnly) flags.push('--allowedTools=Read,Grep,Glob,Bash');
  // The session id sonata chose, so the run's transcript — and the router's
  // ledger rows, which record Claude Code's session id — name this run.
  if (input.sessionId !== undefined) flags.push(`--session-id ${shellQuote(input.sessionId)}`);

  // Resolve the actual router URL from config rather than inheriting from
  // the parent env — the parent is typically an unproxied session where
  // ANTHROPIC_BASE_URL is unset.
  let routerUrl = '';
  let contextWindow = '';
  try {
    const config = loadConfig(input.cwd, homedir());
    if (config.native) {
      routerUrl = `http://localhost:${routerPorts(homedir()).router}`;
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

  // silentUntilExit: stdout goes to last-message.txt (see the no-tee comment
  // above), so the pane stays unchanged for the whole run and pane-silence
  // stall detection would mark every long run STALLED.
  return { script, interactive: false, canWriteReport: !readOnly, silentUntilExit: true, effortHonoured };
}

/**
 * A finished run's usage.
 *
 * When the config has a native section, `plan` pointed the run at sonata's
 * router, which already wrote a ledger row for every request — reading the
 * transcript as well would count each token twice, so the answer is `router`
 * and the rows are found by session id. Otherwise the run spoke to Anthropic
 * directly and the transcript is the only record: every assistant line
 * carries its request's `message.usage`, and a streamed message can be
 * written more than once under one `message.id`, so the last copy wins.
 */
export function claudeUsage(query: UsageQuery): UsageResult {
  let routed = false;
  try {
    routed = loadConfig(query.cwd, query.home).native !== undefined;
  } catch {
    // No loadable config: the plan could not have routed it either.
  }
  if (routed) return { kind: 'router', session: query.sessionId };
  if (query.sessionId === undefined) {
    return { kind: 'unobservable', reason: 'the run was launched before sonata named its claude session' };
  }
  const name = `${query.sessionId}.jsonl`;
  const [path] = filesIn(join(query.home, '.claude', 'projects'), () => true)
    .flatMap((dir) => filesIn(dir, (file) => file === name));
  if (path === undefined) return { kind: 'unobservable', reason: 'no claude transcript was written for this run' };
  const byMessage = new Map<string, UsageRecord>();
  for (const line of readJsonl(path)) {
    const entry = asRecord(line);
    const message = asRecord(entry?.message);
    const usage = asRecord(message?.usage);
    if (entry?.type !== 'assistant' || usage === undefined) continue;
    const id = typeof message?.id === 'string' ? message.id : `${byMessage.size}`;
    byMessage.set(id, {
      ts: new Date(epochMs(entry.timestamp) ?? query.endMs).toISOString(),
      model: typeof message?.model === 'string' ? message.model : undefined,
      tokens: {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheCreation: count(usage.cache_creation_input_tokens),
      },
    });
  }
  return { kind: 'observed', session: query.sessionId, records: [...byMessage.values()] };
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
  usage: claudeUsage,
};
