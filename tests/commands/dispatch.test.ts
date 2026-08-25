import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdDispatch } from '../../src/commands/dispatch.js';

const TIERED = `
[models."flash"]
gateway = "g"
id = "flash-1"
harness = "opencode"

[models."terra"]
gateway = "g"
id = "terra-1"
harness = "opencode"

[tiers.code]
simple = ["flash", "terra"]
complex = ["terra"]

[native.gateways."g"]
base_url = "http://gateway.example/v1"
`;

let cwd: string; let home: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-dispatch-'));
  home = mkdtempSync(join(tmpdir(), 'sonata-dispatch-home-'));
  writeFileSync(join(cwd, 'sonata.toml'), TIERED);
});

const opts = () => ({ cwd, home, tier: 'code-simple', task: 'do the thing', rolesDir: '/roles' });

describe('cmdDispatch', () => {
  it('returns the first candidate result when it succeeds', async () => {
    const outcome = await cmdDispatch(opts(), {
      run: async (o) => { expect(o.model).toBe('flash'); return { id: 'r1', session: 's', interactive: false }; },
      wait: async () => ({ id: 'r1', state: 'DONE', report: 'did it', lines: [], degraded: false }) as never,
    });
    expect(outcome).toMatchObject({ id: 'r1', state: 'DONE', modelKey: 'flash', report: 'did it' });
    expect(outcome.attempts).toHaveLength(1);
  });

  it('falls through to the next candidate on a degraded finish', async () => {
    const ran: string[] = [];
    const outcome = await cmdDispatch(opts(), {
      run: async (o) => { ran.push(o.model); return { id: `r${ran.length}`, session: 's', interactive: false }; },
      wait: async (o) => (o.id === 'r1'
        ? { id: 'r1', state: 'DONE', report: '', degraded: true, lines: [] }
        : { id: 'r2', state: 'DONE', report: 'terra did it', degraded: false, lines: [] }) as never,
    });
    expect(ran).toEqual(['flash', 'terra']);
    expect(outcome.modelKey).toBe('terra');
    expect(outcome.attempts.map((a) => a.state)).toEqual(['DONE', 'DONE']);
  });

  it('falls through when the launch itself throws', async () => {
    const ran: string[] = [];
    const outcome = await cmdDispatch(opts(), {
      run: async (o) => {
        ran.push(o.model);
        if (o.model === 'flash') throw new Error('database is locked');
        return { id: 'r2', session: 's', interactive: false };
      },
      wait: async () => ({ id: 'r2', state: 'DONE', report: 'ok', degraded: false, lines: [] }) as never,
    });
    expect(ran).toEqual(['flash', 'terra']);
    expect(outcome.state).toBe('DONE');
    expect(outcome.attempts[0]).toMatchObject({ modelKey: 'flash', state: 'FAILED', error: 'database is locked' });
  });

  it('returns PAUSED immediately — an approval is not a failure', async () => {
    const outcome = await cmdDispatch(opts(), {
      run: async () => ({ id: 'r1', session: 's', interactive: true }),
      wait: async () => ({ id: 'r1', state: 'PAUSED', lines: ['Allow?'], degraded: false }) as never,
    });
    expect(outcome.state).toBe('PAUSED');
    expect(outcome.attempts).toHaveLength(1);
  });

  it('stops rather than falling through when wait itself throws after a successful launch', async () => {
    const ran: string[] = [];
    const outcome = await cmdDispatch(opts(), {
      run: async (o) => { ran.push(o.model); return { id: 'r1', session: 's', interactive: false }; },
      wait: async () => { throw new Error('run-state file unreadable'); },
    });
    // Only flash was launched — terra must never start, since flash's run
    // may still be active and a second launch would race it on the same tree.
    expect(ran).toEqual(['flash']);
    expect(outcome).toMatchObject({ id: 'r1', state: 'FAILED', modelKey: 'flash' });
    expect(outcome.attempts[0]).toMatchObject({ error: 'run-state file unreadable' });
  });

  it('returns RUNNING immediately rather than reopening the wait window', async () => {
    let waitCalls = 0;
    const outcome = await cmdDispatch(opts(), {
      run: async () => ({ id: 'r1', session: 's', interactive: false }),
      wait: async () => { waitCalls += 1; return { id: 'r1', state: 'RUNNING', lines: [] } as never; },
    });
    expect(waitCalls).toBe(1);
    expect(outcome).toMatchObject({ id: 'r1', state: 'RUNNING', modelKey: 'flash' });
  });

  it('derives the role from the resolved alias, not by splitting a sonata-prefixed --tier', async () => {
    const outcome = await cmdDispatch({ ...opts(), tier: 'sonata-code-simple' }, {
      run: async (o) => { expect(o.role).toBe('code'); return { id: 'r1', session: 's', interactive: false }; },
      wait: async () => ({ id: 'r1', state: 'DONE', report: 'ok', degraded: false, lines: [] }) as never,
    });
    expect(outcome.state).toBe('DONE');
  });

  it('reports the exhausted list when every candidate fails', async () => {
    const outcome = await cmdDispatch(opts(), {
      run: async () => { throw new Error('down'); },
      wait: async () => { throw new Error('unreachable'); },
    });
    expect(outcome.state).toBe('FAILED');
    expect(outcome.attempts).toHaveLength(2);
  });

  it('--model dispatches exactly one key and refuses a harness-less one', async () => {
    const outcome = await cmdDispatch({ ...opts(), tier: undefined, model: 'terra' }, {
      run: async (o) => { expect(o.model).toBe('terra'); return { id: 'r1', session: 's', interactive: false }; },
      wait: async () => ({ id: 'r1', state: 'DONE', report: 'ok', degraded: false, lines: [] }) as never,
    });
    expect(outcome.modelKey).toBe('terra');
    await expect(cmdDispatch({ ...opts(), tier: undefined, model: 'missing' }, {}))
      .rejects.toThrow(/missing/);
  });

  it('--model defaults to the code role, but --role overrides it', async () => {
    const seenRoles: string[] = [];
    const run = async (o: { role: string }) => { seenRoles.push(o.role); return { id: 'r1', session: 's', interactive: false }; };
    const wait = async () => ({ id: 'r1', state: 'DONE', report: 'ok', degraded: false, lines: [] }) as never;

    await cmdDispatch({ ...opts(), tier: undefined, model: 'terra' }, { run, wait });
    await cmdDispatch({ ...opts(), tier: undefined, model: 'terra', role: 'review' }, { run, wait });

    expect(seenRoles).toEqual(['code', 'review']);
  });
});
