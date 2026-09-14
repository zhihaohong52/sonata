import { describe, it, expect } from 'vitest';
import {
  EFFORT_LEVELS, isEffort, splitCandidate, joinCandidate, parseAaEffort, aaEffortSuffix,
} from '../src/effort.js';

describe('EFFORT_LEVELS', () => {
  it('is the wire enum, weakest first', () => {
    expect(EFFORT_LEVELS).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(isEffort('xhigh')).toBe(true);
    expect(isEffort('XHIGH')).toBe(false);
    expect(isEffort('turbo')).toBe(false);
  });
});

describe('splitCandidate / joinCandidate', () => {
  it('returns a bare key unchanged', () => {
    expect(splitCandidate('gpt-5.6-luna')).toEqual({ key: 'gpt-5.6-luna' });
  });
  it('splits on the last @', () => {
    expect(splitCandidate('gpt-5.6-luna@xhigh')).toEqual({ key: 'gpt-5.6-luna', effort: 'xhigh' });
  });
  it('refuses an empty or unknown level', () => {
    expect(() => splitCandidate('gpt-5.6-luna@')).toThrow(/effort level/);
    expect(() => splitCandidate('gpt-5.6-luna@turbo')).toThrow(/"turbo"/);
  });
  it('refuses an empty key', () => {
    // `@low` names a level and no model: the router would otherwise forward
    // `default/` to LiteLLM, and a tier list would hold a key matching nothing.
    expect(() => splitCandidate('@low')).toThrow(/model key must precede "@"/);
  });
  it('round-trips through join', () => {
    expect(joinCandidate('k', 'low')).toBe('k@low');
    expect(joinCandidate('k')).toBe('k');
    expect(splitCandidate(joinCandidate('k', 'max'))).toEqual({ key: 'k', effort: 'max' });
  });
});

describe('parseAaEffort', () => {
  // The vocabulary tallied over AA's 647 rows on 2026-09-13.
  it.each([
    ['GPT-5.6 Luna (max)', 'max'],
    ['GPT-5.6 Luna (xhigh)', 'xhigh'],
    ['GPT-5.6 Luna (high)', 'high'],
    ['GPT-5.6 Luna (medium)', 'medium'],
    ['GPT-5.6 Luna (low)', 'low'],
    ['Gemini 3.5 Flash (minimal)', 'minimal'],
    ['GPT-5.6 Luna (Non-reasoning)', 'none'],
    ['GPT-5.2 (Non-Reasoning)', 'none'],
    ['DeepSeek V4 Pro (Reasoning, Max Effort)', 'max'],
    ['DeepSeek V4 Pro (Reasoning, High Effort)', 'high'],
    ['Claude Opus 4.8 (Adaptive Reasoning, Xhigh Effort)', 'xhigh'],
    ['Claude Opus 4.8 (Adaptive Reasoning, Max Effort, Default Fallback)', 'max'],
    ['Claude Sonnet 4.8 (Non-reasoning, High Effort)', 'none'],
    ['Multiverse (high, based on gpt-oss-120b)', 'high'],
    ['Multiverse (max, based on GLM-5.2)', 'max'],
  ])('%s → %s', (name, effort) => {
    expect(parseAaEffort(name)).toBe(effort);
  });

  it.each([
    'Qwen3.8 Max (Reasoning)',
    "Gemini 2.0 Flash (Dec '24)",
    'Gemini 3.1 Flash Lite (Preview)',
    'Llama 5 (Vision)',
    'HyperCLOVA X (32B)',
    'GPT-4o (ChatGPT)',
    'Reka Core (V1)',
    'GPT-4 (0613)',
    'Motif (Beta)',
    'Gemma (experimental)',
    'GPT-5.6 Luna',
  ])('%s → no effort', (name) => {
    expect(parseAaEffort(name)).toBeUndefined();
  });

  it('does not read a level out of a model name', () => {
    // "Max" is part of this model's name, not a parenthetical level.
    expect(parseAaEffort('Qwen3.8 Max')).toBeUndefined();
  });
});

describe('aaEffortSuffix', () => {
  it('maps none to the slug spelling', () => {
    expect(aaEffortSuffix('none')).toBe('non-reasoning');
    expect(aaEffortSuffix('xhigh')).toBe('xhigh');
  });
});
