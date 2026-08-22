# Add Provider / Import From Harnesses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `sonata init`'s wizard step-2 provider multi-select and step-3 per-gateway credential screen with a top-level [Import from other harnesses] / [Add provider] menu, where Add provider supports a fully custom (name + base URL + wire format) provider in addition to known/well-known ones.

**Architecture:** A new `ProvidersStep` Ink component owns a small internal screen state machine (menu → import/pick → credential-choice/custom-entry → login/key-entry/byok) and writes directly into the same `InitState` shape (`providerKeys`, `credentialSources`, `byokKeys`, `byokModels`, plus two new fields) that the existing downstream steps (models, roles, per-role models) already consume unchanged. A new optional `wire_format` config field threads a custom provider's chosen wire format from the wizard through to `src/native/litellm.ts`'s new `anthropic/<id>` LiteLLM routing branch.

**Tech Stack:** TypeScript, Ink (React for CLIs), vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-add-provider-flow-design.md`

## Global Constraints

- `wire_format` is valid only on `auth = "api-key"` gateways; refused at parse time on any OAuth-auth gateway (spec Section D).
- Absent `wire_format` means today's only behavior (`openai`) — zero effect on any existing config file (spec Section D).
- OAuth ("Run OAuth login") is offered only for `codex` and `github-copilot` — sonata has no generic OAuth mechanism (spec Non-goals, Section C).
- A custom provider never offers OAuth — only "Enter an API key" (spec Section C).
- Editing/removing an already-configured provider within the same wizard run is out of scope (spec Non-goals).
- Every downstream step (role assignment, per-role model selection, final TOML emission) must keep consuming `credentialSources`/`nativeKeys`/`byokKeys`/`byokModels` exactly as today — no changes past provider+credential configuration (spec Section E).

---

### Task 1: `wire_format` config field

**Files:**
- Modify: `src/config.ts:83-87` (`NativeGatewayConfig`), `src/config.ts:229-249` (gateway parsing loop)
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `NativeGatewayConfig.wireFormat?: 'openai' | 'anthropic'`, consumed by Task 2 (`src/native/litellm.ts`) and Task 3 (`src/commands/init.ts`'s `NativeCandidate`/`nativeTomlFor`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/config.test.ts`, inside a new `describe` block (place it near the existing `describe('native gateway credential_source', ...)` block):

```ts
describe('native gateway wire_format', () => {
  it('parses wire_format = "anthropic" on an api-key gateway', () => {
    const config = parseConfig(`
[native.gateways.custom]
auth = "api-key"
base_url = "https://example.com/v1"
wire_format = "anthropic"
`);
    expect(config.native!.gateways.custom.wireFormat).toBe('anthropic');
  });

  it('defaults to no wireFormat when absent, unchanged from today', () => {
    const config = parseConfig(`
[native.gateways.custom]
auth = "api-key"
base_url = "https://example.com/v1"
`);
    expect(config.native!.gateways.custom.wireFormat).toBeUndefined();
  });

  it('refuses wire_format on an unknown value', () => {
    expect(() => parseConfig(`
[native.gateways.custom]
auth = "api-key"
base_url = "https://example.com/v1"
wire_format = "grpc"
`)).toThrow(/unknown wire_format "grpc".*openai, anthropic/s);
  });

  it('refuses wire_format on a codex-oauth gateway', () => {
    expect(() => parseConfig(`
[native.gateways.codex]
auth = "codex-oauth"
wire_format = "anthropic"
`)).toThrow(/codex-oauth, so it cannot set wire_format/);
  });

  it('refuses wire_format on a copilot-oauth gateway', () => {
    expect(() => parseConfig(`
[native.gateways."github-copilot"]
auth = "copilot-oauth"
wire_format = "anthropic"
`)).toThrow(/copilot-oauth, so it cannot set wire_format/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/config.test.ts -t "wire_format"`
Expected: FAIL — `wireFormat` is `undefined` in every case (property doesn't exist yet) and the two refusal tests fail because nothing throws.

- [ ] **Step 3: Implement**

In `src/config.ts`, add the type and the known-values list right after `NATIVE_GATEWAY_AUTHS` (after line 38):

```ts
export type NativeGatewayWireFormat = 'openai' | 'anthropic';

export const NATIVE_GATEWAY_WIRE_FORMATS: readonly NativeGatewayWireFormat[] = ['openai', 'anthropic'];
```

Add the field to `NativeGatewayConfig` (replace lines 83-87):

```ts
export interface NativeGatewayConfig {
  baseUrl: string;
  auth: NativeGatewayAuth;
  credentialSource?: CredentialSource;
  wireFormat?: NativeGatewayWireFormat;
}
```

In the gateway-parsing loop, add wire_format parsing right after the `credentialSource` block closes (after line 229, before the `isOauthGatewayAuth(auth)` block at line 234):

```ts
      let wireFormat: NativeGatewayWireFormat | undefined;
      if (d.wire_format !== undefined) {
        const rawFormat = d.wire_format;
        if (typeof rawFormat !== 'string' || !NATIVE_GATEWAY_WIRE_FORMATS.includes(rawFormat as NativeGatewayWireFormat)) {
          throw new Error(
            `sonata.toml: native gateway "${name}" has unknown wire_format "${String(rawFormat)}". ` +
            `Known: ${NATIVE_GATEWAY_WIRE_FORMATS.join(', ')}`,
          );
        }
        // Every OAuth gateway's wire format is implied by `auth` (codex-oauth
        // always speaks the chatgpt/responses shape, copilot-oauth always
        // github_copilot) — a value here would only claim a shape LiteLLM's
        // own provider for that auth kind does not use.
        if (isOauthGatewayAuth(auth)) {
          throw new Error(
            `sonata.toml: native gateway "${name}" is ${auth}, so it cannot set wire_format — ` +
            'that credential\'s wire format is fixed by its auth kind. Remove wire_format.',
          );
        }
        wireFormat = rawFormat as NativeGatewayWireFormat;
      }
```

Then thread `wireFormat` into both places `gateways[name] = {...}` is assigned. The OAuth branch (line 243, inside the `if (isOauthGatewayAuth(auth))` block) never reaches the code above since it throws first when `wire_format` is set — so that branch's assignment (`gateways[name] = { baseUrl: implied, auth, credentialSource };`) is unchanged. The non-OAuth branch (line 249) becomes:

```ts
      gateways[name] = { baseUrl: d.base_url, auth, credentialSource, wireFormat };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS, full file green (no regressions in the other `describe` blocks).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add optional wire_format for api-key native gateways"
```

---

### Task 2: `litellmConfig` anthropic wire-format branch

**Files:**
- Modify: `src/native/litellm.ts:27-58`
- Test: `tests/native/litellm.test.ts`

**Interfaces:**
- Consumes: `NativeGatewayConfig.wireFormat` from Task 1.
- Produces: no new exports; `litellmConfig`'s emitted shape for `wireFormat === 'anthropic'` gateways, consumed only by `sonata serve`'s LiteLLM config file (unchanged interface, new branch).

- [ ] **Step 1: Write the failing test**

Add to `tests/native/litellm.test.ts`, as a new top-level `describe` block:

```ts
describe('LiteLLM config — anthropic wire format', () => {
  const native: NativeConfig = {
    models: { 'custom-claude-clone': { gateway: 'custom', id: 'claude-clone', contextWindow: 128000 } },
    gateways: { custom: { baseUrl: 'https://example.com/v1', auth: 'api-key', wireFormat: 'anthropic' } },
    ports: { router: 4100, litellm: 4000 },
    generate: {},
  };

  it('routes through the anthropic custom_llm_provider instead of openai', () => {
    const config = litellmConfig(native, 'k');
    expect(config.model_list[0]!.litellm_params.model).toBe('anthropic/claude-clone');
  });

  it('still passes api_base and api_key, unlike the OAuth branches', () => {
    const config = litellmConfig(native, 'k');
    expect(config.model_list[0]!.litellm_params.api_base).toBe('https://example.com/v1');
    expect(config.model_list[0]!.litellm_params.api_key).toBe('os.environ/SONATA_KEY_CUSTOM');
  });

  it('sets no mode override — only codex-oauth needs one', () => {
    const config = litellmConfig(native, 'k');
    expect(config.model_list[0]!.model_info).toBeUndefined();
  });

  it('leaves an absent wire_format on the openai/<id> path, unchanged', () => {
    const openaiNative: NativeConfig = {
      ...native,
      gateways: { custom: { baseUrl: 'https://example.com/v1', auth: 'api-key' } },
    };
    const config = litellmConfig(openaiNative, 'k');
    expect(config.model_list[0]!.litellm_params.model).toBe('openai/claude-clone');
  });
});
```

Add `NativeConfig` to the existing import line at the top of `tests/native/litellm.test.ts` if it is not already imported (check the file's current imports first — it likely already imports `litellmConfig` and may need `NativeConfig` added from `'../../src/config.js'`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/native/litellm.test.ts -t "anthropic wire format"`
Expected: FAIL — the model routes through `openai/claude-clone` (today's only branch) instead of `anthropic/claude-clone`.

- [ ] **Step 3: Implement**

In `src/native/litellm.ts`, replace the final `return` in the `modelList` mapper (lines 50-57) with a wire-format branch:

```ts
    if (native.gateways[model.gateway].wireFormat === 'anthropic') {
      return {
        model_name: modelName,
        litellm_params: {
          model: `anthropic/${model.id}`,
          api_base: native.gateways[model.gateway].baseUrl,
          api_key: `os.environ/${envVarForGateway(model.gateway)}`,
        },
      };
    }
    return {
      model_name: modelName,
      litellm_params: {
        model: `openai/${model.id}`,
        api_base: native.gateways[model.gateway].baseUrl,
        api_key: `os.environ/${envVarForGateway(model.gateway)}`,
      },
    };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/native/litellm.test.ts`
Expected: PASS, full file green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/native/litellm.ts tests/native/litellm.test.ts
git commit -m "feat(native): route anthropic-wire-format gateways through LiteLLM's anthropic provider"
```

---

### Task 3: Custom-provider state fields and TOML wiring

**Files:**
- Modify: `src/tui-ink/types.ts` (`InitState`)
- Modify: `src/commands/init.ts:190-197` (`NativeCandidate`), `src/commands/init.ts:395-425` (`nativeTomlFor`), `src/commands/init.ts:628-649` (`addByokCandidates`, `byokUrls`), `src/commands/init.ts:709-725` (interactive-path wiring)
- Test: `tests/init.test.ts`

**Interfaces:**
- Consumes: `NativeGatewayConfig.wireFormat` type from Task 1 (imported as `NativeGatewayWireFormat`).
- Produces:
  - `InitState.customProviders?: { name: string; url: string }[]` — consumed by Task 7 (`ProvidersStep`, to know which custom providers already exist across screen transitions) and Task 4's `addProviderCatalog`/name-collision helpers.
  - `InitState.customWireFormats?: Record<string, 'anthropic'>` — consumed by Task 7.
  - `NativeCandidate.wireFormat?: NativeGatewayWireFormat` — consumed by `nativeTomlFor`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/init.test.ts`, near the existing `nativeTomlFor` tests (search for `describe('nativeTomlFor'` or similar — if no such block exists, add a new one):

```ts
describe('nativeTomlFor — wire_format', () => {
  it('emits wire_format for an anthropic-wire-format candidate', () => {
    const toml = nativeTomlFor({
      code: [{
        key: 'custom-claude-clone', gateway: 'custom', id: 'claude-clone',
        contextWindow: 128000, baseUrl: 'https://example.com/v1', auth: 'api-key',
        wireFormat: 'anthropic',
      }],
    });
    expect(toml).toMatch(/\[native\.gateways\.custom\][\s\S]*wire_format = "anthropic"/);
  });

  it('omits wire_format for an openai (default) candidate', () => {
    const toml = nativeTomlFor({
      code: [{
        key: 'custom-gpt', gateway: 'custom', id: 'gpt',
        contextWindow: 128000, baseUrl: 'https://example.com/v1', auth: 'api-key',
      }],
    });
    expect(toml).not.toContain('wire_format');
  });
});
```

Add end-to-end coverage in the existing interactive-wizard test area (search for where `tuiMocks.result` is set with a `state` containing `nativeKeys`/`byokModels`, e.g. near line 1178-1220 per the file's current structure):

```ts
describe('cmdInit — custom provider wire format', () => {
  it('writes wire_format for a custom provider added through the wizard', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'init-custom-provider-cwd-'));
    const home = mkdtempSync(join(tmpdir(), 'init-custom-provider-home-'));
    const detect = makeDetect();
    tuiMocks.interactive = true;
    tuiMocks.result = {
      cancelled: false,
      state: {
        configScope: 'project',
        harnesses: [],
        providerKeys: ['byok/my-proxy'],
        nativeKeys: ['my-proxy-claude-clone'],
        roles: ['code'],
        perRoleModels: { code: ['my-proxy-claude-clone'] },
        byokKeys: { 'my-proxy': 'sk-test' },
        byokModels: { 'my-proxy': ['claude-clone'] },
        customProviders: [{ name: 'my-proxy', url: 'https://my-proxy.example.com/v1' }],
        customWireFormats: { 'my-proxy': 'anthropic' },
      },
    };
    await cmdInit({ cwd, home, packageRoot: '/pkg', yes: false, detect, scope: 'skip', write: () => {} });
    const written = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    expect(written).toMatch(/\[native\.gateways\.my-proxy\][\s\S]*base_url = "https:\/\/my-proxy\.example\.com\/v1"[\s\S]*wire_format = "anthropic"/);
    expect(written).toContain('id = "claude-clone"');
  });
});
```

`mkdtempSync`, `tmpdir`, `join`, `readFileSync` are already imported at the top of `tests/init.test.ts`, and `makeDetect()` (defined at `tests/init.test.ts:121`) is a shared module-level factory already used by several other describe blocks in this file — reuse it rather than hand-writing a new detect fixture. This test's `tuiMocks.result` fully determines the written config, so `makeDetect()`'s defaults are sufficient; nothing here depends on which harness or models it reports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/init.test.ts -t "wire_format" -t "wire format"`
Expected: FAIL — `nativeTomlFor` doesn't accept/emit `wireFormat`, and the custom provider's models are silently dropped (the `my-proxy` gateway is never written) because `byokUrls` has no entry for it.

- [ ] **Step 3: Implement**

In `src/tui-ink/types.ts`, add two fields to `InitState` (after `byokModels`):

```ts
  /** Providers typed in directly through the wizard's "Add a custom provider" flow. */
  customProviders?: Array<{ name: string; url: string }>;
  /** Custom-provider name -> wire format, only recorded for the non-default choice. */
  customWireFormats?: Record<string, 'anthropic'>;
```

In `src/commands/init.ts`, add `wireFormat` to `NativeCandidate` (line 190-197):

```ts
export interface NativeCandidate {
  key: string;
  gateway: string;
  id: string;
  contextWindow: number;
  baseUrl: string;
  auth: NativeGatewayAuth;
  wireFormat?: NativeGatewayWireFormat;
}
```

Add `NativeGatewayWireFormat` to the existing `import type { ... } from '../config.js'` line at the top of the file.

In `nativeTomlFor` (lines 411-425), thread `wireFormat` through the gateway map and TOML lines:

```ts
  const gateways = new Map<string, { baseUrl: string; auth: NativeGatewayAuth; wireFormat?: NativeGatewayWireFormat }>();
  for (const c of allModels.values()) gateways.set(c.gateway, { baseUrl: c.baseUrl, auth: c.auth, wireFormat: c.wireFormat });

  const lines: string[] = [];

  for (const [gateway, { baseUrl, auth, wireFormat }] of gateways) {
    lines.push(`[native.gateways.${tomlKey(gateway)}]`);
    // An OAuth gateway takes no base_url: the credential reaches only its own
    // provider's backend, and LiteLLM already knows that URL.
    if (isOauthGatewayAuth(auth)) lines.push(`auth = ${tomlKey(auth)}`);
    else lines.push(`base_url = ${tomlKey(baseUrl)}`);
    const source = credentialSources[gateway];
    if (source !== undefined) lines.push(`credential_source = ${tomlKey(source)}`);
    if (wireFormat === 'anthropic') lines.push(`wire_format = ${tomlKey(wireFormat)}`);
    lines.push('');
  }
```

In `addByokCandidates` (around line 640-649), accept a wire-format lookup and record it on each candidate:

```ts
  const addByokCandidates = (byokModels: Record<string, string[]>, wireFormats: Record<string, 'anthropic'> = {}): void => {
    for (const [gateway, ids] of Object.entries(byokModels)) {
      const baseUrl = byokUrls.get(gateway);
      if (baseUrl === undefined) continue;
      const wireFormat = wireFormats[gateway];
      for (const id of ids) {
        const key = byokCandidateKey(gateway, id);
        nativeByKey.set(key, {
          key, gateway, id, contextWindow: 128000, baseUrl, auth: 'api-key',
          ...(wireFormat !== undefined ? { wireFormat } : {}),
        });
      }
    }
  };
```

In the interactive-path wiring (around line 709-725), before the existing `addByokCandidates(result.state.byokModels ?? {});` call, register any custom providers' base URLs so they resolve like any other BYOK provider, then pass the wire-format map through:

```ts
    configScope = result.state.configScope ?? 'project';
    configPathResolved = configPathFor(configScope, opts.cwd, opts.home);
    for (const provider of result.state.customProviders ?? []) {
      byokUrls.set(provider.name, provider.url);
    }
    addByokCandidates(result.state.byokModels ?? {}, result.state.customWireFormats);
```

(This replaces the existing two-line `configScope = ...; configPathResolved = ...; addByokCandidates(result.state.byokModels ?? {});` sequence — keep everything else in that block, e.g. the `byokKeys = result.state.byokKeys ?? {};` line right after, unchanged.)

The non-interactive (`else`) branch's `addByokCandidates(byokModels);` call (around line 792) is unchanged — custom providers are an interactive-wizard-only concept per the spec's non-goals.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/init.test.ts`
Expected: PASS, full file green (this file is large — confirm no regressions elsewhere in it).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tui-ink/types.ts src/commands/init.ts tests/init.test.ts
git commit -m "feat(init): thread custom-provider wire format from wizard state to TOML"
```

---

### Task 4: Provider-catalog and validation helpers

**Files:**
- Modify: `src/tui-ink/app-state.ts` (add new exports; remove `credentialRowsFor`/`CredentialRow`)
- Test: `tests/tui-ink/app-state.test.ts`

**Interfaces:**
- Consumes: `ProviderOption`, `AvailableCredentials` (already defined in this file); `byokProviderName` (already defined in this file).
- Produces (consumed by Task 7's `ProvidersStep`):
  - `importableProviders(providers: ProviderOption[], availability: Record<string, AvailableCredentials>): ProviderOption[]`
  - `addProviderCatalog(providers: ProviderOption[], configuredGateways: readonly string[]): ProviderOption[]`
  - `configuredProviderNames(providerKeys: readonly string[], providers: ProviderOption[]): string[]`
  - `validateCustomProviderName(name: string, existingNames: readonly string[]): string | undefined`
  - `validateProviderUrl(url: string): string | undefined`

- [ ] **Step 1: Write the failing tests**

Replace the existing `describe('credential source step', ...)` block in `tests/tui-ink/app-state.test.ts` (lines 150-186) — it tests `credentialRowsFor`/`CredentialRow`, which this task removes — with:

```ts
describe('importableProviders', () => {
  const providers: ProviderOption[] = [
    { key: 'opencode-openai', harness: 'opencode', provider: 'openai', count: 2 },
    { key: 'codex-codex', harness: 'codex', provider: 'codex', count: 1 },
    { key: 'byok/groq', harness: 'byok', provider: 'groq', count: 0 },
  ];

  it('keeps only providers with a detected codex or opencode credential', () => {
    const availability = {
      openai: { codex: { expiresInDays: 5 }, opencode: null, key: null, keyEntryAvailable: true },
      codex: { codex: null, opencode: null, key: null, keyEntryAvailable: true },
      groq: { codex: null, opencode: { expiresInDays: 3 }, key: null, keyEntryAvailable: true },
    };
    expect(importableProviders(providers, availability).map((p) => p.provider)).toEqual(['openai', 'groq']);
  });

  it('is empty when nothing has a detected credential', () => {
    const availability = {
      openai: { codex: null, opencode: null, key: null, keyEntryAvailable: true },
    };
    expect(importableProviders(providers, availability)).toEqual([]);
  });

  it('dedupes by provider name across multiple harness entries', () => {
    const dup: ProviderOption[] = [
      { key: 'opencode-openai', harness: 'opencode', provider: 'openai', count: 2 },
      { key: 'pi-openai', harness: 'pi', provider: 'openai', count: 1 },
    ];
    const availability = { openai: { codex: { expiresInDays: 5 }, opencode: null, key: null, keyEntryAvailable: true } };
    expect(importableProviders(dup, availability).map((p) => p.key)).toEqual(['opencode-openai']);
  });
});

describe('addProviderCatalog', () => {
  const providers: ProviderOption[] = [
    { key: 'opencode-openai', harness: 'opencode', provider: 'openai', count: 2 },
    { key: 'codex-codex', harness: 'codex', provider: 'codex', count: 1 },
    { key: 'byok/groq', harness: 'byok', provider: 'groq', count: 0 },
  ];

  it('excludes already-configured gateways', () => {
    expect(addProviderCatalog(providers, ['openai']).map((p) => p.provider)).toEqual(['codex', 'groq']);
  });

  it('dedupes by provider name and sorts alphabetically', () => {
    const dup: ProviderOption[] = [...providers, { key: 'pi-openai', harness: 'pi', provider: 'openai', count: 3 }];
    expect(addProviderCatalog(dup, []).map((p) => p.provider)).toEqual(['codex', 'groq', 'openai']);
  });
});

describe('configuredProviderNames', () => {
  const providers: ProviderOption[] = [
    { key: 'opencode-openai', harness: 'opencode', provider: 'openai', count: 2 },
  ];

  it('resolves a catalogued key through the provider list', () => {
    expect(configuredProviderNames(['opencode-openai'], providers)).toEqual(['openai']);
  });

  it('resolves a byok/custom key through byokProviderName', () => {
    expect(configuredProviderNames(['byok/my-proxy'], providers)).toEqual(['my-proxy']);
  });

  it('drops a key matching neither', () => {
    expect(configuredProviderNames(['config/ghost'], providers)).toEqual([]);
  });
});

describe('validateCustomProviderName', () => {
  it('requires a non-empty name', () => {
    expect(validateCustomProviderName('  ', [])).toMatch(/required/);
  });

  it('rejects a name colliding case-insensitively with an existing provider', () => {
    expect(validateCustomProviderName('OpenAI', ['openai'])).toMatch(/already a provider/);
  });

  it('accepts a unique name', () => {
    expect(validateCustomProviderName('my-proxy', ['openai', 'codex'])).toBeUndefined();
  });
});

describe('validateProviderUrl', () => {
  it('requires a non-empty URL', () => {
    expect(validateProviderUrl('')).toMatch(/required/);
  });

  it('rejects a non-URL string', () => {
    expect(validateProviderUrl('not a url')).toMatch(/https:\/\//);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(validateProviderUrl('ftp://example.com')).toMatch(/http:\/\/ or https:\/\//);
  });

  it('accepts a well-formed https URL', () => {
    expect(validateProviderUrl('https://example.com/v1')).toBeUndefined();
  });
});
```

Remove the `credentialRowsFor` import from the file's top-level import list (it will no longer exist).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/tui-ink/app-state.test.ts`
Expected: FAIL to even collect the file — the new functions don't exist yet, and `credentialRowsFor` is still imported/tested by the old block you just replaced (removing the import before removing the export would also fail to compile; do both in the same step).

- [ ] **Step 3: Implement**

In `src/tui-ink/app-state.ts`, delete `CredentialRow` (lines 50-54) and `credentialRowsFor` (lines 71-98) entirely — the import-vs-add split replaces the flat row list this function built.

Add the new functions after `candidatesForProviders` (end of file):

```ts
/**
 * Providers with an actually detected codex or opencode credential — the
 * bulk-import screen's contents. A harness's model catalogue listing a
 * provider is not the same as a credential existing for it.
 */
export function importableProviders(
  providers: ProviderOption[],
  availability: Record<string, AvailableCredentials>,
): ProviderOption[] {
  const seen = new Set<string>();
  const out: ProviderOption[] = [];
  for (const provider of providers) {
    if (seen.has(provider.provider)) continue;
    const have = availability[provider.provider];
    if (have === undefined || (have.codex === null && have.opencode === null)) continue;
    seen.add(provider.provider);
    out.push(provider);
  }
  return out;
}

/**
 * The Add-provider search list: every known provider not already configured
 * in this run, deduped by name (a provider can appear once per harness that
 * knows it) and sorted for a stable, scannable list.
 */
export function addProviderCatalog(
  providers: ProviderOption[],
  configuredGateways: readonly string[],
): ProviderOption[] {
  const configured = new Set(configuredGateways);
  const seen = new Set<string>();
  const out: ProviderOption[] = [];
  for (const provider of providers) {
    if (configured.has(provider.provider) || seen.has(provider.provider)) continue;
    seen.add(provider.provider);
    out.push(provider);
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * The gateway names already configured in this run, resolved from
 * `providerKeys` — a catalogued provider's key resolves through the provider
 * list, a byok/custom provider's key resolves through `byokProviderName`.
 */
export function configuredProviderNames(providerKeys: readonly string[], providers: ProviderOption[]): string[] {
  const byKey = new Map(providers.map((p) => [p.key, p.provider]));
  return providerKeys
    .map((key) => byokProviderName(key) ?? byKey.get(key))
    .filter((name): name is string => name !== undefined);
}

export function validateCustomProviderName(name: string, existingNames: readonly string[]): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') return 'A name is required.';
  if (existingNames.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
    return `"${trimmed}" is already a provider — pick a different name.`;
  }
  return undefined;
}

export function validateProviderUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === '') return 'A base URL is required.';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Enter a full URL, including https://.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'The URL must start with http:// or https://.';
  }
  return undefined;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/tui-ink/app-state.test.ts`
Expected: PASS, full file green.

- [ ] **Step 5: Typecheck, then check for other consumers of the removed export**

Run: `npm run typecheck`
Expected: errors in `src/tui-ink/app.tsx`, which still imports and uses `credentialRowsFor` — this is expected and resolved by Task 8. Confirm the *only* errors are in `app.tsx` (grep `credentialRowsFor` across `src/` — it must appear only in `app-state.ts`, now with the export removed, and `app.tsx`). Do not fix `app.tsx` here; Task 8 replaces its entire usage.

- [ ] **Step 6: Commit**

```bash
git add src/tui-ink/app-state.ts tests/tui-ink/app-state.test.ts
git commit -m "feat(tui): add provider-catalog and custom-provider validation helpers"
```

Note: this commit leaves `npm run typecheck` failing (in `app.tsx` only) until Task 8. That is expected — Tasks 4-8 form one coherent unit of work; run the full suite/typecheck/build gate at the end of Task 8, not after each of Tasks 4-7.

---

### Task 5: `SearchSelect` component

**Files:**
- Create: `src/tui-ink/components/search-select.tsx`

**Interfaces:**
- Consumes: `msVisible` from `src/tui-ink/components/multi-select-state.ts` (already exists and is already tested).
- Produces: `SearchSelect<T>` component and `SearchSelectItem<T>`/`SearchSelectProps<T>` types, consumed by Task 7's `ProvidersStep`.

- [ ] **Step 1: Implement**

No new pure logic is introduced (filtering reuses the already-tested `msVisible`), so this task has no new test file — it is verified by typecheck now and exercised indirectly once Task 7 wires it in.

Create `src/tui-ink/components/search-select.tsx`:

```tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { msVisible } from './multi-select-state.js';

export interface SearchSelectItem<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface SearchSelectProps<T> {
  title: string;
  items: Array<SearchSelectItem<T>>;
  onSubmit: (value: T) => void;
  onBack?: () => void;
  onCancel?: () => void;
}

const WINDOW_ROWS = 12;

/**
 * A single-select, type-to-filter list — the Add-provider catalog can run to
 * several dozen entries, too many for a plain arrow-navigated `Choice`.
 */
export function SearchSelect<T>({ title, items, onSubmit, onBack, onCancel }: SearchSelectProps<T>): React.ReactElement {
  const labels = items.map((item) => item.label);
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);
  const visible = msVisible(labels, filter);
  const boundedCursor = visible.length === 0 ? 0 : Math.min(cursor, visible.length - 1);
  const start = Math.max(0, Math.min(boundedCursor - Math.floor(WINDOW_ROWS / 2), visible.length - WINDOW_ROWS));
  const end = Math.min(visible.length, start + WINDOW_ROWS);

  useInput((input, key) => {
    if (key.escape) return onCancel?.();
    if (key.leftArrow) return onBack?.();
    if (key.return) {
      const index = visible[boundedCursor];
      if (index !== undefined) onSubmit(items[index]!.value);
      return;
    }
    if (key.upArrow) return setCursor((c) => (visible.length === 0 ? 0 : (c - 1 + visible.length) % visible.length));
    if (key.downArrow) return setCursor((c) => (visible.length === 0 ? 0 : (c + 1) % visible.length));
    if (key.backspace) return setFilter((f) => f.slice(0, -1));
    if (input.length === 1 && /[a-zA-Z0-9._\-/ ]/.test(input)) {
      setFilter((f) => f + input);
      setCursor(0);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text>Filter: {filter}</Text>
      <Text dimColor>{visible.length} of {items.length} shown</Text>
      {start > 0 && <Text dimColor>  ↑ {start} more</Text>}
      {Array.from({ length: end - start }, (_, offset) => {
        const row = start + offset;
        const index = visible[row]!;
        const item = items[index]!;
        return (
          <Text key={index} inverse={row === boundedCursor}>
            {row === boundedCursor ? '›' : ' '} {item.label}{item.hint ? `  · ${item.hint}` : ''}
          </Text>
        );
      })}
      {end < visible.length && <Text dimColor>  ↓ {visible.length - end} more</Text>}
      <Text dimColor>
        ↑↓ choose · type to filter · enter confirm{onBack ? ' · ← back' : ''}{onCancel ? ' · esc cancel' : ''}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: the pre-existing `app.tsx`/`credentialRowsFor` errors from Task 4 remain (unresolved until Task 8); no *new* errors from this file.

- [ ] **Step 3: Commit**

```bash
git add src/tui-ink/components/search-select.tsx
git commit -m "feat(tui): add SearchSelect, a filterable single-select list"
```

---

### Task 6: Extract `ByokStep` into its own file

**Files:**
- Create: `src/tui-ink/components/byok-step.tsx`
- Modify: `src/tui-ink/app.tsx:88-256` (remove `ByokStep` and its private helpers, import it instead)

**Interfaces:**
- Produces: `ByokStep`, `ByokStepProps` exported from the new file, consumed by Task 7's `ProvidersStep` and (unchanged call site, just relocated) by `app.tsx` until Task 8 removes that call site.

This is a pure refactor — no behavior changes, so no new tests. The existing suite (which exercises `ByokStep` only indirectly, since it has no dedicated render tests per the codebase's established convention of testing TUI components by typecheck + their underlying pure state, not rendering) must stay green throughout.

- [ ] **Step 1: Create the new file with the extracted code**

Create `src/tui-ink/components/byok-step.tsx` containing exactly the current `src/tui-ink/app.tsx:88-256` block (the `ByokStepProps` interface, the `ByokStep` function, and its three private helpers `hintFor`, `validateIds`, `parseIds`), with adjusted imports for its new location:

```tsx
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MultiSelect } from './multi-select.js';
import { TextInput } from './text-input.js';
import { isAnthropicRoutedName } from '../../config.js';
import { fetchModels as defaultFetchModels, type FetchModelsResult } from '../../native/models.js';

interface ChoiceProps<T> {
  title: string;
  choices: Array<{ value: T; label: string }>;
  initial?: T;
  onSubmit: (value: T) => void;
  onBack?: () => void;
  onCancel: () => void;
}

function Choice<T>({ title, choices, initial, onSubmit, onBack, onCancel }: ChoiceProps<T>): React.ReactElement {
  const [cursor, setCursor] = useState(() => Math.max(0, choices.findIndex((choice) => choice.value === initial)));

  useInput((_, key) => {
    if (key.escape) return onCancel();
    if (key.leftArrow) return onBack?.();
    if (key.upArrow) return setCursor((current) => (current - 1 + choices.length) % choices.length);
    if (key.downArrow) return setCursor((current) => (current + 1) % choices.length);
    if (key.return && choices[cursor]) onSubmit(choices[cursor].value);
  });

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {choices.map((choice, index) => (
        <Text key={String(choice.value)} inverse={index === cursor}>
          {index === cursor ? '›' : ' '} {choice.label}
        </Text>
      ))}
      <Text dimColor>↑↓ choose · enter confirm{onBack ? ' · ← back' : ''} · esc cancel</Text>
    </Box>
  );
}

export interface ByokStepProps {
  provider: { name: string; url: string };
  /** The key already stored for this provider, or typed earlier in this run. */
  apiKey?: string;
  initialIds?: string[];
  fetchModels: typeof defaultFetchModels;
  onKey: (key: string) => void;
  onSubmit: (ids: string[]) => void;
  onBack: () => void;
  onCancel: () => void;
}

/**
 * One BYOK provider: get a key if we lack one, ask the provider what it serves,
 * and let the user choose — or type ids, when it will not say.
 *
 * This is the wizard's only asynchronous step. The fetch runs in an effect and
 * the reducer never blocks on it; a `cancelled` flag keeps a late response from
 * writing into a screen the user has already left.
 */
export function ByokStep(props: ByokStepProps): React.ReactElement {
  const { provider, apiKey, initialIds, fetchModels, onKey, onSubmit, onBack, onCancel } = props;
  const [result, setResult] = useState<FetchModelsResult | undefined>(undefined);
  const [dropped, setDropped] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [ignoreRejection, setIgnoreRejection] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (apiKey === undefined) return;
    let cancelled = false;
    void fetchModels(provider.url, apiKey).then((found) => {
      if (cancelled) return;
      if (found.outcome === 'ok') {
        const usable = found.models.filter((model) => !isAnthropicRoutedName(model.id));
        setDropped(found.models.length - usable.length);
        setResult({ outcome: 'ok', models: usable });
      } else {
        setResult(found);
      }
    });
    return () => { cancelled = true; };
  }, [apiKey, provider.url, fetchModels, attempt]);

  const retryKey = (): void => {
    setResult(undefined);
    setIgnoreRejection(false);
    setRetrying(false);
    setAttempt((n) => n + 1);
  };

  if (apiKey === undefined || (result?.outcome === 'unauthorized' && retrying)) {
    return (
      <TextInput
        key={`byok-key-${provider.name}-${attempt}`}
        title={`API key for ${provider.name}`}
        hint={`${provider.url} · stored in sonata's key store, not shown again`}
        mask
        validate={(value) => value.trim() === '' ? 'A key is required to list this provider\'s models.' : undefined}
        onSubmit={(value) => { onKey(value.trim()); retryKey(); }}
        onBack={onBack}
        onCancel={onCancel}
      />
    );
  }

  if (result === undefined) {
    return (
      <Box flexDirection="column">
        <Text bold>{provider.name}</Text>
        <Text dimColor>fetching models from {provider.url}…</Text>
      </Box>
    );
  }

  if (result.outcome === 'unauthorized' && !ignoreRejection) {
    return (
      <Choice
        key={`byok-rejected-${provider.name}`}
        title={`${provider.name} rejected that key (HTTP ${result.status})`}
        choices={[
          { value: 'retry' as const, label: 'Re-enter the key' },
          { value: 'manual' as const, label: 'Keep it and type model ids by hand' },
        ]}
        initial={'retry' as const}
        onSubmit={(choice) => choice === 'retry' ? setRetrying(true) : setIgnoreRejection(true)}
        onBack={onBack}
        onCancel={onCancel}
      />
    );
  }

  if (result.outcome !== 'ok' || result.models.length === 0) {
    return (
      <TextInput
        key={`byok-ids-${provider.name}`}
        title={`Model ids for ${provider.name} (comma-separated)`}
        hint={hintFor(result, provider.url)}
        initial={initialIds?.join(', ')}
        validate={validateIds}
        onSubmit={(value) => onSubmit(parseIds(value))}
        onBack={onBack}
        onCancel={onCancel}
      />
    );
  }

  return (
    <Box flexDirection="column">
      {dropped > 0 && (
        <Text dimColor>
          {dropped} claude-* model{dropped === 1 ? '' : 's'} not shown — the router reserves that prefix
        </Text>
      )}
      <MultiSelect
        key={`byok-models-${provider.name}`}
        title={`Models for ${provider.name}`}
        items={result.models.map((model) => ({ value: model.id, label: model.name ?? model.id, hint: model.id }))}
        initialSelected={new Set(initialIds)}
        onSubmit={onSubmit}
        onBack={onBack}
        onCancel={onCancel}
      />
    </Box>
  );
}

/** Says what actually happened, so the fallback is not read as a diagnosis. */
function hintFor(result: FetchModelsResult, url: string): string {
  switch (result.outcome) {
    case 'unauthorized':
      return `${url} rejected the key for listing models — enter ids by hand`;
    case 'unreachable':
      return `could not reach ${url} — enter ids by hand`;
    default:
      return `${url} did not return a model list — enter ids by hand`;
  }
}

function validateIds(value: string): string | undefined {
  if (parseIds(value).length > 0) return undefined;
  const typed = value.split(',').map((id) => id.trim()).filter((id) => id !== '');
  return typed.length > 0
    ? 'None of those can be used: the router reserves `claude-` for Anthropic.'
    : 'Enter at least one model id.';
}

function parseIds(value: string): string[] {
  return [...new Set(value.split(',').map((id) => id.trim()).filter((id) => id !== ''))]
    .filter((id) => !isAnthropicRoutedName(id));
}
```

- [ ] **Step 2: Remove the extracted code from `app.tsx` and import it instead**

In `src/tui-ink/app.tsx`, delete lines 88-256 (the `ByokStepProps` interface, `ByokStep` function, `hintFor`, `validateIds`, `parseIds` — everything between the `Choice` component and the `Summary` function). Note `Choice` itself (lines 55-86) stays in `app.tsx` — it is still used by `Summary`-adjacent screens and by the (currently still present, to be simplified in Task 8) `case 3` block; do not remove it here.

Add an import near the top of `app.tsx`, alongside the existing `LoginScreen` import:

```ts
import { ByokStep } from './components/byok-step.js';
```

`app.tsx`'s existing `case 3` block (lines 437-459 in the current file, the byok-walking loop) still calls `ByokStep` directly — leave that call site as-is for now; it now resolves through the new import instead of the local definition. This will be deleted in Task 8, not this task — keep this task a pure relocation with zero behavior change.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: the pre-existing `credentialRowsFor` errors from Task 4 remain (unresolved until Task 8); no new errors. `ByokStep`'s relocation must not introduce any type mismatch — `ByokStepProps`, `FetchModelsResult`, `defaultFetchModels` all resolve the same way through the new relative import paths (`../../config.js`, `../../native/models.js` from the `components/` subdirectory).

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS — this is a pure relocation, so nothing behavioral changed; any failure here means an import path or prop was transcribed incorrectly and must be fixed before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/tui-ink/components/byok-step.tsx src/tui-ink/app.tsx
git commit -m "refactor(tui): extract ByokStep into its own file"
```

---

### Task 7: `ProvidersStep` component

**Files:**
- Create: `src/tui-ink/components/providers-step.tsx`

**Interfaces:**
- Consumes:
  - `ProviderOption`, `CandidateOption`, `AvailableCredentials`, `importableProviders`, `addProviderCatalog`, `configuredProviderNames`, `validateCustomProviderName`, `validateProviderUrl`, `byokProviderKey`, `applyStep` from `../app-state.js` (Task 4 additions plus existing exports)
  - `isOauthGatewayAuth`, `NativeGatewayAuth` from `../../config.js`
  - `byokCandidateKey`, `fetchModels as defaultFetchModels` from `../../native/models.js`
  - `LoginScreen` from `./login-screen.js`
  - `ByokStep` from `./byok-step.js` (Task 6)
  - `MultiSelect` from `./multi-select.js`
  - `TextInput` from `./text-input.js`
  - `SearchSelect` from `./search-select.js` (Task 5)
  - `InitState` from `../types.js`
- Produces: `ProvidersStep` component, consumed by Task 8's `app.tsx` rewrite of `case 2`.

This is the largest new piece of behavior in the plan, so it gets its own task with no test file of its own (matching this codebase's established convention — no `InitWizard`/step-component render tests exist anywhere; only the pure functions it calls, already tested in Tasks 1-4, are unit-tested). It is exercised indirectly, end-to-end, by Task 3's `cmdInit` test and verified directly by manual QA in Task 8's final step.

- [ ] **Step 1: Implement**

Create `src/tui-ink/components/providers-step.tsx`:

```tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { MultiSelect } from './multi-select.js';
import { TextInput } from './text-input.js';
import { SearchSelect } from './search-select.js';
import { LoginScreen } from './login-screen.js';
import { ByokStep } from './byok-step.js';
import {
  addProviderCatalog,
  applyStep,
  byokProviderKey,
  configuredProviderNames,
  importableProviders,
  validateCustomProviderName,
  validateProviderUrl,
  type AvailableCredentials,
  type ProviderOption,
} from '../app-state.js';
import { isOauthGatewayAuth, type NativeGatewayAuth } from '../../config.js';
import { fetchModels as defaultFetchModels } from '../../native/models.js';
import type { InitState } from '../types.js';

interface ChoiceProps<T> {
  title: string;
  choices: Array<{ value: T; label: string }>;
  initial?: T;
  onSubmit: (value: T) => void;
  onBack?: () => void;
  onCancel: () => void;
}

/**
 * A local copy of app.tsx's arrow-navigated Choice — kept private to this
 * file rather than shared, the same way byok-step.tsx keeps its own copy.
 * Both are small (under 35 lines) and neither depends on the other's file.
 */
function Choice<T>({ title, choices, initial, onSubmit, onBack, onCancel }: ChoiceProps<T>): React.ReactElement {
  const [cursor, setCursor] = useState(() => Math.max(0, choices.findIndex((choice) => choice.value === initial)));

  useInput((_, key) => {
    if (key.escape) return onCancel();
    if (key.leftArrow) return onBack?.();
    if (key.upArrow) return setCursor((current) => (current - 1 + choices.length) % choices.length);
    if (key.downArrow) return setCursor((current) => (current + 1) % choices.length);
    if (key.return && choices[cursor]) onSubmit(choices[cursor].value);
  });

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {choices.map((choice, index) => (
        <Text key={String(choice.value)} inverse={index === cursor}>
          {index === cursor ? '›' : ' '} {choice.label}
        </Text>
      ))}
      <Text dimColor>↑↓ choose · enter confirm{onBack ? ' · ← back' : ''} · esc cancel</Text>
    </Box>
  );
}

export interface ProvidersStepProps {
  home: string;
  providers: ProviderOption[];
  byokProviders: Array<{ name: string; url: string }>;
  credentialAvailability: Record<string, AvailableCredentials>;
  gatewayAuth: Record<string, NativeGatewayAuth>;
  storedKeys: Record<string, string>;
  fetchModels?: typeof defaultFetchModels;
  state: InitState;
  onChange: (updater: (current: InitState) => InitState) => void;
  onContinue: () => void;
  onBack: () => void;
  onCancel: () => void;
}

type Screen =
  | { kind: 'menu' }
  | { kind: 'import' }
  | { kind: 'pick' }
  | { kind: 'custom-name' }
  | { kind: 'custom-url'; name: string }
  | { kind: 'custom-format'; name: string; url: string }
  | { kind: 'credential-choice'; provider: ProviderOption }
  | { kind: 'login'; provider: ProviderOption }
  | { kind: 'key-entry'; provider: ProviderOption }
  | { kind: 'byok'; name: string; url: string };

/**
 * Replaces the old flat "log in / import from codex / import from opencode /
 * enter a key" row list with an explicit top-level choice, modeled on
 * opencode's own /connect: bulk-import everything already authenticated, or
 * add providers one at a time — including one sonata has never heard of.
 */
export function ProvidersStep(props: ProvidersStepProps): React.ReactElement {
  const {
    home, providers, byokProviders, credentialAvailability, gatewayAuth, storedKeys,
    fetchModels = defaultFetchModels, state, onChange, onContinue, onBack, onCancel,
  } = props;
  const [screen, setScreen] = useState<Screen>({ kind: 'menu' });
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const configured = configuredProviderNames(state.providerKeys ?? [], providers);
  const existingNames = [
    ...providers.map((p) => p.provider),
    ...byokProviders.map((p) => p.name),
    ...(state.customProviders ?? []).map((p) => p.name),
  ];

  if (screen.kind === 'menu') {
    const importable = importableProviders(providers, credentialAvailability);
    const choices: Array<{ value: 'import' | 'add' | 'continue'; label: string }> = [];
    if (importable.length > 0) choices.push({ value: 'import', label: 'Import from other harnesses' });
    choices.push({ value: 'add', label: 'Add provider' });
    if (configured.length > 0) choices.push({ value: 'continue', label: 'Continue' });
    return (
      <Box flexDirection="column">
        {problem !== undefined && <Text color="red">{problem}</Text>}
        <Choice
          key="providers-menu"
          title="Set up providers"
          choices={choices}
          initial={choices[0]?.value}
          onSubmit={(choice) => {
            setProblem(undefined);
            if (choice === 'import') setScreen({ kind: 'import' });
            else if (choice === 'add') setScreen({ kind: 'pick' });
            else onContinue();
          }}
          onBack={onBack}
          onCancel={onCancel}
        />
      </Box>
    );
  }

  if (screen.kind === 'import') {
    const importable = importableProviders(providers, credentialAvailability);
    return (
      <MultiSelect
        key="providers-import"
        title="Import from other harnesses"
        items={importable.map((provider) => {
          const have = credentialAvailability[provider.provider]!;
          const fromCodex = have.codex !== null;
          const days = (fromCodex ? have.codex : have.opencode)?.expiresInDays ?? null;
          const hint = days === null ? 'expiry unknown' : days < 0 ? 'expired — re-login in that tool' : `expires in ${days}d`;
          return { value: provider.key, label: provider.provider, hint };
        })}
        initialSelected={new Set()}
        onSubmit={(keys) => {
          onChange((current) => {
            const nextCredentialSources = { ...current.credentialSources };
            for (const key of keys) {
              const provider = importable.find((p) => p.key === key);
              if (provider === undefined) continue;
              const have = credentialAvailability[provider.provider]!;
              nextCredentialSources[provider.provider] = have.codex !== null ? 'codex' : 'opencode';
            }
            return {
              ...current,
              providerKeys: [...new Set([...(current.providerKeys ?? []), ...keys])],
              credentialSources: nextCredentialSources,
            };
          });
          setScreen({ kind: 'menu' });
        }}
        onBack={() => setScreen({ kind: 'menu' })}
        onCancel={onCancel}
      />
    );
  }

  if (screen.kind === 'pick') {
    const catalog = addProviderCatalog(providers, configured);
    const items = [
      ...catalog.map((provider) => ({ value: provider.key, label: provider.provider, hint: provider.harness })),
      { value: '__custom__', label: 'Add a custom provider…' },
    ];
    return (
      <SearchSelect
        key="providers-pick"
        title="Add provider"
        items={items}
        onSubmit={(value) => {
          if (value === '__custom__') { setScreen({ kind: 'custom-name' }); return; }
          const provider = catalog.find((p) => p.key === value);
          if (provider === undefined) return;
          if (provider.harness === 'byok') {
            const known = byokProviders.find((p) => p.name === provider.provider);
            if (known !== undefined) setScreen({ kind: 'byok', name: known.name, url: known.url });
            return;
          }
          const auth = gatewayAuth[provider.provider];
          if (auth !== undefined && isOauthGatewayAuth(auth)) {
            setScreen({ kind: 'credential-choice', provider });
          } else {
            setScreen({ kind: 'key-entry', provider });
          }
        }}
        onBack={() => setScreen({ kind: 'menu' })}
        onCancel={onCancel}
      />
    );
  }

  if (screen.kind === 'custom-name') {
    return (
      <TextInput
        key="providers-custom-name"
        title="Custom provider name"
        hint="a short identifier, e.g. my-proxy"
        validate={(value) => validateCustomProviderName(value, existingNames)}
        onSubmit={(value) => setScreen({ kind: 'custom-url', name: value.trim() })}
        onBack={() => setScreen({ kind: 'pick' })}
        onCancel={onCancel}
      />
    );
  }

  if (screen.kind === 'custom-url') {
    return (
      <TextInput
        key={`providers-custom-url-${screen.name}`}
        title={`Base URL for ${screen.name}`}
        hint="e.g. https://api.example.com/v1"
        validate={validateProviderUrl}
        onSubmit={(value) => setScreen({ kind: 'custom-format', name: screen.name, url: value.trim() })}
        onBack={() => setScreen({ kind: 'custom-name' })}
        onCancel={onCancel}
      />
    );
  }

  if (screen.kind === 'custom-format') {
    const { name, url } = screen;
    return (
      <Choice
        key={`providers-custom-format-${name}`}
        title={`Wire format for ${name}`}
        choices={[
          { value: 'openai' as const, label: 'OpenAI-compatible' },
          { value: 'anthropic' as const, label: 'Anthropic-compatible' },
        ]}
        initial={'openai' as const}
        onSubmit={(format) => {
          onChange((current) => ({
            ...current,
            customProviders: [...(current.customProviders ?? []), { name, url }],
            customWireFormats: format === 'anthropic'
              ? { ...current.customWireFormats, [name]: 'anthropic' as const }
              : current.customWireFormats,
          }));
          setScreen({ kind: 'byok', name, url });
        }}
        onBack={() => setScreen({ kind: 'custom-url', name, url })}
        onCancel={onCancel}
      />
    );
  }

  if (screen.kind === 'credential-choice') {
    const { provider } = screen;
    return (
      <Box flexDirection="column">
        {problem !== undefined && <Text color="red">{problem}</Text>}
        <Choice
          key={`providers-credential-choice-${provider.provider}`}
          title={`Credential for ${provider.provider}`}
          choices={[
            { value: 'login' as const, label: 'Run OAuth login' },
            { value: 'key' as const, label: 'Enter an API key' },
          ]}
          initial={'login' as const}
          onSubmit={(choice) => {
            setProblem(undefined);
            setScreen(choice === 'login' ? { kind: 'login', provider } : { kind: 'key-entry', provider });
          }}
          onBack={() => setScreen({ kind: 'pick' })}
          onCancel={onCancel}
        />
      </Box>
    );
  }

  if (screen.kind === 'login') {
    const { provider } = screen;
    const auth = gatewayAuth[provider.provider];
    if (auth === undefined) { setScreen({ kind: 'pick' }); return <></>; }
    return (
      <LoginScreen
        key={`providers-login-${provider.provider}`}
        home={home}
        gateway={provider.provider}
        auth={auth}
        onDone={(result) => {
          if (result.ok) {
            onChange((current) => ({
              ...current,
              providerKeys: [...new Set([...(current.providerKeys ?? []), provider.key])],
              credentialSources: { ...current.credentialSources, [provider.provider]: 'sonata' },
            }));
            setScreen({ kind: 'menu' });
          } else {
            setProblem(result.problem ?? 'Login failed.');
            setScreen({ kind: 'credential-choice', provider });
          }
        }}
      />
    );
  }

  if (screen.kind === 'key-entry') {
    const { provider } = screen;
    const auth = gatewayAuth[provider.provider];
    const canGoBackToChoice = auth !== undefined && isOauthGatewayAuth(auth);
    return (
      <TextInput
        key={`providers-key-entry-${provider.provider}`}
        title={`API key for ${provider.provider}`}
        hint="stored in sonata's key store, not shown again"
        mask
        validate={(value) => value.trim() === '' ? 'A key is required.' : undefined}
        onSubmit={(value) => {
          onChange((current) => ({
            ...current,
            byokKeys: { ...current.byokKeys, [provider.provider]: value.trim() },
            providerKeys: [...new Set([...(current.providerKeys ?? []), provider.key])],
          }));
          setScreen({ kind: 'menu' });
        }}
        onBack={() => setScreen(canGoBackToChoice ? { kind: 'credential-choice', provider } : { kind: 'pick' })}
        onCancel={onCancel}
      />
    );
  }

  // screen.kind === 'byok'
  const { name, url } = screen;
  return (
    <ByokStep
      key={`providers-byok-${name}`}
      provider={{ name, url }}
      apiKey={state.byokKeys?.[name] ?? storedKeys[name]}
      initialIds={state.byokModels?.[name]}
      fetchModels={fetchModels}
      onKey={(key) => onChange((current) => ({ ...current, byokKeys: { ...current.byokKeys, [name]: key } }))}
      onSubmit={(ids) => {
        onChange((current) => {
          const withModels = applyStep(current, 6, { provider: name, ids });
          return {
            ...withModels,
            providerKeys: [...new Set([...(withModels.providerKeys ?? []), byokProviderKey(name)])],
          };
        });
        setScreen({ kind: 'menu' });
      }}
      onBack={() => setScreen({ kind: 'pick' })}
      onCancel={onCancel}
    />
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: the pre-existing `app.tsx`/`credentialRowsFor` errors from Task 4 remain (unresolved until Task 8); no new errors from this file. Pay particular attention to the `screen.kind === 'login'` branch's early return (`return <></>;`) — confirm it satisfies the function's `React.ReactElement` return type (an empty fragment is a valid `ReactElement`).

- [ ] **Step 3: Commit**

```bash
git add src/tui-ink/components/providers-step.tsx
git commit -m "feat(tui): add ProvidersStep — the Import/Add-provider menu and flows"
```

---

### Task 8: Wire `ProvidersStep` into the wizard, simplify the models step

**Files:**
- Modify: `src/tui-ink/app.tsx`

**Interfaces:**
- Consumes: `ProvidersStep` (Task 7), `importableProviders`/`addProviderCatalog`/etc. are NOT imported directly into `app.tsx` — they're used only inside `ProvidersStep`.
- Produces: the wizard's actual step 2/3 behavior — this task has no new exports; it is the integration point.

- [ ] **Step 1: Update imports**

In `src/tui-ink/app.tsx`, replace the import block (lines 1-20) with:

```tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ProvidersStep } from './components/providers-step.js';
import {
  applyStep,
  byokProviderName,
  candidatesForProviders,
  providersForHarnesses,
  type AvailableCredentials,
  type CandidateOption,
  type ProviderOption,
} from './app-state.js';
import { type NativeGatewayAuth } from '../config.js';
import {
  byokCandidateKey, fetchModels as defaultFetchModels, type FetchModelsResult,
} from '../native/models.js';
import type { InitState, TuiResult } from './types.js';
```

This drops `TextInput`, `credentialRowsFor`, `isOauthGatewayAuth`, and `LoginScreen` — all now used only inside `providers-step.tsx`/`byok-step.tsx`. `byokProviderName` stays (still used by the models-step candidate/byok bookkeeping below). `FetchModelsResult` stays (still referenced in `WizardData`'s `fetchModels` type). `useEffect` is no longer used directly in this file (it was only used by the now-relocated `ByokStep`) — drop it from the `react` import, keeping just `React, { useState }`.

- [ ] **Step 2: Replace `case 2`**

Replace the current `case 2` block:

```tsx
    case 2: {
      const providers = providersForHarnesses(data.providers, state.harnesses);
      return <MultiSelect key="providers" title="Providers" items={providers.map((provider) => ({ value: provider.key, label: provider.provider, hint: `${provider.harness} · ${provider.count}` }))} initialSelected={new Set(state.providerKeys)} onSubmit={next} onBack={back} onCancel={cancel} />;
    }
```

with:

```tsx
    case 2: {
      const providers = providersForHarnesses(data.providers, state.harnesses);
      return <ProvidersStep
        key="providers-step"
        home={data.home}
        providers={providers}
        byokProviders={data.byokProviders}
        credentialAvailability={data.credentialAvailability ?? {}}
        gatewayAuth={data.gatewayAuth ?? {}}
        storedKeys={data.storedKeys}
        fetchModels={data.fetchModels ?? defaultFetchModels}
        state={state}
        onChange={setState}
        onContinue={() => setStep(3)}
        onBack={back}
        onCancel={cancel}
      />;
    }
```

- [ ] **Step 3: Replace `case 3`**

Replace the entire current `case 3` block (from `case 3: {` through its closing `}` — everything covering the old credential-source screen and the byok-walking loop) with:

```tsx
    case 3: {
      const providers = providersForHarnesses(data.providers, state.harnesses);
      const candidates = candidatesForProviders(data.candidates, providers, state.providerKeys);
      if (candidates.length === 0) return <Summary state={state} onDone={onDone} onBack={back} />;
      return <MultiSelect
        key="models"
        title="Models"
        items={candidates.map((candidate) => ({ value: candidate.key, label: candidate.label, hint: candidate.id }))}
        initialSelected={new Set(state.nativeKeys)}
        onSubmit={(keys) => {
          // Keep any BYOK/custom-provider keys already chosen: this step owns
          // the harness candidates only, and a plain overwrite would drop the
          // rest — they were already selected inside ProvidersStep.
          const byokKeys = new Set(Object.entries(state.byokModels ?? {}).flatMap(([provider, ids]) =>
            ids.map((id) => byokCandidateKey(provider, id))));
          const kept = (state.nativeKeys ?? []).filter((key) => byokKeys.has(key));
          setState((current) => applyStep(current, 3, [...(keys as string[]), ...kept]));
          setStep(4);
        }}
        onBack={back}
        onCancel={cancel}
      />;
    }
```

- [ ] **Step 4: Remove now-dead local state from `InitWizard`**

In the `InitWizard` function body, remove these `useState` declarations, which existed only for the old `case 3` block's credential-source and byok-walk logic (all now owned internally by `ProvidersStep`):

```tsx
  // Walks the selected credential gateways within step 3, before models.
  const [credentialIndex, setCredentialIndex] = useState(0);
  const [enteringCredentialKey, setEnteringCredentialKey] = useState(false);
  const [enteringLogin, setEnteringLogin] = useState(false);
  const [credentialProblem, setCredentialProblem] = useState<string | undefined>(undefined);
  // Walks the selected BYOK providers within step 3, the way roleIndex walks
  // roles within step 5.
  const [byokIndex, setByokIndex] = useState(0);
```

Also remove the two references to `setCredentialIndex` inside `chooseScope`:

```tsx
  const chooseScope = (scope: InitState['configScope']) => {
    setState(data.initialStateByScope?.[scope!] ?? { configScope: scope });
    setSameModels(undefined);
    setRoleIndex(0);
    setCredentialIndex(0);   // <-- remove this line
    setStep(1);
  };
```

becomes:

```tsx
  const chooseScope = (scope: InitState['configScope']) => {
    setState(data.initialStateByScope?.[scope!] ?? { configScope: scope });
    setSameModels(undefined);
    setRoleIndex(0);
    setStep(1);
  };
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean — this resolves every error left open since Task 4 (no more references to `credentialRowsFor`, `enteringCredentialKey`, etc. anywhere in `app.tsx`).

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, full suite green — including Task 3's new end-to-end `cmdInit` test (which exercises this wiring indirectly through the mocked `runInitTui`/`tuiMocks.result` path, without rendering Ink).

- [ ] **Step 7: Manual smoke test**

Run `npm run build && npm link` (if not already linked) and run `sonata init` in a scratch directory (or `--config-scope` a throwaway location) to walk the new menu by hand: confirm "Import from other harnesses" is offered only when a real codex/opencode credential exists on the machine, confirm "Add provider" lists known providers plus "Add a custom provider…", and confirm a custom provider walks name → URL → wire format → key entry → model ids, landing back on the menu with "Continue" now present. This step has no automated assertion — it is the one place in this plan that needs a human (or an agent literally reading the rendered terminal output) to confirm the interactive experience matches the spec, since this codebase has no Ink-rendering test harness.

- [ ] **Step 8: Commit**

```bash
git add src/tui-ink/app.tsx
git commit -m "feat(init): wire ProvidersStep into the wizard, drop the old flat credential screen"
```

---

### Task 9: Documentation and final verification

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above. Produces no code.

- [ ] **Step 1: Document `wire_format`**

In `CLAUDE.md`, under Configuration, add `wire_format` to the `[native.gateways]` description alongside the existing `credential_source` bullet (near "Keys are always quoted"): the two values (`openai` default, `anthropic`), that it is refused on any OAuth-auth gateway, and that it exists to support a hand-typed custom provider from `sonata init`'s Add-provider flow.

- [ ] **Step 2: Document the wizard flow**

In `CLAUDE.md`, under a relevant section (e.g. near the existing description of `sonata init`'s interactive TUI being an Ink app), add a short note: the provider-setup step is now a menu (Import from other harnesses / Add provider), Add provider supports picking any known provider or typing in a fully custom one (name, base URL, wire format), and a custom provider always authenticates by API key — sonata has no generic OAuth mechanism beyond the two LiteLLM-backed device flows (codex, github-copilot).

- [ ] **Step 3: Run the full verification gate**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green. This is the same gate every prior task in this plan already passed individually — this step re-confirms nothing regressed across the whole sequence.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: wire_format and the Add provider / Import from harnesses wizard flow"
```

- [ ] **Step 5: Push**

Push the full sequence of commits from this plan to `origin/main`, per this repository's standing convention that finishing a change includes pushing it.
