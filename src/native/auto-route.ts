/**
 * Automatic tier choice for `sonata-<role>-auto`.
 *
 * Tier *selection* was sonata's weakest routing decision: the dispatching
 * model picks from a description, and one unsure of itself picks upward
 * (`complex` took 74% of tiered requests). This asks TypeSafe's System One
 * model Jev one Choice question, once per conversation, and hands the answer
 * to the unchanged tier path. See
 * docs/superpowers/specs/2026-09-30-jev-auto-route-design.md.
 *
 * Every failure is fail-open to the fallback tier: a classifier that is down,
 * unsure or unkeyed never does worse than today's default, and never blocks a
 * subagent past `JEV_DEADLINE_MS`.
 */
// Tier is defined by agent generation, not config parsing.
import type { Tier } from '../commands/agents.js';
import type { AutoRouteRecord } from '../ledger.js';
import type { AutoRouteConfig } from '../config.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_ATTEMPT_MS = 1_500;
export const JEV_DEADLINE_MS = 3_000;
export const TASK_CHAR_CAP = 8_000;

const AUTO_ALIAS = /^sonata-(.+)-auto$/;

/** The role an auto alias names, or undefined for any other model name. */
export function autoRole(alias: string): string | undefined {
  const match = AUTO_ALIAS.exec(alias);
  return match === null || match[1].length === 0 ? undefined : match[1];
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * The task as the classifier may see it: the first user message's text only,
 * with Claude Code's injected context removed. Nothing else leaves the
 * machine — no system prompt, tool results, images or later turns.
 */
export function cleanTask(body: Buffer): string | undefined {
  let messages: unknown;
  try {
    messages = (JSON.parse(body.toString()) as { messages?: unknown }).messages;
  } catch {
    return undefined;
  }
  if (!Array.isArray(messages)) return undefined;
  const first = messages.find((m) => (m as { role?: unknown })?.role === 'user') as { content?: unknown } | undefined;
  if (first === undefined) return undefined;
  const parts = typeof first.content === 'string'
    ? [first.content]
    : Array.isArray(first.content)
      ? first.content
        .filter((b) => (b as { type?: unknown })?.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
        .map((b) => (b as { text: string }).text)
      : [];
  const text = parts.join('\n').replace(REMINDER, '').trim();
  return text.length === 0 ? undefined : text.slice(0, TASK_CHAR_CAP);
}

/** `normal` when the role has one, else the next tier up. */
export function fallbackTier(tiers: readonly Tier[]): Tier {
  if (tiers.includes('normal')) return 'normal';
  if (tiers.includes('complex')) return 'complex';
  return tiers[0];
}

/** Same definitions the generated agent descriptions use, so Jev and a caller judge alike. */
const TIER_CRITERIA: Record<Tier, { what: string; not_for: string }> = {
  simple: {
    what: 'Specified closely enough that the change could be written without asking a question; '
      + 'typically one or two files and no interface change. A large mechanical change is simple.',
    not_for: 'Work that needs a design decision or reading the surrounding code to fit in.',
  },
  normal: {
    what: 'You know what to change but not exactly how; needs reading the surrounding code; '
      + 'may touch several files; what "done" means is not in question.',
    not_for: 'Open design choices, or an ambiguous definition of done.',
  },
  complex: {
    what: 'Needs a design decision affecting other components, or is ambiguous about what "done" means, '
      + 'so the first job is deciding what to build. A three-line change that decides an interface is complex.',
    not_for: 'Routine work with a clear implementation, however large.',
  },
};

/** The System One request: `state` plus one Choice named `tier`. */
export function jevRequestBody(input: { role: string; task: string; tiers: readonly Tier[] }): object {
  return {
    state: { role: input.role, task: input.task },
    questions: {
      tier: {
        type: 'choice',
        instructions: [
          'Pick the cheapest tier that can fully complete `task` in one pass, without being re-run at a higher tier.',
          '`role` is the kind of work (code, review, explore or plan). Size is not difficulty.',
        ],
        criteria: Object.fromEntries(input.tiers.map((tier) => [tier, TIER_CRITERIA[tier]])),
      },
    },
  };
}

export interface ClassifierAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  classifierModel?: string;
  tokens?: { input: number; output: number };
  /** What the provider charged for this call, when it says (OpenRouter does). */
  costUsd?: number;
}

export interface TierClassifier {
  name: 'jev';
  classify(input: { role: string; task: string; tiers: readonly Tier[] }, signal: AbortSignal): Promise<ClassifierAnswer>;
}

/** A response was received, but it cannot answer the Choice question. */
export class MalformedAnswerError extends Error {
  constructor() { super('malformed classifier response'); this.name = 'MalformedAnswerError'; }
}

/** The `tier` answer out of a System One response. Throws on anything else. */
export function parseJevAnswer(json: unknown): ClassifierAnswer {
  const root = json as { model?: unknown; answers?: { tier?: unknown }; usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown } } | null;
  const tier = root?.answers?.tier as { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown } | undefined;
  // Reject malformed numeric output before it can influence tier selection.
  if (tier === undefined || tier === null || typeof tier !== 'object' || Array.isArray(tier)
    || tier.type !== 'choice' || typeof tier.choice !== 'string'
    || typeof tier.confidence !== 'number' || !Number.isFinite(tier.confidence)
    || tier.confidence < 0 || tier.confidence > 1
    || tier.probabilities === null || typeof tier.probabilities !== 'object'
    || Array.isArray(tier.probabilities)
    || Object.values(tier.probabilities).some((value) => typeof value !== 'number'
      || !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new MalformedAnswerError();
  }
  const probabilities = tier.probabilities as Record<string, number>;
  if (Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) > 0.01 + Number.EPSILON) {
    throw new MalformedAnswerError();
  }
  const usage = root?.usage;
  return {
    choice: tier.choice,
    confidence: tier.confidence,
    probabilities: tier.probabilities as Record<string, number>,
    ...(typeof root?.model === 'string' ? { classifierModel: root.model } : {}),
    ...(typeof usage?.input_tokens === 'number' && Number.isFinite(usage.input_tokens) && usage.input_tokens >= 0
      && typeof usage?.output_tokens === 'number' && Number.isFinite(usage.output_tokens) && usage.output_tokens >= 0
      ? { tokens: { input: usage.input_tokens, output: usage.output_tokens } } : {}),
    ...(typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? { costUsd: usage.cost } : {}),
  };
}

/**
 * Jev over plain `fetch`. The key is read per call, so adding one needs no
 * restart. `endpoint` and `model` choose the provider: TypeSafe's own
 * endpoint by default, or OpenRouter's Decisions API with a decision model.
 * `keyHint` is the command the missing-key error names.
 */
export function jevClassifier(opts: {
  fetch: typeof fetch; key: () => string | undefined; attemptMs?: number; retries?: number;
  endpoint?: string; model?: string | ((signal: AbortSignal) => Promise<string | undefined>); keyHint?: string;
  /** False for a URL that may need no key (a local server): no key then sends no Authorization header. */
  keyRequired?: boolean;
  /** A local server charges nothing, so an answer reporting no cost is free rather than unpriced. */
  loopbackFree?: boolean;
}): TierClassifier {
  const endpoint = opts.endpoint ?? JEV_ENDPOINT;
  const keyHint = opts.keyHint ?? 'sonata auth add typesafe';
  const attemptMs = opts.attemptMs ?? JEV_ATTEMPT_MS;
  const retries = opts.retries ?? 1;
  return {
    name: 'jev',
    async classify(input, signal) {
      const key = opts.key();
      if (key === undefined && opts.keyRequired !== false) throw new Error(`no classifier key — run \`${keyHint}\``);
      const model = typeof opts.model === 'function' ? await opts.model(signal) : opts.model;
      let last: unknown;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (signal.aborted) break;
        try {
          const res = await opts.fetch(endpoint, {
            method: 'POST',
            headers: { ...(key === undefined ? {} : { authorization: `Bearer ${key}` }), 'content-type': 'application/json' },
            body: JSON.stringify({ ...(model === undefined ? {} : { model }), ...jevRequestBody(input) }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(attemptMs)]),
          });
          if (!res.ok) { last = new Error(`HTTP ${res.status}`); continue; }
          let json: unknown;
          try { json = await res.json(); } catch (error) {
            if (error instanceof SyntaxError) throw new MalformedAnswerError();
            throw error;
          }
          const answer = parseJevAnswer(json);
          return opts.loopbackFree === true && answer.costUsd === undefined ? { ...answer, costUsd: 0 } : answer;
        } catch (error) {
          if (error instanceof MalformedAnswerError) throw error;
          last = error;
        }
      }
      throw last instanceof Error ? last : new Error('classifier unavailable');
    },
  };
}

/** Whether a URL points at this machine — a decision model there costs nothing. */
export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/**
 * The key-store name a decision URL's key is filed under, by host — a key is
 * only ever sent to the host it belongs to. `auto-route` is every other host:
 * a self-hosted decision server, keyed under one shared name.
 */
export function decisionGatewayFor(baseUrl: string): 'typesafe' | 'openrouter' | 'auto-route' {
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch { /* other */ }
  if (host === 'api.typesafe.ai') return 'typesafe';
  if (host === 'openrouter.ai') return 'openrouter';
  return 'auto-route';
}

/** The key a decision URL needs, by host — a key is only ever sent to the host it belongs to. */
export function decisionKeyFor(
  baseUrl: string,
  keys: { openrouter: () => string | undefined; typesafe: () => string | undefined; other: () => string | undefined },
): { key: string | undefined; hint: string } {
  const gateway = decisionGatewayFor(baseUrl);
  if (gateway === 'openrouter') return { key: keys.openrouter(), hint: 'sonata auth add openrouter' };
  if (gateway === 'typesafe') return { key: keys.typesafe(), hint: 'sonata auth add typesafe' };
  return { key: keys.other(), hint: 'sonata auth add auto-route' };
}

/** The classifier for one `[auto_route]` URL; `model` is resolved per call. */
export function decisionClassifier(
  settings: Pick<AutoRouteConfig, 'baseUrl'>,
  deps: { fetch: typeof fetch; key: () => string | undefined; keyHint: string; model: (signal: AbortSignal) => Promise<string | undefined> },
): TierClassifier {
  let host = '';
  try { host = new URL(settings.baseUrl).hostname; } catch { /* treated as other */ }
  return jevClassifier({
    fetch: deps.fetch,
    key: deps.key,
    keyHint: deps.keyHint,
    keyRequired: host === 'openrouter.ai' || host === 'api.typesafe.ai',
    endpoint: `${settings.baseUrl}/v1/systemone`,
    model: deps.model,
    loopbackFree: isLoopbackUrl(settings.baseUrl),
  });
}

export interface AutoDecision { tier: Tier; record: AutoRouteRecord }

/** One decision: clean, ask, apply the policy. Never throws. */
export async function decideTier(opts: {
  classifier: TierClassifier | undefined;
  role: string;
  body: Buffer;
  tiers: readonly Tier[];
  minConfidence: number;
  now?: () => number;
  deadlineMs?: number;
}): Promise<AutoDecision> {
  const now = opts.now ?? Date.now;
  const started = now();
  const fallback = fallbackTier(opts.tiers);
  const failed = (reason: string): AutoDecision => ({
    tier: fallback, record: { classifier: 'jev', outcome: 'failed', reason, ms: now() - started },
  });
  // No task means no question to ask: Claude Code's own side requests for a
  // background agent (measured 2026-10-02: one 7–13 s after each agent start,
  // its first message nothing but reminders) land here. Not a failure.
  const task = cleanTask(opts.body);
  if (task === undefined) return { tier: fallback, record: { classifier: 'jev', outcome: 'no-task', ms: now() - started } };
  if (opts.classifier === undefined) return failed('no classifier');

  const controller = new AbortController();
  const deadline = opts.deadlineMs ?? JEV_DEADLINE_MS;
  let timer: NodeJS.Timeout | undefined;
  let answer: ClassifierAnswer;
  try {
    answer = await Promise.race([
      opts.classifier.classify({ role: opts.role, task, tiers: opts.tiers }, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error(`no answer within ${deadline}ms`)); }, deadline);
      }),
    ]);
  } catch (error) {
    if (error instanceof MalformedAnswerError) {
      return { tier: fallback, record: { classifier: 'jev', outcome: 'invalid', reason: error.message, ms: now() - started } };
    }
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }

  const record: AutoRouteRecord = {
    classifier: 'jev',
    ...(answer.classifierModel === undefined ? {} : { classifierModel: answer.classifierModel }),
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    outcome: 'accepted',
    ms: now() - started,
    ...(answer.tokens === undefined ? {} : { tokens: answer.tokens }),
    ...(answer.costUsd === undefined ? {} : { costUsd: answer.costUsd }),
  };
  if (!(opts.tiers as readonly string[]).includes(answer.choice)) {
    return { tier: fallback, record: { ...record, outcome: 'invalid', reason: `not an offered tier: ${answer.choice}` } };
  }
  if (answer.confidence < opts.minConfidence) {
    return { tier: fallback, record: { ...record, outcome: 'low-confidence' } };
  }
  return { tier: answer.choice as Tier, record };
}

/**
 * Decisions by conversation key, bounded like the router's sticky map.
 * Concurrent first requests share one in-flight creation; a rejected
 * creation is not kept, so the next turn tries again.
 */
export class DecisionStore {
  private readonly done = new Map<string, { decision: AutoDecision; at: number }>();
  private readonly pending = new Map<string, Promise<AutoDecision>>();
  private generation = 0;
  constructor(private readonly ttlMs: number, private readonly max: number) {}

  get(key: string, at: number): AutoDecision | undefined {
    const hit = this.done.get(key);
    if (hit === undefined) return undefined;
    if (at - hit.at > this.ttlMs) { this.done.delete(key); return undefined; }
    this.done.delete(key);
    this.done.set(key, { decision: hit.decision, at });
    return hit.decision;
  }

  async getOrCreate(key: string, at: number, make: () => Promise<AutoDecision>): Promise<{ decision: AutoDecision; fresh: boolean }> {
    const hit = this.get(key, at);
    if (hit !== undefined) return { decision: hit, fresh: false };
    const inFlight = this.pending.get(key);
    if (inFlight !== undefined) return { decision: await inFlight, fresh: false };
    const generation = this.generation;
    const created = make();
    this.pending.set(key, created);
    try {
      const decision = await created;
      // Do not resurrect entries after clear() invalidates this generation.
      if (this.generation === generation) {
        this.done.set(key, { decision, at });
        while (this.done.size > this.max) {
          const oldest = this.done.keys().next();
          if (oldest.done) break;
          this.done.delete(oldest.value);
        }
      }
      return { decision, fresh: true };
    } finally {
      // A replacement promise may own this key after clear(); preserve it.
      if (this.pending.get(key) === created) this.pending.delete(key);
    }
  }

  // Invalidate in-flight creations so clear() cannot be undone by a late result.
  clear(): void { this.generation += 1; this.done.clear(); this.pending.clear(); }
  size(): number { return this.done.size; }
}
