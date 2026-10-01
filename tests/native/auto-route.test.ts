// tests/native/auto-route.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  autoRole,
  cleanTask,
  TASK_CHAR_CAP,
  fallbackTier,
  jevRequestBody,
  parseJevAnswer,
  MalformedAnswerError,
  jevClassifier,
  decideTier,
  DecisionStore,
  JEV_ENDPOINT,
  decisionClassifier,
  decisionKeyFor,
  isLoopbackUrl,
  type TierClassifier,
} from '../../src/native/auto-route.js';

const body = (messages: unknown[]) =>
  Buffer.from(JSON.stringify({ model: 'sonata-code-auto', messages }));
const ALL = ['simple', 'normal', 'complex'] as const;

const answer = (choice: string, confidence: number) => ({
  choice,
  confidence,
  probabilities: { simple: 0.1, normal: 0.2, complex: 0.7 },
  classifierModel: 'jev-1.13.0',
  tokens: { input: 300, output: 30 },
});
const fixed = (a: ReturnType<typeof answer>): TierClassifier => ({
  name: 'jev',
  classify: async () => a,
});

describe('autoRole', () => {
  it('reads the role from an auto alias', () => {
    expect(autoRole('sonata-code-auto')).toBe('code');
    expect(autoRole('sonata-code-simple')).toBeUndefined();
    expect(autoRole('code-auto')).toBeUndefined();
    expect(autoRole('sonata--auto')).toBeUndefined();
  });
});

describe('cleanTask', () => {
  it('keeps text blocks of the first user message and drops reminders', () => {
    const task = cleanTask(
      body([
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<system-reminder>\nCLAUDE.md stuff\n</system-reminder>',
            },
            { type: 'text', text: 'Rename foo to bar in src/a.ts' },
            { type: 'image', source: {} },
          ],
        },
        { role: 'assistant', content: 'later turn' },
      ]),
    );
    expect(task).toBe('Rename foo to bar in src/a.ts');
  });

  it('accepts string content and strips inline reminders', () => {
    expect(
      cleanTask(
        body([
          {
            role: 'user',
            content: 'Do X <system-reminder>secret</system-reminder> now',
          },
        ]),
      ),
    ).toBe('Do X  now');
  });

  it('returns undefined when only reminders remain', () => {
    expect(
      cleanTask(
        body([
          { role: 'user', content: '<system-reminder>only</system-reminder>' },
        ]),
      ),
    ).toBeUndefined();
  });

  it('caps the text, keeping the start', () => {
    const long = 'a'.repeat(TASK_CHAR_CAP + 500);
    expect(cleanTask(body([{ role: 'user', content: long }]))?.length).toBe(
      TASK_CHAR_CAP,
    );
  });

  it('returns undefined for an unparseable body or no user message', () => {
    expect(cleanTask(Buffer.from('not json'))).toBeUndefined();
    expect(cleanTask(body([]))).toBeUndefined();
  });
});

describe('fallbackTier', () => {
  it('is normal, else the next tier up', () => {
    expect(fallbackTier(ALL)).toBe('normal');
    expect(fallbackTier(['simple', 'complex'])).toBe('complex');
  });
});

describe('jevRequestBody', () => {
  it('offers only the role\'s tiers, in order, with state role and task', () => {
    const req = jevRequestBody({
      role: 'code',
      task: 'T',
      tiers: ['simple', 'complex'],
    }) as any;
    expect(req.state).toEqual({ role: 'code', task: 'T' });
    expect(req.questions.tier.type).toBe('choice');
    expect(Object.keys(req.questions.tier.criteria)).toEqual([
      'simple',
      'complex',
    ]);
    expect(JSON.stringify(req.questions.tier)).toMatch(
      /Size is not difficulty/,
    );
  });
});

describe('parseJevAnswer', () => {
  it('reads the tier answer, model and usage', () => {
    const a = parseJevAnswer({
      model: 'jev-1.13.0',
      answers: {
        tier: {
          type: 'choice',
          choice: 'simple',
          probabilities: { simple: 0.88, normal: 0.12, complex: 0 },
          confidence: 0.81,
        },
      },
      usage: { input_tokens: 318, output_tokens: 34 },
    });
    expect(a).toEqual({
      choice: 'simple',
      confidence: 0.81,
      probabilities: { simple: 0.88, normal: 0.12, complex: 0 },
      classifierModel: 'jev-1.13.0',
      tokens: { input: 318, output: 34 },
    });
  });

  it('throws on a malformed body', () => {
    expect(() => parseJevAnswer({ answers: {} })).toThrow();
    expect(() =>
      parseJevAnswer({ answers: { tier: { choice: 1, confidence: 'x' } } }),
    ).toThrow();
  });

  it('rejects malformed probabilities and confidence values', () => {
    const base = {
      answers: {
        tier: {
          type: 'choice',
          choice: 'simple',
          confidence: 0.5,
          probabilities: { simple: 1 },
        },
      },
    };
    expect(() =>
      parseJevAnswer({
        ...base,
        answers: { tier: { ...base.answers.tier, probabilities: [] } },
      }),
    ).toThrow();
    expect(() =>
      parseJevAnswer({
        ...base,
        answers: {
          tier: { ...base.answers.tier, probabilities: { simple: 'x' } },
        },
      }),
    ).toThrow();
    for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() =>
        parseJevAnswer({
          ...base,
          answers: { tier: { ...base.answers.tier, confidence } },
        }),
      ).toThrow();
    }
  });

  it('requires a choice answer and probabilities that sum to one', () => {
    const valid = {
      answers: {
        tier: {
          type: 'choice', choice: 'simple', confidence: 0.5, probabilities: { simple: 1 },
        },
      },
    };
    expect(() => parseJevAnswer({ ...valid, answers: { tier: { ...valid.answers.tier, type: 'score' } } })).toThrow(MalformedAnswerError);
    expect(() => parseJevAnswer({ ...valid, answers: { tier: { ...valid.answers.tier, probabilities: { simple: 0.5 } } } })).toThrow(MalformedAnswerError);
    expect(() => parseJevAnswer({ ...valid, answers: { tier: { ...valid.answers.tier, probabilities: { simple: 0.98 } } } })).toThrow(MalformedAnswerError);
    expect(() => parseJevAnswer({ ...valid, answers: { tier: { ...valid.answers.tier, probabilities: { simple: 0.5, normal: 0.5, extra: 0.02 } } } })).toThrow(MalformedAnswerError);
  });

  it('omits invalid usage counts instead of recording them', () => {
    const base = {
      model: 'jev-1.13.0',
      answers: { tier: { type: 'choice', choice: 'simple', confidence: 1, probabilities: { simple: 1 } } },
    };
    for (const usage of [
      { input_tokens: -1, output_tokens: 2 },
      { input_tokens: Number.NaN, output_tokens: 2 },
      { input_tokens: 2, output_tokens: Number.POSITIVE_INFINITY },
      { input_tokens: 2, output_tokens: '2' },
    ]) {
      expect(parseJevAnswer({ ...base, usage }).tokens).toBeUndefined();
    }
  });
});

describe('decideTier', () => {
  const b = body([{ role: 'user', content: 'Rename foo' }]);

  it('accepts a confident, offered choice', async () => {
    const d = await decideTier({
      classifier: fixed(answer('complex', 0.8)),
      role: 'code',
      body: b,
      tiers: ALL,
      minConfidence: 0.5,
    });
    expect(d.tier).toBe('complex');
    expect(d.record).toMatchObject({
      classifier: 'jev',
      outcome: 'accepted',
      choice: 'complex',
      confidence: 0.8,
      classifierModel: 'jev-1.13.0',
    });
  });

  it('falls back below min_confidence', async () => {
    const d = await decideTier({
      classifier: fixed(answer('simple', 0.3)),
      role: 'code',
      body: b,
      tiers: ALL,
      minConfidence: 0.5,
    });
    expect(d.tier).toBe('normal');
    expect(d.record.outcome).toBe('low-confidence');
    expect(d.record.choice).toBe('simple');
  });

  it('falls back on a tier the role does not have', async () => {
    const d = await decideTier({
      classifier: fixed(answer('normal', 0.9)),
      role: 'code',
      body: b,
      tiers: ['simple', 'complex'],
      minConfidence: 0.5,
    });
    expect(d.tier).toBe('complex');
    expect(d.record.outcome).toBe('invalid');
  });

  it('falls back with outcome failed when there is no classifier (no key)', async () => {
    const d = await decideTier({
      classifier: undefined,
      role: 'code',
      body: b,
      tiers: ALL,
      minConfidence: 0.5,
    });
    expect(d).toMatchObject({ tier: 'normal', record: { outcome: 'failed' } });
  });

  it('never calls the classifier for an empty task', async () => {
    const classify = vi.fn();
    const d = await decideTier({
      classifier: { name: 'jev', classify },
      role: 'code',
      body: body([
        { role: 'user', content: '<system-reminder>x</system-reminder>' },
      ]),
      tiers: ALL,
      minConfidence: 0.5,
    });
    expect(classify).not.toHaveBeenCalled();
    expect(d).toMatchObject({
      tier: 'normal',
      record: { outcome: 'failed', reason: 'empty task' },
    });
  });

  it('records malformed classifier answers as invalid', async () => {
    const malformed = [
      null,
      { answers: {} },
      { answers: { tier: null } },
      { answers: { tier: 42 } },
      { answers: { tier: 'choice' } },
      { answers: { tier: { choice: 'simple', confidence: 1, probabilities: { simple: 1 } } } },
      { answers: { tier: { type: 'choice', choice: 1, confidence: 1, probabilities: { simple: 1 } } } },
      { answers: { tier: { type: 'choice', choice: 'simple', confidence: NaN, probabilities: { simple: 1 } } } },
      { answers: { tier: { type: 'choice', choice: 'simple', confidence: 1, probabilities: [] } } },
      { answers: { tier: { type: 'choice', choice: 'simple', confidence: 1, probabilities: { simple: -1 } } } },
      { answers: { tier: { type: 'score', choice: 'simple', confidence: 1, probabilities: { simple: 1 } } } },
      { answers: { tier: { type: 'choice', choice: 'simple', confidence: 1, probabilities: { simple: 0.5 } } } },
    ];
    for (const payload of malformed) {
      const d = await decideTier({
        classifier: { name: 'jev', classify: async () => parseJevAnswer(payload) },
        role: 'code', body: b, tiers: ALL, minConfidence: 0.5,
      });
      expect(d.tier).toBe('normal');
      expect(d.record).toMatchObject({ classifier: 'jev', outcome: 'invalid' });
      expect(d.record.reason).toMatch(/malformed classifier response/);
    }
  });

  it('falls back when the classifier throws, recording the reason but not the task', async () => {
    const d = await decideTier({
      classifier: {
        name: 'jev',
        classify: async () => {
          throw new Error('HTTP 503');
        },
      },
      role: 'code',
      body: b,
      tiers: ALL,
      minConfidence: 0.5,
    });
    expect(d).toMatchObject({
      tier: 'normal',
      record: { outcome: 'failed', reason: 'HTTP 503' },
    });
    expect(JSON.stringify(d.record)).not.toContain('Rename foo');
  });

  it('falls back at the deadline when the classifier hangs', async () => {
    const started = Date.now();
    const d = await decideTier({
      classifier: { name: 'jev', classify: () => new Promise(() => {}) },
      role: 'code',
      body: b,
      tiers: ALL,
      minConfidence: 0.5,
      deadlineMs: 50,
    });
    expect(d.record.outcome).toBe('failed');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('jevClassifier', () => {
  const ok = () =>
    new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          tier: {
            type: 'choice',
            choice: 'normal',
            probabilities: { simple: 0.1, normal: 0.8, complex: 0.1 },
            confidence: 0.7,
          },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      { status: 200 },
    );

  it('posts to the System One endpoint with a bearer key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = jevClassifier({
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return ok();
      }) as any,
      key: () => 'k-123',
    });
    const a = await c.classify(
      { role: 'code', task: 'T', tiers: ['simple', 'normal', 'complex'] },
      new AbortController().signal,
    );
    expect(a.choice).toBe('normal');
    expect(calls[0].url).toBe(JEV_ENDPOINT);
    expect(
      (calls[0].init.headers as Record<string, string>).authorization,
    ).toBe('Bearer k-123');
  });

  it('throws without a key, without calling fetch', async () => {
    const f = vi.fn();
    const c = jevClassifier({ fetch: f as any, key: () => undefined });
    await expect(
      c.classify(
        { role: 'code', task: 'T', tiers: ['simple'] },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/sonata auth add typesafe/);
    expect(f).not.toHaveBeenCalled();
  });

  it('reads the key per call, so a key added later is picked up', async () => {
    let key: string | undefined;
    const f = vi.fn(async () => new Response(JSON.stringify({ answers: { tier: { type: 'choice', choice: 'simple', confidence: 1, probabilities: { simple: 1 } } } }), { status: 200 }));
    const c = jevClassifier({ fetch: f as any, key: () => key });
    await expect(c.classify({ role: 'code', task: 'T', tiers: ['simple'] }, new AbortController().signal)).rejects.toThrow();
    key = 'k';
    await expect(c.classify({ role: 'code', task: 'T', tiers: ['simple'] }, new AbortController().signal)).resolves.toMatchObject({ choice: 'simple' });
  });

  it('does not retry a malformed answer body', async () => {
    let n = 0;
    const c = jevClassifier({
      fetch: (async () => {
        n += 1;
        return new Response(JSON.stringify({ answers: { tier: { type: 'choice', choice: 'simple', confidence: 1, probabilities: { simple: 0.5 } } } }), { status: 200 });
      }) as any,
      key: () => 'k',
    });
    await expect(c.classify({ role: 'code', task: 'T', tiers: ['simple'] }, new AbortController().signal)).rejects.toBeInstanceOf(MalformedAnswerError);
    expect(n).toBe(1);
  });

  it('records non-JSON answers as invalid without retrying', async () => {
    let calls = 0;
    const classifier = jevClassifier({ fetch: (async () => { calls += 1; return new Response('not json'); }) as any, key: () => 'k' });
    const d = await decideTier({ classifier, role: 'code', body: body([{ role: 'user', content: 'T' }]), tiers: ALL, minConfidence: 0.5 });
    expect(d.record.outcome).toBe('invalid');
    expect(calls).toBe(1);
  });

  it('records network and HTTP failures as failed after retrying', async () => {
    for (const fail of [async () => { throw new Error('network unavailable'); }, async () => new Response('x', { status: 503 })]) {
      let calls = 0;
      const classifier = jevClassifier({ fetch: (async () => { calls += 1; return fail(); }) as any, key: () => 'k' });
      const d = await decideTier({ classifier, role: 'code', body: body([{ role: 'user', content: 'T' }]), tiers: ALL, minConfidence: 0.5 });
      expect(d.record.outcome).toBe('failed');
      expect(calls).toBe(2);
    }
  });

  it('retries once after a non-2xx, then succeeds', async () => {
    let n = 0;
    const c = jevClassifier({
      fetch: (async () =>
        ++n === 1 ? new Response('x', { status: 503 }) : ok()) as any,
      key: () => 'k',
    });
    await expect(
      c.classify(
        { role: 'code', task: 'T', tiers: ['simple', 'normal', 'complex'] },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ choice: 'normal' });
    expect(n).toBe(2);
  });
});

describe('DecisionStore', () => {
  it('shares one in-flight decision between concurrent callers', async () => {
    const store = new DecisionStore(60_000, 10);
    let calls = 0;
    const make = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return {
        tier: 'simple' as const,
        record: {
          classifier: 'jev' as const,
          outcome: 'accepted' as const,
          ms: 1,
        },
      };
    };
    const [a, b] = await Promise.all([
      store.getOrCreate('k', 0, make),
      store.getOrCreate('k', 0, make),
    ]);
    expect(calls).toBe(1);
    expect([a.fresh, b.fresh].sort()).toEqual([false, true]);
    expect(store.get('k', 1)?.tier).toBe('simple');
  });

  it('expires by ttl and evicts beyond the cap', async () => {
    const store = new DecisionStore(100, 2);
    const d = {
      tier: 'normal' as const,
      record: {
        classifier: 'jev' as const,
        outcome: 'accepted' as const,
        ms: 1,
      },
    };
    await store.getOrCreate('a', 0, async () => d);
    expect(store.get('a', 50)).toBeDefined();
    expect(store.get('a', 200)).toBeUndefined();
    await store.getOrCreate('b', 0, async () => d);
    await store.getOrCreate('c', 0, async () => d);
    await store.getOrCreate('e', 0, async () => d);
    expect(store.size()).toBe(2);
  });

  it('does not keep a rejected creation', async () => {
    const store = new DecisionStore(60_000, 10);
    await expect(
      store.getOrCreate('k', 0, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow();
    expect(store.get('k', 1)).toBeUndefined();
  });

  it('does not resurrect a creation that was pending when cleared', async () => {
    const store = new DecisionStore(60_000, 10);
    let resolve!: (decision: {
      tier: 'simple';
      record: { classifier: 'jev'; outcome: 'accepted'; ms: number };
    }) => void;
    const pending = new Promise<{
      tier: 'simple';
      record: { classifier: 'jev'; outcome: 'accepted'; ms: number };
    }>((r) => {
      resolve = r;
    });
    const creation = store.getOrCreate('k', 0, () => pending);
    store.clear();
    resolve({
      tier: 'simple',
      record: { classifier: 'jev', outcome: 'accepted', ms: 1 },
    });
    await creation;
    expect(store.get('k', 1)).toBeUndefined();
  });

  it('keeps a replacement creation pending when the cleared one settles', async () => {
    const store = new DecisionStore(60_000, 10);
    let resolveA!: (decision: {
      tier: 'simple';
      record: { classifier: 'jev'; outcome: 'accepted'; ms: number };
    }) => void;
    let resolveB!: (decision: {
      tier: 'normal';
      record: { classifier: 'jev'; outcome: 'accepted'; ms: number };
    }) => void;
    const a = new Promise<{
      tier: 'simple';
      record: { classifier: 'jev'; outcome: 'accepted'; ms: number };
    }>((r) => {
      resolveA = r;
    });
    const b = new Promise<{
      tier: 'normal';
      record: { classifier: 'jev'; outcome: 'accepted'; ms: number };
    }>((r) => {
      resolveB = r;
    });
    const first = store.getOrCreate('k', 0, () => a);
    store.clear();
    const second = store.getOrCreate('k', 1, () => b);
    resolveA({
      tier: 'simple',
      record: { classifier: 'jev', outcome: 'accepted', ms: 1 },
    });
    await first;
    const makeC = vi.fn(async () => ({
      tier: 'complex' as const,
      record: {
        classifier: 'jev' as const,
        outcome: 'accepted' as const,
        ms: 1,
      },
    }));
    const third = store.getOrCreate('k', 2, makeC);
    expect(makeC).not.toHaveBeenCalled();
    resolveB({
      tier: 'normal',
      record: { classifier: 'jev', outcome: 'accepted', ms: 2 },
    });
    await second;
    await third;
    expect(store.get('k', 3)?.tier).toBe('normal');
  });
});

describe('decision providers', () => {
  const answerBody = (usage: Record<string, unknown> = { input_tokens: 476, output_tokens: 70, cost: 0.000019992 }) => JSON.stringify({
    id: 'gen-1', model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe',
    answers: { tier: { type: 'choice', choice: 'normal', confidence: 0.67, probabilities: { simple: 0.11, normal: 0.78, complex: 0.11 } } },
    usage,
  });

  it('posts to OpenRouter\'s Decisions API with the model and the OpenRouter key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = jevClassifier({
      fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(answerBody(), { status: 200 }); }) as any,
      key: () => 'or-key', endpoint: 'https://openrouter.ai/api/v1/systemone', model: '~typesafe/jev-latest',
    });
    const a = await c.classify({ role: 'code', task: 'T', tiers: ['simple', 'normal', 'complex'] }, new AbortController().signal);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/systemone');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer or-key');
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.model).toBe('~typesafe/jev-latest');
    expect(sent.questions.tier.type).toBe('choice');
    expect(a).toMatchObject({ choice: 'normal', classifierModel: 'typesafe/jev-1.13-20260917', costUsd: 0.000019992 });
  });

  it('sends no model field to TypeSafe\'s own endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = jevClassifier({ fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(answerBody(), { status: 200 }); }) as any, key: () => 'k' });
    await c.classify({ role: 'code', task: 'T', tiers: ['simple', 'normal', 'complex'] }, new AbortController().signal);
    expect(calls[0].url).toBe(JEV_ENDPOINT);
    expect(JSON.parse(calls[0].init.body as string).model).toBeUndefined();
  });

  it('ignores a cost that is not a finite non-negative number', () => {
    expect(parseJevAnswer(JSON.parse(answerBody({ input_tokens: 1, output_tokens: 1, cost: -1 }))).costUsd).toBeUndefined();
    expect(parseJevAnswer(JSON.parse(answerBody({ input_tokens: 1, output_tokens: 1 }))).costUsd).toBeUndefined();
  });

  it('records the classifier cost on the decision', async () => {
    const d = await decideTier({
      classifier: { name: 'jev', classify: async () => ({ choice: 'simple', confidence: 0.9, probabilities: { simple: 1 }, costUsd: 0.00002 }) },
      role: 'code', body: Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'Rename foo' }] })), tiers: ['simple', 'normal', 'complex'], minConfidence: 0.5,
    });
    expect(d.record.costUsd).toBe(0.00002);
  });

  it('names the key to add in the missing-key error', async () => {
    const c = jevClassifier({ fetch: (async () => new Response('')) as any, key: () => undefined, keyHint: 'sonata auth add openrouter' });
    await expect(c.classify({ role: 'code', task: 'T', tiers: ['simple'] }, new AbortController().signal)).rejects.toThrow(/sonata auth add openrouter/);
  });
});

describe('URL-based decision classifier', () => {
  const ok = (usage?: Record<string, unknown>) => new Response(JSON.stringify({
    answers: { tier: { type: 'choice', choice: 'simple', confidence: 1, probabilities: { simple: 1 } } }, ...(usage ? { usage } : {}),
  }), { status: 200 });

  it('posts to <base_url>/v1/systemone with the lazily chosen model', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = decisionClassifier({ baseUrl: 'https://openrouter.ai/api' }, {
      fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return ok({ cost: 0.00002 }); }) as any,
      key: () => 'or', keyHint: 'sonata auth add openrouter', model: async () => 'typesafe/jev-1.13',
    });
    const a = await c.classify({ role: 'code', task: 'T', tiers: ['simple'] }, new AbortController().signal);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(JSON.parse(calls[0].init.body as string).model).toBe('typesafe/jev-1.13');
    expect(a.costUsd).toBe(0.00002);
  });

  it('sends no model field when none is chosen, and no auth header without a key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = decisionClassifier({ baseUrl: 'http://localhost:8000' }, {
      fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return ok(); }) as any,
      key: () => undefined, keyHint: 'sonata auth add auto-route', model: async () => undefined,
    });
    const a = await c.classify({ role: 'code', task: 'T', tiers: ['simple'] }, new AbortController().signal);
    expect(JSON.parse(calls[0].init.body as string).model).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(a.costUsd).toBe(0);
  });

  it('leaves a non-loopback answer without a reported cost unpriced', async () => {
    const c = decisionClassifier({ baseUrl: 'https://decide.example.com' }, {
      fetch: (async () => ok()) as any, key: () => 'k', keyHint: 'h', model: async () => undefined,
    });
    expect((await c.classify({ role: 'code', task: 'T', tiers: ['simple'] }, new AbortController().signal)).costUsd).toBeUndefined();
  });

  it('picks the key by host and never sends the OpenRouter key elsewhere', () => {
    const keys = { openrouter: () => 'OR', typesafe: () => 'TS', other: () => 'OTHER' };
    expect(decisionKeyFor('https://openrouter.ai/api', keys)).toEqual({ key: 'OR', hint: 'sonata auth add openrouter' });
    expect(decisionKeyFor('https://api.typesafe.ai', keys)).toEqual({ key: 'TS', hint: 'sonata auth add typesafe' });
    expect(decisionKeyFor('http://localhost:8000', keys)).toEqual({ key: 'OTHER', hint: 'sonata auth add auto-route' });
    expect(decisionKeyFor('https://evil.example/openrouter.ai', keys).key).toBe('OTHER');
  });

  it('recognises loopback hosts', () => {
    expect(['http://localhost:8000', 'http://127.0.0.1:9', 'http://[::1]:8000'].every(isLoopbackUrl)).toBe(true);
    expect(isLoopbackUrl('https://openrouter.ai/api')).toBe(false);
  });
});
