import { describe, it, expect, vi } from 'vitest';
import {
  findHarnessUpdates, offerHarnessUpdates, UPDATABLE_HARNESSES, type UpdateDeps,
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

  it('runs the harness\'s own updater for each Yes, and skips each No', async () => {
    const d = outdated();
    const run = vi.fn(async (_command: string[], _out: (line: string) => void) => true);
    d.run = run;
    const ask = vi.fn(async (q: string) => q.includes('codex'));
    const lines: string[] = [];
    await offerHarnessUpdates({ interactive: true, ask, out: (l) => lines.push(l), deps: d });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual(['codex', 'update']);
    expect(lines.join('\n')).toMatch(/pi.*skipped/);
  });

  it('asks with Yes as the default and names both versions', async () => {
    const ask = vi.fn(async () => false);
    await offerHarnessUpdates({ interactive: true, ask, out: () => {}, deps: outdated() });
    const calls = ask.mock.calls as unknown as Array<[string, boolean]>;
    const [question, initial] = calls.find(([q]) => q.startsWith('codex'))!;
    expect(question).toContain('0.156.1');
    expect(question).toContain('0.159.2');
    expect(initial).toBe(true);
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

  it('continues on the old version when the updater fails', async () => {
    const d = outdated();
    d.run = async () => false;
    const lines: string[] = [];
    await expect(offerHarnessUpdates({
      interactive: true, ask: async (q) => q.includes('codex'), out: (l) => lines.push(l), deps: d,
    })).resolves.toBeUndefined();
    expect(lines.join('\n')).toMatch(/codex update did not complete.*0\.156\.1/);
  });

  it('continues when the updater throws', async () => {
    const d = outdated();
    d.run = async () => { throw new Error('spawn failed'); };
    const lines: string[] = [];
    await offerHarnessUpdates({ interactive: true, ask: async (q) => q.includes('codex'), out: (l) => lines.push(l), deps: d });
    expect(lines.join('\n')).toMatch(/codex update did not complete/);
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

  it('warns in the question when the new version is outside the tested range', async () => {
    const ask = vi.fn(async () => false);
    await offerHarnessUpdates({
      interactive: true, ask, out: () => {},
      deps: deps({ opencode: '1.18.32' }, { 'opencode-ai': '2.0.0' }),
    });
    expect((ask.mock.calls as unknown as Array<[string, boolean]>)[0][0]).toMatch(/outside.*tested/);
  });
});
