import { describe, it, expect, beforeAll } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brokenHarness, firstErrorLine, isBrokenHarness, probeVersion } from '../src/detect.js';

/** A PATH holding fake binaries, so each case is exactly what it claims. */
let bin: string;
const env = () => ({ ...process.env, PATH: `${bin}:/usr/bin:/bin` });
const fake = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'probe-bin-'));
  fake('works', 'echo "works 1.2.3"');
  // The real failure, verbatim: a Node launcher whose platform binary npm
  // skipped. It prints a source excerpt, then the error, then a stack.
  fake('crashes', [
    'echo "file:///x/codex.js:107" >&2',
    'echo "  throw new Error(" >&2',
    'echo "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest" >&2',
    'echo "    at findCodexExecutable (file:///x/codex.js:107:9)" >&2',
    'exit 1',
  ].join('\n'));
  fake('hangs', 'sleep 5');
});

describe('probeVersion', () => {
  it('reports a working harness and its version', async () => {
    expect(await probeVersion('works', env())).toEqual({ state: 'ok', version: 'works 1.2.3' });
  });

  it('reports a missing harness as missing', async () => {
    expect(await probeVersion('not-a-real-harness', env())).toEqual({ state: 'missing' });
  });

  it('reports a crashing harness as broken, not missing, with its own error', async () => {
    // Treating this as missing is how codex's models vanished with no warning.
    const probe = await probeVersion('crashes', env());
    expect(probe.state).toBe('broken');
    if (probe.state === 'broken') {
      expect(probe.reason).toContain('Missing optional dependency @openai/codex-darwin-arm64');
      expect(probe.reason).toContain('npm install -g @openai/codex@latest');
    }
  });

  it('reports a harness that never answers as broken', async () => {
    const probe = await probeVersion('hangs', env(), 300);
    expect(probe.state).toBe('broken');
  });
});

describe('firstErrorLine', () => {
  it('picks the Error line out of a Node crash, not the source excerpt', () => {
    expect(firstErrorLine('file:///x.js:1\n  throw new Error(\n        ^\n\nError: boom\n    at f')).toBe('Error: boom');
  });

  it('falls back to the first line when there is no Error line', () => {
    expect(firstErrorLine('\nsegmentation fault\n')).toBe('segmentation fault');
    expect(firstErrorLine(undefined)).toBeUndefined();
  });
});

describe('brokenHarness', () => {
  it('offers no models but says why', () => {
    const status = brokenHarness('codex', 'Error: boom');
    expect(status.installed).toBe(false);
    expect(status.refs).toEqual([]);
    expect(status.problems).toHaveLength(1);
    expect(status.problems[0]!.severity).toBe('warn');
    expect(status.problems[0]!.message).toContain('codex is on PATH but fails to run');
    expect(status.problems[0]!.message).toContain('Error: boom');
  });
});

describe('isBrokenHarness', () => {
  it('tells a crashing harness from an absent one', () => {
    expect(isBrokenHarness(brokenHarness('codex', 'Error: boom'))).toBe(true);
    expect(isBrokenHarness({ name: 'codex', installed: false, supported: false, refs: [], authedProviders: [], problems: [] })).toBe(false);
  });
});
