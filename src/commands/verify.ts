import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDir } from '../store.js';

export interface VerifyOptions { cwd: string; id: string; model?: string }

/**
 * Confirms a run actually happened, and on which model.
 *
 * The second layer under the wrapper's tool restriction: a fabricated report
 * carries no id that survives this.
 */
export function cmdVerify(opts: VerifyOptions): { ok: boolean; detail: string } {
  // Shares the store's definition rather than rebuilding the path: two copies
  // could disagree about where runs live, and this is the check that decides
  // whether a run happened at all.
  const dir = runDir(opts.cwd, opts.id);
  const metaPath = join(dir, 'meta.json');
  if (!existsSync(metaPath)) {
    return { ok: false, detail: `no run "${opts.id}" — looked in ${dir}` };
  }

  let meta: { model?: string; harness?: string; role?: string; exitCode?: number; degraded?: boolean };
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return { ok: false, detail: `run "${opts.id}" has unreadable meta.json` };
  }
  // A meta that is not an object reads every field as undefined, which looked
  // exactly like a successful verification of a run that never happened —
  // defeating the only check that a report corresponds to real work.
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { ok: false, detail: `run "${opts.id}" has unusable meta.json` };
  }
  if (typeof meta.model !== 'string') {
    return { ok: false, detail: `run "${opts.id}" names no model in meta.json` };
  }


  if (opts.model !== undefined && meta.model !== opts.model) {
    return {
      ok: false,
      detail: `run "${opts.id}" ran ${meta.model}, not ${opts.model}`,
    };
  }

  // `meta.exitCode` is written by `sonata tail`, so a run whose tail never
  // completed looks live forever — exactly the case verify exists for. The
  // exit sentinel is written by the launched shell itself and is the truth
  // about whether the process finished. Observed on 2026-08-12: a run that
  // exited 0 and wrote a full report reported "still running", because the
  // wrapper's `tail` was denied by the permission classifier mid-run.
  const exit = meta.exitCode !== undefined
    ? `exit ${meta.exitCode}`
    : sentinelExit(dir) ?? 'still running';

  const unreconciled = meta.exitCode === undefined && sentinelExit(dir) !== null
    ? ' · finished but never read back by `sonata tail`'
    : '';

  return {
    ok: true,
    detail: `${opts.id}: ${meta.role} on ${meta.model} via ${meta.harness} · ${exit}` +
      (meta.degraded ? ' · degraded' : '') + unreconciled,
  };
}

/** The exit sentinel the launched shell writes, independent of `tail`. */
function sentinelExit(dir: string): string | null {
  try {
    const raw = readFileSync(join(dir, 'exit'), 'utf8').trim();
    return /^-?\d+$/.test(raw) ? `exit ${raw}` : null;
  } catch {
    return null;
  }
}
