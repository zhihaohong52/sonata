import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { cmdDoctor, overCeilingSimple, strandedNoneCandidates, knownBadVersion, type Check } from '../src/commands/doctor.js';

vi.mock('../src/commands/doctor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/commands/doctor.js')>(
    '../src/commands/doctor.js',
  );
  return { ...actual, cmdDoctor: vi.fn() };
});

const cmdDoctorMock = vi.mocked(cmdDoctor);

describe('sonata doctor CLI wiring', () => {
  afterEach(() => vi.restoreAllMocks());

  it('--json prints the checks as a parseable object and preserves the exit code', async () => {
    const checks: Check[] = [
      { name: 'tmux', ok: true, detail: '3.4' },
      { name: 'sonata.toml', ok: false, detail: 'not found' },
    ];
    cmdDoctorMock.mockResolvedValue({ ok: false, checks });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['doctor', '--json']);
    expect(code).toBe(1);
    const out = spy.mock.calls.map(([l]) => String(l)).join('');
    expect(JSON.parse(out)).toEqual({ ok: false, checks });
  });

  it('without --json prints the human-readable lines, not JSON', async () => {
    cmdDoctorMock.mockResolvedValue({
      ok: true,
      checks: [{ name: 'tmux', ok: true, detail: '3.4' }],
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['doctor']);
    expect(code).toBe(0);
    const all = spy.mock.calls.map(([l]) => String(l)).join('\n');
    expect(all).toContain('ok   tmux: 3.4');
    expect(() => JSON.parse(all)).toThrow();
  });

  it('rejects an unrecognized flag with the parseArgs unknown-option error', async () => {
    cmdDoctorMock.mockResolvedValue({ ok: true, checks: [] });

    const err = await main(['doctor', '--bogus']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`Unknown option '--bogus'`);
  });
});

describe('strandedNoneCandidates', () => {
  const fam = (...levels: string[]) => ({ variants: new Map(levels.map((l) => [l, {}])) });
  const tiers = (...c: string[]) => ({ code: { simple: c, complex: [] } });

  it('flags a @none pin the catalog states no level for', () => {
    // The measured case: all 24 ranked entries for glm-5.3-flash were @none
    // while AA had stated no level at all, so the model was ranked on a
    // reasoning score and then asked not to reason. Its endpoint refuses,
    // and every request 400d.
    const out = strandedNoneCandidates(tiers('glm-5.3-flash@none'), () => fam('default'));
    expect([...out.keys()]).toEqual(['glm-5.3-flash']);
    expect([...out.get('glm-5.3-flash')!]).toEqual(['code']);
  });

  it('leaves a model that genuinely has a none variant alone', () => {
    // AA said `Non-Reasoning` for this one, so @none is exactly right and
    // reporting it would invent a fault.
    expect(strandedNoneCandidates(tiers('luna@none'), () => fam('none', 'low', 'max')).size).toBe(0);
  });

  it('says nothing about a model the catalog does not score', () => {
    // An unscored key carries no statement about its levels. Guessing would
    // flag every hand-added model on a thin catalog.
    expect(strandedNoneCandidates(tiers('hand-added@none'), () => undefined).size).toBe(0);
  });

  it('ignores candidates pinned at any other level', () => {
    const out = strandedNoneCandidates(tiers('luna@low', 'luna@max', 'luna'), () => fam('default'));
    expect(out.size).toBe(0);
  });

  it('gathers every role holding the same stranded key', () => {
    // Roles share one ranking, so a stranded model is normally in all four —
    // reported once with its roles rather than four near-identical lines.
    const out = strandedNoneCandidates({
      code: { simple: ['glm@none'], complex: [] },
      review: { simple: [], normal: ['glm@none'], complex: ['glm@none'] },
    }, () => fam('default'));
    expect([...out.get('glm')!].sort()).toEqual(['code', 'review']);
  });
});

describe('overCeilingSimple', () => {
  // Measured on a real config 2026-09-18: `simple` led with a candidate 4.5x
  // dearer per task than `normal`'s leader, and by rank 4 held one 34x dearer.
  // `simple` and `complex` predated the current catalog and were sticky, while
  // `normal` — added later — had been seeded from a fresh proposal, so the two
  // lists were computed in different eras and the frozen one was the expensive
  // one. Nothing reported it: a wrong ranking is silent by construction.
  it('names a saved candidate the current proposal would cap out of simple', () => {
    const over = overCeilingSimple(
      ['luna@high', 'luna@max', 'terra@high'],
      { simple: ['luna@low', 'luna@medium', 'luna@high'], normal: ['luna@low', 'luna@medium', 'luna@high', 'luna@max', 'terra@high'] },
    );
    expect(over).toEqual(['luna@max', 'terra@high']);
  });

  it('says nothing about a tier that matches the proposal', () => {
    expect(overCeilingSimple(
      ['luna@low', 'luna@high'],
      { simple: ['luna@low', 'luna@medium', 'luna@high'], normal: ['luna@low', 'luna@medium', 'luna@high'] },
    )).toEqual([]);
  });

  it('ignores a candidate the proposal does not rank at all', () => {
    // A hand-added key the catalog cannot score is absent from both lists.
    // Reporting it would be a claim about a cost nothing knows, and such a key
    // is explicitly still accepted everywhere outside init's own proposal.
    expect(overCeilingSimple(
      ['hand-added-model'],
      { simple: ['luna@low'], normal: ['luna@low'] },
    )).toEqual([]);
  });

  it('does not complain merely because the order differs', () => {
    // Ordering is the user's to tune; only membership signals a stale cap.
    expect(overCeilingSimple(
      ['luna@high', 'luna@low'],
      { simple: ['luna@low', 'luna@high'], normal: ['luna@low', 'luna@high'] },
    )).toEqual([]);
  });
});

describe('knownBadVersion', () => {
  // Claude Code 2.1.275 failed EVERY request with a 400 naming
  // `Input tag 'advisor_20260301'` whenever `ANTHROPIC_BASE_URL` pointed at a
  // proxy or gateway, fixed in 2.1.276. The whole native path works by
  // pointing that variable at sonata's router, so on that one build every
  // routed request dies — and an opaque 400 from a proxied request reads as a
  // sonata or model fault, exactly like the Codex "System messages are not
  // allowed" and Azure "is not a 'regex'" 400s already documented here.
  it('names the reason for a known-bad version', () => {
    expect(knownBadVersion('2.1.275')).toMatch(/advisor_20260301/);
    expect(knownBadVersion('2.1.275')).toMatch(/2\.1\.276/);
  });

  it('clears the fixed version and the ones before it', () => {
    // A range cannot express this: `<2.1.275` would also reject 2.1.276.
    expect(knownBadVersion('2.1.276')).toBeUndefined();
    expect(knownBadVersion('2.1.274')).toBeUndefined();
    expect(knownBadVersion('2.2.0')).toBeUndefined();
  });

  it('tolerates a version string with surrounding noise', () => {
    // `claude --version` prints "2.1.276 (Claude Code)".
    expect(knownBadVersion('2.1.275 (Claude Code)')).toMatch(/advisor_20260301/);
    expect(knownBadVersion('2.1.276 (Claude Code)')).toBeUndefined();
  });
});

