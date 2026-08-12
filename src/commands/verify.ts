import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VerifyOptions { cwd: string; id: string; model?: string }

/**
 * Confirms a run actually happened, and on which model.
 *
 * The second layer under the wrapper's tool restriction: a fabricated report
 * carries no id that survives this.
 */
export function cmdVerify(opts: VerifyOptions): { ok: boolean; detail: string } {
  const dir = join(opts.cwd, '.sonata', 'runs', opts.id);
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

  const exit = meta.exitCode === undefined ? 'still running' : `exit ${meta.exitCode}`;
  return {
    ok: true,
    detail: `${opts.id}: ${meta.role} on ${meta.model} via ${meta.harness} · ${exit}` +
      (meta.degraded ? ' · degraded' : ''),
  };
}
