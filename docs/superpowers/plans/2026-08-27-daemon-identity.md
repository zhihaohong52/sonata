# Daemon Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sonata restart`/`startServeDaemon` unable to false-report success against a stale router, and turn `stopServe`'s dead-end refusal (no recorded pid) into an actionable message — without ever letting sonata kill a process it didn't spawn itself.

**Architecture:** A random instance id is generated once per `cmdServe` invocation and reported on `/__sonata_health`. `startServeDaemon` generates that id itself, passes it to its spawned child via an environment variable, and polls until a router reports back *that exact id* — not just any healthy sonata router. `stopServe`'s no-recorded-pid error gains a best-effort, print-only pid lookup (`lsof -ti:<port>`) so the user gets a copy-pasteable `kill <pid>` instead of "kill it by hand." A now-redundant identity re-check in `route.ts` (added earlier to guard exactly the race the instance id now closes structurally) is removed.

**Tech Stack:** TypeScript, Node's `node:crypto` (`randomUUID`), `node:child_process` (`execFileSync`), vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-daemon-identity-design.md`

## Global Constraints

- Sonata never kills a pid it did not itself record — the takeover fix is message-only; `lsof`'s output is printed, never acted on. (Spec, Decision 2.)
- The instance id is never persisted to `serve-state.json` — it lives only for the duration of one `startServeDaemon` call. (Spec, Decision 1, "Not persisted.")
- macOS/Linux only, matching the project's existing platform support — `lsof` is not expected on Windows. (Spec, Decision 2.)
- Config is re-read per request inside `cmdServe`'s `createRouterServer({...})` closures (existing convention in that file) — do not close over a cached config anywhere this plan touches.

---

### Task 1: Instance-id handshake — router reports it, `cmdServe` generates/reads it

**Files:**
- Modify: `src/native/router.ts` (`RouterDeps` interface, health handler — around line 19 and line 582-585)
- Modify: `src/commands/serve.ts` (`ServeDeps` interface around line 39-68; `cmdServe` around line 405-410; the `createRouterServer({...})` call around line 609-617; new export near `sonataRouterConfigPath` around line 173-190; import line 2)
- Test: `tests/commands/serve.test.ts` (update the existing health-endpoint test around line 184-195; add new tests)

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `RouterDeps.instanceId?: string` (native/router.ts) — reported on `/__sonata_health` as `instanceId: string | null`
  - `ServeDeps.instanceId?: string` (commands/serve.ts) — test seam; production default reads `process.env.SONATA_SERVE_INSTANCE_ID`, then falls back to `randomUUID()`
  - `export async function sonataRouterInstanceId(port: number, doFetch: typeof fetch = fetch): Promise<string | null>` (commands/serve.ts)

- [ ] **Step 1: Write the failing tests**

In `tests/commands/serve.test.ts`, update the existing health-endpoint test (around line 184-195) — it currently asserts the exact JSON shape with `toEqual`, which will fail once `instanceId` is added:

```ts
  it('serves a health endpoint on the router port', async () => {
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(),
      waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
    });
    handles.push(handle);

    const response = await fetch(serveHealthUrl(handle.routerPort));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'ok', sonata: true, configPath: join(cwd, 'sonata.toml'),
    });
    expect(typeof body.instanceId).toBe('string');
    expect(body.instanceId.length).toBeGreaterThan(0);
  });
```

Add two new tests directly after it, in the same `describe` block:

```ts
  it('reads its instance id from the environment when set, for a daemon-spawned process', async () => {
    const previous = process.env.SONATA_SERVE_INSTANCE_ID;
    process.env.SONATA_SERVE_INSTANCE_ID = 'fixed-test-id';
    try {
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(),
        waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
      });
      handles.push(handle);

      const response = await fetch(serveHealthUrl(handle.routerPort));
      const body = await response.json();
      expect(body.instanceId).toBe('fixed-test-id');
    } finally {
      if (previous === undefined) delete process.env.SONATA_SERVE_INSTANCE_ID;
      else process.env.SONATA_SERVE_INSTANCE_ID = previous;
    }
  });

  it('generates its own instance id when neither the env var nor an injected one is present', async () => {
    const previous = process.env.SONATA_SERVE_INSTANCE_ID;
    delete process.env.SONATA_SERVE_INSTANCE_ID;
    try {
      const handle = await cmdServe({
        cwd, home, tempDir: tempDirFor(),
        waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill() {} }),
      });
      handles.push(handle);

      const response = await fetch(serveHealthUrl(handle.routerPort));
      const body = await response.json();
      expect(typeof body.instanceId).toBe('string');
      expect(body.instanceId.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.SONATA_SERVE_INSTANCE_ID;
      else process.env.SONATA_SERVE_INSTANCE_ID = previous;
    }
  });
```

Add a new `describe` block right after the existing `describe('isSonataRouter', ...)` block (around line 1203-1210), following its exact style:

```ts
describe('sonataRouterInstanceId', () => {
  it('resolves the instance id from the sonata health payload', async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ status: 'ok', sonata: true, instanceId: 'abc-123' }))) as unknown as typeof fetch;
    expect(await sonataRouterInstanceId(4100, ok)).toBe('abc-123');
  });

  it('returns null for a non-sonata or malformed response', async () => {
    const notSonata = (async () => new Response(JSON.stringify({ status: 'ok' }))) as unknown as typeof fetch;
    const notJson = (async () => new Response('<html>')) as unknown as typeof fetch;
    const noId = (async () => new Response(JSON.stringify({ status: 'ok', sonata: true }))) as unknown as typeof fetch;
    expect(await sonataRouterInstanceId(4100, notSonata)).toBeNull();
    expect(await sonataRouterInstanceId(4100, notJson)).toBeNull();
    expect(await sonataRouterInstanceId(4100, noId)).toBeNull();
  });
});
```

And add `sonataRouterInstanceId` to the import block at the top of the file (currently line 7-10):

```ts
import {
  cmdServe, serveHealthUrl, type ServeHandle, isSonataRouter, occupiedPortMessage, startServeDaemon,
  serveStatePath, stopServe, cmdRestart, sonataRouterInstanceId,
} from '../../src/commands/serve.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands/serve.test.ts`
Expected: FAIL — `sonataRouterInstanceId` is not exported (the import itself fails, so the whole file fails to run), and the health payload has no `instanceId` field

- [ ] **Step 3: Implement — router.ts**

In `src/native/router.ts`, add to the `RouterDeps` interface, right after the existing `configPath` field (around line 19):

```ts
  /** The resolved sonata.toml path this router instance is running with, reported on /__sonata_health so a caller can tell two same-port routers apart by which config actually started them. */
  configPath?: string;
  /**
   * A random id generated once per `cmdServe` invocation, reported on
   * `/__sonata_health` so a caller that just spawned a daemon can tell its
   * own freshly-bound instance apart from an older, stale router that
   * happens to still be answering the same port.
   */
  instanceId?: string;
```

Update the health handler (around line 582-585):

```ts
      if (deps.health && new URL(req.url ?? '/', 'http://localhost').pathname === '/__sonata_health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok', sonata: true, configPath: deps.configPath ?? null, instanceId: deps.instanceId ?? null,
        }));
        return;
      }
```

- [ ] **Step 4: Implement — serve.ts**

Update the import at the top of `src/commands/serve.ts` (line 2) to also import `randomUUID`:

```ts
import { randomBytes, randomUUID } from 'node:crypto';
```

Add a new field to `ServeDeps` (right after the `recordUsage` field, before the closing brace of the interface — around line 68):

```ts
  /**
   * Test seam for the id `cmdServe` reports on `/__sonata_health`. Production
   * default reads `SONATA_SERVE_INSTANCE_ID` (set by `startServeDaemon` on the
   * child it spawns) and falls back to a freshly generated id when neither is
   * present — a foreground `sonata serve` with no daemon wrapper still needs
   * one.
   */
  instanceId?: string;
```

In `cmdServe`, right after the `masterKey` line (around line 406):

```ts
  const masterKey = `sk-sonata-${randomBytes(32).toString('hex')}`;
  const instanceId = opts.instanceId ?? process.env.SONATA_SERVE_INSTANCE_ID ?? randomUUID();
```

In the `createRouterServer({...})` call, add `instanceId` right after the `configPath` field (around line 617):

```ts
      configPath: resolveSonataConfigPath(opts.cwd, opts.home) ?? undefined,
      instanceId,
```

Add a new exported function right after `sonataRouterConfigPath` (around line 190, before `occupiedPortMessage`):

```ts
/** The instance id a running sonata router reports on /__sonata_health, or null if the port isn't a sonata router (or reports none). */
export async function sonataRouterInstanceId(
  port: number,
  doFetch: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await doFetch(serveHealthUrl(port), {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { sonata?: unknown; instanceId?: unknown };
    if (body?.sonata !== true) return null;
    return typeof body.instanceId === 'string' ? body.instanceId : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/commands/serve.test.ts`
Expected: PASS (all tests in the file, including the 3 new/updated ones)

- [ ] **Step 6: Typecheck, commit**

```bash
npm run typecheck
git add src/native/router.ts src/commands/serve.ts tests/commands/serve.test.ts
git commit -m "feat(serve): instance id on the health endpoint"
```

---

### Task 2: `startServeDaemon` waits for its own instance id, not any healthy router

**Files:**
- Modify: `src/commands/serve.ts` (`DaemonDeps` interface around line 717-723; `startServeDaemon` around line 744-789)
- Test: `tests/commands/serve.test.ts` (`describe('startServeDaemon', ...)` block, around line 1212-1301)

**Interfaces:**
- Consumes: `sonataRouterInstanceId` (Task 1)
- Produces: `DaemonDeps.probe?: (port: number, instanceId: string) => Promise<boolean>` (signature changed — was `(port: number) => Promise<boolean>`)

This is the direct regression test for the bug that motivated this whole plan: `startServeDaemon` must only report success once the router answering the port is the one it spawned, never a stale one that happens to already be there.

- [ ] **Step 1: Write the failing test**

In `tests/commands/serve.test.ts`, add a new test inside `describe('startServeDaemon', ...)`, right after the existing `'waits for the router rather than reporting success immediately'` test:

```ts
  it('does not accept a stale router with a different instance id as its own', async () => {
    // The exact bug this fixes: a stale daemon from a previous run is still
    // answering `sonata:true` on the port when a fresh spawn's poll begins.
    // The old check (`sonata === true`) would have accepted it immediately;
    // the fix must keep waiting until the id it generated itself is the one
    // reported back.
    let calls = 0;
    const result = await startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: fakeSpawn(),
      // First two probes see the stale router (wrong id); the third sees the
      // freshly-spawned one (matching id, since the real default probe reads
      // the id this call generated and passed to the child's env).
      probe: async (_port, id) => {
        calls += 1;
        return calls >= 3 ? true : false;
      },
      sleep: async () => {},
    });
    expect(calls).toBe(3);
    expect(result.port).toBe(4100);
  });

  it('sets SONATA_SERVE_INSTANCE_ID on the spawned child so it can report back the matching id', async () => {
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const spy = ((_cmd: string, _args: string[], o: { env?: NodeJS.ProcessEnv }) => {
      envs.push(o.env);
      return { pid: 4242, unref: () => {} };
    }) as unknown as typeof spawnType;

    await startServeDaemon(home, ['node', 'cli.js', 'serve'], {
      spawn: spy,
      probe: async () => true,
    });

    expect(typeof envs[0]?.SONATA_SERVE_INSTANCE_ID).toBe('string');
    expect(envs[0]?.SONATA_SERVE_INSTANCE_ID?.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands/serve.test.ts`
Expected: FAIL on the second new test (`'sets SONATA_SERVE_INSTANCE_ID on the spawned child...'`) — the spawned child's `env` option is currently unset (inherits `process.env` untouched, no `SONATA_SERVE_INSTANCE_ID` key added). The first new test (`'does not accept a stale router with a different instance id...'`) passes even before Step 3 — its inline probe stub takes an `id` parameter but never uses it to decide the return value, so it's exercising the *call shape* the fix depends on, not the real default probe; it becomes a meaningful regression test once Step 3 changes what the *default* probe (used when no `probe` is injected) actually does. That's expected and fine — it isn't a placeholder, it's asserting call counts against a scripted stub, same pattern as the existing `'waits for the router rather than reporting success immediately'` test right above it.

- [ ] **Step 3: Implement**

In `src/commands/serve.ts`, update the `DaemonDeps` interface (around line 717-723):

```ts
export interface DaemonDeps {
  spawn?: typeof spawn;
  /** Resolves true once the router answers on `port` with the given instance id. */
  probe?: (port: number, instanceId: string) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}
```

Update `startServeDaemon` (around line 744-789):

```ts
export async function startServeDaemon(
  home: string,
  argv: string[],
  deps: DaemonDeps = {},
  cwd: string = process.cwd(),
): Promise<DaemonResult> {
  const spawnFn = deps.spawn ?? spawn;
  const probe = deps.probe ?? (async (port: number, id: string) => (await sonataRouterInstanceId(port)) === id);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? 60_000;

  const config = loadConfig(cwd, home);
  if (!config.native) throw new Error('sonata serve: no [native] table');
  const port = config.native.ports.router;

  const logPath = timestampedLogPath(home, 'serve');
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a');

  // Generated here, before spawning, and handed to the child via its own
  // environment — so the polling loop below can tell its own freshly-spawned
  // process apart from a stale router that happens to still be answering the
  // same port, which is what let `sonata restart` false-report success
  // against a leftover daemon (see the design doc for the reproduction).
  const instanceId = randomUUID();

  // Explicit, not inherited: a daemon started to serve *every* project
  // (`route on/auto --global`) must not bind itself to whichever project's
  // session happened to trigger it first — the router is a single process,
  // so its config has to be the one every routed project actually shares.
  // The caller passes `home` here for that case (see route.ts); a plain
  // `sonata serve --daemon` keeps inheriting the shell's own cwd.
  const child = spawnFn(argv[0], argv.slice(1), {
    detached: true,
    stdio: ['ignore', log, log],
    cwd,
    env: { ...process.env, SONATA_SERVE_INSTANCE_ID: instanceId },
  });
  child.unref();

  const deadline = now() + timeoutMs;
  for (;;) {
    if (await probe(port, instanceId)) return { pid: child.pid ?? 0, port, logPath };
    if (now() > deadline) {
      throw new Error(
        `sonata serve: the daemon did not answer on port ${port} within ${Math.round(timeoutMs / 1000)}s. ` +
        `See ${logPath}`,
      );
    }
    await sleep(500);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands/serve.test.ts`
Expected: PASS (all tests, including the two new ones)

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/commands/serve.ts tests/commands/serve.test.ts
git commit -m "fix(serve): startServeDaemon waits for its own instance id, not any healthy router"
```

---

### Task 3: `stopServe`'s actionable takeover message

**Files:**
- Modify: `src/commands/serve.ts` (`StopDeps` interface around line 790-798; `stopServe` around line 833-880; import line 3)
- Test: `tests/commands/serve.test.ts` (`describe('stopServe', ...)` block, around line 1307-1391)

**Interfaces:**
- Consumes: nothing new
- Produces: `StopDeps.findPortPid?: (port: number) => string | undefined`

- [ ] **Step 1: Write the failing tests**

In `tests/commands/serve.test.ts`, update the existing test `'refuses to kill when the port answers sonata but no pid was ever recorded'` (around line 1358-1363) — it currently calls `stopServe` with no `findPortPid`, which would fall through to the real `lsof`-based default and behave nondeterministically in CI. Make it deterministic by injecting the seam explicitly:

```ts
  it('refuses to kill when the port answers sonata but no pid was ever recorded', async () => {
    // Never guess a pid by scanning the OS — only a pid sonata itself
    // recorded is ever killed. `findPortPid` here simulates the lookup
    // itself failing (or finding nothing), so the message falls back to the
    // generic wording rather than naming a pid.
    await expect(stopServe({ cwd, home, probeHealth: sonataHealth, findPortPid: () => undefined }))
      .rejects.toThrow(/no recorded pid/);
  });
```

Add two new tests directly after it, in the same `describe` block:

```ts
  it('names a killable pid when the port lookup finds exactly one', async () => {
    // Sonata still never kills this pid itself — the message only prints it,
    // as a copy-pasteable next step for the user.
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, findPortPid: () => '48213',
    }).catch((e) => e as Error);
    expect((result as Error).message).toMatch(/kill 48213/);
  });

  it('falls back to the generic message when the port lookup is unavailable or ambiguous', async () => {
    const result = await stopServe({
      cwd, home, probeHealth: sonataHealth, findPortPid: () => undefined,
    }).catch((e) => e as Error);
    expect((result as Error).message).toMatch(/no recorded pid/);
    expect((result as Error).message).not.toMatch(/kill \d/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands/serve.test.ts`
Expected: FAIL on `'names a killable pid when the port lookup finds exactly one'` — before Step 3, `stopServe` doesn't read `findPortPid` at all, so its error message is still the old generic wording with no `kill 48213` text to match. The updated `'refuses to kill...'` test and the new `'falls back to the generic message...'` test both pass even before Step 3 (the old message already matches `/no recorded pid/` and already contains no `kill \d` pattern) — that's expected; the "found a pid" case is what actually drives this step's implementation.

- [ ] **Step 3: Implement**

Update the import at the top of `src/commands/serve.ts` (line 3) to also import `execFileSync`:

```ts
import { spawn, execFileSync } from 'node:child_process';
```

Add a default lookup function, right before the `StopDeps` interface (around line 790):

```ts
/**
 * Finds the OS pid bound to a TCP port, purely so `stopServe` can print it —
 * sonata never acts on what this returns. `lsof -ti` prints one pid per line;
 * an empty or ambiguous (more than one) result means "don't know", which the
 * caller treats the same as a lookup failure.
 */
function defaultFindPortPid(port: number): string | undefined {
  try {
    const out = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).trim();
    if (out === '') return undefined;
    const pids = out.split('\n').filter((line) => line !== '');
    return pids.length === 1 ? pids[0] : undefined;
  } catch {
    return undefined;
  }
}

export interface StopDeps {
  probeHealth?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Test seam — production default is `process.kill`. */
  kill?: (pid: number) => void;
  /** Test seam — production default checks the OS for the pid. */
  isAlive?: (pid: number) => boolean;
  /**
   * Test seam — production default shells out to `lsof -ti:<port>` purely to
   * *print* the result in the takeover message below; sonata never kills a
   * pid this way itself. Returns `undefined` on any failure or ambiguity
   * (0 or more than 1 pid found).
   */
  findPortPid?: (port: number) => string | undefined;
}
```

Update `stopServe`'s no-recorded-pid branch (around line 846-852):

```ts
  const state = readServeState(opts.home);
  if (state?.routerPid === undefined && state?.litellmPid === undefined) {
    const findPortPid = opts.findPortPid ?? defaultFindPortPid;
    const foundPid = findPortPid(port);
    const nextStep = foundPid !== undefined
      ? ` Kill it yourself, then run \`sonata serve --daemon\`:\n  kill ${foundPid}`
      : ' Kill it by hand, then run `sonata serve --daemon`.';
    throw new Error(
      `sonata restart: router port ${port} answers as a sonata router, but no recorded pid for it ` +
      `was found in ${serveStatePath(opts.home)} — it may have been started by a different sonata ` +
      `install or an older version.${nextStep}`,
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands/serve.test.ts`
Expected: PASS (all tests, including the 3 updated/new ones)

- [ ] **Step 5: Typecheck, full suite, verify by hand, commit**

```bash
npm run typecheck && npm test
node dist/cli.js restart   # only if you have a stale, unrecorded router to test against by hand; otherwise skip
git add src/commands/serve.ts tests/commands/serve.test.ts
git commit -m "fix(serve): stopServe prints a killable pid instead of a dead-end refusal"
```

---

### Task 4: Remove `route.ts`'s now-redundant post-spawn identity re-check

**Files:**
- Modify: `src/commands/route.ts` (the `if (!running) { ... }` block around line 684-711)
- Test: `tests/commands/route.test.ts` (delete two obsolete tests around line 652-683 and 699-720; keep the two tests for the *pre-spawn* check, around line 627-649 and 685-698, fully untouched)

**Interfaces:**
- Consumes: nothing new — Task 2's fix inside `startServeDaemon` is what makes this removal safe
- Produces: nothing new — this task only deletes now-redundant code and its now-obsolete tests

There are **two** configPath identity checks in this function today, and they guard different things — only the second is being removed:

1. **Pre-spawn check** (`if (running && deps.probe === undefined) { ... }`, around line 665-680): verifies an *already-running* router (found before this call ever tried to start anything) belongs to the right project's config. This is unrelated to daemon-spawn races and **must stay**.
2. **Post-spawn check** (`if (!running) { await startDaemon(...); if (deps.probe === undefined) { ... } }`, around line 684-711): re-verifies identity specifically because, before Task 2's fix, `startServeDaemon` could report success against a *different* concurrent spawn that won the same port. Task 2 closes this race structurally — `startServeDaemon` now only returns once the router answering is confirmed to be carrying the exact instance id it generated for its own spawn. This check is what gets removed.

- [ ] **Step 1: Delete the obsolete tests**

In `tests/commands/route.test.ts`, delete these two tests in their entirety (they test the post-spawn check's behavior via a stubbed `startDaemon` that bypasses the real `startServeDaemon` — so they cannot be "fixed to still pass" by relying on Task 2's guarantee, since that guarantee lives inside the very function these tests stub out):

- `'re-checks identity after starting a daemon, catching a racing project that won the port'` (around line 652-683)
- `'re-checks identity after starting a daemon, refusing a router that reports no configPath'` (around line 699-720)

Do **not** touch these two tests — they cover the pre-spawn check, which is not changing:

- `'refuses to share a router port already serving a different project\'s config'` (around line 627-649)
- `'refuses a running router that reports no configPath at all'` (around line 685-698)

- [ ] **Step 2: Run the full route test file to confirm the deletion alone doesn't break anything else**

Run: `npx vitest run tests/commands/route.test.ts`
Expected: PASS — deleting a test doesn't change production behavior yet, so nothing regresses at this point; this just confirms the file is still valid TypeScript and the remaining tests are unaffected.

- [ ] **Step 3: Remove the post-spawn check from `route.ts`**

In `src/commands/route.ts`, inside the `if (!running) { await startDaemon(opts.home, opts.serveArgv, {}, configCwd); ... }` block (around line 684-711), remove the `if (deps.probe === undefined) { ... }` re-check entirely, leaving just the daemon start:

```ts
    if (!running) {
      await startDaemon(opts.home, opts.serveArgv, {}, configCwd);
    }
```

(This deletes the comment block and the `sonataRouterConfigPath`/throw logic that followed it — everything between `await startDaemon(...)` and the closing `}` of the `if (!running)` block, EXCEPT the `await startDaemon(...)` call itself.)

Leave the pre-spawn check (`if (running && deps.probe === undefined) { ... }`, above this block) completely untouched.

- [ ] **Step 4: Run tests to verify nothing regresses**

Run: `npx vitest run tests/commands/route.test.ts`
Expected: PASS — the two remaining pre-spawn-check tests still pass unchanged; the two deleted tests are gone; no other test in the file references the removed code path.

- [ ] **Step 5: Typecheck, full suite, verify the real regression coverage exists one layer down, commit**

```bash
npm run typecheck && npm test
```

Confirm Task 2's `'does not accept a stale router with a different instance id as its own'` test (in `tests/commands/serve.test.ts`) is what now covers the underlying race this removed code used to guard — that test should already be passing from Task 2's commit.

```bash
git add src/commands/route.ts tests/commands/route.test.ts
git commit -m "refactor(route): remove the post-spawn identity re-check startServeDaemon's instance id now makes redundant"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Decision 1: identity handshake (instance id on health, env var, generation fallback) | 1 |
| Decision 1: `startServeDaemon` waits for its own id | 2 |
| Decision 1, "Simplification this enables": remove `route.ts`'s redundant re-check | 4 |
| Decision 1, "Not persisted": no `serve-state.json` change | Implicit — no task touches `ServeState`/`serveStatePath`'s schema |
| Decision 2: actionable takeover message, `lsof`-based, message-only | 3 |
| Decision 2: fallback to generic wording on lookup failure | 3 |
| Edge case: pre-change router with no `instanceId` field times out normally | Implicit — `sonataRouterInstanceId` returns `null` for a response with no `instanceId` field, which never equals a generated UUID, so the existing timeout path in `startServeDaemon` (unchanged) handles it; no separate task needed |
| Edge case: `cmdRestart` unaffected structurally | Implicit — Tasks 2 and 3 change `startServeDaemon`/`stopServe` internals only; `cmdRestart`'s call sequence (`stopServe` then `startServeDaemon`) is untouched by any task |
| Testing: instance-id-aware probe test | 2 |
| Testing: `cmdServe` env var / fallback test | 1 |
| Testing: takeover message found/not-found tests | 3 |
| Testing: `route.ts`'s race test still covered one layer down | 4 |

No gaps found.

**Placeholder scan:** No TBD/TODO. Every step carries real, complete code — including the exact deletion boundaries in Task 4, since "remove this block" without showing the resulting code would leave an implementer guessing where the block actually ends.

**Type consistency:** `DaemonDeps.probe`'s signature change (Task 2, `(port, instanceId) => Promise<boolean>`) doesn't affect `route.ts`'s own `startDaemon` field, which is already loosely typed (`deps?: unknown`) — confirmed by reading the current code, so no cascading type change needed there. `sonataRouterInstanceId` (Task 1) is consumed by `startServeDaemon`'s default probe (Task 2) with the exact signature Task 1 produces (`(port: number, doFetch?) => Promise<string | null>`, called here with just `port`). `StopDeps.findPortPid` (Task 3) and `DaemonDeps`/`ServeDeps` (Tasks 1-2) are independent additions to three different interfaces — no naming collision, no shared field.
