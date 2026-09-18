import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { cmdDoctor, overCeilingSimple, knownBadVersion, type Check } from '../src/commands/doctor.js';

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
