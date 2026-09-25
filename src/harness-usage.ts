/**
 * The tokens a finished `sonata dispatch` run spent, written to the ledger.
 *
 * A dispatch run executes in the harness's own process and never transits the
 * router, so nothing observes its requests in flight. What the harness keeps
 * on disk afterwards does record them, and each adapter's `usage()` reads that
 * store; this module only turns the answer into ledger rows — once per run —
 * so `sonata usage` and `[budget] daily_usd` see the harness lane beside the
 * native one.
 *
 * Three properties are deliberate:
 *
 * - **Once per run.** `sonata tail` of a finished run re-enters the DONE
 *   branch on every call, and the ledger has no dedup, so a marker file in the
 *   run directory is claimed (exclusive create) before anything is appended.
 * - **Unknown is never zero.** An unobservable run writes no row and records
 *   why in the marker; a row whose price cannot be found is written unpriced,
 *   exactly as the router writes one.
 * - **Attributed to the project.** The row carries the tenant id the router
 *   would have given a request from this directory, so a project's own
 *   `daily_usd` counts it, not only the machine's.
 */
import { closeSync, existsSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { HarnessAdapter, UsageRecord, UsageResult } from './adapters/types.js';
import { canonicalPath, sumTokens } from './adapters/usage-files.js';
import { configPath, type NativeGatewayConfig, type SonataConfig } from './config.js';
import { appendRow, type LedgerPrice, type LedgerRow } from './ledger.js';
import { loadModelsDev, type ModelsDevCache } from './modelsdev.js';
import { canonicalConfigPath, tenantId } from './native/tenants.js';
import type { UsageTokens } from './native/usage.js';
import { resolvePrice } from './pricing.js';
import { runDir } from './store.js';
import type { RunMeta } from './types.js';

/** What `usage.json` in a run directory records. */
export type RecordedUsage =
  | { kind: 'observed'; session?: string; tokens: UsageTokens; price: LedgerPrice }
  | { kind: 'router'; session?: string }
  | { kind: 'unobservable'; reason: string };

export function usageMarkerPath(cwd: string, id: string): string {
  return join(runDir(cwd, id), 'usage.json');
}

/** The recorded answer for a run, or undefined when none has been recorded. */
export function readRecordedUsage(cwd: string, id: string): RecordedUsage | undefined {
  try {
    return JSON.parse(readFileSync(usageMarkerPath(cwd, id), 'utf8')) as RecordedUsage;
  } catch {
    return undefined;
  }
}

/**
 * The provider models.dev files a harness model under, and the model's name
 * there. Provider-qualified ids (`openrouter/kimi-k3`) name it; codex runs
 * OpenAI's models and names none; claude talks to Anthropic.
 */
function harnessProviderModel(harness: string, id: string): { provider: string; model: string } | undefined {
  if (harness === 'codex') return { provider: 'openai', model: id };
  if (harness === 'claude') return { provider: 'anthropic', model: id };
  const slash = id.indexOf('/');
  return slash > 0 ? { provider: id.slice(0, slash), model: id.slice(slash + 1) } : undefined;
}

/**
 * What a run cost, in the order that trusts sonata's own numbers first.
 *
 * 1. The config's rate for the model — a `[price]` block, or the pricing
 *    provider of a native gateway the same model is also reachable through.
 *    Priced exactly as the router prices a native request.
 * 2. The harness's own cost, when EVERY record carries one. A partial sum
 *    would under-report, which the ledger refuses to do.
 * 3. models.dev under the provider the harness id names, through the same
 *    `resolvePrice` rules (OpenRouter as last resort, coverage check) — by
 *    describing the harness model as a one-model gateway to it.
 */
export function priceHarnessRun(
  config: SonataConfig,
  meta: Pick<RunMeta, 'model' | 'harness' | 'harnessModelId'>,
  tokens: UsageTokens,
  records: readonly UsageRecord[],
  at: Date,
  modelsDev: ModelsDevCache | undefined,
): LedgerPrice {
  const own = resolvePrice(config, meta.model, tokens, at, modelsDev);
  if (own.source !== 'none') return own;

  if (records.length > 0 && records.every((record) => record.costUsd !== undefined)) {
    return { source: 'harness', totalUsd: records.reduce((sum, record) => sum + record.costUsd!, 0) };
  }

  const target = harnessProviderModel(meta.harness, meta.harnessModelId ?? meta.model);
  if (target === undefined || modelsDev === undefined) return { source: 'none' };
  const key = '__harness__';
  const synthetic: SonataConfig = {
    ...config,
    unifiedModels: { [key]: { gateway: key, id: target.model } },
    native: {
      models: {},
      ports: config.native?.ports ?? { router: 0, litellm: 0 },
      generate: config.native?.generate ?? {},
      ...config.native,
      gateways: { [key]: { baseUrl: '', auth: 'api-key', pricingProvider: [target.provider] } satisfies NativeGatewayConfig },
    },
  };
  return resolvePrice(synthetic, key, tokens, at, modelsDev);
}

/** Exclusive create: true when this caller now owns recording the run. */
function claim(path: string): boolean {
  try {
    closeSync(openSync(path, 'wx'));
    return true;
  } catch {
    return false;
  }
}

function writeMarker(path: string, value: RecordedUsage): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}

export interface RecordHarnessUsageOptions {
  cwd: string;
  home: string;
  meta: RunMeta;
  config: SonataConfig;
  adapter: Pick<HarnessAdapter, 'usage'>;
  now?: () => number;
  modelsDev?: ModelsDevCache;
}

/**
 * Read a finished run's usage and append it to the ledger, once.
 *
 * Returns what was recorded — or, when another call already recorded this
 * run, what that call recorded. Never throws: a run whose usage cannot be
 * read is still a finished run.
 */
export function recordHarnessUsage(opts: RecordHarnessUsageOptions): RecordedUsage {
  const { cwd, home, meta } = opts;
  const marker = usageMarkerPath(cwd, meta.id);
  if (existsSync(marker) || !claim(marker)) {
    return readRecordedUsage(cwd, meta.id) ?? { kind: 'unobservable', reason: 'recorded by a concurrent call' };
  }

  // The run's end is the EARLIER of the exit sentinel's mtime and the time
  // sonata recorded the run finished. Either alone can be late: `endedAt` is
  // when tail noticed, which can be long after exit; and a run directory that
  // was copied or restored (every file re-created — measured on a real run,
  // 90 minutes after it ended) carries fresh mtimes. A late end widens the
  // window over later, unrelated sessions and makes the run falsely ambiguous.
  const now = opts.now ?? Date.now;
  const ends = [now()];
  try {
    ends.push(statSync(join(runDir(cwd, meta.id), 'exit')).mtimeMs);
  } catch {
    // No sentinel to read — `endedAt` and now still bound the run.
  }
  const endedAt = meta.endedAt === undefined ? Number.NaN : Date.parse(meta.endedAt);
  if (Number.isFinite(endedAt)) ends.push(endedAt);
  const endMs = Math.min(...ends);
  const startMs = Date.parse(meta.startedAt);

  let result: UsageResult;
  try {
    result = Number.isFinite(startMs)
      ? opts.adapter.usage({
        home,
        cwd: canonicalPath(cwd),
        runDir: runDir(cwd, meta.id),
        startMs,
        endMs,
        modelId: meta.harnessModelId ?? meta.model,
        ...(meta.harnessSessionId === undefined ? {} : { sessionId: meta.harnessSessionId }),
      })
      : { kind: 'unobservable', reason: 'the run has no readable start time' };
  } catch (err) {
    result = { kind: 'unobservable', reason: `the usage reader failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (result.kind !== 'observed') {
    writeMarker(marker, result);
    return result;
  }

  const tokens = sumTokens(result.records.map((record) => record.tokens));
  const at = new Date(endMs);
  const price = priceHarnessRun(opts.config, meta, tokens, result.records, at, opts.modelsDev ?? loadModelsDev(home));
  const recorded: RecordedUsage = { kind: 'observed', session: result.session, tokens, price };
  const spent = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
  if (spent > 0) {
    const path = configPath(cwd, home);
    const row: LedgerRow = {
      ts: at.toISOString(),
      ms: Math.max(0, endMs - startMs),
      ...(result.session === undefined ? {} : { session: result.session }),
      project: cwd,
      ...(path === null ? {} : { tenant: tenantId(canonicalConfigPath(path)) }),
      alias: meta.model,
      role: meta.role,
      key: meta.model,
      ...(meta.effort === undefined ? {} : { effort: meta.effort }),
      upstream: 'harness',
      harness: meta.harness,
      run: meta.id,
      status: 200,
      complete: true,
      tokens,
      price,
      attempts: [],
    };
    try {
      appendRow(home, row);
    } catch {
      // The marker still says what was observed; a ledger sonata cannot write
      // must not turn a finished run into a failed one.
    }
  }
  writeMarker(marker, recorded);
  return recorded;
}
