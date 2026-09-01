import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdLitellm, describeStatus, statusIsHealthy } from '../../src/commands/litellm.js';
import {
  managedLitellmPath, venvDir, LITELLM_VERSION, type InstallerDeps,
} from '../../src/native/litellm-venv.js';

const NEEDS_LITELLM = `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash-0731"
context_window = 128000

[native.gateways."acme"]
base_url = "https://gateway.example/v1"
`;

const ANTHROPIC_ONLY = `
[models."or-flash"]
gateway = "openrouter"
id = "deepseek/deepseek-v4-flash"
context_window = 128000

[native.gateways."openrouter"]
base_url = "https://openrouter.ai/api/v1"
provider = "anthropic"
`;

function setup(toml: string): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'litellm-cmd-cwd-'));
  const home = mkdtempSync(join(tmpdir(), 'litellm-cmd-home-'));
  writeFileSync(join(cwd, 'sonata.toml'), toml);
  return { cwd, home };
}

/** An installer that records its calls and fakes the venv the real tool would build. */
function fakeInstaller(home: string, opts: { uv?: boolean } = {}): InstallerDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    which: (bin) => (bin === (opts.uv === true ? 'uv' : 'python3') ? `/bin/${bin}` : undefined),
    pythonVersion: () => '3.12.0',
    run: async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      // At the final path, which is where the real installer builds: a venv's
      // console scripts carry an absolute shebang, so one assembled elsewhere
      // and renamed into place cannot run.
      //
      // Including the binary: without it the post-install status is `broken`,
      // and the "Done —" assertion would pass only because the broken message
      // happens to contain the same path.
      mkdirSync(join(venvDir(home), 'bin'), { recursive: true });
      writeFileSync(managedLitellmPath(home), '#!/bin/sh\n', { mode: 0o755 });
    },
  };
}

const lines = (): { out: (l: string) => void; text: () => string } => {
  const collected: string[] = [];
  return { out: (l) => collected.push(l), text: () => collected.join('\n') };
};

describe('cmdLitellm status', () => {
  it('is healthy and says nothing needs it, for an anthropic-only config', async () => {
    const { cwd, home } = setup(ANTHROPIC_ONLY);
    const w = lines();
    expect(await cmdLitellm('status', { cwd, home, write: w.out, deps: fakeInstaller(home) })).toBe(0);
    expect(w.text()).toMatch(/not-required/);
    expect(w.text()).toMatch(/no gateway/i);
  });

  it('exits non-zero and names the repair when a config needs it and it is absent', async () => {
    const { cwd, home } = setup(NEEDS_LITELLM);
    const w = lines();
    expect(await cmdLitellm('status', { cwd, home, write: w.out, deps: fakeInstaller(home) })).toBe(1);
    expect(w.text()).toContain('sonata litellm install');
  });

  it('reports no-python rather than missing when nothing could build the venv', async () => {
    // Different repair: "install uv" is much cheaper advice than "install a
    // different Python", and only this state can tell the user which it is.
    const { cwd, home } = setup(NEEDS_LITELLM);
    const w = lines();
    await cmdLitellm('status', {
      cwd, home, write: w.out, deps: { which: () => undefined, pythonVersion: () => '3.9.6' },
    });
    expect(w.text()).toContain('no-python');
    expect(w.text()).toContain('install uv');
  });

  it('is healthy on a stale pin — an old version still serves', async () => {
    const { cwd, home } = setup(NEEDS_LITELLM);
    mkdirSync(join(venvDir(home), 'bin'), { recursive: true });
    writeFileSync(managedLitellmPath(home), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(venvDir(home), '.sonata-pin'), '1.0.0');
    const w = lines();
    expect(await cmdLitellm('status', { cwd, home, write: w.out, deps: fakeInstaller(home) })).toBe(0);
    expect(w.text()).toContain('stale');
  });
});

describe('cmdLitellm install', () => {
  it('installs nothing when no gateway routes through litellm', async () => {
    const { cwd, home } = setup(ANTHROPIC_ONLY);
    const deps = fakeInstaller(home);
    const w = lines();
    expect(await cmdLitellm('install', { cwd, home, write: w.out, deps })).toBe(0);
    expect(deps.calls).toEqual([]);
    expect(existsSync(venvDir(home))).toBe(false);
  });

  it('installs the pinned version and reports where it landed', async () => {
    const { cwd, home } = setup(NEEDS_LITELLM);
    const deps = fakeInstaller(home);
    const w = lines();
    expect(await cmdLitellm('install', { cwd, home, write: w.out, deps })).toBe(0);
    expect(deps.calls.some((c) => c.includes(`litellm[proxy]==${LITELLM_VERSION}`))).toBe(true);
    expect(readFileSync(join(venvDir(home), '.sonata-pin'), 'utf8')).toBe(LITELLM_VERSION);
    expect(w.text()).toContain(managedLitellmPath(home));
    expect(w.text()).toContain(LITELLM_VERSION);
    expect(w.text()).not.toContain('unusable');
  });

  it('states the expected duration, which differs by an order of magnitude', async () => {
    const { cwd, home } = setup(NEEDS_LITELLM);
    const w = lines();
    await cmdLitellm('install', { cwd, home, write: w.out, deps: fakeInstaller(home, { uv: true }) });
    expect(w.text()).toContain('seconds');

    const second = setup(NEEDS_LITELLM);
    const w2 = lines();
    await cmdLitellm('install', {
      cwd: second.cwd, home: second.home, write: w2.out, deps: fakeInstaller(second.home),
    });
    expect(w2.text()).toContain('minutes');
  });
});

describe('describeStatus', () => {
  it('names a repair for every state, and never leaves one unhandled', () => {
    const cases = [
      { state: 'not-required' },
      { state: 'ok', version: '1.98.0', path: '/p' },
      { state: 'stale', installed: '1.0.0', expected: '1.98.0', path: '/p' },
      { state: 'missing' },
      { state: 'broken', reason: 'binary is missing' },
      { state: 'no-python', pythonVersion: '3.9.6' },
    ] as const;
    for (const status of cases) expect(describeStatus(status)).not.toBe('');
    // Only `ok` and `not-required` are silent; the rest each name a command or
    // a tool to install.
    expect(cases.filter((c) => !statusIsHealthy(c)).every((c) => /install|uv/.test(describeStatus(c))))
      .toBe(true);
  });
});
