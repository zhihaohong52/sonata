/**
 * One read per credential store per build.
 *
 * `sonata serve` asks two questions of each credential store on every build:
 * whether it answered (`credential-reads.ts` classifies that) and what it
 * holds (the readers in `codex-auth.ts`, `opencode-store.ts` and
 * `credentials.ts` parse it). Asked of two separate reads, a write landing
 * between them gets two different answers — a torn parse followed by a clean
 * classification reads as "the store answered and holds no login", which
 * ended the gateway's login and restarted LiteLLM for a write codex was
 * merely in the middle of.
 *
 * Inside `withReadSnapshot` every read of a path, and every query of a
 * database, returns what the first one returned — bytes or error — so the
 * classifier and every parser see exactly the same content. Outside one,
 * each read goes to disk, as it always has.
 *
 * Synchronous only: the scope is a module variable, which a callback that
 * awaited would leak into whatever ran in the meantime.
 */
import { readFileSync } from 'node:fs';

type Cached = { bytes: Buffer } | { error: unknown };

let active: { files: Map<string, Cached>; queries: Map<string, unknown> } | undefined;

/**
 * Runs `fn` with every `readOnce`/`queryOnce` inside it answered once per
 * key. A nested call joins the scope already open, so a build that opens one
 * around a merge and a resolution shares it with both.
 */
export function withReadSnapshot<T>(fn: () => T): T {
  if (active !== undefined) return fn();
  active = { files: new Map(), queries: new Map() };
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('withReadSnapshot takes a synchronous function');
    return result;
  } finally {
    active = undefined;
  }
}

/** `readFileSync(path)`, answered once per snapshot: a later read returns the same bytes, or throws the same error. */
export function readOnce(path: string): Buffer {
  const cache = active?.files;
  if (cache === undefined) return readFileSync(path);
  let hit = cache.get(path);
  if (hit === undefined) {
    try {
      hit = { bytes: readFileSync(path) };
    } catch (error) {
      hit = { error };
    }
    cache.set(path, hit);
  }
  if ('error' in hit) throw hit.error;
  return hit.bytes;
}

/** `run()`, answered once per snapshot under `key`; `run` must not throw. */
export function queryOnce<T>(key: string, run: () => T): T {
  const cache = active?.queries;
  if (cache === undefined) return run();
  if (cache.has(key)) return cache.get(key) as T;
  const result = run();
  cache.set(key, result);
  return result;
}
