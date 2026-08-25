import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig, harnessModelFor, resolveTierAlias } from '../config.js';
import { cmdRun } from './run.js';
import type { RunOptions } from './run.js';
import { cmdWait } from './wait.js';
import type { WaitResult } from './wait.js';

export const MAX_REPORT_CHARS = 40_000;

const PROVENANCE_MARKER = '\n\n— sonata ';

/**
 * Truncates a report to `max` characters, but never at the cost of the
 * closing `— sonata ...` provenance line `cmdTail` appends to every finished
 * report: generated wrappers reject a result with no such line as evidence
 * no dispatch happened, so losing it on a long-but-successful run would
 * report a real run as invalid.
 */
export function truncateReport(report: string, id: string, max = MAX_REPORT_CHARS): string {
  if (report.length <= max) return report;
  const markerIndex = report.lastIndexOf(PROVENANCE_MARKER);
  const provenance = markerIndex !== -1 ? report.slice(markerIndex) : '';
  const bodyMax = Math.max(0, max - provenance.length);
  return `${report.slice(0, bodyMax)}\n\n[truncated: full transcript at \`sonata log ${id}\`]${provenance}`;
}

export interface DispatchOptions {
  cwd: string;
  home: string;
  tier?: string;
  model?: string;
  /** Role to dispatch as — only meaningful with --model; --tier's alias already names one. */
  role?: string;
  task: string;
  rolesDir: string;
  sessionId?: string;
}

export interface DispatchAttempt {
  modelKey: string;
  state: string;
  degraded: boolean;
  /** Set when the launch or wait itself threw, before any run state existed. */
  error?: string;
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

/**
 * `Date.now()` alone collides under concurrent dispatch — two calls in the
 * same millisecond would overwrite each other's task file before either
 * launch reads it back. The random suffix makes the name unique regardless
 * of timing.
 */
export function taskPath(cwd: string): string {
  const dir = join(cwd, '.sonata', 'tasks');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}.md`);
}

/** Run a ranked harness route, trying the next route only on a failed finish. */
export async function cmdDispatch(
  opts: DispatchOptions,
  deps: DispatchDeps = {},
): Promise<DispatchOutcome> {
  const config = loadConfig(opts.cwd, opts.home);
  const candidates: string[] = [];
  let role = 'code';

  if ((opts.tier === undefined) === (opts.model === undefined)) {
    throw new Error('sonata dispatch requires exactly one of --tier or --model');
  }

  if (opts.tier !== undefined) {
    const alias = opts.tier.startsWith('sonata-') ? opts.tier : `sonata-${opts.tier}`;
    const resolved = resolveTierAlias(config, alias);
    if (!resolved) throw new Error(`sonata dispatch: unknown tier "${opts.tier}"`);
    role = resolved.role;
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
    // Unlike --tier, a bare --model key carries no role of its own — a
    // legacy config's review-<model>/explore-<model> wrapper depends on
    // this being right, since running the wrong role's prompt under a
    // read-only role's own permission policy would let it write.
    role = opts.role ?? 'code';
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
        role,
        model: modelKey,
        taskFile,
        rolesDir: opts.rolesDir,
        sessionId: opts.sessionId,
      };
      launched = await run(runOpts);
      lastId = launched.id;
    } catch (err) {
      attempts.push({
        modelKey, state: 'FAILED', degraded: true,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    let result: WaitResult;
    try {
      result = await wait({ cwd: opts.cwd, id: launched.id });
    } catch (err) {
      // The launch succeeded — the harness may still be running. Trying the
      // next candidate here would race it on the same working tree, so this
      // stops rather than falling through, surfacing the launched run's id
      // instead of silently doubling up.
      attempts.push({
        modelKey, state: 'FAILED', degraded: true,
        error: err instanceof Error ? err.message : String(err),
      });
      return { id: launched.id, state: 'FAILED', modelKey, attempts };
    }

    if (result.state === 'RUNNING') {
      // The wait window elapsed with the run still in progress — not a
      // failure, just unresolved. Return control to the caller (`sonata wait
      // <id>` resumes it) rather than reopening another full wait window,
      // which would block indefinitely and starve whatever invoked this.
      attempts.push({ modelKey, state: 'RUNNING', degraded: false });
      return { id: result.id, state: 'RUNNING', modelKey, attempts };
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
