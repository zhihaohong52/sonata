import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVersion, cmdDoctor } from '../../src/commands/doctor.js';

describe('checkVersion', () => {
  it('accepts a version inside the supported range', () => {
    expect(checkVersion('1.18.15', '>=1.18.0 <2.0.0')).toBe(true);
  });

  it('rejects a version below the floor', () => {
    expect(checkVersion('1.17.9', '>=1.18.0 <2.0.0')).toBe(false);
  });

  it('rejects a version at or above the ceiling', () => {
    expect(checkVersion('2.0.0', '>=1.18.0 <2.0.0')).toBe(false);
  });

  it('tolerates a v prefix and trailing text', () => {
    expect(checkVersion('v1.18.15 (build 3)', '>=1.18.0 <2.0.0')).toBe(true);
  });
});

describe('cmdDoctor — which config', () => {
  const MINIMAL = `
[models."m"]
harness = "codex"
id = "gpt-5.6-sol"

[generate]
roles = ["code"]
models = ["m"]
`;
  let cwd: string;
  let home: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'doc-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'doc-home-'));
  });

  const check = async (name: string) =>
    (await cmdDoctor({ cwd, home })).checks.find((c) => c.name === name);

  it('reports the machine config path when that is what it used', async () => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), MINIMAL);

    const c = await check('sonata.toml');
    expect(c?.ok).toBe(true);
    // With two possible sources, a model count alone cannot be debugged from.
    expect(c?.detail).toContain(join(home, '.config', 'sonata', 'sonata.toml'));
    expect(c?.detail).toContain('1 model');
  });

  it('reports the project config path when the repo has one', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), MINIMAL);
    expect((await check('sonata.toml'))?.detail).toContain(join(cwd, 'sonata.toml'));
  });

  it('warns about a stray ~/sonata.toml, which nothing reads', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), MINIMAL);
    writeFileSync(join(home, 'sonata.toml'), MINIMAL);

    const c = await check('stray config');
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain(join(home, 'sonata.toml'));
    expect(c?.detail).toContain('mv');
  });

  it('says nothing about a stray file when there is none', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), MINIMAL);
    expect(await check('stray config')).toBeUndefined();
  });
});
