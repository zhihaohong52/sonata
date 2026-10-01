import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findHarnessUpdates, offerHarnessUpdates, realUpdateDeps, UPDATABLE_HARNESSES, type UpdateDeps,
} from '../../src/init/harness-updates.js';

/** Deps where every harness is installed at `installed` and npm says `latest`. */
function deps(
  installed: Record<string, string | undefined>,
  latest: Record<string, string | undefined>,
  run: UpdateDeps['run'] = async () => true,
): UpdateDeps {
  return {
    installedVersion: async (h) => installed[h],
    latestVersion: async (pkg) => latest[pkg],
    run,
  };
}

describe('findHarnessUpdates', () => {
  it('reports a harness whose npm latest is newer than the installed version', async () => {
    const found = await findHarnessUpdates(deps(
      { codex: 'codex-cli 0.156.1' },
      { '@openai/codex': '0.159.2' },
    ));
    expect(found).toEqual([{
      harness: 'codex', installed: '0.156.1', latest: '0.159.2',
      command: ['codex', 'update'], outsideTested: undefined,
    }]);
  });

  it('reads a leading v and a name prefix off the installed version', async () => {
    const found = await findHarnessUpdates(deps(
      { reasonix: 'reasonix v1.26.0' },
      { reasonix: '1.39.5' },
    ));
    expect(found.map((u) => [u.harness, u.installed])).toEqual([['reasonix', '1.26.0']]);
  });

  it('reports nothing for a harness that is current or ahead', async () => {
    const found = await findHarnessUpdates(deps(
      { codex: '0.159.2', pi: '0.99.2' },
      { '@openai/codex': '0.159.2', '@earendil-works/pi-coding-agent': '0.99.1' },
    ));
    expect(found).toEqual([]);
  });

  it('never prompts on an unknown: not installed, lookup failed, or unparseable', async () => {
    const found = await findHarnessUpdates(deps(
      { codex: undefined, opencode: '1.18.32', pi: 'weird', reasonix: '1.26.0' },
      { '@openai/codex': '9.9.9', 'opencode-ai': undefined, '@earendil-works/pi-coding-agent': '9.9.9', reasonix: 'garbage' },
    ));
    expect(found).toEqual([]);
  });

  it('names the tested range when the latest release falls outside it', async () => {
    const found = await findHarnessUpdates(deps(
      { opencode: '1.18.32' },
      { 'opencode-ai': '2.0.0' },
    ));
    expect(found[0].outsideTested).toBe('>=1.18.0 <2.0.0');
  });

  it('covers exactly the harnesses init detects, not claude', () => {
    expect([...UPDATABLE_HARNESSES].sort()).toEqual(['codex', 'opencode', 'pi', 'reasonix']);
  });
});

describe('offerHarnessUpdates', () => {
  const outdated = () => deps(
    { codex: '0.156.1', pi: '0.87.1' },
    { '@openai/codex': '0.159.2', '@earendil-works/pi-coding-agent': '0.99.1' },
  );

  /** Three outdated harnesses, one of them past its adapter's tested range. */
  const outdated3 = () => deps(
    { codex: '0.156.1', pi: '0.87.1', opencode: '1.18.32' },
    {
      '@openai/codex': '0.159.2',
      '@earendil-works/pi-coding-agent': '0.99.1',
      'opencode-ai': '2.0.0',
    },
  );

  it('asks once, naming every harness with both versions and the tested-range note only where it applies', async () => {
    const ask = vi.fn(async () => false);
    await offerHarnessUpdates({ interactive: true, ask, out: () => {}, deps: outdated3() });
    expect(ask).toHaveBeenCalledTimes(1);
    const [question, initial] = ask.mock.calls[0] as unknown as [string, boolean];
    expect(initial).toBe(true);
    expect(question).toContain('3 harness updates are available');
    expect(question).toContain('codex');
    expect(question).toContain('0.156.1');
    expect(question).toContain('0.159.2');
    expect(question).toContain('pi');
    expect(question).toContain('0.87.1');
    expect(question).toContain('0.99.1');
    expect(question).toContain('opencode');
    expect(question).toContain('1.18.32');
    expect(question).toContain('2.0.0');
    expect(question).toContain('Newer versions can serve models these do not list.');
    const noted = question.split('\n').filter((l) => l.includes('outside the range sonata has tested'));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain('opencode');
    expect(noted[0]).toContain('>=1.18.0 <2.0.0');
    expect(noted[0]).toContain('prompt detection may misbehave');
  });

  it('runs every updater concurrently: all started before any is released', async () => {
    const d = outdated();
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async (_command: string[], _out: (line: string) => void) => {
      started += 1;
      await gate;
      return true;
    });
    d.run = run;
    const lines: string[] = [];
    const done = offerHarnessUpdates({ interactive: true, ask: async () => true, out: (l) => lines.push(l), deps: d });
    // Sequential updaters hold the gate open forever and never both arrive
    // here, so `bothStarted` below fails instead of the test deadlocking.
    const deadline = Date.now() + 500;
    while (started < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    const bothStarted = started;
    release();
    await done;
    expect(bothStarted).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map((c) => c[0].join(' ')).sort()).toEqual(['codex update', 'pi update --self']);
  });

  it('keeps each harness\'s output contiguous even when the updaters interleave', async () => {
    const d = outdated();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    d.run = async (command, emit) => {
      const tag = command[0] === 'codex' ? 'c' : 'p';
      emit(`${tag}1`);
      await sleep(15);
      emit(`${tag}2`);
      return true;
    };
    const lines: string[] = [];
    await offerHarnessUpdates({ interactive: true, ask: async () => true, out: (l) => lines.push(l), deps: d });
    for (const tag of ['c', 'p']) {
      const first = lines.indexOf(`    ${tag}1`);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(lines[first + 1]).toBe(`    ${tag}2`);
      expect(lines[first + 2]).toMatch(new RegExp(`^  [✓!] ${tag === 'c' ? 'codex' : 'pi'} `));
    }
  });

  it('one updater throwing still lets the other finish, and both print a result', async () => {
    const d = outdated();
    d.run = async (command) => {
      if (command[0] === 'codex') throw new Error('spawn failed');
      return true;
    };
    const lines: string[] = [];
    await offerHarnessUpdates({ interactive: true, ask: async () => true, out: (l) => lines.push(l), deps: d });
    const text = lines.join('\n');
    expect(text).toMatch(/! codex update did not complete; continuing with 0\.156\.1/);
    expect(text).toMatch(/✓ pi updated to/);
  });

  it('declining the single prompt runs nothing and says the updates were skipped', async () => {
    const d = outdated();
    const run = vi.fn(async (_command: string[], _out: (line: string) => void) => true);
    d.run = run;
    const ask = vi.fn(async () => false);
    const lines: string[] = [];
    await offerHarnessUpdates({ interactive: true, ask, out: (l) => lines.push(l), deps: d });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('harness updates skipped');
  });

  it('reports the version reached after an update', async () => {
    let version = '0.156.1';
    const d: UpdateDeps = {
      installedVersion: async (h) => (h === 'codex' ? version : undefined),
      latestVersion: async (pkg) => (pkg === '@openai/codex' ? '0.159.2' : undefined),
      run: async () => { version = '0.159.2'; return true; },
    };
    const lines: string[] = [];
    await offerHarnessUpdates({ interactive: true, ask: async () => true, out: (l) => lines.push(l), deps: d });
    expect(lines.join('\n')).toContain('codex updated to 0.159.2');
  });

  it('never claims a version the re-probe cannot read', async () => {
    // The updater exited 0, which is not the same as knowing what is now
    // installed. Printing the pre-update version as "updated to" is a claim
    // nothing verified; the honest line names that instead. Both ways a probe
    // fails are covered: no version at all, and one that will not parse.
    const probes: Record<string, number> = {};
    const d: UpdateDeps = {
      installedVersion: async (harness) => {
        const n = probes[harness] = (probes[harness] ?? 0) + 1;
        if (n === 1) return harness === 'codex' ? '0.156.1' : harness === 'pi' ? '0.87.1' : undefined;
        return harness === 'codex' ? undefined : 'no version here';
      },
      latestVersion: async (pkg) => (pkg === '@openai/codex' ? '0.159.2'
        : pkg === '@earendil-works/pi-coding-agent' ? '0.99.1' : undefined),
      run: async () => true,
    };
    const lines: string[] = [];
    await offerHarnessUpdates({ interactive: true, ask: async () => true, out: (l) => lines.push(l), deps: d });
    const text = lines.join('\n');
    expect(text).toContain('✓ codex updater completed; installed version could not be verified');
    expect(text).toContain('✓ pi updater completed; installed version could not be verified');
    expect(text).not.toContain('updated to 0.156.1');
    expect(text).not.toContain('updated to 0.87.1');
  });

  it('continues on the old version when the updater fails', async () => {
    const d = deps(
      { codex: '0.156.1' },
      { '@openai/codex': '0.159.2' },
      async () => false,
    );
    const lines: string[] = [];
    await expect(offerHarnessUpdates({
      interactive: true, ask: async () => true, out: (l) => lines.push(l), deps: d,
    })).resolves.toBeUndefined();
    expect(lines.join('\n')).toMatch(/codex update did not complete.*0\.156\.1/);
  });

  it('never prompts or updates when unattended; names the command instead', async () => {
    const d = outdated();
    const run = vi.fn(async (_command: string[], _out: (line: string) => void) => true);
    d.run = run;
    const ask = vi.fn(async () => true);
    const lines: string[] = [];
    await offerHarnessUpdates({ interactive: false, ask, out: (l) => lines.push(l), deps: d });
    expect(ask).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('`codex update`');
    expect(lines.join('\n')).toContain('`pi update --self`');
  });

  it('says nothing when every harness is current', async () => {
    const lines: string[] = [];
    await offerHarnessUpdates({ interactive: true, ask: async () => true, out: (l) => lines.push(l), deps: deps({}, {}) });
    expect(lines).toEqual([]);
  });
});

describe('realUpdateDeps.run', () => {
  it('settles false at the timeout even when the updater ignores SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sonata-updater-'));
    const script = join(dir, 'stubborn');
    writeFileSync(script, "#!/bin/sh\ntrap '' TERM\necho starting\nsleep 30\n");
    chmodSync(script, 0o755);
    const lines: string[] = [];
    const started = Date.now();
    const ok = await realUpdateDeps(dir, 300).run([script], (l) => lines.push(l));
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports true for an updater that exits 0, forwarding its output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sonata-updater-'));
    const script = join(dir, 'fine');
    writeFileSync(script, '#!/bin/sh\necho updated\n');
    chmodSync(script, 0o755);
    const lines: string[] = [];
    expect(await realUpdateDeps(dir).run([script], (l) => lines.push(l))).toBe(true);
    expect(lines).toContain('updated');
  });
});
