import { describe, it, expect } from 'vitest';
import type { InitState, TuiResult } from '../../src/tui-ink/types.js';

describe('TuiResult contract', () => {
  it('survives a JSON.stringify/parse round-trip with its expected shape', () => {
    const result: TuiResult = {
      cancelled: false,
      state: {
        configScope: 'project',
        harnesses: ['opencode', 'pi'],
        providerKeys: ['openrouter', 'openai'],
        nativeKeys: ['opencode-openrouter-deepseek-v4-flash'],
        roles: ['code', 'review'],
        perRoleModels: {
          code: ['opencode-openrouter-deepseek-v4-flash'],
          review: ['opencode-openai-gpt-5.6-sol'],
        },
        hookScope: 'global',
      },
    };

    const parsed = JSON.parse(JSON.stringify(result)) as TuiResult;

    expect(parsed).toEqual(result);
    expect(parsed.cancelled).toBe(false);
    expect(parsed.state.configScope).toBe('project');
    expect(parsed.state.hookScope).toBe('global');
    expect(parsed.state.harnesses).toEqual(['opencode', 'pi']);
    expect(parsed.state.nativeKeys).toEqual(['opencode-openrouter-deepseek-v4-flash']);
    expect(parsed.state.perRoleModels?.code).toEqual(['opencode-openrouter-deepseek-v4-flash']);
  });

  it('treats missing fields as absent, not defined', () => {
    const empty: TuiResult = { cancelled: true, state: {} };
    const parsed = JSON.parse(JSON.stringify(empty)) as TuiResult;

    expect(parsed.cancelled).toBe(true);
    expect(parsed.state.configScope).toBeUndefined();
    expect(parsed.state.harnesses).toBeUndefined();
    expect(parsed.state.providerKeys).toBeUndefined();
    expect(parsed.state.nativeKeys).toBeUndefined();
    expect(parsed.state.roles).toBeUndefined();
    expect(parsed.state.perRoleModels).toBeUndefined();
    expect(parsed.state.hookScope).toBeUndefined();
  });

  it('round-trips a per-role model set for the default off state', () => {
    const result: TuiResult = {
      cancelled: false,
      state: { roles: ['code'], perRoleModels: {} },
    };
    const parsed = JSON.parse(JSON.stringify(result)) as TuiResult;
    expect(parsed).toEqual(result);
  });
});