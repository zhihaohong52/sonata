import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config.js';
import { tierQualifiesForExtendedContext, extendedContextAdvice, EXTENDED_CONTEXT_TOKENS } from '../src/extended-context.js';
import { tierAgentMarkdown } from '../src/commands/sync.js';
import { nativeSessionEnv } from '../src/commands/code.js';

const toml = (models: string) => parseConfig(`
[native.gateways."acme"]
base_url = "https://acme.example/v1"
${models}
`);

const native = (key: string, window?: number) => `
[models.${JSON.stringify(key)}]
gateway = "acme"
id = ${JSON.stringify(key)}
${window === undefined ? '' : `context_window = ${window}`}
`;

describe('tierQualifiesForExtendedContext', () => {
  // A tier is a ranked fallback list, so the window has to hold for whichever
  // candidate actually answers — not merely for the best of them.
  it('qualifies only when every candidate is at least 1M', () => {
    const config = toml(native('big-a', 1_000_000) + native('big-b', 1_048_576));
    expect(tierQualifiesForExtendedContext(config, ['big-a', 'big-b'])).toBe(true);
  });

  it('refuses when one candidate is smaller', () => {
    const config = toml(native('big', 1_000_000) + native('small', 128_000));
    expect(tierQualifiesForExtendedContext(config, ['big', 'small'])).toBe(false);
  });

  // Unknown is not 1M. Claiming a window sonata cannot vouch for trades a
  // wasted window for a hard context-limit error on the model that answers.
  it('refuses when a candidate declares no window at all', () => {
    const config = toml(native('big', 1_000_000) + native('silent'));
    expect(tierQualifiesForExtendedContext(config, ['big', 'silent'])).toBe(false);
  });

  it('refuses an empty tier', () => {
    expect(tierQualifiesForExtendedContext(toml(native('big', 1_000_000)), [])).toBe(false);
  });

  // A harness-only entry is a `sonata dispatch` fallback; it never serves the
  // alias, so its (absent) window must not veto the tier.
  it('ignores a harness-only candidate', () => {
    const config = parseConfig(`
[native.gateways."acme"]
base_url = "https://acme.example/v1"

[models."big"]
gateway = "acme"
id = "big"
context_window = 1000000

[models."viahar"]
harness = "opencode"
id = "openrouter/x"
`);
    expect(tierQualifiesForExtendedContext(config, ['big', 'viahar'])).toBe(true);
  });

  it('refuses a tier with no native candidate at all', () => {
    const config = parseConfig(`
[models."viahar"]
harness = "opencode"
id = "openrouter/x"
`);
    expect(tierQualifiesForExtendedContext(config, ['viahar'])).toBe(false);
  });
});

describe('tierAgentMarkdown — the [1m] alias suffix', () => {
  // Measured 2026-09-11: Claude Code strips the suffix before forwarding, so
  // the router still sees the bare alias and resolution is unaffected.
  it('suffixes the alias when the tier qualifies', () => {
    const md = tierAgentMarkdown({ role: 'code', tier: 'complex', extendedContext: true });
    expect(md).toContain('model: sonata-code-complex[1m]');
  });

  it('leaves the alias bare when it does not', () => {
    const md = tierAgentMarkdown({ role: 'code', tier: 'complex', extendedContext: false });
    expect(md).toContain('model: sonata-code-complex');
    expect(md).not.toContain('[1m]');
  });

  it('suffixes a collapsed (tier-less) alias too', () => {
    expect(tierAgentMarkdown({ role: 'code', extendedContext: true })).toContain('model: sonata-code[1m]');
  });

  it('defaults to bare when the caller says nothing', () => {
    expect(tierAgentMarkdown({ role: 'code', tier: 'simple' })).not.toContain('[1m]');
  });
});

describe('nativeSessionEnv — the context floor', () => {
  const env = (models: string) => nativeSessionEnv(toml(models), 4100);

  // The variable applies to every unrecognized id at once, so it must stay the
  // smallest window that could answer. Models addressed through a [1m] alias
  // no longer depend on it and would only drag the floor down.
  it('ignores models at or above 1M when computing the floor', () => {
    expect(env(native('small', 128_000) + native('big', 1_000_000)).CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('128000');
  });

  it('is omitted entirely when every model is at least 1M', () => {
    expect(env(native('big', 1_000_000) + native('bigger', 1_048_576)).CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  it('still reports the smallest of several sub-1M models', () => {
    expect(env(native('a', 200_000) + native('b', 64_000)).CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('64000');
  });

  it('uses the documented 1M threshold', () => {
    expect(EXTENDED_CONTEXT_TOKENS).toBe(1_000_000);
  });
});

describe('extendedContextAdvice — what routing costs the main session', () => {
  // Measured 2026-09-11 and documented: behind a gateway Claude Code cannot
  // verify 1M support, so a model relying on its *native* 1M window is
  // budgeted at 200K. An explicit `[1m]` is immune, because there is nothing
  // left to verify. Sonata causes this by pointing ANTHROPIC_BASE_URL at its
  // own router, so it owes the user the disclosure.
  it('warns when routing is on and the model setting has no [1m]', () => {
    const advice = extendedContextAdvice({ routed: true, model: 'sonnet' });
    expect(advice).toMatch(/200K|200k/);
    expect(advice).toContain('sonnet[1m]');
  });

  it('stays silent when the model already asks for [1m]', () => {
    expect(extendedContextAdvice({ routed: true, model: 'fable[1m]' })).toBeUndefined();
  });

  it('stays silent when the project is not routed', () => {
    expect(extendedContextAdvice({ routed: false, model: 'sonnet' })).toBeUndefined();
  });

  // With no model pinned the session uses whatever the picker last chose, so
  // sonata cannot name a replacement — but the demotion still applies.
  it('warns without inventing a model name when none is set', () => {
    const advice = extendedContextAdvice({ routed: true });
    expect(advice).toMatch(/200K|200k/);
    expect(advice).toContain('[1m]');
  });

  // `readSettings` returns an open record, so `model` is whatever JSON held.
  // A non-string value used to reach `.toLowerCase()` and throw, which took
  // down the whole of `sonata doctor` — the one command whose job is to report
  // problems rather than become one.
  it('treats a non-string model as unset instead of throwing', () => {
    for (const model of [42, true, null, {}, ['sonnet']] as unknown[]) {
      expect(() => extendedContextAdvice({ routed: true, model })).not.toThrow();
      expect(extendedContextAdvice({ routed: true, model })).toMatch(/200K|200k/);
    }
  });

  it('is case-insensitive about the suffix', () => {
    expect(extendedContextAdvice({ routed: true, model: 'opus[1M]' })).toBeUndefined();
  });
});
