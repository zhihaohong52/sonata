# One-Call Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a sonata dispatch cost one MCP tool call and one result instead of one call per model turn.

**Architecture:** A new blocking loop (`cmdWait`) wraps the existing `cmdTail` and returns only when the run reaches a state worth reporting. The MCP surface becomes `dispatch` / `wait` / `approve`; `run` and `tail` are removed from it so the expensive path cannot be taken. `sonata tail` remains a CLI command.

**Tech Stack:** TypeScript (ESM, Node 22+), vitest, tmux. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-one-call-dispatch-design.md`

## Global Constraints

- Node 22+, TypeScript ESM. Relative imports carry the `.js` extension.
- `npm run typecheck` and `npm test` must pass before every commit.
- **`sonata` on PATH runs `dist/`, not `src/`.** Run `npm run build` before any manual CLI check, or you will test the old behaviour.
- Tests need tmux and run against the fake harness in `tests/fake-harness/`. No API keys.
- New config keys are snake_case in TOML, camelCase in `SonataConfig`.
- Default `dispatch_window_seconds` = `1500`. It must stay below Claude Code's 30-minute (1800s) stdio idle window.
- `MAX_REPORT_CHARS` = `40_000`. `MAX_RESULT_SIZE_CHARS` = `200_000` (hard ceiling imposed by Claude Code is 500,000).
- Comments explain *why*, matching the density of surrounding code. Findings from probes go in comments, not commit messages alone.

---

### Task 1: `dispatch_window_seconds` config key

**Files:**
- Modify: `src/config.ts:24-28` (the `run` block of `SonataConfig`), `src/config.ts:104-108` (the `run` block of `parseConfig`)
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SonataConfig['run']['dispatchWindowSeconds']: number`, default `1500`.

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts`:

```typescript
describe('dispatch window', () => {
  it('defaults to 1500 seconds, inside the 30-minute MCP idle window', () => {
    const c = parseConfig(`
[models.m]
harness = "opencode"
id = "p/m"

[generate.roles]
code = ["m"]
`);
    expect(c.run.dispatchWindowSeconds).toBe(1500);
  });

  it('reads an override from the run table', () => {
    const c = parseConfig(`
[models.m]
harness = "opencode"
id = "p/m"

[generate.roles]
code = ["m"]

[run]
dispatch_window_seconds = 600
`);
    expect(c.run.dispatchWindowSeconds).toBe(600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts -t "dispatch window"`
Expected: FAIL — `expected undefined to be 1500`

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`, add the field to the interface:

```typescript
  run: {
    tailWindowSeconds: number;
    stallTimeoutSeconds: number;
    runTimeoutSeconds: number;
    /**
     * How long `dispatch`/`wait` block before returning RUNNING.
     *
     * Claude Code aborts an MCP call that sends nothing for its idle window —
     * 30 minutes for stdio servers. Silence is already covered by
     * stallTimeoutSeconds; this bounds the opposite case, a productive run
     * that works for longer than the window and would otherwise be killed
     * mid-flight. Must stay below 1800.
     */
    dispatchWindowSeconds: number;
  };
```

and to `parseConfig`'s return:

```typescript
    run: {
      tailWindowSeconds: num(raw.run?.tail_window_seconds, 20),
      stallTimeoutSeconds: num(raw.run?.stall_timeout_seconds, 120),
      runTimeoutSeconds: num(raw.run?.run_timeout_seconds, 1800),
      dispatchWindowSeconds: num(raw.run?.dispatch_window_seconds, 1500),
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean (other `SonataConfig` literals may need the new field — fix any the compiler names).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: dispatch_window_seconds bounds a blocking dispatch"
```

---

### Task 2: `cmdWait`, the blocking loop

**Files:**
- Create: `src/commands/wait.ts`
- Test: `tests/commands/wait.test.ts`

**Interfaces:**
- Consumes: `cmdTail(opts: TailOptions): Promise<TailResult>` and `TailResult` from `src/commands/tail.ts`; `loadConfig` from `src/config.ts`.
- Produces:
  ```typescript
  export type WaitState = TailState | 'RUNNING';
  export interface WaitResult extends Omit<TailResult, 'state'> { state: WaitState; id: string }
  export interface WaitOptions {
    cwd: string;
    id: string;
    windowSeconds?: number;   // defaults to config run.dispatchWindowSeconds
    pollMs?: number;
    now?: () => number;
    tail?: typeof cmdTail;    // seam for tests
  }
  export function cmdWait(opts: WaitOptions): Promise<WaitResult>
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/commands/wait.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdWait } from '../../src/commands/wait.js';
import type { TailResult } from '../../src/commands/tail.js';

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'sonata-wait-'));
  writeFileSync(join(cwd, 'sonata.toml'), `
[models.m]
harness = "opencode"
id = "p/m"

[generate.roles]
code = ["m"]
`);
  return cwd;
}

/** A scripted cmdTail: returns each result in order, repeating the last. */
function scripted(results: TailResult[]) {
  let i = 0;
  return async () => results[Math.min(i++, results.length - 1)];
}

const PROGRESS: TailResult = { state: 'PROGRESS', lines: [] };

describe('cmdWait', () => {
  it('keeps waiting through PROGRESS and returns the first terminal state', async () => {
    const done: TailResult = { state: 'DONE', lines: [], report: 'the report', exitCode: 0, degraded: false };
    const r = await cmdWait({
      cwd: repo(), id: 'abc123', pollMs: 1,
      tail: scripted([PROGRESS, PROGRESS, done]) as any,
    });
    expect(r.state).toBe('DONE');
    expect(r.report).toBe('the report');
    expect(r.id).toBe('abc123');
  });

  it('returns on PAUSED so a human can answer', async () => {
    const paused: TailResult = { state: 'PAUSED', lines: [], prompt: 'Allow once?' };
    const r = await cmdWait({
      cwd: repo(), id: 'abc123', pollMs: 1,
      tail: scripted([PROGRESS, paused]) as any,
    });
    expect(r.state).toBe('PAUSED');
    expect(r.prompt).toBe('Allow once?');
  });

  it('returns on STALLED rather than blocking to the idle timeout', async () => {
    const stalled: TailResult = { state: 'STALLED', lines: ['nothing since'] };
    const r = await cmdWait({
      cwd: repo(), id: 'abc123', pollMs: 1,
      tail: scripted([stalled]) as any,
    });
    expect(r.state).toBe('STALLED');
  });

  // The window keeps the call inside Claude Code's 30-minute stdio idle
  // window. RUNNING is resumable: the run is untouched and still in tmux.
  it('gives up its window and returns RUNNING, not a failure', async () => {
    let t = 0;
    const r = await cmdWait({
      cwd: repo(), id: 'abc123', pollMs: 1, windowSeconds: 10,
      now: () => (t += 4_000),
      tail: scripted([PROGRESS]) as any,
    });
    expect(r.state).toBe('RUNNING');
    expect(r.id).toBe('abc123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/wait.test.ts`
Expected: FAIL — cannot resolve `../../src/commands/wait.js`

- [ ] **Step 3: Write minimal implementation**

Create `src/commands/wait.ts`:

```typescript
import { loadConfig } from '../config.js';
import { cmdTail } from './tail.js';
import type { TailResult } from './tail.js';
import type { TailState } from '../types.js';

/**
 * `RUNNING` is not a run state — it means "this call gave up its window, the
 * run is untouched". The caller resumes with another `cmdWait` on the same id.
 */
export type WaitState = TailState | 'RUNNING';

export interface WaitResult extends Omit<TailResult, 'state'> {
  state: WaitState;
  /** Always present, so a caller resuming after RUNNING or PAUSED has the id. */
  id: string;
}

export interface WaitOptions {
  cwd: string;
  id: string;
  windowSeconds?: number;
  pollMs?: number;
  now?: () => number;
  /** Seam for tests; production always uses the real cmdTail. */
  tail?: typeof cmdTail;
}

/**
 * Blocks until a run reaches a state worth returning to the caller.
 *
 * This exists so a dispatch costs one tool call instead of one per model turn.
 * Every intermediate PROGRESS result used to be returned to the wrapper agent,
 * which re-sent its whole context each time — so the cost grew with the length
 * of the run rather than the size of its result. Nothing read those lines.
 *
 * The loop reuses cmdTail rather than growing a second state machine, so pane
 * diffing, events.jsonl and the cursor keep advancing exactly as before and
 * `sonata log` is unaffected.
 */
export async function cmdWait(opts: WaitOptions): Promise<WaitResult> {
  const now = opts.now ?? (() => Date.now());
  const tail = opts.tail ?? cmdTail;
  const pollMs = opts.pollMs ?? 500;
  const windowSeconds = opts.windowSeconds
    ?? loadConfig(opts.cwd).run.dispatchWindowSeconds;
  const deadline = now() + windowSeconds * 1000;

  for (;;) {
    const result = await tail({
      cwd: opts.cwd,
      id: opts.id,
      // One tail call must not outlast the window it is spending.
      waitSeconds: Math.max(0, Math.ceil((deadline - now()) / 1000)),
      pollMs,
    });
    if (result.state !== 'PROGRESS') return { ...result, id: opts.id };
    if (now() >= deadline) return { ...result, state: 'RUNNING', id: opts.id };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/commands/wait.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/wait.ts tests/commands/wait.test.ts
git commit -m "feat: cmdWait blocks until a run is worth reporting"
```

---

### Task 3: `cmdWait` against the fake harness

**Files:**
- Modify: `tests/e2e.test.ts`

**Interfaces:**
- Consumes: `cmdWait` from Task 2; the existing `launch()` and `writeConfig()` helpers in `tests/e2e.test.ts`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `tests/e2e.test.ts`, inside the existing `describe('end to end against the fake harness')`:

```typescript
  // The one-call path: no polling loop, one call, the report.
  it('cmdWait returns DONE with the report in a single call', async () => {
    const { cmdWait } = await import('../src/commands/wait.js');
    const id = await launch('normal', false);
    const r = await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    expect(r.state).toBe('DONE');
    expect(r.report).toContain('Refactored the parser');
    expect(r.report).toContain(`— sonata ${id}:`);
    expect(r.degraded).toBe(false);
  });

  it('cmdWait surfaces a crash as DONE degraded in one call', async () => {
    const { cmdWait } = await import('../src/commands/wait.js');
    const id = await launch('crash', false);
    const r = await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    expect(r.state).toBe('DONE');
    expect(r.degraded).toBe(true);
    expect(r.report).toContain('segmentation fault');
  });

  it('cmdWait stops at PAUSED, and resumes to DONE after approve', async () => {
    writeConfig(30, 30, 'codex');
    const id = await launch('prompt', true, 'codex');
    const { cmdWait } = await import('../src/commands/wait.js');
    const paused = await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    expect(paused.state).toBe('PAUSED');
    expect(paused.prompt).toContain('Would you like to run the following command?');
    expect(paused.id).toBe(id);

    const { cmdApprove } = await import('../src/commands/approve.js');
    await cmdApprove({ cwd, id, yes: true });
    const done = await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    expect(['DONE', 'PAUSED', 'STALLED']).toContain(done.state);
  });

  it('cmdWait returns STALLED rather than blocking on a silent run', async () => {
    writeConfig(3);
    const id = await launch('prompt', false);
    const { cmdWait } = await import('../src/commands/wait.js');
    const r = await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    expect(r.state).toBe('STALLED');
  });

  // Idempotent: the retry path exists for calls that may have been dropped
  // mid-block, so calling wait once too often must return the report again.
  it('cmdWait on a finished run returns the report again, not an error', async () => {
    const { cmdWait } = await import('../src/commands/wait.js');
    const id = await launch('normal', false);
    await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    const again = await cmdWait({ cwd, id, pollMs: 200, windowSeconds: 30 });
    expect(again.state).toBe('DONE');
    expect(again.report).toContain('Refactored the parser');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/e2e.test.ts -t "cmdWait"`
Expected: FAIL if Task 2 is incomplete; otherwise these should pass on first run — that is fine, they are regression cover for a loop that already exists. If any fails, fix `src/commands/wait.ts`, not the test.

- [ ] **Step 3: No implementation needed**

These exercise Task 2's code against real tmux and the fake harness. If `cmdWait` needs a change to pass, make it in `src/commands/wait.ts`.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e.test.ts
git commit -m "test: cmdWait against the fake harness, including resume after approve"
```

---

### Task 4: Report truncation

**Files:**
- Modify: `src/mcp/tools.ts`
- Test: `tests/mcp/tools.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export const MAX_REPORT_CHARS: number` and `export function truncateReport(report: string, id: string, max?: number): string`.

- [ ] **Step 1: Write the failing test**

Add to `tests/mcp/tools.test.ts`:

```typescript
import { truncateReport, MAX_REPORT_CHARS } from '../../src/mcp/tools.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/tools.test.ts -t "truncateReport"`
Expected: FAIL — `truncateReport` is not exported

- [ ] **Step 3: Write minimal implementation**

Add to `src/mcp/tools.ts`:

```typescript
/**
 * Ceiling on a report returned through MCP.
 *
 * Claude Code warns above 10k tokens of tool output and caps at 25k, and a
 * result over its persist-to-disk threshold is replaced in the conversation by
 * a file reference — which stops the report being the wrapper's final message,
 * the one thing the orchestrator actually reads. 40k characters is roughly 10k
 * tokens, so an ordinary report stays inline and under the warning.
 */
export const MAX_REPORT_CHARS = 40_000;

/** Keeps the head of an oversized report and says where the whole thing is. */
export function truncateReport(report: string, id: string, max = MAX_REPORT_CHARS): string {
  if (report.length <= max) return report;
  return `${report.slice(0, max)}\n\n[truncated: full transcript at \`sonata log ${id}\`]`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/tools.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/tools.test.ts
git commit -m "feat: truncate an oversized report rather than lose it to a file reference"
```

---

### Task 5: The `dispatch` and `wait` MCP tools

**Files:**
- Modify: `src/mcp/tools.ts` (`TOOL_DEFS`, `callTool`), `src/mcp/protocol.ts:23-27` (`ToolDef`)
- Test: `tests/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `cmdWait`, `WaitResult` (Task 2); `truncateReport`, `MAX_REPORT_CHARS` (Task 4); existing `cmdRun`, `cmdApprove`.
- Produces: MCP tools named `dispatch`, `wait`, `approve`. `ToolDef` gains an optional `_meta?: Record<string, unknown>`.

- [ ] **Step 1: Write the failing test**

Replace the `TOOL_DEFS` describe block in `tests/mcp/tools.test.ts` with:

```typescript
describe('TOOL_DEFS', () => {
  // `run` and `tail` are deliberately absent: a wrapper that cannot poll
  // cannot spend a turn per model turn. `sonata tail` is still a CLI command.
  it('exposes exactly dispatch, wait and approve', () => {
    expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual(['approve', 'dispatch', 'wait']);
  });

  it('declares the arguments each tool needs', () => {
    const dispatch = TOOL_DEFS.find((t) => t.name === 'dispatch')!;
    expect(Object.keys((dispatch.inputSchema as any).properties).sort())
      .toEqual(['model', 'role', 'task']);
    expect((dispatch.inputSchema as any).required.sort()).toEqual(['model', 'role', 'task']);

    const wait = TOOL_DEFS.find((t) => t.name === 'wait')!;
    expect((wait.inputSchema as any).required).toEqual(['id']);
  });

  // Without this, a long report is persisted to disk and replaced by a file
  // reference instead of being the wrapper's final message.
  it('raises the result-size ceiling for the tools that return reports', () => {
    for (const name of ['dispatch', 'wait']) {
      const def = TOOL_DEFS.find((t) => t.name === name)!;
      expect(def._meta?.['anthropic/maxResultSizeChars']).toBe(200_000);
    }
  });
});
```

and update the `callTool` describe block:

```typescript
describe('callTool', () => {
  const env = { cwd: '/repo', home: '/home', rolesDir: '/pkg/roles' };

  it('refuses a tool it does not define', async () => {
    await expect(callTool('rm', {}, env)).rejects.toThrow(/unknown tool/i);
  });

  it('no longer offers the polling tools', async () => {
    await expect(callTool('tail', { id: 'abc123' }, env)).rejects.toThrow(/unknown tool/i);
    await expect(callTool('run', { role: 'code', model: 'm', task: 't' }, env))
      .rejects.toThrow(/unknown tool/i);
  });

  it('requires the arguments the schema declares', async () => {
    await expect(callTool('dispatch', { role: 'code' }, env)).rejects.toThrow(/model/);
    await expect(callTool('wait', {}, env)).rejects.toThrow(/id/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/tools.test.ts`
Expected: FAIL — `expected ['approve','run','tail'] to equal ['approve','dispatch','wait']`

- [ ] **Step 3: Write minimal implementation**

In `src/mcp/protocol.ts`, extend `ToolDef`:

```typescript
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  /** Passed through verbatim in `tools/list`; see anthropic/maxResultSizeChars. */
  _meta?: Record<string, unknown>;
}
```

In `src/mcp/tools.ts`, replace `TOOL_DEFS` and the `run`/`tail` cases:

```typescript
/**
 * Claude Code's hard ceiling is 500,000; 200,000 is generous enough for a
 * degraded report carrying pane text while staying well inside it.
 */
const MAX_RESULT_SIZE_CHARS = 200_000;
const REPORT_META = { 'anthropic/maxResultSizeChars': MAX_RESULT_SIZE_CHARS };

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'dispatch',
    description:
      'Run a task on a foreign model and return its report. Blocks until the run ' +
      'finishes, needs an approval, or stalls — so one call is usually the whole ' +
      'dispatch. Returns state DONE, PAUSED, STALLED or RUNNING.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'code | review | explore | plan' },
        model: { type: 'string', description: 'a model key from sonata.toml' },
        task: { type: 'string', description: 'the full task text for the model' },
      },
      required: ['role', 'model', 'task'],
    },
    _meta: REPORT_META,
  },
  {
    name: 'wait',
    description:
      'Resume waiting on a run already launched — after answering a PAUSED prompt, ' +
      'or when a previous call returned RUNNING. Same states as dispatch.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'the run id' } },
      required: ['id'],
    },
    _meta: REPORT_META,
  },
  {
    name: 'approve',
    description: 'Answer a run that is PAUSED awaiting approval.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        answer: { type: 'string', description: 'yes or no' },
      },
      required: ['id', 'answer'],
    },
  },
];

/** Trims the report in a result, leaving every other field alone. */
function withTrimmedReport(result: WaitResult): WaitResult {
  return result.report === undefined
    ? result
    : { ...result, report: truncateReport(result.report, result.id) };
}
```

and in `callTool`:

```typescript
    case 'dispatch': {
      const role = need(args, 'role');
      const model = need(args, 'model');
      const task = need(args, 'task');
      const taskFile = join(tmpdir(), `sonata-task-${Date.now()}-${randomUUID().slice(0, 8)}.md`);
      writeFileSync(taskFile, task);
      const started = await cmdRun({
        cwd: env.cwd,
        role,
        model,
        taskFile,
        rolesDir: env.rolesDir,
        sessionId: env.sessionId,
      });
      const result = await cmdWait({ cwd: env.cwd, id: started.id });
      return JSON.stringify(withTrimmedReport(result));
    }
    case 'wait': {
      const result = await cmdWait({ cwd: env.cwd, id: need(args, 'id') });
      return JSON.stringify(withTrimmedReport(result));
    }
```

Delete the `run` and `tail` cases. Add the imports:

```typescript
import { cmdWait } from '../commands/wait.js';
import type { WaitResult } from '../commands/wait.js';
```

and remove the now-unused `import { cmdTail } from '../commands/tail.js';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp/ && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/protocol.ts tests/mcp/tools.test.ts
git commit -m "feat: dispatch and wait replace run and tail on the MCP surface"
```

---

### Task 6: Allow-list the new tool names

**Files:**
- Modify: `src/settings.ts:42-46` (`SONATA_TOOLS`)
- Test: `tests/allowlist.test.ts`, `tests/settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SONATA_TOOLS` = `['mcp__sonata__dispatch', 'mcp__sonata__wait', 'mcp__sonata__approve']`.

- [ ] **Step 1: Write the failing test**

Add to `tests/allowlist.test.ts`:

```typescript
  it('allow-lists the tools the wrapper actually holds', () => {
    expect(SONATA_TOOLS).toEqual([
      'mcp__sonata__dispatch',
      'mcp__sonata__wait',
      'mcp__sonata__approve',
    ]);
  });

  // A leftover entry is harmless to permissions but tells doctor the settings
  // were written for the polling wrapper, which no longer exists.
  it('does not name the removed polling tools', () => {
    expect(SONATA_TOOLS).not.toContain('mcp__sonata__run');
    expect(SONATA_TOOLS).not.toContain('mcp__sonata__tail');
  });
```

Import `SONATA_TOOLS` from `../src/settings.js` if the file does not already.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/allowlist.test.ts`
Expected: FAIL — the array still names `run` and `tail`

- [ ] **Step 3: Write minimal implementation**

In `src/settings.ts`, replace the array and update the comment above it so it describes the current tools:

```typescript
export const SONATA_TOOLS = [
  'mcp__sonata__dispatch',
  'mcp__sonata__wait',
  'mcp__sonata__approve',
];
```

The existing comment argues that permitting the executing tool while blocking the read-back is the worst half to keep. Update its wording: `dispatch` both executes and reads back, so a denied `wait` now strands only a run that paused.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/allowlist.test.ts tests/settings.test.ts && npm run typecheck`
Expected: PASS. Fix any other test that asserts the old names.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts tests/allowlist.test.ts tests/settings.test.ts
git commit -m "feat: allow-list dispatch and wait instead of run and tail"
```

---

### Task 7: The wrapper agent template

**Files:**
- Modify: `src/commands/sync.ts:14-70` (`agentMarkdown`)
- Test: `tests/commands/sync.test.ts`

**Interfaces:**
- Consumes: the tool names from Task 5.
- Produces: `agentMarkdown` emitting `tools: mcp__sonata__dispatch, mcp__sonata__wait, mcp__sonata__approve` and a procedure with no polling step.

- [ ] **Step 1: Write the failing test**

Add to `tests/commands/sync.test.ts`:

```typescript
describe('agentMarkdown — one-call dispatch', () => {
  const md = agentMarkdown({ role: 'code', model: 'm', harness: 'opencode' });

  it('grants the three tools the wrapper holds', () => {
    expect(md).toContain('tools: mcp__sonata__dispatch, mcp__sonata__wait, mcp__sonata__approve');
  });

  it('never tells the wrapper to poll', () => {
    expect(md).not.toMatch(/\bpoll\b/i);
    expect(md).not.toContain('`tail`');
  });

  it('tells it to resume with wait after a RUNNING result', () => {
    expect(md).toContain('RUNNING');
    expect(md).toContain('`wait`');
  });

  it('still forbids doing the work itself', () => {
    expect(md).toContain('You do no work of your own.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/sync.test.ts -t "one-call dispatch"`
Expected: FAIL — the frontmatter still names `run` and `tail`

- [ ] **Step 3: Write minimal implementation**

In `src/commands/sync.ts`, change the frontmatter line to:

```
tools: mcp__sonata__dispatch, mcp__sonata__wait, mcp__sonata__approve
```

and replace the whole `## Procedure` section with:

```markdown
## Procedure

1. Call the \`dispatch\` tool exactly once with:
   role: ${spec.role}, model: ${spec.model}, and the full task text.
   It blocks until the run is worth reporting, so one call is usually the
   whole job. Do not add your own waiting.

2. Act on the state it returns:

   - **DONE** — return the report as your final message and stop. Include its
     closing \`— sonata <id>: …\` provenance line exactly as given: it is the
     evidence the run really happened. If the report is marked degraded, say
     so in your first line; the harness exited without writing a report and
     the content is scraped terminal output.
   - **PAUSED** — stop and return immediately. Your final message must be
     exactly \`PAUSED <id>\` on the first line, then the pending action. You
     cannot approve it yourself; the main thread will ask the user and call
     the \`approve\` tool. The tmux session stays alive, so nothing is lost.
   - **RUNNING** — the call spent its window and the run is still going.
     Call the \`wait\` tool with the same id and act on what it returns.
     This is the only case where you make a second call.
   - **STALLED** — stop and return. First line: \`STALLED <id>\`, then the
     terminal tail you were given. Do not try to diagnose it.

3. Never call the \`approve\` tool yourself. Never start a second run.

4. If a tool call is refused — a permission denial rather than a result —
   stop and say so as your first line: \`BLOCKED <id> <tool> denied\`. Do not
   retry it, work around it, or summarise the task from the run id alone. The
   run is still executing in tmux and is now unobserved, which is the one
   outcome worse than a failed dispatch: the human needs to know a model is
   writing to their repository with nothing watching it.
```

Keep the closing paragraph about `tmux attach -r` unchanged — it is now the only live view.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/commands/sync.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/sync.ts tests/commands/sync.test.ts
git commit -m "feat: the wrapper dispatches once instead of polling"
```

---

### Task 8: `sonata doctor` blocks on stale agents

**Files:**
- Modify: `src/commands/doctor.ts:102-116` (the wrapper-scanning block)
- Test: `tests/commands/doctor.test.ts`

**Interfaces:**
- Consumes: the tool names from Task 5.
- Produces: a `Check` named `agent tools` that is `ok: false` when a generated agent still names `mcp__sonata__run` or `mcp__sonata__tail`.

- [ ] **Step 1: Write the failing test**

Add a new describe block to `tests/commands/doctor.test.ts`. There is no shared
agent-writing helper in that file, so this block carries its own:

```typescript
describe('cmdDoctor — stale wrapper agents', () => {
  const MINIMAL = `
[models."m"]
harness = "codex"
id = "gpt-5.6-sol"

[generate.roles]
code = ["m"]
`;
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'doc-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'doc-home-'));
    writeFileSync(join(cwd, 'sonata.toml'), MINIMAL);
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
  });

  const writeAgent = (file: string, tools: string) => {
    writeFileSync(join(cwd, '.claude', 'agents', file), [
      '---',
      `name: ${file.replace(/\.md$/, '')}`,
      `tools: ${tools}`,
      '---',
      '',
      'You are a forwarding wrapper around the sonata runtime.',
      ''
    ].join('\n'));
  };

  // A stale agent instructs the wrapper to call tools that no longer exist, so
  // the dispatch fails partway with a foreign model already running. That is
  // the silent-failure class this repo keeps getting bitten by — block on it.
  it('blocks when a generated agent still names the polling tools', async () => {
    writeAgent('code-old.md', 'mcp__sonata__run, mcp__sonata__tail, mcp__sonata__approve');

    const { checks } = await cmdDoctor({ cwd, home });
    const check = checks.find((c) => c.name === 'agent tools')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('sonata sync');
  });

  it('passes when every agent names the current tools', async () => {
    writeAgent('code-new.md', 'mcp__sonata__dispatch, mcp__sonata__wait, mcp__sonata__approve');

    const { checks } = await cmdDoctor({ cwd, home });
    expect(checks.find((c) => c.name === 'agent tools')!.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/doctor.test.ts -t "polling tools"`
Expected: FAIL — the check reports ok because it only looks for `tools: Bash`

- [ ] **Step 3: Write minimal implementation**

In `src/commands/doctor.ts`, extend the wrapper scan. Keep the Bash check and add the stale-tool check beside it:

```typescript
  const wrappers = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((f) => f.endsWith('.md')).filter((f) =>
        readFileSync(join(agentsDir, f), 'utf8')
          .includes('forwarding wrapper around the sonata runtime'))
    : [];

  const withBash = wrappers.filter((f) =>
    /^tools:\s*Bash\s*$/m.test(readFileSync(join(agentsDir, f), 'utf8')));

  // An agent generated before one-call dispatch tells the wrapper to call
  // `run` and poll `tail`. Those tools are gone, so the dispatch dies partway
  // through with a foreign model already writing to the repository. A warning
  // is not enough: nothing downstream can tell that from a successful run.
  const stalePolling = wrappers.filter((f) =>
    /mcp__sonata__(run|tail)\b/.test(readFileSync(join(agentsDir, f), 'utf8')));

  checks.push(stalePolling.length === 0
    ? { name: 'agent tools', ok: withBash.length === 0, detail: withBash.length === 0
        ? 'no wrapper grants Bash'
        : `${withBash.length} wrapper(s) still grant Bash and can do the work ` +
          'themselves — run `sonata sync`, then restart Claude Code' }
    : {
        name: 'agent tools',
        ok: false,
        detail: `${stalePolling.length} wrapper(s) still call the removed run/tail ` +
          'tools and will fail mid-dispatch — run `sonata sync`, then restart Claude Code',
      });
```

Remove the old `withBash` push that this replaces.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/commands/doctor.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts tests/commands/doctor.test.ts
git commit -m "fix: doctor blocks on agents that still call run and tail"
```

---

### Task 9: Restore the CLI long-poll

**Files:**
- Modify: `src/cli.ts` (the `tail` command's `waitSeconds`)
- Test: `tests/commands/tail.test.ts`

**Interfaces:**
- Consumes: `SonataConfig['run']['tailWindowSeconds']`.
- Produces: nothing new.

Context: the MCP `tail` passed `waitSeconds: 0`, which is why the wrapper spun. That call site is gone with Task 5. The CLI has a smaller version of the same bug at `src/cli.ts:153`: it defaults to a hardcoded `'20'` rather than reading `tail_window_seconds`, so configuring the key does nothing unless `--wait` is passed on every call.

- [ ] **Step 1: Write the failing test**

Add a test that the resolved window comes from config. Extract the choice into a
pure function so it is testable without running the CLI — add to `src/cli.ts`:

```typescript
/**
 * `--wait` wins; otherwise the configured window. It used to default to a
 * hardcoded 20, so setting tail_window_seconds did nothing unless every call
 * also passed --wait.
 */
export function tailWaitSeconds(flag: string | undefined, configured: number): number {
  if (flag === undefined) return configured;
  const parsed = Number.parseInt(flag, 10);
  return Number.isFinite(parsed) ? parsed : configured;
}
```

Add to `tests/commands/tail.test.ts`:

```typescript
import { tailWaitSeconds } from '../../src/cli.js';

describe('tailWaitSeconds', () => {
  it('uses the configured window when --wait is absent', () => {
    expect(tailWaitSeconds(undefined, 45)).toBe(45);
  });

  it('lets --wait override it', () => {
    expect(tailWaitSeconds('5', 45)).toBe(5);
  });

  it('falls back to the configured window for a non-numeric flag', () => {
    expect(tailWaitSeconds('soon', 45)).toBe(45);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/tail.test.ts -t "tailWaitSeconds"`
Expected: FAIL — `tailWaitSeconds` is not exported from `src/cli.ts`

- [ ] **Step 3: Write minimal implementation**

Add the function above to `src/cli.ts`, then use it at the `tail` branch (`src/cli.ts:150-154`):

```typescript
    const res = await cmdTail({
      cwd: process.cwd(),
      id,
      waitSeconds: tailWaitSeconds(values.wait, loadConfig(process.cwd()).run.tailWindowSeconds),
    });
```

Import `loadConfig` from `./config.js` if `src/cli.ts` does not already.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/commands/tail.test.ts
git commit -m "fix: sonata tail long-polls for the configured window"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: Update CLAUDE.md**

- Architecture diagram: `mcp__sonata__run / tail / approve` → `mcp__sonata__dispatch / wait / approve`.
- The "three wrapper tools must be allow-listed" bullet: rename the tools, and keep the 2026-08-12 classifier story — it is why they are allow-listed at all.
- The "wrapper holds run, tail and approve" bullet: rename, and add why the polling tools were removed rather than merely discouraged.
- Add to Configuration: `dispatch_window_seconds = 1500  # blocking window; must stay under MCP's 30-minute stdio idle limit`.
- Known Limitations: rewrite the streaming bullet. The conversation still cannot be streamed, but `sonata tail` is no longer the wrapper's mechanism — `tmux attach -r -t sonata-<id>` and `sonata log <id>` are the live views.
- Commands list: `sonata tail` is now a human/debugging command, not part of the dispatch path.

- [ ] **Step 2: Update README.md**

- The commands table and any walkthrough naming `run`/`tail` as MCP tools.
- Troubleshooting: add a row — "Dispatch fails immediately after upgrading" → "Generated agents still name the removed `run`/`tail` tools. Run `sonata sync`, then restart Claude Code."
- The permission-modes text that mentions polling.

- [ ] **Step 3: Verify no stale references**

Run: `grep -rn 'mcp__sonata__run\|mcp__sonata__tail' --include='*.md' --include='*.ts' . | grep -v node_modules`
Expected: only `src/commands/doctor.ts` (which detects them on purpose) and its test.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: one-call dispatch replaces the polling loop"
```

---

### Task 11: Live verification

**Files:** none — this is a probe, per the repository rule that the real binary decides.

**Interfaces:**
- Consumes: the built `dist/`.

- [ ] **Step 1: Build and regenerate**

```bash
npm run build
node dist/cli.js sync
node dist/cli.js doctor
```

Expected: doctor reports `agent tools` ok. If it blocks, `sonata sync` did not rewrite every agent — fix that before continuing.

- [ ] **Step 2: Dispatch a real run through MCP**

In a scratch repo with a reasonix model configured, call the MCP server's `dispatch` tool directly over stdio (the `tests/mcp/server.test.ts` harness shows the JSON-RPC framing), with a task that takes at least a minute.

Expected: exactly one `dispatch` call returns `state: "DONE"` and a report carrying its `— sonata <id>:` provenance line. No `tail` calls anywhere.

- [ ] **Step 3: Verify the PAUSED path**

Same, with `permissionMode: default` and a write-capable role.

Expected: `dispatch` returns `PAUSED` with the prompt, `approve` answers it, `wait` returns `DONE`.

- [ ] **Step 4: Record what the probe showed**

Add anything surprising to `CLAUDE.md` as a comment or Known Limitation — especially if the idle window, `progressToken`, or result size behaved differently than the spec assumed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: record what a live one-call dispatch actually did"
```

---

## Notes for the executor

- **Task order matters.** Tasks 5–8 change the tool names together; between Task 5 and Task 7 the generated agents on disk are stale by construction. Do not stop in the middle and try a live dispatch.
- **`progressToken` is unverified.** The design deliberately does not depend on MCP progress notifications. If Task 11 shows Claude Code sends a `progressToken`, adding notifications is a follow-up, not part of this plan.
- **Do not reintroduce `tail` to the MCP surface** as a convenience. The whole point is that the expensive path cannot be chosen.
