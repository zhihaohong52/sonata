import { describe, it, expect } from 'vitest';
import { guardProgress } from '../src/detect.js';

describe('guardProgress', () => {
  it('passes every call through', () => {
    const seen: string[] = [];
    const report = guardProgress((name, state, detail) => { seen.push(`${name}:${state}:${detail ?? ''}`); });
    report('codex', 'probing');
    report('codex', 'done', '6 models');
    expect(seen).toEqual(['codex:probing:', 'codex:done:6 models']);
  });

  it('swallows a throwing callback instead of failing detection', () => {
    // The contract says progress reporting cannot fail the thing it reports
    // on. Called bare, a throw here rejected `detectHarnesses` and stopped
    // `sonata init` over a display problem.
    const report = guardProgress(() => { throw new Error('screen went away'); });
    expect(() => report('pi', 'probing')).not.toThrow();
  });

  it('is a no-op when there is no callback', () => {
    expect(() => guardProgress(undefined)('pi', 'done', 'not installed')).not.toThrow();
  });
});
