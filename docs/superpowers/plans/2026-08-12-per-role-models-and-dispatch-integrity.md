# Per-Role Models + Dispatch Integrity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each role choose its own models, and make a wrapper agent unable to do the work itself.

**Architecture:** `[generate.roles]` becomes a table, and one `generatedAgents` function replaces the roles × models product that is currently written out three times. The wrapper then loses `Bash` and gains three MCP tools served by a hand-rolled stdio JSON-RPC server, with `sonata verify` and a `doctor` completeness pass as the second layer.

**Tech Stack:** TypeScript (strict, ESM), Node ≥22, vitest, smol-toml. No new dependencies.

**Specs:** `docs/superpowers/specs/2026-08-12-per-role-models-design.md`, `docs/superpowers/specs/2026-08-12-dispatch-integrity-design.md`

## Global Constraints

- ESM: every relative import ends in `.js`, even from `.ts` sources.
- Strict TypeScript. `npx tsc --noEmit` must pass at every commit.
- Full suite green at every commit: `npx vitest run` (321 tests pass today).
- **No new runtime dependencies.** `smol-toml` remains the only one.
- No test may read the real `$HOME` or `process.cwd()`; inject temp dirs.
- Every key and value written into TOML goes through `tomlKey`.
- `sonata` on PATH runs `dist/`, not `src/`. Run `npm run build` before testing the installed command.
- Every commit message ends with these two trailers:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
  ```

## Parallelism

Concurrently-runnable tasks never share a file.

```
Task 1  src/config.ts                     ← foundational, alone
   ├── Task 2  src/commands/sync.ts       ┐
   ├── Task 3  src/commands/init.ts       ├─ concurrent
   └── Task 4  src/detect.ts              ┘
          ├── Task 5  src/mcp/protocol.ts ┐
          ├── Task 6  src/mcp/tools.ts    ├─ concurrent
          └── Task 7  src/settings.ts     ┘
                 └── Task 8  src/mcp/server.ts + cli.ts   ← needs 5 and 6
                        ├── Task 9   src/commands/verify.ts  ┐
                        └── Task 10  src/commands/doctor.ts  ┘ concurrent
                               └── Task 11 sync.ts agentMarkdown
                                      └── Task 12 init.ts wiring
                                             └── Task 13 handshake capture
                                                    └── Task 14 docs
```

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/config.ts` | `[generate.roles]` shape, old-form rejection, `generatedAgents` | 1 |
| `src/commands/sync.ts` | generate from `generatedAgents`; report stale; MCP tool grant | 2, 11 |
| `src/commands/init.ts` | write the table; per-role wizard; prune prompt; MCP registration | 3, 12 |
| `src/detect.ts` | `pruneAgents` beside `staleAgents` | 4 |
| `src/mcp/protocol.ts` | pure JSON-RPC request → response | 5 |
| `src/mcp/tools.ts` | the three tool definitions and their dispatch | 6 |
| `src/mcp/server.ts` | stdio loop | 8 |
| `src/settings.ts` | MCP server registration | 7 |
| `src/commands/verify.ts` | `sonata verify` | 9 |
| `src/commands/doctor.ts` | completeness checks | 10 |
| `src/cli.ts` | `mcp` and `verify` subcommands, `--prune` | 8, 9 |

---

### Task 1: `[generate.roles]` and `generatedAgents`

Foundational — every later task reads this shape. Breaks every fixture carrying the flat form, so this task fixes them.

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`, `tests/e2e.test.ts`, `tests/commands/run.test.ts`, `tests/commands/sync.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SonataConfig.generate: { roles: Record<string, string[]> }` (the `models` field is gone) and `generatedAgents(config: SonataConfig): { role: string; model: string }[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`:

```ts
import { generatedAgents } from '../src/config.js';

describe('generate.roles table', () => {
  const cfg = (body: string) => `
[models."a"]
harness = "codex"
id = "gpt-5.6-sol"

[models."b"]
harness = "codex"
id = "gpt-5.6-terra"

${body}
`;

  it('gives each role its own models', () => {
    const c = parseConfig(cfg(`
[generate.roles]
code = ["a"]
review = ["a", "b"]
`));
    expect(c.generate.roles).toEqual({ code: ['a'], review: ['a', 'b'] });
    expect(generatedAgents(c)).toEqual([
      { role: 'code', model: 'a' },
      { role: 'review', model: 'a' },
      { role: 'review', model: 'b' },
    ]);
  });

  it('treats an empty list and an omitted role alike', () => {
    const c = parseConfig(cfg(`
[generate.roles]
code = []
`));
    expect(generatedAgents(c)).toEqual([]);
  });

  // TOML cannot hold both `roles = [...]` and `[generate.roles]`, so the old
  // form is detected by type rather than guessed. A config that parses into
  // something nobody intended is how the [models.gpt-5.6-luna] bug happened.
  it('rejects the old flat form, naming the fix', () => {
    expect(() => parseConfig(cfg(`
[generate]
roles = ["code"]
models = ["a"]
`))).toThrow(/\[generate\.roles\]/);
  });

  it('rejects a leftover generate.models key', () => {
    expect(() => parseConfig(cfg(`
[generate]
models = ["a"]
`))).toThrow(/\[generate\.roles\]/);
  });

  it('rejects an unknown role key', () => {
    expect(() => parseConfig(cfg(`
[generate.roles]
dance = ["a"]
`))).toThrow(/unknown role/i);
  });

  it('names the role when a model is undefined', () => {
    expect(() => parseConfig(cfg(`
[generate.roles]
code = ["nope"]
`))).toThrow(/code.*nope/s);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts -t "generate.roles table"`
Expected: FAIL — `generatedAgents is not a function`.

- [ ] **Step 3: Change the type and the parser**

In `src/config.ts`, change the interface:

```ts
export interface SonataConfig {
  models: Record<string, ModelConfig>;
  generate: { roles: Record<string, string[]> };
  run: {
    tailWindowSeconds: number;
    stallTimeoutSeconds: number;
    runTimeoutSeconds: number;
  };
}
```

Replace the two `generate` reads and their validation loops with:

```ts
  const gen = (raw.generate ?? {}) as Record<string, unknown>;

  // TOML cannot express both `roles = [...]` and `[generate.roles]`, so the
  // old form is distinguishable exactly. Fail loudly rather than approximate:
  // a config read as something nobody intended is worse than one that errors.
  if (Array.isArray(gen.roles) || gen.models !== undefined) {
    throw new Error(
      'sonata.toml: [generate] now maps each role to its own models. Replace\n' +
      '    roles  = [...]\n    models = [...]\n' +
      'with, for example:\n' +
      '    [generate.roles]\n    code   = ["<model-key>"]\n    review = ["<model-key>"]\n' +
      'or re-run `sonata init`.',
    );
  }

  const roles: Record<string, string[]> = {};
  for (const [role, list] of Object.entries((gen.roles ?? {}) as Record<string, unknown>)) {
    if (!KNOWN_ROLES.includes(role as any)) {
      throw new Error(
        `sonata.toml: generate.roles contains unknown role "${role}". ` +
        `Known roles: ${KNOWN_ROLES.join(', ')}`,
      );
    }
    if (!Array.isArray(list)) {
      throw new Error(`sonata.toml: generate.roles.${role} must be a list of model keys.`);
    }
    for (const m of list) {
      if (!models[m as string]) {
        throw new Error(
          `sonata.toml: generate.roles.${role} references unknown model "${m}". ` +
          `Define [models."${m}"] first.`,
        );
      }
    }
    roles[role] = list as string[];
  }
```

and return `generate: { roles }`.

Then add:

```ts
/**
 * Every agent the config asks for.
 *
 * The single definition of what should exist. The roles × models product used
 * to be written out in `cmdSync`, again in `init`'s summary, and again as the
 * expected set for `staleAgents` — three copies that could disagree, and stale
 * agents caused three separate failures.
 */
export function generatedAgents(config: SonataConfig): { role: string; model: string }[] {
  const out: { role: string; model: string }[] = [];
  for (const [role, models] of Object.entries(config.generate.roles)) {
    for (const model of models) out.push({ role, model });
  }
  return out;
}
```

- [ ] **Step 4: Fix every fixture carrying the flat form**

The suite will name them. In each, replace

```toml
[generate]
roles = ["code"]
models = ["fake"]
```

with

```toml
[generate.roles]
code = ["fake"]
```

Known files: `tests/config.test.ts` (its existing cases), `tests/e2e.test.ts`, `tests/commands/run.test.ts`, `tests/commands/sync.test.ts`. Chase any others the suite reports.

- [ ] **Step 5: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. `src/commands/sync.ts` and `src/commands/init.ts` still reference `config.generate.models` and will not compile — fix them minimally to `Object.values(config.generate.roles).flat()` so this task compiles; Tasks 2 and 3 rewrite them properly.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/commands tests
git commit -m "$(cat <<'EOF'
feat: give each role its own models

sync generated the cartesian product of roles and models, so every role
got every model. This machine's config produced 40 agents where about 8
were wanted, and every surplus agent is one wrong pick away from being
chosen.

[generate.roles] is now a table. The flat pair is removed rather than
kept alongside: two ways to say one thing needs a precedence rule, and a
misread config is how the [models.gpt-5.6-luna] nesting bug happened.
The old form is detected by type — TOML cannot hold both — so it fails
loudly instead of being approximated.

generatedAgents replaces the product that was written out three times,
in sync, in init's summary, and as staleAgents' expected set.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 2: `cmdSync` generates from `generatedAgents` and reports stale

Concurrent with Tasks 3 and 4.

**Files:**
- Modify: `src/commands/sync.ts`
- Test: `tests/commands/sync.test.ts`

**Interfaces:**
- Consumes: `generatedAgents`, `loadConfig(cwd, home?)`, `staleAgents(agentsDir, expected)`.
- Produces: `SyncResult { written: string[]; stale: string[] }`; `cmdSync(opts: SyncOptions): SyncResult`.

- [ ] **Step 1: Write the failing test**

Append to `tests/commands/sync.test.ts`:

```ts
describe('cmdSync — per-role models and staleness', () => {
  it('writes only the agents the roles ask for', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sync-roles-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."a"]
harness = "codex"
id = "gpt-5.6-sol"

[models."b"]
harness = "codex"
id = "gpt-5.6-terra"

[generate.roles]
code = ["a"]
review = ["a", "b"]
`);
    const agentsDir = join(cwd, '.claude', 'agents');
    const res = cmdSync({ cwd, agentsDir });

    expect(res.written).toHaveLength(3);
    expect(existsSync(join(agentsDir, 'code-a.md'))).toBe(true);
    expect(existsSync(join(agentsDir, 'review-b.md'))).toBe(true);
    // code did not ask for b
    expect(existsSync(join(agentsDir, 'code-b.md'))).toBe(false);
  });

  it('reports stale agents without deleting them', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sync-stale-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."a"]
harness = "codex"
id = "gpt-5.6-sol"

[generate.roles]
code = ["a"]
`);
    const agentsDir = join(cwd, '.claude', 'agents');
    cmdSync({ cwd, agentsDir });
    // An agent sonata wrote earlier, for a model no longer configured.
    writeFileSync(join(agentsDir, 'code-gone.md'),
      'forwarding wrapper around the sonata runtime');

    const res = cmdSync({ cwd, agentsDir });
    expect(res.stale).toEqual(['code-gone.md']);
    // Reported, not removed — the caller decides.
    expect(existsSync(join(agentsDir, 'code-gone.md'))).toBe(true);
  });

  it('never reports an agent sonata did not write', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'sync-foreign-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[models."a"]
harness = "codex"
id = "gpt-5.6-sol"

[generate.roles]
code = ["a"]
`);
    const agentsDir = join(cwd, '.claude', 'agents');
    cmdSync({ cwd, agentsDir });
    writeFileSync(join(agentsDir, 'my-own-agent.md'), 'hand written, not sonata');

    expect(cmdSync({ cwd, agentsDir }).stale).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/sync.test.ts -t "per-role models and staleness"`
Expected: FAIL — `res.written` is undefined, because `cmdSync` returns an array.

- [ ] **Step 3: Rewrite `cmdSync`**

```ts
import { generatedAgents, loadConfig } from '../config.js';
import { staleAgents } from '../detect.js';

export interface SyncOptions { cwd: string; agentsDir: string; home?: string }

export interface SyncResult {
  /** Paths written. */
  written: string[];
  /** Filenames sonata wrote that the config no longer covers. Not deleted. */
  stale: string[];
}

export function cmdSync(opts: SyncOptions): SyncResult {
  const config = loadConfig(opts.cwd, opts.home);
  mkdirSync(opts.agentsDir, { recursive: true });

  const wanted = generatedAgents(config);
  const written: string[] = [];
  for (const { role, model } of wanted) {
    const harness = config.models[model].harness;
    const path = join(opts.agentsDir, `${role}-${model}.md`);
    writeFileSync(path, agentMarkdown({ role, model, harness }));
    written.push(path);
  }

  return {
    written,
    stale: staleAgents(opts.agentsDir, wanted.map((a) => `${a.role}-${a.model}`)),
  };
}
```

- [ ] **Step 4: Fix the callers minimally**

`src/commands/init.ts` and `src/cli.ts` use the old array return. Change each to read `.written`. Task 12 rewrites init's block properly.

- [ ] **Step 5: Run the full suite, then commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/commands/sync.ts src/commands/init.ts src/cli.ts tests/commands/sync.test.ts
git commit -m "$(cat <<'EOF'
feat: sync generates per-role agents and reports what is stale

cmdSync returns { written, stale } so callers can act on staleness
without recomputing it, and stays non-interactive: putting a prompt
inside the one function the whole agent surface depends on would make it
untestable without a TTY.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 3: `tomlFor` writes `[generate.roles]`, and the wizard asks per role

Concurrent with Tasks 2 and 4. Touches only `src/commands/init.ts` and `tests/init.test.ts`.

**Files:**
- Modify: `src/commands/init.ts`
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: `generatedAgents`, `parseConfig`, the existing `tomlKey`, `multiselect`, `select`.
- Produces: `tomlFor(roleModels: Record<string, ModelRef[]>, carried: Record<string, ConfigEntry>): string`; `InitOptions.roles` and `.models` keep their meaning.

- [ ] **Step 1: Write the failing test**

Append to `tests/init.test.ts`:

```ts
describe('tomlFor — per-role table', () => {
  const ref = (id: string) => ({
    harness: 'opencode' as const, provider: 'openrouter', id, ref: `openrouter/${id}`,
  });

  it('writes each role with its own models and round-trips', () => {
    const out = tomlFor(
      { code: [ref('kimi-k3')], review: [ref('kimi-k3'), ref('grok-4.5')] },
      {},
    );
    const cfg = parseConfig(out);
    expect(cfg.generate.roles).toEqual({
      code: ['opencode-openrouter-kimi-k3'],
      review: ['opencode-openrouter-kimi-k3', 'opencode-openrouter-grok-4.5'],
    });
    // A dotted model key must survive as one key, not nest.
    expect(cfg.models['opencode-openrouter-grok-4.5'].id).toBe('openrouter/grok-4.5');
  });

  it('defines a model once even when several roles use it', () => {
    const out = tomlFor({ code: [ref('kimi-k3')], plan: [ref('kimi-k3')] }, {});
    expect(out.match(/\[models\./g)).toHaveLength(1);
    expect(parseConfig(out).generate.roles.plan).toEqual(['opencode-openrouter-kimi-k3']);
  });

  it('still carries a hand-written entry through', () => {
    const out = tomlFor({ code: [ref('kimi-k3')] },
      { 'gpt-5-6-sol': { harness: 'codex', id: 'gpt-5.6-sol' } });
    expect(parseConfig(out).models['gpt-5-6-sol'].id).toBe('gpt-5.6-sol');
  });
});

describe('cmdInit — per-role models', () => {
  const detect = async () => ({
    tmux: { installed: true, version: '3.7b', problems: [] },
    harnesses: [{
      name: 'opencode', installed: true, version: '1.18.16', supported: true,
      refs: parseOpenCodeRefs('openrouter/kimi-k3\nopenrouter/grok-4.5\n'),
      authedProviders: ['openrouter'], problems: [],
    }],
  });

  it('flags mean every listed role gets every listed model', async () => {
    const res = await cmdInit({
      cwd, home, packageRoot: '/pkg', yes: true, detect,
      providers: ['opencode/openrouter'],
      models: ['opencode-openrouter-kimi-k3', 'opencode-openrouter-grok-4.5'],
      roles: ['code', 'review'], scope: 'skip', configScope: 'project', write,
    });

    const cfg = parseConfig(readFileSync(join(cwd, 'sonata.toml'), 'utf8'));
    expect(cfg.generate.roles.code.sort()).toEqual(
      ['opencode-openrouter-grok-4.5', 'opencode-openrouter-kimi-k3']);
    expect(cfg.generate.roles.review).toHaveLength(2);
    expect(res.agentsWritten).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/init.test.ts -t "per-role table"`
Expected: FAIL — `tomlFor` takes `(refs, roles, carried)`.

- [ ] **Step 3: Rewrite `tomlFor`**

```ts
/**
 * `roleModels` maps a role to the refs that role should generate agents for.
 * A model used by several roles is still defined once in [models].
 */
export function tomlFor(
  roleModels: Record<string, ModelRef[]>,
  carried: Record<string, ConfigEntry>,
): string {
  const defined = new Map<string, ConfigEntry>();
  for (const refs of Object.values(roleModels)) {
    for (const r of refs) defined.set(configKeyFor(r), { harness: r.harness, id: r.ref });
  }
  for (const [k, e] of Object.entries(carried)) defined.set(k, e);

  const clashes = duplicateKeys([...defined.keys()]);
  if (clashes.length > 0) {
    throw new Error(
      `sonata: ${clashes.join(', ')} would name two different models. ` +
      'Rename the hand-written entry, or enable only one of the colliding refs.',
    );
  }

  const lines: string[] = [];
  for (const [key, entry] of defined) {
    lines.push(
      `[models.${tomlKey(key)}]`,
      `harness = ${tomlKey(entry.harness)}`,
      `id = ${tomlKey(entry.id)}`,
      '',
    );
  }

  lines.push('[generate.roles]');
  for (const [role, refs] of Object.entries(roleModels)) {
    lines.push(`${tomlKey(role)} = [${refs.map((r) => tomlKey(configKeyFor(r))).join(', ')}]`);
  }
  lines.push(
    '',
    '[run]',
    'tail_window_seconds = 20',
    'stall_timeout_seconds = 120',
    'run_timeout_seconds = 1800',
    '',
  );
  return lines.join('\n');
}
```

Note: `duplicateKeys` now runs over the deduplicated key set, so one model used by two roles is not a collision.

- [ ] **Step 4: Add the wizard question and the per-role loop**

In `cmdInit`, after roles are chosen and before the hook block:

```ts
  // The common case is one keystroke; only a user who wants different models
  // per role pays for the extra screens.
  let roleModels: Record<string, ModelRef[]>;
  const sameForAll = !interactive || await confirm(
    `Use the same models for every role?  (${roles.length} roles × ${chosen.length} models = ` +
    `${roles.length * chosen.length} agents)`,
    true,
  );

  if (sameForAll) {
    roleModels = Object.fromEntries(roles.map((r) => [r, chosen]));
  } else {
    roleModels = {};
    for (const role of roles) {
      const picked = await multiselect(
        `Models for: ${role}`,
        chosen.map((r) => ({ value: r.ref, label: r.ref, hint: r.name, checked: true })),
      );
      roleModels[role] = chosen.filter((r) => picked.includes(r.ref));
    }
  }
```

Replace the write with `writeFileSync(configPathResolved, tomlFor(roleModels, carried))`, and compute the summary's agent count as `Object.values(roleModels).reduce((n, m) => n + m.length, 0)`.

- [ ] **Step 5: Run the full suite, then commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/commands/init.ts tests/init.test.ts
git commit -m "$(cat <<'EOF'
feat: sonata init asks whether every role uses the same models

One question in the common case, four screens only when the answer is
no. The per-role lists reuse the existing multiselect, viewport and
filter, so there is no new widget to build, test and window.

tomlFor defines a model once however many roles use it, so a shared
model is not mistaken for a key collision.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 4: `pruneAgents`

Concurrent with Tasks 2 and 3. Touches only `src/detect.ts` and a new test file.

**Files:**
- Modify: `src/detect.ts`
- Create: `tests/prune.test.ts`

**Interfaces:**
- Consumes: the existing `staleAgents`.
- Produces: `pruneAgents(agentsDir: string, files: string[]): string[]` — returns the filenames actually removed.

- [ ] **Step 1: Write the failing test**

Create `tests/prune.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneAgents, staleAgents } from '../src/detect.js';

const MARKER = 'forwarding wrapper around the sonata runtime';

describe('pruneAgents', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prune-'));
    writeFileSync(join(dir, 'code-old.md'), MARKER);
    writeFileSync(join(dir, 'code-keep.md'), MARKER);
    writeFileSync(join(dir, 'my-own-agent.md'), 'hand written, not sonata');
  });

  it('removes exactly the files it is given', () => {
    expect(pruneAgents(dir, ['code-old.md'])).toEqual(['code-old.md']);
    expect(existsSync(join(dir, 'code-old.md'))).toBe(false);
    expect(existsSync(join(dir, 'code-keep.md'))).toBe(true);
  });

  it('cannot touch a hand-written agent, because staleAgents never names one', () => {
    const stale = staleAgents(dir, ['code-keep']);
    expect(stale).not.toContain('my-own-agent.md');
    pruneAgents(dir, stale);
    expect(existsSync(join(dir, 'my-own-agent.md'))).toBe(true);
  });

  it('tolerates a file already gone', () => {
    // A concurrent sync removing it first is a race, not an error.
    expect(pruneAgents(dir, ['code-old.md', 'never-existed.md'])).toEqual(['code-old.md']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/prune.test.ts`
Expected: FAIL — `pruneAgents is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/detect.ts`, add `unlinkSync` to the `node:fs` import and, directly below `staleAgents`:

```ts
/**
 * Deletes the named agent files, returning those actually removed.
 *
 * Takes an explicit list rather than recomputing, so the files shown to a user
 * are exactly the files deleted — there is no window in which the set changes
 * between the question and the deletion.
 */
export function pruneAgents(agentsDir: string, files: string[]): string[] {
  const removed: string[] = [];
  for (const f of files) {
    try {
      unlinkSync(join(agentsDir, f));
      removed.push(f);
    } catch {
      // Already gone. A concurrent sync is a race, not a failure.
    }
  }
  return removed;
}
```

- [ ] **Step 4: Run the full suite, then commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/detect.ts tests/prune.test.ts
git commit -m "$(cat <<'EOF'
feat: pruneAgents deletes stale agent files

staleAgents has only ever reported. The accumulated files caused three
failures on 2026-08-12: 36 globally offered agents naming models a
rewritten config no longer defined, and 32 more removed by hand.

Takes an explicit list rather than recomputing, so the files shown to
the user are exactly the files deleted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 5: MCP protocol handler

Concurrent with Tasks 6 and 7. Creates a new directory; touches nothing existing.

**Files:**
- Create: `src/mcp/protocol.ts`
- Create: `tests/mcp/protocol.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `JsonRpcRequest`, `JsonRpcResponse`, `ToolDef { name: string; description: string; inputSchema: object }`, and
  `handle(req: JsonRpcRequest, deps: { tools: ToolDef[]; call(name: string, args: Record<string, unknown>): Promise<string> }): Promise<JsonRpcResponse | null>`.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { handle, type ToolDef } from '../../src/mcp/protocol.js';

const tools: ToolDef[] = [
  { name: 'run', description: 'launch', inputSchema: { type: 'object', properties: {} } },
];
const deps = { tools, call: async (n: string) => `called ${n}` };

describe('handle', () => {
  it('answers initialize with the client’s protocol version', async () => {
    const res = await handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18' } }, deps);
    expect(res!.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
    });
    expect((res!.result as any).serverInfo.name).toBe('sonata');
  });

  it('returns nothing for a notification', async () => {
    expect(await handle(
      { jsonrpc: '2.0', method: 'notifications/initialized' }, deps)).toBeNull();
  });

  it('lists the tools it was given', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, deps);
    expect((res!.result as any).tools).toEqual(tools);
  });

  it('calls a tool and wraps the text', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'run', arguments: {} } }, deps);
    expect((res!.result as any).content).toEqual([{ type: 'text', text: 'called run' }]);
    expect((res!.result as any).isError).toBeUndefined();
  });

  it('reports a throwing tool as isError rather than crashing', async () => {
    // This is the path that was invisible on 2026-08-12: a refused dispatch
    // must reach the wrapper as text it can relay.
    const res = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'run', arguments: {} } },
      { tools, call: async () => { throw new Error('unknown model "x"'); } });
    expect((res!.result as any).isError).toBe(true);
    expect((res!.result as any).content[0].text).toContain('unknown model');
  });

  it('rejects an unknown tool without throwing', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'nope', arguments: {} } }, deps);
    expect((res!.result as any).isError).toBe(true);
  });

  it('returns method-not-found for an unknown method', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 6, method: 'nope' }, deps);
    expect(res!.error!.code).toBe(-32601);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/protocol.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/protocol.js`.

- [ ] **Step 3: Write the implementation**

Create `src/mcp/protocol.ts`:

```ts
/**
 * The MCP surface sonata needs, as a pure function.
 *
 * MCP is JSON-RPC 2.0 over newline-delimited stdio. Only four messages matter
 * here, so the protocol lives in one testable function and the transport is a
 * thin loop around it — the same split as parseKey/runList in tui.ts.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

export interface Deps {
  tools: ToolDef[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

/** Used only when a client omits its version; the real one is echoed back. */
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

export async function handle(
  req: JsonRpcRequest,
  deps: Deps,
): Promise<JsonRpcResponse | null> {
  // Notifications have no id and take no response.
  if (req.id === undefined) return null;
  const id = req.id;

  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (req.params?.protocolVersion as string) ?? FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'sonata', version: '0.0.1' },
        },
      };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: deps.tools } };

    case 'tools/call': {
      const name = req.params?.name as string;
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      try {
        if (!deps.tools.some((t) => t.name === name)) {
          throw new Error(`unknown tool "${name}"`);
        }
        const text = await deps.call(name, args);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
      } catch (err) {
        // A refused dispatch must reach the wrapper as text it can relay,
        // never as a dropped call it reports nothing about.
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: (err as Error).message }],
            isError: true,
          },
        };
      }
    }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `method not found: ${req.method}` },
      };
  }
}
```

- [ ] **Step 4: Run the full suite, then commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/mcp/protocol.ts tests/mcp/protocol.test.ts
git commit -m "$(cat <<'EOF'
feat: MCP protocol handler as a pure function

Four messages — initialize, notifications/initialized, tools/list,
tools/call — as one request→response function, so every protocol
decision is testable without spawning a process.

A throwing tool becomes an isError result rather than a dropped call.
That is the path that was invisible when two wrapper agents reported
work no harness ever did.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 6: The three MCP tools

Concurrent with Tasks 5 and 7.

**Files:**
- Create: `src/mcp/tools.ts`
- Create: `tests/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `ToolDef` from `../mcp/protocol.js`; `cmdRun`, `cmdTail`, `cmdApprove`.
- Produces: `TOOL_DEFS: ToolDef[]` and `callTool(name, args, env): Promise<string>` where `env = { cwd: string; home: string; rolesDir: string; sessionId?: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/tools.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TOOL_DEFS, callTool } from '../../src/mcp/tools.js';

describe('TOOL_DEFS', () => {
  it('exposes exactly run, tail and approve', () => {
    // The wrapper's entire capability. Anything more is a way to do the work
    // itself, which is what this design exists to prevent.
    expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual(['approve', 'run', 'tail']);
  });

  it('declares the arguments each tool needs', () => {
    const run = TOOL_DEFS.find((t) => t.name === 'run')!;
    expect(Object.keys((run.inputSchema as any).properties).sort())
      .toEqual(['model', 'role', 'task']);
    expect((run.inputSchema as any).required.sort()).toEqual(['model', 'role', 'task']);
  });
});

describe('callTool', () => {
  const env = { cwd: '/repo', home: '/home', rolesDir: '/pkg/roles' };

  it('refuses a tool it does not define', async () => {
    await expect(callTool('rm', {}, env)).rejects.toThrow(/unknown tool/i);
  });

  it('requires the arguments the schema declares', async () => {
    await expect(callTool('run', { role: 'code' }, env)).rejects.toThrow(/model/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/tools.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/tools.js`.

- [ ] **Step 3: Write the implementation**

Create `src/mcp/tools.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolDef } from './protocol.js';
import { cmdRun } from '../commands/run.js';
import { cmdTail } from '../commands/tail.js';
import { cmdApprove } from '../commands/approve.js';

export interface ToolEnv {
  cwd: string;
  home: string;
  rolesDir: string;
  sessionId?: string;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'run',
    description:
      'Launch a sonata run on a foreign model and return its run id immediately. ' +
      'The run continues in the background; poll it with tail.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'code | review | explore | plan' },
        model: { type: 'string', description: 'a model key from sonata.toml' },
        task: { type: 'string', description: 'the full task text for the model' },
      },
      required: ['role', 'model', 'task'],
    },
  },
  {
    name: 'tail',
    description:
      'Poll a run for progress. Blocks until something changes or the tail window ' +
      'elapses. Returns PROGRESS, PAUSED, DONE or STALLED.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'the run id' } },
      required: ['id'],
    },
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

function need(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`sonata: the "${key}" argument is required`);
  }
  return v;
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: ToolEnv,
): Promise<string> {
  switch (name) {
    case 'run': {
      const role = need(args, 'role');
      const model = need(args, 'model');
      const task = need(args, 'task');
      // The task reaches the harness as a file, exactly as the CLI does it.
      const taskFile = join(tmpdir(), `sonata-task-${Date.now()}.md`);
      writeFileSync(taskFile, task);
      const res = await cmdRun({
        cwd: env.cwd, role, model, taskFile,
        rolesDir: env.rolesDir, sessionId: env.sessionId,
      });
      return JSON.stringify(res);
    }
    case 'tail': {
      const res = await cmdTail({ cwd: env.cwd, id: need(args, 'id') });
      return JSON.stringify(res);
    }
    case 'approve': {
      await cmdApprove({ cwd: env.cwd, id: need(args, 'id'), answer: need(args, 'answer') });
      return 'answered';
    }
    default:
      throw new Error(`sonata: unknown tool "${name}"`);
  }
}
```

If `cmdRun`, `cmdTail` or `cmdApprove` take different option names, match the real signatures in `src/commands/*.ts` rather than these — read them first.

- [ ] **Step 4: Run the full suite, then commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/mcp/tools.ts tests/mcp/tools.test.ts
git commit -m "$(cat <<'EOF'
feat: the three MCP tools a wrapper is allowed

run, tail and approve, and nothing else. The wrapper's entire capability
is dispatching and relaying; any further tool is a way to do the work
itself, which is the failure this design removes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 7: MCP server registration in settings

Concurrent with Tasks 5 and 6.

**Files:**
- Modify: `src/settings.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: the existing `HookScope`, `readSettings`, `writeSettings`.
- Produces: `mcpConfigPath(scope, cwd, home): string`, `mcpRegistered(path, packageRoot): boolean`, `registerMcp(path, packageRoot): { changed: boolean }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/settings.test.ts`:

```ts
describe('MCP registration', () => {
  it('registers sonata as a stdio server pointing at this install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-reg-'));
    const path = join(dir, '.mcp.json');

    expect(mcpRegistered(path, '/pkg')).toBe(false);
    expect(registerMcp(path, '/pkg').changed).toBe(true);
    expect(mcpRegistered(path, '/pkg')).toBe(true);

    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.mcpServers.sonata.command).toBe('node');
    expect(parsed.mcpServers.sonata.args).toEqual([join('/pkg', 'dist', 'cli.js'), 'mcp']);
  });

  it('is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-reg-'));
    const path = join(dir, '.mcp.json');
    registerMcp(path, '/pkg');
    expect(registerMcp(path, '/pkg').changed).toBe(false);
  });

  it('leaves another server alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-reg-'));
    const path = join(dir, '.mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    registerMcp(path, '/pkg');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.mcpServers.other.command).toBe('x');
    expect(parsed.mcpServers.sonata).toBeDefined();
  });
});
```

Add `mcpConfigPath, mcpRegistered, registerMcp` to the `../src/settings.js` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/settings.test.ts -t "MCP registration"`
Expected: FAIL — `mcpRegistered is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/settings.ts`:

```ts
/**
 * Where the MCP registration lives, mirroring settingsPath: a project-scoped
 * config registers in the project, a machine-scoped one in the user's config.
 * A registration that outlives its config is the same class of bug as agents
 * that outlive theirs.
 */
export function mcpConfigPath(scope: HookScope, cwd: string, home: string): string {
  return scope === 'global'
    ? join(home, '.claude', 'mcp.json')
    : join(cwd, '.mcp.json');
}

function mcpEntry(packageRoot: string) {
  return { command: 'node', args: [join(packageRoot, 'dist', 'cli.js'), 'mcp'] };
}

export function mcpRegistered(path: string, packageRoot: string): boolean {
  const s = readSettings(path) as { mcpServers?: Record<string, { args?: string[] }> };
  const want = mcpEntry(packageRoot).args.join(' ');
  return (s.mcpServers?.sonata?.args ?? []).join(' ') === want;
}

export function registerMcp(path: string, packageRoot: string): { changed: boolean } {
  if (mcpRegistered(path, packageRoot)) return { changed: false };
  const s = readSettings(path) as Settings & { mcpServers?: Record<string, unknown> };
  s.mcpServers = { ...(s.mcpServers ?? {}), sonata: mcpEntry(packageRoot) };
  writeSettings(path, s);
  return { changed: true };
}
```

- [ ] **Step 4: Run the full suite, then commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/settings.ts tests/settings.test.ts
git commit -m "$(cat <<'EOF'
feat: register the sonata MCP server, scoped like the config

Registration follows the config's scope, because a registration that
outlives its config is the same class of bug as agents that outlive
theirs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 8: The stdio server and `sonata mcp`

Needs Tasks 5 and 6.

**Files:**
- Create: `src/mcp/server.ts`
- Modify: `src/cli.ts`
- Create: `tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: `handle`, `TOOL_DEFS`, `callTool`.
- Produces: `serveMcp(input: AsyncIterable<string>, write: (line: string) => void, env: ToolEnv): Promise<void>`; the `sonata mcp` subcommand.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/server.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { serveMcp } from '../../src/mcp/server.js';

async function* lines(...ls: string[]) { for (const l of ls) yield l; }

describe('serveMcp', () => {
  const env = { cwd: '/repo', home: '/home', rolesDir: '/pkg/roles' };

  it('answers a handshake and lists tools', async () => {
    const out: string[] = [];
    await serveMcp(lines(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ), (l) => out.push(l), env);

    // The notification produces no line.
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[1]).result.tools).toHaveLength(3);
  });

  it('survives malformed input and keeps serving', async () => {
    // A server that dies takes the session's dispatch capability with it.
    const out: string[] = [];
    await serveMcp(lines(
      'not json at all',
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
    ), (l) => out.push(l), env);

    expect(JSON.parse(out[0]).error.code).toBe(-32700);
    expect(JSON.parse(out[1]).result.tools).toHaveLength(3);
  });

  it('ignores blank lines', async () => {
    const out: string[] = [];
    await serveMcp(lines('', '   '), (l) => out.push(l), env);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: FAIL — cannot resolve `../../src/mcp/server.js`.

- [ ] **Step 3: Write the server**

Create `src/mcp/server.ts`:

```ts
import { createInterface } from 'node:readline';
import { handle, type JsonRpcRequest } from './protocol.js';
import { TOOL_DEFS, callTool, type ToolEnv } from './tools.js';

/**
 * The stdio loop. Input is injected so the whole server is testable without a
 * process, which is the same seam readKeys uses for stdin in tui.ts.
 */
export async function serveMcp(
  input: AsyncIterable<string>,
  write: (line: string) => void,
  env: ToolEnv,
): Promise<void> {
  for await (const raw of input) {
    const line = raw.trim();
    if (line.length === 0) continue;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      // Never die on bad input: the session loses dispatch entirely.
      write(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32700, message: 'parse error' },
      }));
      continue;
    }

    const res = await handle(req, {
      tools: TOOL_DEFS,
      call: (name, args) => callTool(name, args, env),
    });
    if (res !== null) write(JSON.stringify(res));
  }
}

/** Wires the loop to the real stdio streams. */
export async function runMcpStdio(env: ToolEnv): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  await serveMcp(rl, (l) => process.stdout.write(`${l}\n`), env);
}
```

- [ ] **Step 4: Add the subcommand**

In `src/cli.ts`, beside the other commands:

```ts
  if (command === 'mcp') {
    const { runMcpStdio } = await import('./mcp/server.js');
    await runMcpStdio({
      cwd: process.cwd(),
      home: homedir(),
      rolesDir: join(packageRoot(), 'roles'),
      sessionId: process.env.CLAUDE_CODE_SESSION_ID,
    });
    return 0;
  }
```

Add `sonata mcp` to the USAGE text with the note `(started by Claude Code; not run by hand)`.

- [ ] **Step 5: Run the full suite, then commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/mcp/server.ts src/cli.ts tests/mcp/server.test.ts
git commit -m "$(cat <<'EOF'
feat: sonata mcp — the stdio JSON-RPC server

Input is injected so the loop is testable without a process, matching
how readKeys takes stdin in tui.ts. Malformed input answers with a parse
error and keeps serving: a server that dies takes the session's dispatch
capability with it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 9: `sonata verify`

Concurrent with Task 10.

**Files:**
- Create: `src/commands/verify.ts`
- Modify: `src/cli.ts`
- Create: `tests/commands/verify.test.ts`

**Interfaces:**
- Consumes: the run directory layout `<cwd>/.sonata/runs/<id>/meta.json`.
- Produces: `cmdVerify(opts: { cwd: string; id: string; model?: string }): { ok: boolean; detail: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/commands/verify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdVerify } from '../../src/commands/verify.js';

function runDirWith(meta: object): string {
  const cwd = mkdtempSync(join(tmpdir(), 'verify-'));
  const dir = join(cwd, '.sonata', 'runs', 'abc123');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  return cwd;
}

describe('cmdVerify', () => {
  const meta = { id: 'abc123', model: 'opencode-openrouter-kimi-k3', harness: 'opencode', role: 'explore' };

  it('confirms a run that exists', () => {
    const res = cmdVerify({ cwd: runDirWith(meta), id: 'abc123' });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('opencode-openrouter-kimi-k3');
  });

  it('fails for an id with no run, naming where it looked', () => {
    const res = cmdVerify({ cwd: runDirWith(meta), id: 'nope' });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('nope');
  });

  it('fails when the model does not match, naming both', () => {
    // What a fabricated or mis-attributed report looks like.
    const res = cmdVerify({ cwd: runDirWith(meta), id: 'abc123', model: 'something-else' });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('something-else');
    expect(res.detail).toContain('opencode-openrouter-kimi-k3');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/verify.test.ts`
Expected: FAIL — cannot resolve `../../src/commands/verify.js`.

- [ ] **Step 3: Write the implementation**

Create `src/commands/verify.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VerifyOptions { cwd: string; id: string; model?: string }

/**
 * Confirms a run actually happened, and on which model.
 *
 * The second layer under the wrapper's tool restriction: a fabricated report
 * carries no id that survives this.
 */
export function cmdVerify(opts: VerifyOptions): { ok: boolean; detail: string } {
  const dir = join(opts.cwd, '.sonata', 'runs', opts.id);
  const metaPath = join(dir, 'meta.json');
  if (!existsSync(metaPath)) {
    return { ok: false, detail: `no run "${opts.id}" — looked in ${dir}` };
  }

  let meta: { model?: string; harness?: string; role?: string; exitCode?: number; degraded?: boolean };
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return { ok: false, detail: `run "${opts.id}" has unreadable meta.json` };
  }

  if (opts.model !== undefined && meta.model !== opts.model) {
    return {
      ok: false,
      detail: `run "${opts.id}" ran ${meta.model}, not ${opts.model}`,
    };
  }

  const exit = meta.exitCode === undefined ? 'still running' : `exit ${meta.exitCode}`;
  return {
    ok: true,
    detail: `${opts.id}: ${meta.role} on ${meta.model} via ${meta.harness} · ${exit}` +
      (meta.degraded ? ' · degraded' : ''),
  };
}
```

- [ ] **Step 4: Add the subcommand**

In `src/cli.ts`:

```ts
  if (command === 'verify') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true, options: { model: { type: 'string' } },
    });
    const id = positionals[0];
    if (!id) throw new Error('sonata verify requires a run id');
    const { cmdVerify } = await import('./commands/verify.js');
    const res = cmdVerify({ cwd: process.cwd(), id, model: values.model });
    console.log(`${res.ok ? 'ok  ' : 'FAIL'} ${res.detail}`);
    return res.ok ? 0 : 1;
  }
```

Add it to USAGE.

- [ ] **Step 5: Run the full suite, then commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/commands/verify.ts src/cli.ts tests/commands/verify.test.ts
git commit -m "$(cat <<'EOF'
feat: sonata verify confirms a dispatch actually happened

A fabricated report carries no id that survives this. It is the second
layer deliberately: the first is the one that should never fail, and
this is how we would find out if it did.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 10: `doctor` completeness checks

Concurrent with Task 9.

**Files:**
- Modify: `src/commands/doctor.ts`
- Test: `tests/commands/doctor.test.ts`

**Interfaces:**
- Consumes: `generatedAgents`, `staleAgents`, `mcpConfigPath`, `mcpRegistered`, `configPath`.
- Produces: no new exports; new `Check` entries.

- [ ] **Step 1: Write the failing test**

Append to `tests/commands/doctor.test.ts`:

```ts
describe('cmdDoctor — completeness', () => {
  const MIN = `
[models."a"]
harness = "codex"
id = "gpt-5.6-sol"

[generate.roles]
code = ["a"]
`;
  const MARKER = 'forwarding wrapper around the sonata runtime';

  const setup = () => {
    const cwd = mkdtempSync(join(tmpdir(), 'doc-c-'));
    const home = mkdtempSync(join(tmpdir(), 'doc-h-'));
    writeFileSync(join(cwd, 'sonata.toml'), MIN);
    mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
    return { cwd, home };
  };
  const check = async (cwd: string, home: string, name: string) =>
    (await cmdDoctor({ cwd, home })).checks.find((c) => c.name === name);

  it('flags an agent naming a model the config does not define', async () => {
    const { cwd, home } = setup();
    writeFileSync(join(cwd, '.claude', 'agents', 'code-gone.md'), MARKER);
    expect((await check(cwd, home, 'agents'))?.ok).toBe(false);
  });

  it('flags an agent that still grants Bash', async () => {
    const { cwd, home } = setup();
    writeFileSync(join(cwd, '.claude', 'agents', 'code-a.md'),
      `---\nname: code-a\ntools: Bash\n---\n${MARKER}`);
    const c = await check(cwd, home, 'agent tools');
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain('sonata sync');
  });

  it('flags an unregistered MCP server', async () => {
    const { cwd, home } = setup();
    // The wrapper cannot report its own absence of tools, so doctor must.
    expect((await check(cwd, home, 'mcp server'))?.ok).toBe(false);
  });

  it('stays quiet on a healthy setup', async () => {
    const { cwd, home } = setup();
    writeFileSync(join(cwd, '.claude', 'agents', 'code-a.md'),
      `---\nname: code-a\ntools: mcp__sonata__run\n---\n${MARKER}`);
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
      mcpServers: { sonata: { command: 'node', args: [join('/pkg', 'dist', 'cli.js'), 'mcp'] } },
    }));
    const res = await cmdDoctor({ cwd, home, packageRoot: '/pkg' });
    for (const name of ['agents', 'agent tools', 'mcp server']) {
      expect(res.checks.find((c) => c.name === name)?.ok).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/doctor.test.ts -t completeness`
Expected: FAIL — no `agents`, `agent tools` or `mcp server` checks exist.

- [ ] **Step 3: Write the implementation**

`cmdDoctor` gains `packageRoot?: string` in its options. After the config check:

```ts
  const agentsDir = join(opts.cwd, '.claude', 'agents');
  const wanted = generatedAgents(config).map((a) => `${a.role}-${a.model}`);
  const stale = staleAgents(agentsDir, wanted);
  checks.push(stale.length === 0
    ? { name: 'agents', ok: true, detail: `${wanted.length} generated, none stale` }
    : {
        name: 'agents',
        ok: false,
        detail: `${stale.length} stale agent file(s) name models the config does not ` +
          `define — run \`sonata sync\` to remove them: ${stale.slice(0, 3).join(', ')}` +
          (stale.length > 3 ? ', …' : ''),
      });

  // An agent granting Bash can do the work itself instead of dispatching.
  const withBash = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((f) => f.endsWith('.md')).filter((f) => {
        const body = readFileSync(join(agentsDir, f), 'utf8');
        return body.includes('forwarding wrapper around the sonata runtime')
          && /^tools:\s*Bash\s*$/m.test(body);
      })
    : [];
  checks.push(withBash.length === 0
    ? { name: 'agent tools', ok: true, detail: 'no wrapper grants Bash' }
    : {
        name: 'agent tools',
        ok: false,
        detail: `${withBash.length} wrapper(s) still grant Bash and can do the work ` +
          'themselves — run `sonata sync`, then restart Claude Code',
      });

  const scope = resolved === join(opts.cwd, 'sonata.toml') ? 'project' : 'global';
  const mcpPath = mcpConfigPath(scope, opts.cwd, home);
  const registered = opts.packageRoot !== undefined
    && mcpRegistered(mcpPath, opts.packageRoot);
  checks.push(registered
    ? { name: 'mcp server', ok: true, detail: mcpPath }
    : {
        name: 'mcp server',
        ok: false,
        detail: `not registered in ${mcpPath} — wrappers would have no tools at all; ` +
          'run `sonata init`',
      });
```

Pass `packageRoot: packageRoot()` from `src/cli.ts`'s doctor branch.

- [ ] **Step 4: Run the full suite, then commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/commands/doctor.ts src/cli.ts tests/commands/doctor.test.ts
git commit -m "$(cat <<'EOF'
feat: doctor checks that a dispatch can actually work

Three failures this week were outside what doctor looked at: stale
agents naming undefined models, a wrapper that could do the work itself,
and a component that was simply absent. An unregistered MCP server is
the new failure this design introduces — a wrapper with no tools cannot
report its own absence, so doctor must.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 11: The wrapper loses Bash

Needs Tasks 2 and 6.

**Files:**
- Modify: `src/commands/sync.ts` (`agentMarkdown`)
- Test: `tests/commands/sync.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: generated agents granting only MCP tools.

- [ ] **Step 1: Write the failing test**

Append to `tests/commands/sync.test.ts`:

```ts
describe('agentMarkdown — tool grant', () => {
  const md = () => agentMarkdown({ role: 'code', model: 'm', harness: 'opencode' });

  it('grants only the three sonata MCP tools', () => {
    expect(md()).toContain(
      'tools: mcp__sonata__run, mcp__sonata__tail, mcp__sonata__approve');
  });

  it('never grants Bash', () => {
    // Bash is how a wrapper did 102 file reads and zero dispatches.
    expect(md()).not.toMatch(/^tools:.*\bBash\b/m);
  });

  it('tells the wrapper to call tools, not shell commands', () => {
    expect(md()).not.toContain('sonata run --role');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/sync.test.ts -t "tool grant"`
Expected: FAIL — the frontmatter says `tools: Bash`.

- [ ] **Step 3: Rewrite the frontmatter and the procedure**

In `agentMarkdown`, change the frontmatter line to:

```
tools: mcp__sonata__run, mcp__sonata__tail, mcp__sonata__approve
```

and replace the numbered procedure's shell commands with tool calls:

```
1. Start the run exactly once by calling the `run` tool with:
   role: ${spec.role}, model: ${spec.model}, and the full task text.
   It returns a run id immediately; the run continues in the background.

2. Poll by calling the `tail` tool with that id. Each call blocks until
   something changes or the tail window elapses, so this is cheap. Do not add
   your own waiting.
```

Keep the DONE / PAUSED / STALLED handling text, replacing `sonata approve` with
"call the `approve` tool". Add to the report contract:

```
Your final message must end with a line naming the run:

    run: <id>  model: ${spec.model}
```

- [ ] **Step 4: Run the full suite, then commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/commands/sync.ts tests/commands/sync.test.ts
git commit -m "$(cat <<'EOF'
fix: a wrapper agent can no longer do the work itself

The wrapper was told "you do no work of your own" and granted
tools: Bash. On 2026-08-12 two explore agents made 102 bash calls
reading a codebase directly and zero calls to sonata; the work was done
by Haiku and reported as though a foreign model had done it.

It now holds three MCP tools and nothing else, so there is no tool that
can read a file. tools: Bash(sonata:*) was tested first and silently
ignored — an agent carrying it read /etc/hosts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 12: `init` registers the server and offers to prune

Needs Tasks 3, 4, 7 and 11.

**Files:**
- Modify: `src/commands/init.ts`, `src/cli.ts`
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: `registerMcp`, `mcpConfigPath`, `pruneAgents`, `SyncResult`.
- Produces: `InitOptions.prune?: boolean`; `InitResult.mcpChanged: boolean`, `InitResult.pruned: string[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/init.test.ts`:

```ts
describe('cmdInit — MCP and pruning', () => {
  const detect = async () => ({
    tmux: { installed: true, version: '3.7b', problems: [] },
    harnesses: [{
      name: 'opencode', installed: true, version: '1.18.16', supported: true,
      refs: parseOpenCodeRefs('openrouter/kimi-k3\n'),
      authedProviders: ['openrouter'], problems: [],
    }],
  });
  const args = {
    packageRoot: '/pkg', yes: true, detect,
    providers: ['opencode/openrouter'], models: ['opencode-openrouter-kimi-k3'],
    roles: ['code'], scope: 'skip' as const, configScope: 'project' as const,
  };

  it('registers the MCP server in the config’s scope', async () => {
    const res = await cmdInit({ ...args, cwd, home, write });
    expect(res.mcpChanged).toBe(true);
    const parsed = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'));
    expect(parsed.mcpServers.sonata.args).toContain('mcp');
  });

  it('does not delete stale agents unless asked', async () => {
    await cmdInit({ ...args, cwd, home, write });
    const dir = join(cwd, '.claude', 'agents');
    writeFileSync(join(dir, 'code-gone.md'), 'forwarding wrapper around the sonata runtime');

    const res = await cmdInit({ ...args, cwd, home, write });
    expect(res.pruned).toEqual([]);
    expect(existsSync(join(dir, 'code-gone.md'))).toBe(true);
  });

  it('deletes them when --prune is given', async () => {
    await cmdInit({ ...args, cwd, home, write });
    const dir = join(cwd, '.claude', 'agents');
    writeFileSync(join(dir, 'code-gone.md'), 'forwarding wrapper around the sonata runtime');

    const res = await cmdInit({ ...args, cwd, home, prune: true, write });
    expect(res.pruned).toEqual(['code-gone.md']);
    expect(existsSync(join(dir, 'code-gone.md'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/init.test.ts -t "MCP and pruning"`
Expected: FAIL — `res.mcpChanged` is undefined.

- [ ] **Step 3: Wire it into `cmdInit`**

Add `prune?: boolean` to `InitOptions`, and `mcpChanged: boolean` and
`pruned: string[]` to `InitResult`. After the sync call:

```ts
  const sync = cmdSync({ cwd: opts.cwd, home: opts.home, agentsDir });
  out(`  ✓ generated ${sync.written.length} agents in ${agentsDir}`);

  const mcpPath = mcpConfigPath(configScope === 'global' ? 'global' : 'project',
    opts.cwd, opts.home);
  const mcp = registerMcp(mcpPath, opts.packageRoot);
  out(mcp.changed
    ? `  ✓ registered the sonata MCP server in ${mcpPath}`
    : `  · MCP server already registered in ${mcpPath}`);

  let pruned: string[] = [];
  if (sync.stale.length > 0) {
    out('');
    out(`  ! ${sync.stale.length} stale agent file(s) no longer in your config:`);
    for (const f of sync.stale.slice(0, 5)) out(`      ${f}`);
    if (sync.stale.length > 5) out(`      … and ${sync.stale.length - 5} more`);

    // Deletion is destructive: ask a person, require a flag from a script.
    const remove = opts.prune ?? (interactive && await confirm('Delete them?', true));
    if (remove) {
      pruned = pruneAgents(agentsDir, sync.stale);
      out(`  ✓ removed ${pruned.length} stale agent file(s)`);
    } else {
      out('      ❯ delete them by hand, or re-run with --prune');
    }
  }

  out('');
  out('  Done. Restart Claude Code so it picks up the agents and the MCP server.');
```

Add `--prune` to the `init` and `sync` branches of `src/cli.ts`, and have the
`sync` branch apply the same prompt-or-flag rule using `pruneAgents`.

- [ ] **Step 4: Run the full suite, then commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/commands/init.ts src/cli.ts tests/init.test.ts
git commit -m "$(cat <<'EOF'
feat: init registers the MCP server and offers to prune stale agents

A prompt when interactive, --prune when not: a scripted run that
silently deleted files would be a poor trade for tidiness. Only files
carrying sonata's marker are ever candidates.

The closing line now says a restart is required, because new tool grants
are not picked up mid-session — confirmed during design, when a changed
tools: line only applied after the registry refreshed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 13: Capture the real handshake

Not TDD. This is the evidence step, and the spec forbids trusting the protocol without it.

**Files:**
- Create: `tests/fixtures/mcp-handshake.jsonl`
- Modify: `tests/mcp/protocol.test.ts`

- [ ] **Step 1: Build and register**

```bash
npm run build
cd $(mktemp -d) && sonata init --yes --providers opencode/openrouter \
  --models opencode-openrouter-kimi-k3 --roles code --config-scope project --scope skip
```

- [ ] **Step 2: Capture what a real client sends**

Temporarily log every inbound line in `runMcpStdio`:

```ts
  const rl = createInterface({ input: process.stdin });
  const log = (l: string) => appendFileSync('/tmp/sonata-mcp-in.jsonl', `${l}\n`);
  await serveMcp((async function* () { for await (const l of rl) { log(l); yield l; } })(),
    (l) => process.stdout.write(`${l}\n`), env);
```

Restart Claude Code in that directory so it launches the server, then read
`/tmp/sonata-mcp-in.jsonl`. **Revert the logging afterwards.**

- [ ] **Step 3: Commit the capture as a fixture**

Save the captured lines to `tests/fixtures/mcp-handshake.jsonl` and add a test
replaying them through `handle`, asserting every response is well-formed JSON-RPC
with a matching id.

If the real `protocolVersion` differs from `FALLBACK_PROTOCOL_VERSION`, update
the constant to the captured value.

- [ ] **Step 4: Verify a real dispatch end to end**

In that directory, dispatch a generated agent and confirm a run directory
appears and `sonata verify <id>` passes. This is the check that would have
caught the 2026-08-12 failure.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/mcp-handshake.jsonl tests/mcp/protocol.test.ts src/mcp/protocol.ts
git commit -m "$(cat <<'EOF'
test: replace the assumed MCP handshake with a captured one

The protocol was written from documentation. This is the captured
exchange from a real Claude Code session, which is the rule that caught
every adapter bug in this repository — and the rule parsePiRefs still
does not satisfy.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

---

### Task 14: Documentation

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Update the config section in both**

Replace the `[generate]` example with:

```toml
[generate.roles]
code    = ["opencode-openrouter-kimi-k3"]
review  = ["opencode-openrouter-grok-4.5", "opencode-openai-gpt-5.6-sol"]
explore = ["opencode-opencode-go-deepseek-v4-flash"]
plan    = ["opencode-openai-gpt-5.6-terra"]
```

State that each role chooses its own models, that the flat `roles`/`models`
pair is no longer accepted, and that `sonata init` rewrites an old config.

- [ ] **Step 2: Document the wrapper's tools**

In `CLAUDE.md`, under the architecture section, record that a wrapper holds
`mcp__sonata__run`, `mcp__sonata__tail` and `mcp__sonata__approve` and no Bash,
and why: an agent with Bash did 102 file reads and zero dispatches on
2026-08-12. Note that `tools: Bash(sonata:*)` was tested and is silently
ignored, so nobody re-proposes it.

- [ ] **Step 3: Document the new commands**

Add `sonata mcp` and `sonata verify <id> [--model <key>]` to the command list in
both files, and `--prune` to the `init` and `sync` flags.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: per-role models, MCP-only wrappers, verify and prune

Records that tools: Bash(sonata:*) was tested and silently ignored, so
it is not re-proposed as a cheaper alternative to the MCP server.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0119sDQT9AWqPyL87rHHtkFN
EOF
)"
```

## Self-Review

**Spec coverage — per-role models.** Table shape and old-form rejection → Task 1. `generatedAgents` → Task 1, consumed in Tasks 2, 10. `tomlFor` → Task 3. Wizard → Task 3. Flags keep flat meaning → Task 3. Fixtures and docs → Tasks 1, 14.

**Spec coverage — dispatch integrity.** MCP tools on the wrapper → Task 11. Hand-rolled stdio server → Tasks 5, 6, 8. Captured handshake → Task 13. `sonata verify` → Task 9. `doctor` completeness → Task 10. Registration follows config scope → Tasks 7, 12. Stale-agent pruning → Tasks 4, 12. Restart notice → Task 12.

**Placeholders.** None. Every code step carries its code; every test step its test.

**Type consistency.** `SonataConfig.generate.roles` is `Record<string, string[]>` in Task 1 and read that way in Tasks 2, 3, 10. `generatedAgents` returns `{ role, model }[]` throughout. `SyncResult { written, stale }` is defined in Task 2 and consumed in Tasks 10, 12. `ToolDef` is defined in Task 5 and imported in Task 6. `ToolEnv` is defined in Task 6 and used in Task 8. `pruneAgents(agentsDir, files)` is defined in Task 4 and called in Task 12. `mcpConfigPath`/`mcpRegistered`/`registerMcp` are defined in Task 7 and used in Tasks 10, 12.

**Known temporary breakage.** Task 1 leaves `sync` and `init` compiling against a stopgap (`Object.values(...).flat()`); Tasks 2 and 3 replace it. This is called out in Task 1 Step 5 so a fresh implementer does not mistake it for an oversight.
