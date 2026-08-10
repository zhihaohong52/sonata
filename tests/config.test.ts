import { describe, it, expect } from 'vitest';
import { parseConfig, isReadOnlyRole } from '../src/config.js';

const VALID = `
[models.deepseek-v4-flash]
harness = "opencode"
id = "deepseek-v4-flash"

[generate]
roles = ["code"]
models = ["deepseek-v4-flash"]
`;

describe('parseConfig', () => {
  it('parses models and applies run defaults', () => {
    const cfg = parseConfig(VALID);
    expect(cfg.models['deepseek-v4-flash']).toEqual({
      harness: 'opencode', id: 'deepseek-v4-flash',
    });
    expect(cfg.run.tailWindowSeconds).toBe(20);
    expect(cfg.run.stallTimeoutSeconds).toBe(120);
    expect(cfg.run.runTimeoutSeconds).toBe(1800);
  });

  it('overrides run defaults from snake_case keys', () => {
    const cfg = parseConfig(`${VALID}\n[run]\ntail_window_seconds = 5\n`);
    expect(cfg.run.tailWindowSeconds).toBe(5);
  });

  it('rejects a generate.models entry with no model definition', () => {
    const bad = `
[models.a]
harness = "opencode"
id = "a"

[generate]
roles = ["code"]
models = ["ghost"]
`;
    expect(() => parseConfig(bad)).toThrow(/unknown model "ghost"/);
  });

  it('rejects an unknown harness', () => {
    const bad = `
[models.a]
harness = "nope"
id = "a"

[generate]
roles = ["code"]
models = ["a"]
`;
    expect(() => parseConfig(bad)).toThrow(/unknown harness "nope"/);
  });

  it('rejects an unknown role', () => {
    const bad = `
[models.a]
harness = "opencode"
id = "a"

[generate]
roles = ["dance"]
models = ["a"]
`;
    expect(() => parseConfig(bad)).toThrow(/unknown role "dance"/);
  });

  it('accepts explore and plan roles', () => {
    const cfg = parseConfig(`
[models.a]
harness = "opencode"
id = "a"

[generate]
roles = ["explore", "plan"]
models = ["a"]
`);
    expect(cfg.generate.roles).toEqual(['explore', 'plan']);
  });
});

describe('isReadOnlyRole', () => {
  it('returns true for read-only roles', () => {
    expect(isReadOnlyRole('review')).toBe(true);
    expect(isReadOnlyRole('explore')).toBe(true);
    expect(isReadOnlyRole('plan')).toBe(true);
  });

  it('returns false for code', () => {
    expect(isReadOnlyRole('code')).toBe(false);
  });
});
