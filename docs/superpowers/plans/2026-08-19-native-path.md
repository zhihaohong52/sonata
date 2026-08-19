# Native Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a sonata-configured foreign model run as a *native* Claude Code subagent — Claude Code's own loop, tools, and permission modes — via a local routing proxy, delivered as `sonata serve`/`sonata code`/`sonata auth` plus a `claude` harness adapter.

**Architecture:** A `[native]` table in `sonata.toml` describes foreign models, the gateways that serve them, and the roles that use them. `sonata serve` runs a zero-dependency router (`claude-*` → Anthropic with the client's own auth forwarded byte-for-byte; everything else → a managed LiteLLM child that translates to the gateway). `sonata code` points a `claude` session at the router. `sonata sync` also generates real (non-wrapper) native agent files. A fifth `claude` harness adapter lets unproxied sessions dispatch foreign-on-Claude-loop through the existing MCP path.

**Tech Stack:** TypeScript (Node 22, ESM, `.js` import specifiers), vitest, smol-toml, tmux, LiteLLM (external prerequisite, like tmux).

**Spec:** `docs/superpowers/specs/2026-08-19-native-path-design.md`

## Global Constraints

- **`sonata` on PATH runs `dist/`, not `src/`.** Run `npm run build` before any live/CLI check; tests run against `src/` via vitest.
- **Tests need no API keys and no network.** Router tests hit fake local upstreams; credential tests use fixture files; init tests inject a detector. Follow the fake-harness pattern in `tests/`.
- **Every TOML key and value is written through `tomlKey`** (escapes dotted keys and control chars). Never string-concatenate a raw key.
- **A `[native.models]` id or key beginning `claude-` is refused at parse time** — the router routes on that prefix, so such a model would silently reach Anthropic. This rule is load-bearing and appears in parsing, doctor, and a test.
- **Keys never leave their path:** store → `sonata serve` memory → LiteLLM child env. Never logged, never written by sonata except its own `auth add` file, never placed in a Claude conversation. Router logs method/path/upstream only.
- **The user starts `sonata serve`.** Nothing in sonata may assume it can launch an auth-forwarding proxy from inside a Claude session — the auto-mode classifier blocks that, correctly.
- Run `npm test` and `npm run typecheck` before считая a task done; both must be green.
- Match existing file conventions: focused modules, comments that state constraints (not narration), `home` injected in tests.

## File Structure

- `src/config.ts` — extend `SonataConfig` with a `native` field; parse `[native.*]` and `[generate.native]`; the `claude-` refusal; `generatedNativeAgents()`.
- `src/native/router.ts` (new) — the request router as a testable factory over an injected `fetch`.
- `src/native/litellm.ts` (new) — generate a LiteLLM config object/string from `[native]`; locate the binary.
- `src/native/credentials.ts` (new) — the credential resolution chain (sonata store → discovered agent stores), source-labelled, value-hiding.
- `src/commands/serve.ts` (new) — start router + LiteLLM child, health endpoint, `--daemon`, teardown.
- `src/commands/code.ts` (new) — ensure serve, build env, exec `claude`.
- `src/commands/auth.ts` (new) — `add`/`list`/`remove` against the sonata key store.
- `src/commands/sync.ts` — second generator: `nativeAgentMarkdown()` + write `native-<role>-<model>.md`.
- `src/commands/init.ts` — native model/role screens + key check; unattended flags.
- `src/commands/doctor.ts` — LiteLLM, serve health, key source, prefix-collision, stale-native checks.
- `src/adapters/claude.ts` (new) + `src/adapters/index.ts` + `KNOWN_HARNESSES` — the fifth adapter (Deliverable B).
- `src/cli.ts` — wire `serve`, `code`, `auth`; extend `init` flags; USAGE.
- `tests/native/*.test.ts`, `tests/commands/{serve,code,auth}.test.ts`, `tests/adapters/claude.test.ts` — coverage.

---

### Task 1: `[native]` config parsing and the `claude-` refusal

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: existing `parseConfig(text: string): SonataConfig`.
- Produces:
  ```ts
  export interface NativeModelConfig { gateway: string; id: string; contextWindow: number }
  export interface NativeGatewayConfig { baseUrl: string }
  export interface NativeConfig {
    models: Record<string, NativeModelConfig>;
    gateways: Record<string, NativeGatewayConfig>;
    ports: { router: number; litellm: number };
    generate: Record<string, string[]>; // role -> native model keys
  }
  // SonataConfig gains: native?: NativeConfig
  export function generatedNativeAgents(config: SonataConfig): { role: string; model: string }[]
  ```
  Defaults: `ports.router = 4100`, `ports.litellm = 4000`. `[native]` absent → `native` is `undefined` and nothing else changes.

- [ ] **Step 1: Write failing tests**

```ts
// tests/config.test.ts — add
it('parses a [native] table with models, gateways, ports and generate', () => {
  const cfg = parseConfig(`
[native.models."deepseek-v4-flash"]
gateway = "anexto"
id = "deepseek-v4-flash-0731"
context_window = 128000
[native.gateways."anexto"]
base_url = "https://bifrost.advai.net/v1"
[generate.native]
code = ["deepseek-v4-flash"]
`);
  expect(cfg.native?.models['deepseek-v4-flash']).toEqual({
    gateway: 'anexto', id: 'deepseek-v4-flash-0731', contextWindow: 128000,
  });
  expect(cfg.native?.gateways['anexto'].baseUrl).toBe('https://bifrost.advai.net/v1');
  expect(cfg.native?.ports).toEqual({ router: 4100, litellm: 4000 });
  expect(cfg.native?.generate.code).toEqual(['deepseek-v4-flash']);
});

it('leaves native undefined when no [native] table is present', () => {
  expect(parseConfig(`[models."x"]\nharness="codex"\nid="gpt"`).native).toBeUndefined();
});

it('refuses a native model id beginning claude-', () => {
  expect(() => parseConfig(`
[native.models."sneaky"]
gateway = "g"
id = "claude-opus-5"
context_window = 1000
[native.gateways."g"]
base_url = "http://x"
`)).toThrow(/claude-/);
});

it('refuses a native model key beginning claude-', () => {
  expect(() => parseConfig(`
[native.models."claude-ish"]
gateway = "g"
id = "foo"
context_window = 1000
[native.gateways."g"]
base_url = "http://x"
`)).toThrow(/claude-/);
});

it('refuses generate.native referencing an undefined native model', () => {
  expect(() => parseConfig(`
[native.models."a"]
gateway="g"
id="a1"
context_window=1000
[native.gateways."g"]
base_url="http://x"
[generate.native]
code = ["missing"]
`)).toThrow(/unknown native model "missing"/);
});

it('refuses a native model naming an undefined gateway', () => {
  expect(() => parseConfig(`
[native.models."a"]
gateway="nope"
id="a1"
context_window=1000
`)).toThrow(/unknown gateway "nope"/);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL (native undefined / no such property).

- [ ] **Step 3: Implement**

In `src/config.ts`: add the interfaces above; add `native?: NativeConfig` to `SonataConfig`. After the existing `models`/`generate.roles` parsing, when `raw.native !== undefined`, build `NativeConfig`:
- For each `[native.models.<key>]`: require string `gateway`, string `id`, number `context_window`. **Refuse** if `key.startsWith('claude-')` or `(id as string).startsWith('claude-')` with a message naming the router-prefix reason. Refuse an unknown `gateway` (not present in `[native.gateways]`).
- For each `[native.gateways.<key>]`: require string `base_url`.
- `ports` from `raw.native.ports` with the 4100/4000 defaults via the existing `num` helper.
- `generate.native` from `raw.generate?.native`: each role in `KNOWN_ROLES`, each list a string array, each entry present in `native.models` (else "unknown native model").
- Add `generatedNativeAgents(config)` mirroring `generatedAgents` but over `config.native?.generate ?? {}`.

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run tests/config.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): parse [native] models, gateways, ports; refuse claude- prefix"
```

---

### Task 2: The router

**Files:**
- Create: `src/native/router.ts`
- Test: `tests/native/router.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RouterDeps {
    fetch: typeof fetch;               // injected; real one in production
    anthropicBase?: string;            // default 'https://api.anthropic.com'
    litellmBase: string;               // e.g. 'http://localhost:4000'
    litellmKey: string;                // master key for the LiteLLM child
    log?: (line: string) => void;      // method/path/upstream only
  }
  // Pure request handler, HTTP-server-agnostic, so it is testable without a socket.
  export function routeRequest(
    req: { method: string; url: string; headers: Record<string,string>; body: Buffer },
    deps: RouterDeps,
  ): Promise<{ status: number; headers: Record<string,string>; body: AsyncIterable<Uint8Array> | Buffer }>
  export function createRouterServer(deps: RouterDeps): import('node:http').Server
  ```

- [ ] **Step 1: Write failing tests** (inject a fake `fetch` recording target + headers)

```ts
// tests/native/router.test.ts
import { routeRequest } from '../../src/native/router.js';

function fakeFetch(record: any[]) {
  return async (url: string, init: any) => {
    record.push({ url, headers: init.headers });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const base = { litellmBase: 'http://lite', litellmKey: 'sk-local', anthropicBase: 'https://api.anthropic.com' };

it('routes a claude- model to anthropic with client headers forwarded', async () => {
  const rec: any[] = [];
  await routeRequest(
    { method: 'POST', url: '/v1/messages', headers: { authorization: 'Bearer usr', 'x-api-key': 'k' },
      body: Buffer.from(JSON.stringify({ model: 'claude-sonnet-5' })) },
    { ...base, fetch: fakeFetch(rec) });
  expect(rec[0].url).toBe('https://api.anthropic.com/v1/messages');
  expect(rec[0].headers.authorization).toBe('Bearer usr'); // untouched
});

it('routes a foreign model to litellm with the local key', async () => {
  const rec: any[] = [];
  await routeRequest(
    { method: 'POST', url: '/v1/messages', headers: { authorization: 'Bearer usr', 'x-api-key': 'k' },
      body: Buffer.from(JSON.stringify({ model: 'deepseek-v4-flash' })) },
    { ...base, fetch: fakeFetch(rec) });
  expect(rec[0].url).toBe('http://lite/v1/messages');
  expect(rec[0].headers.authorization).toBe('Bearer sk-local');
  expect(rec[0].headers['x-api-key']).toBeUndefined();
});

it('passes a bodyless request through to anthropic', async () => {
  const rec: any[] = [];
  await routeRequest({ method: 'GET', url: '/v1/models', headers: {}, body: Buffer.alloc(0) },
    { ...base, fetch: fakeFetch(rec) });
  expect(rec[0].url).toBe('https://api.anthropic.com/v1/models');
});

it('returns 502 with a typed body when the upstream throws', async () => {
  const res = await routeRequest(
    { method: 'POST', url: '/v1/messages', headers: {}, body: Buffer.from('{"model":"deepseek-v4-flash"}') },
    { ...base, fetch: async () => { throw new Error('down'); } });
  expect(res.status).toBe(502);
  expect(JSON.parse((res.body as Buffer).toString()).error.type).toBe('router_error');
});
```

- [ ] **Step 2: Run → FAIL** (`npx vitest run tests/native/router.test.ts`).

- [ ] **Step 3: Implement.** `routeRequest`: parse `model` from the JSON body inside a try/catch (parse failure or empty body → Anthropic). Choose target/base. Copy headers minus `host`/`content-length`; for the LiteLLM branch set `authorization: Bearer <litellmKey>` and delete `x-api-key`. `log?.(\`${method} ${url} -> ${which}\`)`. `fetch`, strip hop-by-hop response headers (`content-encoding`, `transfer-encoding`, `content-length`, `connection`), stream the body through. On throw, return 502 `{error:{type:'router_error',message}}`. `createRouterServer` wraps it in `http.createServer`, reading the body to a Buffer first. Port both from the spike `router.mjs`; keep it dependency-free.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/native/router.ts tests/native/router.test.ts
git commit -m "feat(native): request router — claude- to anthropic, others to litellm"
```

---

### Task 3: LiteLLM config generation and discovery

**Files:**
- Create: `src/native/litellm.ts`
- Test: `tests/native/litellm.test.ts`

**Interfaces:**
- Consumes: `NativeConfig`.
- Produces:
  ```ts
  // Builds the LiteLLM proxy config. Keys are NOT embedded — each model's
  // api_key is "os.environ/SONATA_KEY_<GATEWAY>", resolved from the child env.
  export function litellmConfig(native: NativeConfig, masterKey: string): {
    model_list: Array<{ model_name: string; litellm_params: Record<string, unknown> }>;
    litellm_settings: { drop_params: true };
    general_settings: { master_key: string };
  }
  export function litellmConfigYaml(native: NativeConfig, masterKey: string): string
  export function envVarForGateway(gateway: string): string // "SONATA_KEY_<UPPER_SNAKE>"
  export function findLitellm(): string | null // PATH lookup; null if absent
  ```

- [ ] **Step 1: Failing tests**

```ts
it('emits one model_list entry per native model, keyed by env, never the key itself', () => {
  const cfg = litellmConfig({
    models: { 'deepseek-v4-flash': { gateway: 'anexto', id: 'deepseek-v4-flash-0731', contextWindow: 128000 } },
    gateways: { anexto: { baseUrl: 'https://bifrost.advai.net/v1' } },
    ports: { router: 4100, litellm: 4000 }, generate: {},
  }, 'sk-master');
  const e = cfg.model_list[0];
  expect(e.model_name).toBe('deepseek-v4-flash');
  expect(e.litellm_params.model).toBe('openai/deepseek-v4-flash-0731');
  expect(e.litellm_params.api_base).toBe('https://bifrost.advai.net/v1');
  expect(e.litellm_params.api_key).toBe('os.environ/SONATA_KEY_ANEXTO');
  expect(cfg.general_settings.master_key).toBe('sk-master');
  expect(cfg.litellm_settings.drop_params).toBe(true);
  expect(JSON.stringify(cfg)).not.toContain('sk-master-value'); // sanity: only master_key placeholder
});
it('maps a gateway name to an env var', () => {
  expect(envVarForGateway('anexto')).toBe('SONATA_KEY_ANEXTO');
  expect(envVarForGateway('open-router')).toBe('SONATA_KEY_OPEN_ROUTER');
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `litellm_params.model` is `openai/<id>` (LiteLLM's OpenAI-compatible prefix). `api_key` is the `os.environ/…` placeholder. `litellmConfigYaml` serialises deterministically (simple hand-rolled YAML or `JSON`→documented; a fixture pins the shape). `findLitellm` checks `PATH` for `litellm` (reuse the pattern doctor uses for other binaries).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(native): generate LiteLLM config from [native], keys via env`.

---

### Task 4: Credential resolution chain

**Files:**
- Create: `src/native/credentials.ts`
- Test: `tests/native/credentials.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface KeySource { gateway: string; source: string /* 'sonata' | 'opencode' | ... */; key: string }
  export interface KeyReport { gateway: string; source: string | null } // value never included
  // Resolves each gateway's key, first hit wins: sonata store, then discovered
  // agent stores. Reads files under `home`; pure over an injected fs is fine.
  export function resolveKeys(gateways: string[], home: string): KeySource[]
  export function keyReport(gateways: string[], home: string): KeyReport[] // for doctor/init; no values
  export function sonataKeyStorePath(home: string): string // ~/.config/sonata/keys.json
  export function writeSonataKey(home: string, gateway: string, key: string): void // chmod 600
  export function removeSonataKey(home: string, gateway: string): void
  ```

- [ ] **Step 1: Failing tests** (write fixture stores under a tmp `home`)

```ts
it('prefers the sonata store over a discovered opencode key', () => {
  const home = tmp();
  writeSonataKey(home, 'anexto', 'sonata-key');
  writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ anexto: { key: 'oc-key' }}));
  const [r] = resolveKeys(['anexto'], home);
  expect(r).toMatchObject({ gateway: 'anexto', source: 'sonata', key: 'sonata-key' });
});
it('falls back to opencode when sonata has no key', () => {
  const home = tmp();
  mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
  writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ anexto: { key: 'oc-key' }}));
  expect(resolveKeys(['anexto'], home)[0]).toMatchObject({ source: 'opencode', key: 'oc-key' });
});
it('keyReport never includes the key value', () => {
  const home = tmp(); writeSonataKey(home, 'anexto', 'secret');
  const rep = keyReport(['anexto'], home);
  expect(rep[0]).toEqual({ gateway: 'anexto', source: 'sonata' });
  expect(JSON.stringify(rep)).not.toContain('secret');
});
it('reports source null for a gateway with no key anywhere', () => {
  expect(keyReport(['ghost'], tmp())[0]).toEqual({ gateway: 'ghost', source: null });
});
it('writeSonataKey creates a 0600 file', () => {
  const home = tmp(); writeSonataKey(home, 'anexto', 'k');
  expect(statSync(sonataKeyStorePath(home)).mode & 0o777).toBe(0o600);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Sonata store: `~/.config/sonata/keys.json` `{ "<gateway>": "<key>" }`, written with `{ mode: 0o600 }` and re-`chmodSync` to be safe. Discovered sources: a small ordered list of `{ name, read(home): Record<gateway,key> }`; start with opencode (`~/.local/share/opencode/auth.json`, entries shaped `{ key }` or `{ apiKey }`); only add a source whose stored credential is a usable API key — do NOT add codex OAuth. `resolveKeys` returns first match per gateway; `keyReport` maps to `{gateway, source|null}` with no value. Reads only; never logs.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(native): credential chain — sonata store then discovered agent stores`.

---

### Task 5: `sonata auth` command

**Files:**
- Create: `src/commands/auth.ts`
- Modify: `src/cli.ts` (wire `auth`, USAGE)
- Test: `tests/commands/auth.test.ts`

**Interfaces:**
- Consumes: Task 4's `writeSonataKey`/`removeSonataKey`/`keyReport`.
- Produces:
  ```ts
  export function cmdAuthList(opts: { home: string; gateways: string[] }): { text: string }
  export function cmdAuthAdd(opts: { home: string; gateway: string; key: string }): void
  export function cmdAuthRemove(opts: { home: string; gateway: string }): void
  ```
  (The interactive key prompt lives in `cli.ts`; `cmdAuthAdd` takes the key as a param so it is testable without a TTY.)

- [ ] **Step 1: Failing tests** — `cmdAuthAdd` then `cmdAuthList` shows the gateway with source `sonata` and no value; `cmdAuthRemove` drops it; list output never contains the key.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the three functions over Task 4. `cmdAuthList` derives gateways from config `native.gateways` (caller passes them). In `cli.ts`, add an `auth` command with `add <gateway>`/`list`/`remove <gateway>`; `add` reads the key from a non-echoing prompt (reuse `tui.ts` input; if none exists, read a line from stdin with echo off) — but the key never touches argv.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(cli): sonata auth add/list/remove for gateway keys`.

---

### Task 6: `sonata serve`

**Files:**
- Create: `src/commands/serve.ts`
- Modify: `src/cli.ts` (wire `serve`, USAGE)
- Test: `tests/commands/serve.test.ts`

**Interfaces:**
- Consumes: `createRouterServer` (Task 2), `litellmConfigYaml`/`findLitellm` (Task 3), `resolveKeys`/`envVarForGateway` (Tasks 3/4), `loadConfig`.
- Produces:
  ```ts
  export interface ServeHandle { routerPort: number; litellmPort: number; stop(): Promise<void> }
  // spawnLitellm is injected so the test never launches a real process.
  export interface ServeDeps {
    spawnLitellm?: (configPath: string, env: NodeJS.ProcessEnv, port: number) => { pid: number; kill(): void };
  }
  export function cmdServe(opts: { cwd: string; home: string; daemon?: boolean } & ServeDeps): Promise<ServeHandle>
  export function serveHealthUrl(routerPort: number): string // http://localhost:<p>/__sonata_health
  ```

- [ ] **Step 1: Failing tests** (inject a fake `spawnLitellm`; assert env + health)

```ts
it('resolves keys into the litellm child env under the gateway env var', async () => {
  // config with one native model + gateway; sonata key written for it
  let captured: NodeJS.ProcessEnv = {};
  const h = await cmdServe({ cwd, home, spawnLitellm: (_c, env) => { captured = env; return { pid: 1, kill() {} }; }});
  expect(captured.SONATA_KEY_ANEXTO).toBe('the-key');
  expect(captured).not.toHaveProperty('ANTHROPIC_API_KEY'); // no stray forwarding
  await h.stop();
});

it('serves a health endpoint on the router port', async () => {
  const h = await cmdServe({ cwd, home, spawnLitellm: () => ({ pid: 1, kill() {} }) });
  const res = await fetch(serveHealthUrl(h.routerPort));
  expect(res.status).toBe(200);
  await h.stop();
});

it('refuses to start when [native] is absent', async () => {
  await expect(cmdServe({ cwd: cwdWithNoNative, home })).rejects.toThrow(/no \[native\]/);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Load config; require `native`. Generate a master key (`randomBytes`). Write the LiteLLM config to a temp path. `resolveKeys(Object.keys(native.gateways), home)` → build the child env `{ ...process.env-subset, SONATA_KEY_<G>: key }` (only the sonata vars; do not copy the whole environment's secrets). `spawnLitellm(configPath, env, native.ports.litellm)` (real impl: `child_process.spawn('litellm', ['--config', p, '--port', String(port)])`; injected in tests). Start `createRouterServer({ fetch, litellmBase: 'http://localhost:'+litellmPort, litellmKey: master, log })` listening on `native.ports.router`, plus a `/__sonata_health` 200 route. `stop()` closes the server and kills the child. `--daemon` detaches (document; a follow-up wires `gc`). Errors if a port is occupied by a non-sonata listener (health probe returns non-sonata / connection refused distinction).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(cli): sonata serve — managed router + litellm child`.

---

### Task 7: `sonata code`

**Files:**
- Create: `src/commands/code.ts`
- Modify: `src/cli.ts` (wire `code`, USAGE)
- Test: `tests/commands/code.test.ts`

**Interfaces:**
- Consumes: `serveHealthUrl` (Task 6), `loadConfig`.
- Produces:
  ```ts
  // Pure planning half, so the exec is testable without launching claude.
  export interface CodePlan { env: Record<string,string>; argv: string[]; banner: string }
  export function planCode(opts: { cwd: string; home: string; passthrough: string[] }): CodePlan
  export function cmdCode(opts: { cwd: string; home: string; passthrough: string[];
    exec?: (argv: string[], env: Record<string,string>) => never;
    ensureServe?: () => Promise<number> /* returns router port */ }): Promise<void>
  ```

- [ ] **Step 1: Failing tests**

```ts
it('sets ANTHROPIC_BASE_URL to the router and the min context window', () => {
  // config: two native models, windows 128000 and 32000
  const plan = planCode({ cwd, home, passthrough: ['--model', 'sonnet'] });
  expect(plan.env.ANTHROPIC_BASE_URL).toBe('http://localhost:4100');
  expect(plan.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('32000'); // conservative min
  expect(plan.argv).toEqual(['claude', '--model', 'sonnet']);
  expect(plan.banner).toMatch(/Remote Control unavailable/i);
});
it('omits the context var when no native models are configured', () => {
  expect(planCode({ cwd: cwdNoNative, home, passthrough: [] }).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `planCode`: `ANTHROPIC_BASE_URL=http://localhost:<native.ports.router>`; if `native.models` non-empty, `CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(min(contextWindow))`; `argv = ['claude', ...passthrough]`; banner as specified. `cmdCode`: `await ensureServe()` (default: probe health, else spawn `sonata serve --daemon` — user-invoked, so allowed), print banner, then `exec(argv, {...process.env, ...plan.env})` (default exec: `execvp`-style via `child_process` replacing the process, or `spawn` with `stdio:'inherit'` and propagate exit code).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(cli): sonata code — launch a native-routed claude session`.

---

### Task 8: Native agent generation in `sync`

**Files:**
- Modify: `src/commands/sync.ts`
- Test: `tests/commands/sync.test.ts`

**Interfaces:**
- Consumes: `generatedNativeAgents` (Task 1), existing `ROLE_BLURB`, `isReadOnlyRole`.
- Produces:
  ```ts
  export function nativeAgentMarkdown(spec: { role: string; model: string }): string
  // cmdSync also writes native-<role>-<model>.md for each generatedNativeAgents entry
  ```

- [ ] **Step 1: Failing tests**

```ts
it('generates a native agent with the model id in frontmatter and no MCP tools', () => {
  const md = nativeAgentMarkdown({ role: 'code', model: 'deepseek-v4-flash' });
  expect(md).toMatch(/^model: deepseek-v4-flash$/m);
  expect(md).not.toMatch(/mcp__sonata__/);
  expect(md).not.toMatch(/forwarding wrapper/);
});
it('restricts a read-only native role to read tools', () => {
  const md = nativeAgentMarkdown({ role: 'explore', model: 'deepseek-v4-flash' });
  expect(md).toMatch(/^tools: Read, Grep, Glob$/m);
});
it('cmdSync writes native-<role>-<model>.md alongside wrapper agents', () => {
  // config with both [generate.roles] and [generate.native]
  const res = cmdSync({ cwd, agentsDir, home });
  expect(res.written.some(p => p.endsWith('native-code-deepseek-v4-flash.md'))).toBe(true);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `nativeAgentMarkdown`: frontmatter `name: native-<role>-<model>`, description ("Runs <blurb> natively on <model> inside Claude Code's own loop. Requires a `sonata code` session."), `model: <model>`, `tools:` line — read-only roles `Read, Grep, Glob`, code omitted (full tools). Body: the role prompt guidance minus the reporting contract, plus a first line stating it only works in a `sonata code` session. In `cmdSync`, after the wrapper loop, iterate `generatedNativeAgents(config)` writing `native-<role>-<model>.md`; add these paths to `written`. Feed both wrapper and native names into `staleAgents` so pruning still works.
- [ ] **Step 4: Run → PASS.** Also update any wrapper-count assertions that now see extra files.
- [ ] **Step 5: Commit** `feat(sync): generate native (non-wrapper) agent files`.

---

### Task 9: `sonata init` native screens

**Files:**
- Modify: `src/commands/init.ts`, `src/cli.ts` (flags), `docs`/USAGE
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: existing step-machine, `multiselect`/`select`, `keyReport` (Task 4), the native model catalogue (from the same `offerableProviders`/detected refs, filtered to gateways that can serve native — treat every detected provider base URL as a candidate gateway).
- Produces: `InitOptions` gains `nativeModels?: string[]`, `nativeRoles?: string[]`; `tomlFor` (or a new `nativeTomlFor`) also emits `[native.*]` and `[generate.native]` when native models are chosen.

- [ ] **Step 1: Failing tests** (inject detector; drive non-interactively via flags)

```ts
it('writes a [native] table and generate.native when native flags are given', async () => {
  const res = await cmdInit({ ...base, yes: true, providers: [...], models: [...], roles: ['code'],
    nativeModels: ['deepseek-v4-flash'], nativeRoles: ['code'] });
  const toml = readFileSync(res.configPath, 'utf8');
  expect(toml).toMatch(/\[native\.models\."deepseek-v4-flash"\]/);
  expect(toml).toMatch(/\[generate\.native\]/);
});
it('writes no [native] table when native is skipped', async () => {
  const res = await cmdInit({ ...base, yes: true, /* no native flags */ });
  expect(readFileSync(res.configPath, 'utf8')).not.toMatch(/\[native\]/);
});
it('previousAskedStep still skips flag-answered native screens'); // back-nav unit test
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Grow the step machine from 5 to 7 steps: **native models** (multiselect over gateway/model candidates; empty = skip native entirely) and **native roles** (per-role assignment mirroring step 4). Extend `asked[]` and `previousAskedStep` coverage so Left skips flag-answered native steps. After selection, a **key check**: for each chosen gateway call `keyReport`; print `gateway: key from <source>` or, interactively, offer `sonata auth add <gateway>` inline. Extend the TOML writer to emit `[native.models.*]`, `[native.gateways.*]`, and `[generate.native]` (gateway base URLs from the detected provider). Add `--native-models`/`--native-roles` in `cli.ts`; `--yes` selects no native models. Keep everything keyed through `tomlKey`; run the same `duplicateKeys` collision guard over native keys.
- [ ] **Step 4: Run → PASS** (full `tests/init.test.ts`).
- [ ] **Step 5: Commit** `feat(init): native model/role screens, key check, TOML output`.

---

### Task 10: Doctor checks for the native path

**Files:**
- Modify: `src/commands/doctor.ts`
- Test: `tests/commands/doctor.test.ts`

- [ ] **Step 1: Failing tests** — with a `[native]` config: a check for LiteLLM presence (injected/faked), a serve-health check (faked up/down), a per-gateway key-source line (from `keyReport`, no values), and a stale-native-agents check. Assert no key value appears in any check detail.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Only when `config.native` is present: `findLitellm()` → ok/absent with the `pip install 'litellm[proxy]'` fix; probe `serveHealthUrl` → up/down (down is a warn, not error — serve is user-started); `keyReport(gateways)` → one line each, `source` or "no key — `sonata auth add <gateway>`"; feed native agent names into the existing stale check. Belt to Task 1's braces: also warn if any `native.models` id/key starts with `claude-` (should be impossible post-parse, but doctor is the place that says so out loud).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(doctor): litellm, serve health, key source, native staleness`.

---

### Task 11: The `claude` harness adapter (Deliverable B)

**Files:**
- Create: `src/adapters/claude.ts`
- Modify: `src/adapters/index.ts`, `src/config.ts` (`KNOWN_HARNESSES`)
- Test: `tests/adapters/claude.test.ts`

**Interfaces:**
- Consumes: `HarnessAdapter`, `PlanInput`, `LaunchPlan` (`src/adapters/types.ts`).
- Produces: a `claudeAdapter: HarnessAdapter` named `'claude'`, registered; `KNOWN_HARNESSES` gains `'claude'`.

- [ ] **Step 1: Failing tests** (mirror an existing adapter test)

```ts
it('plan runs claude -p headless with the model id', () => {
  const plan = claudeAdapter.plan({ modelId: 'deepseek-v4-flash', role: 'code', mode: 'acceptEdits', cwd, runDir, instructionsPath });
  expect(plan.script).toMatch(/claude .* -p/);
  expect(plan.script).toContain('deepseek-v4-flash');
  expect(plan.interactive).toBe(false);
});
it('a read-only role restricts tools and cannot write a report', () => {
  const plan = claudeAdapter.plan({ modelId: 'x', role: 'explore', mode: 'plan', cwd, runDir, instructionsPath });
  expect(plan.script).toMatch(/--permission-mode plan|--allowedTools/);
});
it('canWriteReport is true for a write-capable role', () => {
  expect(claudeAdapter.plan({ modelId: 'x', role: 'code', mode: 'acceptEdits', cwd, runDir, instructionsPath }).canWriteReport).not.toBe(false);
});
it('is registered and known', () => {
  expect(getAdapter('claude').name).toBe('claude');
  expect(KNOWN_HARNESSES).toContain('claude');
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** `claude -p` headless: no TUI seeding, `interactive: false`, empty `promptPatterns`, `describePrompt` → null, `approveKeys` empty. Modes: `plan`→`--permission-mode plan`; read-only roles→restricted `--allowedTools Read,Grep,Glob` (or `--permission-mode plan`); `default`→`--permission-mode default`; `acceptEdits`/`bypassPermissions`→same-named. `canWriteReport` true for write-capable roles (model has Write), false for the strict read-only allowlist (mirror pi's reasoning). Inject `ANTHROPIC_BASE_URL`/context env into the script so a dispatched native model is routed (the run is expected to happen inside, or alongside, a serve). `versionCommand`/`supportedVersions`/`pathPrepend` per the real binary. `fallbackReportFile` — `-o`/last-message file if used. Register in `index.ts`; add `'claude'` to `KNOWN_HARNESSES`. Note in a comment: the adapter assumes `sonata serve` is up; the launch fails legibly otherwise.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(adapter): claude harness — foreign-on-Claude-loop via -p`.

---

### Task 12: Docs, CLI USAGE, and CLAUDE.md

**Files:**
- Modify: `src/cli.ts` (USAGE for serve/code/auth), `CLAUDE.md`, `README.md`
- Test: none (docs), but run the full suite + typecheck + build.

- [ ] **Step 1:** Add `serve`, `code`, `auth` to USAGE with one-line summaries and the native init flags.
- [ ] **Step 2:** CLAUDE.md — a "Native path" section (the two deliverables, the `[native]` config, the remote-control trade-off, the `claude-` prefix rule, the credential flow, "the user starts serve"), and a Security paragraph (router transits the session credential locally; keys go store→env→litellm only). Add `claude` to the harness list and the permission-modes section.
- [ ] **Step 3:** README — install note that LiteLLM is an optional prerequisite for the native path.
- [ ] **Step 4:** `npm run build && npm run typecheck && npm test` — all green.
- [ ] **Step 5: Commit** `docs: native path — CLAUDE.md, README, CLI usage`.

---

## Self-Review Notes

- **Spec coverage:** config (T1), router (T2), litellm (T3), credentials (T4), auth (T5), serve (T6), code (T7), native agents (T8), init TUI (T9), doctor (T10), claude adapter/B (T11), docs (T12). All spec sections mapped.
- **Type consistency:** `NativeConfig`/`NativeModelConfig` defined in T1 and consumed unchanged in T3/T6/T7/T9/T10; `KeySource`/`KeyReport` from T4 used in T5/T6/T9/T10; `RouterDeps` from T2 used in T6.
- **Ordering:** T1–T4 are leaf modules; T5–T11 depend only on earlier tasks; T12 is docs last. Each task ends green and is independently reviewable.
- **Deliverable A** = T1–T10; **Deliverable B** = T11. B can be deferred without blocking A.
