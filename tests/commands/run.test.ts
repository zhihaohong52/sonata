import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdRun, MAX_REPO_CONTEXT_CHARS, repoContext } from '../../src/commands/run.js';
import { readMeta, runDir } from '../../src/store.js';
import { killSession, hasSession, capturePane } from '../../src/tmux.js';
import { readPermissionMode } from '../../src/mode.js';

let cwd: string;
let created: string[] = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-run-'));
  mkdirSync(join(cwd, 'roles'), { recursive: true });
  writeFileSync(join(cwd, 'roles', 'code.md'), 'Do the work.');
  writeFileSync(join(cwd, 'sonata.toml'), `
[models.fake]
harness = "opencode"
id = "fake/fake"

[generate.roles]
code = ["fake"]
`);
});

afterEach(async () => {
  for (const s of created) await killSession(s);
  created = [];
});

describe('readPermissionMode', () => {
  it('defaults to the safest mode when no session file exists', () => {
    expect(readPermissionMode(cwd, 'missing')).toBe('default');
  });

  it('reads a written mode', () => {
    mkdirSync(join(cwd, '.sonata'), { recursive: true });
    writeFileSync(join(cwd, '.sonata', 'session-s1.json'),
      JSON.stringify({ permissionMode: 'bypassPermissions' }));
    expect(readPermissionMode(cwd, 's1')).toBe('bypassPermissions');
  });

  it('maps Claude Code `auto` onto acceptEdits', () => {
    // `auto` is Claude Code's current default mode: it runs lower-risk calls
    // without prompting. Treating it as `default` would claim the parent
    // prompts for everything, and would make every opencode dispatch refuse.
    mkdirSync(join(cwd, '.sonata'), { recursive: true });
    writeFileSync(join(cwd, '.sonata', 'session-s2.json'),
      JSON.stringify({ permissionMode: 'auto' }));
    expect(readPermissionMode(cwd, 's2')).toBe('acceptEdits');
  });

  it('still falls back to default for a genuinely unknown mode', () => {
    mkdirSync(join(cwd, '.sonata'), { recursive: true });
    writeFileSync(join(cwd, '.sonata', 'session-s3.json'),
      JSON.stringify({ permissionMode: 'someFutureMode' }));
    expect(readPermissionMode(cwd, 's3')).toBe('default');
  });
});

describe('cmdRun', () => {
  /** opencode refuses `default` mode, so a launch test must pick a mode it runs. */
  function sessionInMode(mode: string): string {
    mkdirSync(join(cwd, '.sonata'), { recursive: true });
    writeFileSync(join(cwd, '.sonata', 'session-run.json'),
      JSON.stringify({ permissionMode: mode }));
    return 'run';
  }

  it('creates a run, writes instructions and cmd.sh, and starts a live session', async () => {
    const taskFile = join(cwd, 'task.txt');
    writeFileSync(taskFile, 'Refactor the parser.');

    const res = await cmdRun({
      cwd, role: 'code', model: 'fake', taskFile,
      rolesDir: join(cwd, 'roles'), sessionId: sessionInMode('acceptEdits'),
    });
    created.push(res.session);

    const dir = runDir(cwd, res.id);
    expect(existsSync(join(dir, 'instructions.md'))).toBe(true);
    expect(existsSync(join(dir, 'cmd.sh'))).toBe(true);

    const instructions = readFileSync(join(dir, 'instructions.md'), 'utf8');
    expect(instructions).toContain('Refactor the parser.');
    expect(instructions).toContain(join(dir, 'report.md'));

    const meta = readMeta(cwd, res.id);
    expect(meta.harness).toBe('opencode');
    expect(meta.model).toBe('fake');
    expect(meta.mode).toBe('acceptEdits');

    expect(await hasSession(res.session)).toBe(true);
  });

  it('rejects an undefined model with an actionable message', async () => {
    const taskFile = join(cwd, 'task.txt');
    writeFileSync(taskFile, 'x');
    await expect(cmdRun({
      cwd, role: 'code', model: 'ghost', taskFile,
      rolesDir: join(cwd, 'roles'), sessionId: undefined,
    })).rejects.toThrow(/unknown model "ghost"/);
  });

  it('refuses an opencode dispatch when the mode is unknown', async () => {
    // No session file means no permission hook, and sonata assumes `default`.
    // opencode cannot honour that, so the dispatch must fail loudly rather
    // than silently run ungated.
    const taskFile = join(cwd, 'task.txt');
    writeFileSync(taskFile, 'x');
    await expect(cmdRun({
      cwd, role: 'code', model: 'fake', taskFile,
      rolesDir: join(cwd, 'roles'), sessionId: undefined,
    })).rejects.toThrow(/cannot ask for approval/i);
  });
});

describe('repoContext', () => {
  it('caps oversized repository instructions with a visible file marker', () => {
    writeFileSync(join(cwd, 'CLAUDE.md'), 'x'.repeat(MAX_REPO_CONTEXT_CHARS + 1_000));

    const context = repoContext(cwd);

    expect(context.length).toBeLessThanOrEqual(MAX_REPO_CONTEXT_CHARS);
    expect(context).toContain('[truncated: CLAUDE.md exceeded');
  });
});
