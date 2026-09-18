import { describe, expect, it } from 'vitest';
import { watchTick } from '../scripts/pr-status.mjs';

/**
 * The watch loop is the guard this repository's conventions lean on — "keep
 * `--watch=60` running for as long as any PR is open". It was calling `report`
 * inside `setInterval` with no `try`, so a transient `gh` failure became an
 * uncaught exception and killed the process while `process.exitCode` was
 * already 0.
 *
 * Observed twice in one session, both times ending
 * `error connecting to api.github.com` then `[exited with code 0]`. A watch
 * that has silently stopped is indistinguishable from one reporting a quiet
 * PR, which is the one thing it must never be.
 */
describe('watchTick', () => {
  const ok = () => [{ fingerprint: 'a', text: 'PR #1', clean: false }];

  it('survives a throwing poll and keeps watching', () => {
    const state = { previous: 'a', failures: 0 };
    const out: string[] = [];
    const result = watchTick({
      poll: () => { throw new Error('error connecting to api.github.com'); },
      state, log: (l: string) => out.push(l), maxFailures: 3,
    });
    expect(result).toBe('continue');
    expect(state.failures).toBe(1);
    expect(out.join(' ')).toMatch(/api\.github\.com/);
  });

  it('gives up after repeated failures rather than spinning forever', () => {
    // A revoked token or a removed repo fails every time. Retrying silently
    // for hours is not better than stopping and saying why.
    const state = { previous: 'a', failures: 2 };
    const result = watchTick({
      poll: () => { throw new Error('gh: not found'); },
      state, log: () => {}, maxFailures: 3,
    });
    expect(result).toBe('stop');
  });

  it('resets the failure count once a poll succeeds', () => {
    // A blip must not accumulate toward the give-up threshold across hours.
    const state = { previous: 'a', failures: 2 };
    watchTick({ poll: ok, state, log: () => {}, maxFailures: 3 });
    expect(state.failures).toBe(0);
  });

  it('stops when every PR is clean', () => {
    const state = { previous: 'x', failures: 0 };
    const result = watchTick({
      poll: () => [{ fingerprint: 'b', text: 'PR #1', clean: true }],
      state, log: () => {}, maxFailures: 3,
    });
    expect(result).toBe('stop');
  });

  it('says nothing when nothing changed', () => {
    const out: string[] = [];
    const state = { previous: 'a', failures: 0 };
    watchTick({ poll: ok, state, log: (l: string) => out.push(l), maxFailures: 3 });
    expect(out).toEqual([]);
  });
});
