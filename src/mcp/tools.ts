import { writeFileSync, statSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDef } from './protocol.js';
import { cmdRun } from '../commands/run.js';
import { cmdWait } from '../commands/wait.js';
import type { WaitResult } from '../commands/wait.js';
import { cmdApprove } from '../commands/approve.js';
import { readEvents } from '../store.js';

/**
 * Ceiling on a report returned through MCP.
 *
 * Claude Code warns above 10k tokens of tool output and caps at 25k, and a
 * result over its persist-to-disk threshold is replaced in the conversation by
 * a file reference — which stops the report being the wrapper's final message,
 * the one thing the orchestrator actually reads. 40k characters is roughly 10k
 * tokens, so an ordinary report stays inline and under the warning.
 */
export const MAX_REPORT_CHARS = 40_000;

/** Keeps the head of an oversized report and says where the whole thing is. */
export function truncateReport(report: string, id: string, max = MAX_REPORT_CHARS): string {
  if (report.length <= max) return report;
  return `${report.slice(0, max)}\n\n[truncated: full transcript at \`sonata log ${id}\`]`;
}

export interface ToolEnv {
  cwd: string;
  home: string;
  rolesDir: string;
  sessionId?: string;
  /** Test seams; production uses the real commands. */
  run?: typeof cmdRun;
  wait?: typeof cmdWait;
  approve?: typeof cmdApprove;
}

const MAX_RESULT_SIZE_CHARS = 200_000;
const REPORT_META = { 'anthropic/maxResultSizeChars': MAX_RESULT_SIZE_CHARS };

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'dispatch',
    description:
      'Run a task on a foreign model and return its report. Blocks until the run ' +
      'finishes, needs an approval, or stalls — so one call is usually the whole ' +
      'dispatch. Returns state DONE, PAUSED, STALLED or RUNNING.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'code | review | explore | plan' },
        model: { type: 'string', description: 'a model key from sonata.toml' },
        task: { type: 'string', description: 'The task text, verbatim and byte for byte. Never summarise, shorten, or rewrite it. If the caller gave you a file path instead, use task_file.' },
        task_file: { type: 'string', description: 'Path to a file holding the task. Prefer this whenever the caller gives you one: a path cannot be paraphrased, and the model receives exactly what was written. Give either task or task_file, not both.' },
        transcript: { type: 'boolean', description: 'Return the run\'s whole terminal transcript beside the report. Pass true when the caller asks to read what the model did, turn by turn; leave it out otherwise, since a transcript is far larger than a report.' },
        cwd: { type: 'string', description: 'optional existing directory in which to launch the run' },
      },
      required: ['role', 'model'],
    },
    _meta: REPORT_META,
  },
  {
    name: 'wait',
    description:
      'Resume waiting on a run already launched — after answering a PAUSED prompt, ' +
      'or when a previous call returned RUNNING. Same states as dispatch.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'the run id' },
        cwd: { type: 'string', description: 'the same directory returned by dispatch' },
        transcript: { type: 'boolean', description: 'Return the run\'s whole terminal transcript beside the report.' },
      },
      required: ['id'],
    },
    _meta: REPORT_META,
  },
  {
    name: 'approve',
    description: 'Answer a run that is PAUSED awaiting approval.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        answer: { type: 'string', description: 'yes or no' },
        cwd: { type: 'string', description: 'the same directory returned by dispatch' },
      },
      required: ['id', 'answer'],
    },
  },
];

/** Trims the report in a result, leaving every other field alone. */
function withTrimmedReport(result: WaitResult): WaitResult {
  return result.report === undefined
    ? result
    : { ...result, report: truncateReport(result.report, result.id) };
}

/** The result payload, carrying the transcript only when it was asked for. */
function withTranscript(
  result: WaitResult,
  cwd: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...result, cwd };
  if (args.transcript !== true) return payload;
  const transcript = transcriptFor(cwd, result.id, (result.report ?? '').length);
  if (transcript !== undefined) payload.transcript = transcript;
  return payload;
}

/**
 * The run's whole pane transcript, for a caller who asked to read it.
 *
 * The events file has held every line all along — this is `sonata log`'s
 * content delivered through MCP, so a wrapper can show its caller what the
 * foreign model actually did rather than only what it concluded.
 *
 * Budgeted against the report beside it, because the two share one result and
 * the report is the part that must never be pushed out. Head rather than tail:
 * the end of a run is what the report already describes, so what is missing is
 * how it got there.
 */
export function transcriptFor(
  cwd: string,
  id: string,
  reportChars: number,
  max = MAX_REPORT_CHARS,
): string | undefined {
  const lines = readEvents(cwd, id);
  if (lines.length === 0) return undefined;

  const budget = max - reportChars;
  if (budget <= 0) return `[omitted: the report used the whole result — \`sonata log ${id}\`]`;

  const text = lines.join('\n');
  return text.length <= budget
    ? text
    : `${text.slice(0, budget)}\n\n[truncated: whole transcript at \`sonata log ${id}\`]`;
}

/**
 * Where the task text comes from: an inline string, or a file the caller wrote.
 *
 * `task_file` exists because the wrapper agent is a small model relaying
 * arguments, and it paraphrases — a ~3K step-by-step spec once reached the
 * harness as a one-line summary. A path cannot be paraphrased: it either
 * arrives intact or the dispatch fails loudly. Prose asking a model not to
 * summarise is a request; this is a mechanism.
 *
 * Exactly one of the two, because silently preferring one when both are given
 * would let a paraphrased `task` win over the file the caller meant.
 */
export function resolveTaskFile(args: Record<string, unknown>, cwd: string): string {
  const inline = typeof args.task === 'string' && args.task.length > 0;
  const path = typeof args.task_file === 'string' && args.task_file.length > 0;

  if (inline && path) {
    throw new Error('sonata: give either "task" or "task_file", not both');
  }
  if (path) {
    const resolved = resolve(cwd, args.task_file as string);
    if (!existsSync(resolved)) {
      throw new Error(`sonata: task_file "${args.task_file}" does not exist`);
    }
    // Copied rather than read-and-rewritten so the bytes the caller wrote are
    // the bytes composeInstructions receives.
    return resolved;
  }
  if (!inline) {
    throw new Error('sonata: the "task" or "task_file" argument is required');
  }
  const tmp = join(tmpdir(), `sonata-task-${Date.now()}-${randomUUID().slice(0, 8)}.md`);
  writeFileSync(tmp, args.task as string);
  return tmp;
}

function need(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`sonata: the "${key}" argument is required`);
  }
  return value;
}

export function resolveToolCwd(args: Record<string, unknown>, env: ToolEnv): string {
  if (args.cwd === undefined) return env.cwd;
  if (typeof args.cwd !== 'string' || args.cwd.length === 0) {
    throw new Error('sonata: the "cwd" argument must be a non-empty directory path');
  }

  const cwd = resolve(env.cwd, args.cwd);
  try {
    if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`sonata: requested cwd "${args.cwd}" does not exist or is not a directory`);
  }
  return cwd;
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: ToolEnv,
  onLines?: (lines: string[]) => void,
): Promise<string> {
  switch (name) {
    case 'dispatch': {
      const role = need(args, 'role');
      const model = need(args, 'model');
      const cwd = resolveToolCwd(args, env);
      const taskFile = resolveTaskFile(args, cwd);
      const started = await (env.run ?? cmdRun)({
        cwd,
        role,
        model,
        taskFile,
        rolesDir: env.rolesDir,
        sessionId: env.sessionId,
      });
      const result = await (env.wait ?? cmdWait)({ cwd, id: started.id, onLines });
      return JSON.stringify(withTranscript(withTrimmedReport(result), cwd, args));
    }
    case 'wait': {
      const cwd = resolveToolCwd(args, env);
      const result = await (env.wait ?? cmdWait)({ cwd, id: need(args, 'id'), onLines });
      return JSON.stringify(withTranscript(withTrimmedReport(result), cwd, args));
    }
    case 'approve': {
      const answer = need(args, 'answer');
      if (answer !== 'yes' && answer !== 'no') {
        throw new Error('sonata: the "answer" argument must be yes or no');
      }
      await (env.approve ?? cmdApprove)({
        cwd: resolveToolCwd(args, env), id: need(args, 'id'), yes: answer === 'yes',
      });
      return 'answered';
    }
    default:
      throw new Error(`sonata: unknown tool "${name}"`);
  }
}
