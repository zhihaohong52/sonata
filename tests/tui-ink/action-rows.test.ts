import { describe, expect, it } from 'vitest';
import { actionRows, summariseSync, staleNames } from '../../src/tui-ink/screens/action-rows.js';

describe('actionRows', () => {
  it('lists actions with distinct non-escape keys', () => {
    const rows = actionRows();
    expect(rows).toEqual([
      { key: 's', label: 'sync agents', runnable: true, note: 'regenerate .claude/agents from sonata.toml' },
      { key: 'c', label: 'update catalog', runnable: true, note: 'fetch model rankings and prices' },
      { key: 'l', label: 'install litellm', runnable: false, note: expect.stringContaining('sonata litellm install') },
      { key: 'r', label: 'routing', runnable: false, note: expect.stringContaining('sonata route auto') },
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(rows.every((row) => row.key !== 'escape')).toBe(true);
  });

  it('names commands for non-runnable actions', () => {
    expect(actionRows().filter((row) => !row.runnable).map((row) => row.note)).toEqual([
      expect.stringContaining('sonata litellm install'),
      expect.stringContaining('sonata route auto'),
    ]);
  });

  it('summarises all sync counts, including zeroes', () => {
    expect(summariseSync({ written: [], stale: [], skipped: [] })).toBe('wrote 0 · 0 stale · 0 skipped');
    expect(summariseSync({ written: ['a', 'b'], stale: ['old'], skipped: ['x', 'y', 'z'] })).toBe('wrote 2 · 1 stale · 3 skipped');
  });
  it('names the stale files separately, so the summary line stays stable', () => {
    // sonata does not delete a stale agent: Claude Code keeps offering it as a
    // subagent type whose alias no longer resolves, so a dispatch to it fails
    // rather than falling back. A count alone cannot say which to remove.
    expect(staleNames({ stale: ['code-normal', 'review-normal'] })).toEqual(['code-normal', 'review-normal']);
    expect(staleNames({ stale: [] })).toEqual([]);
  });
});
