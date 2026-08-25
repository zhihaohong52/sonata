import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, harnessModelFor, resolveTierAlias } from '../config.js';
import { cmdRun } from './run.js';
import type { RunOptions } from './run.js';
import { cmdWait } from './wait.js';
import type { WaitResult } from './wait.js';

export const MAX_REPORT_CHARS = 40_000;

export function truncateReport(report: string, id: string, max = MAX_REPORT_CHARS): string {
  if (report.length <= max) return report;
  return `${report.slice(0, max)}\n\n[truncated: full transcript at \`sonata log ${id}\`]`;
}

export interface DispatchOptions {
  cwd: string;
  home: string;
  tier?: string;
  model?: string;
  task: string;
  rolesDir: string;
  sessionId?: string;
}

export interface DispatchAttempt {
  modelKey: string;
  state: string;
  degraded: boolean;
}

export interface DispatchOutcome {
  id: string;
  state: string;
  report?: string;
  modelKey: string;
  attempts: DispatchAttempt[];
  prompt?: string;
  lines?: string[];
}

interface DispatchDeps {
  run?: typeof cmdRun;
  wait?: typeof cmdWait;
}

function taskPath(cwd: string): string {
  const dir = join(cwd, '.sonata', 'tasks');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${Date.now()}.md`);
}

/** Run a ranked harness route, trying the next route only on a failed finish. */
export async function cmdDispatch(
  opts: DispatchOptions,
  deps: DispatchDeps = {},
): Promise<DispatchOutcome> {
  const config = loadConfig(opts.cwd, opts.home);
  const candidates: string[] = [];

  if ((opts.tier === undefined) === (opts.model === undefined)) {
    throw new Error('sonata dispatch requires exactly one of --tier or --model');
  }

  if (opts.tier !== undefined) {
    const alias = opts.tier.startsWith('sonata-') ? opts.tier : `sonata-${opts.tier}`;
    const resolved = resolveTierAlias(config, alias);
    if (!resolved) throw new Error(`sonata dispatch: unknown tier "${opts.tier}"`);
    for (const route of resolved.routes) {
      if (route.harness !== undefined) candidates.push(route.key);
    }
    if (candidates.length === 0) {
      throw new Error(`sonata dispatch: tier "${opts.tier}" has no harness routes`);
    }
  } else {
    if (!harnessModelFor(config, opts.model!)) {
      throw new Error(`sonata dispatch: model "${opts.model}" has no harness route`);
    }
    candidates.push(opts.model!);
  }

  const run = deps.run ?? cmdRun;
  const wait = deps.wait ?? cmdWait;
  const attempts: DispatchAttempt[] = [];
  let lastId = '';

  for (const modelKey of candidates) {
    const taskFile = taskPath(opts.cwd);
    writeFileSync(taskFile, opts.task);

    let launched: Awaited<ReturnType<typeof run>>;
    try {
      const runOpts: RunOptions = {
        cwd: opts.cwd,
        role: opts.tier?.split('-')[0] ?? 'code',
        model: modelKey,
        taskFile,
        rolesDir: opts.rolesDir,
        sessionId: opts.sessionId,
      };
      launched = await run(runOpts);
      lastId = launched.id;
    } catch (err) {
      attempts.push({ modelKey, state: 'FAILED', degraded: true });
      continue;
    }

    let result: WaitResult;
    try {
      do {
        result = await wait({ cwd: opts.cwd, id: launched.id });
      } while (result.state === 'RUNNING');
    } catch (err) {
      attempts.push({ modelKey, state: 'FAILED', degraded: true });
      continue;
    }

    const degraded = result.degraded === true;
    attempts.push({ modelKey, state: result.state, degraded });
    const emptyReport = result.state === 'DONE' && !(result.report?.trim());
    if (result.state === 'DONE' && (degraded || emptyReport)) {
      continue;
    }

    return {
      id: result.id,
      state: result.state,
      modelKey,
      report: result.report === undefined ? undefined : truncateReport(result.report, result.id),
      prompt: result.prompt ?? (result.state === 'PAUSED' && result.lines.length > 0
        ? result.lines.join('\n')
        : undefined),
      lines: result.lines,
      attempts,
    };
  }

  // Preserve the ranked failure history rather than surfacing one misleading
  // error after every route has been tried.
  return {
    id: lastId,
    state: 'FAILED',
    modelKey: candidates[candidates.length - 1] ?? '',
    attempts,
  };
}
