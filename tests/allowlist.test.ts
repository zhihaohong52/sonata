import { describe, it, expect } from 'vitest';
import { allowSonataTools, missingAllowEntries, missingAllowEntriesAcross, staleAllowEntries, SONATA_TOOLS, REMOVED_SONATA_TOOLS } from '../src/settings.js';

/**
 * The wrapper's tools must never be left to Claude Code's `auto` mode
 * classifier. Observed on 2026-08-12: a wrapper had `run` allowed and `tail`
 * allowed twice, then denied twice mid-run ("Blocked by classifier"), leaving
 * a foreign model writing to the repository with nothing able to read it back.
 */
describe('allow-listing the sonata tools', () => {
  it('allow-lists dispatch and wait — and never approve', () => {
    expect(SONATA_TOOLS).toEqual([
      'Bash(sonata dispatch:*)', 'Bash(sonata wait:*)',
    ]);
    // `approve` answers a codex/reasonix approval card. Allow-listed, a model
    // could answer it itself with no human ever seeing the prompt — so every
    // `sonata approve` call must go through the permission prompt instead.
    expect(SONATA_TOOLS).not.toContain('Bash(sonata approve:*)');
    expect(REMOVED_SONATA_TOOLS).toEqual(['Bash(sonata approve:*)']);
  });

  it('adds every tool to an empty settings file', () => {
    const { settings, changed } = allowSonataTools({});
    expect(changed).toBe(true);
    expect(settings.permissions?.allow).toEqual(SONATA_TOOLS);
  });

  it('keeps unrelated allow entries and every other key', () => {
    const before = {
      permissions: { defaultMode: 'auto', allow: ['Bash(ls:*)', 'mcp__other__thing'] },
      hooks: { PreToolUse: [] },
      model: 'opus',
    };
    const { settings } = allowSonataTools(before);
    expect(settings.permissions?.allow).toEqual([
      'Bash(ls:*)', 'mcp__other__thing', ...SONATA_TOOLS,
    ]);
    expect(settings.permissions?.defaultMode).toBe('auto');
    expect(settings.model).toBe('opus');
    expect(settings.hooks).toEqual({ PreToolUse: [] });
  });

  it('is idempotent, so re-running init cannot duplicate entries', () => {
    const once = allowSonataTools({});
    const twice = allowSonataTools(once.settings);
    expect(twice.changed).toBe(false);
    expect(twice.settings.permissions?.allow).toEqual(SONATA_TOOLS);
  });

  // The dangerous state is partial: `dispatch` permitted while `wait` is not
  // means dispatches launch and cannot be observed.
  it('completes a partial allow list without disturbing what is there', () => {
    const partial = { permissions: { allow: ['Bash(sonata dispatch:*)'] } };
    expect(missingAllowEntries(partial)).toEqual([
      'Bash(sonata wait:*)',
    ]);
    const { settings, changed } = allowSonataTools(partial);
    expect(changed).toBe(true);
    expect(settings.permissions?.allow).toEqual(SONATA_TOOLS);
  });

  it('removes a stale approve entry when it rewrites the settings', () => {
    const old = { permissions: { allow: ['Bash(sonata dispatch:*)', 'Bash(sonata wait:*)', 'Bash(sonata approve:*)'] } };
    expect(staleAllowEntries(old)).toEqual(['Bash(sonata approve:*)']);
    const { settings, changed } = allowSonataTools(old);
    expect(changed).toBe(true);
    expect(settings.permissions?.allow).toEqual(SONATA_TOOLS);
  });

  it('flags a stale approve entry until the writer removes it', () => {
    expect(staleAllowEntries({ permissions: { allow: ['Bash(sonata approve:*)'] } }))
      .toEqual(['Bash(sonata approve:*)']);
    expect(staleAllowEntries({ permissions: { allow: [...SONATA_TOOLS] } })).toEqual([]);
  });

  it('reports nothing missing once both are present', () => {
    expect(missingAllowEntries({ permissions: { allow: [...SONATA_TOOLS] } })).toEqual([]);
  });

  it('treats an allow list split across scopes as complete', () => {
    // An entry allow-listed in either scope covers the call, so project
    // holding dispatch and global holding wait is missing nothing.
    expect(missingAllowEntriesAcross([
      { permissions: { allow: ['Bash(sonata dispatch:*)'] } },
      { permissions: { allow: ['Bash(sonata wait:*)'] } },
    ])).toEqual([]);
    expect(missingAllowEntriesAcross([
      { permissions: { allow: ['Bash(sonata dispatch:*)'] } },
      { permissions: { allow: [] } },
    ])).toEqual(['Bash(sonata wait:*)']);
  });

  it('does not mutate the settings it was given', () => {
    const before = { permissions: { allow: ['Bash(ls:*)'] } };
    allowSonataTools(before);
    expect(before.permissions.allow).toEqual(['Bash(ls:*)']);
  });
});
