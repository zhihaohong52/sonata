# Multi-Tenant Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One machine router (`sonata serve`) serves every project, resolving each request's `sonata.toml` from the project the request came from, with one LiteLLM child whose model list is the namespaced union of every known project's models.

**Architecture:** A new `TenantRegistry` (`src/native/tenants.ts`) resolves a request to a tenant — header `x-sonata-project`, then the session registry, then the machine config — and enumerates every known tenant for the LiteLLM union. `RouterDeps` become tenant-scoped functions (`resolveTier(alias, tenant)` etc.), the litellm model name becomes `<tenantId>/<key>`, and every port consumer reads ports from one `routerPorts(home)` resolver that only ever looks at the machine config. Every caller that today compares the router's `configPath` instead requires the health endpoint to report `multiTenant: true`.

**Tech Stack:** TypeScript (Node 22, ESM), vitest, LiteLLM 1.98.0 (managed venv), Claude Code settings `env` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`).

**Spec:** `docs/superpowers/specs/2026-09-09-multi-tenant-router-design.md`

## Global Constraints

- Tenant id: first 12 hex chars of sha256 over the resolved config path (spec §Tenancy).
- Resolution order: `x-sonata-project` header → `sessions.json` by `x-claude-code-session-id` → machine config. First hit wins.
- `x-sonata-project` is stripped before forwarding on every path.
- Router ports come only from the machine config `[native.ports]`, else `4100`/`4000`. A project `[native.ports]` parses, is ignored, and `sonata doctor` warns.
- LiteLLM model names are `<tenantId>/<key>` for every tenant, including the machine one.
- Credential env vars stay `SONATA_KEY_<GATEWAY>` by gateway name — not namespaced.
- `serve` never installs LiteLLM. A tenant that needs LiteLLM while the venv is unhealthy gets 502 naming `sonata litellm install`.
- Health reports `multiTenant: true`, `instanceId`, `tenants: [{ id, configPath }]`; `configPath` is no longer reported.
- Callers refuse a router without `multiTenant: true` with: `router on port N predates multi-tenant routing — run sonata restart`.
- Ledger rows gain `project?: string`. A project cap counts rows whose `project` equals the tenant's cwd; a machine cap counts every row.
- `ANTHROPIC_CUSTOM_HEADERS` is written only at project scope (global scope has no single cwd).
- Errors in spec §Errors are 400/502/429, never written to the ledger.
- Use `/usr/bin/grep`, never bare `grep` (a shim hides matching lines). `src/native/router.ts` contains a NUL byte: add `-a`.
- Run `npm run typecheck` and the named test file after every task; run the full `npx vitest run` before the final task. `sonata` on PATH runs `dist/`, so `npm run build` before any live check.
- Commit after each task; push only at the end of Task 12.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/native/tenants.ts` (new) | `tenantId`, `SONATA_PROJECT_HEADER`, `TenantError`, `TenantRegistry` (resolve, known, union snapshot, once-per-error logging) |
| `src/commands/ports.ts` (new) | `routerPorts(home)`: the only place router/litellm ports are decided |
| `src/native/litellm.ts` | `litellmConfigForTenants` — the namespaced union model list |
| `src/native/router.ts` | tenant-scoped deps, header strip, namespaced rewrite and cooldowns, per-tenant budgets, health flag, `project` on ledger rows, litellm-unavailable 502 |
| `src/ledger.ts`, `src/budget.ts`, `src/commands/usage.ts` | `project` field, project-filtered spend, cap naming its file, usage preferring the row field |
| `src/commands/serve.ts` | `cmdServe` on a `TenantRegistry`; lazy LiteLLM; union config; per-tenant gateway keys; `startServeDaemon`/`stopServe` on `routerPorts` |
| `src/commands/code.ts` | `nativeSessionEnv(config, routerPort, projectCwd?)`; `defaultEnsureServe` on the multi-tenant check |
| `src/commands/route.ts` | custom-header env in `planRouteOn`/`planRouteOff`; `cmdRouteSession` on the multi-tenant check; ports from `routerPorts` |
| `src/commands/run.ts`, `src/cli.ts`, `src/adapters/claude.ts` | ports from `routerPorts`; `ensureNativeServe` on the multi-tenant check |
| `hooks/ensure-serve.mjs` | multi-tenant check; daemon always started from the machine config dir |
| `src/commands/doctor.ts` | serve-health on the flag listing tenants; project `[native.ports]` warning; ports from `routerPorts` |
| `tests/native/tenants.test.ts` (new), `tests/commands/ports.test.ts` (new) | new units |
| existing test files named per task | updated assertions |

---

### Task 1: Tenant id and router ports

**Files:**
- Create: `src/native/tenants.ts`
- Create: `src/commands/ports.ts`
- Test: `tests/native/tenants.test.ts`, `tests/commands/ports.test.ts`

**Interfaces:**
- Produces: `tenantId(configPath: string): string`; `SONATA_PROJECT_HEADER = 'x-sonata-project'`; `class TenantError extends Error`; `routerPorts(home: string): { router: number; litellm: number }`.

- [ ] **Step 1: Write the failing tests**

`tests/native/tenants.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { tenantId, SONATA_PROJECT_HEADER, TenantError } from '../../src/native/tenants.js';

describe('tenantId', () => {
  it('is 12 lowercase hex chars, stable for the same path', () => {
    const id = tenantId('/home/u/proj/sonata.toml');
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(tenantId('/home/u/proj/sonata.toml')).toBe(id);
  });
  it('differs for a different path', () => {
    expect(tenantId('/a/sonata.toml')).not.toBe(tenantId('/b/sonata.toml'));
  });
  it('names the header and exports a typed error', () => {
    expect(SONATA_PROJECT_HEADER).toBe('x-sonata-project');
    expect(new TenantError('x')).toBeInstanceOf(Error);
    expect(new TenantError('x').name).toBe('TenantError');
  });
});
```

`tests/commands/ports.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routerPorts } from '../../src/commands/ports.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-ports-')); });

const machine = (toml: string) => {
  mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
  writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), toml);
};

describe('routerPorts', () => {
  it('defaults with no machine config at all', () => {
    expect(routerPorts(home)).toEqual({ router: 4100, litellm: 4000 });
  });
  it('reads the machine config [native.ports]', () => {
    machine('[native.ports]\nrouter = 4300\nlitellm = 4301\n');
    expect(routerPorts(home)).toEqual({ router: 4300, litellm: 4301 });
  });
  it('defaults when the machine config has no [native] table', () => {
    machine('schema_version = 1\n');
    expect(routerPorts(home)).toEqual({ router: 4100, litellm: 4000 });
  });
  it('throws on a machine config that will not parse — a broken machine config is a real error', () => {
    machine('[native.ports\n');
    expect(() => routerPorts(home)).toThrow();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/native/tenants.test.ts tests/commands/ports.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement**

`src/native/tenants.ts` (Task 5 grows this file; write only this now):

```ts
import { createHash } from 'node:crypto';

/**
 * The request header a routed session carries naming its project directory.
 * Written into settings `env` as `ANTHROPIC_CUSTOM_HEADERS` by the routing
 * planner (`nativeSessionEnv`), so a subagent's very first request already
 * says which project it belongs to — no registry, no ordering.
 */
export const SONATA_PROJECT_HEADER = 'x-sonata-project';

/** Stable, log-readable, and safe inside a LiteLLM model name. */
export function tenantId(configPath: string): string {
  return createHash('sha256').update(configPath).digest('hex').slice(0, 12);
}

/** "This request cannot be attributed to a loadable configuration" — a 400, never a 5xx. */
export class TenantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantError';
  }
}
```

`src/commands/ports.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GLOBAL_CONFIG_RELATIVE, parseConfig } from '../config.js';

export const DEFAULT_PORTS = { router: 4100, litellm: 4000 } as const;

/**
 * The one place router and litellm ports are decided.
 *
 * There is one router per machine, so its ports are the machine config's —
 * never a project's. A project `[native.ports]` still parses (an existing file
 * keeps loading) but is ignored here, and `sonata doctor` says so. Reading the
 * machine file directly rather than through `loadConfig(cwd)` is the point:
 * `loadConfig` prefers `<cwd>/sonata.toml`, which is exactly the file this
 * must not consult.
 */
export function routerPorts(home: string): { router: number; litellm: number } {
  const path = join(home, GLOBAL_CONFIG_RELATIVE);
  if (!existsSync(path)) return { ...DEFAULT_PORTS };
  const config = parseConfig(readFileSync(path, 'utf8'));
  return config.native?.ports ?? { ...DEFAULT_PORTS };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/native/tenants.test.ts tests/commands/ports.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/native/tenants.ts src/commands/ports.ts tests/native/tenants.test.ts tests/commands/ports.test.ts
git commit -m "feat(native): tenant id and machine-only router ports"
```

---

### Task 2: Namespaced union LiteLLM config

**Files:**
- Modify: `src/native/litellm.ts` (after `litellmConfig`, ~line 132)
- Test: `tests/native/litellm.test.ts` (exists; append)

**Interfaces:**
- Produces: `litellmConfigForTenants(tenants: { id: string; config: SonataConfig }[], masterKey: string): LiteLLMConfig` and `litellmConfigYamlForTenants(...)` (same args, returns string). Model names are `${id}/${key}`.

- [ ] **Step 1: Write the failing test**

Append to `tests/native/litellm.test.ts`:

```ts
import { litellmConfigForTenants } from '../../src/native/litellm.js';
import { parseConfig } from '../../src/config.js';

describe('litellmConfigForTenants', () => {
  const a = parseConfig(`
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash"
[native.gateways."acme"]
base_url = "https://a.example/v1"
`);
  const b = parseConfig(`
[models."flash"]
gateway = "acme"
id = "gemini-3.8-flash"
[native.gateways."acme"]
base_url = "https://b.example/v1"
`);

  it('namespaces every tenant, so the same key in two projects stays two models', () => {
    const cfg = litellmConfigForTenants([{ id: 'aaaaaaaaaaaa', config: a }, { id: 'bbbbbbbbbbbb', config: b }], 'sk');
    const names = cfg.model_list.map((m) => m.model_name);
    expect(names).toEqual(['aaaaaaaaaaaa/flash', 'bbbbbbbbbbbb/flash']);
    expect(cfg.model_list[0].litellm_params.model).toBe('openai/deepseek-v4-flash');
    expect(cfg.model_list[0].litellm_params.api_base).toBe('https://a.example/v1');
    expect(cfg.model_list[1].litellm_params.api_base).toBe('https://b.example/v1');
    // Same gateway name, same env var: credentials are machine-wide by name.
    expect(cfg.model_list[0].litellm_params.api_key).toBe('os.environ/SONATA_KEY_ACME');
    expect(cfg.model_list[1].litellm_params.api_key).toBe('os.environ/SONATA_KEY_ACME');
    expect(cfg.general_settings.master_key).toBe('sk');
  });

  it('skips a tenant with no [native] table', () => {
    const none = parseConfig('[models."k"]\nharness = "codex"\nid = "gpt-5.6-sol"\n');
    expect(litellmConfigForTenants([{ id: 'x', config: none }], 'sk').model_list).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/native/litellm.test.ts`
Expected: FAIL, `litellmConfigForTenants` is not exported.

- [ ] **Step 3: Implement**

In `src/native/litellm.ts`, add the import `import type { NativeConfig, UnifiedModelConfig, SonataConfig } from '../config.js';` (extend the existing type import) and after `litellmConfig`:

```ts
/**
 * The union of every known tenant's native models, each under
 * `<tenantId>/<key>`. One LiteLLM child serves every project; the namespace is
 * what lets two projects both call a model `flash` and mean different things.
 * Credentials are deliberately not namespaced: the key store is machine-wide
 * by gateway name, so two tenants naming `acme` already share one key, while
 * `api_base` is per entry so they still each reach their own endpoint.
 */
export function litellmConfigForTenants(
  tenants: { id: string; config: SonataConfig }[],
  masterKey: string,
): LiteLLMConfig {
  const modelList: LiteLLMModelConfig[] = [];
  for (const { id, config } of tenants) {
    const native = config.native;
    if (native === undefined) continue;
    const single = litellmConfig(native, masterKey, config.unifiedModels);
    for (const entry of single.model_list) {
      modelList.push({ ...entry, model_name: `${id}/${entry.model_name}` });
    }
  }
  return {
    model_list: modelList,
    litellm_settings: { drop_params: true, use_chat_completions_url_for_anthropic_messages: true },
    general_settings: { master_key: masterKey },
  };
}

export function litellmConfigYamlForTenants(
  tenants: { id: string; config: SonataConfig }[],
  masterKey: string,
): string {
  return `${JSON.stringify(litellmConfigForTenants(tenants, masterKey), null, 2)}\n`;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/native/litellm.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/native/litellm.ts tests/native/litellm.test.ts
git commit -m "feat(native): namespaced union litellm config across tenants"
```

---

### Task 3: Ledger `project`, project-filtered spend, cap naming its file

**Files:**
- Modify: `src/ledger.ts:22-40` (`LedgerRow`)
- Modify: `src/budget.ts` (`spentTodayUsd`, `BudgetStatus`, `budgetRefusal`)
- Modify: `src/commands/usage.ts:57` (`labelOf` project case)
- Test: `tests/budget.test.ts`, `tests/commands/usage.test.ts`

**Interfaces:**
- Produces: `LedgerRow.project?: string`; `spentTodayUsd(home, now?, project?)`; `BudgetStatus { dailyUsd; spentUsd; configPath: string }`; `budgetRefusal(statuses: BudgetStatus[] | undefined): string | undefined` (first status at or over its cap wins).

- [ ] **Step 1: Write the failing tests**

Append to `tests/budget.test.ts` (reuse the file's existing row-writing helper; read its top 35 lines first and match the helper's name):

```ts
describe('spentTodayUsd — per project', () => {
  it('filters to one project when asked, and counts everything when not', () => {
    // Write two priced rows for today: one with project '/p/a', one with '/p/b'.
    // Use this file's existing helper that appends a row for a given day/price,
    // passing `project` through `over`.
    writeRow({ project: '/p/a', price: { source: 'model', totalUsd: 1 } });
    writeRow({ project: '/p/b', price: { source: 'model', totalUsd: 2 } });
    expect(spentTodayUsd(home, NOW, '/p/a')).toBe(1);
    expect(spentTodayUsd(home, NOW)).toBe(3);
  });
});

describe('budgetRefusal — several caps', () => {
  it('refuses on the first cap reached and names that cap\'s file', () => {
    const msg = budgetRefusal([
      { dailyUsd: 10, spentUsd: 1, configPath: '/p/a/sonata.toml' },
      { dailyUsd: 2, spentUsd: 2, configPath: '/home/u/.config/sonata/sonata.toml' },
    ]);
    expect(msg).toContain('/home/u/.config/sonata/sonata.toml');
    expect(msg).toContain('$2.0000 of $2.00');
  });
  it('is undefined when every cap has room, or there are none', () => {
    expect(budgetRefusal([{ dailyUsd: 10, spentUsd: 1, configPath: '/x' }])).toBeUndefined();
    expect(budgetRefusal([])).toBeUndefined();
    expect(budgetRefusal(undefined)).toBeUndefined();
  });
});
```

Append to `tests/commands/usage.test.ts` (match its existing row helper):

```ts
it('groups by the row\'s own project before falling back to the session join', () => {
  const rows = [
    row({ project: '/p/a', session: 's1' }),
    row({ session: 's2' }),
  ];
  const report = aggregate(rows, 'project', { s2: { session: 's2', cwd: '/p/b', started: '' } });
  expect(report.buckets.map((b) => b.label).sort()).toEqual(['/p/a', '/p/b']);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/budget.test.ts tests/commands/usage.test.ts`
Expected: FAIL (type errors on `project`/`configPath`, wrong totals).

- [ ] **Step 3: Implement**

`src/ledger.ts`: add to `LedgerRow` after `session?: string;`:

```ts
  /** The project directory the request was attributed to, written by the router from the resolved tenant. Absent on rows written before multi-tenant routing and on requests no project could be resolved for. */
  project?: string;
```

`src/budget.ts`: replace `spentTodayUsd`, `BudgetStatus`, `budgetRefusal`:

```ts
/**
 * Priced spend recorded so far in the current UTC day — for one project when
 * `project` is given, else for every row the router forwarded.
 */
export function spentTodayUsd(home: string, now: number = Date.now(), project?: string): number {
  let total = 0;
  for (const row of readRows(home, startOfUtcDay(now), now)) {
    if (project !== undefined && row.project !== project) continue;
    if (row.price.source === 'none' || row.price.totalUsd === undefined) continue;
    total += row.price.totalUsd;
  }
  return total;
}

export interface BudgetStatus {
  dailyUsd: number;
  spentUsd: number;
  /** The sonata.toml that set this cap — named in the refusal, since a project and the machine can each set one. */
  configPath: string;
}

/**
 * Whether this request should be refused, and what to tell the caller. Several
 * caps can apply to one request (the project's and the machine's); the first
 * one reached refuses, naming its own file.
 */
export function budgetRefusal(statuses: BudgetStatus[] | undefined): string | undefined {
  for (const status of statuses ?? []) {
    if (status.spentUsd < status.dailyUsd) continue;
    return (
      `sonata daily budget reached: $${status.spentUsd.toFixed(4)} of ` +
      `$${status.dailyUsd.toFixed(2)} priced spend used today (UTC). ` +
      `Raise or remove [budget] daily_usd in ${status.configPath} to continue. ` +
      'Note this counts priced requests only, and covers the native router path ' +
      'alone — `sonata dispatch` runs never transit the router.'
    );
  }
  return undefined;
}
```

Keep the module's header comment; update its "one number the user writes down" sentence to "one number per config file".

`src/commands/usage.ts:57`:

```ts
    case 'project': return row.project ?? (row.session === undefined ? 'unknown' : (sessions[row.session]?.cwd ?? 'unknown'));
```

Then fix every existing caller of `budgetRefusal` (`src/native/router.ts:791` — wrap for now: `budgetRefusal(deps.budget?.() === undefined ? undefined : [deps.budget()!])`, replaced properly in Task 4) and every test constructing a `BudgetStatus` (`/usr/bin/grep -rn "dailyUsd" tests`) to add `configPath`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/budget.test.ts tests/commands/usage.test.ts tests/native/router.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ledger.ts src/budget.ts src/commands/usage.ts src/native/router.ts tests/budget.test.ts tests/commands/usage.test.ts tests/native/router.test.ts
git commit -m "feat(ledger,budget): project on every row; caps per file"
```

---

### Task 4: Tenant-scoped router

**Files:**
- Modify: `src/native/router.ts` — `RouterDeps` (14-100), `RecordContext` (~178), `routeTierRequest` (~640-775), `routeRequest` (~776-870), `createRouterServer` health (~880-900), `requestHeaders` (~118)
- Test: `tests/native/router.test.ts`

**Interfaces:**
- Consumes: `SONATA_PROJECT_HEADER` (Task 1), `BudgetStatus[]`/`budgetRefusal` (Task 3).
- Produces (all in `RouterDeps`):
  ```ts
  export interface RouterTenant { id: string; project?: string; configPath?: string; config?: SonataConfig }
  resolveTenant?: (hint: { project?: string; session?: string }) => RouterTenant;   // may throw TenantError
  resolveTier?: (alias: string, tenant: RouterTenant) => { role; tier; routes } | undefined;
  resolveGateway?: (key: string, tenant: RouterTenant) => string | undefined;
  budget?: (tenant: RouterTenant) => BudgetStatus[] | undefined;
  gatewayKeys?: (tenant: RouterTenant) => Record<string, string>;
  litellmUnavailable?: () => string | undefined;
  tenants?: () => { id: string; configPath: string | null }[];
  ```
  plus `export function litellmModelName(tenant: RouterTenant, key: string): string` returning `${tenant.id}/${key}`, and `export const DEFAULT_TENANT: RouterTenant = { id: 'default' }` used when `resolveTenant` is absent.

- [ ] **Step 1: Write the failing tests**

Append to `tests/native/router.test.ts`:

```ts
import { TenantError, SONATA_PROJECT_HEADER } from '../../src/native/tenants.js';
import { litellmModelName, DEFAULT_TENANT } from '../../src/native/router.js';

describe('routeRequest — tenants', () => {
  const seen: { url: string; model: string; headers: Record<string, string> }[] = [];
  const capture: typeof fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(Buffer.from(init.body as Uint8Array).toString()) as { model: string };
    seen.push({ url, model: body.model, headers: init.headers as Record<string, string> });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const tenantA = { id: 'aaaaaaaaaaaa', project: '/p/a', configPath: '/p/a/sonata.toml' };
  const tenantB = { id: 'bbbbbbbbbbbb', project: '/p/b', configPath: '/p/b/sonata.toml' };
  const routesFor = (t: { id: string }) => ({
    role: 'code', tier: 'simple',
    routes: [{ key: 'flash', native: { gateway: 'g', id: t.id === 'aaaaaaaaaaaa' ? 'deepseek' : 'gemini' } }],
  });
  const deps = {
    fetch: capture, litellmBase: 'http://litellm', litellmKey: 'k',
    resolveTenant: (hint: { project?: string; session?: string }) => {
      if (hint.project === '/p/a' || hint.session === 'sa') return tenantA;
      if (hint.project === '/p/b') return tenantB;
      if (hint.project === '/none') throw new TenantError('No sonata.toml found for /none');
      return DEFAULT_TENANT;
    },
    resolveTier: (_alias: string, t: { id: string }) => routesFor(t),
  };
  const req = (headers: Record<string, string>, model = 'sonata-code-simple') => ({
    method: 'POST', url: '/v1/messages',
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify({ model, messages: [] })),
  });
  beforeEach(() => { seen.length = 0; clearCooldowns(); });

  it('resolves by the project header first and namespaces the litellm model', async () => {
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/a', 'x-claude-code-session-id': 'zz' }), deps);
    expect(seen[0].model).toBe('aaaaaaaaaaaa/flash');
  });
  it('falls back to the session, then to the default tenant', async () => {
    await routeRequest(req({ 'x-claude-code-session-id': 'sa' }), deps);
    expect(seen[0].model).toBe('aaaaaaaaaaaa/flash');
    await routeRequest(req({}), deps);
    expect(seen[1].model).toBe('default/flash');
  });
  it('strips the project header before forwarding, on the litellm and anthropic paths', async () => {
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/a' }), deps);
    expect(Object.keys(seen[0].headers).map((h) => h.toLowerCase())).not.toContain(SONATA_PROJECT_HEADER);
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/a' }, 'claude-sonnet-5'), { ...deps, anthropicBase: 'http://anthropic' });
    expect(Object.keys(seen[1].headers).map((h) => h.toLowerCase())).not.toContain(SONATA_PROJECT_HEADER);
  });
  it('answers a TenantError with a 400 naming the message, and records nothing', async () => {
    const rows: unknown[] = [];
    const res = await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/none' }), { ...deps, recordUsage: (r) => rows.push(r) });
    expect(res.status).toBe(400);
    expect(Buffer.from(res.body as Buffer).toString()).toContain('No sonata.toml found for /none');
    expect(rows).toEqual([]);
  });
  it('cools one tenant\'s candidate without touching the other\'s', async () => {
    const failing: typeof fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(Buffer.from(init.body as Uint8Array).toString()) as { model: string };
      seen.push({ url: '', model: body.model, headers: {} });
      return new Response('{}', { status: body.model.startsWith('aaaa') ? 503 : 200 });
    }) as unknown as typeof fetch;
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/a' }), { ...deps, fetch: failing });  // cools aaaa/flash
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/b' }), { ...deps, fetch: failing });
    expect(seen.map((s) => s.model)).toEqual(['aaaaaaaaaaaa/flash', 'bbbbbbbbbbbb/flash']);
  });
  it('writes the project onto the ledger row', async () => {
    const rows: { project?: string }[] = [];
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/a' }), { ...deps, recordUsage: (r) => rows.push(r) });
    expect(rows[0].project).toBe('/p/a');
  });
  it('namespaces a bare --model key request too', async () => {
    await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/b' }, 'flash'), deps);
    expect(seen[0].model).toBe('bbbbbbbbbbbb/flash');
  });
  it('refuses on the tenant\'s own cap, naming its file', async () => {
    const res = await routeRequest(req({ [SONATA_PROJECT_HEADER]: '/p/a' }), {
      ...deps,
      budget: (t) => [{ dailyUsd: 1, spentUsd: 1, configPath: `${t.configPath}` }],
    });
    expect(res.status).toBe(429);
    expect(Buffer.from(res.body as Buffer).toString()).toContain('/p/a/sonata.toml');
  });
  it('returns 502 naming the install when litellm is unavailable', async () => {
    const res = await routeRequest(req({}, 'flash'), { ...deps, litellmUnavailable: () => 'LiteLLM is missing — run `sonata litellm install`' });
    expect(res.status).toBe(502);
    expect(Buffer.from(res.body as Buffer).toString()).toContain('sonata litellm install');
  });
  it('litellmModelName is <id>/<key>', () => {
    expect(litellmModelName({ id: 'x' }, 'flash')).toBe('x/flash');
  });
});

describe('createRouterServer — health', () => {
  it('reports multiTenant and the known tenants, never a configPath', async () => {
    const server = createRouterServer({
      fetch, litellmBase: 'http://litellm', litellmKey: 'k', health: true, instanceId: 'i',
      tenants: () => [{ id: 'aaaaaaaaaaaa', configPath: '/p/a/sonata.toml' }],
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/__sonata_health`)).json() as Record<string, unknown>;
      expect(body).toMatchObject({ sonata: true, multiTenant: true, instanceId: 'i', tenants: [{ id: 'aaaaaaaaaaaa', configPath: '/p/a/sonata.toml' }] });
      expect(body).not.toHaveProperty('configPath');
    } finally {
      server.close();
    }
  });
});
```

Add `createRouterServer` to the file's import from router.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/native/router.test.ts`
Expected: FAIL on the new describe blocks.

- [ ] **Step 3: Implement**

In `src/native/router.ts`:

1. Imports: `import type { SonataConfig } from '../config.js';` and `import { SONATA_PROJECT_HEADER, TenantError } from './tenants.js';`.
2. Add the types and default next to `TierRoute`:

```ts
/** What the router knows about the project a request belongs to. `config` is present whenever `resolveTenant` supplied one; the default tenant has none. */
export interface RouterTenant {
  id: string;
  project?: string;
  configPath?: string;
  config?: SonataConfig;
}
export const DEFAULT_TENANT: RouterTenant = { id: 'default' };

/** The model name LiteLLM knows a tenant's key by. */
export function litellmModelName(tenant: RouterTenant, key: string): string {
  return `${tenant.id}/${key}`;
}
```

3. In `RouterDeps` replace `configPath?: string` with `tenants?: () => { id: string; configPath: string | null }[]`; change signatures: `resolveTier?: (alias: string, tenant: RouterTenant) => ...`, `resolveGateway?: (key: string, tenant: RouterTenant) => string | undefined`, `budget?: (tenant: RouterTenant) => BudgetStatus[] | undefined`, `gatewayKeys?: (tenant: RouterTenant) => Record<string, string>`; add:

```ts
  /** Resolves the tenant a request belongs to; may throw `TenantError`, which becomes a 400. Absent means single-tenant: every request is `DEFAULT_TENANT`. */
  resolveTenant?: (hint: { project?: string; session?: string }) => RouterTenant;
  /** Why LiteLLM cannot serve right now (venv missing, broken), or undefined when it can. A litellm-bound request is answered 502 with this text rather than forwarded. */
  litellmUnavailable?: () => string | undefined;
```

4. `requestHeaders`: extend the drop list to `['host', 'content-length', SONATA_PROJECT_HEADER]`.
5. `RecordContext`: add `project?: string`; in `withUsageRecording`'s emitted row add `project: ctx.project`.
6. `routeTierRequest(req, deps, alias, startedAt, session, tenant)`: `deps.resolveTier?.(alias, tenant)`; cooldown/counter keys use `litellmModelName(tenant, route.key)` (introduce `const cool = litellmModelName(tenant, route.key)` at the top of the loop and use it for `cooldowns` and `capability400Counts`); litellm body `withModel(flattened, litellmModelName(tenant, route.key))`; direct key `deps.gatewayKeys?.(tenant)[route.native!.gateway] ?? ''`; every `withUsageRecording` ctx gets `project: tenant.project`; the 529 message appends `` + (deps.litellmUnavailable?.() ? `; litellm: ${deps.litellmUnavailable()}` : '') ``.
7. `forwardToLitellm`: first line inside `try`: 

```ts
    const unavailable = deps.litellmUnavailable?.();
    if (unavailable !== undefined) {
      return { status: 502, headers: { 'content-type': 'application/json' }, body: anthropicErrorBody('router_error', unavailable) };
    }
```

8. `routeRequest`: after reading `session`, resolve the tenant before the budget check:

```ts
  let tenant: RouterTenant;
  try {
    tenant = deps.resolveTenant?.({ project: req.headers[SONATA_PROJECT_HEADER], session }) ?? DEFAULT_TENANT;
  } catch (error) {
    if (!(error instanceof TenantError)) throw error;
    deps.log?.(`router: refused model=${alias ?? '?'} — ${error.message}`);
    return { status: 400, headers: { 'content-type': 'application/json' }, body: anthropicErrorBody('invalid_request_error', error.message) };
  }
  const refusal = budgetRefusal(deps.budget?.(tenant));
```

   `resolveTier?.(alias, tenant)` in the alias test; pass `tenant` to `routeTierRequest`; the non-anthropic bare-key branch rewrites the model: `const body = anthropic ? req.body : withModel(litellmBody(req.body), litellmModelName(tenant, alias ?? ''))` (only when `alias !== undefined`; otherwise `litellmBody(req.body)` unchanged), `deps.resolveGateway?.(alias, tenant)`, and `project: tenant.project` on all three `withUsageRecording` contexts.
9. Health: `res.end(JSON.stringify({ status: 'ok', sonata: true, multiTenant: true, instanceId: deps.instanceId ?? null, tenants: deps.tenants?.() ?? [] }))`.
10. Delete the `configPath` doc comment on `RouterDeps` (line ~21).

Then update existing router tests: `gatewayKeys: { g: 'GATEWAY-KEY' }` → `gatewayKeys: () => ({ g: 'GATEWAY-KEY' })` (5 sites); `expect(seen).toEqual(['flash'])`-style assertions to `['default/flash']` etc. (lines ~106-369); any test asserting a health `configPath`. Do not weaken any assertion — only rename the model strings.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/native/router.test.ts && npm run typecheck`
Expected: router tests PASS; typecheck will still fail in `src/commands/serve.ts` on the changed dep signatures — that is Task 6. Confirm the only errors are in `serve.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/native/router.ts tests/native/router.test.ts
git commit -m "feat(router): tenant-scoped resolution, namespaced litellm models, multiTenant health"
```

---

### Task 5: TenantRegistry

**Files:**
- Modify: `src/native/tenants.ts`
- Test: `tests/native/tenants.test.ts`

**Interfaces:**
- Consumes: `loadSessions(home)` (`src/sessions.ts`), `configPath`/`parseConfig`/`GLOBAL_CONFIG_RELATIVE` (`src/config.ts`), `RouterTenant` (Task 4).
- Produces:
  ```ts
  export interface KnownTenant { id: string; configPath: string; config?: SonataConfig; error?: string }
  export class TenantRegistry {
    constructor(home: string, deps?: { log?: (line: string) => void; now?: () => number });
    noteProject(cwd: string): void;
    resolve(hint: { project?: string; session?: string }): RouterTenant;   // throws TenantError
    known(): KnownTenant[];                                                // machine + sessions + noted, deduped by configPath
    loadable(): { id: string; config: SonataConfig; configPath: string }[]; // known() minus failures
    unionSnapshot(): string;                                               // JSON of every loadable tenant's native snapshot, tenant-id order
    summary(): { id: string; configPath: string | null }[];                 // for health
  }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/native/tenants.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TenantRegistry } from '../../src/native/tenants.js';
import { recordSession } from '../../src/sessions.js';

const NATIVE = (id: string) => `
[models."flash"]
gateway = "acme"
id = "${id}"
[tiers.code]
simple = ["flash"]
complex = ["flash"]
[native.gateways."acme"]
base_url = "https://gateway.example/v1"
`;

describe('TenantRegistry', () => {
  let home: string;
  let a: string;
  let b: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tenants-home-'));
    a = mkdtempSync(join(tmpdir(), 'tenants-a-'));
    b = mkdtempSync(join(tmpdir(), 'tenants-b-'));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), NATIVE('machine-model'));
    writeFileSync(join(a, 'sonata.toml'), NATIVE('a-model'));
    writeFileSync(join(b, 'sonata.toml'), NATIVE('b-model'));
  });

  it('resolves the header first, then the session, then the machine config', async () => {
    const reg = new TenantRegistry(home);
    await recordSession(home, { session: 's-b', cwd: b, started: new Date().toISOString() });
    expect(reg.resolve({ project: a, session: 's-b' }).config?.unifiedModels.flash.id).toBe('a-model');
    expect(reg.resolve({ session: 's-b' }).config?.unifiedModels.flash.id).toBe('b-model');
    expect(reg.resolve({}).config?.unifiedModels.flash.id).toBe('machine-model');
    expect(reg.resolve({ project: a }).project).toBe(a);
    expect(reg.resolve({ project: a }).id).toBe(tenantId(join(a, 'sonata.toml')));
  });

  it('a project without its own file resolves to the machine config, keeping its cwd as the project', () => {
    const plain = mkdtempSync(join(tmpdir(), 'tenants-plain-'));
    const t = new TenantRegistry(home).resolve({ project: plain });
    expect(t.configPath).toBe(join(home, '.config', 'sonata', 'sonata.toml'));
    expect(t.project).toBe(plain);
  });

  it('throws TenantError naming both paths when nothing resolves', () => {
    const empty = mkdtempSync(join(tmpdir(), 'tenants-empty-home-'));
    const plain = mkdtempSync(join(tmpdir(), 'tenants-plain-'));
    expect(() => new TenantRegistry(empty).resolve({ project: plain })).toThrow(TenantError);
    expect(() => new TenantRegistry(empty).resolve({ project: plain })).toThrow(new RegExp(plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('throws TenantError naming the file and the parse error for a broken config', () => {
    writeFileSync(join(a, 'sonata.toml'), '[native.gateways\n');
    expect(() => new TenantRegistry(home).resolve({ project: a })).toThrow(/sonata\.toml/);
  });

  it('known() is machine + registered sessions + noted projects, deduplicated, and skips a broken one with one log line', async () => {
    const lines: string[] = [];
    const reg = new TenantRegistry(home, { log: (l) => lines.push(l) });
    await recordSession(home, { session: 's-a', cwd: a, started: new Date().toISOString() });
    reg.noteProject(b);
    reg.noteProject(b);
    expect(reg.known().map((t) => t.configPath).sort()).toEqual([
      join(a, 'sonata.toml'), join(b, 'sonata.toml'), join(home, '.config', 'sonata', 'sonata.toml'),
    ].sort());
    writeFileSync(join(b, 'sonata.toml'), '[native.gateways\n');
    expect(reg.loadable().map((t) => t.configPath)).not.toContain(join(b, 'sonata.toml'));
    reg.known(); reg.known();
    expect(lines.filter((l) => l.includes(join(b, 'sonata.toml')))).toHaveLength(1);
  });

  it('unionSnapshot changes when any tenant\'s registry changes, and not otherwise', () => {
    const reg = new TenantRegistry(home);
    reg.noteProject(a);
    const before = reg.unionSnapshot();
    expect(reg.unionSnapshot()).toBe(before);
    writeFileSync(join(a, 'sonata.toml'), NATIVE('a-model-2'));
    expect(reg.unionSnapshot()).not.toBe(before);
  });

  it('summary() lists ids and paths for health', () => {
    const reg = new TenantRegistry(home);
    expect(reg.summary()).toEqual([{ id: tenantId(join(home, '.config', 'sonata', 'sonata.toml')), configPath: join(home, '.config', 'sonata', 'sonata.toml') }]);
  });
});
```

Add `beforeEach` to the vitest import.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/native/tenants.test.ts`
Expected: FAIL, `TenantRegistry` not exported.

- [ ] **Step 3: Implement**

Append to `src/native/tenants.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GLOBAL_CONFIG_RELATIVE, configPath as resolveConfigPath, parseConfig, type SonataConfig } from '../config.js';
import { loadSessions } from '../sessions.js';
import type { RouterTenant } from './router.js';

export interface KnownTenant {
  id: string;
  configPath: string;
  config?: SonataConfig;
  error?: string;
}

/** What `maybeRestartForModelChange` compares — the same fields `serve` snapshotted for one config. */
function nativeSnapshot(cfg: SonataConfig): unknown {
  return { legacyModels: cfg.native?.models, models: cfg.unifiedModels, gateways: cfg.native?.gateways };
}

/**
 * Which project a request belongs to, and every project the router knows.
 *
 * Configs are re-read on every call, as the single-config router already did
 * per request: the file is the user's live control surface, and a tenant edit
 * that only applies after `sonata restart` reads as broken. A parse failure is
 * logged once per distinct message per tenant, not once per request.
 */
export class TenantRegistry {
  private readonly noted = new Set<string>();
  private readonly logged = new Map<string, string>();

  constructor(
    private readonly home: string,
    private readonly deps: { log?: (line: string) => void } = {},
  ) {}

  private machinePath(): string | null {
    const path = join(this.home, GLOBAL_CONFIG_RELATIVE);
    return existsSync(path) ? path : null;
  }

  noteProject(cwd: string): void {
    this.noted.add(cwd);
  }

  private load(path: string): SonataConfig {
    return parseConfig(readFileSync(path, 'utf8'));
  }

  resolve(hint: { project?: string; session?: string }): RouterTenant {
    const cwd = hint.project ?? (hint.session === undefined ? undefined : loadSessions(this.home)[hint.session]?.cwd);
    let path: string | null;
    if (cwd !== undefined) {
      this.noteProject(cwd);
      path = resolveConfigPath(cwd, this.home);
      if (path === null) {
        throw new TenantError(
          `No sonata.toml found for ${cwd}. Looked in ${join(cwd, 'sonata.toml')} and ` +
          `${join(this.home, GLOBAL_CONFIG_RELATIVE)}. Run \`sonata init\` there, or create one.`,
        );
      }
    } else {
      path = this.machinePath();
      if (path === null) {
        throw new TenantError(
          `No sonata.toml found. The request named no project and there is no machine config at ` +
          `${join(this.home, GLOBAL_CONFIG_RELATIVE)}. Run \`sonata init\`.`,
        );
      }
    }
    let config: SonataConfig;
    try {
      config = this.load(path);
    } catch (error) {
      throw new TenantError(`${path} does not load: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { id: tenantId(path), project: cwd, configPath: path, config };
  }

  known(): KnownTenant[] {
    const paths = new Set<string>();
    const machine = this.machinePath();
    if (machine !== null) paths.add(machine);
    for (const record of Object.values(loadSessions(this.home))) {
      const path = resolveConfigPath(record.cwd, this.home);
      if (path !== null) paths.add(path);
    }
    for (const cwd of this.noted) {
      const path = resolveConfigPath(cwd, this.home);
      if (path !== null) paths.add(path);
    }
    const out: KnownTenant[] = [];
    for (const path of [...paths].sort()) {
      const id = tenantId(path);
      try {
        out.push({ id, configPath: path, config: this.load(path) });
        this.logged.delete(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.logged.get(id) !== message) {
          this.logged.set(id, message);
          this.deps.log?.(`tenants: ${path} does not load and is left out of the litellm model list: ${message}`);
        }
        out.push({ id, configPath: path, error: message });
      }
    }
    return out;
  }

  loadable(): { id: string; config: SonataConfig; configPath: string }[] {
    return this.known()
      .filter((t): t is KnownTenant & { config: SonataConfig } => t.config !== undefined)
      .map(({ id, config, configPath }) => ({ id, config, configPath }))
      .sort((x, y) => x.id.localeCompare(y.id));
  }

  unionSnapshot(): string {
    return JSON.stringify(this.loadable().map(({ id, config }) => ({ id, snapshot: nativeSnapshot(config) })));
  }

  summary(): { id: string; configPath: string | null }[] {
    return this.known().map(({ id, configPath }) => ({ id, configPath }));
  }
}
```

`import type` from router is type-only, so there is no runtime cycle; if `tsc` complains about the import order, move `RouterTenant` into `tenants.ts` and re-export it from `router.ts`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run tests/native/tenants.test.ts && npm run typecheck 2>&1 | /usr/bin/grep -v serve.ts`
Expected: tenant tests PASS; remaining typecheck errors only in `serve.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/native/tenants.ts tests/native/tenants.test.ts
git commit -m "feat(native): TenantRegistry — header, session, machine resolution and the litellm union"
```

---

### Task 6: `cmdServe` on the registry, lazy LiteLLM, ports from the machine

**Files:**
- Modify: `src/commands/serve.ts` — `cmdServe` (573-995), `startServeDaemon` (997-1060), `stopServe` (1123-1197), `cmdRestart` (1198-1213), `sonataRouterConfigPath` (323-339)
- Test: `tests/commands/serve.test.ts`, `tests/commands/serve-ledger.test.ts`

**Interfaces:**
- Consumes: `TenantRegistry` (Task 5), `litellmConfigYamlForTenants` (Task 2), `routerPorts` (Task 1), router deps (Task 4), `spentTodayUsd(home, now, project)` (Task 3).
- Produces: `sonataRouterMultiTenant(port, doFetch?): Promise<boolean | null>` — `true` when the health payload has `multiTenant: true`, `false` for a sonata router without it, `null` when the port is not a sonata router. `sonataRouterConfigPath` is deleted. `cmdServe(opts)` ignores `opts.cwd` for config (keep the field so callers compile; document it as unused).

- [ ] **Step 1: Migrate the serve tests to a machine config, then write the new tests**

In `tests/commands/serve.test.ts` and `tests/commands/serve-ledger.test.ts` every config that today is written to `join(cwd, 'sonata.toml')` must instead be the machine config, because `cmdServe` no longer reads a project file from its cwd. Add near the top of `serve.test.ts`:

```ts
/** The machine config — the only file `serve` reads its own ports from, and the default tenant for a request naming no project. */
const machineConfigPath = () => join(home, '.config', 'sonata', 'sonata.toml');
function writeMachineConfig(toml: string): void {
  mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
  writeFileSync(machineConfigPath(), toml);
}
```

Replace every `writeFileSync(join(cwd, 'sonata.toml'), X)` with `writeMachineConfig(X)`, and in `serveWith` write to the *helper's own* `home` the same way. Assertions on litellm model names become namespaced: compute `const machineId = tenantId(machineConfigPath())` (import from `../../src/native/tenants.js`) and expect `${machineId}/<key>`. `configs[1]).toContain('second-upstream')`-style checks are unchanged. A health assertion on `configPath` (line ~218) becomes `multiTenant: true`.

Then append:

```ts
describe('cmdServe — tenants', () => {
  const TENANT = (id: string, litellmPort = 4000) => `
[models."flash"]
gateway = "acme"
id = "${id}"
[tiers.code]
simple = ["flash"]
complex = ["flash"]
[native.gateways."acme"]
base_url = "https://gateway.example/v1"
[native.ports]
router = 0
litellm = ${litellmPort}
`;

  it('serves a project by its header with that project\'s own config, and namespaces the litellm model', async () => {
    writeMachineConfig(TENANT('machine-model'));
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-a-'));
    writeFileSync(join(project, 'sonata.toml'), TENANT('a-model'));
    const forwarded: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      forwarded.push((JSON.parse(init.body as string) as { model: string }).model);
      return new Response('{}', { status: 200 });
    }));
    const configs: string[] = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
      spawnLitellm: (configPath) => { configs.push(readFileSync(configPath, 'utf8')); return { pid: 1, kill: () => {} }; },
    });
    handles.push(handle);
    vi.unstubAllGlobals();
    const capture = globalThis.fetch;
    // Route through the real server with a real fetch, but stub what the router forwards.
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/__sonata_health') || String(url).includes(`localhost:${handle.routerPort}`)) return capture(url, init);
      forwarded.push((JSON.parse(init!.body as string) as { model: string }).model);
      return new Response('{}', { status: 200 });
    }));
    const res = await capture(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sonata-project': project },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    expect(res.status).toBe(200);
    const projectId = tenantId(join(project, 'sonata.toml'));
    expect(forwarded).toEqual([`${projectId}/flash`]);
    // The union list was regenerated to include the new tenant before its request was served.
    await new Promise((r) => setTimeout(r, 0));
    expect(configs.at(-1)).toContain(`${projectId}/flash`);
    expect(configs.at(-1)).toContain('a-model');
  });

  it('starts litellm lazily when the first tenant needing it appears after startup', async () => {
    // Machine config is Anthropic-direct: no litellm at startup.
    writeMachineConfig(`
[models."sonnet-like"]
gateway = "anth"
id = "some-model"
[tiers.code]
simple = ["sonnet-like"]
complex = ["sonnet-like"]
[native.gateways."anth"]
base_url = "https://anth.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = 4000
`);
    writeSonataKey(home, 'anth', 'k');
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-lazy-'));
    writeFileSync(join(project, 'sonata.toml'), TENANT('needs-litellm'));
    let spawns = 0;
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
      spawnLitellm: () => { spawns += 1; return { pid: spawns, kill: () => {} }; },
    });
    handles.push(handle);
    expect(handle.litellmPort).toBeUndefined();
    expect(spawns).toBe(0);
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes(`localhost:${handle.routerPort}`)) return real(url, init);
      return new Response('{}', { status: 200 });
    }));
    await real(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sonata-project': project },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(spawns).toBe(1);
  });

  it('answers 502 naming the install when a tenant needs litellm and the venv is missing', async () => {
    rmSync(venvDir(home), { recursive: true, force: true });
    writeMachineConfig(`
[models."m"]
gateway = "anth"
id = "some-model"
[native.gateways."anth"]
base_url = "https://anth.example"
provider = "anthropic"
[native.ports]
router = 0
litellm = 4000
`);
    writeSonataKey(home, 'anth', 'k');
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-noinstall-'));
    writeFileSync(join(project, 'sonata.toml'), TENANT('needs-litellm'));
    const handle = await cmdServe({ cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {}, spawnLitellm: () => { throw new Error('must not spawn'); } });
    handles.push(handle);
    const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sonata-project': project },
      body: JSON.stringify({ model: 'flash', messages: [] }),
    });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('sonata litellm install');
  });

  it('leaves a tenant that will not parse out of the union and still serves the others', async () => {
    writeMachineConfig(TENANT('machine-model'));
    const broken = mkdtempSync(join(tmpdir(), 'serve-tenant-broken-'));
    writeFileSync(join(broken, 'sonata.toml'), '[native.gateways\n');
    const configs: string[] = [];
    const handle = await cmdServe({
      cwd, home, tempDir: tempDirFor(), waitForLitellm: async () => {},
      spawnLitellm: (configPath) => { configs.push(readFileSync(configPath, 'utf8')); return { pid: 1, kill: () => {} }; },
    });
    handles.push(handle);
    const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sonata-project': broken },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(join(broken, 'sonata.toml'));
    expect(configs.at(-1)).toContain('machine-model');
  });

  it('ignores a project [native.ports]: the router binds the machine ports', async () => {
    writeMachineConfig(TENANT('machine-model'));
    const project = mkdtempSync(join(tmpdir(), 'serve-tenant-ports-'));
    writeFileSync(join(project, 'sonata.toml'), TENANT('a-model', 4999).replace('router = 0', 'router = 4999'));
    const handle = await cmdServe({ cwd: project, home, tempDir: tempDirFor(), waitForLitellm: async () => {}, spawnLitellm: () => ({ pid: 1, kill: () => {} }) });
    handles.push(handle);
    expect(handle.routerPort).not.toBe(4999);
    expect(handle.litellmPort).toBe(4000);
  });
});

describe('sonataRouterMultiTenant', () => {
  it('is true for a multi-tenant router, false for an older one, null for a non-router', async () => {
    const payload = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;
    expect(await sonataRouterMultiTenant(1, payload({ sonata: true, multiTenant: true }))).toBe(true);
    expect(await sonataRouterMultiTenant(1, payload({ sonata: true, configPath: '/x' }))).toBe(false);
    expect(await sonataRouterMultiTenant(1, payload({ other: true }))).toBe(null);
    expect(await sonataRouterMultiTenant(1, payload({}, false))).toBe(null);
  });
});
```

Add `sonataRouterMultiTenant` to the serve import and `tenantId` from tenants.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/commands/serve.test.ts`
Expected: compile failure (typecheck errors in serve.ts) or FAIL on the new tests.

- [ ] **Step 3: Implement**

In `src/commands/serve.ts`:

1. Imports: replace `configPath as resolveSonataConfigPath, loadConfig, resolveTierAlias, type NativeConfig, type SonataConfig` with `loadConfig, resolveTierAlias, GLOBAL_CONFIG_RELATIVE, type NativeConfig, type SonataConfig`; add `import { TenantRegistry } from '../native/tenants.js';`, `import { litellmConfigYamlForTenants } from '../native/litellm.js';` (extend the existing litellm import), `import { routerPorts } from './ports.js';`, `import { existsSync } from 'node:fs'` is already there.

2. Replace `sonataRouterConfigPath` (323-339) with:

```ts
/** Whether the sonata router on `port` is a multi-tenant one: true, false for an older single-config router, null when the port is not a sonata router. */
export async function sonataRouterMultiTenant(
  port: number,
  doFetch: typeof fetch = fetch,
): Promise<boolean | null> {
  try {
    const response = await doFetch(serveHealthUrl(port), { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const body = await response.json() as { sonata?: unknown; multiTenant?: unknown };
    if (body?.sonata !== true) return null;
    return body.multiTenant === true;
  } catch {
    return null;
  }
}

/** The one refusal every caller gives a router that predates this design. */
export function preMultiTenantMessage(port: number): string {
  return `sonata: router on port ${port} predates multi-tenant routing — run \`sonata restart\``;
}
```

3. `cmdServe` — replace the opening (lines 573-598) with:

```ts
export async function cmdServe(
  opts: { cwd: string; home: string; daemon?: boolean } & ServeDeps,
): Promise<ServeHandle> {
  // `opts.cwd` no longer chooses a config: there is one router per machine and
  // it serves every project, resolving each request's own sonata.toml. It is
  // kept on the options so callers compile, and noted as a tenant so a plain
  // `sonata serve` run inside a project has that project in the union from
  // the first request.
  const registry = new TenantRegistry(opts.home, { log: (line) => console.error(`sonata serve: ${line}`) });
  registry.noteProject(opts.cwd);
  const ports = routerPorts(opts.home);
  const machineConfigPath = join(opts.home, GLOBAL_CONFIG_RELATIVE);
  const machineConfig = (): SonataConfig | undefined => {
    try { return existsSync(machineConfigPath) ? loadConfig(dirname(machineConfigPath), opts.home) : undefined; } catch { return undefined; }
  };

  /** Merged gateways across every loadable tenant — what credential resolution and the child env are built from. */
  const mergedNative = (): NativeConfig => {
    const gateways: NativeConfig['gateways'] = {};
    for (const { config } of registry.loadable()) Object.assign(gateways, config.native?.gateways ?? {});
    return { models: {}, gateways, ports, generate: {} };
  };
  const unionNeedsLitellm = (): boolean => registry.loadable().some(({ config }) => litellmRequired(config));

  const litellmBin = managedLitellmPath(opts.home);
  /** Why litellm cannot serve, or undefined. Set lazily; cleared when a later check finds the venv healthy. */
  let litellmUnavailable: string | undefined;
  const litellmHealthy = (): boolean => {
    const status = litellmStatus(opts.home, true);
    if (status.state === 'ok' || status.state === 'stale') { litellmUnavailable = undefined; return true; }
    litellmUnavailable = `a project routes through LiteLLM, which is ${status.state} — run \`sonata litellm install\``;
    return false;
  };
  const needsLitellmAtStart = unionNeedsLitellm();
  if (needsLitellmAtStart && !litellmHealthy()) {
    // Startup keeps the loud refusal: a router that comes up with its default
    // tenant unservable is a router nobody asked for.
    throw new Error(`sonata serve: this config routes through LiteLLM, which is ${litellmStatus(opts.home, true).state} — run \`sonata litellm install\``);
  }
```

   Then through the body: every `native.ports.router` → `ports.router`, every `native.ports.litellm` → `ports.litellm`; `writeFileSync(configPath, litellmConfigYaml(native, masterKey, config.unifiedModels), ...)` → `writeFileSync(configPath, litellmConfigYamlForTenants(registry.loadable(), masterKey), ...)` (both sites); `buildChildEnv(native, ...)` → `buildChildEnv(mergedNative(), ...)` (both sites); `refreshGatewayKeys(native)` → `refreshGatewayKeys(mergedNative())`; `activeNativeSnapshot(config)` → `registry.unionSnapshot()` and `activeNativeSnapshot(freshConfig)` → the same; `maybeRestartForModelChange` takes no argument and reads `registry`; its `if (!freshConfig.native)` branch becomes `if (registry.loadable().length === 0)`; `litellmRequired(freshConfig)` → `unionNeedsLitellm()`; `let needsLitellm = needsLitellmAtStart` becomes mutable, and the `!needsLitellm` branch becomes:

```ts
      if (child === undefined) {
        // No child yet: refresh direct credentials, and if the union now needs
        // litellm, start it here — tenants appear after startup, and "run
        // sonata restart" is not an answer a hook can act on.
        try {
          childEnv = buildChildEnv(mergedNative(), opts.home, tempDir);
          refreshGatewayKeys(mergedNative());
          activeModelsJson = freshModelsJson;
        } catch (error) {
          console.error(`sonata serve: could not refresh gateway credentials: ${String(error)}`);
          return;
        }
        if (unionNeedsLitellm()) {
          if (!litellmHealthy()) {
            console.error(`sonata serve: ${litellmUnavailable}`);
            return;
          }
          writeFileSync(configPath, litellmConfigYamlForTenants(registry.loadable(), masterKey), { mode: 0o600 });
          console.error('sonata serve: a project now routes through LiteLLM — starting it');
          litellmReady = (async () => {
            child = spawnLitellmChild();
            await (opts.waitForLitellm ?? defaultWaitForLitellm)(ports.litellm, masterKey);
          })().catch((error) => { console.error(`sonata serve: litellm never came up: ${String(error)}`); });
          await litellmReady;
        }
        return;
      }
```

   `if (needsLitellm) { child = spawnLitellmChild(); ... }` at startup uses `needsLitellmAtStart`. The returned handle's `litellmPort: child !== undefined ? ports.litellm : undefined` must be computed at return time (read `child`, not `needsLitellm`).

4. Router deps block (lines ~850-930):

```ts
      tenants: () => registry.summary(),
      resolveTenant: (hint) => registry.resolve(hint),
      resolveTier: (alias, tenant) => tenant.config === undefined ? undefined : resolveTierAlias(tenant.config, alias),
      resolveGateway: (key, tenant) => tenant.config?.unifiedModels[key]?.gateway,
      budget: (tenant) => {
        const out: BudgetStatus[] = [];
        const project = tenant.config?.budget?.dailyUsd;
        if (project !== undefined && tenant.configPath !== undefined && tenant.configPath !== machineConfigPath) {
          out.push({ dailyUsd: project, spentUsd: spentTodayUsd(opts.home, Date.now(), tenant.project), configPath: tenant.configPath });
        }
        const machine = machineConfig()?.budget?.dailyUsd;
        if (machine !== undefined) out.push({ dailyUsd: machine, spentUsd: spentTodayUsd(opts.home), configPath: machineConfigPath });
        return out.length === 0 ? undefined : out;
      },
      gatewayKeys: (tenant) => {
        const out: Record<string, string> = {};
        for (const [name, gateway] of Object.entries(tenant.config?.native?.gateways ?? {})) {
          if (transportFor(gateway, name) !== 'direct') continue;
          const key = childEnv[envVarForGateway(name)];
          if (key !== undefined && key !== '') out[name] = key;
        }
        return out;
      },
      litellmUnavailable: () => litellmUnavailable,
      checkModelChange: () => {
        void maybeRestartForModelChange().catch((error) => {
          console.error(`sonata serve: model-registry restart check failed: ${String(error)}`);
        });
      },
```

   Import `type BudgetStatus` from `../budget.js`. Delete the old `configPath:` dep and `refreshGatewayKeys`'s map if the function form above makes it unused (keep `childEnv` refreshes). `recordUsage`'s `priceRow(loadConfig(opts.cwd, opts.home), ...)` becomes `priceRow(registry.resolve({ project: row.project }).config!, opts.home, row)` inside its existing try, falling back to the raw row on throw.

5. `startServeDaemon(home, argv, deps, cwd)`: replace `const config = loadConfig(cwd, home); if (!config.native) throw ...; const port = config.native.ports.router;` with `const port = routerPorts(home).router;` and spawn the child with `cwd: dirname(join(home, GLOBAL_CONFIG_RELATIVE))` when that directory exists, else `cwd`. `stopServe`/`cmdRestart`: `const config = loadConfig(opts.cwd, opts.home)` → `const port = routerPorts(opts.home).router` and use it where `config.native.ports.router` was.

6. `priceRow` is unchanged.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run typecheck && npx vitest run tests/commands/serve.test.ts tests/commands/serve-ledger.test.ts tests/native`
Expected: PASS. Fix every existing serve assertion that names a bare litellm model to the namespaced form; never delete a test.

- [ ] **Step 5: Commit**

```bash
git add src/commands/serve.ts tests/commands/serve.test.ts tests/commands/serve-ledger.test.ts
git commit -m "feat(serve): one router for every project — tenant registry, lazy litellm, machine ports"
```

---

### Task 7: Session env carries the project header

**Files:**
- Modify: `src/commands/code.ts:25-42` (`nativeSessionEnv`), `:44-52` (`planCode`)
- Modify: `src/commands/route.ts:55` (`ROUTE_ENV_KEYS`), `:77-110` (`planRouteOn`), `:138-175` (`planRouteOff`), `:489-495` (`routeScopeStatus`), `:535`
- Modify: `src/commands/doctor.ts:308,330,405-415`
- Test: `tests/commands/code.test.ts`, `tests/commands/route.test.ts`

**Interfaces:**
- Produces: `nativeSessionEnv(config: SonataConfig, routerPort: number, projectCwd?: string): Record<string, string>` — adds `ANTHROPIC_CUSTOM_HEADERS: 'x-sonata-project: <cwd>'` when `projectCwd` is given. `mergeCustomHeaders(existing: string | undefined, cwd: string): string` and `stripSonataHeader(existing: string): string | undefined` exported from `route.ts`.

- [ ] **Step 1: Write the failing tests**

In `tests/commands/code.test.ts`, the `nativeSessionEnv` describe (line ~33) — add:

```ts
  it('names the project in a custom header so the router can resolve its config', () => {
    const env = nativeSessionEnv(config, 4100, '/p/a');
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:4100');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-sonata-project: /p/a');
  });
  it('writes no header without a project cwd (global scope has no single project)', () => {
    expect(nativeSessionEnv(config, 4100).ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });
```

Update the existing `nativeSessionEnv(config)` calls in that file to `nativeSessionEnv(config, 4100)` (or the port each test's config names).

In `tests/commands/route.test.ts` add:

```ts
describe('custom headers', () => {
  it('merges the sonata line into headers the user already has, and strips only that line', () => {
    expect(mergeCustomHeaders(undefined, '/p/a')).toBe('x-sonata-project: /p/a');
    expect(mergeCustomHeaders('X-Team: blue', '/p/a')).toBe('X-Team: blue\nx-sonata-project: /p/a');
    expect(mergeCustomHeaders('X-Team: blue\nx-sonata-project: /old', '/p/a')).toBe('X-Team: blue\nx-sonata-project: /p/a');
    expect(stripSonataHeader('X-Team: blue\nx-sonata-project: /p/a')).toBe('X-Team: blue');
    expect(stripSonataHeader('x-sonata-project: /p/a')).toBeUndefined();
  });

  it('route on writes the header at project scope and route off removes only it', async () => {
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE_TOML);
    const on = planRouteOn({ env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Team: blue' } }, loadConfig(cwd, home), PACKAGE_ROOT, 'project', { routerPort: 4100, projectCwd: cwd });
    expect(on.settings.env?.ANTHROPIC_CUSTOM_HEADERS).toBe(`X-Team: blue\nx-sonata-project: ${cwd}`);
    const off = planRouteOff(on.settings, PACKAGE_ROOT);
    expect(off.settings.env?.ANTHROPIC_CUSTOM_HEADERS).toBe('X-Team: blue');
    expect(off.settings.env?.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('route on at global scope writes no header', () => {
    writeFileSync(join(cwd, 'sonata.toml'), NATIVE_TOML);
    const on = planRouteOn({}, loadConfig(cwd, home), PACKAGE_ROOT, 'global', { routerPort: 4100 });
    expect(on.settings.env?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/commands/code.test.ts tests/commands/route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/commands/code.ts`:

```ts
import { SONATA_PROJECT_HEADER } from '../native/tenants.js';
import { routerPorts } from './ports.js';

export function nativeSessionEnv(config: SonataConfig, routerPort: number, projectCwd?: string): Record<string, string> {
  if (!config.native) return {};
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: `http://localhost:${routerPort}` };
  // The router resolves the project's own sonata.toml from this header, so a
  // subagent's first request is already attributed. Only at project scope: a
  // global settings file serves every directory and has no one cwd to name.
  if (projectCwd !== undefined) env.ANTHROPIC_CUSTOM_HEADERS = `${SONATA_PROJECT_HEADER}: ${projectCwd}`;
  const windows = [
    ...Object.values(config.native.models).map((model) => model.contextWindow),
    ...Object.values(config.unifiedModels)
      .map((model) => model.contextWindow)
      .filter((window): window is number => window !== undefined),
  ];
  if (windows.length > 0) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(Math.min(...windows));
  return env;
}
```

`planCode`: `env: nativeSessionEnv(config, routerPorts(opts.home).router, opts.cwd)`.

`src/commands/route.ts`:

```ts
export const ROUTE_ENV_KEYS = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'ANTHROPIC_CUSTOM_HEADERS'] as const;

/** Adds (or replaces) the sonata project line, keeping every other header the user set. */
export function mergeCustomHeaders(existing: string | undefined, cwd: string): string {
  const kept = (existing ?? '').split('\n').filter((line) => line.trim() !== '' && !line.toLowerCase().startsWith(`${SONATA_PROJECT_HEADER}:`));
  return [...kept, `${SONATA_PROJECT_HEADER}: ${cwd}`].join('\n');
}

/** Removes only the sonata line; undefined when nothing else was there. */
export function stripSonataHeader(existing: string): string | undefined {
  const kept = existing.split('\n').filter((line) => line.trim() !== '' && !line.toLowerCase().startsWith(`${SONATA_PROJECT_HEADER}:`));
  return kept.length === 0 ? undefined : kept.join('\n');
}
```

`planRouteOn(settings, config, packageRoot, scope = 'project', target: { routerPort: number; projectCwd?: string })`: `const port = target.routerPort; const env = nativeSessionEnv(config, port, target.projectCwd);` then before merging: `if (env.ANTHROPIC_CUSTOM_HEADERS !== undefined) env.ANTHROPIC_CUSTOM_HEADERS = mergeCustomHeaders(routeEnv(settings).ANTHROPIC_CUSTOM_HEADERS, target.projectCwd!);` and use `env` where `target` was. `envChanged` compares each `ROUTE_ENV_KEYS` value as today.

`planRouteOff`: where it deletes `ROUTE_ENV_KEYS` from `env`, treat `ANTHROPIC_CUSTOM_HEADERS` specially: `const rest = stripSonataHeader(env.ANTHROPIC_CUSTOM_HEADERS ?? ''); if (rest === undefined) delete env.ANTHROPIC_CUSTOM_HEADERS; else env.ANTHROPIC_CUSTOM_HEADERS = rest;` — and count it as a change only if the value differs.

Callers of `planRouteOn` inside `cmdRoute('on')` pass `{ routerPort: routerPorts(opts.home).router, projectCwd: scope === 'project' ? opts.cwd : undefined }`. `routeScopeStatus`/`routeStatus`/`cmdRoute` read `port` from `routerPorts(home)` instead of `config.native?.ports.router` (thread `home` through; `routeStatus` already takes `home`). `cmdRouteSession` line ~749 likewise.

`src/commands/doctor.ts`: `routerUrl` at 308 and 330 → `` `http://localhost:${routerPorts(home).router}` ``; the `nativeSessionEnv(config)` call near 409 → `nativeSessionEnv(config, routerPorts(home).router, opts.cwd)`, and its comparison must compare `ANTHROPIC_BASE_URL` only (the header is scope-dependent) — read the surrounding lines and keep the existing "different port" diagnosis intact.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run typecheck && npx vitest run tests/commands/code.test.ts tests/commands/route.test.ts tests/commands/doctor.test.ts`
Expected: PASS (update existing `planRouteOn` call sites in tests to the new argument).

- [ ] **Step 5: Commit**

```bash
git add src/commands/code.ts src/commands/route.ts src/commands/doctor.ts tests/commands/code.test.ts tests/commands/route.test.ts tests/commands/doctor.test.ts
git commit -m "feat(route,code): routed sessions name their project in a custom header"
```

---

### Task 8: Every identity caller checks `multiTenant`

**Files:**
- Modify: `src/commands/code.ts:54-100` (`defaultEnsureServe`), `src/commands/run.ts:85-140` (`ensureNativeServe`), `src/commands/route.ts:730-775` (`cmdRouteSession` start branch), `src/cli.ts:474`, `src/adapters/claude.ts:35`
- Modify: `hooks/ensure-serve.mjs`
- Test: `tests/commands/code.test.ts:160-240`, `tests/commands/run.test.ts:200-280`, `tests/commands/route.test.ts:629-670`, `tests/hooks/ensure-serve.test.ts`

**Interfaces:**
- Consumes: `sonataRouterMultiTenant`, `preMultiTenantMessage` (Task 6), `routerPorts` (Task 1).

- [ ] **Step 1: Rewrite the identity tests**

In each of the four test files, replace the "different config" and "no configPath" cases with two: a router reporting `{ sonata: true, multiTenant: true }` is accepted (no daemon start), and one reporting `{ sonata: true, configPath: '/x' }` (older) is refused with `/predates multi-tenant routing/`. Keep the "starts the daemon when none is running, then checks again" tests, with the post-start check on the flag. For `ensure-serve.test.ts` the fake server returns the same two payloads; assert `stderr` contains `predates multi-tenant routing` for the old one. Also in `route.test.ts` line ~629: the `refuses to share a router port already serving a different project's config` test becomes `accepts a multi-tenant router regardless of which project started it` — two projects, both with `sonata.toml`, health `{ sonata: true, multiTenant: true }`, `cmdRouteSession('start', ...)` resolves and registers the session.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/commands/code.test.ts tests/commands/run.test.ts tests/commands/route.test.ts tests/hooks/ensure-serve.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `code.ts` `defaultEnsureServe`, `run.ts` `ensureNativeServe`, and `route.ts` `cmdRouteSession` replace each config-path comparison with:

```ts
  const port = routerPorts(home).router;
  const running = await isSonataRouter(port);
  if (running) {
    if (await sonataRouterMultiTenant(port) !== true) throw new Error(preMultiTenantMessage(port));
    return port;   // (route.ts: fall through to registration)
  }
  await startServeDaemon(home, ['sonata', 'serve', '--daemon'], {}, cwd);
  if (await sonataRouterMultiTenant(port) !== true) throw new Error(preMultiTenantMessage(port));
```

In `route.ts` keep the injected `deps.probe`/`deps.startDaemon` seams; the flag check runs only when `deps.probe === undefined`, exactly as the old identity check did. Delete `expectedConfigPath`/`resolveSonataConfigPath` uses in these three files. `cli.ts:474`: `port = routerPorts(home).router;`. `adapters/claude.ts:35`: `routerUrl = \`http://localhost:${routerPorts(homedir()).router}\`` (import `homedir` if absent).

`hooks/ensure-serve.mjs`: delete `expectedConfigPath` and the two config-path branches. After `const existing = await probeHealth(1000); if (existing) {`:

```js
    if (existing.multiTenant !== true) {
      console.error(`sonata: router on port ${port} predates multi-tenant routing — run \`sonata restart\``);
      process.exit(1);
    }
    process.exit(0);
```

Spawn the daemon with `cwd: join(homedir(), '.config', 'sonata')` when that directory exists (both scopes — there is one router), and after the wait loop apply the same `multiTenant` check to `started`. Update the file's header comment: the hook knows the port because both it and the router read it from the machine config.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run typecheck && npx vitest run tests/commands/code.test.ts tests/commands/run.test.ts tests/commands/route.test.ts tests/hooks/ensure-serve.test.ts`
Expected: PASS. Also `/usr/bin/grep -rn "sonataRouterConfigPath\|different sonata configuration" src hooks tests` must print nothing.

- [ ] **Step 5: Commit**

```bash
git add src/commands/code.ts src/commands/run.ts src/commands/route.ts src/cli.ts src/adapters/claude.ts hooks/ensure-serve.mjs tests/commands tests/hooks
git commit -m "feat(route,code,run): accept any multi-tenant router; refuse one that predates it"
```

---

### Task 9: Doctor — serve health lists tenants; project ports warning

**Files:**
- Modify: `src/commands/doctor.ts:380-420` (serve health), plus a new check after `'stray config'` (~343)
- Test: `tests/commands/doctor.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the three serve-health tests added on 2026-09-09 (`reports a router on this config's port that is serving a different project's config`, `reports a router that will not say which config it runs`, `calls a router serving this very config up`) with:

```ts
  it('calls a multi-tenant router up and lists what it serves', async () => {
    const { cwd, home } = setup();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 'ok', sonata: true, multiTenant: true, tenants: [{ id: 'aaaaaaaaaaaa', configPath: join(cwd, 'sonata.toml') }],
    }), { status: 200 })) as unknown as typeof fetch;
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      expect(checks.find((c) => c.name === 'serve health')).toEqual({ name: 'serve health', ok: true, detail: `up · 1 project(s): ${join(cwd, 'sonata.toml')}` });
    } finally { globalThis.fetch = originalFetch; }
  });

  it('fails a router that predates multi-tenant routing', async () => {
    const { cwd, home } = setup();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ status: 'ok', sonata: true, configPath: '/x' }), { status: 200 })) as unknown as typeof fetch;
    try {
      const { checks } = await cmdDoctor({ cwd, home });
      expect(checks.find((c) => c.name === 'serve health')).toMatchObject({ ok: false, detail: expect.stringContaining('sonata restart') });
    } finally { globalThis.fetch = originalFetch; }
  });

  it('warns on a project [native.ports], which the machine router ignores', async () => {
    const { cwd, home } = setup();
    writeFileSync(join(cwd, 'sonata.toml'), `${NATIVE}\n[native.ports]\nrouter = 4101\nlitellm = 4001\n`);
    const { checks } = await cmdDoctor({ cwd, home });
    expect(checks.find((c) => c.name === 'project ports')).toEqual({
      name: 'project ports', ok: true,
      detail: `${join(cwd, 'sonata.toml')} sets [native.ports], which is ignored — one router serves every project on the machine ports; delete the table`,
    });
  });
```

Also update the older `reports native serve health and key source without exposing key values` fixture to `{ sonata: true, multiTenant: true, tenants: [] }` expecting detail `up · 0 project(s)`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Serve health block:

```ts
      const healthy = response.status === 200 && body !== null && typeof body === 'object' && (body as Record<string, unknown>).sonata === true;
      if (!healthy) {
        checks.push({ name: 'serve health', ok: true, detail: 'not running — start with `sonata serve`' });
      } else if ((body as { multiTenant?: unknown }).multiTenant !== true) {
        checks.push({ name: 'serve health', ok: false, detail: `up, but predates multi-tenant routing — sessions here will refuse it; run \`sonata restart\`` });
      } else {
        const tenants = ((body as { tenants?: { configPath: string | null }[] }).tenants ?? []).map((t) => t.configPath ?? '?');
        checks.push({ name: 'serve health', ok: true, detail: `up · ${tenants.length} project(s)${tenants.length > 0 ? `: ${tenants.join(', ')}` : ''}` });
      }
```

Project ports check, after `'stray config'`:

```ts
  // One router per machine, on the machine config's ports. A project
  // [native.ports] parses (an existing file keeps loading) but does nothing,
  // and a table that does nothing while looking load-bearing is worth a line.
  if (resolved !== null && resolved !== join(home, GLOBAL_CONFIG_RELATIVE) && /^\[native\.ports\]/m.test(readFileSync(resolved, 'utf8'))) {
    checks.push({
      name: 'project ports',
      ok: true,
      detail: `${resolved} sets [native.ports], which is ignored — one router serves every project on the machine ports; delete the table`,
    });
  }
```

The fetch uses `serveHealthUrl(routerPorts(home).router)`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm run typecheck && npx vitest run tests/commands/doctor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts tests/commands/doctor.test.ts
git commit -m "feat(doctor): serve health on the multi-tenant flag; warn on project ports"
```

---

### Task 10: Full suite, then the live check

**Files:** none new.

- [ ] **Step 1: Full suite and build**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: every file passes. Fix any straggler (a test still writing `[native.ports]` into a project config and expecting it honoured is now wrong by design — rewrite it against the machine config).

- [ ] **Step 2: Live check with two projects on one router**

This machine's live router on :4100 is the one this session routes through — **do not kill it**. Use a scratch `HOME` and a scratch port:

```bash
H=$(mktemp -d); mkdir -p $H/.config/sonata
cp ~/.config/sonata/sonata.toml $H/.config/sonata/sonata.toml     # machine config (contains luna/terra)
printf '\n[native.ports]\nrouter = 4190\nlitellm = 4090\n' >> $H/.config/sonata/sonata.toml
cp -r ~/.config/sonata/credentials $H/.config/sonata/ 2>/dev/null; cp -r ~/.config/sonata/litellm $H/.config/sonata/
A=$(mktemp -d); B=$(mktemp -d); cp ~/.config/sonata/sonata.toml $A/sonata.toml; cp ~/.config/sonata/sonata.toml $B/sonata.toml
HOME=$H node dist/cli.js serve --daemon
for P in $A $B; do
  curl -s localhost:4190/v1/messages -H 'content-type: application/json' -H "x-sonata-project: $P" \
    -d '{"model":"sonata-explore-simple","max_tokens":16,"messages":[{"role":"user","content":"say ok"}]}' | head -c 200; echo
done
curl -s localhost:4190/__sonata_health
HOME=$H node dist/cli.js usage --by project --since 1h
```

Expected: both requests answer 200 from the foreign model; health lists three tenants (machine, A, B) with `multiTenant: true`; the serve log (`$H/.config/sonata/logs/serve-*.log`) shows `<tenantId>/<key> -> litellm` lines with two distinct ids; `usage --by project` shows `$A` and `$B` as separate rows. Then `HOME=$H node dist/cli.js restart` to stop cleanly (or kill the recorded `routerPid` from `$H/.config/sonata/serve-state-4190.json`).

Record the exact observed lines in the spec under a new heading `## What the live run produced (date)`.

- [ ] **Step 3: Commit the spec addendum**

```bash
git add docs/superpowers/specs/2026-09-09-multi-tenant-router-design.md
git commit -m "docs: record the multi-tenant router live run"
```

---

### Task 11: Documentation

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]`), `CLAUDE.md` (Architecture diagram; the `sonata serve`/`restart`/`route` command bullets; "Serve state is keyed by router port" and "`sonata restart` clears that occupant" paragraphs; the 2026-09-09 hook bullet; Configuration `[native.ports]`), `docs/HANDOFF.md`, `docs/guide/` (any page describing `[native.ports]` or "two projects cannot share one router port")

- [ ] **Step 1: CHANGELOG**

Under `### Added` in `[Unreleased]` (create the heading above the existing `### Fixed`):

```markdown
### Added
- **One router serves every project.** `sonata serve` is now a machine daemon
  that resolves each request's `sonata.toml` from the project it came from —
  an `x-sonata-project` header the routing env writes through
  `ANTHROPIC_CUSTOM_HEADERS`, else the session registry, else the machine
  config — and runs one LiteLLM child whose model list is the namespaced union
  (`<tenant>/<key>`) of every known project's models, started lazily the first
  time a project needs it. Ports come only from the machine config; a project
  `[native.ports]` is ignored and `sonata doctor` says so. The health endpoint
  reports `multiTenant: true` and the projects it knows, and every caller that
  used to compare `configPath` now refuses only a router predating this
  change, naming `sonata restart`. Ledger rows carry `project`; a project's
  `[budget] daily_usd` caps that project's spend and the machine's caps all of
  it, each refusal naming its file. Design:
  `docs/superpowers/specs/2026-09-09-multi-tenant-router-design.md`.
```

Under `### Fixed`, amend the 2026-09-09 "refused silently" entry's last sentences: the "different configuration" refusal and doctor line described there no longer exist; the hook still surfaces any non-zero exit.

- [ ] **Step 2: CLAUDE.md**

Update the Architecture diagram's `router (sonata serve)` line to `router (sonata serve — one per machine; resolves each request's project config)`; rewrite the `sonata serve` and `sonata restart` bullets to say ports come from the machine config and the router serves every project; replace the "Serve state is keyed by router port, because daemons run in parallel" paragraph with a short note that there is one daemon per machine and the port key remains for the legacy fallback; in the `route auto` section replace the 2026-09-09 "A refusal inside either hook is shown to the user" bullet's description of the collision with the new rule (any multi-tenant router is accepted; an older one is refused naming `sonata restart`); in Configuration, note under `[native.ports]` that only the machine file's table is read. Add a "Tenancy" paragraph under Native path summarising resolution order, namespacing, credentials not namespaced, lazy LiteLLM, and the errors table from the spec.

- [ ] **Step 3: HANDOFF and guide**

In `docs/HANDOFF.md` replace the "First external report" section's line 2 outcome with the multi-tenant router, and add the live-run result. `/usr/bin/grep -rn "share one router port\|native.ports" docs/guide` and rewrite each hit to the new rule.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md CLAUDE.md docs
git commit -m "docs: one router for every project"
```

---

### Task 12: Push

- [ ] **Step 1: Final verification**

Run: `npm run typecheck && npx vitest run && npm run build && git status --short`
Expected: all green, clean tree.

- [ ] **Step 2: Push**

```bash
git push origin main
```
