# LiteLLM Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each gateway declare which LiteLLM provider it speaks, route Anthropic-native gateways directly with no LiteLLM at all, and manage a pinned LiteLLM venv for the gateways that still need one.

**Architecture:** A gateway gains a `provider` field (superseding `wire_format`). Transport is *derived* from `provider` + `auth`: `anthropic` + api-key routes direct from sonata's own router; everything else goes through LiteLLM as `<provider>/<id>`. LiteLLM therefore becomes conditional — when no configured gateway needs it, `serve` starts no child and no Python is required. When one does, a pinned venv under `~/.config/sonata/litellm/` is created by `init`, repaired by `doctor`, and never installed by `serve`.

**Tech Stack:** TypeScript (NodeNext, `.js` specifiers on `.ts` sources), vitest, LiteLLM ≥1.98.0, `uv` or `python3` for venv creation.

**Spec:** `docs/superpowers/specs/2026-09-01-litellm-strategy-design.md`

## Status: executed 2026-09-01/02

All twelve tasks are done, on branch `litellm-venv`. `1408 tests across 79
files`, typecheck and build clean. Task 5 was implemented by a foreign-model
subagent; tasks 6–12 were implemented directly after two `code-simple`
dispatches died on routing infrastructure rather than on the work (recorded in
`CLAUDE.md`).

**Five things this plan got wrong**, each recorded in the spec rather than
quietly fixed:

1. `litellmRequired` was scoped to `[tiers]`. A bare model key never calls
   `resolveTier`, so an untiered `[models]` entry — and every pre-`[tiers]`
   config — would have started no child and 502'd.
2. Nothing populated `RouterDeps.gatewayKeys`, so the direct transport was
   structurally dead in production.
3. Task 10's `cmdLitellm` snippet used `require()` inside ESM: it typechecks
   (@types/node declares it globally) and fails only on a user's machine.
4. The install seam had a default, so 46 init tests ran real `uv pip install`
   against PyPI on any machine with uv.
5. **The atomic staging rename does not work.** A venv's console scripts carry
   absolute shebangs; the renamed venv could not run, and `litellmStatus`
   called it `ok`. Found only by task 12's live run.

## Global Constraints

- **LiteLLM pin is exactly `1.98.0`.** Written to `.sonata-pin`; a range is forbidden.
- **Python range is `>=3.10,<3.15`.** A ceiling, not just a floor — a 3.15 interpreter must be rejected.
- **Assistant content blocks must round-trip byte-identical.** `redacted_thinking` carries opaque vendor state; nothing may rewrite assistant content.
- **Never forward the caller's credential to a third-party gateway.** Strip incoming `authorization`/`x-api-key`, inject the gateway's own.
- **`serve` never installs anything.** It is started headless by `hooks/ensure-serve.mjs`.
- **Both `Installer` implementations run against the same assertions.** A test passing for only one is not done.
- **`sonata` on PATH runs `dist/`.** Run `npm run build` before any live check.
- Run `npm run typecheck` and `npm test` before every commit.

---

### Task 1: The provider table

**Files:**
- Create: `src/native/providers.ts`
- Test: `tests/native/providers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type LitellmProvider = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'mistral' | 'groq'`; `PROVIDER_FOR_GATEWAY: Record<string, LitellmProvider>`; `providerForBaseUrl(name: string): LitellmProvider`.

- [x] **Step 1: Write the failing test**

```ts
// tests/native/providers.test.ts
import { describe, it, expect } from 'vitest';
import { providerForBaseUrl, PROVIDER_FOR_GATEWAY } from '../../src/native/providers.js';

describe('providerForBaseUrl', () => {
  it('gives a known vendor its native provider', () => {
    expect(providerForBaseUrl('google')).toBe('gemini');
    expect(providerForBaseUrl('deepseek')).toBe('deepseek');
  });

  it('falls back to openai for an endpoint nobody has classified', () => {
    // `openai` is the default for the UNKNOWN, not for known vendors: an
    // OpenAI-compatible shim is the safest guess when we know nothing.
    expect(providerForBaseUrl('my-corp-proxy')).toBe('openai');
  });

  it('only names providers LiteLLM actually has', () => {
    const known = new Set(['openai', 'anthropic', 'gemini', 'deepseek', 'mistral', 'groq']);
    for (const p of Object.values(PROVIDER_FOR_GATEWAY)) expect(known).toContain(p);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/providers.test.ts`
Expected: FAIL — cannot resolve `../../src/native/providers.js`

- [x] **Step 3: Write the implementation**

```ts
// src/native/providers.ts
/**
 * Which LiteLLM provider a gateway speaks.
 *
 * LiteLLM picks its wire format from the prefix on `litellm_params.model`
 * (`custom_llm_provider`), so this is the single decision that determines
 * whether a request reaches a vendor's native API or a compatibility shim.
 * A shim is where vendor-specific state has nowhere to live — Gemini's
 * `thought_signature` is the worked example.
 */
export type LitellmProvider = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'mistral' | 'groq';

/**
 * Only entries whose endpoint has been exercised. This table doubles as a
 * lookup, and a wrong prefix is worse than a missing one: it produces a
 * confident request to the wrong dialect.
 */
export const PROVIDER_FOR_GATEWAY: Record<string, LitellmProvider> = {
  google: 'gemini',
  deepseek: 'deepseek',
  mistral: 'mistral',
  groq: 'groq',
  anthropic: 'anthropic',
};

/** `openai` is the fallback for the unknown, never the default for a known vendor. */
export function providerForBaseUrl(gateway: string): LitellmProvider {
  return PROVIDER_FOR_GATEWAY[gateway] ?? 'openai';
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/native/providers.test.ts`
Expected: PASS (3 tests)

- [x] **Step 5: Commit**

```bash
git add src/native/providers.ts tests/native/providers.test.ts
git commit -m "feat(native): a provider table, so a gateway's dialect is a fact not a default"
```

---

### Task 2: `provider` on the gateway config, migrating `wire_format`

**Files:**
- Modify: `src/config.ts:100-102` (types), `src/config.ts:147-154` (`NativeGatewayConfig`), `src/config.ts:480-525` (parsing)
- Modify: `src/normalize.ts` (`migrateLegacyConfig`)
- Test: `tests/config.test.ts`, `tests/normalize.test.ts`

**Interfaces:**
- Consumes: `LitellmProvider` from Task 1.
- Produces: `NativeGatewayConfig.provider?: LitellmProvider`. `wireFormat` remains readable for migration only.

- [x] **Step 1: Write the failing tests**

```ts
// tests/config.test.ts — add
it('parses provider on a gateway', () => {
  const c = parseConfig(`
[models."m"]
gateway = "gw"
id = "x"

[native.gateways."gw"]
base_url = "https://gw.example/v1"
provider = "gemini"
`);
  expect(c.native!.gateways.gw.provider).toBe('gemini');
});

it('refuses a provider LiteLLM does not have', () => {
  expect(() => parseConfig(`
[models."m"]
gateway = "gw"
id = "x"

[native.gateways."gw"]
base_url = "https://gw.example/v1"
provider = "not-a-provider"
`)).toThrow(/provider/);
});
```

```ts
// tests/normalize.test.ts — add
it('migrates wire_format to provider', () => {
  // `wire_format` ships in configs today; it is a two-valued subset of the
  // same idea, so it maps rather than being refused.
  const migrated = migrateLegacyConfig({
    native: { gateways: { gw: { baseUrl: 'https://x/v1', auth: 'api-key', wireFormat: 'anthropic' } } },
  } as never);
  expect(migrated.native!.gateways.gw.provider).toBe('anthropic');
  expect(migrated.native!.gateways.gw.wireFormat).toBeUndefined();
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts tests/normalize.test.ts`
Expected: FAIL — `provider` is not a property; `migrateLegacyConfig` leaves `wireFormat`

- [x] **Step 3: Add the field and parsing**

In `src/config.ts`, beside the existing wire-format types:

```ts
import type { LitellmProvider } from './native/providers.js';
export const LITELLM_PROVIDERS: readonly LitellmProvider[] =
  ['openai', 'anthropic', 'gemini', 'deepseek', 'mistral', 'groq'];
```

Add to `NativeGatewayConfig` (line 147):

```ts
  provider?: LitellmProvider;
```

In the gateway parsing block (around line 480), after the `wireFormat` handling:

```ts
      let provider: LitellmProvider | undefined;
      const rawProvider = (d as Record<string, unknown>).provider;
      if (rawProvider !== undefined) {
        if (typeof rawProvider !== 'string' || !LITELLM_PROVIDERS.includes(rawProvider as LitellmProvider)) {
          throw new Error(
            `sonata.toml: [native.gateways."${name}"].provider must be one of ` +
            `${LITELLM_PROVIDERS.join(', ')} — got ${JSON.stringify(rawProvider)}`,
          );
        }
        provider = rawProvider as LitellmProvider;
      }
```

and add `provider` to the object written at line 525.

- [x] **Step 4: Migrate `wire_format`**

In `src/normalize.ts`, inside `migrateLegacyConfig`, for each gateway:

```ts
    // `wire_format` was a two-valued subset of `provider`. Mapping rather than
    // refusing keeps every config that ships today loading.
    if (gw.wireFormat !== undefined && gw.provider === undefined) {
      gw.provider = gw.wireFormat;
      delete gw.wireFormat;
    }
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts tests/normalize.test.ts`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add src/config.ts src/normalize.ts tests/config.test.ts tests/normalize.test.ts
git commit -m "feat(config): gateways declare a provider; wire_format migrates to it"
```

---

### Task 3: Emit `<provider>/<id>` from the LiteLLM config

**Files:**
- Modify: `src/native/litellm.ts:30-95` (`litellmModelEntry`)
- Test: `tests/native/litellm.test.ts`

**Interfaces:**
- Consumes: `NativeGatewayConfig.provider` (Task 2), `providerForBaseUrl` (Task 1).
- Produces: no new exports; `litellmModelEntry` behaviour changes.

- [x] **Step 1: Write the failing test**

```ts
// tests/native/litellm.test.ts — add
it('emits the gateway provider prefix, not a blanket openai/', () => {
  const cfg = litellmConfig(configWith({
    gateways: { google: { baseUrl: 'https://g/v1beta', auth: 'api-key', provider: 'gemini' } },
    models: { 'google-flash': { gateway: 'google', id: 'gemini-2.5-flash' } },
  }), { google: 'K' });
  const entry = cfg.model_list.find((m) => m.model_name === 'google-flash')!;
  expect(entry.litellm_params.model).toBe('gemini/gemini-2.5-flash');
});

it('falls back to the table when the gateway declares no provider', () => {
  const cfg = litellmConfig(configWith({
    gateways: { google: { baseUrl: 'https://g/v1beta', auth: 'api-key' } },
    models: { 'google-flash': { gateway: 'google', id: 'gemini-2.5-flash' } },
  }), { google: 'K' });
  expect(cfg.model_list[0].litellm_params.model).toBe('gemini/gemini-2.5-flash');
});

it('still emits openai/ for an endpoint nobody has classified', () => {
  const cfg = litellmConfig(configWith({
    gateways: { acme: { baseUrl: 'https://acme/v1', auth: 'api-key' } },
    models: { 'acme-x': { gateway: 'acme', id: 'x' } },
  }), { acme: 'K' });
  expect(cfg.model_list[0].litellm_params.model).toBe('openai/x');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/litellm.test.ts`
Expected: FAIL — receives `openai/gemini-2.5-flash`

- [x] **Step 3: Replace the trailing openai branch**

In `src/native/litellm.ts`, replace the final `return` of `litellmModelEntry`:

```ts
  // The gateway's declared provider, else the table, else openai as the
  // fallback for an endpoint nobody has classified. A blanket `openai/`
  // reaches a vendor's compatibility shim rather than its native API, which
  // is where vendor-specific state has nowhere to live.
  const provider = gateways[gateway].provider ?? providerForBaseUrl(gateway);
  return {
    model_name: modelName,
    litellm_params: {
      model: `${provider}/${id}`,
      api_base: gateways[gateway].baseUrl,
      api_key: `os.environ/${envVarForGateway(gateway)}`,
    },
  };
```

Delete the now-dead `wireFormat === 'anthropic'` branch above it (Task 2 migrated the field away) and add the import:

```ts
import { providerForBaseUrl } from './providers.js';
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/native/litellm.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/native/litellm.ts tests/native/litellm.test.ts
git commit -m "feat(litellm): emit each gateway's own provider prefix"
```

---

### Task 4: Transport resolution and `litellmRequired`

**Files:**
- Modify: `src/native/providers.ts`
- Test: `tests/native/providers.test.ts`

**Interfaces:**
- Consumes: `SonataConfig`, `NativeGatewayConfig`.
- Produces: `type Transport = 'direct' | 'litellm' | 'anthropic'`; `transportFor(gw: NativeGatewayConfig, gateway: string): Transport`; `litellmRequired(config: SonataConfig): boolean`.

- [x] **Step 1: Write the failing test**

```ts
// tests/native/providers.test.ts — add
import { transportFor, litellmRequired } from '../../src/native/providers.js';

describe('transportFor', () => {
  it('routes an anthropic api-key gateway directly', () => {
    expect(transportFor({ baseUrl: 'https://x/v1', auth: 'api-key', provider: 'anthropic' }, 'x'))
      .toBe('direct');
  });

  it('routes every other api-key gateway through litellm', () => {
    expect(transportFor({ baseUrl: 'https://x/v1', auth: 'api-key', provider: 'gemini' }, 'x'))
      .toBe('litellm');
  });

  it('routes oauth gateways through litellm whatever their provider', () => {
    // Their provider is fixed by their auth: chatgpt/ needs mode: responses,
    // copilot needs a token exchange. Neither is a plain Anthropic endpoint.
    for (const auth of ['codex-oauth', 'copilot-oauth'] as const) {
      expect(transportFor({ baseUrl: 'https://x/v1', auth }, 'x')).toBe('litellm');
    }
  });
});

describe('litellmRequired', () => {
  const cfg = (gateways: Record<string, unknown>, tiers: string[]) => ({
    unifiedModels: Object.fromEntries(tiers.map((k) => [k, { gateway: k.split('-')[0], id: 'x' }])),
    tiers: { code: { simple: tiers, complex: tiers } },
    native: { gateways },
  }) as never;

  it('is false when every tier model is on an anthropic gateway', () => {
    expect(litellmRequired(cfg(
      { or: { baseUrl: 'https://or/v1', auth: 'api-key', provider: 'anthropic' } }, ['or-a']))).toBe(false);
  });

  it('is true when any tier model needs translation', () => {
    expect(litellmRequired(cfg({
      or: { baseUrl: 'https://or/v1', auth: 'api-key', provider: 'anthropic' },
      g: { baseUrl: 'https://g/v1', auth: 'api-key', provider: 'gemini' },
    }, ['or-a', 'g-b']))).toBe(true);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/providers.test.ts`
Expected: FAIL — `transportFor` is not exported

- [x] **Step 3: Write the implementation**

```ts
// src/native/providers.ts — append
import type { NativeGatewayConfig, SonataConfig } from '../config.js';

export type Transport = 'direct' | 'litellm' | 'anthropic';

/**
 * Derived, never configured separately. Two keys that can disagree is the
 * shape of the item-14 scope bug, where a writer and a cleaner defaulted
 * differently and ids leaked forever.
 */
export function transportFor(gw: NativeGatewayConfig, gateway: string): Transport {
  if (gw.auth !== 'api-key') return 'litellm';
  const provider = gw.provider ?? providerForBaseUrl(gateway);
  return provider === 'anthropic' ? 'direct' : 'litellm';
}

/**
 * Whether ANY model reachable from `[tiers]` needs LiteLLM. When false, `serve`
 * starts no child and the Python prerequisite disappears entirely.
 */
export function litellmRequired(config: SonataConfig): boolean {
  const gateways = config.native?.gateways ?? {};
  const keys = new Set(Object.values(config.tiers ?? {}).flatMap((t) => [...t.simple, ...t.complex]));
  for (const key of keys) {
    const gateway = config.unifiedModels[key]?.gateway;
    if (gateway === undefined) continue;
    const gw = gateways[gateway];
    if (gw === undefined) continue;
    if (transportFor(gw, gateway) === 'litellm') return true;
  }
  return false;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/native/providers.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/native/providers.ts tests/native/providers.test.ts
git commit -m "feat(native): derive transport, and whether litellm is needed at all"
```

---

### Task 5: Direct transport in the router

**Files:**
- Modify: `src/native/router.ts` (add `forwardDirect`; dispatch in `routeTierRequest`)
- Test: `tests/native/router.test.ts`

**Interfaces:**
- Consumes: `transportFor` (Task 4).
- Produces: `forwardDirect(body: Buffer, gw: { baseUrl: string; key: string; authHeader?: string }, req: RouterRequest, deps: RouterDeps): Promise<RouterResponse>`.

- [x] **Step 1: Write the failing test**

```ts
// tests/native/router.test.ts — add inside 'tier alias routing'
it('sends a direct-transport candidate straight to the gateway, with the gateway key', async () => {
  let seenUrl = '', seenAuth = '', seenBody = '';
  const res = await routeRequest(
    { method: 'POST', url: '/v1/messages',
      headers: { 'content-type': 'application/json', authorization: 'Bearer CALLER-SECRET' },
      body: Buffer.from(JSON.stringify({
        model: 'sonata-code-simple',
        system: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
        messages: [],
      })) },
    {
      fetch: (async (url: string, init: RequestInit) => {
        seenUrl = url; seenBody = init.body as string;
        seenAuth = (init.headers as Record<string, string>).authorization ?? '';
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      gatewayKeys: { g: 'GATEWAY-KEY' },
      resolveTier: () => ({ role: 'code', tier: 'simple', routes: [
        { key: 'direct-1', native: { gateway: 'g', id: 'model-1', transport: 'direct',
          baseUrl: 'https://gw.example/v1' } },
      ] }),
    },
  );
  expect(res.status).toBe(200);
  expect(seenUrl).toBe('https://gw.example/v1/messages');
  // The caller's credential must never reach a third-party gateway.
  expect(seenAuth).toBe('Bearer GATEWAY-KEY');
  // cache_control survives: nothing flattens on this path.
  expect(seenBody).toContain('cache_control');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/native/router.test.ts`
Expected: FAIL — request goes to `http://litellm/v1/messages`

- [x] **Step 3: Add `forwardDirect`**

```ts
// src/native/router.ts
/**
 * Forwards to an Anthropic-native gateway with no LiteLLM in the path.
 *
 * The body is passed through UNMODIFIED — no `flattenSystemBlocks`. An
 * Anthropic upstream understands block arrays, so flattening would discard
 * `cache_control` for nothing. Assistant blocks in particular must survive
 * byte-identical: `redacted_thinking` carries opaque vendor state that the
 * upstream requires echoed back exactly.
 */
async function forwardDirect(
  body: Buffer,
  gw: { baseUrl: string; key: string; authHeader?: string },
  req: RouterRequest,
  deps: RouterDeps,
): Promise<RouterResponse> {
  const headers = requestHeaders(req.headers);
  // Strip the caller's credential before injecting the gateway's. This is the
  // security boundary, not hygiene: forwarding a session credential to a
  // third-party gateway is a credential leak.
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'authorization' || name.toLowerCase() === 'x-api-key') delete headers[name];
  }
  if ((gw.authHeader ?? 'authorization').toLowerCase() === 'x-api-key') headers['x-api-key'] = gw.key;
  else headers.authorization = `Bearer ${gw.key}`;

  const response = await (deps.fetch ?? fetch)(targetUrl(gw.baseUrl, req.url), {
    method: req.method, headers, body,
  });
  return {
    status: response.status,
    headers: responseHeaders(response.headers),
    body: response.body === null ? Buffer.alloc(0) : responseBody(response.body),
  };
}
```

- [x] **Step 4: Dispatch on transport in the tier loop**

In `routeTierRequest`, replace the single `forwardToLitellm` call:

```ts
    const direct = route.native!.transport === 'direct';
    // Only the litellm path needs the string system form.
    const body = withModel(direct ? req.body : flattened, direct ? route.native!.id : route.key);
    const response = direct
      ? await forwardDirect(
          body,
          { baseUrl: route.native!.baseUrl!, key: deps.gatewayKeys?.[route.native!.gateway] ?? '' },
          req, deps)
      : await forwardToLitellm(body, headers, { ...req, body }, deps);
```

Add `gatewayKeys?: Record<string, string>` to `RouterDeps`, and `transport?: Transport; baseUrl?: string` to the native half of `TierRoute` in `src/config.ts`, populated by `resolveTierAlias` from the gateway config.

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/native/router.test.ts`
Expected: PASS (all, including the pre-existing tier tests)

- [x] **Step 6: Commit**

```bash
git add src/native/router.ts src/config.ts tests/native/router.test.ts
git commit -m "feat(router): forward anthropic-native gateways directly, no litellm in the path"
```

---

### Task 6: Assistant blocks round-trip byte-identical

**Files:**
- Test: `tests/native/router.test.ts`

**Interfaces:**
- Consumes: `forwardDirect` (Task 5).
- Produces: nothing — a guard on the Global Constraint.

- [x] **Step 1: Write the test**

```ts
// tests/native/router.test.ts — add
it('never rewrites assistant content blocks', async () => {
  // `redacted_thinking` carries opaque vendor state (measured: Gemini's
  // thought_signature via an aggregator) that the upstream requires echoed
  // back exactly. Any rewriting silently breaks the next turn.
  const assistant = [
    { type: 'redacted_thinking', data: 'OPAQUE-VENDOR-STATE-DO-NOT-TOUCH' },
    { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
  ];
  let sent = '';
  await routeRequest(
    { method: 'POST', url: '/v1/messages', headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        model: 'sonata-code-simple',
        messages: [{ role: 'assistant', content: assistant }],
      })) },
    {
      fetch: (async (_u: string, init: RequestInit) => { sent = init.body as string; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch,
      litellmBase: 'http://litellm', litellmKey: 'k',
      gatewayKeys: { g: 'K' },
      resolveTier: () => ({ role: 'code', tier: 'simple', routes: [
        { key: 'd', native: { gateway: 'g', id: 'm', transport: 'direct', baseUrl: 'https://gw/v1' } },
      ] }),
    },
  );
  expect(JSON.parse(sent).messages[0].content).toEqual(assistant);
});
```

- [x] **Step 2: Run test**

Run: `npx vitest run tests/native/router.test.ts -t "never rewrites"`
Expected: PASS if Task 5 is correct. If it FAILS, `withModel` or a flatten is touching messages — fix that, do not weaken the test.

- [x] **Step 3: Commit**

```bash
git add tests/native/router.test.ts
git commit -m "test(router): pin that assistant blocks round-trip byte-identical"
```

---

### Task 7: The managed venv module

**Files:**
- Create: `src/native/litellm-venv.ts`
- Test: `tests/native/litellm-venv.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LITELLM_VERSION = '1.98.0'`; `PYTHON_MIN = '3.10'`, `PYTHON_MAX_EXCLUSIVE = '3.15'`; `venvDir(home): string`; `managedLitellmPath(home): string`; `pythonInRange(v: string): boolean`; `type LitellmStatus`; `litellmStatus(home, required): LitellmStatus`; `type Installer`; `detectInstaller(deps): Installer | undefined`; `installLitellm(home, deps): Promise<void>`.

- [x] **Step 1: Write the failing tests**

```ts
// tests/native/litellm-venv.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pythonInRange, litellmStatus, venvDir, LITELLM_VERSION, detectInstaller,
} from '../../src/native/litellm-venv.js';

describe('pythonInRange', () => {
  it('enforces the ceiling as well as the floor', () => {
    // LiteLLM declares <3.15,>=3.10. A "3.10 or newer" check passes 3.15 and
    // fails later at the resolver, which is a much worse error to read.
    expect(pythonInRange('3.9.6')).toBe(false);
    expect(pythonInRange('3.10.0')).toBe(true);
    expect(pythonInRange('3.14.1')).toBe(true);
    expect(pythonInRange('3.15.0')).toBe(false);
  });
});

describe('litellmStatus', () => {
  const home = () => mkdtempSync(join(tmpdir(), 'lv-'));

  it('is not-required when no gateway needs litellm', () => {
    expect(litellmStatus(home(), false).state).toBe('not-required');
  });

  it('is missing when required and absent', () => {
    expect(litellmStatus(home(), true).state).toBe('missing');
  });

  it('is stale when the pin disagrees with this sonata', () => {
    const h = home();
    mkdirSync(join(venvDir(h), 'bin'), { recursive: true });
    writeFileSync(join(venvDir(h), 'bin', 'litellm'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(venvDir(h), '.sonata-pin'), '1.0.0');
    const s = litellmStatus(h, true);
    expect(s.state).toBe('stale');
  });

  it('is ok when the pin matches', () => {
    const h = home();
    mkdirSync(join(venvDir(h), 'bin'), { recursive: true });
    writeFileSync(join(venvDir(h), 'bin', 'litellm'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(venvDir(h), '.sonata-pin'), LITELLM_VERSION);
    expect(litellmStatus(h, true).state).toBe('ok');
  });

  it('is broken when the venv exists but the binary does not', () => {
    const h = home();
    mkdirSync(venvDir(h), { recursive: true });
    expect(litellmStatus(h, true).state).toBe('broken');
  });
});

describe('detectInstaller', () => {
  it('prefers uv when present', () => {
    expect(detectInstaller({ which: (b) => b === 'uv' ? '/bin/uv' : undefined, pythonVersion: () => '3.12.0' })!.kind)
      .toBe('uv');
  });

  it('falls back to python3 when uv is absent', () => {
    expect(detectInstaller({ which: (b) => b === 'python3' ? '/bin/python3' : undefined, pythonVersion: () => '3.12.0' })!.kind)
      .toBe('python3');
  });

  it('returns undefined when python3 is out of range and uv is absent', () => {
    // uv could fetch a conforming interpreter; python3 alone cannot.
    expect(detectInstaller({ which: (b) => b === 'python3' ? '/bin/python3' : undefined, pythonVersion: () => '3.9.6' }))
      .toBeUndefined();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/native/litellm-venv.test.ts`
Expected: FAIL — module not found

- [x] **Step 3: Write the implementation**

```ts
// src/native/litellm-venv.ts
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pinned exactly. This is the version every LiteLLM behaviour recorded in
 * CLAUDE.md was measured against; a range would reintroduce the "whatever the
 * user happens to have" problem this exists to remove.
 */
export const LITELLM_VERSION = '1.98.0';

/** LiteLLM declares `<3.15,>=3.10`. The ceiling is load-bearing. */
export const PYTHON_MIN = [3, 10] as const;
export const PYTHON_MAX_EXCLUSIVE = [3, 15] as const;

export function pythonInRange(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version.trim());
  if (m === null) return false;
  const v = [Number(m[1]), Number(m[2])] as const;
  const ge = v[0] > PYTHON_MIN[0] || (v[0] === PYTHON_MIN[0] && v[1] >= PYTHON_MIN[1]);
  const lt = v[0] < PYTHON_MAX_EXCLUSIVE[0] || (v[0] === PYTHON_MAX_EXCLUSIVE[0] && v[1] < PYTHON_MAX_EXCLUSIVE[1]);
  return ge && lt;
}

export function venvDir(home: string): string { return join(home, '.config', 'sonata', 'litellm'); }
export function managedLitellmPath(home: string): string { return join(venvDir(home), 'bin', 'litellm'); }
function pinPath(home: string): string { return join(venvDir(home), '.sonata-pin'); }

export type LitellmStatus =
  | { state: 'not-required' }
  | { state: 'ok'; version: string; path: string }
  | { state: 'stale'; installed: string; expected: string; path: string }
  | { state: 'missing' }
  | { state: 'broken'; reason: string }
  | { state: 'no-python'; pythonVersion?: string };

export function litellmStatus(home: string, required: boolean): LitellmStatus {
  if (!required) return { state: 'not-required' };
  if (!existsSync(venvDir(home))) return { state: 'missing' };
  const bin = managedLitellmPath(home);
  if (!existsSync(bin)) return { state: 'broken', reason: `${bin} is missing` };
  let installed = '';
  try { installed = readFileSync(pinPath(home), 'utf8').trim(); } catch { /* absent */ }
  if (installed === '') return { state: 'broken', reason: 'no .sonata-pin — provenance unknown' };
  return installed === LITELLM_VERSION
    ? { state: 'ok', version: installed, path: bin }
    : { state: 'stale', installed, expected: LITELLM_VERSION, path: bin };
}

export interface InstallerDeps {
  which(bin: string): string | undefined;
  pythonVersion(): string | undefined;
  run?(cmd: string, args: string[]): Promise<void>;
}

export interface Installer {
  readonly kind: 'uv' | 'python3';
  create(venv: string, run: NonNullable<InstallerDeps['run']>): Promise<void>;
  install(venv: string, spec: string, run: NonNullable<InstallerDeps['run']>): Promise<void>;
}

const uvInstaller: Installer = {
  kind: 'uv',
  create: (venv, run) => run('uv', ['venv', '--python', `>=${PYTHON_MIN.join('.')},<${PYTHON_MAX_EXCLUSIVE.join('.')}`, venv]),
  install: (venv, spec, run) => run('uv', ['pip', 'install', '--python', join(venv, 'bin', 'python'), spec]),
};

const python3Installer: Installer = {
  kind: 'python3',
  create: (venv, run) => run('python3', ['-m', 'venv', venv]),
  install: (venv, spec, run) => run(join(venv, 'bin', 'pip'), ['install', spec]),
};

/** uv first: it is faster AND can fetch a conforming interpreter, which is the
 *  only thing that rescues an out-of-range system python3. */
export function detectInstaller(deps: InstallerDeps): Installer | undefined {
  if (deps.which('uv') !== undefined) return uvInstaller;
  const v = deps.pythonVersion();
  if (deps.which('python3') !== undefined && v !== undefined && pythonInRange(v)) return python3Installer;
  return undefined;
}

/**
 * Builds in a temp directory and moves into place only on success, so a
 * network failure leaves `missing` (which has a working repair) rather than
 * `broken` (which invites debugging a half-built environment).
 */
export async function installLitellm(home: string, deps: InstallerDeps): Promise<void> {
  const installer = detectInstaller(deps);
  if (installer === undefined) {
    throw new Error(
      `sonata: no usable Python. LiteLLM needs ${PYTHON_MIN.join('.')}–${PYTHON_MAX_EXCLUSIVE.join('.')} ` +
      `(exclusive). Install uv (which can fetch one) or a conforming python3.`,
    );
  }
  const run = deps.run;
  if (run === undefined) throw new Error('sonata: no runner supplied');
  const final = venvDir(home);
  const staging = `${final}.installing`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
  try {
    await installer.create(staging, run);
    await installer.install(staging, `litellm[proxy]==${LITELLM_VERSION}`, run);
    writeFileSync(join(staging, '.sonata-pin'), LITELLM_VERSION);
    rmSync(final, { recursive: true, force: true });
    renameSync(staging, final);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/native/litellm-venv.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/native/litellm-venv.ts tests/native/litellm-venv.test.ts
git commit -m "feat(native): a pinned, atomically-installed managed litellm venv"
```

---

### Task 8: Both installers against the same assertions, and atomicity

**Files:**
- Test: `tests/native/litellm-venv.test.ts`

**Interfaces:**
- Consumes: `Installer`, `installLitellm` (Task 7).
- Produces: nothing — a guard on the Global Constraint about two paths.

- [x] **Step 1: Write the test**

```ts
// tests/native/litellm-venv.test.ts — add
import { installLitellm, venvDir, LITELLM_VERSION } from '../../src/native/litellm-venv.js';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

describe.each([
  ['uv', (b: string) => b === 'uv' ? '/bin/uv' : undefined],
  ['python3', (b: string) => b === 'python3' ? '/bin/python3' : undefined],
])('installLitellm via %s', (_kind, which) => {
  // The whole mitigation for accepting two install paths: identical
  // assertions. The python3 path is the one most users take and the one least
  // exercised in development, so a test passing for only one is not done.
  it('installs the pinned version and records the pin', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lv-i-'));
    const calls: string[] = [];
    await installLitellm(home, {
      which, pythonVersion: () => '3.12.0',
      run: async (cmd, args) => {
        calls.push([cmd, ...args].join(' '));
        // Simulate the venv the real tool would produce.
        const venv = args.find((a) => a.includes('.installing'))
          ?? args.find((a) => a.startsWith('/'))?.replace(/\/bin\/(python|pip)$/, '');
        if (venv !== undefined) mkdirSync(join(venv, 'bin'), { recursive: true });
      },
    });
    expect(calls.some((c) => c.includes(`litellm[proxy]==${LITELLM_VERSION}`))).toBe(true);
    expect(readFileSync(join(venvDir(home), '.sonata-pin'), 'utf8')).toBe(LITELLM_VERSION);
  });

  it('leaves no directory behind when the install fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lv-f-'));
    await expect(installLitellm(home, {
      which, pythonVersion: () => '3.12.0',
      run: async (_c, args) => {
        const venv = args.find((a) => a.includes('.installing'));
        if (venv !== undefined) mkdirSync(join(venv, 'bin'), { recursive: true });
        if (args.some((a) => a.includes('litellm[proxy]'))) throw new Error('network down');
      },
    })).rejects.toThrow(/network down/);
    // `missing` has a working repair; `broken` invites debugging a half-install.
    expect(existsSync(venvDir(home))).toBe(false);
    expect(existsSync(`${venvDir(home)}.installing`)).toBe(false);
  });
});
```

- [x] **Step 2: Run test**

Run: `npx vitest run tests/native/litellm-venv.test.ts`
Expected: PASS for both parameterisations

- [x] **Step 3: Commit**

```bash
git add tests/native/litellm-venv.test.ts
git commit -m "test(native): both installers under one suite, and a failed install leaves nothing"
```

---

### Task 9: `serve` — conditional child, managed binary, never installs

**Files:**
- Modify: `src/commands/serve.ts:244` (spawn), and the startup path around `:500`
- Test: `tests/commands/serve.test.ts`

**Interfaces:**
- Consumes: `litellmRequired` (Task 4), `litellmStatus`, `managedLitellmPath` (Task 7).
- Produces: no new exports.

- [x] **Step 1: Write the failing tests**

```ts
// tests/commands/serve.test.ts — add
it('starts no litellm child when no gateway needs one', async () => {
  // Asserted on the spawn seam, not by absence of error: "it did not crash"
  // is not evidence that nothing was spawned.
  let spawned = 0;
  const { stop } = await cmdServe({
    ...baseOpts(anthropicOnlyConfig),
    spawnLitellm: () => { spawned++; return fakeChild(); },
  });
  expect(spawned).toBe(0);
  await stop();
});

it('refuses to start, naming the repair, when litellm is required but missing', async () => {
  await expect(cmdServe({ ...baseOpts(litellmNeedingConfig) }))
    .rejects.toThrow(/sonata litellm install/);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands/serve.test.ts`
Expected: FAIL — a child is spawned; no refusal

- [x] **Step 3: Gate the child on requirement and status**

In `cmdServe`, before spawning:

```ts
  const needsLitellm = litellmRequired(config);
  if (needsLitellm) {
    const status = litellmStatus(opts.home, true);
    if (status.state !== 'ok' && status.state !== 'stale') {
      // Never install here: `hooks/ensure-serve.mjs` starts serve headless from
      // a SessionStart hook, where a silent multi-minute pip install is
      // indistinguishable from a hang.
      throw new Error(
        `sonata serve: LiteLLM is ${status.state} and this config needs it — run \`sonata litellm install\``,
      );
    }
  }
```

and make the spawn conditional, using the managed path:

```ts
  const child = needsLitellm
    ? (opts.spawnLitellm ?? defaultSpawnLitellm)(configPath, childEnv, native.ports.litellm)
    : undefined;
```

Change `defaultSpawnLitellm` (line 244) to spawn `managedLitellmPath(home)` rather than the bare name, and guard the respawn watcher on `child !== undefined`.

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands/serve.test.ts`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add src/commands/serve.ts tests/commands/serve.test.ts
git commit -m "feat(serve): no litellm child when nothing needs one; refuse rather than install"
```

---

### Task 10: `sonata litellm install|status`, and doctor

**Files:**
- Create: `src/commands/litellm.ts`
- Modify: `src/cli.ts` (command dispatch), `src/commands/doctor.ts:311`
- Test: `tests/commands/litellm.test.ts`, `tests/commands/doctor.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `cmdLitellm(action: 'install' | 'status', opts): Promise<number>`.

- [x] **Step 1: Write the failing tests**

```ts
// tests/commands/doctor.test.ts — add
it('says litellm is not required rather than not installed', async () => {
  // "not installed" reads as a fault. For a config no gateway routes through
  // litellm, its absence is correct.
  const { checks } = await cmdDoctor({ cwd: anthropicOnlyCwd, home });
  const c = checks.find((x) => x.name === 'litellm')!;
  expect(c.ok).toBe(true);
  expect(c.detail).toMatch(/no gateway needs/i);
});

it('names the repair command when litellm is required but missing', async () => {
  const { checks } = await cmdDoctor({ cwd: litellmNeedingCwd, home });
  const c = checks.find((x) => x.name === 'litellm')!;
  expect(c.ok).toBe(false);
  expect(c.detail).toContain('sonata litellm install');
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands/doctor.test.ts`
Expected: FAIL — detail still reads `not found — pip install ...`

- [x] **Step 3: Report the status value in doctor**

Replace the block at `src/commands/doctor.ts:311`:

```ts
    const required = litellmRequired(config);
    const status = litellmStatus(home, required);
    const detail = {
      'not-required': 'not needed — no gateway routes through it',
      ok: `${(status as { path?: string }).path ?? ''} (${LITELLM_VERSION})`,
      stale: `installed ${(status as { installed?: string }).installed} but this sonata pins ${LITELLM_VERSION} — run \`sonata litellm install\``,
      missing: 'required by this config but not installed — run `sonata litellm install`',
      broken: `installed but unusable — run \`sonata litellm install\``,
      'no-python': `no usable Python (needs >=3.10,<3.15) — install uv, or a conforming python3`,
    }[status.state];
    checks.push({ name: 'litellm', ok: status.state === 'ok' || status.state === 'not-required' || status.state === 'stale', detail });
    // A PATH litellm is information, not what sonata runs.
    const onPath = findLitellm();
    if (onPath !== null && status.state !== 'not-required') {
      checks.push({ name: 'litellm (PATH)', ok: true, detail: `${onPath} — not used; sonata runs its own pinned venv` });
    }
```

- [x] **Step 4: Add the command**

```ts
// src/commands/litellm.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../config.js';
import { litellmRequired } from '../native/providers.js';
import { installLitellm, litellmStatus, LITELLM_VERSION } from '../native/litellm-venv.js';

const run = promisify(execFile);

export async function cmdLitellm(
  action: 'install' | 'status',
  opts: { cwd: string; home: string; write?: (l: string) => void },
): Promise<number> {
  const out = opts.write ?? ((l: string) => console.log(l));
  const config = loadConfig(opts.cwd, opts.home);
  const required = litellmRequired(config);

  if (action === 'status') {
    const s = litellmStatus(opts.home, required);
    out(`litellm: ${s.state}${'path' in s ? ` — ${s.path}` : ''}`);
    return s.state === 'ok' || s.state === 'not-required' ? 0 : 1;
  }

  if (!required) {
    out('No gateway in this config routes through LiteLLM — nothing to install.');
    return 0;
  }
  out(`Installing litellm[proxy]==${LITELLM_VERSION} (uv: seconds; pip: a few minutes)…`);
  await installLitellm(opts.home, {
    which: (b) => { try { return require('node:child_process').execFileSync('which', [b], { encoding: 'utf8' }).trim() || undefined; } catch { return undefined; } },
    pythonVersion: () => { try { return require('node:child_process').execFileSync('python3', ['-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], { encoding: 'utf8' }).trim(); } catch { return undefined; } },
    run: async (cmd, args) => { await run(cmd, args); },
  });
  out('Done.');
  return 0;
}
```

Wire it in `src/cli.ts` beside the other commands.

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add src/commands/litellm.ts src/commands/doctor.ts src/cli.ts tests/
git commit -m "feat(cli): sonata litellm install|status, and a doctor check that names the state"
```

---

### Task 11: `init` offers the install; docs and roadmap

**Files:**
- Modify: `src/init/plan.ts` (summary line), `src/init/apply.ts` (install step), `src/commands/init.ts`
- Modify: `README.md` (Requirements), `CLAUDE.md`, `docs/roadmap.md` (item 09), `CHANGELOG.md`
- Test: `tests/init/plan.test.ts`

**Interfaces:**
- Consumes: `litellmRequired`, `installLitellm`.
- Produces: nothing.

- [x] **Step 1: Write the failing test**

```ts
// tests/init/plan.test.ts — add
it('plans a litellm install only when the chosen config needs one', () => {
  const needing = plan(env(), state, noCredentials, opts);
  expect(needing.installLitellm).toBe(true);

  const anthropicOnly = plan(env(), { ...state, /* gateway with provider: 'anthropic' */ }, noCredentials, opts);
  expect(anthropicOnly.installLitellm).toBe(false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/init/plan.test.ts`
Expected: FAIL — `installLitellm` is not on `InitPlan`

- [x] **Step 3: Add it to the plan and apply it**

Add `installLitellm: boolean` to `InitPlan`, set from `litellmRequired` on the config the plan emits, show it in the summary (`  litellm  install litellm[proxy]==1.98.0` or `not needed`), and in `apply` run `installLitellm(home, …)` when true, printing progress.

- [x] **Step 4: Update the docs**

- `README.md` Requirements: LiteLLM is no longer an unconditional prerequisite. State that sonata manages a pinned venv when a gateway needs one, and that `uv` or `python3 >=3.10,<3.15` is required only in that case.
- `CLAUDE.md`: replace the `pip install 'litellm[proxy]'` prerequisite line with the managed-venv description and the provider/transport model.
- `docs/roadmap.md` item 09: mark shipped, noting LiteLLM became conditional.
- `CHANGELOG.md` under `## [Unreleased]`.

- [x] **Step 5: Run the full suite and build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(init): install litellm only when the config needs it; update the docs"
```

---

### Task 12: Live verification

**Files:** none — this task produces evidence, not code.

**Interfaces:**
- Consumes: everything.
- Produces: a paragraph for the PR body.

- [x] **Step 1: Direct transport, end to end**

Configure a scratch `HOME` with an `openrouter` gateway at `provider = "anthropic"`, run `sonata serve`, dispatch one real request, and confirm from `sonata usage` that a row was recorded with correct tokens. Confirm from the serve log that **no litellm child was started**.

- [x] **Step 2: The install, on the slow path**

On a machine or container without `uv` on PATH, run `sonata litellm install` and confirm it completes and `sonata litellm status` reports `ok`. This is the path most users take and the one CI cannot exercise.

- [x] **Step 3: Record the results in the PR body**

Both outcomes verbatim, including the absence of the litellm child. Do not claim either without the output.

---

## Self-Review

**Spec coverage.** Findings 1 and 2 → Tasks 4–6. Finding 3 (dialect, no defect) → Tasks 1–3. Provider table → Task 1. Migration → Task 2. Direct transport and the auth third mode → Task 5. Byte-identical assistant blocks → Task 6. Managed venv, pin, range, atomicity, six-state status → Tasks 7–8. `not-required` and conditional child → Tasks 4, 9, 10. init/doctor/serve division → Tasks 9–11. Testing section → distributed. Live verification → Task 12.

**Gap found and closed:** the spec's `auth_header` per-gateway config is *not* implemented as a config key — Task 5 supports `x-api-key` in `forwardDirect` but nothing writes it, since every probed endpoint accepted `Authorization: Bearer`. Adding the key with no verified consumer would be speculative; it is deferred until a gateway needs it, and this paragraph records the decision.

**Type consistency.** `LitellmProvider`, `Transport`, `LitellmStatus`, `Installer`, `InstallerDeps` are defined once (Tasks 1, 4, 7) and referenced identically after. `litellmStatus(home, required)` takes the same two arguments at all four call sites (Tasks 7, 9, 10).
