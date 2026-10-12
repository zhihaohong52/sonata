# Claude Models as Ordinary Sonata Models — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any tier may rank a Claude model, whether a gateway serves it or the person's own Claude Code account does. Every request's true cost is its API list price, shown everywhere and marked `sub` when a subscription paid.

**Architecture:**
- **Config.** The `claude-` refusal (`isAnthropicRoutedName`) is deleted. A new gateway auth kind `session` forwards the caller's own credential, and only ever to `api.anthropic.com`.
- **Router.** Configured keys are resolved before the router's last-resort "`claude-*` goes to Anthropic" pass-through. A `session` request records which credential paid it on its ledger row.
- **Pricing.** That record decides `covered` vs `priced`.
- **Display.** `usage`, `status` and the loop panel show list cost with a `sub` mark.

**Tech Stack:** TypeScript (Node 22), vitest, Ink (init TUI), the Claude Code mod API (loop panel, `claude plugin test`).

**Spec:** `docs/superpowers/specs/2026-10-12-claude-models-design.md`

## Global Constraints

- **The session credential's destination.** A `session` gateway's credential (the caller's `authorization`/`x-api-key`) is only ever sent to `https://api.anthropic.com`. The parser refuses any other `base_url`.
- **No credential in logs or the ledger.** The credential never appears in a log line, a ledger row, an error message or a test snapshot. Only its classification (`subscription` | `key`) is recorded.
- **Unknown is never zero.** An unpriced model shows no cost (`—`), never `$0`.
- **`[budget] daily_usd` counts billed money only.** `covered` rows never count.
- **`sonata init` deletes whatever it does not write back.** Every new config value round-trips through `nativeTomlFor` → `parseConfig`, with a test.
- **The rest of the body is untouched.** A request forwarded to Anthropic keeps its body byte-identical except `model`.
- **The `sub` marker.** It is the literal text `sub`, after the amount, separated by one space: `$0.42 sub`. Mixed: `$1.10 + $0.42 sub`.
- **Release.** CHANGELOG under `## [Unreleased]`, released as a **minor** bump.
- **Branch.** `feat/claude-models` in `~/Documents/workspace/sonata-claude-models`. Stage explicit paths only, never `git add -A`. One commit per task.
- **Verify.** Run `npm run typecheck` and the task's tests before each commit. The panel's tests run with `claude plugin test skills/loop`.

## Review Focus

1. **A session gateway with a `base_url` that only looks like Anthropic's.** `https://api.anthropic.com.evil.test/v1`, `http://api.anthropic.com/v1` and `https://api.anthropic.com@evil.test/v1` must all be refused. Compare the parsed URL's `protocol` and `host`, never a string prefix. *Pinned in Task 1.*
2. **A main-session `claude-*` request when the config defines no such key.** It must still reach Anthropic byte-identical with the caller's headers. This is every routed session's own turns. *Pinned in Task 2.*
3. **A tier candidate on a session gateway, reached by a request with no credential at all** (a `sonata dispatch` harness run, a misconfigured client). It must fall through to the next candidate, not 500. *Pinned in Task 2.*
4. **A `claude-*@low` request.** When the key is configured, it splits into key and effort. When not, it passes through unsplit as today, since Anthropic will 404 it either way. *Pinned in Task 2.*
5. **Ledger rows written before this change** (no `credential` field) on a session-like gateway, and covered rows with a `totalUsd`. `status` and `usage` must not crash on either, and old rows read as not covered. *Pinned in Tasks 3 and 4.*

---

### Task 1: Config — remove the `claude-` refusal, add `auth = "session"`

**Files:**
- Modify: `src/config.ts`. Lines ~151–166 (`ANTHROPIC_ROUTED_PREFIX`, `isAnthropicRoutedName`): delete. Lines 118–120: auth kinds. Line ~396 (`[models]` key refusal), line ~508 (`[tiers]` candidate refusal), line ~852 (`[native.models]` refusal): delete. Lines ~681–812: gateway parsing. Line ~1061: `nativeRouteFor`.
- Modify: `src/native/providers.ts:96-103` (`transportFor`).
- Modify: `src/native/router.ts:22` (`TierRoute.native` gains `auth`).
- Modify: `src/init/toml.ts:196-235` (write `auth = "session"`).
- Modify: `src/commands/serve.ts:1068-1069` (skip `session` in key resolution).
- Modify: `src/commands/auth.ts:36` (`login` refuses `session`), plus the `add` path (search `export async function cmdAuthAdd` or the `add` branch in `src/cli.ts`'s `auth` command; refuse `session` gateways there with the same wording).
- Test: `tests/config.test.ts`, `tests/init/toml.test.ts`, `tests/native/providers.test.ts`.

**Interfaces:**
- Produces:
  - `type NativeGatewayAuth = 'api-key' | 'codex-oauth' | 'copilot-oauth' | 'session'`
  - `const ANTHROPIC_SESSION_BASE_URL = 'https://api.anthropic.com/v1'` (exported from `src/config.ts`)
  - `TierRoute['native']` becomes `{ gateway: string; id: string; transport?: Transport; baseUrl?: string; auth?: NativeGatewayAuth }`. `nativeRouteFor` fills `auth` from the gateway.
  - `transportFor(gw)` returns `'direct'` for `auth === 'session'`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/config.test.ts`:

```ts
describe('parseConfig — Claude models are ordinary models', () => {
  const tiers = (key: string) => `\n[tiers.code]\nsimple = ["${key}"]\n`;

  it('accepts a claude- key in [models] and [tiers]', () => {
    const cfg = parseConfig(`schema_version = 1
[native.gateways."copilot"]
auth = "copilot-oauth"
[models."claude-sonnet-4.5"]
gateway = "copilot"
id = "claude-sonnet-4.5"
${tiers('claude-sonnet-4.5')}`);
    expect(cfg.unifiedModels['claude-sonnet-4.5'].id).toBe('claude-sonnet-4.5');
    expect(cfg.tiers?.code?.simple).toEqual(['claude-sonnet-4.5']);
  });

  it('accepts a session gateway and defaults its base_url to Anthropic', () => {
    const cfg = parseConfig(`schema_version = 1
[native.gateways."claude"]
provider = "anthropic"
auth = "session"
[models."opus"]
gateway = "claude"
id = "claude-opus-4-1"
${tiers('opus')}`);
    expect(cfg.native!.gateways.claude).toMatchObject({ auth: 'session', baseUrl: ANTHROPIC_SESSION_BASE_URL, provider: 'anthropic' });
    expect(nativeRouteFor(cfg, 'opus')).toEqual({ gateway: 'claude', id: 'claude-opus-4-1', transport: 'direct', baseUrl: ANTHROPIC_SESSION_BASE_URL, auth: 'session' });
  });

  it.each([
    'https://api.anthropic.com.evil.test/v1',
    'http://api.anthropic.com/v1',
    'https://api.anthropic.com@evil.test/v1',
    'https://gateway.example/v1',
    'not a url',
  ])('refuses a session gateway whose base_url is %s', (url) => {
    expect(() => parseConfig(`schema_version = 1
[native.gateways."claude"]
provider = "anthropic"
auth = "session"
base_url = "${url}"
`)).toThrow(/session.*api\.anthropic\.com/);
  });

  it('accepts the Anthropic base_url spelled with or without /v1', () => {
    for (const url of ['https://api.anthropic.com', 'https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/']) {
      const cfg = parseConfig(`schema_version = 1\n[native.gateways."claude"]\nprovider = "anthropic"\nauth = "session"\nbase_url = "${url}"\n`);
      expect(cfg.native!.gateways.claude.baseUrl).toBe(ANTHROPIC_SESSION_BASE_URL);
    }
  });

  it('refuses a session gateway on any provider but anthropic, and with a credential_source', () => {
    expect(() => parseConfig(`schema_version = 1\n[native.gateways."claude"]\nprovider = "openai"\nauth = "session"\n`))
      .toThrow(/session.*provider = "anthropic"/);
    expect(() => parseConfig(`schema_version = 1\n[native.gateways."claude"]\nauth = "session"\n`))
      .toThrow(/session.*provider = "anthropic"/);
    expect(() => parseConfig(`schema_version = 1\n[native.gateways."claude"]\nprovider = "anthropic"\nauth = "session"\ncredential_source = "sonata"\n`))
      .toThrow(/session.*credential_source/);
  });
});
```

  Add `ANTHROPIC_SESSION_BASE_URL` and `nativeRouteFor` to the file's import from `../src/config.js`. Then **replace** the existing tests that assert the refusal: `tests/config.test.ts:453` ("refuses a native model key beginning claude-") becomes "accepts a native model key beginning claude-" with `.not.toThrow()`. Grep the file for `toThrow(/claude-/)` and invert each one the same way. In `tests/adapters/claude.test.ts`, drop the `isAnthropicRoutedName` import and the assertion at line 236; Task 7 rewrites that file's prefix logic.

  Append to `tests/native/providers.test.ts`:

```ts
it('reaches a session gateway directly, never through LiteLLM', () => {
  expect(transportFor({ baseUrl: 'https://api.anthropic.com/v1', auth: 'session', provider: 'anthropic' }, 'claude')).toBe('direct');
});
```

  Append to `tests/init/toml.test.ts`. Model it on the nearest existing `nativeTomlFor` round-trip test in that file, and keep its fixture helpers. It must assert that a config holding a `session` gateway, written by `nativeTomlFor` and read back by `parseConfig`, yields `auth: 'session'`, no `base_url` line, `provider = "anthropic"`, and no `credential_source`.

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `npx vitest run tests/config.test.ts tests/native/providers.test.ts tests/init/toml.test.ts`
  Expected: FAIL. `ANTHROPIC_SESSION_BASE_URL` is not exported, `unknown auth "session"`, and `cannot use the "claude-" prefix`.

- [ ] **Step 3: Implement.**
  - **Delete** `ANTHROPIC_ROUTED_PREFIX`, `isAnthropicRoutedName` and their three refusal blocks in `parseConfig`. Remove the now-unused imports everywhere `tsc` reports them. The `init` call sites get real replacements in Task 6; for now delete the `.filter(... !isAnthropicRoutedName ...)` clauses outright (`src/init/helpers.ts:305`, `models-step.tsx:113`, `byok-step.tsx:78,193`, `providers-step.tsx:132,136`). `src/adapters/claude.ts:51` becomes `const anthropicRouted = false;` until Task 7.
  - **Auth kinds:**

```ts
export type NativeGatewayAuth = 'api-key' | 'codex-oauth' | 'copilot-oauth' | 'session';
export const NATIVE_GATEWAY_AUTHS: readonly NativeGatewayAuth[] = ['api-key', 'codex-oauth', 'copilot-oauth', 'session'];

/**
 * Where a `session` gateway sends the caller's own credential — and the only
 * place it may: the credential is Claude Code's own, and any other host would
 * receive it in the clear.
 */
export const ANTHROPIC_SESSION_BASE_URL = 'https://api.anthropic.com/v1';

/** Whether `url` is Anthropic's API itself: https, host exactly api.anthropic.com, path empty or /v1. */
function isAnthropicApiUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'https:' && parsed.host === 'api.anthropic.com'
    && parsed.username === '' && parsed.password === ''
    && /^\/(v1\/?)?$/.test(parsed.pathname) && parsed.search === '' && parsed.hash === '';
}
```

  - **In the gateway loop**, directly after `const auth = rawAuth as NativeGatewayAuth;`, add the session branch. It must come *before* the `credential_source` parsing, and read `d.credential_source`, `d.provider` and `d.base_url` directly:

```ts
      if (auth === 'session') {
        // The person's own Claude Code account: the caller's credential is
        // forwarded as-is, so where it may go is the whole security question.
        if (d.provider !== 'anthropic') {
          throw new Error(`sonata.toml: native gateway "${name}" is auth = "session", which needs provider = "anthropic".`);
        }
        if (d.credential_source !== undefined) {
          throw new Error(
            `sonata.toml: native gateway "${name}" is auth = "session", so it cannot set credential_source — ` +
            'its credential is the session\'s own, never a stored one. Remove credential_source.',
          );
        }
        if (d.base_url !== undefined && (typeof d.base_url !== 'string' || !isAnthropicApiUrl(d.base_url))) {
          throw new Error(
            `sonata.toml: native gateway "${name}" is auth = "session", so its base_url must be ` +
            `https://api.anthropic.com — the session's credential goes nowhere else. Remove base_url.`,
          );
        }
        const price = parsePrice(d.price, `[native.gateways."${name}"]`);
        const pricingProvider = parsePricingProvider(name, d.pricing_provider);
        gateways[name] = { baseUrl: ANTHROPIC_SESSION_BASE_URL, auth, provider: 'anthropic', price, pricingProvider };
        continue;
      }
```

  - **Extract `parsePricingProvider`.** Move the existing `pricing_provider` block (lines ~761–792) into `function parsePricingProvider(name: string, raw: unknown): string[] | undefined` with the same errors, and call it from both the session branch and the original place.
  - **`transportFor`** (`src/native/providers.ts`), before the `api-key` check:

```ts
  // A session gateway is Anthropic itself, reached with the caller's own credential.
  if (gw.auth === 'session') return 'direct';
```

  - **`nativeRouteFor`** adds `auth: gw?.auth`, but only when `gw` is defined: `...(gw !== undefined ? { auth: gw.auth } : {})`. **`TierRoute.native`** adds `auth?: NativeGatewayAuth`. Import the type from `../config.js`; a type-only import creates no cycle.
  - **`nativeTomlFor`** (`src/init/toml.ts`). Where it pushes `base_url`/`auth`, write `auth = "session"` and **no** `base_url` for a session gateway. Skip `credential_source` for it, and always write `provider = "anthropic"` for it:

```ts
    if (isOauthGatewayAuth(auth) || auth === 'session') lines.push(`auth = ${tomlKey(auth)}`);
    if (!isOauthGatewayAuth(auth) && auth !== 'session') lines.push(`base_url = ${tomlKey(baseUrl)}`);
    const source = auth === 'session' ? undefined : credentialSources[gateway];
```

    Also change the `providerToWrite` line so that `auth === 'session'` yields `'anthropic'`.
  - **`serve.ts:1069`:** filter out `gateway.auth === 'session'` from `automaticallyResolved`, since a session gateway has no key to find.
  - **`auth.ts` login:** before the `isOauthGatewayAuth` check, refuse with: `sonata auth login: gateway "<name>" is auth = "session" — it uses the Claude Code session's own credential; there is nothing to log in to.` Use the same sentence for `auth add` with its own command name.

- [ ] **Step 4: Run the tests and confirm they pass, plus the suites that touch auth kinds.**
  Run: `npx vitest run tests/config.test.ts tests/native/providers.test.ts tests/init/toml.test.ts tests/commands/serve.test.ts tests/commands/doctor.test.ts && npm run typecheck`
  Expected: PASS, and no type errors.

- [ ] **Step 5: Commit.**

```bash
git add src/config.ts src/native/providers.ts src/native/router.ts src/init/toml.ts src/commands/serve.ts src/commands/auth.ts src/cli.ts src/init/helpers.ts src/tui-ink/components/models-step.tsx src/tui-ink/components/byok-step.tsx src/tui-ink/components/providers-step.tsx src/adapters/claude.ts tests/config.test.ts tests/native/providers.test.ts tests/init/toml.test.ts tests/adapters/claude.test.ts
git commit -m "feat(config): Claude models are ordinary models; auth = \"session\" gateways"
```

---

### Task 2: Router — configured keys first, session forwarding, credential classification

**Files:**
- Modify: `src/native/router.ts`:
  - `isClaudeRequest` (~1422);
  - `routeRequest`'s `@` split (~2338–2350) and its `anthropic` decision (~2458–2475);
  - `forwardDirect` (~1795–1840) and its two call sites (~1990 tier loop, ~2486 bare key);
  - `RecordContext` (~434) and `withUsageRecording`.
- Modify: `src/ledger.ts:64` (`LedgerRow` gains `credential`).
- Test: `tests/native/router.test.ts`, `tests/native/router-usage.test.ts`.

**Interfaces:**
- Consumes: `TierRoute['native'].auth` (Task 1).
- Produces:
  - `LedgerRow.credential?: 'subscription' | 'key'`, present only on rows served by a `session` gateway.
  - `export function sessionCredential(headers: Record<string, string>): 'subscription' | 'key' | undefined` (exported from `src/native/router.ts`; `undefined` when the request carries no credential).

- [ ] **Step 1: Write the failing tests.** Append to `tests/native/router.test.ts`, inside `describe('routeRequest', …)`. Use the file's `req(model)`, `fakeFetch` and `base` helpers; extend `req` with headers via a spread where it doesn't take them.

```ts
  const SESSION = { gateway: 'claude', id: 'claude-opus-4-1', transport: 'direct' as const, baseUrl: 'https://api.anthropic.com/v1', auth: 'session' as const };
  const withHeaders = (model: string, headers: Record<string, string>) =>
    ({ method: 'POST', url: '/v1/messages', headers, body: Buffer.from(JSON.stringify({ model, messages: [] })) });

  it('routes a configured claude- key to its own gateway, not to Anthropic', async () => {
    const rec: FetchCall[] = [];
    const res = await routeRequest(withHeaders('claude-sonnet-4.5', { authorization: 'Bearer usr' }), {
      ...base, fetch: fakeFetch(rec),
      resolveNative: (key) => key === 'claude-sonnet-4.5' ? { gateway: 'copilot', id: 'claude-sonnet-4.5', transport: 'litellm' as const } : undefined,
    });
    expect(res.status).toBe(200);
    expect(rec[0].url).toBe('http://lite/v1/messages');
  });

  it('still passes an unconfigured claude- name to Anthropic byte-identical with the caller headers', async () => {
    const rec: { url: string; headers: Record<string, string>; body: string }[] = [];
    const body = JSON.stringify({ model: 'claude-opus-4-1', system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }] });
    await routeRequest({ method: 'POST', url: '/v1/messages', headers: { authorization: 'Bearer usr' }, body: Buffer.from(body) }, {
      ...base, resolveNative: () => undefined,
      fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
        rec.push({ url: String(u), headers: Object.fromEntries(new Headers(init?.headers)), body: Buffer.from(init!.body as Uint8Array).toString() });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    expect(rec[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(rec[0].headers.authorization).toBe('Bearer usr');
    expect(rec[0].body).toBe(body);
  });

  it('forwards a session candidate with the caller credential, rewriting only model', async () => {
    const rec: { url: string; headers: Record<string, string>; body: string }[] = [];
    const sent = { model: 'sonata-code-complex', system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }], messages: [] };
    await serveFully({ method: 'POST', url: '/v1/messages', headers: { authorization: 'Bearer sk-ant-oat01-x', 'anthropic-beta': 'oauth-2025-04-20' }, body: Buffer.from(JSON.stringify(sent)) }, {
      ...base,
      resolveTier: () => ({ role: 'code', tier: 'complex', routes: [{ key: 'opus', native: SESSION }] }),
      fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
        rec.push({ url: String(u), headers: Object.fromEntries(new Headers(init?.headers)), body: Buffer.from(init!.body as Uint8Array).toString() });
        return new Response(COMPLETE_BODY, { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    expect(rec[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(rec[0].headers.authorization).toBe('Bearer sk-ant-oat01-x');
    expect(rec[0].headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(JSON.parse(rec[0].body)).toEqual({ ...sent, model: 'claude-opus-4-1' });
  });

  it('falls through to the next candidate when a session candidate answers 401', async () => {
    const urls: string[] = [];
    const res = await serveFully(withHeaders('sonata-code-complex', {}), {
      ...base,
      resolveTier: () => ({ role: 'code', tier: 'complex', routes: [
        { key: 'opus', native: SESSION },
        { key: 'flash', native: { gateway: 'g', id: 'flash-1', transport: 'litellm' as const } },
      ] }),
      fetch: (async (u: RequestInfo | URL) => {
        urls.push(String(u));
        return String(u).startsWith('https://api.anthropic.com')
          ? new Response('{"type":"error","error":{"type":"authentication_error","message":"x"}}', { status: 401 })
          : new Response(COMPLETE_BODY, { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    expect(res.status).toBe(200);
    expect(urls).toEqual(['https://api.anthropic.com/v1/messages', 'http://lite/v1/messages']);
  });

  it('splits claude-key@low only when the key is configured', async () => {
    const seen: string[] = [];
    await routeRequest(withHeaders('claude-sonnet-4.5@low', {}), {
      ...base, fetch: fakeFetch([]),
      resolveNative: (key) => { seen.push(key); return key === 'claude-sonnet-4.5' ? { gateway: 'g', id: 'claude-sonnet-4.5', transport: 'litellm' as const } : undefined; },
    });
    expect(seen).toContain('claude-sonnet-4.5');
    const rec: FetchCall[] = [];
    await routeRequest(withHeaders('claude-opus-4-1@low', {}), { ...base, fetch: fakeFetch(rec), resolveNative: () => undefined });
    expect(rec[0].url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('classifies the session credential without exposing it', () => {
    expect(sessionCredential({ authorization: 'Bearer sk-ant-oat01-abc' })).toBe('subscription');
    expect(sessionCredential({ Authorization: 'Bearer sk-ant-oat01-abc' })).toBe('subscription');
    expect(sessionCredential({ 'x-api-key': 'sk-ant-api03-abc' })).toBe('key');
    expect(sessionCredential({ authorization: 'Bearer some-gateway-token' })).toBe('key');
    expect(sessionCredential({})).toBeUndefined();
  });
```

  Add `sessionCredential` to the router import line.

  In `tests/native/router-usage.test.ts`, following that file's pattern for capturing `recordUsage` rows, add a test. A session candidate served with `authorization: Bearer sk-ant-oat01-SECRET` must record a row with `credential: 'subscription'`, `gateway: 'claude'` and `upstream: 'direct'`. `JSON.stringify(row)` must not contain `SECRET`. The same request with `x-api-key: SECRET2` records `credential: 'key'`. A non-session candidate's row has no `credential` key (`expect('credential' in row).toBe(false)`).

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `npx vitest run tests/native/router.test.ts tests/native/router-usage.test.ts`
  Expected: FAIL. `sessionCredential` is not exported, the configured `claude-` key reaches `api.anthropic.com`, the session candidate's authorization is replaced, and `@low` is not split.

- [ ] **Step 3: Implement.**
  - **`sessionCredential`**, next to `isClaudeRequest`:

```ts
/**
 * Which kind of credential a `session` request carries — recorded on its
 * ledger row so the price can say whether a subscription or a key paid. The
 * credential itself is never returned, logged or stored.
 */
export function sessionCredential(headers: Record<string, string>): 'subscription' | 'key' | undefined {
  let bearer: string | undefined;
  let apiKey = false;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'authorization') bearer = value;
    else if (lower === 'x-api-key' && value !== '') apiKey = true;
  }
  if (bearer !== undefined && /^Bearer sk-ant-oat/i.test(bearer)) return 'subscription';
  if (apiKey || (bearer !== undefined && bearer.trim() !== '')) return 'key';
  return undefined;
}
```

  - **The `@` split in `routeRequest`.** Replace `!isClaudeRequest(req.body)` with "split unless it is an unconfigured `claude-` name":

```ts
  if (requested !== undefined && requested.includes('@') && !requested.startsWith('sonata-')) {
    let split: { key: string; effort: Effort } | undefined;
    try {
      split = splitCandidate(requested);
    } catch (error) {
      // An unconfigured claude- name is the main session's own; Anthropic answers it.
      if (!isClaudeRequest(req.body)) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log?.(`router: refused model=${requested} — ${message}`);
        return { status: 400, headers: { 'content-type': 'application/json' }, body: anthropicErrorBody('invalid_request_error', message) };
      }
    }
    if (split !== undefined && (!isClaudeRequest(req.body) || deps.resolveNative?.(split.key, tenant) !== undefined)) {
      ({ key: alias, effort: bareEffort } = split);
    }
  }
```

    `tenant` must be resolved before this block. If it is resolved later in the function today, move the split to just after tenant resolution, and keep the order of every other check unchanged.
  - **The `anthropic` decision** (~2458). A configured key is never "Anthropic's own":

```ts
  const configured = alias !== undefined ? deps.resolveNative?.(alias, tenant) : undefined;
  const anthropic = configured === undefined && isClaudeRequest(req.body);
```

    The following `const native = …` becomes `const native = configured;`.
  - **`forwardDirect`** takes `gw: { baseUrl: string; key: string; authHeader?: string; session?: boolean }`. When `session` is true, skip the header deletion and the key insertion entirely: the caller's `authorization`/`x-api-key` go through unchanged. Add to the doc comment: *"A session gateway is the exception: its credential IS the caller's, and parseConfig pins its base URL to api.anthropic.com, so forwarding it is not a leak."*
  - **Both call sites** pass `session: route.native!.auth === 'session'` (tier loop) and `session: native.auth === 'session'` (bare key). For a session gateway, `key` is `''`.
  - **`RecordContext`** gains `credential?: 'subscription' | 'key'`. In the tier loop's two `withUsageRecording` calls, and in the bare-key direct call, add `...(native.auth === 'session' ? sessionCredentialField(req.headers) : {})`, where `sessionCredentialField = (h) => { const c = sessionCredential(h); return c === undefined ? {} : { credential: c }; }`. `withUsageRecording` copies `ctx.credential` onto the row when present, following how it copies `effort`.
  - **`LedgerRow`** (`src/ledger.ts`) gains:

```ts
  /**
   * Which credential paid a request served by a `session` gateway: the
   * person's Claude subscription, or a key billed per token. Absent on every
   * other row. Never the credential itself.
   */
  credential?: 'subscription' | 'key';
```

- [ ] **Step 4: Run the tests and confirm they pass, plus the whole router suite.**
  Run: `npx vitest run tests/native && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/native/router.ts src/ledger.ts tests/native/router.test.ts tests/native/router-usage.test.ts
git commit -m "feat(router): configured keys before the claude- pass-through; session gateways forward the caller credential"
```

---

### Task 3: Pricing — session gateways price at Anthropic list, subscription is `covered`; `usage` shows it

**Files:**
- Modify: `src/pricing.ts`: `relabelCovered` (~88), `MODELSDEV_PROVIDER_FOR_AUTH` (~171), `ResolvePriceOptions` (~280), `resolvePrice`.
- Modify: `src/commands/serve.ts:1399-1406` (`priceRow` passes the row's credential).
- Modify: `src/commands/usage.ts:84-89` (`spentLabel`).
- Test: `tests/pricing.test.ts`, `tests/budget.test.ts`, `tests/commands/usage.test.ts`.

**Interfaces:**
- Consumes: `LedgerRow.credential` (Task 2).
- Produces:
  - `ResolvePriceOptions.credential?: 'subscription' | 'key'`
  - `spentLabel(bucket, money)` now returns `` `${money(coveredUsd)} sub` `` for an all-covered bucket.

- [ ] **Step 1: Write the failing tests.** In `tests/pricing.test.ts`, following the file's existing `resolvePrice` tests and models.dev fixture style, add:
  - A config with a `session` gateway `claude` (no `pricing_provider`) and model `opus` → `claude-opus-4-1`, with a models.dev cache holding `anthropic: { 'claude-opus-4-1': { input: 15, output: 75 } }` (per-million rates, in the file's fixture shape):
    - `resolvePrice(cfg, 'opus', tokens, at, cache, { credential: 'subscription' })` has `source: 'covered'` and a `totalUsd` equal to the list cost;
    - with `{ credential: 'key' }`, or no credential, `source` is not `covered` (the file's priced source, e.g. `'modelsdev'`) with the same `totalUsd`.
  - `proposePricingProvider('claude', 'session')` equals `['anthropic']`.

  In `tests/budget.test.ts`, following its row-writing helper, add: a covered row (`price: { source: 'covered', totalUsd: 5 }`) plus a priced row of `$1` gives `spentTodayUsd` `1`. A pre-change session row with no `credential` and `source` priced counts.

  In `tests/commands/usage.test.ts`, add `spentLabel` cases (with `money = (u) => '$' + u.toFixed(2)`):
  - all-covered bucket `{ costUsd: 0, coveredUsd: 0.42, coveredRequests: 2, unpricedRequests: 0, requests: 2 }` → `'$0.42 sub'`;
  - mixed `{ costUsd: 1.1, coveredUsd: 0.42, coveredRequests: 1, requests: 2, unpricedRequests: 0 }` → `'$1.10'`. The covered column carries the rest, as today;
  - all-unpriced → `'—'`, unchanged.

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `npx vitest run tests/pricing.test.ts tests/budget.test.ts tests/commands/usage.test.ts`
  Expected: FAIL. The session gateway is unpriced (no provider for `session`), and `spentLabel` returns `'—'`.

- [ ] **Step 3: Implement.**

```ts
const MODELSDEV_PROVIDER_FOR_AUTH: Record<string, string> = {
  'codex-oauth': 'openai',
  'copilot-oauth': 'github-copilot',
  session: 'anthropic',
};

/**
 * Subscription work is valued at list rates but never billed per token. An
 * OAuth gateway is always a subscription; a session gateway is one exactly
 * when the request carried the person's Claude subscription credential.
 */
function relabelCovered(auth: NativeGatewayAuth | undefined, price: LedgerPrice, credential?: 'subscription' | 'key'): LedgerPrice {
  if (price.source === 'none' || auth === undefined) return price;
  const isSubscription = isOauthGatewayAuth(auth) || (auth === 'session' && credential === 'subscription');
  return isSubscription ? { ...price, source: 'covered' } : price;
}
```

  `ResolvePriceOptions` gains `credential?: 'subscription' | 'key'` with a one-line doc comment. `resolvePrice`'s `covered` helper passes `options?.credential`. In `priceRow` (`src/commands/serve.ts`): `resolvePrice(config, row.key, row.tokens, new Date(row.ts), loadModelsDev(home), row.credential === undefined ? undefined : { credential: row.credential })`.

  `spentLabel`:

```ts
export function spentLabel(bucket: UsageBucket, money: (usd: number) => string): string {
  if (bucket.costUsd === 0 && bucket.coveredUsd === 0 && bucket.unpricedRequests === bucket.requests) return '—';
  // All subscription work: its true cost is its list value, marked as covered.
  if (bucket.costUsd === 0 && bucket.coveredRequests > 0) return `${money(bucket.coveredUsd)} sub`;
  return money(bucket.costUsd);
}
```

  Update `spentLabel`'s doc comment to match. `cli.ts` and `usage.tsx` pad the cell; check that their column widths fit `$0.0000 sub` and widen the spent column by 4 where it doesn't.

- [ ] **Step 4: Run the tests and confirm they pass.**
  Run: `npx vitest run tests/pricing.test.ts tests/budget.test.ts tests/commands/usage.test.ts tests/tui-ink/usage-view.test.ts tests/commands/serve.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/pricing.ts src/commands/serve.ts src/commands/usage.ts src/cli.ts src/tui-ink/screens/usage.tsx tests/pricing.test.ts tests/budget.test.ts tests/commands/usage.test.ts
git commit -m "feat(pricing): session gateways at Anthropic list price; subscription work shown as \$x sub"
```

---

### Task 4: `sonata status` — cost per route and split totals

**Files:**
- Modify: `src/commands/status.ts:80-115` (`RouteLine`, `recentRoutes`, two new helpers).
- Modify: `src/cli.ts:755-770` (plain `status` print).
- Modify: `src/tui-ink/screens/status.tsx:196-225` (route rows) and its footer area.
- Test: `tests/commands/status.test.ts`, `tests/cli-status.test.ts`.

**Interfaces:**
- Consumes: ledger rows with `price.source === 'covered'`.
- Produces (all in `src/commands/status.ts`):
  - `RouteLine.isCovered?: true`, present only when the row's price source is `covered`. This is also what `/__sonata/api/session/<id>` returns, via `ui-detail.ts`.
  - `export function routeCostLabel(line: RouteLine, money?: (usd: number) => string): string` returns `'—'`, `'$0.0123'` or `'$0.0123 sub'`.
  - `export function routeTotals(lines: RouteLine[], money?: (usd: number) => string): string | undefined` returns `'$1.10 billed · $0.42 sub'`, `'$1.10 billed'` or `'$0.42 sub'`. It returns `undefined` when nothing was priced.
  - Default `money`: `(usd) => '$' + usd.toFixed(4)`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/commands/status.test.ts`, following its ledger-row fixture:

```ts
describe('route cost', () => {
  const line = (over: Partial<RouteLine>): RouteLine => ({ alias: 'a', attempts: [], served: 'k', status: 200, input: 1, output: 1, ts: '2026-10-12T00:00:00Z', ...over });

  it('marks covered rows and carries the flag through recentRoutes', () => {
    const rows = [
      { ...row(), price: { source: 'covered', totalUsd: 0.42 } },
      { ...row(), price: { source: 'modelsdev', totalUsd: 1.1 } },
    ] as LedgerRow[];
    const lines = recentRoutes(rows, 10);
    expect(lines.filter((l) => l.isCovered === true)).toHaveLength(1);
    expect(lines.some((l) => 'isCovered' in l && l.isCovered !== true)).toBe(false);
  });

  it('labels each route and totals billed apart from subscription', () => {
    expect(routeCostLabel(line({ priceUsd: 0.0123 }))).toBe('$0.0123');
    expect(routeCostLabel(line({ priceUsd: 0.42, isCovered: true }))).toBe('$0.4200 sub');
    expect(routeCostLabel(line({}))).toBe('—');
    expect(routeTotals([line({ priceUsd: 1.1 }), line({ priceUsd: 0.42, isCovered: true }), line({})])).toBe('$1.1000 billed · $0.4200 sub');
    expect(routeTotals([line({ priceUsd: 0.42, isCovered: true })])).toBe('$0.4200 sub');
    expect(routeTotals([line({})])).toBeUndefined();
  });
});
```

  Use whatever row factory the file already has, named `row()` above. Import `routeCostLabel`, `routeTotals`, `recentRoutes` and `type RouteLine`. Replace `'modelsdev'` with the file's actual priced source string if it differs; grep `source:` in `src/ledger.ts` for the union.

  In `tests/cli-status.test.ts`, following its pattern, assert that a ledger with one covered and one priced route prints `$… sub` on the covered line and a `billed · … sub` totals line.

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `npx vitest run tests/commands/status.test.ts tests/cli-status.test.ts`
  Expected: FAIL, because `routeCostLabel` is not exported.

- [ ] **Step 3: Implement.** In `recentRoutes`, add `...(row.price?.source === 'covered' ? { isCovered: true as const } : {})`. On `RouteLine`, add `/** The price is a subscription's list value, not money billed per token. */ isCovered?: true;`. Then:

```ts
const usd4 = (usd: number): string => `$${usd.toFixed(4)}`;

/** One route's cost: list price, marked `sub` when a subscription covered it; `—` when unpriced, never $0. */
export function routeCostLabel(line: RouteLine, money: (usd: number) => string = usd4): string {
  if (line.priceUsd === undefined) return '—';
  return line.isCovered === true ? `${money(line.priceUsd)} sub` : money(line.priceUsd);
}

/** Billed money and subscription value, apart; undefined when nothing shown was priced. */
export function routeTotals(lines: RouteLine[], money: (usd: number) => string = usd4): string | undefined {
  let billed = 0;
  let covered = 0;
  let anyBilled = false;
  let anyCovered = false;
  for (const l of lines) {
    if (l.priceUsd === undefined) continue;
    if (l.isCovered === true) { covered += l.priceUsd; anyCovered = true; } else { billed += l.priceUsd; anyBilled = true; }
  }
  const parts = [...(anyBilled ? [`${money(billed)} billed`] : []), ...(anyCovered ? [`${money(covered)} sub`] : [])];
  return parts.length === 0 ? undefined : parts.join(' · ');
}
```

  **`cli.ts`:** append `  ${routeCostLabel(line)}` to each route's line after the token counts. After the loop, print `` `cost: ${t}` `` where `t = routeTotals(recent)`, when defined.

  **`status.tsx`:** add a muted cell after `in / out` with `routeCostLabel(line)`. Under the route list, add one muted `cost: …` line from `routeTotals(visible)` when it is defined. Count that line in `routesThatFit`'s reserved rows (the comment at line ~111 lists them).

- [ ] **Step 4: Run the tests and confirm they pass.**
  Run: `npx vitest run tests/commands/status.test.ts tests/cli-status.test.ts tests/status-scope.test.ts tests/tui-ink/status-poll.test.ts tests/native/ui-detail.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/commands/status.ts src/cli.ts src/tui-ink/screens/status.tsx tests/commands/status.test.ts tests/cli-status.test.ts
git commit -m "feat(status): cost per route, subscription marked sub, billed and sub totals"
```

---

### Task 5: Loop panel — `sub` on agent rows, task rows and the header

**Files:**
- Modify: `skills/loop/types/index.d.ts` (`RouteLine.isCovered`).
- Modify: `skills/loop/hooks/register.tsx:61-68` (route-shape filter).
- Modify: `skills/loop/hooks/model.ts:166-207` (`attribute`, `taskCost`).
- Modify: `skills/loop/hooks/panel.tsx` (cost cells, header facts, detail line).
- Test: `skills/loop/hooks/attribution.test.ts`, `skills/loop/hooks/board.test.ts`, `skills/loop/hooks/panel.test.ts`.

**Interfaces:**
- Consumes: `isCovered?: true` on each route from `/__sonata/api/session/<id>` (Task 4).
- Produces:
  - `Attribution` gains `isCovered: boolean` (true when any of the agent's routes was covered).
  - `taskCost` returns `{ usd: number; coveredUsd: number; isPartial: boolean }`. `usd` stays the **total** list value, and `coveredUsd` is the covered part of it.

- [ ] **Step 1: Write the failing tests.**
  - **`attribution.test.ts`**, following its route fixture: one agent with routes `[{ priceUsd: 0.3 }, { priceUsd: 0.12, isCovered: true }]` gives `attribute(...)` `{ usd: 0.42, isCovered: true }`, and `taskCost` gives `{ usd: 0.42, coveredUsd: 0.12, isPartial: false }`. With no covered route, `isCovered` is false and `coveredUsd` is `0`.
  - **`board.test.ts`**, with its pure text renderer:
    - an agent whose routes are all covered renders its cost cell as `$0.42 sub`;
    - a task whose agents mix billed `$1.10` and covered `$0.42` renders `$1.52 sub` in its cost cell, since any covered part marks it;
    - the header facts read `$1.10 + $0.42 sub`;
    - with only covered work, the header reads `$0.42 sub`;
    - the `sub` text renders in the `inactive` colour: assert through the renderer's colour annotation, as the router-down colour test does.
  - **`panel.test.ts`:** a fetched route with `isCovered: true` survives `fetchOnce`'s shape filter, and one with `isCovered: 'yes'` is dropped.

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `claude plugin test skills/loop`
  Expected: the new tests fail.

- [ ] **Step 3: Implement.**
  - **`types/index.d.ts`:** on `RouteLine`, add `isCovered?: true`.
  - **`register.tsx` filter:** add `&& (r.isCovered === undefined || r.isCovered === true)` to the shape check.
  - **`model.ts`:**
    - `Attribution` gains `isCovered: boolean`, computed as `mine.some(r => r.isCovered === true)`, and every return carries it (`false` on the early returns).
    - `taskCost` accumulates `coveredUsd` from each agent's covered share. Add `coveredUsdOf(agent routes)` alongside `attribute`, i.e. the sum of `priceUsd` over `mine` where `isCovered`, but only when the agent's `usd` is defined, so an ambiguous agent contributes nothing.
  - **`panel.tsx`:** wherever an agent or task cost string is built (search for the `$` formatting helper), append a separate `Text` reading ` sub` in `inactive` when `isCovered`, or `coveredUsd > 0` for a task. The header facts become:
    - billed only: `$X`;
    - both: `$B + $C sub`, where `B = total - covered` and `C = covered`;
    - covered only: `$C sub`.

    The selected row's detail section gains one line when both kinds are present: `cost   $B billed · $C sub`. Widen the cost column by 4 at ≥76 cols. Below that, drop the ` sub` text from rows (the header keeps it); add this to the narrow-layout test.
  - Keep `≈` and unknown-cost rendering exactly as they are.

- [ ] **Step 4: Run the tests and confirm they pass; validate.**
  Run: `claude plugin test skills/loop && claude plugin validate skills/loop`
  Expected: all pass, and validation passes.

- [ ] **Step 5: Commit.**

```bash
git add skills/loop/types/index.d.ts skills/loop/hooks/register.tsx skills/loop/hooks/model.ts skills/loop/hooks/panel.tsx skills/loop/hooks/attribution.test.ts skills/loop/hooks/board.test.ts skills/loop/hooks/panel.test.ts
git commit -m "feat(loop-panel): subscription cost shown at list price, marked sub"
```

---

### Task 6: `sonata init` — offer Claude ids, and a "Claude (this Claude Code account)" provider

**Files:**
- Modify: `src/init/helpers.ts:63-68` (a provider → `session` mapping) and `~305` (the filter was removed in Task 1; confirm no replacement is needed).
- Modify: `src/init/discover.ts:228-240` (`gatewayAuth` gets `claude` → `session`) and the BYOK offering (~250).
- Modify: `src/detect.ts` (`WELL_KNOWN_PROVIDER_URLS` gains `claude: 'https://api.anthropic.com/v1'`), with a comment that `claude` is the session gateway's name.
- Modify: `src/init/candidates.ts:58-64` (a session candidate keeps `baseUrl` Anthropic, `auth: 'session'`, `wireFormat: 'anthropic'`).
- Modify: `src/tui-ink/components/providers-step.tsx`:
  - `routeToProvider` (~226–247): a `session` auth goes straight to `oauth-models`;
  - the `oauth-models` onSubmit (~590–603): set no `credentialSources` for `session`;
  - its `onBack`: a session provider goes back to `pick`.
- Modify: `src/tui-ink/components/models-step.tsx:70` (the live refresh skips `session`).
- Test: `tests/tui-ink/providers-step.test.ts`, `tests/init/candidates.test.ts`, `tests/init/discover.test.ts`, `tests/init/plan.test.ts` (or `apply.test.ts`, whichever already asserts written TOML for a BYOK provider).

**Interfaces:**
- Consumes: `NativeGatewayAuth` `'session'` and `nativeTomlFor`'s session output (Task 1). `proposePricingProvider('claude','session')` → `['anthropic']` (Task 3). `oauthModelIds(cache, 'claude', 'session')` lists `cache.providers.anthropic`'s ids. It already goes through `proposePricingProvider`, so it works once Task 3's table entry exists.
- Produces: `export const PROVIDER_SESSION_GATEWAY = 'claude'` in `src/init/helpers.ts`.

- [ ] **Step 1: Write the failing tests.**
  - **`providers-step.test.ts`**, following its render-and-press pattern (`ink-testing-library`):
    1. Pick "claude" from Add provider.
    2. No key prompt appears; the next screen is the models list showing the models.dev `anthropic` ids from the fixture cache (e.g. `claude-opus-4-1`).
    3. Select one and submit.
    4. Assert the resulting state has `byokModels.claude` containing it, `providerKeys` containing the claude provider key, and **no** `credentialSources.claude`.

    Add another case: a Copilot candidate list containing `claude-sonnet-4.5` is offered (no longer filtered).
  - **`candidates.test.ts`:** `addByokCandidates` for gateway `claude` with `gatewayAuth` `claude → session` yields a candidate `{ gateway: 'claude', auth: 'session', baseUrl: 'https://api.anthropic.com/v1', wireFormat: 'anthropic' }`.
  - **`discover.test.ts`:** a fresh machine with no config has `gatewayAuth.get('claude') === 'session'`, and `claude` among the offered BYOK providers.
  - **Plan/apply test:** an interactive state choosing the claude provider and `claude-opus-4-1` writes TOML that `parseConfig` loads, with `native.gateways.claude.auth === 'session'` and a model whose `id` is `claude-opus-4-1`.

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `npx vitest run tests/tui-ink/providers-step.test.ts tests/init`
  Expected: FAIL. `claude` routes to key entry, and no session candidate is produced.

- [ ] **Step 3: Implement.**
  - `helpers.ts`: `export const PROVIDER_SESSION_GATEWAY = 'claude';`.
  - `discover.ts`: after the `PROVIDER_OAUTH_AUTHS` loop, `if (!gatewayAuth.has(PROVIDER_SESSION_GATEWAY)) gatewayAuth.set(PROVIDER_SESSION_GATEWAY, 'session');`.
  - `detect.ts`: add `claude` to `WELL_KNOWN_PROVIDER_URLS`. It then appears in `wellKnownProviders()` and the BYOK list. If a test pins the size of that table, update it.
  - `candidates.ts` `addByokCandidates`: when `auth === 'session'`, use `baseUrl: ANTHROPIC_SESSION_BASE_URL` and `wireFormat: 'anthropic'`.
  - `providers-step.tsx` `routeToProvider`, BYOK branch: before computing `route`, add

```tsx
      if (gatewayAuth[provider.provider] === 'session') {
        // The person's own Claude Code account: nothing to store or log in to.
        setScreen({ kind: 'oauth-models', provider: byokOption, ids: oauthModelIds(modelsDevCache, provider.provider, 'session') });
        return;
      }
```

  - `oauth-models` onSubmit: build `credentialSources` only when `gatewayAuth[provider.provider] !== 'session'`. Its `onBack`: `gatewayAuth[provider.provider] === 'session' ? { kind: 'pick' } : { kind: 'login', provider }`.
  - `models-step.tsx:70`: `if (auth !== undefined && (isOauthGatewayAuth(auth) || auth === 'session')) return false;`.
  - Check `src/init/validate.ts` and `src/init/plan.ts` for an `auth === 'api-key'` assumption that would demand a key for `claude`. A gateway with no key and no credential source must not be reported as missing a key when its auth is `session`; add the `session` exclusion wherever the plan/apply test shows it being asked for one.

- [ ] **Step 4: Run the tests and confirm they pass.**
  Run: `npx vitest run tests/tui-ink tests/init tests/init.test.ts && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/init/helpers.ts src/init/discover.ts src/detect.ts src/init/candidates.ts src/init/validate.ts src/init/plan.ts src/tui-ink/components/providers-step.tsx src/tui-ink/components/models-step.tsx tests/tui-ink/providers-step.test.ts tests/init
git commit -m "feat(init): offer gateway-served Claude ids and a Claude Code account provider"
```

---

### Task 7: Harness lane, doctor, docs and changelog

**Files:**
- Modify: `src/adapters/claude.ts:40-55` (effort decision).
- Modify: `src/commands/doctor.ts` (the credential check skips `session` gateways; a session gateway reports `uses the Claude Code session's own credential`).
- Modify: `docs/internals/configuration.md`, `docs/internals/native-path.md` (lines ~85 and ~299), `docs/guide/native-path.md` (~39), `docs/internals/limitations.md`, `CLAUDE.md` (*Rules that bite*), `CHANGELOG.md`.
- Test: `tests/adapters/claude.test.ts`, `tests/commands/doctor.test.ts`.

**Interfaces:**
- Consumes: `loadConfig` (already used in `claude.ts:106`) and `unifiedModels`.

- [ ] **Step 1: Write the failing tests.**
  - **`tests/adapters/claude.test.ts`**, following its `plan(...)` fixtures:
    - with a config defining key `claude-sonnet-4.5`, a plan for model `claude-sonnet-4.5` and effort `low` passes `--model 'claude-sonnet-4.5@low'` and reports `effortHonoured: true`;
    - for an undefined `claude-opus-4-1`, it passes the bare name and reports `effortHonoured: false`, as today.
  - **`tests/commands/doctor.test.ts`:** a config with a `session` gateway produces no "credential missing" failure for it, and its credentials line reads `claude: uses the Claude Code session's own credential`.

- [ ] **Step 2: Run them and confirm they fail.**
  Run: `npx vitest run tests/adapters/claude.test.ts tests/commands/doctor.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement.**
  - **`claude.ts`:** move the `loadConfig` call (currently ~106) above the flags, wrapped in its existing try/catch. Then:

```ts
  // A name the config defines is a sonata key like any other and takes a
  // level; one it does not define is Anthropic's own (the router passes it
  // through untouched), so a level appended there would reach Anthropic as
  // part of the name.
  const anthropicRouted = input.modelId.startsWith('claude-') && config?.unifiedModels[input.modelId] === undefined;
```

    Replace the comment block above it to say this.
  - **`doctor.ts`:** in the gateway credential loop (~1230), before the `credentialSource` handling, add `if (gateway.auth === 'session') { checks.push({ name: 'credentials', ok: true, detail: \`${name}: uses the Claude Code session's own credential\` }); continue; }`. Match the check name the surrounding code uses.
  - **Docs:** delete every statement that `claude-` keys or ids are refused. Add to `docs/guide/native-path.md`, after the gateway section:

```markdown
### Your own Claude Code account

A tier can rank Claude models served by your own Claude Code account:

    [native.gateways."claude"]
    provider = "anthropic"
    auth = "session"

    [models."opus"]
    gateway = "claude"
    id = "claude-opus-4-1"

The router forwards the session's own credential, and only to
`api.anthropic.com` — any other `base_url` is refused. Usage is priced at
Anthropic's list rates; work your Claude subscription paid for is shown as
`$x sub` and never counts toward `[budget]`. A key named exactly like a model
your main session uses (`claude-opus-4-1`) also catches that session's own
turns when it is routed.
```

    Add the same facts, in the maintainer register, to `docs/internals/native-path.md` and `configuration.md`. In `CLAUDE.md`, replace the bullet ``- `claude-` model keys/ids are refused — that prefix routes to Anthropic (`isAnthropicRoutedName`).`` with ``- A `claude-*` name the config does not define passes through to Anthropic; a configured key routes like any other. `auth = "session"` forwards the caller's credential and only to `api.anthropic.com`.``
  - **CHANGELOG**, under `## [Unreleased]`:

```markdown
- **Claude models are ordinary models.** A tier may rank Claude ids that a
  gateway serves (Copilot, OpenRouter, any other) and, through a new
  `auth = "session"` gateway, models on your own Claude Code account — the
  router forwards the session's credential, only ever to `api.anthropic.com`.
  `sonata init` offers both. Every request is priced at its API list rate:
  subscription work (`codex-oauth`, `copilot-oauth`, and a Claude
  subscription session) shows as `$x sub` in `sonata usage`, `sonata status`
  and the loop panel, and still never counts toward `[budget]`.
```

- [ ] **Step 4: Run the full verification.**
  Run: `npm run typecheck && npm test && claude plugin test skills/loop && claude plugin validate skills/loop`
  Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add src/adapters/claude.ts src/commands/doctor.ts tests/adapters/claude.test.ts tests/commands/doctor.test.ts docs/internals/configuration.md docs/internals/native-path.md docs/guide/native-path.md docs/internals/limitations.md CLAUDE.md CHANGELOG.md
git commit -m "feat: Claude models on the harness lane and in doctor; docs and changelog"
```

---

## After the last task

- Run `npm run build && npm link` from the worktree and `sonata restart`.
- **Real check:**
  1. Add a session gateway to a scratch project's `sonata.toml`.
  2. Run `sonata code`, and dispatch a tier agent whose first candidate is `opus`.
  3. Confirm `sonata status` shows the route as `$… sub` (under a subscription login) and the panel's row reads `sub`.
- Once PR #86 merges, rebase onto `main` and open the PR.
