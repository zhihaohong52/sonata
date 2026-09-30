/**
 * Automatic tier choice for `sonata-<role>-auto`.
 *
 * Tier selection asks TypeSafe's System One model Jev one Choice question,
 * once per conversation, and hands the answer to the unchanged tier path.
 */
import type { Tier } from '../commands/agents.js';
import type { AutoRouteRecord } from '../ledger.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_ATTEMPT_MS = 1_500;
export const JEV_DEADLINE_MS = 3_000;
export const TASK_CHAR_CAP = 8_000;

const AUTO_ALIAS = /^sonata-(.+)-auto$/;
export function autoRole(alias: string): string | undefined {
  const match = AUTO_ALIAS.exec(alias);
  return match === null || match[1].length === 0 ? undefined : match[1];
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
export function cleanTask(body: Buffer): string | undefined {
  let messages: unknown;
  try {
    messages = (JSON.parse(body.toString()) as { messages?: unknown }).messages;
  } catch {
    return undefined;
  }
  if (!Array.isArray(messages)) return undefined;
  const first = messages.find(
    (m) => (m as { role?: unknown })?.role === 'user',
  ) as { content?: unknown } | undefined;
  if (first === undefined) return undefined;
  const parts =
    typeof first.content === 'string'
      ? [first.content]
      : Array.isArray(first.content)
        ? first.content
            .filter(
              (b) =>
                (b as { type?: unknown })?.type === 'text' &&
                typeof (b as { text?: unknown }).text === 'string',
            )
            .map((b) => (b as { text: string }).text)
        : [];
  const text = parts.join('\n').replace(REMINDER, '').trim();
  return text.length === 0 ? undefined : text.slice(0, TASK_CHAR_CAP);
}

export function fallbackTier(tiers: readonly Tier[]): Tier {
  if (tiers.includes('normal')) return 'normal';
  if (tiers.includes('complex')) return 'complex';
  return tiers[0];
}

const TIER_CRITERIA: Record<Tier, { what: string; not_for: string }> = {
  simple: {
    what:
      'Specified closely enough that the change could be written without asking a question; ' +
      'typically one or two files and no interface change. A large mechanical change is simple.',
    not_for:
      'Work that needs a design decision or reading the surrounding code to fit in.',
  },
  normal: {
    what:
      'You know what to change but not exactly how; needs reading the surrounding code; may touch several files; ' +
      'what \'done\' means is not in question.',
    not_for: 'Open design choices, or an ambiguous definition of done.',
  },
  complex: {
    what:
      'Needs a design decision affecting other components, or is ambiguous about what \'done\' means, so the first job ' +
      'is deciding what to build. ' +
      'A three-line change that decides an interface is complex.',
    not_for: 'Routine work with a clear implementation, however large.',
  },
};
export function jevRequestBody(input: {
  role: string;
  task: string;
  tiers: readonly Tier[];
}): object {
  return {
    state: { role: input.role, task: input.task },
    questions: {
      tier: {
        type: 'choice',
        instructions: [
          'Pick the cheapest tier that can fully complete `task` in one pass, without being re-run at a higher tier.',
          '`role` is the kind of work (code, review, explore or plan). Size is not difficulty.',
        ],
        criteria: Object.fromEntries(
          input.tiers.map((tier) => [tier, TIER_CRITERIA[tier]]),
        ),
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
}
export interface TierClassifier {
  name: 'jev';
  classify(
    input: { role: string; task: string; tiers: readonly Tier[] },
    signal: AbortSignal,
  ): Promise<ClassifierAnswer>;
}
export function parseJevAnswer(json: unknown): ClassifierAnswer {
  const root = json as {
    model?: unknown;
    answers?: { tier?: unknown };
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  const tier = root?.answers?.tier as
    | { choice?: unknown; confidence?: unknown; probabilities?: unknown }
    | undefined;
  const probabilities = tier?.probabilities;
  const validProbabilities =
    probabilities !== null &&
    typeof probabilities === 'object' &&
    !Array.isArray(probabilities) &&
    Object.values(probabilities as Record<string, unknown>).every(
      (value) =>
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= 1,
    );
  if (
    tier === undefined ||
    typeof tier.choice !== 'string' ||
    typeof tier.confidence !== 'number' ||
    !Number.isFinite(tier.confidence) ||
    tier.confidence < 0 ||
    tier.confidence > 1 ||
    !validProbabilities
  ) {
    throw new Error('malformed classifier response');
  }
  const usage = root.usage;
  return {
    choice: tier.choice,
    confidence: tier.confidence,
    probabilities: probabilities as Record<string, number>,
    ...(typeof root.model === 'string' ? { classifierModel: root.model } : {}),
    ...(typeof usage?.input_tokens === 'number' &&
    typeof usage?.output_tokens === 'number'
      ? { tokens: { input: usage.input_tokens, output: usage.output_tokens } }
      : {}),
  };
}

export function jevClassifier(opts: {
  fetch: typeof fetch;
  key: () => string | undefined;
  attemptMs?: number;
  retries?: number;
}): TierClassifier {
  const attemptMs = opts.attemptMs ?? JEV_ATTEMPT_MS;
  const retries = opts.retries ?? 1;
  return {
    name: 'jev',
    async classify(input, signal) {
      const key = opts.key();
      if (key === undefined)
        throw new Error('no TypeSafe key — run `sonata auth add typesafe`');
      let last: unknown;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (signal.aborted) break;
        try {
          const res = await opts.fetch(JEV_ENDPOINT, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${key}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(jevRequestBody(input)),
            signal: AbortSignal.any([signal, AbortSignal.timeout(attemptMs)]),
          });
          if (!res.ok) {
            last = new Error(`HTTP ${res.status}`);
            continue;
          }
          return parseJevAnswer(await res.json());
        } catch (error) {
          last = error;
        }
      }
      throw last instanceof Error ? last : new Error('classifier unavailable');
    },
  };
}

export interface AutoDecision {
  tier: Tier;
  record: AutoRouteRecord;
}
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
    tier: fallback,
    record: {
      classifier: 'jev',
      outcome: 'failed',
      reason,
      ms: now() - started,
    },
  });
  if (opts.classifier === undefined) return failed('no classifier');
  const task = cleanTask(opts.body);
  if (task === undefined) return failed('empty task');
  const controller = new AbortController();
  const deadline = opts.deadlineMs ?? JEV_DEADLINE_MS;
  let timer: NodeJS.Timeout | undefined;
  let answer: ClassifierAnswer;
  try {
    answer = await Promise.race([
      opts.classifier.classify(
        { role: opts.role, task, tiers: opts.tiers },
        controller.signal,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`no answer within ${deadline}ms`));
        }, deadline);
      }),
    ]);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
  const record: AutoRouteRecord = {
    classifier: 'jev',
    ...(answer.classifierModel === undefined
      ? {}
      : { classifierModel: answer.classifierModel }),
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    outcome: 'accepted',
    ms: now() - started,
    ...(answer.tokens === undefined ? {} : { tokens: answer.tokens }),
  };
  if (!(opts.tiers as readonly string[]).includes(answer.choice))
    return {
      tier: fallback,
      record: {
        ...record,
        outcome: 'invalid',
        reason: `not an offered tier: ${answer.choice}`,
      },
    };
  if (answer.confidence < opts.minConfidence)
    return { tier: fallback, record: { ...record, outcome: 'low-confidence' } };
  return { tier: answer.choice as Tier, record };
}

export class DecisionStore {
  private readonly done = new Map<
    string,
    { decision: AutoDecision; at: number }
  >();
  private readonly pending = new Map<string, Promise<AutoDecision>>();
  private generation = 0;
  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}
  get(key: string, at: number): AutoDecision | undefined {
    const hit = this.done.get(key);
    if (hit === undefined) return undefined;
    if (at - hit.at > this.ttlMs) {
      this.done.delete(key);
      return undefined;
    }
    this.done.delete(key);
    this.done.set(key, { decision: hit.decision, at });
    return hit.decision;
  }
  async getOrCreate(
    key: string,
    at: number,
    make: () => Promise<AutoDecision>,
  ): Promise<{ decision: AutoDecision; fresh: boolean }> {
    const hit = this.get(key, at);
    if (hit !== undefined) return { decision: hit, fresh: false };
    const inFlight = this.pending.get(key);
    if (inFlight !== undefined)
      return { decision: await inFlight, fresh: false };
    const generation = this.generation;
    const created = make();
    this.pending.set(key, created);
    try {
      const decision = await created;
      if (generation === this.generation) {
        this.done.set(key, { decision, at });
        while (this.done.size > this.max) {
          const oldest = this.done.keys().next();
          if (oldest.done) break;
          this.done.delete(oldest.value);
        }
      }
      return { decision, fresh: true };
    } finally {
      if (this.pending.get(key) === created) this.pending.delete(key);
    }
  }
  clear(): void {
    this.generation += 1;
    this.done.clear();
    this.pending.clear();
  }
  size(): number {
    return this.done.size;
  }
}
