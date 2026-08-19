import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_DEFS, callTool, truncateReport, MAX_REPORT_CHARS, resolveTaskFile, transcriptFor } from '../../src/mcp/tools.js';
import { appendEvents, runDir } from '../../src/store.js';

describe('truncateReport', () => {
  it('leaves an ordinary report exactly as it is', () => {
    expect(truncateReport('a short report', 'abc123')).toBe('a short report');
  });

  it('keeps the head and says where the rest is', () => {
    const big = 'x'.repeat(MAX_REPORT_CHARS + 500);
    const out = truncateReport(big, 'abc123');
    expect(out.length).toBeLessThan(big.length);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain('[truncated: full transcript at `sonata log abc123`]');
  });

  it('does not truncate at exactly the limit', () => {
    const exact = 'x'.repeat(MAX_REPORT_CHARS);
    expect(truncateReport(exact, 'abc123')).toBe(exact);
  });
});

describe('TOOL_DEFS', () => {
  it('exposes exactly dispatch, wait and approve', () => {
    expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual(['approve', 'dispatch', 'wait']);
  });

  it('declares the arguments each tool needs', () => {
    const dispatch = TOOL_DEFS.find((t) => t.name === 'dispatch')!;
    expect(Object.keys((dispatch.inputSchema as any).properties).sort())
      .toEqual(['cwd', 'model', 'role', 'task', 'task_file', 'transcript']);
    // `task` is not required: task_file is the paraphrase-proof alternative,
    // and resolveTaskFile enforces that exactly one of the two is given.
    expect((dispatch.inputSchema as any).required.sort()).toEqual(['model', 'role']);

    const wait = TOOL_DEFS.find((t) => t.name === 'wait')!;
    expect((wait.inputSchema as any).required).toEqual(['id']);
    expect(Object.keys((wait.inputSchema as any).properties)).toContain('transcript');
    expect((dispatch.inputSchema as any).properties.task.description).toMatch(/verbatim/i);
  });

  it('raises the result-size ceiling for the tools that return reports', () => {
    for (const name of ['dispatch', 'wait']) {
      const def = TOOL_DEFS.find((t) => t.name === name)!;
      expect(def._meta?.['anthropic/maxResultSizeChars']).toBe(200_000);
    }
  });
});

describe('callTool', () => {
  const env = { cwd: '/repo', home: '/home', rolesDir: '/pkg/roles' };

  it('refuses a tool it does not define', async () => {
    await expect(callTool('rm', {}, env)).rejects.toThrow(/unknown tool/i);
  });

  it('requires the arguments the schema declares', async () => {
    await expect(callTool('dispatch', { role: 'code' }, env)).rejects.toThrow(/model/);
    await expect(callTool('wait', {}, env)).rejects.toThrow(/id/);
  });

  it('no longer offers the polling tools', async () => {
    await expect(callTool('tail', { id: 'abc123' }, env)).rejects.toThrow(/unknown tool/i);
    await expect(callTool('run', { role: 'code', model: 'm', task: 't' }, env))
      .rejects.toThrow(/unknown tool/i);
  });

  it('uses a valid dispatch cwd and returns it for resuming', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sonata-tool-cwd-'));
    let runCwd = '';
    let waitCwd = '';
    const result = await callTool('dispatch', { role: 'code', model: 'm', task: 't', cwd }, {
      ...env,
      run: async (opts) => {
        runCwd = opts.cwd;
        return { id: 'abc123', session: 'sonata-abc123', interactive: false };
      },
      wait: async (opts) => {
        waitCwd = opts.cwd;
        return { id: opts.id, state: 'RUNNING', lines: [] };
      },
    });

    expect(runCwd).toBe(cwd);
    expect(waitCwd).toBe(cwd);
    expect(JSON.parse(result)).toMatchObject({ id: 'abc123', cwd });
  });

  it('refuses missing and non-directory cwd values without launching a run', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'sonata-tool-cwd-'));
    const file = join(parent, 'not-a-directory');
    writeFileSync(file, 'x');
    let launched = false;
    const testEnv = { ...env, run: async () => {
      launched = true;
      throw new Error('should not launch');
    } };

    await expect(callTool('dispatch', { role: 'code', model: 'm', task: 't', cwd: join(parent, 'missing') }, testEnv))
      .rejects.toThrow(/does not exist or is not a directory/);
    await expect(callTool('dispatch', { role: 'code', model: 'm', task: 't', cwd: file }, testEnv))
      .rejects.toThrow(/does not exist or is not a directory/);
    expect(launched).toBe(false);
  });

  it('uses cwd supplied to wait to find a run outside the server directory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sonata-tool-wait-'));
    let waitCwd = '';
    const result = await callTool('wait', { id: 'abc123', cwd }, {
      ...env,
      wait: async (opts) => {
        waitCwd = opts.cwd;
        return { id: opts.id, state: 'RUNNING', lines: [] };
      },
    });

    expect(waitCwd).toBe(cwd);
    expect(JSON.parse(result)).toMatchObject({ id: 'abc123', cwd });
  });

  it('passes an output observer to dispatch and wait', async () => {
    const onLines = () => {};
    let dispatchObserver: unknown;
    let waitObserver: unknown;
    const run = async () => ({ id: 'abc123', session: 'sonata-abc123', interactive: false });
    const wait = async (opts: any) => {
      if (opts.id === 'abc123') dispatchObserver = opts.onLines;
      if (opts.id === 'def456') waitObserver = opts.onLines;
      return { id: opts.id, state: 'RUNNING' as const, lines: [] };
    };

    await callTool('dispatch', { role: 'code', model: 'm', task: 't' }, { ...env, run, wait }, onLines);
    await callTool('wait', { id: 'def456' }, { ...env, wait }, onLines);

    expect(dispatchObserver).toBe(onLines);
    expect(waitObserver).toBe(onLines);
  });
});

/**
 * `task_file` exists because the wrapper agent paraphrases: a ~3K spec once
 * reached the harness as one line. A path cannot be paraphrased.
 */
describe('resolveTaskFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonata-taskfile-'));

  it('writes an inline task to a temp file and returns its path', () => {
    const p = resolveTaskFile({ task: 'do the thing' }, dir);
    expect(readFileSync(p, 'utf8')).toBe('do the thing');
  });

  it('returns the caller\'s file untouched, so the exact bytes survive', () => {
    const brief = join(dir, 'brief.md');
    writeFileSync(brief, '# A long brief\n\nwith detail\n');
    expect(resolveTaskFile({ task_file: brief }, dir)).toBe(brief);
  });

  it('resolves a relative task_file against the run cwd', () => {
    writeFileSync(join(dir, 'rel.md'), 'relative');
    expect(resolveTaskFile({ task_file: 'rel.md' }, dir)).toBe(join(dir, 'rel.md'));
  });

  // Preferring one silently would let a paraphrased `task` beat the file the
  // caller actually meant.
  it('refuses both at once rather than picking', () => {
    const brief = join(dir, 'brief.md');
    expect(() => resolveTaskFile({ task: 'x', task_file: brief }, dir))
      .toThrow(/either "task" or "task_file", not both/);
  });

  it('refuses a task_file that does not exist', () => {
    expect(() => resolveTaskFile({ task_file: join(dir, 'gone.md') }, dir))
      .toThrow(/does not exist/);
  });

  it('refuses neither being given', () => {
    expect(() => resolveTaskFile({}, dir)).toThrow(/required/);
  });
});


describe('transcriptFor', () => {
  function runWithEvents(lines: string[]): { cwd: string; id: string } {
    const cwd = mkdtempSync(join(tmpdir(), 'sonata-transcript-'));
    mkdirSync(runDir(cwd, 'abc123'), { recursive: true });
    appendEvents(cwd, 'abc123', lines);
    return { cwd, id: 'abc123' };
  }

  it('returns every recorded line', () => {
    const { cwd, id } = runWithEvents(['first turn', 'second turn']);
    expect(transcriptFor(cwd, id, 0)).toBe('first turn\nsecond turn');
  });

  it('returns nothing for a run that recorded no output', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sonata-transcript-'));
    expect(transcriptFor(cwd, 'abc123', 0)).toBeUndefined();
  });

  it('budgets itself against the report sharing the result', () => {
    const { cwd, id } = runWithEvents(['x'.repeat(200)]);
    const out = transcriptFor(cwd, id, MAX_REPORT_CHARS - 50)!;
    expect(out).toContain('[truncated: whole transcript at `sonata log abc123`]');
    expect(out.startsWith('x'.repeat(50))).toBe(true);
  });

  it('yields the result to the report when the report fills it', () => {
    const { cwd, id } = runWithEvents(['anything at all']);
    expect(transcriptFor(cwd, id, MAX_REPORT_CHARS)).toBe(
      '[omitted: the report used the whole result — `sonata log abc123`]',
    );
  });
});

describe('callTool — transcript', () => {
  function envWithRun(lines: string[]) {
    const cwd = mkdtempSync(join(tmpdir(), 'sonata-tool-transcript-'));
    mkdirSync(runDir(cwd, 'abc123'), { recursive: true });
    appendEvents(cwd, 'abc123', lines);
    return {
      cwd,
      home: '/home',
      rolesDir: '/pkg/roles',
      wait: async (opts: any) => ({
        id: opts.id, state: 'DONE' as const, report: 'the report', lines: [],
      }),
    };
  }

  it('omits the transcript unless it was asked for', async () => {
    const env = envWithRun(['a turn']);
    const out = JSON.parse(await callTool('wait', { id: 'abc123' }, env));
    expect(out.transcript).toBeUndefined();
    expect(out.report).toBe('the report');
  });

  it('returns it beside the report when asked', async () => {
    const env = envWithRun(['a turn', 'another turn']);
    const out = JSON.parse(await callTool('wait', { id: 'abc123', transcript: true }, env));
    expect(out.transcript).toBe('a turn\nanother turn');
    expect(out.report).toBe('the report');
  });
});
