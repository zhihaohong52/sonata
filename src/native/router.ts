import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { budgetRefusal, type BudgetStatus } from '../budget.js';
import { isTierAliasShape, TIER_NAMES, tiersCollapse, type SonataConfig, type AutoRouteConfig } from '../config.js';
import type { AutoRouteRecord, LedgerRow } from '../ledger.js';
import { autoRole, cleanTask, decideTier, DecisionStore, type TierClassifier } from './auto-route.js';
import { SONATA_PROJECT_HEADER, TenantError } from './tenants.js';
import { SONATA_TOKEN_HEADER, projectHintAuthorised } from './router-token.js';
import { OPENCODE_SESSION_HEADER, type Transport } from './providers.js';
import { joinCandidate, splitCandidate, wireEffort, type Effort } from '../effort.js';
import { createUsageCollector, type UsageTokens, usageFromJsonBody } from './usage.js';
import { rewriteTextToolCallJson, rewriteTextToolCallStream, toolSchemas, type TextToolCallCounts } from './text-tool-calls.js';
import { handleUiRequest, type UiDeps } from './ui.js';

export interface TierRoute {
  key: string;
  /** The reasoning-effort level this candidate is pinned to, if any. */
  effort?: Effort;
  native?: { gateway: string; id: string; transport?: Transport; baseUrl?: string };
  harness?: { harness: string; id: string };
}

/** What the router knows about the project a request belongs to. `config` is present whenever `resolveTenant` supplied one; the default tenant has none. */
export interface RouterTenant {
  id: string;
  project?: string;
  configPath?: string;
  config?: SonataConfig;
}
export const DEFAULT_TENANT: RouterTenant = { id: 'default' };

/** The model name LiteLLM knows a tenant's key by. */
export function litellmModelName(tenant: RouterTenant, key: string): string {
  return `${tenant.id}/${key}`;
}

export interface RouterDeps {
  fetch: typeof fetch;
  anthropicBase?: string;
  litellmBase: string;
  litellmKey: string;
  log?: (line: string) => void;
  health?: boolean;
  /** Whether startup dependencies are ready for the health probe. */
  healthReady?: () => boolean;
  tenants?: () => { id: string; configPath: string | null }[];
  /**
   * A random id generated once per `cmdServe` invocation, reported on
   * `/__sonata_health` so a caller that just spawned a daemon can tell its
   * own freshly-bound instance apart from an older, stale router that
   * happens to still be answering the same port.
   */
  instanceId?: string;
  /** Resolves the tenant a request belongs to; may throw `TenantError`, which becomes a 400. Absent means single-tenant: every request is `DEFAULT_TENANT`. */
  resolveTenant?: (hint: { project?: string; session?: string }) => RouterTenant;
  /**
   * The secret a request must present to *choose* its own project. Absent means
   * no request may: the hint is ignored and resolution falls back to the
   * session registry, then the machine config. See `src/native/router-token.ts`
   * for why the hint needs authorising at all.
   */
  projectHintToken?: string;
  /** Resolves a `sonata-<role>-<tier>` alias to its ranked routes, or undefined if unknown. */
  resolveTier?: (alias: string, tenant: RouterTenant) => { role: string; tier: string; routes: TierRoute[] } | undefined;
  /** Chooses the tier for `sonata-<role>-auto`. Absent -> every auto request takes the fallback tier. */
  classifier?: TierClassifier;
  /**
   * The classifier for one project's `[auto_route]` settings — its provider
   * and decision model are per project, while one router serves them all.
   * Preferred over `classifier` when present.
   */
  classifierFor?: (settings: AutoRouteConfig) => TierClassifier | undefined;
  /**
   * Resolves a direct `--model <key>` request's key to its gateway name, so a
   * direct-model row carries `gateway` and can be priced (pricing's step 2
   * reads the gateway's own rates). Direct requests never pass through
   * `resolveTier`, so their key/gateway are the model string and whatever this
   * returns.
   */
  resolveGateway?: (key: string, tenant: RouterTenant) => string | undefined;
  /**
   * Resolves a bare `--model <key>` request's key to its native route, so a
   * key on a `direct` gateway is forwarded straight to that gateway — the same
   * path a tier candidate takes — rather than to a LiteLLM that, on a
   * direct-only config, is not running at all.
   */
  resolveNative?: (key: string, tenant: RouterTenant) => TierRoute['native'];
  /**
   * Fire-and-forget: checks whether sonata.toml's model registry has changed
   * since litellm was last (re)started, restarting it if so. Called once per
   * litellm-bound router request — both a tier request and a direct
   * `--model <key>` request — not only on tier resolution, because a direct
   * request for a newly added native-only model never goes through
   * `resolveTier` at all and would otherwise reach litellm's startup-era
   * model list until a manual `sonata restart`. Called once per request
   * rather than once per tier candidate, so a candidate skipped for being in
   * its post-failure cooldown doesn't also skip this check.
   */
  checkModelChange?: () => void;
  now?: () => number;
  /**
   * Resolves once the current litellm child is confirmed healthy (or once
   * serve has given up waiting on it). A respawn after a crash otherwise
   * leaves a brief window where litellm is not listening yet; without this,
   * a request landing in that window gets a connection-refused 502 that
   * `routeTierRequest` cannot tell apart from a genuine model failure, and
   * cools the candidate down for `TIER_COOLDOWN_MS` even though it recovers
   * moments later. Awaited before every litellm-bound request; omitted by
   * callers (and tests) that have no respawn to gate.
   */
  litellmReady?: () => Promise<void>;
  /**
   * Receives one row per request. Each invocation is isolated from routing so
   * accounting trouble can only lose its own row, never a client response.
   */
  recordUsage?: (row: LedgerRow, config?: SonataConfig) => void;
  /**
   * The daily cap and the spend against it, or `undefined` when no cap is
   * configured. Called once per request rather than read at startup, so a cap
   * raised in sonata.toml takes effect on the next request instead of needing
   * `sonata restart` — the same per-request re-read `resolveTier` does, and for
   * the same reason: the config is the user's live control surface, and a
   * setting that only applies after a restart is one they will believe is
   * broken.
   */
  budget?: (tenant: RouterTenant) => BudgetStatus[] | undefined;
  /**
   * Resolved API key per native gateway, keyed by gateway name — how
   * `forwardDirect` finds the credential to inject for a direct-transport
   * candidate. Absent or unresolved means an empty bearer, same as any other
   * unresolvable credential.
   */
  gatewayKeys?: (tenant: RouterTenant) => Record<string, string>;
  /**
   * Why serve is not serving a gateway, or undefined when it is: it was
   * dropped (two tenants' credentials conflict on it, or one child cannot
   * hold both accounts), or its credential did not resolve. A request for a
   * model on one is never forwarded: LiteLLM would serve it from whatever
   * credential it does hold — another account — and a direct gateway would
   * send the conversation with no key at all.
   */
  gatewayUnavailable?: (tenant: RouterTenant, gateway: string) => string | undefined;
  /**
   * Told when a LiteLLM response shows its ChatGPT login was refused
   * (`CHATGPT_LOGIN_REFUSED`), with what `chatgptTokenDir` answered when
   * that request was forwarded. serve marks its codex-oauth gateways
   * unavailable until LiteLLM is started on a different token and logs the
   * remedy once — unless the child that answered has since been replaced;
   * absent, the router logs the remedy itself.
   */
  chatgptLoginRefused?: (served: string | undefined) => void;
  /**
   * The ChatGPT token directory of the LiteLLM a request is forwarded to,
   * read as it is forwarded, so a refusal answered after a restart is
   * attributed to the child that gave it and not to its replacement.
   */
  chatgptTokenDir?: () => string | undefined;
  /** Why LiteLLM cannot serve right now (venv missing, broken), or undefined when it can. A litellm-bound request is answered 502 with this text rather than forwarded. */
  litellmUnavailable?: () => string | undefined;
  /**
   * Serves the local UI under `/__sonata/`. Absent means no UI -- which is what
   * every test and every non-`serve` caller gets, so the proxy path is
   * unaffected by this feature existing.
   */
  ui?: UiDeps;
  /**
   * How much of an error body the router reads, and for how long, before it
   * abandons the rest. Test seam; defaults to `ERROR_BODY_LIMITS`.
   */
  errorBodyLimits?: { maxBytes: number; timeoutMs: number };
  /**
   * How much of a non-streamed JSON reply the router reads while looking for
   * text-form tool calls, and how long it waits between chunks, before it
   * stops trying to rewrite and passes the body through untouched. Test seam;
   * defaults to `TEXT_TOOL_CALL_READ_LIMITS`.
   */
  textToolCallReadLimits?: { maxBytes: number; idleMs: number };
  /**
   * Where to write the outbound body of every 400 a tier candidate answers,
   * one 0600 file per refusal. Unset (the default) writes nothing: bodies
   * hold conversation content. `serve` sets it from `SONATA_CAPTURE_400_DIR`.
   */
  capture400Dir?: string;
}

/**
 * An error body is read only to decide what to do next (a fingerprint, a
 * rewrite) or to hand the caller the upstream's own message. Neither needs
 * more than a megabyte, and neither is worth waiting on: an upstream that
 * sends its error status and then stalls would otherwise hold the whole
 * ranked fallback on one candidate, forever.
 */
export const ERROR_BODY_LIMITS = { maxBytes: 1024 * 1024, timeoutMs: 10_000 };

/**
 * How much of a non-streamed JSON reply is read whole so it can be rewritten,
 * and how long between chunks counts as a stall. Past either the body is
 * passed through untouched — far past any reply that carries a tool call in
 * its text, and far past what rewriting needs.
 */
export const TEXT_TOOL_CALL_READ_LIMITS = { maxBytes: 64 * 1024 * 1024, idleMs: 10_000 };

export interface RouterRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  /**
   * Aborted when the client disconnects before the response starts. Passed
   * to every upstream fetch, so a request nobody is waiting for stops holding
   * an upstream connection; and a fetch it aborts is the client's doing, so
   * it is neither a candidate failure nor a ledger row (`clientGone`).
   */
  signal?: AbortSignal;
}

/**
 * The answer to a request whose client left before the response started.
 * Never written anywhere — respond sees the destroyed response and returns —
 * and never recorded: the request was abandoned, not served or refused.
 */
interface ClientGoneResponse extends RouterResponse { clientGone: true }

function clientGone(): ClientGoneResponse {
  return { status: 499, headers: {}, body: Buffer.alloc(0), clientGone: true };
}

/** Whether the client disconnected while this request was being routed. */
function clientLeft(req: RouterRequest): boolean {
  return req.signal?.aborted === true;
}

function isClientGone(response: RouterResponse): response is ClientGoneResponse {
  return (response as Partial<ClientGoneResponse>).clientGone === true;
}

export interface RouterResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array> | Buffer;
}

const HOP_BY_HOP_HEADERS = new Set([
  'content-encoding',
  'transfer-encoding',
  'content-length',
  'connection',
]);

function targetUrl(base: string, url: string): string {
  return `${base.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

function requestHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !['host', 'content-length', SONATA_PROJECT_HEADER, SONATA_TOKEN_HEADER].includes(name.toLowerCase())),
  );
}

function responseHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()].filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}

/**
 * An upstream body as an async iterable that can also be cancelled.
 *
 * `cancel` exists because a generator suspended on a read cannot be stopped
 * by `return()` — that waits for the pending read to settle, which for a
 * stalled upstream is never. Cancelling the reader settles it at once.
 */
function responseBody(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> & { cancel(): void } {
  const reader = body.getReader();
  async function* chunks(): AsyncIterable<Uint8Array> {
    let finished = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { finished = true; return; }
        yield value;
      }
    } finally {
      // Left early — the client went away, or a bounded read gave up — so the
      // upstream is cancelled rather than merely unlocked: an unlocked body
      // keeps its connection open with nobody left to read it.
      if (!finished) reader.cancel().catch(() => { /* nothing left to tell */ });
      try { reader.releaseLock(); } catch { /* already released by a cancel */ }
    }
  }
  return Object.assign(chunks(), {
    cancel: () => { reader.cancel().catch(() => { /* nothing left to tell */ }); },
  });
}

/** Test seam: an upstream body as the router wraps it. */
export const responseBodyForTest = responseBody;

/** Cancels a routed body, through any wrappers that forward `cancel`. */
function cancelBody(body: AsyncIterable<Uint8Array> | Buffer): void {
  (body as { cancel?: () => void }).cancel?.();
}

/**
 * Reads at most `maxBytes` of a body within `timeoutMs`, then abandons the
 * rest — cancelling the upstream so its connection is released rather than
 * left half-read. What was read is returned; `abandoned` says the body was
 * cut short. A failing body ends the read with what arrived before it.
 */
async function readBounded(
  body: AsyncIterable<Uint8Array> | Buffer,
  limits: { maxBytes: number; timeoutMs: number },
  keep: boolean,
): Promise<{ buf: Buffer; abandoned: boolean }> {
  if (Buffer.isBuffer(body)) return { buf: body.subarray(0, limits.maxBytes), abandoned: body.length > limits.maxBytes };
  const iterator = body[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'expired'>((resolve) => { timer = setTimeout(() => resolve('expired'), limits.timeoutMs); });
  const abandon = (): void => {
    (body as { cancel?: () => void }).cancel?.();
    void Promise.resolve(iterator.return?.()).catch(() => { /* already failing */ });
  };
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), expired]);
      if (next === 'expired') { abandon(); return { buf: Buffer.concat(chunks), abandoned: true }; }
      if (next.done === true) return { buf: Buffer.concat(chunks), abandoned: false };
      const chunk = Buffer.from(next.value);
      const room = limits.maxBytes - bytes;
      if (keep) chunks.push(chunk.subarray(0, Math.max(0, room)));
      bytes += chunk.length;
      if (bytes > limits.maxBytes) { abandon(); return { buf: Buffer.concat(chunks), abandoned: true }; }
    }
  } catch {
    return { buf: Buffer.concat(chunks), abandoned: true };
  } finally {
    clearTimeout(timer);
  }
}

async function drainBody(body: AsyncIterable<Uint8Array> | Buffer, deps: RouterDeps): Promise<void> {
  await readBounded(body, deps.errorBodyLimits ?? ERROR_BODY_LIMITS, false);
}

/**
 * Lets the client advance before inspecting its chunk. This keeps accounting
 * off the response critical path; `finally` also accounts for disconnects.
 */
function observe(
  body: AsyncIterable<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
  onEnd: (complete: boolean) => void,
): AsyncIterable<Uint8Array> & { cancel(): void } {
  async function* chunks(): AsyncIterable<Uint8Array> {
    let complete = false;
    try {
      for await (const chunk of body) {
        yield chunk;
        try {
          onChunk(chunk);
        } catch { /* A malformed frame must not interrupt the response. */ }
      }
      complete = true;
    } finally {
      try {
        onEnd(complete);
      } catch { /* Ledger failures must not escape a disconnected stream either. */ }
    }
  }
  // Forwarded, so whoever holds the outermost wrapper can still cancel the
  // upstream underneath it — `respond` does, when its client disconnects.
  return Object.assign(chunks(), { cancel: () => cancelBody(body) });
}

/** Most bytes of a non-SSE body kept to judge whether it completed. */
const COMPLETION_JSON_CAP_BYTES = 1024 * 1024;

/**
 * Calls `onEnd(true)` once the response has demonstrably completed — the
 * body was read to its end AND carried final usage (the usage recorder's own
 * "complete" signal: a `message_delta` with usage for a stream, a top-level
 * `usage` for a JSON body) — and `onEnd(false)` for anything less: a stream
 * that broke, a disconnect, or an SSE `error` event that ended it early.
 *
 * Independent of `recordUsage`, which may be absent: stickiness must not
 * depend on whether accounting is switched on.
 */
function withCompletion(response: RouterResponse, onEnd: (complete: boolean) => void): RouterResponse {
  const safe = (complete: boolean): void => {
    try { onEnd(complete); } catch { /* a bookkeeping failure never reaches the client */ }
  };
  if (Buffer.isBuffer(response.body)) {
    safe(usageFromJsonBody(response.body).complete);
    return response;
  }
  const sse = (response.headers['content-type'] ?? '').includes('text/event-stream');
  const collector = createUsageCollector();
  const json: Buffer[] = [];
  let jsonBytes = 0;
  return {
    ...response,
    body: observe(
      response.body,
      (chunk) => {
        collector.push(chunk);
        if (!sse && jsonBytes + chunk.byteLength <= COMPLETION_JSON_CAP_BYTES) {
          json.push(Buffer.from(chunk));
          jsonBytes += chunk.byteLength;
        }
      },
      (streamComplete) => {
        const usageComplete = collector.finish().complete
          || (!sse && usageFromJsonBody(Buffer.concat(json)).complete);
        safe(streamComplete && usageComplete);
      },
    ),
  };
}

interface RecordContext {
  route?: 'auto' | 'manual';
  autoRoute?: AutoRouteRecord;
  startedAt: number;
  alias: string;
  role?: string;
  tier?: string;
  key?: string;
  /** The level the request was pinned to, when the candidate carried one. */
  effort?: Effort;
  gateway?: string;
  upstream: 'litellm' | 'anthropic' | 'direct';
  attempts: { key: string; status: number }[];
  session?: string;
  project?: string;
  tenant?: string;
  /**
   * The tenant's config as it was when the request was routed — handed to
   * the recorder so the row is priced under the rules the request ran under,
   * not whatever the file says when the stream ends.
   */
  tenantConfig?: SonataConfig;
  textToolCalls?: TextToolCallCounts;
}

function headerNumber(headers: Record<string, string>, name: string): number | undefined {
  const value = Number(headers[name]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Adds accounting only when requested. The guard intentionally covers parsing,
 * timestamps, and emission: a ledger defect cannot change router behaviour.
 */
function withUsageRecording(response: RouterResponse, ctx: RecordContext, deps: RouterDeps): RouterResponse {
  if (deps.recordUsage === undefined) return response;

  try {
    const now = deps.now ?? Date.now;
    const fallbacks = headerNumber(response.headers, 'x-litellm-attempted-fallbacks');
    const retries = headerNumber(response.headers, 'x-litellm-attempted-retries');
    const emit = (tokens: UsageTokens, complete: boolean): void => {
      try {
        const endedAt = now();
        deps.recordUsage?.({
          // Priced at request start, not completion (spec §3): a stream that
          // crosses a price-window boundary must keep the rate it started
          // under. `ms` is the genuine duration and stays tied to `endedAt`.
          ts: new Date(ctx.startedAt).toISOString(),
          ms: endedAt - ctx.startedAt,
          session: ctx.session,
          project: ctx.project,
          tenant: ctx.tenant,
          alias: ctx.alias,
          role: ctx.role,
          tier: ctx.tier,
          ...(ctx.route === undefined ? {} : { route: ctx.route }),
          ...(ctx.autoRoute === undefined ? {} : { autoRoute: ctx.autoRoute }),
          key: ctx.key,
          // Only when a level was sent: an absent field means "no level was
          // asked for", which is a different fact from `effort: undefined`.
          ...(ctx.effort === undefined ? {} : { effort: ctx.effort }),
          gateway: ctx.gateway,
          upstream: ctx.upstream,
          litellmModel: response.headers['x-litellm-model-name'],
          callId: response.headers['x-litellm-call-id'],
          status: response.status,
          complete,
          tokens,
          // The router knows observations, while serve owns pricing config.
          price: { source: 'none' },
          attempts: ctx.attempts,
          litellm: fallbacks === undefined && retries === undefined
            ? undefined
            : { fallbacks: fallbacks ?? 0, retries: retries ?? 0 },
          ...(ctx.textToolCalls !== undefined && (ctx.textToolCalls.recovered > 0 || ctx.textToolCalls.unparsed > 0)
            ? { textToolCalls: { ...ctx.textToolCalls } }
            : {}),
        }, ctx.tenantConfig);
      } catch { /* Accounting is strictly best-effort. */ }
    };

    if (Buffer.isBuffer(response.body)) {
      const { tokens, complete } = usageFromJsonBody(response.body);
      emit(tokens, complete);
      return response;
    }

    const collector = createUsageCollector();
    return {
      ...response,
      body: observe(
        response.body,
        (chunk) => collector.push(chunk),
        (streamComplete) => {
          const { tokens, complete } = collector.finish();
          emit(tokens, streamComplete && complete);
        },
      ),
    };
  } catch {
    return response;
  }
}

/**
 * The model a request names, for logging which upstream served it.
 *
 * Without this the routing decision is invisible: LiteLLM's access log records
 * the path and status but not the model, so "did this agent really run on the
 * foreign model?" could only be answered by inference.
 */
export function requestedModel(body: Buffer): string | undefined {
  try {
    const model = (JSON.parse(body.toString()) as { model?: unknown }).model;
    return typeof model === 'string' ? model : undefined;
  } catch {
    return undefined;
  }
}

/** Rewrites only the `model` field of a JSON body; returns it unchanged if it does not parse. */
export function withModel(body: Buffer, model: string): Buffer {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch {
    return body;
  }
  return Buffer.from(JSON.stringify({ ...payload, model }));
}

/**
 * Pins a request to a reasoning-effort level, for a tier candidate that
 * carries one (`luna@xhigh`).
 *
 * Sets top-level `reasoning_effort` — LiteLLM's Anthropic-messages passthrough
 * reads it and maps it per provider (Responses `reasoning.effort`, Gemini
 * thinking level, xAI `reasoning_effort`) — and DELETES `thinking` and
 * `output_config.effort`. That deletion is the load-bearing part: LiteLLM
 * translates Claude Code's `thinking: {type: "adaptive"}` into
 * `reasoning_effort: medium` when it is present, so leaving both in is how an
 * explicit `xhigh` gets silently overwritten by the adaptive default. The
 * ranking scored this model at the stated level; a request that runs it at
 * another describes a different model.
 *
 * Applied on both transports. On `direct` the body is otherwise passed
 * through byte-identical because assistant blocks carry opaque vendor state;
 * one top-level key leaves those blocks untouched, and an Anthropic-wire
 * upstream ignores a key it does not know (measured 2026-09-14 against
 * DeepSeek's `/anthropic/v1/messages`: 200 with `reasoning_effort: "bogus"`).
 *
 * A bare candidate (no effort) returns the identical buffer — exactly the
 * request that shipped before levels existed. What the router cannot tell is
 * whether the upstream HONOURED the level: `drop_params: true` means a
 * provider with no effort control drops the field silently. Same class as
 * unpriced volume — recorded on the ledger row, never assumed applied.
 */
export function withEffort(body: Buffer, effort: Effort | undefined): Buffer {
  // `default` means "as the model ships", so the body is left alone — no
  // `reasoning_effort`, and `thinking` NOT stripped. Sending the literal
  // string would be wrong on the direct transport, which posts to an
  // Anthropic-native gateway that has no such field.
  const wire = wireEffort(effort);
  if (wire === undefined) return body;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch {
    return body;
  }
  const { thinking: _thinking, output_config: outputConfig, ...rest } = payload;
  const out: Record<string, unknown> = { ...rest, reasoning_effort: wire };
  if (typeof outputConfig === 'object' && outputConfig !== null && !Array.isArray(outputConfig)) {
    const { effort: _effort, ...keptConfig } = outputConfig as Record<string, unknown>;
    if (Object.keys(keptConfig).length > 0) out.output_config = keptConfig;
  }
  return Buffer.from(JSON.stringify(out));
}

export const TIER_COOLDOWN_MS = 60_000;

/**
 * How many identical capability 400s from one candidate earn it a cooldown.
 *
 * Higher than the single failure that cools a 5xx/429/401/403, because a 400
 * is ambiguous in a way those are not: it may be the request's fault. Three
 * consecutive *identically fingerprinted* rejections is strong evidence the
 * candidate cannot serve this shape at all, while still returning the first
 * two to the caller, who is the only one who can tell a genuine client error.
 */
export const TIER_CAPABILITY_400_THRESHOLD = 3;

/**
 * Statuses that are NOT retried against the next candidate, because they
 * describe the request rather than the candidate.
 *
 * 400 (bad request) and 422 (unprocessable) both mean the body sonata built
 * is wrong, so every candidate would reject it identically. Returning the
 * status hands the caller the error body that names the offending field;
 * retrying would throw that away, answer 529 instead, and cool the whole
 * tier — breaking concurrent requests that had nothing wrong with them.
 *
 * A 400 that really is candidate-specific reaches the fallback through
 * `CAPABILITY_400_SIGNATURES`, on captured evidence, never on a guess.
 *
 * 405 and 415 are the protocol-level members of the same class. The router
 * forwards the caller's method and content type unchanged, so a request that
 * reaches `/v1/messages` with an unsupported method earns a request-wide 405
 * from every candidate alike; retrying it would walk the whole tier, cool
 * every candidate, and turn a precise "method not allowed" into a generic
 * 529 saying the models are overloaded — which is the opposite of true and
 * sends the reader to the wrong place entirely.
 *
 * 413 is deliberately NOT here although it looks like a sibling. "Payload too
 * large" is a limit that *differs per model*: the next candidate may have a
 * larger context window and serve the identical request. That is the whole
 * distinction this set encodes — not "a 4xx about the request", but "an
 * answer that every candidate would give".
 */
export const TERMINAL_STATUSES: ReadonlySet<number> = new Set([400, 405, 415, 422]);

/**
 * 400 bodies that mean "this candidate cannot serve requests of this shape",
 * as opposed to "this request was malformed".
 *
 * Four entries, because four have been measured.
 *
 * `thought_signature` — Gemini 3 returns one on each function call and requires
 * it echoed back, and LiteLLM does not preserve it, so every multi-turn
 * tool-use request 400s. Probed directly on 2026-08-30: the identical two-turn
 * exchange 400s on `gemini-3.7-flash`, `gemini-3.5-flash` and
 * `gemini-flash-latest`, and returns 200 on `gemini-2.5-flash`.
 *
 * `System messages are not allowed` — the Codex backend's answer to any
 * `role: system` message. `flattenSystemBlocks` and the codex-oauth model's
 * `supports_system_message: false` were both meant to keep requests off this
 * path, and both were verified present in the running daemon; a `code-complex`
 * subagent on 2026-09-03 still died with `Received Model Group=gpt-5.6-terra`
 * and this body. So the pair is *not* sufficient, and until the remaining hole
 * is found the failure has to be survivable rather than fatal. Listing it here
 * costs a candidate that genuinely cannot serve the shape, and buys the ranked
 * fallback plus the 529 that names `sonata dispatch` — where a bare 400 kills
 * the subagent outright with a message naming neither cause nor remedy.
 *
 * `No tool output found for function call` — the Codex backend's answer when
 * the Responses `input` it was handed holds a `function_call` with no
 * `function_call_output` carrying the same `call_id`. Sonata sends a
 * well-formed Anthropic transcript: the pairing is lost inside LiteLLM's
 * translation onto the Responses API, whose own source carries a pile of
 * repair heuristics for this exact mismatch (`_ensure_tool_results_have_
 * corresponding_tool_calls`), so the remaining hole is upstream and is not
 * yet located. Listed on the same terms as the entry above — survivable
 * rather than fatal, until it is.
 *
 * Captured across four serve logs (2026-08-29, 09-10, 09-16, 09-18): 28
 * occurrences over 12 distinct `call_id`s, and **every one** on a bare
 * `gpt-5.6-*`/`gpt-6-astra` model group — the codex-oauth gateway, reached at
 * `chatgpt.com/backend-api/codex/responses`. Not once on an api-key gateway,
 * although `anexto-*`, `google-*` and `openrouter-*` candidates were serving
 * the same tiers throughout. That is what makes it a candidate-shape failure
 * and not a malformed request: another candidate serves the identical
 * transcript.
 *
 * It is also self-sustaining, which is why returning it is worse than cooling
 * it. The failing turn is never completed, so the next turn re-sends the same
 * transcript: one log has the identical `call_id` refused six times in a row.
 * Without a cooldown the conversation is wedged on that candidate until the
 * agent dies — two tier agents did, reported 2026-09-21.
 *
 * `Reasoning is mandatory` — a model whose endpoint refuses to run with
 * reasoning disabled, answering
 * `Reasoning is mandatory for this endpoint and cannot be disabled` to any
 * request carrying `reasoning_effort: none`. Reported 2026-09-21 against
 * `openrouter-z-ai-glm-5.3-flash` on `sonata-review-complex` and
 * `-review-normal`: all 24 of that model's ranked entries were pinned
 * `@none`, so every one of them 400d unconditionally.
 *
 * The root cause is fixed elsewhere — the catalog was recording "AA stated
 * no level" as `none` rather than `default`, so the model was never
 * requested at a level it can serve. This entry is the safety net for the
 * configs already written that way, which stay `@none` until their owner
 * re-proposes tiers. It is a true capability failure by the definition at
 * the top of this list: the request is well-formed, and the next candidate
 * serves it.
 *
 * Guessing at "equivalent" signatures would break this repo's evidence-over-
 * inference rule, and the cost of a wrong guess is asymmetric: a signature
 * that matches too broadly cools healthy candidates on ordinary client errors,
 * turning a legible 400 into a 529. Add an entry when a failure is captured,
 * not when one is imagined.
 */
const CAPABILITY_400_SIGNATURES = [
  'thought_signature',
  'System messages are not allowed',
  'No tool output found for function call',
  'Reasoning is mandatory',
] as const;

/**
 * Whether an upstream 400 names nothing at all about what was wrong: an empty
 * body, or a JSON object with no `error`, `message` or `detail` in it — seen
 * raw, or as the upstream detail LiteLLM's proxy embeds in its own envelope
 * (`… Error code: 400 - <detail>. Received Model Group=…`, the detail absent
 * when the upstream body was empty).
 *
 * The one definition; the tier loop's message-less fall-through keys on it.
 */
export function isMessagelessError(body: string): boolean {
  const namesNothing = (detail: string): boolean => {
    const text = detail.trim();
    if (text === '') return true;
    // Upstream detail is JSON raw, and a Python dict repr inside LiteLLM's
    // message; both quote their keys, so one pattern reads both.
    if (!text.startsWith('{')) return false;
    return !/['"](error|message|detail)['"]\s*:/.test(text);
  };
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return namesNothing(body);
  }
  const message = (doc as { error?: { message?: unknown } } | null)?.error?.message;
  if (typeof message === 'string') {
    const wrapped = /Error code: 400(?: - ([\s\S]*?))?\. Received Model Group=/.exec(message);
    return wrapped !== null && namesNothing(wrapped[1] ?? '');
  }
  return namesNothing(body);
}

/** The counter fingerprint a message-less 400 accumulates under. */
const MESSAGELESS_400_FINGERPRINT = 'message-less 400';

/**
 * Writes one refused request to `dir` for later diagnosis: the outbound body
 * exactly as the candidate received it, and the start of what it answered.
 * Opt-in, owner-only, and never fatal — a capture that cannot be written is
 * logged and the request carries on.
 */
function capture400(
  deps: RouterDeps,
  entry: { alias: string; candidate: string; status: number; outbound: Buffer; response: Buffer },
): void {
  const dir = deps.capture400Dir;
  if (dir === undefined || dir === '') return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${entry.candidate.replace(/[^A-Za-z0-9@._-]/g, '_')}.json`;
    let request: unknown;
    try { request = JSON.parse(entry.outbound.toString()); } catch { request = entry.outbound.toString(); }
    writeFileSync(join(dir, name), `${JSON.stringify({
      alias: entry.alias,
      candidate: entry.candidate,
      status: entry.status,
      response: entry.response.subarray(0, 4096).toString(),
      request,
    }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    deps.log?.(`router: could not capture a ${entry.status} to ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 400 bodies that mean "this gateway cannot serve ANY request as sonata sends
 * it" — a refusal about how the request was addressed, not its shape.
 *
 * Unlike `CAPABILITY_400_SIGNATURES` these need no run of three: every request
 * to the gateway fails identically, so the first is proof, and waiting for a
 * third means two agents die to learn what the first already said. They fall
 * through at once and cool the whole gateway, since its sibling models are
 * refused for the same reason.
 *
 * `MissingSessionID` is opencode.ai refusing a request without
 * `x-opencode-session` (measured 2026-09-26). The router now sends one, so
 * this is the backstop for when it cannot — a request with no messages and no
 * Claude Code session, or a LiteLLM that stops forwarding the header — where a
 * 400 would otherwise be terminal and kill every agent on a tier that ranks an
 * opencode.ai model first.
 */
const UNSERVABLE_400_SIGNATURES = ['MissingSessionID'] as const;

/** Module-level so a cooling-down key stays cool across requests. Test seam: `clearCooldowns()`. */
const cooldowns = new Map<string, number>();

/**
 * Cooling-down GATEWAYS, keyed `<tenantId>/<gateway>`.
 *
 * A separate map from `cooldowns` rather than a shared one with a prefix,
 * because a gateway name and a model key share no namespace and a collision
 * between them would be silent — one project's gateway called `flash` would
 * cool another's model of that name.
 *
 * Some failures say nothing about the model and everything about the account
 * behind it. An exhausted billing cap, a rejected key or a revoked token
 * cannot be model-specific, so discovering them once per model is pure waste:
 * measured 2026-09-21, one project has 5 of its 11 native models on `anexto`,
 * so an exhausted `anexto` budget cost five separate 402 refusals per
 * dispatch — each one a round trip to be told the same thing.
 */
const providerCooldowns = new Map<string, number>();

/**
 * Statuses that cool the whole gateway rather than the one candidate.
 *
 * 401/403 (the credential is rejected) and 402 (the account is out of money)
 * are account-level by construction: no model on that gateway can serve while
 * they hold.
 *
 * 429 is the uncertain member, and it is here because the alternative is
 * worse in the case that has actually been measured. A gateway may rate-limit
 * per key (provider-wide) or per model, and sonata has probed neither — so
 * this is the one entry resting on inference rather than evidence. The cost of
 * being wrong is bounded by `TIER_COOLDOWN_MS` (60s) and is asymmetric in the
 * direction chosen: treating a per-model limit as provider-wide skips healthy
 * siblings for a minute, while treating a provider-wide limit as per-model
 * pays a refusal per model on every request until it lifts. Narrow this to
 * `[401, 402, 403]` if a gateway is ever observed rate-limiting per model.
 */
const PROVIDER_SCOPED_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 429]);

/** The gateway a candidate is served by, or undefined for a harness-only route. */
function gatewayOf(route: TierRoute): string | undefined {
  return route.native?.gateway;
}

/**
 * The key a gateway's cooldown is stored under.
 *
 * Tenant-scoped, like the candidate cooldowns beside it — and deliberately
 * conservative rather than precise.
 *
 * The key store is machine-wide by gateway name, so two tenants naming
 * `acme` DO share one credential (`litellm.ts`), which means a 401 or 402
 * from one project's `acme` is usually true of the other's as well. Scoping
 * per tenant therefore costs a rediscovery on the second project.
 *
 * It is still the right side to err on, because `base_url` is per config:
 * two tenants naming `acme` may address entirely different services that
 * merely share a name, where the shared key is valid for only one. A
 * machine-wide cooldown would then silence a gateway that is perfectly
 * healthy for the other project — a silent failure — while tenant scoping
 * costs one extra round trip, which is visible and bounded by the 60s
 * window.
 */
function providerCooldownKey(tenant: RouterTenant, gateway: string): string {
  return `${tenant.id}/${gateway}`;
}

/**
 * Consecutive identical capability 400s per candidate, keyed by candidate AND
 * fingerprint. Keying by candidate alone would let two different capability
 * failures add up to a cooldown neither one earned.
 */
const capability400Counts = new Map<string, number>();

/**
 * How long a conversation stays pinned to the candidate that served it.
 *
 * Long enough to cover a subagent's whole run — the agents this protects are
 * the long multi-turn ones — and short enough that an idle entry ages out
 * rather than pinning a conversation to a model the ranking has since moved
 * on from.
 */
export const STICKY_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Cap on remembered conversations, so a long-lived router cannot grow this
 * without bound. Eviction is oldest-touched-first (Map preserves insertion
 * order and `stickySet` re-inserts), which is the right victim: a conversation
 * nobody has spoken to in a thousand others' time is over.
 */
export const STICKY_MAX_CONVERSATIONS = 1000;

/**
 * Which candidate last served a given conversation.
 *
 * Ranked fallback picks a candidate *per request*, which is correct for a
 * single request and wrong for a conversation: a transcript carrying one
 * model's extended-thinking blocks handed to a different model is rejected
 * outright — `The content[].thinking in the thinking mode must be passed back
 * to the API`, a 400 that kills the agent mid-task and reads as a defect in
 * its own work. Remembering who served a conversation lets the router prefer
 * that candidate, and lets it know when it is about to switch.
 */
const stickyCandidates = new Map<string, { key: string; at: number; prefer: boolean; served: Set<string> }>();

function stickyGet(conversation: string, at: number): { key: string; prefer: boolean; served: Set<string> } | undefined {
  const hit = stickyCandidates.get(conversation);
  if (hit === undefined) return undefined;
  if (at - hit.at > STICKY_TTL_MS) {
    stickyCandidates.delete(conversation);
    return undefined;
  }
  return hit;
}

/** Drops the least recently touched conversations beyond the cap. */
function stickyEvict(): void {
  while (stickyCandidates.size > STICKY_MAX_CONVERSATIONS) {
    const oldest = stickyCandidates.keys().next();
    if (oldest.done) return;
    stickyCandidates.delete(oldest.value);
  }
}

/** Test seam: how many conversations the router currently remembers. */
export function stickyConversationCount(): number {
  return stickyCandidates.size;
}

/** Auto-route decisions by conversation, bounded like the sticky map. */
const autoDecisions = new DecisionStore(STICKY_TTL_MS, STICKY_MAX_CONVERSATIONS);

/** Test seam. */
export function clearAutoDecisions(): void {
  autoDecisions.clear();
}

function stickySet(conversation: string, key: string, at: number): void {
  // Delete-then-set moves the entry to the end of the insertion order, so a
  // conversation still in use is never the eviction victim. `served` only
  // grows: it is every candidate whose thinking blocks may be in a transcript
  // carrying this key.
  const served = stickyCandidates.get(conversation)?.served ?? new Set<string>();
  served.add(key);
  stickyPut(conversation, { key, at, prefer: true, served });
}

/**
 * The one way an entry is written: delete-then-set, so it moves to the end of
 * the eviction order, then the cap. Both writers go through here so a
 * conversation that is still being spoken to — whether its last response
 * completed or broke — can never be aged out or evicted ahead of an idle one.
 */
function stickyPut(conversation: string, entry: { key: string; at: number; prefer: boolean; served: Set<string> }): void {
  stickyCandidates.delete(conversation);
  stickyCandidates.set(conversation, entry);
  stickyEvict();
}

/**
 * Stop *preferring* a candidate that just 400d, without forgetting that it
 * served this conversation.
 *
 * The two are different facts and the entry has to keep both. Dropping the
 * record outright — the obvious fix — reopens the hole this whole mechanism
 * exists to close: the next request would find no entry, so `foreign` would be
 * false, so the transcript would reach a different model with the 400ing
 * model's thinking blocks still in it. Preference is what must lapse; the
 * memory of whose reasoning is in the history must not.
 *
 * Only the candidate that actually holds the pin may drop it, so an older
 * concurrent request cannot clear a pin a newer one has since set.
 */
function stickyDemote(conversation: string, key: string): void {
  const hit = stickyCandidates.get(conversation);
  if (hit === undefined || hit.key !== key) return;
  hit.prefer = false;
}

/**
 * A candidate answered but its response did not complete: it may still have
 * put blocks in front of the client, so it joins `served`, but it is not
 * preferred — a stream that broke is no reason to try that candidate first.
 */
function stickyIncomplete(conversation: string, key: string, at: number): void {
  const hit = stickyCandidates.get(conversation);
  if (hit === undefined) {
    // Bounded exactly as `stickySet` is: a stream of broken responses from
    // distinct conversations must not grow this map without limit.
    stickyPut(conversation, { key, at, prefer: false, served: new Set([key]) });
    return;
  }
  hit.served.add(key);
  stickyDemote(conversation, key);
  // A broken response is still activity: refresh the age and the eviction
  // order, or a conversation whose recent turns all broke ages out and takes
  // the memory of whose thinking blocks it carries with it. The pin itself
  // (`key`, `prefer`) is left as it stands.
  stickyPut(conversation, { ...hit, at });
}

/**
 * A stable identity for the conversation this request belongs to.
 *
 * The first message is the one part of a transcript that does not change as
 * turns are appended, so hashing it gives the same answer on turn 1 and turn
 * 40. The alias and tenant join it because two roles are two conversations
 * even when their opening message is identical, and two projects are never the
 * same conversation.
 *
 * A collision — two agents genuinely opened with the same text — is NOT free.
 * The two conversations share one record of who served them, so a candidate
 * that served only the other one would otherwise look like the owner of this
 * transcript's thinking blocks, and receive another model's blocks unstripped
 * (the issue #30 failure). The record therefore keeps every candidate that has
 * served the key, and a candidate is foreign whenever any *other* has: a
 * collision strips thinking rather than keeping foreign blocks. Stripping costs
 * reasoning continuity; keeping them kills the agent. `undefined` (an
 * unparseable or empty body) simply means no stickiness, which is the
 * behaviour that shipped before this existed.
 */
export function conversationKey(body: Buffer, tenant: string, alias: string): string | undefined {
  try {
    const messages = (JSON.parse(body.toString()) as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    return createHash('sha256')
      .update(`${tenant}\u0000${alias}\u0000${JSON.stringify(messages[0])}`)
      .digest('hex')
      .slice(0, 16);
  } catch {
    return undefined;
  }
}

function isThinkingBlock(block: unknown): boolean {
  if (typeof block !== 'object' || block === null) return false;
  const type = (block as { type?: unknown }).type;
  return type === 'thinking' || type === 'redacted_thinking';
}

/**
 * Drop extended-thinking blocks a *different* model produced.
 *
 * Called only when the candidate about to serve is not the one that served
 * this conversation before. Those blocks are that other model's internal
 * reasoning: the new model cannot read them, and several upstreams reject the
 * whole request rather than ignore them. `redacted_thinking` carries opaque
 * vendor state the producing upstream requires echoed back exactly — which is
 * precisely why it cannot travel to a different vendor.
 *
 * Assistant *text* and tool_use blocks are untouched, so the conversation's
 * actual content survives; what is lost is reasoning the new model was never
 * going to be able to use. The alternative is not a richer transcript, it is a
 * 400.
 *
 * An assistant turn left with no content at all is dropped rather than sent
 * empty: an empty content array is itself a 400, and a turn that was nothing
 * but thinking carried nothing the next model can act on.
 */
export function stripForeignThinking(body: Buffer): Buffer {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch {
    return body;
  }
  const messages = payload.messages;
  if (!Array.isArray(messages)) return body;

  let changed = false;
  const out: unknown[] = [];
  for (const message of messages) {
    const record = typeof message === 'object' && message !== null ? message as Record<string, unknown> : undefined;
    if (record === undefined || record.role !== 'assistant' || !Array.isArray(record.content)) {
      out.push(message);
      continue;
    }
    const kept = record.content.filter((block) => !isThinkingBlock(block));
    if (kept.length === record.content.length) {
      out.push(message);
      continue;
    }
    changed = true;
    if (kept.length > 0) out.push({ ...record, content: kept });
  }
  if (!changed) return body;
  return Buffer.from(JSON.stringify({ ...payload, messages: out }));
}

function hasToolName(block: Record<string, unknown>): boolean {
  return typeof block.name === 'string' && block.name.length > 0;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text : ''))
      .join('');
  }
  return '';
}

/**
 * Turn a tool call with no name — and the result answering it — into text.
 *
 * A model can emit one: measured on 2026-09-25 (#66), mimo-v2.6-pro through
 * OpenRouter split one call's arguments into a second call whose name was
 * empty. Claude Code runs it, answers "No such tool available", and then
 * replays it on every later request of the conversation. OpenAI-format
 * validation refuses a nameless tool call outright, so every upstream behind
 * LiteLLM answers 400 — a 400 the fallback loop rightly treats as final, since
 * the next candidate is sent the same transcript. The agent died on its very
 * next turn, twice.
 *
 * Text, not deletion: the turn stays the same length and in the same order,
 * a paired result can never be orphaned, and the model still reads that it
 * made a call that went nowhere. Surviving tool_results are kept ahead of the
 * note that replaces an orphaned one, because Anthropic requires a user turn's
 * tool_result blocks to lead it.
 *
 * Applied on every path, direct included: a nameless call is invalid for any
 * upstream. A body with nothing to repair is returned as the same buffer, so
 * the byte-identical contract holds for every healthy request.
 */
export function repairNamelessToolCalls(body: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString());
  } catch {
    return body;
  }
  // `null`, a number or an array is valid JSON with no `messages` to read —
  // pass it through for the upstream to answer rather than throwing here.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return body;
  const payload = parsed as Record<string, unknown>;
  const messages = payload.messages;
  if (!Array.isArray(messages)) return body;

  const removed = new Set<string>();
  // Tracked apart from `removed`: a nameless call with no string id has no
  // result to match, but it is still repaired, and must still be sent.
  let repairedAny = false;
  const assistantsRepaired = messages.map((message) => {
    const record = typeof message === 'object' && message !== null ? message as Record<string, unknown> : undefined;
    if (record?.role !== 'assistant' || !Array.isArray(record.content)) return message;
    let touched = false;
    const content = record.content.map((block) => {
      const b = typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined;
      if (b?.type !== 'tool_use' || hasToolName(b)) return block;
      touched = true;
      repairedAny = true;
      if (typeof b.id === 'string') removed.add(b.id);
      return { type: 'text', text: '[sonata: removed a tool call with no name — it could not have run]' };
    });
    return touched ? { ...record, content } : message;
  });
  if (!repairedAny) return body;

  const repaired = assistantsRepaired.map((message) => {
    const record = typeof message === 'object' && message !== null ? message as Record<string, unknown> : undefined;
    if (record?.role !== 'user' || !Array.isArray(record.content)) return message;
    const results: unknown[] = [];
    const notes: unknown[] = [];
    const rest: unknown[] = [];
    let touched = false;
    for (const block of record.content) {
      const b = typeof block === 'object' && block !== null ? block as Record<string, unknown> : undefined;
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string' && removed.has(b.tool_use_id)) {
        touched = true;
        notes.push({ type: 'text', text: `[sonata: the removed call's result was: ${resultText(b.content)}]` });
      } else if (b?.type === 'tool_result') {
        results.push(block);
      } else {
        rest.push(block);
      }
    }
    return touched ? { ...record, content: [...results, ...notes, ...rest] } : message;
  });
  return Buffer.from(JSON.stringify({ ...payload, messages: repaired }));
}

/**
 * Test seam: every scrap of per-candidate and per-conversation memory the
 * router accumulates. Sticky pins are cleared alongside the cooldowns because
 * a conversation pinned by one test would otherwise steer the next one's
 * candidate ordering.
 */
export function clearCooldowns(): void {
  cooldowns.clear();
  providerCooldowns.clear();
  capability400Counts.clear();
  stickyCandidates.clear();
}

/** Which capability failure this 400 body is, or undefined if it is not one. */
function capability400Fingerprint(body: string): string | undefined {
  return CAPABILITY_400_SIGNATURES.find((signature) => body.includes(signature));
}

/** Reads a response body into a Buffer, bounded by `ERROR_BODY_LIMITS`. */
async function bufferBody(body: AsyncIterable<Uint8Array> | Buffer, deps: RouterDeps): Promise<Buffer> {
  return (await readBounded(body, deps.errorBodyLimits ?? ERROR_BODY_LIMITS, true)).buf;
}

/**
 * Every chunk already read, in order, then the rest of the same iterator —
 * never a fresh read of the upstream. `cancel` forwards to the body it wraps,
 * so a client that leaves still releases the connection.
 */
function passThroughFrom(
  buffered: readonly Buffer[],
  iterator: AsyncIterator<Uint8Array>,
  body: AsyncIterable<Uint8Array>,
  pending?: Promise<IteratorResult<Uint8Array>>,
): AsyncIterable<Uint8Array> & { cancel(): void } {
  async function* chunks(): AsyncIterable<Uint8Array> {
    for (const chunk of buffered) yield chunk;
    let next = await (pending ?? iterator.next());
    while (next.done !== true) {
      yield next.value;
      next = await iterator.next();
    }
  }
  return Object.assign(chunks(), { cancel: () => cancelBody(body) });
}

/**
 * A finished document is read whole so it can be rewritten; past the cap, or
 * when the upstream stalls, it is passed through untouched rather than held or
 * failed. `ERROR_BODY_LIMITS` were sized for error bodies and would cut a
 * larger reply off mid-document, so this bound is far higher — and unlike
 * those it never cancels or abandons the upstream: a body given up on is one
 * the client is still owed.
 */
async function readWholeOrPassThrough(
  body: AsyncIterable<Uint8Array>,
  limits: { maxBytes: number; idleMs: number },
): Promise<{ whole: Buffer } | { passThrough: AsyncIterable<Uint8Array> & { cancel(): void } }> {
  const iterator = body[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    const pending = iterator.next();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idle = new Promise<'idle'>((resolve) => { timer = setTimeout(() => resolve('idle'), limits.idleMs); });
    let next: IteratorResult<Uint8Array> | 'idle';
    try {
      next = await Promise.race([pending, idle]);
    } finally {
      clearTimeout(timer);
    }
    if (next === 'idle') {
      // The read already in flight is the passthrough's first result, not a
      // fresh `next()`; the catch only keeps a late rejection from being
      // unhandled before the passthrough awaits it.
      pending.catch(() => { /* surfaced where the passthrough awaits it */ });
      return { passThrough: passThroughFrom(chunks, iterator, body, pending) };
    }
    if (next.done === true) return { whole: Buffer.concat(chunks) };
    const chunk = Buffer.from(next.value);
    chunks.push(chunk);
    bytes += chunk.length;
    if (bytes > limits.maxBytes) return { passThrough: passThroughFrom(chunks, iterator, body) };
  }
}

/**
 * Recovers tool calls a model wrote as text, on a 200 from LiteLLM (spec
 * docs/superpowers/specs/2026-10-02-text-tool-calls-design.md). Fills
 * `counts` once the body has been read: at stream end for SSE, at once for
 * JSON. Calls `onUnparsed` when a call could not be recovered. Any other
 * status or content type passes through untouched and unbuffered.
 */
async function recoverTextToolCalls(
  response: RouterResponse,
  req: RouterRequest,
  deps: RouterDeps,
  counts: TextToolCallCounts,
  onUnparsed?: (unparsed: number) => void,
): Promise<RouterResponse> {
  if (response.status !== 200) return response;
  const tools = toolSchemas(req.body);
  const settle = (found: TextToolCallCounts): void => {
    counts.recovered = found.recovered;
    counts.unparsed = found.unparsed;
    if (found.unparsed > 0) onUnparsed?.(found.unparsed);
  };
  const type = response.headers['content-type'] ?? '';
  if (type.includes('text/event-stream') && !Buffer.isBuffer(response.body)) {
    return { ...response, body: rewriteTextToolCallStream(response.body, tools, settle) };
  }
  if (!type.includes('application/json')) return response;
  let read: { whole: Buffer } | { passThrough: AsyncIterable<Uint8Array> & { cancel(): void } };
  try {
    read = Buffer.isBuffer(response.body)
      ? { whole: response.body }
      : await readWholeOrPassThrough(response.body, deps.textToolCallReadLimits ?? TEXT_TOOL_CALL_READ_LIMITS);
  } catch (error) {
    // The client left while the body was still arriving: the same answer
    // every other forwarding path gives, and like those, no ledger row.
    if (clientLeft(req)) return clientGone();
    throw error;
  }
  // A body the bounded read gave up on is served as it arrived, with nothing
  // recovered and `counts` left at zero.
  if ('passThrough' in read) return { ...response, body: read.passThrough };
  const { body, counts: found } = rewriteTextToolCallJson(read.whole, tools);
  settle(found);
  return { ...response, body };
}

/**
 * An Anthropic-shaped error body: `{"type":"error","error":{"type":...,
 * "message":...}}`. An Anthropic-compatible client (Claude Code included)
 * expects this exact envelope on every path — a flat `{type, message}` or a
 * bare `{error: {...}}` with no top-level `type: "error"` is silently
 * discarded, surfacing a generic error instead of the actual message (in
 * particular, the fallback command a tier's 529 names to activate harness
 * dispatch).
 */
function anthropicErrorBody(type: string, message: string): Buffer {
  return Buffer.from(JSON.stringify({ type: 'error', error: { type, message } }));
}

function isClaudeRequest(body: Buffer): boolean {
  try {
    return JSON.parse(body.toString()).model?.startsWith('claude-') === true;
  } catch {
    return true;
  }
}

/**
 * Flattens an Anthropic `system` block array into a single string.
 *
 * Claude Code always sends `system` as an array of text blocks. LiteLLM turns a
 * *string* system prompt into a `developer` message, which the Codex backend
 * accepts, but leaves block arrays as role `system` — and that backend answers
 * `{"detail":"System messages are not allowed"}`, a 400 naming neither the
 * field nor the shape. Probed directly: a string system prompt succeeds, the
 * identical text as a one-element array fails.
 *
 * So the array is joined here, before LiteLLM sees it. The text is unchanged
 * and its order preserved; only the shape differs, and the string form is the
 * one both sides agree on. `cache_control` is dropped with the blocks, which
 * costs prompt caching on this path — the alternative is a request that cannot
 * be sent at all.
 *
 * Returns the body untouched unless it is JSON with a non-empty `system` array:
 * an empty array is already accepted, and a non-JSON body is not ours to parse.
 */
export function flattenSystemBlocks(body: Buffer): Buffer {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch {
    return body;
  }
  const system = payload.system;
  if (!Array.isArray(system) || system.length === 0) return body;

  const text = system
    .map((block) => {
      if (typeof block === 'string') return block;
      const { type, text: blockText } = (block ?? {}) as { type?: unknown; text?: unknown };
      // Only text blocks carry a prompt. Anything else (an image, a shape added
      // later) has no string form, so leaving the body alone is safer than
      // silently dropping content.
      return type === 'text' && typeof blockText === 'string' ? blockText : null;
    })
    .filter((part): part is string => part !== null);

  if (text.length !== system.length) return body;
  return Buffer.from(JSON.stringify({ ...payload, system: text.join('\n\n') }));
}

/**
 * Whether a JSON-Schema `pattern` uses a Unicode property escape (`\p{..}` /
 * `\P{..}`). Backslash parity is honoured: `\\p` is a literal backslash then
 * `p`, which every dialect accepts.
 */
export function usesUnicodePropertyEscape(pattern: string): boolean {
  return /(?<!\\)(?:\\\\)*\\[pP]/.test(pattern);
}

/**
 * Strips, from every tool's `input_schema`, each `pattern` that Python's `re`
 * cannot parse — and only those.
 *
 * A tool schema may constrain a string with `\p{Cc}`-style Unicode property
 * classes. JavaScript and Anthropic accept them. An OpenAI-style endpoint
 * validates each tool's parameters as JSON Schema with `format: regex`, and
 * the reference validator runs that check on Python's `re`, which has no
 * `\p{..}` at all — so Azure answered a `code-simple` request with 400
 * `'^(?!__.*__$)[^\p{Cc}…' is not a 'regex'` (`tools[1].parameters`), LiteLLM
 * reported no fallback, and the agent died on its first request (measured
 * 2026-09-09).
 *
 * **The instance that prompted this is fixed upstream, and the transform is
 * still needed.** That 400 came from Claude Code's own Artifact tool, whose
 * schema Claude Code 2.1.268 corrected. Two reasons this does not follow it
 * into the bin. Claude Code fixed the tools *it* ships; a tool contributed by
 * an **MCP server** can carry the same pattern, reaches the same validator,
 * and fails the same way — and sonata forwards those schemas untouched
 * otherwise. And sonata is installed from npm against whatever Claude Code
 * the user already has, so a session on 2.1.265–2.1.267 still sends the old
 * schema. Since this walks every tool rather than a named one, it covers both
 * without knowing either.
 *
 * (Read-only roles never hit the original case, because their agents carry an
 * explicit `tools:` allowlist that omitted Artifact; write roles inherit
 * everything, on purpose.)
 *
 * Dropping the constraint costs one server-side validation the model was never
 * going to rely on; the alternative is a request that cannot be sent. Every
 * other pattern is kept, so this cannot loosen a schema the upstream accepts.
 * Applied on the litellm path only — an Anthropic request stays byte-identical,
 * and the direct path is a pass-through by contract (see `forwardDirect`).
 * Returns the body untouched, same bytes, when there is nothing to strip.
 */
export function sanitizeToolSchemas(body: Buffer): Buffer {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch {
    return body;
  }
  const tools = payload.tools;
  if (!Array.isArray(tools) || tools.length === 0) return body;

  let changed = false;
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // Only a string-valued `pattern` is the regex keyword; a *property*
      // named `pattern` is an object under `properties` and is left alone.
      if (key === 'pattern' && typeof value === 'string' && usesUnicodePropertyEscape(value)) {
        changed = true;
        continue;
      }
      out[key] = strip(value);
    }
    return out;
  };
  const next = tools.map((tool) => {
    if (tool === null || typeof tool !== 'object' || !('input_schema' in tool)) return tool;
    return { ...(tool as Record<string, unknown>), input_schema: strip((tool as { input_schema: unknown }).input_schema) };
  });
  if (!changed) return body;
  return Buffer.from(JSON.stringify({ ...payload, tools: next }));
}

/**
 * Rewrites every `role: "system"` turn inside `messages` to a `user` turn,
 * content and position untouched.
 *
 * Claude Code 2.1.266 sends mid-conversation system messages ("the system may
 * send updates, reminders, or modifications to rules via mid-conversation
 * system turns") as a `role: "system"` entry in `messages`, which Anthropic
 * accepts. Captured 2026-09-09 through a logging proxy: `messageRoles:
 * ["user","system"]` on the very first request of a `claude -p` session.
 * LiteLLM's Anthropic adapter forwards that turn as a system-role chat message,
 * its chat→responses bridge turns a block-content system message into a
 * system-role *input item*, and the Codex backend answers
 * `{"detail":"System messages are not allowed"}`. Neither
 * `flattenSystemBlocks` nor `supports_system_message: false` looks at
 * `messages`, which is why the pair was measured necessary but not sufficient
 * (HANDOFF, 2026-09-03). Probed directly against the live LiteLLM child: a
 * string `system` with no system turn streams fine; the identical request plus
 * a system turn 400s.
 *
 * `user` is the role LiteLLM's own `map_system_message_pt` demotes to, and a
 * reminder addressed to the model reads the same from either. Litellm path
 * only; Anthropic keeps its own shape byte-identical.
 */
export function demoteSystemTurns(body: Buffer): Buffer {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString()) as Record<string, unknown>;
  } catch {
    return body;
  }
  const messages = payload.messages;
  if (!Array.isArray(messages)) return body;
  let changed = false;
  const next = messages.map((message) => {
    if (message === null || typeof message !== 'object' || (message as { role?: unknown }).role !== 'system') return message;
    changed = true;
    return { ...(message as Record<string, unknown>), role: 'user' };
  });
  if (!changed) return body;
  return Buffer.from(JSON.stringify({ ...payload, messages: next }));
}

/**
 * The one definition of what a Claude Code request needs before LiteLLM may
 * see it — both litellm forwarding paths take this, so they cannot drift.
 */
function litellmBody(body: Buffer): Buffer {
  return demoteSystemTurns(sanitizeToolSchemas(flattenSystemBlocks(body)));
}

/**
 * What a LiteLLM response's error message says when its ChatGPT login has
 * been refused.
 *
 * LiteLLM 1.98.0 never surfaces the refused refresh itself: `get_access_token`
 * catches it, logs "re-login required" to its own stderr (which serve reads —
 * see `LITELLM_CHATGPT_LOGIN_REFUSED`), and falls into a device-code login.
 * What reaches the router is how THAT ends, rendered by LiteLLM's proxy into
 * its error envelope's `error.message`. Measured through a real 1.98.0 proxy
 * (tests/fixtures/litellm/chatgpt-refresh-refused-proxy.json) the answer is a
 * 400 whose message is
 * `litellm.BadRequestError: GetLLMProvider Exception - ` followed by the
 * authenticator's own `litellm.AuthenticationError: Polling failed: …`,
 * `litellm.AuthenticationError: Timed out waiting for device authorization`,
 * or a bare `Failed to request device code: …`. The infix is optional, so the
 * authenticator's error rendered on its own (`litellm.AuthenticationError:
 * Polling failed: …`, as it is raised) matches too. Anchored at the start of the
 * message — never a substring anywhere, since an unrelated upstream error
 * that merely mentions a re-login must not take ChatGPT down — and consulted
 * only for a candidate on a codex-oauth gateway.
 */
const CHATGPT_LOGIN_REFUSED = new RegExp(
  '^litellm\\.\\w+Error: (?:GetLLMProvider Exception - )?(?:litellm\\.\\w+Error: )?' +
  '(?:Polling failed: |Timed out waiting for device authorization|Failed to request device code: )',
);

/** Whether a LiteLLM error body's envelope message is `CHATGPT_LOGIN_REFUSED`. */
function chatgptLoginRefused(text: string): boolean {
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } } | null)?.error?.message;
    return typeof message === 'string' && CHATGPT_LOGIN_REFUSED.test(message);
  } catch {
    return false;
  }
}

/** Whether `gateway` is a ChatGPT-subscription gateway in this tenant's config. */
function isCodexOauth(tenant: RouterTenant, gateway: string | undefined): boolean {
  return gateway !== undefined && tenant.config?.native?.gateways[gateway]?.auth === 'codex-oauth';
}

/**
 * What `forwardToLitellm` answers. `loginRefused` marks a response that showed
 * LiteLLM's ChatGPT login was refused: it is not the request's fault and no
 * other request will do better through that gateway, so no caller hands it
 * back as it arrived — the tier loop moves on, the bare path answers the
 * named 502 (`loginRefusedMessage`).
 */
interface LitellmResponse extends RouterResponse {
  loginRefused?: true;
  /**
   * The refusal came from a LiteLLM that has since been replaced
   * (`chatgptTokenDir` answers differently now than when it was forwarded):
   * it says nothing about the child serving now, so nothing is cooled for it.
   */
  replaced?: true;
}

/**
 * Why a candidate on `gateway` is not served after its ChatGPT login was
 * refused: serve's own `gatewayUnavailable` message, which is what every
 * later request on the gateway is answered with, so the request that noticed
 * reads the same. With no serve to mark it, the router's own remedy.
 */
function loginRefusedMessage(deps: RouterDeps, tenant: RouterTenant, gateway: string): string {
  return deps.gatewayUnavailable?.(tenant, gateway) ??
    `gateway "${gateway}": LiteLLM's ChatGPT login was refused by OpenAI — run ` +
    '`codex login` (or `opencode auth login`) and then `sonata restart`';
}

/**
 * Forwards an already-litellm-shaped request (auth swapped, system flattened,
 * model rewritten if this is a tier candidate) and applies the 500->529
 * empty-completion rewrite. Shared by the plain litellm path and the tier
 * fallback loop so the two forwarding paths cannot drift apart.
 */
async function forwardToLitellm(
  body: Buffer,
  headers: Record<string, string>,
  req: RouterRequest,
  deps: RouterDeps,
  /** The candidate is on a codex-oauth gateway: only then is a refused ChatGPT login looked for. */
  chatgpt = false,
): Promise<LitellmResponse> {
  try {
    await deps.litellmReady?.();
    const served = chatgpt ? deps.chatgptTokenDir?.() : undefined;
    const response = await deps.fetch(
      targetUrl(deps.litellmBase, req.url),
      { method: req.method, headers, body: body.length > 0 ? body as unknown as BodyInit : undefined, signal: req.signal },
    );
    // LiteLLM returns 500 when ChatGPT's Codex endpoint yields output:[]. That
    // usually means the upstream was overloaded and returned an empty completion
    // rather than a real error. Re-emitting it as 529 (overloaded) lets Claude
    // Code treat it as a retriable backpressure signal rather than a hard fault.
    // For a ChatGPT candidate, a 400, 401 or 500 is also where LiteLLM
    // reports how its fallback to a device-code login ended after a refresh it
    // could not make, which only a re-login and a restart (a fresh seed) can
    // mend. Measured, it is a 400.
    if (response.status === 500 || (chatgpt && (response.status === 400 || response.status === 401))) {
      const responseBodyBuf = response.body === null
        ? Buffer.alloc(0)
        : await bufferBody(responseBody(response.body), deps);
      const text = responseBodyBuf.toString();
      const refused = chatgpt && chatgptLoginRefused(text);
      if (refused && deps.chatgptLoginRefused !== undefined) {
        deps.chatgptLoginRefused(served);
      } else if (refused) {
        deps.log?.(
          `router: LiteLLM's ChatGPT login was refused by OpenAI (${requestedModel(body) ?? '?'}) — run ` +
          '`codex login` (or `opencode auth login`) and then `sonata restart`: serve copies a ChatGPT token ' +
          'into LiteLLM only when it starts LiteLLM',
        );
      }
      if (refused) {
        const replaced = deps.chatgptTokenDir !== undefined && deps.chatgptTokenDir() !== served;
        return {
          status: response.status, headers: responseHeaders(response.headers), body: responseBodyBuf, loginRefused: true,
          ...(replaced ? { replaced: true as const } : {}),
        };
      }
      if (response.status === 500 && text.includes('Unknown items in responses API response')) {
        const msg = 'upstream returned empty completion (overloaded) — retry';
        deps.log?.(`router: 500 from litellm rewritten to 529 (${requestedModel(body) ?? '?'}): empty output`);
        return {
          status: 529,
          headers: { 'content-type': 'application/json' },
          body: anthropicErrorBody('overloaded_error', msg),
        };
      }
      return {
        status: response.status,
        headers: responseHeaders(response.headers),
        body: responseBodyBuf,
      };
    }
    return {
      status: response.status,
      headers: responseHeaders(response.headers),
      body: response.body === null ? Buffer.alloc(0) : responseBody(response.body),
    };
  } catch (error) {
    if (clientLeft(req)) return clientGone();
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: anthropicErrorBody('router_error', message),
    };
  }
}

function litellmHeaders(headers: Record<string, string>, litellmKey: string): Record<string, string> {
  const out = { ...headers };
  for (const name of Object.keys(out)) {
    if (name.toLowerCase() === 'authorization' || name.toLowerCase() === 'x-api-key') delete out[name];
  }
  out.authorization = `Bearer ${litellmKey}`;
  return out;
}

/**
 * Names the conversation to an upstream that routes by one, and sends LiteLLM
 * no other client `x-*` header.
 *
 * The session is set on every request to LiteLLM, which forwards it only to
 * the model groups `litellmConfig` lists — opencode.ai's, which refuse a
 * request without it. The value is the conversation key where there is one,
 * because that is stable across a transcript's turns (what the upstream's
 * prompt cache needs) and distinct between two subagents of one Claude
 * session, which Claude Code's own session id is not. Failing that, the
 * session id; failing both, nothing, and the upstream's refusal reaches the
 * fallback below.
 *
 * Every other `x-*` header is dropped, AFTER the session is read from them:
 * for those model groups LiteLLM forwards every client `x-*` header upstream,
 * and Claude Code's session id and metadata are not a third party's business.
 * Nothing on the LiteLLM path reads them — the router takes its own session
 * from the incoming request, not from this copy.
 */
function withSessionHeader(
  headers: Record<string, string>,
  conversation: string | undefined,
): Record<string, string> {
  const session = conversation ?? headers['x-claude-code-session-id'];
  const out = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !name.toLowerCase().startsWith('x-')),
  );
  if (session !== undefined) out[OPENCODE_SESSION_HEADER] = session;
  return out;
}

/**
 * Forwards straight to an Anthropic-native gateway, no LiteLLM in the path.
 *
 * The body is passed through UNMODIFIED — no `flattenSystemBlocks`. An
 * Anthropic upstream understands block arrays, so flattening would discard
 * `cache_control` for nothing. Assistant blocks in particular must survive
 * byte-identical: `redacted_thinking` carries opaque vendor state the
 * upstream requires echoed back exactly.
 *
 * Auth is the security boundary, not hygiene: the caller's credential is
 * Claude Code's own Anthropic credential, and forwarding it to a third-party
 * gateway would be a leak. It is stripped and replaced with the gateway's own
 * key, the same way `litellmHeaders` swaps in the litellm master key.
 */
async function forwardDirect(
  body: Buffer,
  gw: { baseUrl: string; key: string; authHeader?: string },
  req: RouterRequest,
  deps: RouterDeps,
): Promise<RouterResponse> {
  const headers = requestHeaders(req.headers);
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'authorization' || name.toLowerCase() === 'x-api-key') delete headers[name];
  }
  if ((gw.authHeader ?? 'authorization').toLowerCase() === 'x-api-key') headers['x-api-key'] = gw.key;
  else headers.authorization = `Bearer ${gw.key}`;

  // A gateway's configured `base_url` already ends in `/v1` (the same
  // convention `native/models.ts`'s `modelsUrl` relies on), while `req.url`
  // is itself `/v1/messages` — joining both verbatim would send
  // `.../v1/v1/messages`. Strip the trailing `/v1` sonata added so the
  // request lands where the gateway actually is.
  const base = gw.baseUrl.replace(/\/v1\/?$/, '');

  try {
    const response = await deps.fetch(
      targetUrl(base, req.url),
      { method: req.method, headers, body: body.length > 0 ? body as unknown as BodyInit : undefined, signal: req.signal },
    );
    return {
      status: response.status,
      headers: responseHeaders(response.headers),
      body: response.body === null ? Buffer.alloc(0) : responseBody(response.body),
    };
  } catch (error) {
    if (clientLeft(req)) return clientGone();
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: anthropicErrorBody('router_error', message),
    };
  }
}

/**
 * Tries each native-routed candidate for a `sonata-<role>-<tier>` alias in
 * rank order, skipping any inside its post-failure cooldown window. The first
 * response that is neither ≥500, 429, nor a candidate-specific auth failure
 * (401/403) goes to the client — retry is inherently pre-first-byte, so this
 * never interferes with an in-progress stream.
 */
async function routeTierRequest(
  req: RouterRequest,
  deps: RouterDeps,
  alias: string,
  startedAt: number,
  session: string | undefined,
  tenant: RouterTenant,
  unavailable: string | undefined,
  auto?: { alias: string; record?: AutoRouteRecord },
): Promise<RouterResponse> {
  // Once per request, not once per candidate: a candidate skipped for being
  // in its post-failure cooldown window would otherwise mean this never
  // fires at all, silently masking a real config change behind an unrelated
  // stale cooldown until it expires on its own.
  deps.checkModelChange?.();
  const resolved = deps.resolveTier?.(alias, tenant);
  if (resolved === undefined) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: anthropicErrorBody(
        'invalid_request_error',
        `unknown sonata tier alias "${alias}" — run \`sonata sync\` and check [tiers] in sonata.toml`,
      ),
    };
  }

  // Recorded under the alias the caller asked for, so auto conversations stay attributable; the decision rides only on the request that made it.
  const routeFields = auto === undefined
    ? { route: 'manual' as const }
    : { alias: auto.alias, route: 'auto' as const, ...(auto.record === undefined ? {} : { autoRoute: auto.record }) };

  const now = deps.now ?? Date.now;
  const flattened = litellmBody(req.body);
  const ranked = resolved.routes.filter((route) => route.native !== undefined);
  const attempts: { key: string; status: number }[] = [];
  let skippedUnavailableLitellm = false;
  // Gateways skipped for being in their own cooldown. Named in the exhaustion
  // message, because "all native routes failed" with no attempt recorded
  // against them reads as a tier that has no candidates rather than one whose
  // candidates are waiting out an account problem.
  const skippedCoolingProviders = new Set<string>();
  // Why candidates on a gateway serve has dropped were skipped. Never tried,
  // so never cooled — the conflict is config, not a failing model.
  const skippedDropped: string[] = [];
  // The most recent message-less 400, and how many attempts had been made
  // when it arrived. If it is the LAST thing the loop saw, it is returned
  // rather than a 529: a request every candidate refuses may really be
  // malformed, and the caller should see the refusal itself.
  let lastMessageless: { at: number; headers: Record<string, string>; body: Buffer; route: TierRoute } | undefined;

  // Which candidate already served this conversation, if any. Preferring it
  // keeps a multi-turn agent on one model, which is what stops its transcript
  // growing extended-thinking blocks the next candidate would reject.
  const conversation = conversationKey(req.body, tenant.id, alias);
  const headers = withSessionHeader(litellmHeaders(requestHeaders(req.headers), deps.litellmKey), conversation);
  const pinned = conversation === undefined ? undefined : stickyGet(conversation, now());
  // Two different questions, deliberately read from two fields. `served` is
  // every candidate whose extended-thinking blocks the transcript may carry,
  // and only grows. `sticky` is who to TRY first, and lapses the moment that
  // candidate hands back a 400.
  const lastServed = pinned?.key;
  const served = pinned?.served;
  const sticky = pinned?.prefer === true ? pinned.key : undefined;
  // Preference, not a pin: the sticky candidate moves to the front and every
  // other keeps its rank behind it. Its cooldown still applies, so a candidate
  // that has genuinely failed is still skipped — the fallback's whole point —
  // and the strip below is what makes that switch survivable.
  const candidates = sticky === undefined
    ? ranked
    : [...ranked.filter((route) => route.key === sticky), ...ranked.filter((route) => route.key !== sticky)];

  for (const route of candidates) {
    // The client left: asking the next candidate would serve nobody, and
    // counting the abandoned attempt would cool a model that did nothing wrong.
    if (clientLeft(req)) return clientGone();
    const cool = litellmModelName(tenant, route.key);
    const direct = route.native?.transport === 'direct';
    // Dropped before the LiteLLM check: a candidate on a dropped gateway is
    // unservable whether or not LiteLLM is up, and counted the other way round
    // a tier made only of dropped candidates answered "run `sonata litellm
    // install`" — a fix that would not have made one of them servable.
    const dropped = route.native === undefined ? undefined : deps.gatewayUnavailable?.(tenant, route.native.gateway);
    if (dropped !== undefined) {
      skippedDropped.push(dropped);
      continue;
    }
    if (!direct && unavailable !== undefined) {
      // This is router state, not a candidate failure: leave its cooldown intact.
      skippedUnavailableLitellm = true;
      continue;
    }
    const until = cooldowns.get(cool);
    if (until !== undefined && until > now()) continue;
    // The gateway's own cooldown, checked alongside the candidate's. Skipped
    // WITHOUT cooling the candidate: the model has done nothing wrong, and
    // recording a failure against it here would let an account problem look
    // like a broken model for a minute after the account recovered.
    const gateway = gatewayOf(route);
    if (gateway !== undefined) {
      const providerUntil = providerCooldowns.get(providerCooldownKey(tenant, gateway));
      if (providerUntil !== undefined && providerUntil > now()) {
        skippedCoolingProviders.add(gateway);
        continue;
      }
    }

    // Only the litellm path needs the string-flattened system form and the
    // sonata alias key rewritten in — a direct gateway has never heard of
    // that key and understands block arrays fine.
    //
    // A conversation changing hands is the one case where the body must be
    // edited on BOTH transports: the thinking blocks in it were produced by
    // the candidate that is no longer serving, and the direct path's usual
    // byte-identical contract exists to echo vendor state back to the vendor
    // that issued it — which is exactly what has stopped being true here.
    // Foreign when any OTHER candidate has served this key — not merely the
    // last one. A switch leaves the earlier model's blocks in the client's
    // transcript for every later turn, and a colliding conversation's
    // candidate is indistinguishable from this one's (see `conversationKey`).
    const foreign = served !== undefined && [...served].some((key) => key !== route.key);
    if (foreign) {
      deps.log?.(
        `router: ${alias} conversation served by ${[...served!].join(', ')} now on ${route.key}` +
        `${lastServed === route.key ? '' : ` (was ${lastServed})`}, dropping other models' thinking blocks`,
      );
    }
    const outbound = direct ? req.body : flattened;
    const prepared = foreign ? stripForeignThinking(outbound) : outbound;
    // Effort is applied last, after the strip: both touch thinking-adjacent
    // fields for different reasons, and the strip must see the original.
    const body = withEffort(withModel(prepared, direct ? route.native!.id : cool), route.effort);
    const variant = joinCandidate(route.key, route.effort);
    const response = direct
      ? await forwardDirect(
        body,
        { baseUrl: route.native!.baseUrl ?? '', key: deps.gatewayKeys?.(tenant)[route.native!.gateway] ?? '' },
        req,
        deps,
      )
      : await forwardToLitellm(body, headers, { ...req, body }, deps, isCodexOauth(tenant, gateway));
    if (clientLeft(req)) {
      if (!Buffer.isBuffer(response.body)) cancelBody(response.body);
      return clientGone();
    }
    // A refused ChatGPT login is the gateway's, not the request's: the next
    // candidate is tried, and it is counted as not served, so a tier left
    // with nothing else answers the same named 502 later requests get.
    //
    // Cooled only when nothing else will keep the gateway away. serve's mark
    // (`gatewayUnavailable` answering once `chatgptLoginRefused` has run)
    // already skips it, and clears the moment LiteLLM starts on a new login;
    // a cooldown on top outlived that by up to a minute, answering the new
    // login 529. A refusal from a LiteLLM already replaced says nothing about
    // the one serving now, and cools nothing either. With no serve to mark
    // it — or one that did not — the candidate and its gateway cool, as for
    // an unservable 400.
    if ('loginRefused' in response && response.loginRefused === true) {
      if (response.status === 400) {
        capture400(deps, { alias, candidate: variant, status: response.status, outbound: body, response: response.body as Buffer });
      }
      attempts.push({ key: route.key, status: response.status });
      const cooling = !('replaced' in response && response.replaced === true) &&
        deps.gatewayUnavailable?.(tenant, route.native!.gateway) === undefined;
      if (cooling) {
        cooldowns.set(cool, now() + TIER_COOLDOWN_MS);
        if (gateway !== undefined) providerCooldowns.set(providerCooldownKey(tenant, gateway), now() + TIER_COOLDOWN_MS);
      }
      skippedDropped.push(loginRefusedMessage(deps, tenant, route.native!.gateway));
      deps.log?.(`router: ${route.key} refused (ChatGPT login), ${cooling ? `cooling gateway ${gateway ?? '?'} and ` : ''}trying next`);
      continue;
    }
    // Retry by default; only a request that is wrong *everywhere* is terminal.
    //
    // This is a deny-list on purpose, and it used to be an allow-list of
    // {5xx, 429, 401, 403}. The allow-list kept being wrong in one direction
    // only: every status nobody had thought of was treated as fatal, so a
    // failure specific to ONE candidate took down a tier that existed
    // precisely to survive it. 402 was the measured case (below), but 404
    // "model not found", 408, 413 "payload too large" and 451 are all the
    // same shape — the next candidate is a different model on a different
    // gateway with a different context window in a different jurisdiction,
    // and none of those answers carries over. Defaulting to retry means a
    // status nobody has seen yet costs one extra round trip instead of the
    // whole tier.
    //
    // `TERMINAL_STATUSES` is what genuinely does carry over: 400 and 422 say
    // the request sonata built is malformed, and it will be just as malformed
    // at every candidate. Retrying those would be strictly worse than
    // returning them — it discards the one error body that names the bad
    // field, replaces it with a generic 529, spends a round trip per
    // candidate, and (the real damage) cools every candidate in the tier, so
    // concurrent agents that were fine start failing too. A 400 that IS
    // candidate-specific still falls through: that is what the capability
    // fingerprints below are for, and they are deliberately the only way in.
    //
    // 402 measured 2026-09-21 on two machines: a tier holding 42 candidates
    // stopped dead on the first one because anexto answered `Budget exceeded:
    // 200.0409 >= 200.0000`, while the codex and openrouter candidates ranked
    // behind it had their own accounts, their own caps, and were never tried.
    // The consumer saw a bare 402 and four dead dispatches; the only
    // workaround was hand-reordering `[tiers]` per role. It is also the one
    // retried status *known* to persist rather than merely suspected to, so
    // the cooldown is doing real work: later requests skip that gateway
    // instead of paying a round trip to be refused again. This is NOT
    // sonata's own `[budget]` cap, which refuses before forwarding and never
    // reaches this branch.
    //
    // Only >= 400 is considered: a 3xx never arrives (fetch follows
    // redirects) and a 2xx that is not 200 — 204, say — is a success.
    if (response.status >= 400 && !TERMINAL_STATUSES.has(response.status)) {
      await drainBody(response.body, deps);
      attempts.push({ key: route.key, status: response.status });
      cooldowns.set(cool, now() + TIER_COOLDOWN_MS);
      // An account-level refusal is about the gateway, not this model, so it
      // cools the gateway too and every sibling on it is skipped rather than
      // asked the same question again. The candidate is cooled as well: it
      // did just fail, and the two expire together.
      const failedGateway = gatewayOf(route);
      if (failedGateway !== undefined && PROVIDER_SCOPED_STATUSES.has(response.status)) {
        providerCooldowns.set(providerCooldownKey(tenant, failedGateway), now() + TIER_COOLDOWN_MS);
        deps.log?.(
          `router: ${route.key} failed (${response.status}) — account-level, ` +
          `cooling gateway ${failedGateway} and skipping its other models`,
        );
      } else {
        deps.log?.(`router: ${route.key} failed (${response.status}), trying next`);
      }
      continue;
    }
    // A 400 usually means the request was wrong, which retrying cannot fix —
    // that is why it is not in the list above. But a model that 400s *every*
    // request of a given shape becomes an absorbing state: permanently the
    // first non-cooling candidate, killing every agent that reaches it, and
    // never earning the cooldown that would let the tier fall through.
    //
    // The two are told apart by fingerprint, not by status. A recognised
    // capability failure repeated `TIER_CAPABILITY_400_THRESHOLD` times in a
    // row cools the candidate; anything else is returned to the caller, who is
    // the only one able to tell a genuine client error from a broken model.
    // Every terminal status lands here, not just 400. They share the ending —
    // the body is handed back and the candidate stops being preferred — and
    // only 400 carries the capability fingerprint. Letting 422 fall past this
    // block instead would `stickySet` it, pinning the conversation to the
    // candidate that just refused it and preferring that candidate again on
    // the very next turn.
    if (TERMINAL_STATUSES.has(response.status)) {
      // Buffered because deciding requires reading the body, and the body is a
      // one-shot iterable — handing the caller the drained original would give
      // them an empty error. This mirrors the 500 path in `forwardToLitellm`.
      const bodyBuf = await bufferBody(response.body, deps);
      if (response.status === 400) {
        capture400(deps, { alias, candidate: variant, status: response.status, outbound: body, response: bodyBuf });
      }
      const unservable = response.status === 400
        ? UNSERVABLE_400_SIGNATURES.find((signature) => bodyBuf.toString().includes(signature))
        : undefined;
      if (unservable !== undefined) {
        attempts.push({ key: route.key, status: response.status });
        cooldowns.set(cool, now() + TIER_COOLDOWN_MS);
        const refusingGateway = gatewayOf(route);
        if (refusingGateway !== undefined) {
          providerCooldowns.set(providerCooldownKey(tenant, refusingGateway), now() + TIER_COOLDOWN_MS);
        }
        deps.log?.(
          `router: ${route.key} refused (400 "${unservable}"), ` +
          `cooling gateway ${refusingGateway ?? '?'} and trying next`,
        );
        continue;
      }
      const capability = response.status === 400
        ? capability400Fingerprint(bodyBuf.toString())
        : undefined;
      // A deliberate, shape-based exception to "signatures on evidence only":
      // a 400 whose body names nothing says nothing about the request, so
      // reading it as the request's fault is the less likely reading. It falls
      // through on the FIRST occurrence — the agent survives — and cools the
      // candidate only after the usual run of identical ones. Litellm path
      // only, where it was measured: 10 of 10 real subagent requests to one
      // candidate, while hand-built requests to it all succeeded.
      const messageless = capability === undefined && !direct && response.status === 400
        && isMessagelessError(bodyBuf.toString());
      const fingerprint = messageless ? MESSAGELESS_400_FINGERPRINT : capability;
      const counterKey = fingerprint === undefined ? undefined : `${cool} ${fingerprint}`;

      if (counterKey !== undefined) {
        const seen = (capability400Counts.get(counterKey) ?? 0) + 1;
        capability400Counts.set(counterKey, seen);
        if (seen >= TIER_CAPABILITY_400_THRESHOLD) {
          capability400Counts.delete(counterKey);
          attempts.push({ key: route.key, status: response.status });
          cooldowns.set(cool, now() + TIER_COOLDOWN_MS);
          deps.log?.(
            `router: ${route.key} cannot serve this request shape ` +
            `(${seen}× 400 "${fingerprint}"), cooling down and trying next`,
          );
          if (messageless) lastMessageless = { at: attempts.length, headers: response.headers, body: bodyBuf, route };
          continue;
        }
        if (messageless) {
          attempts.push({ key: route.key, status: response.status });
          if (conversation !== undefined) stickyDemote(conversation, route.key);
          deps.log?.(
            `router: ${alias} ${variant} answered a message-less 400 (${seen}×): ` +
            `${JSON.stringify(bodyBuf.subarray(0, 200).toString())} — trying next`,
          );
          lastMessageless = { at: attempts.length, headers: response.headers, body: bodyBuf, route };
          continue;
        }
      } else {
        // A different failure means the run of identical ones is broken.
        for (const key of capability400Counts.keys()) {
          if (key.startsWith(`${cool} `)) capability400Counts.delete(key);
        }
      }

      // The candidate handed back a 400, so it stops being the one to try
      // first — otherwise a pinned candidate that 400s is preferred again on
      // every retry until the 2h TTL, and an UNRECOGNISED 400 never earns the
      // capability cooldown that would otherwise break the loop. Preference
      // lapses; the record of whose thinking blocks are in the transcript does
      // not, so the next candidate still gets them stripped.
      if (conversation !== undefined) stickyDemote(conversation, route.key);
      deps.log?.(
        `router: ${alias} ${variant} answered ${response.status} (terminal): ` +
        JSON.stringify(bodyBuf.subarray(0, 200).toString()),
      );
      return withUsageRecording({
        status: response.status,
        headers: response.headers,
        body: bodyBuf,
      }, {
        startedAt,
        session,
        project: tenant.project,
      tenant: tenant.id,
      tenantConfig: tenant.config,
        alias,
        role: resolved.role,
        tier: resolved.tier,
        ...routeFields,
        key: route.key,
        effort: route.effort,
        gateway: route.native!.gateway,
        upstream: direct ? 'direct' : 'litellm',
        attempts,
      }, deps);
    }
    // A candidate that served a request is not accumulating toward a cooldown.
    for (const key of capability400Counts.keys()) {
      if (key.startsWith(`${cool} `)) capability400Counts.delete(key);
    }
    // A model whose serving backend has no tool-call parser writes its calls
    // as text and ends the turn; Claude Code then ends the agent. Recover
    // what parses; an unparsable call still reaches the client as text (it
    // has started streaming), but cools this candidate so the next request
    // takes the next one. LiteLLM path only: Anthropic speaks tool_use itself.
    const textToolCalls: TextToolCallCounts = { recovered: 0, unparsed: 0 };
    let servedResponse = response;
    if (!direct) {
      servedResponse = await recoverTextToolCalls(response, req, deps, textToolCalls, (n) => {
        cooldowns.set(cool, now() + TIER_COOLDOWN_MS);
        deps.log?.(`router: ${alias} ${variant} wrote ${n} tool call(s) as text that could not be recovered; cooling it`);
      });
      if (isClientGone(servedResponse)) return servedResponse;
    }
    // Pin only on a response the client actually receives IN FULL. A 400
    // handed back above is a request this candidate could not serve, and a
    // stream that breaks partway is one it did not finish serving: pinning to
    // either would make the next turn prefer the model that just failed. The
    // status alone arrives before a single byte of the body, so the decision
    // waits for the body's end.
    const completed = conversation === undefined
      ? servedResponse
      : withCompletion(servedResponse, (complete) => {
        // An unparsed tool call is a turn the model never served: record it, but never prefer it again.
        if (complete && textToolCalls.unparsed === 0) stickySet(conversation, route.key, now());
        else stickyIncomplete(conversation, route.key, now());
      });
    deps.log?.(`${req.method} ${req.url} model=${alias} -> ${variant} -> ${direct ? 'direct' : 'litellm'}`);
    return withUsageRecording(completed, {
      startedAt,
      session,
      project: tenant.project,
      tenant: tenant.id,
      tenantConfig: tenant.config,
      alias,
      role: resolved.role,
      tier: resolved.tier,
      ...routeFields,
      key: route.key,
      effort: route.effort,
      gateway: route.native!.gateway,
      upstream: direct ? 'direct' : 'litellm',
      attempts,
      textToolCalls,
    }, deps);
  }

  const label = `${resolved.role}-${resolved.tier}`;
  // Only when nothing was actually tried. A mixed tier can reach here having
  // forwarded to a direct gateway that failed on its own: answering 502 "run
  // `sonata litellm install`" would misdiagnose that failure, and returning
  // before `withUsageRecording` would drop the ledger row for a request the
  // router really did send upstream.
  // "Not served" only when it is the WHOLE story: every candidate was on a
  // dropped gateway. A tier whose other candidates were merely cooling, or
  // failed, is the ordinary exhaustion below, with the drops named in it.
  if (skippedDropped.length > 0 && skippedDropped.length === candidates.length) {
    deps.log?.(`router: every native route for ${label} is on a gateway that serve is not serving (dropped, or no credential)`);
    return {
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: anthropicErrorBody('router_error', `${label}: not served — ${[...new Set(skippedDropped)].join('; ')}`),
    };
  }
  if (skippedUnavailableLitellm && attempts.length === 0) {
    return {
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: anthropicErrorBody('router_error', unavailable!),
    };
  }
  if (lastMessageless !== undefined && lastMessageless.at === attempts.length) {
    const last = lastMessageless;
    deps.log?.(`router: every native route for ${label} refused; returning the last 400`);
    return withUsageRecording({ status: 400, headers: last.headers, body: last.body }, {
      startedAt,
      session,
      project: tenant.project,
      tenant: tenant.id,
      tenantConfig: tenant.config,
      alias,
      role: resolved.role,
      tier: resolved.tier,
      ...routeFields,
      key: last.route.key,
      effort: last.route.effort,
      gateway: last.route.native!.gateway,
      upstream: last.route.native?.transport === 'direct' ? 'direct' : 'litellm',
      attempts,
    }, deps);
  }
  deps.log?.(`router: all native routes for ${label} failed`);
  const cooling = (skippedCoolingProviders.size > 0
    ? ` (skipped ${[...skippedCoolingProviders].sort().join(', ')}: cooling down after an ` +
      'account-level refusal — an expired key, a rejected credential or an exhausted budget)'
    : '') + (skippedDropped.length > 0
    ? ` (not served: ${[...new Set(skippedDropped)].join('; ')})`
    : '');
  return withUsageRecording({
    status: 529,
    headers: { 'content-type': 'application/json' },
    body: anthropicErrorBody(
      'overloaded_error',
      `all native routes for ${label} failed${cooling}; fall back with: ` +
      `sonata dispatch --tier ${label} --task-file <path> (or trailing task text) — ` +
      'dispatch requires one of those; the router has no task text of its own to supply',
    ),
  }, {
    startedAt,
    session,
    project: tenant.project,
    tenant: tenant.id,
      tenantConfig: tenant.config,
    alias,
    role: resolved.role,
    tier: resolved.tier,
    ...routeFields,
    upstream: 'litellm',
    attempts,
  }, deps);
}

export async function routeRequest(req: RouterRequest, deps: RouterDeps): Promise<RouterResponse> {
  const requested = requestedModel(req.body);
  const session = req.headers['x-claude-code-session-id'];

  // A bare model name may carry a level (`flash@low`) in the same grammar a
  // tier candidate uses. This is how the claude harness adapter — whose
  // `--model` names a sonata key straight to the router — honours a
  // `sonata dispatch --model <key>@<effort>`. A tier alias never contains
  // `@`, and a `claude-` model is Anthropic's own and passes through
  // untouched, so neither is split.
  let alias = requested;
  let bareEffort: Effort | undefined;
  if (requested !== undefined && requested.includes('@') && !requested.startsWith('sonata-') && !isClaudeRequest(req.body)) {
    try {
      ({ key: alias, effort: bareEffort } = splitCandidate(requested));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log?.(`router: refused model=${requested} — ${message}`);
      return { status: 400, headers: { 'content-type': 'application/json' }, body: anthropicErrorBody('invalid_request_error', message) };
    }
  }

  // A hint is honoured only from a caller that proves it is the user: naming a
  // project chooses that project's gateways, endpoints and stored credentials,
  // and the router authenticates nobody on loopback. Unauthorised, the hint is
  // dropped rather than the request refused — the caller gets exactly what a
  // request with no hint gets, which is the safe direction and keeps a session
  // whose settings predate the token working.
  let project: string | undefined = req.headers[SONATA_PROJECT_HEADER];
  if (project !== undefined && !projectHintAuthorised(req.headers[SONATA_TOKEN_HEADER], deps.projectHintToken)) {
    deps.log?.(
      `router: ignoring ${SONATA_PROJECT_HEADER}=${project} — no valid ${SONATA_TOKEN_HEADER}; ` +
      'resolving by session instead. Re-run `sonata route on` (or start a new session under `route auto`) to refresh it.',
    );
    project = undefined;
  }

  let tenant: RouterTenant;
  try {
    tenant = deps.resolveTenant?.({ project, session }) ?? DEFAULT_TENANT;
  } catch (error) {
    if (!(error instanceof TenantError)) throw error;
    deps.log?.(`router: refused model=${alias ?? '?'} — ${error.message}`);
    return { status: 400, headers: { 'content-type': 'application/json' }, body: anthropicErrorBody('invalid_request_error', error.message) };
  }

  const unavailable = deps.litellmUnavailable?.();

  // Before anything is forwarded, and ahead of both the tier and direct paths:
  // this is the one point every native request passes through, and a cap
  // checked on only one of the two branches is not a cap. The health endpoint
  // is answered by the server above and never reaches here, so a router at its
  // limit still reports itself alive — `sonata restart` and the daemon-identity
  // probes must keep working when the budget is spent.
  //
  // The refusal is deliberately not written to the ledger. A ledger row records
  // a request the router actually forwarded; a refusal has no upstream, no
  // tokens and no cost, and putting avoided spend into the store that defines
  // spend is how the number stops meaning what it says.
  const refusal = budgetRefusal(deps.budget?.(tenant));
  if (refusal !== undefined) {
    deps.log?.(`router: refused model=${alias ?? '?'} — ${refusal}`);
    return {
      status: 429,
      headers: { 'content-type': 'application/json' },
      body: anthropicErrorBody('rate_limit_error', refusal),
    };
  }

  // Once, ahead of every branch, so the tier loop, the bare-key path and the
  // direct transport all see the same repaired transcript. See #66.
  const repairedBody = repairNamelessToolCalls(req.body);
  if (repairedBody !== req.body) {
    deps.log?.(`router: model=${alias ?? '?'} — replaced a tool call with no name in the transcript`);
    req = { ...req, body: repairedBody };
  }

  let startedAt = 0;
  if (deps.recordUsage !== undefined) {
    try {
      startedAt = (deps.now ?? Date.now)();
    } catch { /* A broken accounting clock must not stop routing. */ }
  }
  const auto = alias === undefined ? undefined : autoRole(alias);
  if (alias !== undefined && auto !== undefined) {
    const lists = tenant.config?.tiers?.[auto];
    const settings = tenant.config?.autoRoute;
    if (settings === undefined || lists === undefined || tiersCollapse(lists)) {
      const why = settings === undefined
        ? 'auto-routing is off for this project — add [auto_route] to sonata.toml and run `sonata sync`'
        : `role "${auto}" has no tiers to choose between — run \`sonata sync\``;
      deps.log?.(`router: refused model=${alias} — ${why}`);
      return { status: 400, headers: { 'content-type': 'application/json' }, body: anthropicErrorBody('invalid_request_error', `${alias}: ${why}`) };
    }
    const tiers = TIER_NAMES.filter((tier) => lists[tier] !== undefined);
    const conversation = conversationKey(req.body, tenant.id, alias);
    const make = () => decideTier({
      classifier: deps.classifierFor?.(settings) ?? deps.classifier, role: auto, body: req.body, tiers,
      minConfidence: settings.minConfidence, now: deps.now,
    });
    // Never cache a no-task decision: the key hashes messages[0] while `cleanTask` reads the first user message, so a taskless request can share it with a later one that has a task.
    const taskless = cleanTask(req.body) === undefined;
    const { decision, fresh } = taskless || conversation === undefined
      ? { decision: await make(), fresh: true }
      : await autoDecisions.getOrCreate(conversation, (deps.now ?? Date.now)(), make);
    if (fresh && decision.record.outcome !== 'accepted') {
      // Once per conversation, never with the task text.
      deps.log?.(`router: ${alias} → ${decision.tier} (${decision.record.outcome}${decision.record.reason === undefined ? '' : `: ${decision.record.reason}`})`);
    }
    return routeTierRequest(
      req, deps, `sonata-${auto}-${decision.tier}`, startedAt, session, tenant, unavailable,
      { alias, ...(fresh ? { record: decision.record } : {}) },
    );
  }
  if (alias !== undefined && alias.startsWith('sonata-') && deps.resolveTier?.(alias, tenant) !== undefined) {
    return routeTierRequest(req, deps, alias, startedAt, session, tenant, unavailable);
  }
  // A name shaped exactly like a generated alias that the config does not
  // resolve is a stale agent file or a missing tier, not a model key.
  // Forwarding it would surface as LiteLLM's "invalid model name", which
  // names neither cause; `routeTierRequest` answers with the typed 400 that
  // points at `sonata sync`. A config that really has a model key of that
  // shape still reaches it.
  if (alias !== undefined && bareEffort === undefined && isTierAliasShape(alias)
    && deps.resolveNative?.(alias, tenant) === undefined) {
    return routeTierRequest(req, deps, alias, startedAt, session, tenant, unavailable);
  }

  const anthropic = isClaudeRequest(req.body);
  const headers = requestHeaders(req.headers);
  const upstream = anthropic ? 'anthropic' : 'litellm';
  // Anthropic understands its own block arrays and its own tool schemas; only
  // the foreign path needs the string form and the regex-dialect repair, so
  // the request Anthropic receives stays byte-identical.
  const body = anthropic
    ? req.body
    : alias === undefined
      ? litellmBody(req.body)
      : withEffort(withModel(litellmBody(req.body), litellmModelName(tenant, alias)), bareEffort);

  // A bare key on a direct gateway goes where a tier candidate on that
  // gateway would: straight to it, with its own key and its own upstream id.
  // Sending it to LiteLLM instead reaches nothing on a direct-only config
  // (no child is started) and loses the direct path's pass-through contract
  // on a mixed one.
  const native = !anthropic && alias !== undefined ? deps.resolveNative?.(alias, tenant) : undefined;
  const droppedGateway = native === undefined ? undefined : deps.gatewayUnavailable?.(tenant, native.gateway);
  if (droppedGateway !== undefined) {
    deps.log?.(`router: refused model=${requested ?? '?'} — its gateway is not served`);
    return {
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: anthropicErrorBody('router_error', `${alias}: not served — ${droppedGateway}`),
    };
  }
  if (native?.transport === 'direct' && alias !== undefined) {
    deps.log?.(`${req.method} ${req.url} model=${requested ?? '?'} -> direct`);
    const response = await forwardDirect(
      withEffort(withModel(req.body, native.id), bareEffort),
      { baseUrl: native.baseUrl ?? '', key: deps.gatewayKeys?.(tenant)[native.gateway] ?? '' },
      req,
      deps,
    );
    if (isClientGone(response)) return response;
    return withUsageRecording(
      response,
      {
        startedAt,
        session,
        project: tenant.project,
        tenant: tenant.id,
      tenantConfig: tenant.config,
        alias,
        key: alias,
        gateway: native.gateway,
        effort: bareEffort,
        upstream: 'direct',
        attempts: [],
      },
      deps,
    );
  }

  deps.log?.(`${req.method} ${req.url} model=${requested ?? '?'} -> ${upstream}`);

  if (!anthropic) {
    if (unavailable !== undefined) {
      return { status: 502, headers: { 'content-type': 'application/json' }, body: anthropicErrorBody('router_error', unavailable) };
    }
    // A direct `--model <key>` request never goes through `resolveTier` (the
    // key isn't a `sonata-*` alias), so this is the only place such a
    // request's config-change check can fire.
    deps.checkModelChange?.();
    const response = await forwardToLitellm(
      body,
      withSessionHeader(
        litellmHeaders(headers, deps.litellmKey),
        alias === undefined ? undefined : conversationKey(req.body, tenant.id, alias),
      ),
      req,
      deps,
      isCodexOauth(tenant, native?.gateway),
    );
    if (isClientGone(response)) return response;
    // Answered as every later request on the gateway is — the named 502 —
    // and, like those, never a ledger row: nothing was served.
    if (response.loginRefused === true && native !== undefined) {
      return {
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: anthropicErrorBody('router_error', `${alias}: not served — ${loginRefusedMessage(deps, tenant, native.gateway)}`),
      };
    }
    const textToolCalls: TextToolCallCounts = { recovered: 0, unparsed: 0 };
    // No cooldown here: a bare key has no next candidate to fall through to.
    const served = await recoverTextToolCalls(response, req, deps, textToolCalls);
    if (isClientGone(served)) return served;
    return withUsageRecording(
      served,
      {
        startedAt,
        session,
        project: tenant.project,
      tenant: tenant.id,
      tenantConfig: tenant.config,
        alias: alias ?? '',
        // For a direct `--model <key>` request, `alias` IS the config key.
        // Recording it (and its gateway) is what lets `resolvePrice` price this
        // request class at all; without it a direct-model row is `source:
        // 'none'` even when full price config exists for that exact model.
        // `key` is only set when `alias` is defined, matching how optional
        // `RecordContext` fields are handled elsewhere — never an own property
        // with value `undefined`.
        ...(alias !== undefined ? { key: alias, gateway: deps.resolveGateway?.(alias, tenant) } : {}),
        effort: bareEffort,
        upstream: 'litellm',
        attempts: [],
        textToolCalls,
      },
      deps,
    );
  }

  try {
    const response = await deps.fetch(
      targetUrl(deps.anthropicBase ?? 'https://api.anthropic.com', req.url),
      { method: req.method, headers, body: body.length > 0 ? body as unknown as BodyInit : undefined, signal: req.signal },
    );
    return withUsageRecording({
      status: response.status,
      headers: responseHeaders(response.headers),
      body: response.body === null ? Buffer.alloc(0) : responseBody(response.body),
    }, { startedAt, session, project: tenant.project, tenant: tenant.id,
      tenantConfig: tenant.config, alias: alias ?? '', upstream: 'anthropic', attempts: [] }, deps);
  } catch (error) {
    if (clientLeft(req)) return clientGone();
    const message = error instanceof Error ? error.message : String(error);
    return withUsageRecording({
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: anthropicErrorBody('router_error', message),
    }, { startedAt, session, project: tenant.project, tenant: tenant.id,
      tenantConfig: tenant.config, alias: alias ?? '', upstream: 'anthropic', attempts: [] }, deps);
  }
}

function incomingHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Writes a routed response, pulling the next upstream chunk only once the
 * client has taken the last one. Ignoring `write`'s false would let a slow
 * client make the router buffer an entire upstream stream in memory.
 */
export async function respond(res: ServerResponse, routed: RouterResponse): Promise<void> {
  res.writeHead(routed.status, routed.headers);
  if (Buffer.isBuffer(routed.body)) {
    res.end(routed.body);
    return;
  }
  const body = routed.body;
  // Registered before the first write: a client can be gone before the loop
  // ever waits on it, and 'close' fires once. Cancelling the upstream here is
  // what unblocks a loop waiting on the NEXT chunk, not just one waiting to
  // drain; the wrappers' own finally blocks then record the incomplete row.
  let closed = res.destroyed;
  const onClose = (): void => {
    if (res.writableEnded) return;
    closed = true;
    cancelBody(body);
  };
  res.once('close', onClose);
  // Gone before this ran: 'close' has already fired, so cancel here. Without
  // it the loop waits on an upstream that has not sent its first chunk, for
  // a client nobody will write to. Iterating on (rather than returning)
  // lets the wrappers' finally blocks record the incomplete row, exactly as
  // a disconnect mid-stream does.
  if (closed) cancelBody(body);
  try {
    for await (const chunk of body) {
      if (closed || res.destroyed) break;
      if (!res.write(chunk)) {
        if (closed || res.destroyed) break;
        // 'close' as well as 'drain': a client that disconnects never drains.
        await new Promise<void>((resolve) => {
          const done = (): void => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done);
          res.once('close', done);
        });
        if (closed || res.destroyed) break;
      }
    }
    if (!closed && !res.destroyed) res.end();
  } finally {
    res.off('close', onClose);
  }
}

export function createRouterServer(deps: RouterDeps): Server {
  return createServer(async (req, res) => {
    try {
      if (deps.health && new URL(req.url ?? '/', 'http://localhost').pathname === '/__sonata_health') {
        const ready = deps.healthReady?.() ?? true;
        res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: ready ? 'ok' : 'starting', sonata: true, ready, multiTenant: true,
          // A capability, not a version: a caller must be able to tell a router
          // that serves the UI from one built before it existed, rather than
          // printing a URL that 404s. Absent means no UI.
          ui: deps.ui !== undefined,
          instanceId: deps.instanceId ?? null, tenants: deps.tenants?.() ?? [],
        }));
        return;
      }
      if (deps.ui !== undefined) {
        // Not awaited unconditionally: `handleUiRequest`'s decision is
        // synchronous, so a proxied request does not even pay a microtask tick
        // for the UI existing.
        const handled = handleUiRequest(
          { method: req.method ?? 'GET', url: req.url ?? '/', headers: incomingHeaders(req) },
          deps.ui,
        );
        if (handled !== undefined) {
          await respond(res, await handled);
          return;
        }
      }
      const body = await readBody(req);
      // Aborts the upstream fetch if the client leaves while it is pending.
      // Only until routing returns: from then on `respond` owns the
      // disconnect, and cancels the body it is streaming.
      const abort = new AbortController();
      const onClose = (): void => { if (!res.writableEnded) abort.abort(); };
      res.once('close', onClose);
      if (res.destroyed) abort.abort();
      let routed: RouterResponse;
      try {
        routed = await routeRequest({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: incomingHeaders(req),
          body,
          signal: abort.signal,
        }, deps);
      } finally {
        res.off('close', onClose);
      }
      await respond(res, routed);
    } catch (error) {
      // Once the headers are out, the response is an event stream the client
      // is parsing frame by frame: a JSON body appended to it is garbage
      // mid-stream, not an error. Tearing the connection down is the signal
      // every HTTP client understands as "this response failed".
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(anthropicErrorBody('router_error', 'failed to route request'));
    }
  });
}
