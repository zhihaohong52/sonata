import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { budgetRefusal, type BudgetStatus } from '../budget.js';
import type { SonataConfig } from '../config.js';
import type { LedgerRow } from '../ledger.js';
import { SONATA_PROJECT_HEADER, TenantError } from './tenants.js';
import { SONATA_TOKEN_HEADER, projectHintAuthorised } from './router-token.js';
import type { Transport } from './providers.js';
import { createUsageCollector, type UsageTokens, usageFromJsonBody } from './usage.js';

export interface TierRoute {
  key: string;
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
  /**
   * Resolves a direct `--model <key>` request's key to its gateway name, so a
   * direct-model row carries `gateway` and can be priced (pricing's step 2
   * reads the gateway's own rates). Direct requests never pass through
   * `resolveTier`, so their key/gateway are the model string and whatever this
   * returns.
   */
  resolveGateway?: (key: string, tenant: RouterTenant) => string | undefined;
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
  recordUsage?: (row: LedgerRow) => void;
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
  /** Why LiteLLM cannot serve right now (venv missing, broken), or undefined when it can. A litellm-bound request is answered 502 with this text rather than forwarded. */
  litellmUnavailable?: () => string | undefined;
}

export interface RouterRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
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

async function* responseBody(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function drainBody(body: AsyncIterable<Uint8Array> | Buffer): Promise<void> {
  if (Buffer.isBuffer(body)) return;
  try {
    for await (const _chunk of body) { /* discard */ }
  } catch { /* the body failing to drain is not itself an error */ }
}

/**
 * Lets the client advance before inspecting its chunk. This keeps accounting
 * off the response critical path; `finally` also accounts for disconnects.
 */
async function* observe(
  body: AsyncIterable<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
  onEnd: (complete: boolean) => void,
): AsyncIterable<Uint8Array> {
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

interface RecordContext {
  startedAt: number;
  alias: string;
  role?: string;
  tier?: string;
  key?: string;
  gateway?: string;
  upstream: 'litellm' | 'anthropic' | 'direct';
  attempts: { key: string; status: number }[];
  session?: string;
  project?: string;
  tenant?: string;
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
          key: ctx.key,
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
        });
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
 * 400 bodies that mean "this candidate cannot serve requests of this shape",
 * as opposed to "this request was malformed".
 *
 * Two entries, because two have been measured.
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
 * Guessing at "equivalent" signatures would break this repo's evidence-over-
 * inference rule, and the cost of a wrong guess is asymmetric: a signature
 * that matches too broadly cools healthy candidates on ordinary client errors,
 * turning a legible 400 into a 529. Add an entry when a failure is captured,
 * not when one is imagined.
 */
const CAPABILITY_400_SIGNATURES = [
  'thought_signature',
  'System messages are not allowed',
] as const;

/** Module-level so a cooling-down key stays cool across requests. Test seam: `clearCooldowns()`. */
const cooldowns = new Map<string, number>();

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
const stickyCandidates = new Map<string, { key: string; at: number; prefer: boolean }>();

function stickyGet(conversation: string, at: number): { key: string; prefer: boolean } | undefined {
  const hit = stickyCandidates.get(conversation);
  if (hit === undefined) return undefined;
  if (at - hit.at > STICKY_TTL_MS) {
    stickyCandidates.delete(conversation);
    return undefined;
  }
  return hit;
}

function stickySet(conversation: string, key: string, at: number): void {
  // Delete-then-set moves the entry to the end of the insertion order, so a
  // conversation still in use is never the eviction victim.
  stickyCandidates.delete(conversation);
  stickyCandidates.set(conversation, { key, at, prefer: true });
  if (stickyCandidates.size > STICKY_MAX_CONVERSATIONS) {
    const oldest = stickyCandidates.keys().next();
    if (!oldest.done) stickyCandidates.delete(oldest.value);
  }
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
 * A stable identity for the conversation this request belongs to.
 *
 * The first message is the one part of a transcript that does not change as
 * turns are appended, so hashing it gives the same answer on turn 1 and turn
 * 40. The alias and tenant join it because two roles are two conversations
 * even when their opening message is identical, and two projects are never the
 * same conversation.
 *
 * A collision — two agents genuinely opened with the same text — costs nothing
 * beyond a shared preference, since this only reorders candidates that were
 * all eligible anyway. `undefined` (an unparseable or empty body) simply means
 * no stickiness, which is the behaviour that shipped before this existed.
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

/**
 * Test seam: every scrap of per-candidate and per-conversation memory the
 * router accumulates. Sticky pins are cleared alongside the cooldowns because
 * a conversation pinned by one test would otherwise steer the next one's
 * candidate ordering.
 */
export function clearCooldowns(): void {
  cooldowns.clear();
  capability400Counts.clear();
  stickyCandidates.clear();
}

/** Which capability failure this 400 body is, or undefined if it is not one. */
function capability400Fingerprint(body: string): string | undefined {
  return CAPABILITY_400_SIGNATURES.find((signature) => body.includes(signature));
}

/** Reads a response body into a Buffer, leaving it readable by the caller. */
async function bufferBody(body: AsyncIterable<Uint8Array> | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
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
): Promise<RouterResponse> {
  try {
    await deps.litellmReady?.();
    const response = await deps.fetch(
      targetUrl(deps.litellmBase, req.url),
      { method: req.method, headers, body: body.length > 0 ? body as unknown as BodyInit : undefined },
    );
    // LiteLLM returns 500 when ChatGPT's Codex endpoint yields output:[]. That
    // usually means the upstream was overloaded and returned an empty completion
    // rather than a real error. Re-emitting it as 529 (overloaded) lets Claude
    // Code treat it as a retriable backpressure signal rather than a hard fault.
    if (response.status === 500) {
      const responseBodyBuf = response.body === null
        ? Buffer.alloc(0)
        : Buffer.concat(await async function() { const chunks: Buffer[] = []; for await (const c of responseBody(response.body!)) chunks.push(Buffer.from(c)); return chunks; }());
      const text = responseBodyBuf.toString();
      if (text.includes('Unknown items in responses API response')) {
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
      { method: req.method, headers, body: body.length > 0 ? body as unknown as BodyInit : undefined },
    );
    return {
      status: response.status,
      headers: responseHeaders(response.headers),
      body: response.body === null ? Buffer.alloc(0) : responseBody(response.body),
    };
  } catch (error) {
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

  const now = deps.now ?? Date.now;
  const headers = litellmHeaders(requestHeaders(req.headers), deps.litellmKey);
  const flattened = litellmBody(req.body);
  const ranked = resolved.routes.filter((route) => route.native !== undefined);
  const attempts: { key: string; status: number }[] = [];
  let skippedUnavailableLitellm = false;

  // Which candidate already served this conversation, if any. Preferring it
  // keeps a multi-turn agent on one model, which is what stops its transcript
  // growing extended-thinking blocks the next candidate would reject.
  const conversation = conversationKey(req.body, tenant.id, alias);
  const pinned = conversation === undefined ? undefined : stickyGet(conversation, now());
  // Two different questions, deliberately read from two fields. `lastServed`
  // is whose extended-thinking blocks the transcript carries, and stays true
  // until another candidate actually serves. `sticky` is who to TRY first, and
  // lapses the moment that candidate hands back a 400.
  const lastServed = pinned?.key;
  const sticky = pinned?.prefer === true ? pinned.key : undefined;
  // Preference, not a pin: the sticky candidate moves to the front and every
  // other keeps its rank behind it. Its cooldown still applies, so a candidate
  // that has genuinely failed is still skipped — the fallback's whole point —
  // and the strip below is what makes that switch survivable.
  const candidates = sticky === undefined
    ? ranked
    : [...ranked.filter((route) => route.key === sticky), ...ranked.filter((route) => route.key !== sticky)];

  for (const route of candidates) {
    const cool = litellmModelName(tenant, route.key);
    const direct = route.native?.transport === 'direct';
    if (!direct && unavailable !== undefined) {
      // This is router state, not a candidate failure: leave its cooldown intact.
      skippedUnavailableLitellm = true;
      continue;
    }
    const until = cooldowns.get(cool);
    if (until !== undefined && until > now()) continue;

    // Only the litellm path needs the string-flattened system form and the
    // sonata alias key rewritten in — a direct gateway has never heard of
    // that key and understands block arrays fine.
    //
    // A conversation changing hands is the one case where the body must be
    // edited on BOTH transports: the thinking blocks in it were produced by
    // the candidate that is no longer serving, and the direct path's usual
    // byte-identical contract exists to echo vendor state back to the vendor
    // that issued it — which is exactly what has stopped being true here.
    const foreign = lastServed !== undefined && lastServed !== route.key;
    if (foreign) {
      deps.log?.(
        `router: ${alias} conversation moving ${lastServed} -> ${route.key}, ` +
        "dropping the previous model's thinking blocks",
      );
    }
    const outbound = direct ? req.body : flattened;
    const prepared = foreign ? stripForeignThinking(outbound) : outbound;
    const body = withModel(prepared, direct ? route.native!.id : cool);
    const response = direct
      ? await forwardDirect(
        body,
        { baseUrl: route.native!.baseUrl ?? '', key: deps.gatewayKeys?.(tenant)[route.native!.gateway] ?? '' },
        req,
        deps,
      )
      : await forwardToLitellm(body, headers, { ...req, body }, deps);
    // 429 is treated as a failure alongside 5xx (not as one of "our" 4xx
    // mistakes to return as-is): it's the upstream saying it's overloaded,
    // exactly the transient case ranked fallback exists for. 401/403 are also
    // retried — they are credential failures specific to THIS candidate's
    // gateway (an expired or rejected key), so a later candidate on a
    // different gateway with a working credential is worth trying, and they
    // must not take down every tier that ranks the affected gateway first.
    // Every other 4xx (e.g. 400) means the request itself was wrong, which
    // retrying can't fix.
    if (response.status >= 500 || response.status === 429 || response.status === 401 || response.status === 403) {
      await drainBody(response.body);
      attempts.push({ key: route.key, status: response.status });
      cooldowns.set(cool, now() + TIER_COOLDOWN_MS);
      deps.log?.(`router: ${route.key} failed (${response.status}), trying next`);
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
    if (response.status === 400) {
      // Buffered because deciding requires reading the body, and the body is a
      // one-shot iterable — handing the caller the drained original would give
      // them an empty error. This mirrors the 500 path in `forwardToLitellm`.
      const bodyBuf = await bufferBody(response.body);
      const fingerprint = capability400Fingerprint(bodyBuf.toString());
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
      return withUsageRecording({
        status: response.status,
        headers: response.headers,
        body: bodyBuf,
      }, {
        startedAt,
        session,
        project: tenant.project,
      tenant: tenant.id,
        alias,
        role: resolved.role,
        tier: resolved.tier,
        key: route.key,
        gateway: route.native!.gateway,
        upstream: direct ? 'direct' : 'litellm',
        attempts,
      }, deps);
    }
    // A candidate that served a request is not accumulating toward a cooldown.
    for (const key of capability400Counts.keys()) {
      if (key.startsWith(`${cool} `)) capability400Counts.delete(key);
    }
    // Pin only on a response the client actually receives. A 400 handed back
    // above is a request this candidate could not serve, and pinning to it
    // would make the next turn prefer the model that just refused.
    if (conversation !== undefined) stickySet(conversation, route.key, now());
    deps.log?.(`${req.method} ${req.url} model=${alias} -> ${route.key} -> ${direct ? 'direct' : 'litellm'}`);
    return withUsageRecording(response, {
      startedAt,
      session,
      project: tenant.project,
      tenant: tenant.id,
      alias,
      role: resolved.role,
      tier: resolved.tier,
      key: route.key,
      gateway: route.native!.gateway,
      upstream: direct ? 'direct' : 'litellm',
      attempts,
    }, deps);
  }

  const label = `${resolved.role}-${resolved.tier}`;
  // Only when nothing was actually tried. A mixed tier can reach here having
  // forwarded to a direct gateway that failed on its own: answering 502 "run
  // `sonata litellm install`" would misdiagnose that failure, and returning
  // before `withUsageRecording` would drop the ledger row for a request the
  // router really did send upstream.
  if (skippedUnavailableLitellm && attempts.length === 0) {
    return {
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: anthropicErrorBody('router_error', unavailable!),
    };
  }
  deps.log?.(`router: all native routes for ${label} failed`);
  return withUsageRecording({
    status: 529,
    headers: { 'content-type': 'application/json' },
    body: anthropicErrorBody(
      'overloaded_error',
      `all native routes for ${label} failed; fall back with: ` +
      `sonata dispatch --tier ${label} --task-file <path> (or trailing task text) — ` +
      'dispatch requires one of those; the router has no task text of its own to supply',
    ),
  }, {
    startedAt,
    session,
    project: tenant.project,
    tenant: tenant.id,
    alias,
    role: resolved.role,
    tier: resolved.tier,
    upstream: 'litellm',
    attempts,
  }, deps);
}

export async function routeRequest(req: RouterRequest, deps: RouterDeps): Promise<RouterResponse> {
  const alias = requestedModel(req.body);
  const session = req.headers['x-claude-code-session-id'];

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

  let startedAt = 0;
  if (deps.recordUsage !== undefined) {
    try {
      startedAt = (deps.now ?? Date.now)();
    } catch { /* A broken accounting clock must not stop routing. */ }
  }
  if (alias !== undefined && alias.startsWith('sonata-') && deps.resolveTier?.(alias, tenant) !== undefined) {
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
      : withModel(litellmBody(req.body), litellmModelName(tenant, alias));

  deps.log?.(`${req.method} ${req.url} model=${requestedModel(req.body) ?? '?'} -> ${upstream}`);

  if (!anthropic) {
    if (unavailable !== undefined) {
      return { status: 502, headers: { 'content-type': 'application/json' }, body: anthropicErrorBody('router_error', unavailable) };
    }
    // A direct `--model <key>` request never goes through `resolveTier` (the
    // key isn't a `sonata-*` alias), so this is the only place such a
    // request's config-change check can fire.
    deps.checkModelChange?.();
    return withUsageRecording(
      await forwardToLitellm(body, litellmHeaders(headers, deps.litellmKey), req, deps),
      {
        startedAt,
        session,
        project: tenant.project,
      tenant: tenant.id,
        alias: alias ?? '',
        // For a direct `--model <key>` request, `alias` IS the config key.
        // Recording it (and its gateway) is what lets `resolvePrice` price this
        // request class at all; without it a direct-model row is `source:
        // 'none'` even when full price config exists for that exact model.
        // `key` is only set when `alias` is defined, matching how optional
        // `RecordContext` fields are handled elsewhere — never an own property
        // with value `undefined`.
        ...(alias !== undefined ? { key: alias, gateway: deps.resolveGateway?.(alias, tenant) } : {}),
        upstream: 'litellm',
        attempts: [],
      },
      deps,
    );
  }

  try {
    const response = await deps.fetch(
      targetUrl(deps.anthropicBase ?? 'https://api.anthropic.com', req.url),
      { method: req.method, headers, body: body.length > 0 ? body as unknown as BodyInit : undefined },
    );
    return withUsageRecording({
      status: response.status,
      headers: responseHeaders(response.headers),
      body: response.body === null ? Buffer.alloc(0) : responseBody(response.body),
    }, { startedAt, session, project: tenant.project, tenant: tenant.id, alias: alias ?? '', upstream: 'anthropic', attempts: [] }, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return withUsageRecording({
      status: 502,
      headers: { 'content-type': 'application/json' },
      body: anthropicErrorBody('router_error', message),
    }, { startedAt, session, project: tenant.project, tenant: tenant.id, alias: alias ?? '', upstream: 'anthropic', attempts: [] }, deps);
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

async function respond(res: ServerResponse, routed: RouterResponse): Promise<void> {
  res.writeHead(routed.status, routed.headers);
  if (Buffer.isBuffer(routed.body)) {
    res.end(routed.body);
    return;
  }
  for await (const chunk of routed.body) res.write(chunk);
  res.end();
}

export function createRouterServer(deps: RouterDeps): Server {
  return createServer(async (req, res) => {
    try {
      if (deps.health && new URL(req.url ?? '/', 'http://localhost').pathname === '/__sonata_health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok', sonata: true, multiTenant: true, instanceId: deps.instanceId ?? null, tenants: deps.tenants?.() ?? [],
        }));
        return;
      }
      await respond(res, await routeRequest({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: incomingHeaders(req),
        body: await readBody(req),
      }, deps));
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(anthropicErrorBody('router_error', 'failed to route request'));
    }
  });
}
