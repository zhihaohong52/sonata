import { describe, it, expect } from 'vitest';
import { allowSonataTools, missingAllowEntries, SONATA_TOOLS } from '../src/settings.js';

/**
 * The wrapper's tools must never be left to Claude Code's `auto` mode
 * classifier. Observed on 2026-08-12: a wrapper had `run` allowed and `tail`
 * allowed twice, then denied twice mid-run ("Blocked by classifier"), leaving
 * a foreign model writing to the repository with nothing able to read it back.
 */
describe('allow-listing the sonata tools', () => {
  it('allow-lists the tools the wrapper actually holds', () => {
    expect(SONATA_TOOLS).toEqual([
      'mcp__sonata__dispatch', 'mcp__sonata__wait', 'mcp__sonata__approve',
    ]);
  });

  it('does not name the removed polling tools', () => {
    expect(SONATA_TOOLS).not.toContain('mcp__sonata__run');
    expect(SONATA_TOOLS).not.toContain('mcp__sonata__tail');
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

  // The dangerous state is partial: `run` permitted while `tail` is not means
  // dispatches launch and cannot be observed.
  it('completes a partial allow list without disturbing what is there', () => {
    const partial = { permissions: { allow: ['mcp__sonata__dispatch'] } };
    expect(missingAllowEntries(partial)).toEqual([
      'mcp__sonata__wait', 'mcp__sonata__approve',
    ]);
    const { settings, changed } = allowSonataTools(partial);
    expect(changed).toBe(true);
    expect(settings.permissions?.allow).toEqual(SONATA_TOOLS);
  });

  it('reports nothing missing once all three are present', () => {
    expect(missingAllowEntries({ permissions: { allow: [...SONATA_TOOLS] } })).toEqual([]);
  });

  it('does not mutate the settings it was given', () => {
    const before = { permissions: { allow: ['Bash(ls:*)'] } };
    allowSonataTools(before);
    expect(before.permissions.allow).toEqual(['Bash(ls:*)']);
  });
});
