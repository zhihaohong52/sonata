# sonata-loop Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `skills/loop/` into a Claude Code mod that draws a live side
panel showing the sonata-loop plan, each task's agents (as a tree), what each
agent is doing, the models the router served, and each agent's applied diffs.

**Architecture:** The skill folder becomes a plugin folder, which Claude Code
auto-loads from `.claude/skills/sonata-loop/`.
- **State:** all state logic is pure functions in `hooks/model.ts`, unit-tested
  with `claude plugin test`.
- **Hooks:** `hooks/register.tsx` wires engine events and the `sonata_loop`
  tool into those functions through `$.state` atoms. Every hook observes and
  then calls `next(e)`.
- **Drawing:** `hooks/panel.tsx` draws the pane.
- **Sonata side:** `sonata init` and `sonata sync` copy the whole folder; the
  router's session endpoint gains `role`, `tier` and `priceUsd` per route; and
  `doctor` reports the installed mod.

**Tech Stack:** TypeScript (Node 22, vitest) for sonata; the Claude Code mod
API (`claude-code`, `claude-code/testing`) for the mod.

**Spec:** `docs/superpowers/specs/2026-10-09-sonata-loop-panel-design.md`

## Global Constraints

- **Mod location:** the mod lives in `skills/loop/`. Its `plugin.json` `name`
  is `sonata-loop`.
- **Tool name:** the tool's registered name is `sonata_loop`, which the model
  sees as `mcp__sonata-loop__sonata_loop`.
- **Hooks never refuse:** no hook may answer `{ deny }` for an event it
  observes. Every hook calls and returns `next(e)`. Only the mod's own tool may
  return `{ deny }`, and only for validation errors.
- **Sonata agents:** a type counts as a sonata agent iff it matches
  `^(native-)?(code|review|explore|plan)(-|$)`.
- **Unknown is never zero.** A cost that can't be attributed shows as
  `unknown` or `≈`, never `$0`.
- **Diff bounds:** hunks are capped at 40 lines each, and each agent keeps its
  last 30 hunks.
- **Router polling:** every 3 s, only while an agent runs. The router URL
  defaults to `http://127.0.0.1:4100`, overridable by the `router_url` user
  option.
- **Test scope:** the mod's `.ts`/`.tsx` files sit outside the root `tsc` and
  vitest scope (`src/**`, `tests/**`). They are checked with
  `claude plugin validate skills/loop` and `claude plugin test skills/loop`,
  both run locally (CI has no `claude`).
- **Changelog:** entries go under `## [Unreleased]`. The release is a minor
  bump.
- **Committing:** stage explicit paths only, never `git add -A`.
- **Deviations from the spec:**
  - This Claude Code build has no `MultiEdit` tool, so diffs come from `Edit`
    and `Write` only.
  - There is no "not routed" label: the router's session endpoint answers an
    empty list both for an unrouted session and for a routed one with no
    requests yet, so the panel shows `?` until routes appear.
  - There is no per-row "panel error": when a hook or render throws, the
    engine skips that hook (or draws its own fallback) and logs one line.
    Every hook still calls `next(e)`, so the loop is never affected.

## Review Focus

1. **Two sonata agents on one alias at once.** The panel must show `≈` and no
   per-agent cost, never assign one agent's cost to another. Tested in Task 6.
2. **`start` called twice for the same task without a `result`** (a fix
   re-dispatch after an interrupted review). The second `start` must replace
   the pending phase, not error, and not double-attach agents. Tested in
   Task 3.
3. **An `Edit` with `replace_all` or a multi-line `old_string`.** The hunk
   shows every line, capped at 40, not just the first line. Tested in Task 5.
4. **A `Write` to a file the agent already edited.** It is shown as a new
   whole-file hunk, not merged into earlier hunks. Tested in Task 5.
5. **`/clear` mid-loop.** The panel empties, and a later `start` for an old
   task id is refused as unknown. Tested in Task 7.

---

### Task 1: Router session routes carry role, tier and price

**Files:**
- Modify: `src/commands/status.ts:55-110` (`RouteLine`, `recentRoutes`)
- Test: `tests/commands/status.test.ts`

**Interfaces:**
- Produces: `RouteLine` gains `role?: string; tier?: string; priceUsd?: number`.
  `priceUsd` is `row.price.totalUsd` when the row is priced, and is absent
  when it isn't (never 0 standing in for unpriced). `/__sonata/api/session/<id>`
  returns these unchanged.

- [ ] **Step 1: Write the failing test.** Append to `tests/commands/status.test.ts`:

```ts
import { recentRoutes } from '../../src/commands/status.js';

describe('recentRoutes for the loop panel', () => {
  const row = (over: Record<string, unknown>) => ({
    ts: '2026-10-09T03:00:00.000Z', ms: 10, alias: 'sonata-code-auto', upstream: 'litellm',
    status: 200, complete: true, tokens: { input: 1, output: 2 }, attempts: [], key: 'flash',
    role: 'code', tier: 'normal', price: { source: 'model', totalUsd: 0.0123 }, ...over,
  }) as never;

  it('carries role, tier and a priced row\'s cost', () => {
    const [line] = recentRoutes([row({})], 10);
    expect(line).toMatchObject({ role: 'code', tier: 'normal', priceUsd: 0.0123 });
  });

  it('leaves priceUsd absent for an unpriced row rather than 0', () => {
    const [line] = recentRoutes([row({ price: { source: 'none' } })], 10);
    expect(line.priceUsd).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run
  `npx vitest run tests/commands/status.test.ts`. Expected: FAIL, because
  `role` is undefined.

- [ ] **Step 3: Implement.** In `src/commands/status.ts`, add these fields to
  `interface RouteLine`, after `effort`:

```ts
  /** The tier alias's role and the tier it resolved to (an `-auto` alias's choice included). */
  role?: string;
  tier?: string;
  /** The row's priced cost; absent when unpriced, never 0 standing in for "not known". */
  priceUsd?: number;
```

  and in `recentRoutes`'s `.map`, after `effort: row.effort,`:

```ts
      role: row.role,
      tier: row.tier,
      priceUsd: 'totalUsd' in row.price ? row.price.totalUsd : undefined,
```

- [ ] **Step 4: Run the test, then typecheck.** Run
  `npx vitest run tests/commands/status.test.ts && npm run typecheck`.
  Expected: PASS, no errors.

- [ ] **Step 5: Commit.**

```bash
git add src/commands/status.ts tests/commands/status.test.ts
git commit -m "feat(ui): session routes carry role, tier and priced cost"
```

---

### Task 2: `init` and `sync` install the whole skill folder

**Files:**
- Create: `src/loop-skill.ts`
- Modify: `src/init/apply.ts:126-133`, `src/commands/sync.ts:636-668`, `package.json` (`files`)
- Test: `tests/loop-skill.test.ts`

**Interfaces:**
- Produces:
  - `loopSkillFiles(root: string): { rel: string; content: Buffer }[]`: every
    file under `<root>/skills/loop/`, except `*.test.ts` and
    `.claude-plugin/types/`, with relative paths in POSIX form, sorted.
  - `writeLoopSkill(dir: string, files: { rel: string; content: Buffer }[]): string[]`:
    writes each file atomically (temp file plus rename), creating directories,
    and skips a file whose content is unchanged. Returns the paths written.
  - `loopSkillSource(packageRoot: string): string`: `packageRoot` if it holds
    `skills/loop/SKILL.md`, else `process.cwd()`. This is the existing fallback
    in `apply.ts`.

- [ ] **Step 1: Write the failing test.** Create `tests/loop-skill.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loopSkillFiles, writeLoopSkill } from '../src/loop-skill.js';

function fakePackage(): string {
  const root = mkdtempSync(join(tmpdir(), 'loop-skill-'));
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, 'skills/loop', rel, '..'), { recursive: true });
    writeFileSync(join(root, 'skills/loop', rel), text);
  };
  put('SKILL.md', '# skill');
  put('.claude-plugin/plugin.json', '{"name":"sonata-loop"}');
  put('hooks/register.tsx', 'export const register = () => {}');
  put('hooks/model.test.ts', 'test');
  put('.claude-plugin/types/claude-code/index.d.ts', 'generated');
  return root;
}

describe('loop skill folder', () => {
  it('lists the plugin files and leaves out tests and generated types', () => {
    const rels = loopSkillFiles(fakePackage()).map((f) => f.rel);
    expect(rels).toEqual(['.claude-plugin/plugin.json', 'SKILL.md', 'hooks/register.tsx']);
  });

  it('writes the whole folder and skips unchanged files on a second write', () => {
    const files = loopSkillFiles(fakePackage());
    const dir = join(mkdtempSync(join(tmpdir(), 'loop-dest-')), 'sonata-loop');
    expect(writeLoopSkill(dir, files)).toHaveLength(3);
    expect(readFileSync(join(dir, 'hooks/register.tsx'), 'utf8')).toContain('register');
    expect(existsSync(join(dir, 'hooks/model.test.ts'))).toBe(false);
    expect(writeLoopSkill(dir, files)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run
  `npx vitest run tests/loop-skill.test.ts`. Expected: FAIL, because the module
  isn't found.

- [ ] **Step 3: Implement.** Create `src/loop-skill.ts`:

```ts
/**
 * The sonata-loop skill folder: the skill, and the mod Claude Code auto-loads
 * from a skills folder. Installed whole by `init`, refreshed whole by `sync`.
 * Tests and the engine's generated types are never copied.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export interface LoopSkillFile { rel: string; content: Buffer }

export function loopSkillSource(packageRoot: string): string {
  return existsSync(join(packageRoot, 'skills', 'loop', 'SKILL.md')) ? packageRoot : process.cwd();
}

export function loopSkillFiles(root: string): LoopSkillFile[] {
  const base = join(root, 'skills', 'loop');
  const out: LoopSkillFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(base, path).split(sep).join('/');
      if (rel === '.claude-plugin/types' || rel === 'node_modules') continue;
      if (entry.isDirectory()) walk(path);
      else if (!rel.endsWith('.test.ts')) out.push({ rel, content: readFileSync(path) });
    }
  };
  walk(base);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function writeLoopSkill(dir: string, files: LoopSkillFile[]): string[] {
  const written: string[] = [];
  for (const file of files) {
    const path = join(dir, file.rel);
    if (existsSync(path) && readFileSync(path).equals(file.content)) continue;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, file.content);
      renameSync(tmp, path);
      written.push(path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
  return written;
}
```

- [ ] **Step 4: Run the test.** Run `npx vitest run tests/loop-skill.test.ts`.
  Expected: PASS.

- [ ] **Step 5: Use it in `init`.** In `src/init/apply.ts`, replace the
  `// ---- skill ----` block (the lines from `mkdirSync(dirname(plan.skillPath)…`
  through `io.out(\`  ✓ installed loop skill…\`)`) with:

```ts
  // ---- skill ----
  // The whole folder: the skill and the mod Claude Code auto-loads from it.
  writeLoopSkill(dirname(plan.skillPath), loopSkillFiles(loopSkillSource(packageRoot)));
  io.out(`  ✓ installed loop skill and panel in ${dirname(plan.skillPath)}`);
```

  and add `import { loopSkillFiles, loopSkillSource, writeLoopSkill } from '../loop-skill.js';`.
  Remove any import that is now unused (the typecheck reports it).

- [ ] **Step 6: Use it in `sync`.** In `src/commands/sync.ts`, replace the body
  of `refreshLoopSkill` after the `root` line with:

```ts
  if (!existsSync(join(root, 'skills', 'loop', 'SKILL.md'))) return [];
  const files = loopSkillFiles(root);
  const dirs = [
    join(opts.cwd, '.claude', 'skills', 'sonata-loop'),
    ...(opts.home === undefined ? [] : [join(opts.home, '.claude', 'skills', 'sonata-loop')]),
  ];
  const refreshed: string[] = [];
  // Installing stays init's: a folder without SKILL.md was never installed.
  // A copy sonata cannot replace is left as it was rather than failing a sync
  // that has already written the agents.
  for (const dir of dirs) {
    if (!existsSync(join(dir, 'SKILL.md'))) continue;
    try {
      refreshed.push(...writeLoopSkill(dir, files));
    } catch {
      // left as it was
    }
  }
  return refreshed;
```

  and add `import { loopSkillFiles, writeLoopSkill } from '../loop-skill.js';`.

- [ ] **Step 7: Keep the mod's tests out of the npm tarball.** In
  `package.json` `files`, add `"!skills/loop/**/*.test.ts"` after `"skills"`.

- [ ] **Step 8: Run the existing init and sync suites, then typecheck.** Run
  `npx vitest run tests/init tests/commands/sync.test.ts tests/loop-skill.test.ts && npm run typecheck`.
  Expected: PASS. If an existing test asserts the old
  `✓ installed loop skill in <path>/SKILL.md` line, update its expectation to
  the new line, and only that.

- [ ] **Step 9: Commit.**

```bash
git add src/loop-skill.ts src/init/apply.ts src/commands/sync.ts package.json tests/loop-skill.test.ts tests/init tests/commands/sync.test.ts
git commit -m "feat(init): install and sync the whole sonata-loop skill folder"
```

---

### Task 3: Mod scaffold, state contract, and the loop model

**Files:**
- Create: `skills/loop/.claude-plugin/plugin.json`
- Create: `skills/loop/hooks/hooks.json`
- Create: `skills/loop/types/index.d.ts`
- Create: `skills/loop/hooks/model.ts`
- Create: `skills/loop/hooks/register.tsx` (a stub here; filled in Task 7)
- Test: `skills/loop/hooks/loop.test.ts`

**Interfaces:**
- Produces (in `types/index.d.ts`, imported as `'../types'`): the types `Tier`,
  `Phase`, `TaskState`, `LoopTask`, `Loop`, `AgentStatus`, `Hunk`, `AgentRow`,
  `RouteLine`, `RouterState` and `View`, plus `PluginState['sonata-loop']`.
- Produces (in `hooks/model.ts`):
  - `applyLoopAction(loop: Loop | null, input: unknown, now: number): { loop: Loop | null } | { error: string }`
  - `isSonataAgent(type: string): boolean`

- [ ] **Step 1: Write the manifest files.**

`skills/loop/.claude-plugin/plugin.json`:

```json
{
  "name": "sonata-loop",
  "version": "0.1.0",
  "description": "Live panel of a sonata-loop run: tasks, tier agents, served models and diffs",
  "types": "./types/index.d.ts",
  "userConfig": {
    "router_url": {
      "type": "string",
      "title": "sonata router URL",
      "description": "Where `sonata serve` answers; the machine router's port is 4100 unless [native.ports] says otherwise.",
      "default": "http://127.0.0.1:4100"
    }
  }
}
```

`skills/loop/hooks/hooks.json`:

```json
{ "modules": ["./register.tsx"] }
```

- [ ] **Step 2: Write the state contract.** Create `skills/loop/types/index.d.ts`:

```ts
export type Tier = 'simple' | 'normal' | 'complex'
export type Phase = 'code' | 'fix' | 'review' | 'final'
export type TaskState = 'pending' | 'coding' | 'fixing' | 'review' | 'done'

export type LoopTask = {
  id: string
  title: string
  state: TaskState
  failures: number
  escalatedTo?: Tier
  /** The phase of the last `start`, until its `result`. */
  openPhase?: Phase
  agentIds: string[]
}

export type Loop = {
  title: string
  tasks: LoopTask[]
  /** Set by `start`; the next top-level sonata spawn attaches here. */
  pendingTaskId?: string
  isDone: boolean
  summary?: string
  startedAt: number
}

export type AgentStatus = 'running' | 'done' | 'aborted' | 'error'

export type Hunk = {
  file: string
  removed: string[]
  added: string[]
  /** Lines cut by the 40-line cap. */
  omitted: number
  isNewFile: boolean
}

export type AgentRow = {
  id: string
  type: string
  description: string
  parentId?: string
  taskId?: string
  status: AgentStatus
  activity?: string
  steps: number
  /** The model alias its requests name (`sonata-code-auto`). */
  alias?: string
  /** Epoch ms of each `turn.step`, for matching router routes. */
  stepTimes: number[]
  usedBash: boolean
  hunks: Hunk[]
  startedAt: number
  endedAt?: number
}

export type RouteLine = {
  alias: string
  served?: string
  status: number
  ts?: string
  role?: string
  tier?: string
  priceUsd?: number
}

export type RouterState = { routes: RouteLine[]; error?: string }

export type View = { selected?: string; showAll: boolean; expanded: string[] }

declare module 'claude-code' {
  interface PluginState {
    'sonata-loop': {
      loop: Loop | null
      agents: AgentRow[]
      router: RouterState
      view: View
    }
  }
}
```

- [ ] **Step 3: Write the failing test.** Create `skills/loop/hooks/loop.test.ts`:

```ts
import { test, expect } from 'claude-code/testing'
import { applyLoopAction, isSonataAgent } from './model'
import type { Loop } from '../types'

const planned = (): Loop => {
  const r = applyLoopAction(null, { action: 'plan', title: 'auth', tasks: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }] }, 0)
  if ('error' in r || r.loop === null) throw new Error('plan failed')
  return r.loop
}
const ok = (r: ReturnType<typeof applyLoopAction>): Loop => {
  if ('error' in r) throw new Error(r.error)
  return r.loop!
}

test('plan creates pending tasks', () => {
  expect(planned().tasks.map(t => t.state)).toEqual(['pending', 'pending'])
})

test('start, failing result, fix, passing result', () => {
  let loop = ok(applyLoopAction(planned(), { action: 'start', taskId: '1', phase: 'code' }, 1))
  expect(loop.tasks[0].state).toBe('coding')
  expect(loop.pendingTaskId).toBe('1')
  loop = ok(applyLoopAction(loop, { action: 'start', taskId: '1', phase: 'review' }, 2))
  loop = ok(applyLoopAction(loop, { action: 'result', taskId: '1', outcome: 'fail' }, 3))
  expect(loop.tasks[0]).toMatchObject({ failures: 1, openPhase: undefined })
  loop = ok(applyLoopAction(loop, { action: 'start', taskId: '1', phase: 'fix' }, 4))
  expect(loop.tasks[0].state).toBe('fixing')
  loop = ok(applyLoopAction(loop, { action: 'start', taskId: '1', phase: 'review' }, 5))
  loop = ok(applyLoopAction(loop, { action: 'result', taskId: '1', outcome: 'pass' }, 6))
  expect(loop.tasks[0].state).toBe('done')
})

test('a second start without a result replaces the open phase', () => {
  let loop = ok(applyLoopAction(planned(), { action: 'start', taskId: '1', phase: 'review' }, 1))
  loop = ok(applyLoopAction(loop, { action: 'start', taskId: '1', phase: 'fix' }, 2))
  expect(loop.tasks[0]).toMatchObject({ state: 'fixing', openPhase: 'fix' })
})

test('escalate and done', () => {
  let loop = ok(applyLoopAction(planned(), { action: 'escalate', taskId: '2', to: 'complex' }, 1))
  expect(loop.tasks[1].escalatedTo).toBe('complex')
  loop = ok(applyLoopAction(loop, { action: 'done', summary: 'shipped' }, 2))
  expect(loop).toMatchObject({ isDone: true, summary: 'shipped' })
})

test('validation errors', () => {
  const loop = planned()
  expect(applyLoopAction(loop, { action: 'start', taskId: '9', phase: 'code' }, 1)).toEqual({ error: 'unknown taskId "9"; the plan has 1, 2' })
  expect(applyLoopAction(loop, { action: 'result', taskId: '1', outcome: 'pass' }, 1)).toEqual({ error: 'result for task "1" with no start before it' })
  expect(applyLoopAction(loop, { action: 'plan', title: 'x', tasks: [] }, 1)).toEqual({ error: 'a loop is already running; call done first' })
  expect(applyLoopAction(null, { action: 'start', taskId: '1', phase: 'code' }, 1)).toEqual({ error: 'no loop: call plan first' })
  expect(applyLoopAction(loop, { action: 'jump' }, 1)).toEqual({ error: 'unknown action "jump"; expected plan, start, result, escalate or done' })
  expect(applyLoopAction(loop, { action: 'start', taskId: '1', phase: 'deploy' }, 1)).toEqual({ error: 'phase must be code, fix, review or final' })
  expect(applyLoopAction(null, { action: 'plan', title: 'x', tasks: [{ id: '1', title: 'a' }, { id: '1', title: 'b' }] }, 1)).toEqual({ error: 'duplicate task id "1"' })
})

test('sonata agent matcher', () => {
  for (const t of ['code-simple', 'review-auto', 'plan', 'native-explore-normal']) expect(isSonataAgent(t)).toBe(true)
  for (const t of ['general-purpose', 'Explore', 'coder', 'planner']) expect(isSonataAgent(t)).toBe(false)
})
```

- [ ] **Step 4: Write a stub `register.tsx` so the plugin loads.**

```tsx
import type { Register } from 'claude-code'

export const register: Register = () => {}
```

- [ ] **Step 5: Run the test and confirm it fails.** Run
  `claude plugin test skills/loop`. Expected: FAIL, because `./model` isn't
  found. If instead the runner refuses a relative import between plugin files,
  stop and report it: Tasks 4–6 depend on that import.

- [ ] **Step 6: Implement `skills/loop/hooks/model.ts`, part 1.**

```ts
import type { Loop, LoopTask, Phase, Tier } from '../types'

const SONATA_AGENT = /^(native-)?(code|review|explore|plan)(-|$)/
export const isSonataAgent = (type: string): boolean => SONATA_AGENT.test(type)

const PHASES: readonly Phase[] = ['code', 'fix', 'review', 'final']
const TIERS: readonly Tier[] = ['simple', 'normal', 'complex']
const STATE_FOR: Record<Phase, LoopTask['state']> = { code: 'coding', fix: 'fixing', review: 'review', final: 'review' }

type Result = { loop: Loop | null } | { error: string }
const str = (v: unknown): v is string => typeof v === 'string' && v !== ''

export function applyLoopAction(loop: Loop | null, input: unknown, now: number): Result {
  const a = (input ?? {}) as Record<string, unknown>
  if (a.action === 'plan') {
    if (loop !== null && !loop.isDone) return { error: 'a loop is already running; call done first' }
    if (!str(a.title) || !Array.isArray(a.tasks)) return { error: 'plan needs title and tasks: [{ id, title }]' }
    const seen = new Set<string>()
    const tasks: LoopTask[] = []
    for (const t of a.tasks as Record<string, unknown>[]) {
      if (!str(t?.id) || !str(t?.title)) return { error: 'each task needs a string id and title' }
      if (seen.has(t.id)) return { error: `duplicate task id "${t.id}"` }
      seen.add(t.id)
      tasks.push({ id: t.id, title: t.title, state: 'pending', failures: 0, agentIds: [] })
    }
    return { loop: { title: a.title, tasks, isDone: false, startedAt: now } }
  }
  if (!['start', 'result', 'escalate', 'done'].includes(String(a.action))) {
    return { error: `unknown action "${String(a.action)}"; expected plan, start, result, escalate or done` }
  }
  if (loop === null || loop.isDone) return { error: 'no loop: call plan first' }
  if (a.action === 'done') return { loop: { ...loop, isDone: true, summary: str(a.summary) ? a.summary : undefined, pendingTaskId: undefined } }

  const task = loop.tasks.find(t => t.id === a.taskId)
  if (task === undefined) return { error: `unknown taskId "${String(a.taskId)}"; the plan has ${loop.tasks.map(t => t.id).join(', ')}` }
  const put = (next: LoopTask, extra: Partial<Loop> = {}): Result =>
    ({ loop: { ...loop, ...extra, tasks: loop.tasks.map(t => (t.id === next.id ? next : t)) } })

  if (a.action === 'start') {
    if (!PHASES.includes(a.phase as Phase)) return { error: 'phase must be code, fix, review or final' }
    const phase = a.phase as Phase
    return put({ ...task, state: STATE_FOR[phase], openPhase: phase }, { pendingTaskId: task.id })
  }
  if (a.action === 'result') {
    if (task.openPhase === undefined) return { error: `result for task "${task.id}" with no start before it` }
    if (a.outcome !== 'pass' && a.outcome !== 'fail') return { error: 'outcome must be pass or fail' }
    if (a.outcome === 'fail') return put({ ...task, failures: task.failures + 1, openPhase: undefined })
    const isReview = task.openPhase === 'review' || task.openPhase === 'final'
    return put({ ...task, state: isReview ? 'done' : task.state, openPhase: undefined })
  }
  if (!TIERS.includes(a.to as Tier)) return { error: 'to must be simple, normal or complex' }
  return put({ ...task, escalatedTo: a.to as Tier })
}
```

- [ ] **Step 7: Run the tests and validate.** Run
  `claude plugin test skills/loop && claude plugin validate skills/loop`.
  Expected: every test in `loop.test.ts` passes, and validate reports no
  errors.

- [ ] **Step 8: Commit.**

```bash
git add skills/loop/.claude-plugin/plugin.json skills/loop/hooks/hooks.json skills/loop/types/index.d.ts skills/loop/hooks/model.ts skills/loop/hooks/register.tsx skills/loop/hooks/loop.test.ts
git commit -m "feat(loop-panel): mod scaffold, state contract and the loop model"
```

---

### Task 4: The agent tree model

**Files:**
- Modify: `skills/loop/hooks/model.ts` (append)
- Test: `skills/loop/hooks/agents.test.ts`

**Interfaces:**
- Consumes: the `Loop`, `AgentRow` and `isSonataAgent` from Task 3.
- Produces:
  - `spawnAgent(s: { loop: Loop | null; agents: AgentRow[] }, e: { agentId: string; subagentType: string; description: string; parentAgentId?: string }, now: number): { loop: Loop | null; agents: AgentRow[] }`
  - `stepAgent(agents: AgentRow[], e: { agentId: string; model: string }, now: number): AgentRow[]`
  - `toolActivity(agents: AgentRow[], e: { agentId: string; tool: string; input: Record<string, unknown> }): AgentRow[]`
  - `completeAgent(agents: AgentRow[], e: { agentId: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }, now: number): AgentRow[]`
  - `childrenOf(agents: AgentRow[], id: string | undefined): AgentRow[]`
  - `depthOf(agents: AgentRow[], id: string): number`

- [ ] **Step 1: Write the failing test.** Create `skills/loop/hooks/agents.test.ts`:

```ts
import { test, expect } from 'claude-code/testing'
import { applyLoopAction, spawnAgent, stepAgent, toolActivity, completeAgent, childrenOf, depthOf } from './model'
import type { Loop, AgentRow } from '../types'

const started = (): Loop => {
  const p = applyLoopAction(null, { action: 'plan', title: 't', tasks: [{ id: '1', title: 'A' }] }, 0) as { loop: Loop }
  return (applyLoopAction(p.loop, { action: 'start', taskId: '1', phase: 'code' }, 1) as { loop: Loop }).loop
}

test('a top-level sonata spawn attaches to the pending task and clears it', () => {
  const s = spawnAgent({ loop: started(), agents: [] }, { agentId: 'a1', subagentType: 'code-normal', description: 'do A' }, 5)
  expect(s.agents[0]).toMatchObject({ id: 'a1', taskId: '1', status: 'running', steps: 0 })
  expect(s.loop!.pendingTaskId).toBeUndefined()
  expect(s.loop!.tasks[0].agentIds).toEqual(['a1'])
})

test('a child joins its parent\'s task, not the pending one', () => {
  let s = spawnAgent({ loop: started(), agents: [] }, { agentId: 'a1', subagentType: 'code-complex', description: 'A' }, 5)
  s = { ...s, loop: (applyLoopAction(s.loop, { action: 'start', taskId: '1', phase: 'review' }, 6) as { loop: Loop }).loop }
  s = spawnAgent(s, { agentId: 'c1', subagentType: 'code-simple', description: 'part', parentAgentId: 'a1' }, 7)
  expect(s.agents.find(a => a.id === 'c1')).toMatchObject({ parentId: 'a1', taskId: '1' })
  expect(s.loop!.pendingTaskId).toBe('1')
  expect(childrenOf(s.agents, 'a1').map(a => a.id)).toEqual(['c1'])
  expect(depthOf(s.agents, 'c1')).toBe(1)
})

test('unplanned and non-sonata spawns', () => {
  const s1 = spawnAgent({ loop: null, agents: [] }, { agentId: 'u', subagentType: 'explore-simple', description: 'x' }, 1)
  expect(s1.agents[0].taskId).toBeUndefined()
  const s2 = spawnAgent({ loop: null, agents: [] }, { agentId: 'g', subagentType: 'general-purpose', description: 'x' }, 1)
  expect(s2.agents).toEqual([])
})

test('a child of a non-sonata parent is still tracked, with no task', () => {
  const s = spawnAgent({ loop: started(), agents: [] }, { agentId: 'c', subagentType: 'code-simple', description: 'x', parentAgentId: 'gp' }, 1)
  expect(s.agents[0]).toMatchObject({ parentId: 'gp', taskId: undefined })
  expect(s.loop!.pendingTaskId).toBe('1')
})

test('steps, activity and completion', () => {
  let agents: AgentRow[] = spawnAgent({ loop: null, agents: [] }, { agentId: 'a', subagentType: 'code-simple', description: 'x' }, 0).agents
  agents = stepAgent(agents, { agentId: 'a', model: 'sonata-code-simple' }, 10)
  agents = toolActivity(agents, { agentId: 'a', tool: 'Edit', input: { file_path: '/r/src/q.ts' } })
  expect(agents[0]).toMatchObject({ steps: 1, alias: 'sonata-code-simple', stepTimes: [10], activity: 'Edit q.ts' })
  agents = toolActivity(agents, { agentId: 'a', tool: 'Bash', input: { command: 'sed -i s/a/b/ x' } })
  expect(agents[0]).toMatchObject({ activity: 'Bash sed', usedBash: true })
  agents = completeAgent(agents, { agentId: 'a', reason: 'aborted' }, 20)
  expect(agents[0]).toMatchObject({ status: 'aborted', endedAt: 20, activity: undefined })
  expect(stepAgent(agents, { agentId: 'zzz', model: 'm' }, 1)).toBe(agents)
})
```

- [ ] **Step 2: Run it and confirm it fails.** Run
  `claude plugin test skills/loop`. Expected: `agents.test.ts` fails because
  `spawnAgent` is not exported.

- [ ] **Step 3: Implement.** Append to `skills/loop/hooks/model.ts`:

```ts
import type { AgentRow } from '../types'

type Tracked = { loop: Loop | null; agents: AgentRow[] }

export function spawnAgent(
  s: Tracked,
  e: { agentId: string; subagentType: string; description: string; parentAgentId?: string },
  now: number,
): Tracked {
  if (!isSonataAgent(e.subagentType)) return s
  const parent = e.parentAgentId === undefined ? undefined : s.agents.find(a => a.id === e.parentAgentId)
  // A child belongs to its parent's task; only a top-level spawn takes the pending one.
  const taskId = e.parentAgentId !== undefined ? parent?.taskId : s.loop?.pendingTaskId
  const row: AgentRow = {
    id: e.agentId, type: e.subagentType, description: e.description, parentId: e.parentAgentId,
    taskId, status: 'running', steps: 0, stepTimes: [], usedBash: false, hunks: [], startedAt: now,
  }
  let loop = s.loop
  if (loop !== null && taskId !== undefined) {
    loop = {
      ...loop,
      pendingTaskId: e.parentAgentId === undefined ? undefined : loop.pendingTaskId,
      tasks: loop.tasks.map(t => (t.id === taskId ? { ...t, agentIds: [...t.agentIds, e.agentId] } : t)),
    }
  }
  return { loop, agents: [...s.agents, row] }
}

const patch = (agents: AgentRow[], id: string, fn: (a: AgentRow) => AgentRow): AgentRow[] =>
  agents.some(a => a.id === id) ? agents.map(a => (a.id === id ? fn(a) : a)) : agents

export const stepAgent = (agents: AgentRow[], e: { agentId: string; model: string }, now: number): AgentRow[] =>
  patch(agents, e.agentId, a => ({ ...a, steps: a.steps + 1, alias: e.model, stepTimes: [...a.stepTimes, now].slice(-200) }))

const base = (p: string): string => p.split('/').pop() ?? p

function describeCall(tool: string, input: Record<string, unknown>): string {
  const s = (k: string): string | undefined => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const target = s('file_path') ? base(s('file_path')!)
    : s('pattern') ?? s('path') ?? (s('command')?.trim().split(/\s+/)[0]) ?? s('description')
  return target === undefined ? tool : `${tool} ${target}`
}

export const toolActivity = (agents: AgentRow[], e: { agentId: string; tool: string; input: Record<string, unknown> }): AgentRow[] =>
  patch(agents, e.agentId, a => ({ ...a, activity: describeCall(e.tool, e.input), usedBash: a.usedBash || e.tool === 'Bash' }))

export const completeAgent = (agents: AgentRow[], e: { agentId: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }, now: number): AgentRow[] =>
  patch(agents, e.agentId, a => ({
    ...a, activity: undefined, endedAt: now,
    status: e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error',
  }))

export const childrenOf = (agents: AgentRow[], id: string | undefined): AgentRow[] =>
  agents.filter(a => a.parentId === id)

export function depthOf(agents: AgentRow[], id: string): number {
  let depth = 0
  let cur = agents.find(a => a.id === id)
  while (cur?.parentId !== undefined && depth < 32) {
    cur = agents.find(a => a.id === cur!.parentId)
    if (cur === undefined) break
    depth++
  }
  return depth
}
```

Move the new `import type { AgentRow }` into the existing `import type` line at the top of the file.

- [ ] **Step 4: Run the tests.** Run `claude plugin test skills/loop`.
  Expected: all tests pass.

- [ ] **Step 5: Commit.**

```bash
git add skills/loop/hooks/model.ts skills/loop/hooks/agents.test.ts
git commit -m "feat(loop-panel): agent tree, activity and completion model"
```

---

### Task 5: Diff capture

**Files:**
- Modify: `skills/loop/hooks/model.ts` (append)
- Test: `skills/loop/hooks/diff.test.ts`

**Interfaces:**
- Produces:
  - `hunksFor(tool: string, input: Record<string, unknown>): Hunk[]`: returns
    `[]` for any tool other than `Edit` or `Write`.
  - `addHunks(agents: AgentRow[], agentId: string, hunks: Hunk[]): AgentRow[]`:
    keeps the last 30 hunks.
  - `diffStat(hunks: Hunk[]): { added: number; removed: number; files: number }`
  - `HUNK_LINES = 40`, `MAX_HUNKS = 30`

- [ ] **Step 1: Write the failing test.** Create `skills/loop/hooks/diff.test.ts`:

```ts
import { test, expect } from 'claude-code/testing'
import { hunksFor, addHunks, diffStat, spawnAgent, HUNK_LINES, MAX_HUNKS } from './model'

test('an Edit becomes one hunk with every line of both sides', () => {
  const [h] = hunksFor('Edit', { file_path: '/r/a.ts', old_string: 'x\ny', new_string: 'x\ny\nz', replace_all: true })
  expect(h).toEqual({ file: '/r/a.ts', removed: ['x', 'y'], added: ['x', 'y', 'z'], omitted: 0, isNewFile: false })
})

test('a Write is a whole-file hunk, capped at 40 lines', () => {
  const content = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n')
  const [h] = hunksFor('Write', { file_path: '/r/b.ts', content })
  expect(h.isNewFile).toBe(true)
  expect(h.added).toHaveLength(HUNK_LINES)
  expect(h.omitted).toBe(60)
})

test('other tools and malformed input give no hunk', () => {
  expect(hunksFor('Read', { file_path: '/r/a.ts' })).toEqual([])
  expect(hunksFor('Edit', { file_path: '/r/a.ts' })).toEqual([])
})

test('an agent keeps its last 30 hunks, and a Write after an Edit stays separate', () => {
  let agents = spawnAgent({ loop: null, agents: [] }, { agentId: 'a', subagentType: 'code-simple', description: 'x' }, 0).agents
  for (let i = 0; i < 35; i++) agents = addHunks(agents, 'a', hunksFor('Edit', { file_path: `/r/${i}.ts`, old_string: 'a', new_string: 'b' }))
  agents = addHunks(agents, 'a', hunksFor('Write', { file_path: '/r/34.ts', content: 'new' }))
  expect(agents[0].hunks).toHaveLength(MAX_HUNKS)
  expect(agents[0].hunks.at(-1)).toMatchObject({ file: '/r/34.ts', isNewFile: true })
  expect(agents[0].hunks.at(-2)).toMatchObject({ file: '/r/34.ts', isNewFile: false })
  expect(diffStat(agents[0].hunks)).toEqual({ added: 30, removed: 29, files: 30 })
})
```

- [ ] **Step 2: Run it and confirm it fails.** Run
  `claude plugin test skills/loop`. Expected: `diff.test.ts` fails because
  `hunksFor` is not exported.

- [ ] **Step 3: Implement.** Append to `skills/loop/hooks/model.ts`, and add
  `Hunk` to the top-level `import type`:

```ts
export const HUNK_LINES = 40
export const MAX_HUNKS = 30

function capped(file: string, removed: string[], added: string[], isNewFile: boolean): Hunk {
  const keepRemoved = removed.slice(0, HUNK_LINES)
  const keepAdded = added.slice(0, Math.max(0, HUNK_LINES - keepRemoved.length) || HUNK_LINES)
  const omitted = removed.length - keepRemoved.length + added.length - keepAdded.length
  return { file, removed: keepRemoved, added: keepAdded, omitted, isNewFile }
}

export function hunksFor(tool: string, input: Record<string, unknown>): Hunk[] {
  const file = input.file_path
  if (typeof file !== 'string') return []
  if (tool === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return [capped(file, input.old_string.split('\n'), input.new_string.split('\n'), false)]
  }
  if (tool === 'Write' && typeof input.content === 'string') {
    return [capped(file, [], input.content.split('\n'), true)]
  }
  return []
}

export const addHunks = (agents: AgentRow[], agentId: string, hunks: Hunk[]): AgentRow[] =>
  hunks.length === 0 ? agents : patch(agents, agentId, a => ({ ...a, hunks: [...a.hunks, ...hunks].slice(-MAX_HUNKS) }))

export function diffStat(hunks: Hunk[]): { added: number; removed: number; files: number } {
  const files = new Set(hunks.map(h => h.file))
  return {
    added: hunks.reduce((n, h) => n + h.added.length, 0),
    removed: hunks.reduce((n, h) => n + h.removed.length, 0),
    files: files.size,
  }
}
```

  `capped` gives a Write's whole 40-line budget to added lines. For an Edit,
  removed lines are kept first and added lines get the rest of the 40, or the
  full 40 when removed already used it all, so a large replacement still shows
  its new side.

- [ ] **Step 4: Run the tests.** Run `claude plugin test skills/loop`.
  Expected: all tests pass.

- [ ] **Step 5: Commit.**

```bash
git add skills/loop/hooks/model.ts skills/loop/hooks/diff.test.ts
git commit -m "feat(loop-panel): capture applied Edit/Write hunks with caps"
```

---

### Task 6: Model and cost attribution

**Files:**
- Modify: `skills/loop/hooks/model.ts` (append)
- Test: `skills/loop/hooks/attribution.test.ts`

**Interfaces:**
- Consumes: `AgentRow.alias` and `stepTimes` (Task 4), and `RouteLine`
  (Task 1's fields, mirrored in `types/index.d.ts`).
- Produces:
  - `attribute(agents: AgentRow[], routes: RouteLine[], agentId: string): Attribution`
  - `taskCost(agents: AgentRow[], routes: RouteLine[], ids: string[]): { usd: number; isPartial: boolean }`
  - `export type Attribution = { served: string[]; tier?: string; usd?: number; isExact: boolean }`

  Matching rule: a route belongs to an agent when its `alias` equals the
  agent's alias and its `ts` falls within 120 s after one of the agent's
  `stepTimes`. The match is exact when no other agent with the same alias was
  running during that route's time window. An ambiguous match yields `served`
  (deduplicated) but `usd: undefined` and `isExact: false`.

- [ ] **Step 1: Write the failing test.** Create `skills/loop/hooks/attribution.test.ts`:

```ts
import { test, expect } from 'claude-code/testing'
import { attribute, taskCost } from './model'
import type { AgentRow, RouteLine } from '../types'

const agent = (id: string, startedAt: number, endedAt: number | undefined, steps: number[]): AgentRow => ({
  id, type: 'code-simple', description: id, status: endedAt ? 'done' : 'running', steps: steps.length,
  alias: 'sonata-code-simple', stepTimes: steps, usedBash: false, hunks: [], startedAt, endedAt,
})
const route = (ms: number, served: string, priceUsd?: number): RouteLine =>
  ({ alias: 'sonata-code-simple', served, status: 200, ts: new Date(ms).toISOString(), tier: 'simple', priceUsd })

test('one agent on the alias: exact model, tier and cost', () => {
  const agents = [agent('a', 0, 50_000, [1_000, 20_000])]
  const routes = [route(2_000, 'flash', 0.01), route(21_000, 'flash', 0.02)]
  expect(attribute(agents, routes, 'a')).toEqual({ served: ['flash'], tier: 'simple', usd: 0.03, isExact: true })
})

test('two concurrent agents on one alias: models shown, no cost assigned', () => {
  const agents = [agent('a', 0, undefined, [1_000]), agent('b', 500, undefined, [1_200])]
  const routes = [route(2_000, 'flash', 0.01), route(2_100, 'kimi', 0.05)]
  expect(attribute(agents, routes, 'a')).toEqual({ served: ['flash', 'kimi'], tier: 'simple', usd: undefined, isExact: false })
  expect(taskCost(agents, routes, ['a', 'b'])).toEqual({ usd: 0, isPartial: true })
})

test('an unpriced route makes the agent cost unknown, not 0', () => {
  const agents = [agent('a', 0, 10_000, [1_000])]
  expect(attribute(agents, [route(2_000, 'flash')], 'a').usd).toBeUndefined()
  expect(taskCost(agents, [route(2_000, 'flash')], ['a'])).toEqual({ usd: 0, isPartial: true })
})

test('no routes (router unreachable): nothing served, cost unknown', () => {
  expect(attribute([agent('a', 0, undefined, [1_000])], [], 'a')).toEqual({ served: [], tier: undefined, usd: undefined, isExact: false })
})
```

- [ ] **Step 2: Run it and confirm it fails.** Run
  `claude plugin test skills/loop`. Expected: `attribution.test.ts` fails
  because `attribute` is not exported.

- [ ] **Step 3: Implement.** Append to `skills/loop/hooks/model.ts`, and add
  `RouteLine` to the top `import type`:

```ts
export type Attribution = { served: string[]; tier?: string; usd?: number; isExact: boolean }

const WINDOW_MS = 120_000

function routesOf(agent: AgentRow, routes: RouteLine[]): RouteLine[] {
  return routes.filter(r => {
    if (r.alias !== agent.alias || r.ts === undefined) return false
    const at = Date.parse(r.ts)
    return agent.stepTimes.some(t => at >= t && at - t <= WINDOW_MS)
  })
}

function isShared(agents: AgentRow[], agent: AgentRow, at: number): boolean {
  return agents.some(o => o.id !== agent.id && o.alias === agent.alias &&
    o.startedAt <= at && (o.endedAt === undefined || o.endedAt >= at - WINDOW_MS))
}

export function attribute(agents: AgentRow[], routes: RouteLine[], agentId: string): Attribution {
  const agent = agents.find(a => a.id === agentId)
  if (agent === undefined) return { served: [], tier: undefined, usd: undefined, isExact: false }
  const mine = routesOf(agent, routes)
  const served = [...new Set(mine.map(r => r.served).filter((s): s is string => s !== undefined))]
  const tier = mine.find(r => r.tier !== undefined)?.tier
  if (mine.length === 0) return { served, tier, usd: undefined, isExact: false }
  const isExact = !mine.some(r => isShared(agents, agent, Date.parse(r.ts!)))
  const isPriced = mine.every(r => r.priceUsd !== undefined)
  const usd = isExact && isPriced ? mine.reduce((n, r) => n + r.priceUsd!, 0) : undefined
  return { served, tier, usd, isExact }
}

export function taskCost(agents: AgentRow[], routes: RouteLine[], ids: string[]): { usd: number; isPartial: boolean } {
  let usd = 0
  let isPartial = false
  for (const id of ids) {
    const a = attribute(agents, routes, id)
    if (a.usd === undefined) isPartial = true
    else usd += a.usd
  }
  return { usd, isPartial }
}
```

- [ ] **Step 4: Run the tests.** Run `claude plugin test skills/loop`.
  Expected: all tests pass.

- [ ] **Step 5: Commit.**

```bash
git add skills/loop/hooks/model.ts skills/loop/hooks/attribution.test.ts
git commit -m "feat(loop-panel): attribute served models and cost, ambiguity shown"
```

---

### Task 7: Wire the hooks, the tool and router polling

**Files:**
- Modify: `skills/loop/hooks/register.tsx` (replace the stub)
- Test: `skills/loop/hooks/register.test.ts`

**Interfaces:**
- Consumes: every export of `model.ts` (Tasks 3–6).
- Produces:
  - atoms keyed `{ plugin: 'sonata-loop', key: 'loop' | 'agents' | 'router' | 'view' }`;
  - the tool `mcp__sonata-loop__sonata_loop`;
  - the command `/sonata-loop`;
  - the pane id `sonata-loop`.

  Task 8 draws from these atoms.

- [ ] **Step 1: Write the failing test.** Create `skills/loop/hooks/register.test.ts`:

```ts
import { test, expect } from 'claude-code/testing'

const TOOL = 'mcp__sonata-loop__sonata_loop'

test('the tool validates and records the plan', async ($, on) => {
  on('ui.open', () => ({ isPlaced: true }))
  const bad = await $.tool.call({ tool: TOOL, input: { action: 'start', taskId: '1', phase: 'code' } })
  expect('deny' in bad ? bad.deny : bad.text).toMatch(/call plan first/)
  const good = await $.tool.call({ tool: TOOL, input: { action: 'plan', title: 't', tasks: [{ id: '1', title: 'A' }] } })
  expect('text' in good ? good.text : '').toMatch(/1 task/)
  const loop = await $.state.get({ plugin: 'sonata-loop', key: 'loop' })
  expect(loop?.tasks[0].id).toBe('1')
})

test('/clear empties the panel', async ($, on) => {
  on('ui.open', () => ({ isPlaced: true }))
  await $.tool.call({ tool: TOOL, input: { action: 'plan', title: 't', tasks: [{ id: '1', title: 'A' }] } })
  await $.session.end({ reason: 'clear' })
  expect(await $.state.get({ plugin: 'sonata-loop', key: 'loop' })).toBeNull()
  const after = await $.tool.call({ tool: TOOL, input: { action: 'start', taskId: '1', phase: 'code' } })
  expect('deny' in after ? after.deny : after.text).toMatch(/call plan first/)
})
```

  `$.state.get`, `$.session.end` and the `ui.open` answer are the kit's
  surface. If the typings in `.claude-plugin/types/claude-code/index.d.ts`
  spell these differently, use the typings' spelling and keep the assertions.

- [ ] **Step 2: Run it and confirm it fails.** Run
  `claude plugin test skills/loop`. Expected: `register.test.ts` fails because
  no hook answers the tool.

- [ ] **Step 3: Implement.** Replace `skills/loop/hooks/register.tsx`:

```tsx
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { AgentRow, Loop, RouterState, View } from '../types'
import { addHunks, applyLoopAction, completeAgent, hunksFor, spawnAgent, stepAgent, toolActivity } from './model'
import { drawPanel } from './panel'

const PLUGIN = 'sonata-loop'
const PANE = 'sonata-loop'
const TOOL = `mcp__${PLUGIN}__sonata_loop`

export const loopAtom = atom({ plugin: PLUGIN, key: 'loop' } as const, null as Loop | null)
export const agentsAtom = atom({ plugin: PLUGIN, key: 'agents' } as const, [] as AgentRow[])
export const routerAtom = atom({ plugin: PLUGIN, key: 'router' } as const, { routes: [] } as RouterState)
export const viewAtom = atom({ plugin: PLUGIN, key: 'view' } as const, { showAll: true, expanded: [] } as View)

const TOOL_DESCRIPTION = [
  'Report sonata-loop progress to the loop panel. Call it at each loop step:',
  'plan {title, tasks:[{id,title}]} after planning; start {taskId, phase: code|fix|review|final}',
  'right before each dispatch; result {taskId, outcome: pass|fail, note?} after each review;',
  'escalate {taskId, to: simple|normal|complex}; done {summary?} at the end.',
].join(' ')

export const register: Register = (on, options) => {
  const routerUrl = String((options as { router_url?: string } | undefined)?.router_url ?? 'http://127.0.0.1:4100')
  let polling = false

  async function poll($: Parameters<Parameters<typeof on>[1]>[0]): Promise<void> {
    if (polling) return
    polling = true
    try {
      while ((await read($, agentsAtom)).some(a => a.status === 'running')) {
        const session = await $.session.id()
        try {
          const res = await $.http.fetch(`${routerUrl}/__sonata/api/session/${encodeURIComponent(session)}`)
          const body = res.ok ? (JSON.parse(res.text) as { routes?: RouterState['routes'] }) : undefined
          await update($, routerAtom, () => body?.routes === undefined
            ? { routes: [], error: `router answered ${res.status}` }
            : { routes: body.routes })
        } catch {
          await update($, routerAtom, r => ({ ...r, error: 'router not reachable' }))
        }
        await $.clock.sleep(3_000)
      }
    } finally {
      polling = false
    }
  }

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'sonata_loop', description: TOOL_DESCRIPTION, isDeferred: false, inputSchema: {
      type: 'object',
      properties: {
        action: { enum: ['plan', 'start', 'result', 'escalate', 'done'] },
        title: { type: 'string' }, taskId: { type: 'string' }, summary: { type: 'string' }, note: { type: 'string' },
        phase: { enum: ['code', 'fix', 'review', 'final'] }, outcome: { enum: ['pass', 'fail'] },
        to: { enum: ['simple', 'normal', 'complex'] },
        tasks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'] } },
      },
      required: ['action'],
    } })
    await $.command.register({ name: 'sonata-loop', description: 'Show or hide the sonata loop panel' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, loopAtom, () => null)
      await update($, agentsAtom, () => [])
      await update($, viewAtom, () => ({ showAll: true, expanded: [] }))
    }
    return next(e)
  })

  on('command.run', { command: 'sonata-loop' }, async $ => {
    const open = (await $.ui.panes()).some(p => p.id === PANE)
    if (open) await $.ui.close({ id: PANE })
    else await $.ui.open({ id: PANE, title: 'sonata loop' })
    return { text: open ? 'Loop panel closed.' : 'Loop panel opened.' }
  })

  // The mod's own tool: the one place a refusal is allowed (validation only).
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = (e as { input?: unknown }).input
    const result = applyLoopAction(await read($, loopAtom), input, Date.now())
    if ('error' in result) return { deny: result.error }
    await update($, loopAtom, () => result.loop)
    if ((input as { action?: string }).action === 'plan') void $.ui.open({ id: PANE, title: 'sonata loop' })
    const n = result.loop?.tasks.length ?? 0
    return { result: { ok: true }, text: `sonata_loop recorded (${n} task${n === 1 ? '' : 's'}).` }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if ('agentId' in started && started.agentId !== undefined) {
      const s = spawnAgent({ loop: await read($, loopAtom), agents: await read($, agentsAtom) },
        { agentId: started.agentId, subagentType: e.subagentType, description: e.description, parentAgentId: e.parentAgentId }, Date.now())
      await update($, loopAtom, () => s.loop)
      await update($, agentsAtom, () => s.agents)
      void poll($)
    }
    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) await update($, agentsAtom, a => stepAgent(a, { agentId: e.agentId!, model: e.model }, Date.now()))
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    const agentId = (e as { agentId?: string }).agentId
    const input = ((e as { input?: unknown }).input ?? {}) as Record<string, unknown>
    if (agentId !== undefined) await update($, agentsAtom, a => toolActivity(a, { agentId, tool: e.tool, input }))
    const ran = await next(e)
    if (agentId !== undefined && !('deny' in ran) && ran.isError !== true) {
      const hunks = hunksFor(e.tool, input)
      if (hunks.length > 0) await update($, agentsAtom, a => addHunks(a, agentId, hunks))
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const reason = 'reason' in e ? e.reason : 'answer'
      await update($, agentsAtom, a => completeAgent(a, { agentId: e.agentId!, reason }, Date.now()))
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPanel($, e, { loopAtom, agentsAtom, routerAtom, viewAtom }))
}
```

  If the engine's typings place a tool call's arguments other than at
  `e.input` (check `ToolCallInput` in `.claude-plugin/types/claude-code/index.d.ts`),
  change only the two `input` reads to match. The same goes for `agentId`:
  read it from the field the typings name for the calling loop.

- [ ] **Step 4: Add a placeholder `panel.tsx` so this task runs on its own.**
  Task 8 replaces it.

```tsx
export const drawPanel = async ($: any, e: any) => {
  const { Text } = $.ui.resolve(e)
  return <Text dimColor>sonata loop</Text>
}
```

- [ ] **Step 5: Run the tests and validate.** Run
  `claude plugin test skills/loop && claude plugin validate skills/loop`.
  Expected: all tests pass, and validate lists the hooks `session.start`,
  `session.end`, `command.run`, `tool.call` ×2, `agent.spawn`, `turn.step`,
  `turn.complete` and `ui.render`, with no errors.

- [ ] **Step 6: Commit.**

```bash
git add skills/loop/hooks/register.tsx skills/loop/hooks/panel.tsx skills/loop/hooks/register.test.ts
git commit -m "feat(loop-panel): wire loop tool, agent hooks, diff capture and router polling"
```

---

### Task 8: Draw the panel

**Files:**
- Modify: `skills/loop/hooks/panel.tsx` (replace the placeholder)
- Test: `skills/loop/hooks/panel.test.ts`

**Interfaces:**
- Consumes: the atoms (Task 7), and `attribute`, `taskCost`, `diffStat`,
  `childrenOf` and `depthOf` (Tasks 4–6).
- Produces:
  `drawPanel($, e, atoms: { loopAtom; agentsAtom; routerAtom; viewAtom }): Promise<JSX>`.
  Row buttons are keyed `task:<id>`, `agent:<id>`, `fold:<id>` and
  `group:unplanned`. The toolbar keys are `toggle:active`, `jump:latest` and
  `copy:selected`.

- [ ] **Step 1: Write the failing test.** Create `skills/loop/hooks/panel.test.ts`:

```ts
import { test, expect } from 'claude-code/testing'

const TOOL = 'mcp__sonata-loop__sonata_loop'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`panel draws tasks and shows a diff when an agent is selected (${surface})`, async ($, on) => {
    on('ui.open', () => ({ isPlaced: true }))
    on('agent.spawn', () => ({ model: 'sonata-code-simple', agentId: 'a1' }))
    on('tool.call', { tool: 'Edit' }, () => ({ result: {}, text: 'ok' }))
    on('http.fetch', () => ({ status: 200, ok: true, headers: {}, text: '{"routes":[]}' }))
    await $.tool.call({ tool: TOOL, input: { action: 'plan', title: 'auth', tasks: [{ id: '1', title: 'Retry queue' }] } })
    await $.tool.call({ tool: TOOL, input: { action: 'start', taskId: '1', phase: 'code' } })
    await $.agent.spawn({ subagentType: 'code-simple', description: 'queue tests', prompt: 'x' })
    await $.tool.call({ tool: 'Edit', agentId: 'a1', input: { file_path: '/r/q.ts', old_string: 'retry(fn)', new_string: 'retry(fn, { backoff })' } })

    const ui = await $.ui.mount({ plugin: 'sonata-loop', surface, component: 'Pane', props: { requestId: 'sonata-loop' } })
    expect(ui.find('task:1').text).toMatch(/Retry queue/)
    expect(ui.find('agent:a1').text).toMatch(/code-simple/)
    expect(ui.text).not.toMatch(/retry\(fn, \{ backoff \}\)/)
    await ui.press('agent:a1')
    expect(ui.text).toMatch(/\+ retry\(fn, \{ backoff \}\)/)
    expect(ui.text).toMatch(/cost unknown|router not reachable|≈|\?/)
  })
}
```

  The kit's mount and act verbs (`mount`, `find`, `press`, `text`) are named
  in `claude-code/testing`'s `Mounted` type. If the build spells them
  differently, use its spelling and keep the assertions.

- [ ] **Step 2: Run it and confirm it fails.** Run
  `claude plugin test skills/loop`. Expected: `panel.test.ts` fails because
  `task:1` isn't found.

- [ ] **Step 3: Implement.** Replace `skills/loop/hooks/panel.tsx`:

```tsx
import { read, update } from 'claude-code'
import type { AgentRow, Loop, LoopTask, RouterState, View } from '../types'
import { attribute, childrenOf, depthOf, diffStat, taskCost } from './model'

const MARK: Record<LoopTask['state'], string> = { pending: '·', coding: '▶', fixing: '▶', review: '◐', done: '✓' }
const AGENT_MARK: Record<AgentRow['status'], string> = { running: '▶', done: '✓', aborted: '■', error: '✗' }
const money = (usd: number): string => `$${usd.toFixed(2)}`
const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export async function drawPanel($: any, e: any, atoms: { loopAtom: any; agentsAtom: any; routerAtom: any; viewAtom: any }) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const loop: Loop | null = await read($, atoms.loopAtom)
  const agents: AgentRow[] = await read($, atoms.agentsAtom)
  const router: RouterState = await read($, atoms.routerAtom)
  const view: View = await read($, atoms.viewAtom)
  const now = Date.now()
  const select = (key: string) => () => update($, atoms.viewAtom, (v: View) => ({ ...v, selected: v.selected === key ? undefined : key }))
  const toggleFold = (key: string) => () => update($, atoms.viewAtom, (v: View) => ({
    ...v, expanded: v.expanded.includes(key) ? v.expanded.filter(k => k !== key) : [...v.expanded, key],
  }))

  const modelCell = (a: AgentRow): string => {
    if (router.error !== undefined) return '?'
    const at = attribute(agents, router.routes, a.id)
    if (at.served.length === 0) return '?'
    return `${at.isExact ? '→' : '≈'} ${at.served.join('/')}${at.tier ? ` (${at.tier})` : ''}`
  }
  const tail = (a: AgentRow): string => {
    if (a.status === 'running') return `${a.activity ?? ''} · step ${a.steps} · ${clock(now - a.startedAt)}`
    const at = attribute(agents, router.routes, a.id)
    return at.usd === undefined ? 'cost unknown' : money(at.usd)
  }

  const agentLines = (a: AgentRow): any[] => {
    const depth = depthOf(agents, a.id)
    if (!view.showAll && a.status !== 'running') return []
    const kids = childrenOf(agents, a.id)
    const lines = [
      <Button key={`agent:${a.id}`} onPress={select(`agent:${a.id}`)}>
        <Text>{'  '.repeat(depth + 1)}{AGENT_MARK[a.status]} {a.type} "{a.description}" {modelCell(a)} <Text dimColor>{tail(a)}{kids.length > 0 ? ` · fanned out ${kids.length}` : ''}{a.usedBash ? ' · Bash may have changed files: not shown' : ''}</Text></Text>
      </Button>,
    ]
    if (depth >= 1 && kids.length > 0 && !view.expanded.includes(`fold:${a.id}`)) {
      lines.push(<Button key={`fold:${a.id}`} onPress={toggleFold(`fold:${a.id}`)}><Text dimColor>{'  '.repeat(depth + 2)}+{kids.length} more (depth 3+)</Text></Button>)
      return lines
    }
    for (const k of kids) lines.push(...agentLines(k))
    return lines
  }

  const taskLine = (t: LoopTask) => {
    const top = t.agentIds.map(id => agents.find(a => a.id === id)).filter((a): a is AgentRow => a !== undefined)
    const tree = (ids: string[]): string[] => ids.flatMap(id => [id, ...tree(childrenOf(agents, id).map(c => c.id))])
    const all = tree(t.agentIds)
    const cost = taskCost(agents, router.routes, all)
    const stat = diffStat(all.flatMap(id => agents.find(a => a.id === id)?.hunks ?? []))
    const flag = t.escalatedTo ? ` escalated→${t.escalatedTo}` : t.failures > 0 ? ` failed ${t.failures}×` : ''
    return [
      <Button key={`task:${t.id}`} onPress={select(`task:${t.id}`)}>
        <Text>{MARK[t.state]} {t.id} {t.title}<Text color="yellow">{flag}</Text> <Text dimColor>{cost.isPartial ? `≈${money(cost.usd)} + unknown` : money(cost.usd)}{stat.files > 0 ? ` · +${stat.added} −${stat.removed} · ${stat.files} files` : ''}</Text></Text>
      </Button>,
      ...top.flatMap(agentLines),
    ]
  }

  const unplanned = agents.filter(a => a.parentId === undefined && a.taskId === undefined)
  const selectedHunks = view.selected?.startsWith('agent:')
    ? agents.find(a => a.id === view.selected!.slice(6))?.hunks ?? []
    : view.selected?.startsWith('task:')
      ? (() => {
        const t = loop?.tasks.find(x => x.id === view.selected!.slice(5))
        const tree = (ids: string[]): string[] => ids.flatMap(id => [id, ...tree(childrenOf(agents, id).map(c => c.id))])
        return tree(t?.agentIds ?? []).flatMap(id => agents.find(a => a.id === id)?.hunks ?? [])
      })()
      : []
  const done = loop?.tasks.filter(t => t.state === 'done').length ?? 0

  return (
    <Box flexDirection="column">
      {loop === null && unplanned.length === 0 && <Text dimColor>No sonata loop running.</Text>}
      {loop !== null && <Text bold>sonata loop · {loop.title} <Text dimColor>{done}/{loop.tasks.length} done · {clock(now - loop.startedAt)}{loop.isDone ? ' · finished' : ''}</Text></Text>}
      <Box flexDirection="row">
        <Button key="toggle:active" onPress={() => update($, atoms.viewAtom, (v: View) => ({ ...v, showAll: !v.showAll }))}>{view.showAll ? 'active only' : 'all agents'}</Button>
        <Button key="jump:latest" onPress={() => $.ui.scroll({ in: 'sonata-loop', to: 'end' })}>latest</Button>
      </Box>
      {loop?.tasks.flatMap(taskLine)}
      {unplanned.length > 0 && <Text dimColor>── Unplanned ──</Text>}
      {unplanned.flatMap(agentLines)}
      {selectedHunks.length > 0 && <Text dimColor>── diff ({view.selected}) ──</Text>}
      {selectedHunks.map((h, i) => (
        <Box key={`hunk:${i}`} flexDirection="column">
          <Button key={`copy:${i}`} onPress={() => $.ui.copy({ text: [...h.removed.map(l => `- ${l}`), ...h.added.map(l => `+ ${l}`)].join('\n') })}><Text bold>{h.file}{h.isNewFile ? ' (written)' : ''}</Text></Button>
          {h.removed.map(l => <Text color="red">- {l}</Text>)}
          {h.added.map(l => <Text color="green">+ {l}</Text>)}
          {h.omitted > 0 && <Text dimColor>… {h.omitted} more lines</Text>}
        </Box>
      ))}
      {router.error !== undefined && <Text dimColor>{router.error}: models ?, costs unknown</Text>}
    </Box>
  )
}
```

- [ ] **Step 4: Run the tests and validate.** Run
  `claude plugin test skills/loop && claude plugin validate skills/loop`.
  Expected: all tests pass on both surfaces, and no tree is refused. If
  validate refuses a prop (`color`, `bold`), drop that prop and keep the text.

- [ ] **Step 5: Commit.**

```bash
git add skills/loop/hooks/panel.tsx skills/loop/hooks/panel.test.ts
git commit -m "feat(loop-panel): draw tasks, agent tree, models, costs and selected diffs"
```

---

### Task 9: Skill instructions, `doctor` line, docs and changelog

**Files:**
- Modify: `skills/loop/SKILL.md`
- Modify: `src/commands/doctor.ts` (one check)
- Modify: `README.md`, `docs/guide/` (the page that documents sonata-loop),
  `CHANGELOG.md`, and `docs/superpowers/README.md` (row status)
- Test: `tests/commands/doctor.test.ts`

**Interfaces:**
- Produces:
  `loopPanelCheck(dirs: string[], packageRoot: string): { ok: boolean; line: string }`,
  exported from `src/commands/doctor.ts`.

- [ ] **Step 1: Write the failing doctor test.** Append to
  `tests/commands/doctor.test.ts`:

```ts
import { loopPanelCheck } from '../../src/commands/doctor.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('loop panel check', () => {
  const manifest = (dir: string, version: string) => {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sonata-loop', version }));
    writeFileSync(join(dir, 'SKILL.md'), '#');
  };
  const pkg = mkdtempSync(join(tmpdir(), 'pkg-'));
  manifest(join(pkg, 'skills', 'loop'), '0.1.0');

  it('reports an installed, matching panel', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'inst-')), 'sonata-loop');
    manifest(dir, '0.1.0');
    expect(loopPanelCheck([dir], pkg)).toEqual({ ok: true, line: `loop panel 0.1.0 installed (${dir})` });
  });

  it('says to run sonata sync when the installed skill has no panel or an old one', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'inst-')), 'sonata-loop');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '#');
    expect(loopPanelCheck([dir], pkg)).toEqual({ ok: false, line: `loop panel missing in ${dir} — run \`sonata sync\`` });
    manifest(dir, '0.0.9');
    expect(loopPanelCheck([dir], pkg).line).toBe(`loop panel 0.0.9 in ${dir}, package has 0.1.0 — run \`sonata sync\``);
  });

  it('is silent when the skill is not installed at all', () => {
    expect(loopPanelCheck([join(tmpdir(), 'nope-sonata-loop')], pkg)).toEqual({ ok: true, line: 'loop skill not installed' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run
  `npx vitest run tests/commands/doctor.test.ts`. Expected: FAIL, because
  `loopPanelCheck` is not exported.

- [ ] **Step 3: Implement `loopPanelCheck`** in `src/commands/doctor.ts`,
  near the other exported checks:

```ts
/** Whether each installed sonata-loop skill folder carries the panel mod the package ships. */
export function loopPanelCheck(dirs: string[], packageRoot: string): { ok: boolean; line: string } {
  const version = (dir: string): string | undefined => {
    try {
      const v = (JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }).version;
      return typeof v === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const shipped = version(join(packageRoot, 'skills', 'loop'));
  for (const dir of dirs.filter((d) => existsSync(join(d, 'SKILL.md')))) {
    const installed = version(dir);
    if (installed === undefined) return { ok: false, line: `loop panel missing in ${dir} — run \`sonata sync\`` };
    if (shipped !== undefined && installed !== shipped) {
      return { ok: false, line: `loop panel ${installed} in ${dir}, package has ${shipped} — run \`sonata sync\`` };
    }
    return { ok: true, line: `loop panel ${installed} installed (${dir})` };
  }
  return { ok: true, line: 'loop skill not installed' };
}
```

  (Add `existsSync`, `readFileSync` and `join` to the imports if they're
  missing.) Then call it where `cmdDoctor` prints its other checks. Pass
  `[join(cwd, '.claude/skills/sonata-loop'), join(home, '.claude/skills/sonata-loop')]`
  and the package root (the same root `sync` uses), and print `line` with the
  same ok/warn marker style the neighbouring checks use.

- [ ] **Step 4: Run the doctor tests and typecheck.** Run
  `npx vitest run tests/commands/doctor.test.ts && npm run typecheck`.
  Expected: PASS.

- [ ] **Step 5: Add the tool instructions to `SKILL.md`.** Insert this section
  directly after the `## When auto-routing is on` section:

```markdown
## Reporting to the loop panel

When a tool named `mcp__sonata-loop__sonata_loop` is available, the sonata-loop
panel is installed: report each loop step to it so the person watching sees
where the loop is. Call it, and only it, at these points:

- after the plan (step 1): `plan` with `title` and `tasks: [{ id, title }]`,
  one per planned task, ids as you will refer to them;
- immediately before every dispatch: `start` with `taskId` and `phase` —
  `code` for a task's first dispatch, `fix` for a fix, `review` for its review,
  `final` for the final gate (use the final gate's own task id from the plan);
- after every review verdict: `result` with `taskId` and `outcome` `pass` or
  `fail` (and a one-line `note` on a fail);
- when a task escalates: `escalate` with `taskId` and `to`;
- when the loop ends, either way: `done` with a one-line `summary`.

If the tool refuses a call, fix the call (it names what is wrong) — do not stop
the loop over it. If the tool is not available, skip this section entirely:
the loop runs exactly as described everywhere else.
```

  Also add a final-gate task to the plan instruction in step 1, so `start`
  has a task id for `final`: "The plan's last task is always the final gate."
  Make that a one-line change where step 1 lists what the plan contains.

- [ ] **Step 6: Write the docs.**
  - **README.md:** where the sonata-loop skill is described, add one sentence:
    "`sonata init` also installs the skill's panel mod: in a session it shows
    the loop's tasks, each tier agent's live activity, the model the router
    served, and an agent's diff when you select it (`/sonata-loop` toggles it)."
  - **The `docs/guide/` page that describes sonata-loop:** add a "Loop panel"
    subsection. Cover what each row shows; that `≈` means concurrent agents
    on one alias couldn't be told apart; that `cost unknown` means unpriced or
    unattributable; that `Bash` changes aren't diffed; and the `router_url`
    option for a non-default router port.
  - **CHANGELOG.md:** under `## [Unreleased]`, add an `### Added` entry:
    "**The sonata-loop skill is now also a Claude Code mod with a live panel.**"
    followed by two sentences on what it shows and that `sonata init`/`sync`
    install the whole folder.
  - **`docs/superpowers/README.md`:** change this spec's row status to link
    the plan: `[plan](plans/2026-10-09-sonata-loop-panel.md)`.

- [ ] **Step 7: Run the full suite.** Run
  `npm run typecheck && npm test && claude plugin test skills/loop && claude plugin validate skills/loop`.
  Expected: everything passes.

- [ ] **Step 8: Commit.**

```bash
git add skills/loop/SKILL.md src/commands/doctor.ts tests/commands/doctor.test.ts README.md docs/guide CHANGELOG.md docs/superpowers/README.md
git commit -m "feat(loop-panel): skill reports to the panel; doctor checks it; docs"
```

---

### Task 10: Manual verification in a routed session

**Files:** none changed unless a defect is found. A defect gets its own
failing test and fix in the task that owns the code.

- [ ] **Step 1: Build and load.** Run `npm run build`. Then, in a scratch
  repository with a `sonata.toml`, run `sonata route auto` and start
  `claude --plugin-dir <worktree>/skills/loop`.
- [ ] **Step 2: Run a short loop.** Invoke `/sonata-loop` and ask for a
  two-task change. Confirm each of these:
  - the panel opens on `plan`;
  - tasks move pending → coding → review → done;
  - each agent row shows its live tool and step count;
  - the model column shows the served model with its tier;
  - selecting an agent shows its hunks, and selecting it again hides them;
  - a task row's cost and `+A −D` summary appear once its agents finish.
- [ ] **Step 3: Check the nesting and ambiguity paths.** Dispatch a
  `code-complex` task that fans out to two `code-simple` children. Confirm the
  children nest under it, and that concurrent same-alias children show `≈`
  with no per-agent cost.
- [ ] **Step 4: Check the failure paths.** Stop the router with
  `sonata restart` mid-run, then confirm the footer says
  `router not reachable` and costs say unknown. Run `/clear` and confirm the
  panel empties.
- [ ] **Step 5: Record the outcome.** Note the result in the PR description:
  what was verified, and any check that couldn't be run and why.
