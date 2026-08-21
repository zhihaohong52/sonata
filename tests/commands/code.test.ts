import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventEmitter } from 'node:events';
import type { spawn as spawnType } from 'node:child_process';

import { execClaude, planCode } from '../../src/commands/code.js';

let cwd: string;
let home: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-code-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'sonata-code-home-'));
});

describe('planCode', () => {
  it('sets the router URL and minimum native context window', () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.models."large"]
gateway = "g"
id = "large-model"
context_window = 128000
[native.models."small"]
gateway = "g"
id = "small-model"
context_window = 32000
[native.gateways."g"]
base_url = "http://gateway.example/v1"
`);

    const plan = planCode({ cwd, home, passthrough: ['--model', 'sonnet'] });
    expect(plan.env.ANTHROPIC_BASE_URL).toBe('http://localhost:4100');
    expect(plan.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('32000');
  });

  it('omits the context variable when no native models exist', () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways."g"]
base_url = "http://gateway.example/v1"
`);

    expect(planCode({ cwd, home, passthrough: [] }).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  it('includes passthrough args and explains the Remote Control limitation', () => {
    writeFileSync(join(cwd, 'sonata.toml'), '[native]\n');
    const plan = planCode({ cwd, home, passthrough: ['--verbose', '--model', 'sonnet'] });

    expect(plan.argv).toEqual(['claude', '--verbose', '--model', 'sonnet']);
    expect(plan.banner).toMatch(/Remote Control unavailable/i);
  });
});

describe('execClaude', () => {
  /** A stand-in for the spawned child, driven by the test. */
  function fakeChild(): EventEmitter & { spawn: typeof spawnType } {
    const child = new EventEmitter();
    return Object.assign(child, {
      spawn: (() => child) as unknown as typeof spawnType,
    });
  }

  it('does not settle while claude is running', async () => {
    // The regression: an earlier version threw on the line after spawn, on the
    // theory that the exit handler made it unreachable. That handler fires a
    // tick later, so the throw always won — `sonata code` printed its banner
    // and then "failed to start claude", every time, while claude was starting
    // perfectly well.
    const { spawn: fake } = fakeChild();
    let settled = false;
    void execClaude(['claude'], { ANTHROPIC_BASE_URL: 'http://localhost:4100' }, { spawn: fake })
      .then(() => { settled = true; }, () => { settled = true; });

    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
  });

  it('relays claude\'s exit code', async () => {
    const child = fakeChild();
    const codes: number[] = [];
    void execClaude(['claude'], {}, { spawn: child.spawn, exit: (code) => { codes.push(code); } });

    child.emit('exit', 3, null);
    expect(codes).toEqual([3]);
  });

  it('re-raises the signal claude died from', async () => {
    const child = fakeChild();
    const signals: string[] = [];
    void execClaude(['claude'], {}, {
      spawn: child.spawn,
      exit: () => {},
      signal: (sig) => { signals.push(sig); },
    });

    child.emit('exit', null, 'SIGINT');
    expect(signals).toEqual(['SIGINT']);
  });

  it('explains a missing claude binary, and how to route by hand', async () => {
    const child = fakeChild();
    const promise = execClaude(['claude'], { ANTHROPIC_BASE_URL: 'http://localhost:4100' }, { spawn: child.spawn });

    const enoent: NodeJS.ErrnoException = new Error('spawn claude ENOENT');
    enoent.code = 'ENOENT';
    child.emit('error', enoent);

    await expect(promise).rejects.toThrow(/not on PATH.*ANTHROPIC_BASE_URL=http:\/\/localhost:4100/s);
  });

  it('passes any other spawn error through unchanged', async () => {
    const child = fakeChild();
    const promise = execClaude(['claude'], {}, { spawn: child.spawn });

    child.emit('error', new Error('EACCES: permission denied'));
    await expect(promise).rejects.toThrow(/permission denied/);
  });
});
