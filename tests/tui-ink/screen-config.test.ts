import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigForScreen } from '../../src/tui-ink/screens/screen-config.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sonata-screen-config-'));
}

const validConfig = [
  'schema_version = 1',
  '',
  '[models."m1"]',
  'harness = "opencode"',
  'id = "provider/model"',
  '',
].join('\n');

describe('loadConfigForScreen', () => {
  it('returns an actionable message when no config exists', () => {
    const result = loadConfigForScreen(tempDir(), tempDir());
    expect(result).toEqual({ ok: false, message: 'no sonata.toml — run `sonata init` first' });
  });

  it('preserves the underlying validation reason', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'sonata.toml'), [
      '[tiers.code]',
      'simple = ["nope"]',
      'complex = ["nope"]',
      '',
    ].join('\n'));
    const result = loadConfigForScreen(cwd, tempDir());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('unknown model');
  });

  it('returns a parsed valid config', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'sonata.toml'), validConfig);
    const result = loadConfigForScreen(cwd, tempDir());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.models.m1).toEqual({ harness: 'opencode', id: 'provider/model' });
  });

  it('never throws for missing, invalid, or valid configs', () => {
    const missing = () => loadConfigForScreen(tempDir(), tempDir());
    expect(missing).not.toThrow();

    const invalidCwd = tempDir();
    writeFileSync(join(invalidCwd, 'sonata.toml'), '[tiers.code]\nsimple = ["nope"]\ncomplex = ["nope"]\n');
    expect(() => loadConfigForScreen(invalidCwd, tempDir())).not.toThrow();

    const validCwd = tempDir();
    writeFileSync(join(validCwd, 'sonata.toml'), validConfig);
    expect(() => loadConfigForScreen(validCwd, tempDir())).not.toThrow();
  });
});
