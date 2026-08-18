import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDef } from './protocol.js';
import { cmdRun } from '../commands/run.js';
import { cmdTail } from '../commands/tail.js';
import { cmdApprove } from '../commands/approve.js';

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
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'run',
    description:
      'Launch a sonata run on a foreign model and return its run id immediately. ' +
      'The run continues in the background; poll it with tail.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'code | review | explore | plan' },
        model: { type: 'string', description: 'a model key from sonata.toml' },
        task: { type: 'string', description: 'the full task text for the model' },
      },
      required: ['role', 'model', 'task'],
    },
  },
  {
    name: 'tail',
    description:
      'Poll a run for progress. Blocks until something changes or the tail window ' +
      'elapses. Returns PROGRESS, PAUSED, DONE or STALLED.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'the run id' } },
      required: ['id'],
    },
  },
  {
    name: 'approve',
    description: 'Answer a run that is PAUSED awaiting approval.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        answer: { type: 'string', description: 'yes or no' },
      },
      required: ['id', 'answer'],
    },
  },
];

function need(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`sonata: the "${key}" argument is required`);
  }
  return value;
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: ToolEnv,
): Promise<string> {
  switch (name) {
    case 'run': {
      const role = need(args, 'role');
      const model = need(args, 'model');
      const task = need(args, 'task');
      const taskFile = join(tmpdir(), `sonata-task-${Date.now()}-${randomUUID().slice(0, 8)}.md`);
      writeFileSync(taskFile, task);
      const result = await cmdRun({
        cwd: env.cwd,
        role,
        model,
        taskFile,
        rolesDir: env.rolesDir,
        sessionId: env.sessionId,
      });
      return JSON.stringify(result);
    }
    case 'tail': {
      const result = await cmdTail({ cwd: env.cwd, id: need(args, 'id'), waitSeconds: 0 });
      return JSON.stringify(result);
    }
    case 'approve': {
      const answer = need(args, 'answer');
      if (answer !== 'yes' && answer !== 'no') {
        throw new Error('sonata: the "answer" argument must be yes or no');
      }
      await cmdApprove({ cwd: env.cwd, id: need(args, 'id'), yes: answer === 'yes' });
      return 'answered';
    }
    default:
      throw new Error(`sonata: unknown tool "${name}"`);
  }
}
