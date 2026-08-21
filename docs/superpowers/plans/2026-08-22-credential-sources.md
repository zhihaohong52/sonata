# Credential Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user explicitly choose where each native gateway's credential comes from — sonata's own store, codex, or opencode — and log in to a subscription provider from sonata itself, without a harness installed.

**Architecture:** A new optional `credential_source` field on `NativeGatewayConfig` turns today's implicit sniffing precedence into a recorded choice. A new `src/native/oauth-login.ts` drives LiteLLM's own device-code authenticator as a subprocess, so no OAuth protocol is implemented in sonata and no token passes through sonata's memory. `serve` points LiteLLM's token-directory variables at a persistent `~/.config/sonata/credentials/<gateway>/` for the `sonata` source, which also fixes the live bug where every token refresh is discarded on exit.

**Tech Stack:** TypeScript (Node 22, ESM, `.js` import specifiers), vitest, Ink for the wizard, LiteLLM 1.82.3 as an external prerequisite.

**Spec:** `docs/superpowers/specs/2026-08-21-credential-sources-design.md`

## Global Constraints

- **Never call LiteLLM's `_login()`.** Use `Authenticator().get_access_token()`; only it persists the token. For Copilot, follow with `get_api_key()`.
- **Never hardcode `api.githubcopilot.com`.** Pass no `api_base`; LiteLLM's `get_api_base()` reads `endpoints.api` from `api-key.json` (business tenants differ).
- **Never re-derive LiteLLM's verification URLs.** Relay the printed lines. The device-code response has no `verification_uri` for ChatGPT.
- **Relay verbatim:** `"Device codes are a common phishing target. Never share this code."`
- **No credential in argv.** No `--key` flag, and no flag that performs a login.
- **Login child env is `PATH` plus the one token-directory variable, nothing else.** Matches `serve.ts:222`.
- **Never log token material.** Log the gateway a credential belongs to, never its value.
- Credential directories are `0700`; credential files `0600`.
- Poll windows: ChatGPT `15 * 60` seconds; Copilot `12 × 5 = 60` seconds, retried 3 times with a **new code each time**.
- Tests run with **no API keys and no network**. Every LiteLLM interaction is behind an injected `interpreter`.
- Run `npm run build` before testing `sonata` on PATH — it runs `dist/`, not `src/`.

---

### Task 1: Record the credential source in config

**Files:**
- Modify: `src/config.ts:73` (interface), `src/config.ts:175-205` (parser)
- Modify: `src/native/credentials.ts:15` (rename colliding local interface)
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export type CredentialSource = 'sonata' | 'codex' | 'opencode'`; `export const CREDENTIAL_SOURCES: readonly CredentialSource[]`; `NativeGatewayConfig.credentialSource?: CredentialSource`. Every later task imports these from `../config.js`.

**Note on the rename:** `src/native/credentials.ts:15` already declares a *local, unexported* `interface CredentialSource { name: string; read(home: string): Record<string, string> }`. It describes a key-store reader, not the new union. Rename it to `KeyStoreSource` in the same task, so no file can hold two meanings of one name.

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts`:

```ts
describe('native gateway credential_source', () => {
  it('round-trips each valid source', () => {
    for (const source of ['sonata', 'codex', 'opencode']) {
      const config = parseConfig(`
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "${source}"
`, '/tmp/x');
      expect(config.native!.gateways.codex.credentialSource).toBe(source);
    }
  });

  it('leaves the field undefined when absent, preserving today\'s resolution', () => {
    const config = parseConfig(`
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.codex]
auth = "codex-oauth"
`, '/tmp/x');
    expect(config.native!.gateways.codex.credentialSource).toBeUndefined();
  });

  it('refuses an unknown source by name, listing the valid ones', () => {
    expect(() => parseConfig(`
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "keychain"
`, '/tmp/x')).toThrow(/unknown credential_source "keychain".*sonata, codex, opencode/s);
  });

  it('refuses codex as the source for an api-key gateway', () => {
    // codex holds a subscription, not a bearer key; a metered endpoint
    // authenticates it and then 429s, which reads as a missing key.
    expect(() => parseConfig(`
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.openrouter]
base_url = "https://openrouter.ai/api/v1"
credential_source = "codex"
`, '/tmp/x')).toThrow(/cannot take its credential from codex/);
  });

  it('allows opencode as the source for an api-key gateway', () => {
    // opencode holds API keys as well as OAuth entries.
    const config = parseConfig(`
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.openrouter]
base_url = "https://openrouter.ai/api/v1"
credential_source = "opencode"
`, '/tmp/x');
    expect(config.native!.gateways.openrouter.credentialSource).toBe('opencode');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/config.test.ts -t credential_source`
Expected: FAIL — `credentialSource` is `undefined` on every case, and the two refusal tests do not throw.

- [ ] **Step 3: Add the type and the interface field**

In `src/config.ts`, beside `NATIVE_GATEWAY_AUTHS`:

```ts
/**
 * Where a gateway's credential comes from. Absent means "resolve as today":
 * `resolveKeys`'s fixed precedence for keys, `readChatGptOAuth`'s for OAuth.
 * Recording it makes the choice survive a re-run of `sonata init`, which
 * otherwise re-sniffs and can silently answer differently.
 */
export type CredentialSource = 'sonata' | 'codex' | 'opencode';

export const CREDENTIAL_SOURCES: readonly CredentialSource[] = ['sonata', 'codex', 'opencode'];
```

Replace the interface at `src/config.ts:73`:

```ts
export interface NativeGatewayConfig {
  baseUrl: string;
  auth: NativeGatewayAuth;
  credentialSource?: CredentialSource;
}
```

- [ ] **Step 4: Parse and validate the field**

In `src/config.ts`, inside the gateway loop, immediately after `const auth = rawAuth as NativeGatewayAuth;` (line 185):

```ts
      let credentialSource: CredentialSource | undefined;
      if (d.credential_source !== undefined) {
        const raw = d.credential_source;
        if (typeof raw !== 'string' || !CREDENTIAL_SOURCES.includes(raw as CredentialSource)) {
          throw new Error(
            `sonata.toml: native gateway "${name}" has unknown credential_source "${String(raw)}". ` +
            `Known: ${CREDENTIAL_SOURCES.join(', ')}`,
          );
        }
        credentialSource = raw as CredentialSource;
        // codex holds a ChatGPT subscription, never a bearer key. Sending it to
        // a metered endpoint passes auth and then fails for quota, which reads
        // as a missing key — see docs/codex-subscription.md. Die here instead.
        if (credentialSource === 'codex' && auth === 'api-key') {
          throw new Error(
            `sonata.toml: native gateway "${name}" is auth = "api-key", so it ` +
            'cannot take its credential from codex — that is a subscription, not a key.',
          );
        }
      }
```

Then thread it through both assignment sites:

```ts
        gateways[name] = { baseUrl: implied, auth, credentialSource };   // line ~199
...
      gateways[name] = { baseUrl: d.base_url, auth, credentialSource };  // line ~205
```

- [ ] **Step 5: Rename the colliding interface**

In `src/native/credentials.ts`, rename the local interface and its one use:

```ts
/** A place keys are read from, in precedence order. Not the config's CredentialSource union. */
interface KeyStoreSource {
  name: string;
  read(home: string): Record<string, string>;
}
```

```ts
const SOURCES: KeyStoreSource[] = [
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/config.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/native/credentials.ts tests/config.test.ts
git commit -m "feat(config): record a gateway's credential source"
```

---

### Task 2: Drive LiteLLM's device login

**Files:**
- Create: `src/native/oauth-login.ts`
- Create: `tests/fixtures/litellm/fake-authenticator.mjs`
- Test: `tests/native/oauth-login.test.ts`

**Interfaces:**
- Consumes: `NativeGatewayAuth` from `../config.js`.
- Produces:
  - `export function credentialDir(home: string, gateway: string): string`
  - `export interface LoginProgress { line(text: string): void }`
  - `export interface LoginResult { ok: boolean; problem?: string }`
  - `export async function loginGateway(opts: { home: string; gateway: string; auth: NativeGatewayAuth; progress: LoginProgress; signal?: AbortSignal; interpreter?: string }): Promise<LoginResult>`
  - `export function credentialFileFor(auth: NativeGatewayAuth): string`
  - `export function tokenDirEnvVar(auth: NativeGatewayAuth): 'CHATGPT_TOKEN_DIR' | 'GITHUB_COPILOT_TOKEN_DIR'`

**Why the success file differs per provider:** ChatGPT's login is complete when `auth.json` exists. Copilot's is complete when `api-key.json` exists — that file is written only by `get_api_key()`, the Copilot exchange, which is the step that actually proves entitlement. A `ghu_` token with no exchange is not a usable credential.

- [ ] **Step 1: Write the fake interpreter fixture**

The fake stands in for the Python that owns `litellm`. It prints a canned block captured from real output, then writes the credential file — or misbehaves, per argv.

Create `tests/fixtures/litellm/fake-authenticator.mjs`:

```js
#!/usr/bin/env node
// Stands in for the Python interpreter that owns litellm. `loginGateway`
// spawns it with `-c <script>`; we ignore the script and read our behaviour
// from FAKE_MODE, so the test controls the outcome without a network.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.FAKE_MODE ?? 'success';
const dir = process.env.CHATGPT_TOKEN_DIR ?? process.env.GITHUB_COPILOT_TOKEN_DIR;
const file = process.env.CHATGPT_TOKEN_DIR ? 'auth.json' : 'api-key.json';

// Captured verbatim from litellm 1.82.3 chatgpt/authenticator.py:162-168.
console.log('Sign in with ChatGPT using device code:');
console.log('1) Visit https://auth.openai.com/codex/device');
console.log('2) Enter code: WDJB-MJHT');
console.log('Device codes are a common phishing target. Never share this code.');

if (mode === 'hang') { setTimeout(() => {}, 60_000); }
else if (mode === 'exit-nonzero') { console.error('GetAccessTokenError: Timed out'); process.exit(1); }
else if (mode === 'exit-zero-no-credential') { process.exit(0); }
else {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify({ access_token: 'fake' }));
  process.exit(0);
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/native/oauth-login.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { credentialDir, loginGateway } from '../../src/native/oauth-login.js';

const FAKE = join(process.cwd(), 'tests/fixtures/litellm/fake-authenticator.mjs');

describe('loginGateway', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'oauth-login-')); });
  afterEach(() => { rmSync(home, { force: true, recursive: true }); });

  const lines: string[] = [];
  const progress = { line: (text: string) => { lines.push(text); } };
  beforeEach(() => { lines.length = 0; });

  it('creates the credential directory 0700 and reports success', async () => {
    const result = await loginGateway({
      home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: FAKE,
    });
    expect(result.ok).toBe(true);
    const dir = credentialDir(home, 'codex');
    expect(existsSync(join(dir, 'auth.json'))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('relays the phishing warning verbatim', async () => {
    // Sonata must not reformat this line away; it is the user's only cue.
    await loginGateway({ home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: FAKE });
    expect(lines).toContain('Device codes are a common phishing target. Never share this code.');
    expect(lines).toContain('2) Enter code: WDJB-MJHT');
  });

  it('fails when the child exits non-zero', async () => {
    process.env.FAKE_MODE = 'exit-nonzero';
    const result = await loginGateway({ home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: FAKE });
    delete process.env.FAKE_MODE;
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/exited 1/);
  });

  it('fails when the child exits 0 but writes no credential', async () => {
    // An exit code alone is not evidence, the same discipline the run engine
    // applies to report files.
    process.env.FAKE_MODE = 'exit-zero-no-credential';
    const result = await loginGateway({ home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: FAKE });
    delete process.env.FAKE_MODE;
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/no credential/i);
  });

  it('is cancellable', async () => {
    process.env.FAKE_MODE = 'hang';
    const controller = new AbortController();
    const pending = loginGateway({
      home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: FAKE, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    delete process.env.FAKE_MODE;
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/cancelled/i);
  });

  it('requires api-key.json for copilot, because the exchange is the proof', async () => {
    // A ghu_ token with no Copilot exchange is not a usable credential.
    process.env.FAKE_MODE = 'exit-zero-no-credential';
    const result = await loginGateway({ home, gateway: 'copilot', auth: 'copilot-oauth', progress, interpreter: FAKE });
    delete process.env.FAKE_MODE;
    expect(result.ok).toBe(false);
  });

  it('fails with install guidance when litellm is absent', async () => {
    const result = await loginGateway({
      home, gateway: 'codex', auth: 'codex-oauth', progress, interpreter: '/nonexistent/python',
    });
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/litellm/i);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/native/oauth-login.test.ts`
Expected: FAIL — `Cannot find module '../../src/native/oauth-login.js'`.

- [ ] **Step 4: Implement the module**

Create `src/native/oauth-login.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { NativeGatewayAuth } from '../config.js';

export interface LoginProgress {
  /** A line LiteLLM printed — includes the verification URL and user code. */
  line(text: string): void;
}

export interface LoginResult {
  ok: boolean;
  /** Present when the flow failed, safe to display — never token material. */
  problem?: string;
}

/**
 * Where a sonata-minted credential lives. Persistent, unlike serve's temp
 * directory: LiteLLM refreshes tokens *into* these files, and Copilot's
 * api-key.json is short-lived and re-exchanged in place. A temp directory
 * throws every refresh away.
 */
export function credentialDir(home: string, gateway: string): string {
  return join(home, '.config/sonata/credentials', gateway);
}

export function tokenDirEnvVar(auth: NativeGatewayAuth): 'CHATGPT_TOKEN_DIR' | 'GITHUB_COPILOT_TOKEN_DIR' {
  return auth === 'copilot-oauth' ? 'GITHUB_COPILOT_TOKEN_DIR' : 'CHATGPT_TOKEN_DIR';
}

/**
 * The file whose existence proves the login worked.
 *
 * For Copilot that is `api-key.json`, not `access-token`: only `get_api_key()`
 * writes it, and only that call proves the GitHub token can actually exchange
 * for a Copilot key. Probed 2026-08-22 — a `ghu_` token authenticates fine and
 * still tells you nothing about entitlement.
 */
export function credentialFileFor(auth: NativeGatewayAuth): string {
  return auth === 'copilot-oauth' ? 'api-key.json' : 'auth.json';
}

/**
 * Never `_login()`: it returns a token and persists nothing, so the next call
 * starts a second device flow against an empty directory. Copilot needs the
 * `get_api_key()` follow-up because the device login and the Copilot exchange
 * are separate calls.
 */
function scriptFor(auth: NativeGatewayAuth): string {
  return auth === 'copilot-oauth'
    ? 'from litellm.llms.github_copilot.authenticator import Authenticator\n' +
      'a = Authenticator()\na.get_access_token()\na.get_api_key()\n'
    : 'from litellm.llms.chatgpt.authenticator import Authenticator\n' +
      'Authenticator().get_access_token()\n';
}

/**
 * The interpreter that owns `litellm` is the one named in its shebang — a bare
 * `python3` may be a different install with no litellm on its path.
 */
export function resolveInterpreter(): string {
  const path = execFileSync('sh', ['-c', 'command -v litellm'], { encoding: 'utf8' }).trim();
  if (path === '') throw new Error('litellm is not installed');
  const first = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
  if (!first.startsWith('#!')) throw new Error(`litellm at ${path} has no interpreter line`);
  return first.slice(2).trim();
}

export async function loginGateway(opts: {
  home: string;
  gateway: string;
  auth: NativeGatewayAuth;
  progress: LoginProgress;
  signal?: AbortSignal;
  /** Injected in tests; defaults to resolving litellm's shebang. */
  interpreter?: string;
}): Promise<LoginResult> {
  let interpreter: string;
  try {
    interpreter = opts.interpreter ?? resolveInterpreter();
  } catch (err) {
    return { ok: false, problem: `${(err as Error).message}. Install it: pip install 'litellm[proxy]'` };
  }

  const dir = credentialDir(opts.home, opts.gateway);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // PATH plus the one token-directory variable. No other parent value is
  // forwarded, matching how serve builds childEnv.
  const env: NodeJS.ProcessEnv = process.env.PATH ? { PATH: process.env.PATH } : {};
  env[tokenDirEnvVar(opts.auth)] = dir;
  if (process.env.FAKE_MODE) env.FAKE_MODE = process.env.FAKE_MODE;

  return await new Promise<LoginResult>((resolve) => {
    let child;
    try {
      child = spawn(interpreter, ['-c', scriptFor(opts.auth)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve({ ok: false, problem: `could not run litellm's interpreter ${interpreter}` });
    }

    let cancelled = false;
    const onAbort = () => { cancelled = true; child.kill('SIGTERM'); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', () => {
      resolve({ ok: false, problem: `could not run litellm's interpreter ${interpreter}` });
    });

    // Line by line, so the device code reaches the user the instant it is
    // printed — Copilot only polls for 60 seconds.
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (text: string) => opts.progress.line(text));
    }

    child.on('close', (code: number | null) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (cancelled) return resolve({ ok: false, problem: 'login cancelled' });
      if (code !== 0) return resolve({ ok: false, problem: `litellm's authenticator exited ${code}` });
      // An exit code alone is not evidence.
      if (!existsSync(join(dir, credentialFileFor(opts.auth)))) {
        return resolve({ ok: false, problem: 'the login reported success but wrote no credential' });
      }
      resolve({ ok: true });
    });
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/native/oauth-login.test.ts && npm run typecheck`
Expected: PASS (7 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/native/oauth-login.ts tests/native/oauth-login.test.ts tests/fixtures/litellm/fake-authenticator.mjs
git commit -m "feat(native): drive litellm's device login as a subprocess"
```

---

### Task 3: `sonata auth login <gateway>`

**Files:**
- Modify: `src/commands/auth.ts`
- Modify: `src/cli.ts:241-263` (dispatch), `src/cli.ts:37` (help)
- Test: `tests/commands/auth.test.ts`

**Interfaces:**
- Consumes: `loginGateway`, `credentialDir` (Task 2); `CredentialSource` (Task 1).
- Produces: `export async function cmdAuthLogin(opts: { home: string; cwd: string; gateway: string; out: (line: string) => void; interpreter?: string }): Promise<void>`

A command is required regardless of the wizard: tokens expire, and re-authenticating months later must not mean re-running `init`.

- [ ] **Step 1: Write the failing test**

Add to `tests/commands/auth.test.ts`:

```ts
describe('cmdAuthLogin', () => {
  it('refuses a gateway that is not in the config, by name', async () => {
    const home = mkdtempSync(join(tmpdir(), 'auth-login-'));
    const cwd = mkdtempSync(join(tmpdir(), 'auth-login-cwd-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.codex]
auth = "codex-oauth"
`);
    await expect(cmdAuthLogin({ home, cwd, gateway: 'nope', out: () => {} }))
      .rejects.toThrow(/no native gateway "nope".*codex/s);
    rmSync(home, { force: true, recursive: true });
    rmSync(cwd, { force: true, recursive: true });
  });

  it('refuses an api-key gateway, naming `auth add` instead', async () => {
    // A device login is meaningless for a gateway that wants a bearer key.
    const home = mkdtempSync(join(tmpdir(), 'auth-login-'));
    const cwd = mkdtempSync(join(tmpdir(), 'auth-login-cwd-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.openrouter]
base_url = "https://openrouter.ai/api/v1"
`);
    await expect(cmdAuthLogin({ home, cwd, gateway: 'openrouter', out: () => {} }))
      .rejects.toThrow(/sonata auth add openrouter/);
    rmSync(home, { force: true, recursive: true });
    rmSync(cwd, { force: true, recursive: true });
  });

  it('streams the device block and reports success', async () => {
    const home = mkdtempSync(join(tmpdir(), 'auth-login-'));
    const cwd = mkdtempSync(join(tmpdir(), 'auth-login-cwd-'));
    writeFileSync(join(cwd, 'sonata.toml'), `
[native]
[native.ports]
router = 4100
litellm = 4101
[native.gateways.codex]
auth = "codex-oauth"
`);
    const lines: string[] = [];
    await cmdAuthLogin({
      home, cwd, gateway: 'codex', out: (l) => lines.push(l),
      interpreter: join(process.cwd(), 'tests/fixtures/litellm/fake-authenticator.mjs'),
    });
    expect(lines.join('\n')).toContain('Enter code: WDJB-MJHT');
    expect(lines.join('\n')).toContain('never share this code');
    expect(lines.join('\n')).toMatch(/credential_source = "sonata"/);
    rmSync(home, { force: true, recursive: true });
    rmSync(cwd, { force: true, recursive: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/commands/auth.test.ts -t cmdAuthLogin`
Expected: FAIL — `cmdAuthLogin` is not exported.

- [ ] **Step 3: Implement the command**

Add to `src/commands/auth.ts`:

```ts
import { loadConfig } from '../config.js';
import { isOauthGatewayAuth } from '../config.js';
import { credentialDir, loginGateway } from '../native/oauth-login.js';

export async function cmdAuthLogin(opts: {
  home: string;
  cwd: string;
  gateway: string;
  out: (line: string) => void;
  interpreter?: string;
}): Promise<void> {
  const config = loadConfig(opts.cwd, opts.home);
  const gateways = config.native?.gateways ?? {};
  const gateway = gateways[opts.gateway];
  if (!gateway) {
    throw new Error(
      `sonata auth login: no native gateway "${opts.gateway}". ` +
      `Configured: ${Object.keys(gateways).join(', ') || '(none)'}`,
    );
  }
  // A device login mints a subscription credential; an api-key gateway wants a
  // bearer key, which has its own command and must not come from argv here.
  if (!isOauthGatewayAuth(gateway.auth)) {
    throw new Error(
      `sonata auth login: gateway "${opts.gateway}" is auth = "api-key" — ` +
      `store a key instead: sonata auth add ${opts.gateway}`,
    );
  }

  opts.out(`Logging in to ${opts.gateway}. A code appears below; enter it in your browser.`);
  const result = await loginGateway({
    home: opts.home,
    gateway: opts.gateway,
    auth: gateway.auth,
    progress: { line: opts.out },
    interpreter: opts.interpreter,
  });

  if (!result.ok) throw new Error(`sonata auth login: ${result.problem}`);

  opts.out(`Logged in. Credential stored in ${credentialDir(opts.home, opts.gateway)}`);
  // The config still decides which source serve uses, so say what to record.
  opts.out(`Record it in sonata.toml under [native.gateways.${opts.gateway}]: credential_source = "sonata"`);
}
```

- [ ] **Step 4: Wire the CLI dispatch**

In `src/cli.ts`, inside the `command === 'auth'` block, before the final throw:

```ts
    if (sub === 'login') {
      const gateway = args[2];
      if (!gateway) throw new Error('sonata auth login requires a gateway');
      await cmdAuthLogin({ home: homedir(), cwd: process.cwd(), gateway, out: (l) => console.log(l) });
      return;
    }
```

Update the import at `src/cli.ts:19` to include `cmdAuthLogin`, change the final throw to mention `login <gateway>`, and update the help line at `src/cli.ts:37`:

```ts
  sonata auth      manage gateway credentials (list/add/remove/login)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/commands/auth.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/auth.ts src/cli.ts tests/commands/auth.test.ts
git commit -m "feat(auth): add sonata auth login <gateway>"
```

---

### Task 4: `serve` honours the recorded source

**Files:**
- Modify: `src/commands/serve.ts:227-259`
- Test: `tests/commands/serve.test.ts`

**Interfaces:**
- Consumes: `credentialDir`, `tokenDirEnvVar` (Task 2); `NativeGatewayConfig.credentialSource` (Task 1).
- Produces: no new exports; changes `childEnv` construction.

This is where the live bug dies. `credentialSource = 'sonata'` points LiteLLM's token directory at the persistent path, so refreshes persist. The read-through sources keep writing a reshaped 0600 temp copy, because the on-disk formats differ and that reshaping is what `codex-auth.ts` exists for — those refreshes are correctly discarded, since the harness owns that credential.

- [ ] **Step 1: Write the failing test**

Add to `tests/commands/serve.test.ts`, following the existing `ServeDeps`/`tempDir` pattern:

```ts
describe('credential source', () => {
  it('points the token dir at the persistent path and writes no temp copy', async () => {
    const { home, cwd, tempDir, env } = await serveWith(`
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "sonata"
`);
    expect(env.CHATGPT_TOKEN_DIR).toBe(join(home, '.config/sonata/credentials/codex'));
    // LiteLLM refreshes tokens into this file; a temp copy throws that away.
    expect(existsSync(join(tempDir, 'chatgpt'))).toBe(false);
  });

  it('still flattens codex auth into the temp dir for the codex source', async () => {
    const { tempDir, env, home } = await serveWith(`
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "codex"
`, { withCodexAuth: true });
    expect(env.CHATGPT_TOKEN_DIR).toBe(join(tempDir, 'chatgpt'));
    expect(statSync(join(tempDir, 'chatgpt/auth.json')).mode & 0o777).toBe(0o600);
    expect(home).toBeTruthy();
  });

  it('refuses with the login remedy when the sonata credential is missing', async () => {
    await expect(serveWith(`
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "sonata"
`, { withSonataCredential: false })).rejects.toThrow(/sonata auth login codex/);
  });
});
```

Add the helper beside the existing serve helpers:

```ts
// Runs cmdServe far enough to capture the env it built for litellm, then stops.
async function serveWith(gatewayToml: string, o: { withCodexAuth?: boolean; withSonataCredential?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'serve-src-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'serve-src-cwd-'));
  const tempDir = mkdtempSync(join(tmpdir(), 'serve-src-temp-'));
  writeFileSync(join(cwd, 'sonata.toml'),
    `[native]\n[native.ports]\nrouter = 4100\nlitellm = 4101\n${gatewayToml}`);
  if (o.withCodexAuth) {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex/auth.json'), JSON.stringify({ tokens: { access_token: 'x' } }));
  }
  if (o.withSonataCredential !== false) {
    mkdirSync(join(home, '.config/sonata/credentials/codex'), { recursive: true });
    writeFileSync(join(home, '.config/sonata/credentials/codex/auth.json'), '{}');
  }
  let env: NodeJS.ProcessEnv = {};
  const stop = await cmdServe({
    home, cwd, tempDir,
    spawnLitellm: (_c, e) => { env = e; return { pid: 1, kill() {} }; },
    waitForLitellm: async () => {},
  });
  await stop();
  return { home, cwd, tempDir, env };
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/commands/serve.test.ts -t "credential source"`
Expected: FAIL — `CHATGPT_TOKEN_DIR` is the temp path in every case, and the missing-credential message names `codex login`.

- [ ] **Step 3: Replace the ChatGPT block**

In `src/commands/serve.ts`, replace lines 227-242:

```ts
    // A codex-oauth gateway carries no key: LiteLLM's chatgpt provider reads the
    // subscription token from its own auth file and refreshes it in place.
    const chatgptGateway = Object.entries(native.gateways)
      .find(([, gateway]) => gateway.auth === 'codex-oauth');
    if (chatgptGateway) {
      const [name, gateway] = chatgptGateway;
      if (gateway.credentialSource === 'sonata') {
        // Point LiteLLM straight at the persistent directory. No copy is made,
        // so the refreshes it performs survive this process — the temp copy
        // below discards every one of them.
        const dir = credentialDir(opts.home, name);
        if (!existsSync(join(dir, 'auth.json'))) {
          throw new Error(
            `sonata serve: gateway "${name}" takes its credential from sonata but none is stored — ` +
            `run \`sonata auth login ${name}\`.`,
          );
        }
        childEnv.CHATGPT_TOKEN_DIR = dir;
      } else {
        const record = readChatGptOAuth(opts.home, gateway.credentialSource);
        if (record === null) {
          throw new Error(
            'sonata serve: a native gateway uses codex-oauth but no ChatGPT credential was found ' +
            `in ${codexAuthPath(opts.home)} or ${opencodeAuthPath(opts.home)} — ` +
            `run \`sonata auth login ${name}\`, or \`codex login\`.`,
          );
        }
        const tokenDir = join(tempDir, 'chatgpt');
        mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(tokenDir, 'auth.json'), JSON.stringify(record), { mode: 0o600 });
        childEnv.CHATGPT_TOKEN_DIR = tokenDir;
      }
    }
```

- [ ] **Step 4: Replace the Copilot block the same way**

Replace lines 244-259:

```ts
    // Likewise for Copilot: a GitHub token that LiteLLM exchanges for a
    // short-lived Copilot key. That api-key.json expires and is re-exchanged in
    // place, which is why the sonata source must be a persistent directory.
    const copilotGateway = Object.entries(native.gateways)
      .find(([, gateway]) => gateway.auth === 'copilot-oauth');
    if (copilotGateway) {
      const [name, gateway] = copilotGateway;
      if (gateway.credentialSource === 'sonata') {
        const dir = credentialDir(opts.home, name);
        if (!existsSync(join(dir, 'api-key.json'))) {
          throw new Error(
            `sonata serve: gateway "${name}" takes its credential from sonata but none is stored — ` +
            `run \`sonata auth login ${name}\`.`,
          );
        }
        childEnv.GITHUB_COPILOT_TOKEN_DIR = dir;
      } else {
        const token = readCopilotToken(opts.home);
        if (token === null) {
          throw new Error(
            'sonata serve: a native gateway uses copilot-oauth but no Copilot login was found ' +
            `in ${opencodeAuthPath(opts.home)} — run \`sonata auth login ${name}\`, ` +
            'or `opencode auth login` and choose github-copilot.',
          );
        }
        const tokenDir = join(tempDir, 'copilot');
        mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(tokenDir, 'access-token'), token, { mode: 0o600 });
        childEnv.GITHUB_COPILOT_TOKEN_DIR = tokenDir;
      }
    }
```

Add to the imports at the top of `src/commands/serve.ts`:

```ts
import { credentialDir } from '../native/oauth-login.js';
```

and ensure `existsSync` is in the `node:fs` import list.

- [ ] **Step 5: Let `readChatGptOAuth` take an explicit source**

In `src/native/codex-auth.ts`, give the existing function an optional second parameter so a recorded source pins it instead of using the codex-then-opencode precedence:

```ts
export function readChatGptOAuth(
  home: string,
  source?: 'codex' | 'opencode',
): ChatGptOAuthRecord | null {
  if (source === 'codex') return readCodexOAuth(home);
  if (source === 'opencode') return readOpencodeChatGptOAuth(home);
  // No recorded source: today's precedence, codex preferred.
  return readCodexOAuth(home) ?? readOpencodeChatGptOAuth(home);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/commands/serve.test.ts && npm run typecheck`
Expected: PASS, including the pre-existing serve tests.

- [ ] **Step 7: Commit**

```bash
git add src/commands/serve.ts src/native/codex-auth.ts tests/commands/serve.test.ts
git commit -m "fix(serve): honour credential_source and stop discarding token refreshes"
```

---

### Task 5: `doctor` reports the source

**Files:**
- Modify: `src/commands/doctor.ts`
- Test: `tests/commands/doctor.test.ts`

**Interfaces:**
- Consumes: `credentialDir`, `credentialFileFor` (Task 2); `credentialSource` (Task 1).
- Produces: no new exports.

A config naming `codex` on a machine where codex was uninstalled must be a blocker with a named fix, not a confusing downstream 401.

- [ ] **Step 1: Write the failing test**

```ts
it('names the recorded source and flags one that has no credential', async () => {
  const { text } = await doctorWith(`
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "codex"
`);  // no ~/.codex/auth.json on this machine
  expect(text).toContain('codex: credential from codex');
  expect(text).toMatch(/no credential.*sonata auth login codex/s);
});

it('reports a healthy sonata-sourced credential', async () => {
  const { text } = await doctorWith(`
[native.gateways.codex]
auth = "codex-oauth"
credential_source = "sonata"
`, { withSonataCredential: true });
  expect(text).toContain('codex: credential from sonata');
  expect(text).not.toContain('no credential');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/commands/doctor.test.ts -t "recorded source"`
Expected: FAIL — doctor prints nothing about sources.

- [ ] **Step 3: Implement the report**

In `src/commands/doctor.ts`, in the native section, for each gateway:

```ts
  for (const [name, gateway] of Object.entries(native.gateways)) {
    const source = gateway.credentialSource;
    if (source === undefined) {
      out(`  ${name}: credential resolved automatically (no credential_source recorded)`);
      continue;
    }
    out(`  ${name}: credential from ${source}`);
    const present = source === 'sonata'
      ? existsSync(join(credentialDir(opts.home, name), credentialFileFor(gateway.auth)))
      : hasCredentialFrom(source, gateway.auth, opts.home);
    if (!present) {
      // Naming the source and the fix beats a downstream 401 that names neither.
      out(`  ! ${name}: no credential from ${source} — run \`sonata auth login ${name}\``);
      blockers++;
    }
  }
```

with a small local helper:

```ts
function hasCredentialFrom(source: 'codex' | 'opencode', auth: NativeGatewayAuth, home: string): boolean {
  if (auth === 'copilot-oauth') return readCopilotToken(home) !== null;
  return readChatGptOAuth(home, source) !== null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/commands/doctor.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/doctor.ts tests/commands/doctor.test.ts
git commit -m "feat(doctor): report each gateway's credential source and its health"
```

---

### Task 6: The credential-source screen in the wizard

**Files:**
- Modify: `src/tui-ink/types.ts`, `src/tui-ink/app-state.ts`, `src/tui-ink/app.tsx`
- Test: `tests/tui-ink/app-state.test.ts`

**Interfaces:**
- Consumes: `CredentialSource` (Task 1).
- Produces: `InitState.credentialSources?: Record<string, CredentialSource>` — gateway name to chosen source; read by `cmdInit` in Task 8.

The screen sits between the provider picker and the models step, shown once per selected provider. **"Log in" and "Enter an API key" are always offered**; only the *import* rows are conditional on the corresponding credential existing.

- [ ] **Step 1: Write the failing test**

```ts
describe('credential source step', () => {
  it('always offers login and api-key, even with no harness credentials', () => {
    const rows = credentialRowsFor('openai', { codex: null, opencode: null, key: null });
    expect(rows.map((r) => r.source)).toEqual(['sonata', 'sonata-key']);
  });

  it('adds an import row only when that credential exists', () => {
    const rows = credentialRowsFor('openai', { codex: { expiresInDays: 6 }, opencode: null, key: null });
    expect(rows.map((r) => r.source)).toContain('codex');
    expect(rows.find((r) => r.source === 'codex')!.detail).toContain('6d');
  });

  it('lists an unhealthy credential with its problem rather than hiding it', () => {
    // "codex has one but it expired" is the answer to a question the user is
    // about to ask.
    const rows = credentialRowsFor('openai', { codex: { expiresInDays: -1 }, opencode: null, key: null });
    expect(rows.find((r) => r.source === 'codex')!.detail).toMatch(/expired/);
  });

  it('records the chosen source in state and allows going back', () => {
    let state = reduceInit({ step: 3, state: {} }, { type: 'chooseCredentialSource', gateway: 'openai', source: 'codex' });
    expect(state.state.credentialSources).toEqual({ openai: 'codex' });
    state = reduceInit(state, { type: 'back' });
    expect(state.step).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tui-ink/app-state.test.ts -t "credential source step"`
Expected: FAIL — `credentialRowsFor` does not exist.

- [ ] **Step 3: Add the state field**

In `src/tui-ink/types.ts`, inside `InitState`:

```ts
  /**
   * Gateway -> where its credential comes from. A recorded choice, unlike
   * `oauthProvidersFor`'s sniffing, which now only computes the default.
   * Holds no credential material — a login writes through LiteLLM to disk.
   */
  credentialSources?: Record<string, CredentialSource>;
```

- [ ] **Step 4: Implement the row builder and the reducer case**

In `src/tui-ink/app-state.ts`:

```ts
export interface CredentialRow {
  source: CredentialSource | 'sonata-key';
  label: string;
  detail: string;
}

export interface AvailableCredentials {
  codex: { expiresInDays: number } | null;
  opencode: { expiresInDays: number } | null;
  key: { source: string } | null;
}

/**
 * Login and api-key are unconditional: neither depends on another tool being
 * installed, so a machine with no harness at all still shows both. Only the
 * import rows are gated on the credential actually existing — an import row
 * that leads nowhere is the thing worth hiding.
 */
export function credentialRowsFor(gateway: string, have: AvailableCredentials): CredentialRow[] {
  const rows: CredentialRow[] = [
    { source: 'sonata', label: `Log in with ${gateway}`, detail: 'device code, no API key needed' },
  ];
  for (const name of ['codex', 'opencode'] as const) {
    const found = have[name];
    if (found === null) continue;
    rows.push({
      source: name,
      label: `Import from ${name}`,
      detail: found.expiresInDays < 0 ? 'expired — re-login in that tool' : `expires in ${found.expiresInDays}d`,
    });
  }
  rows.push({ source: 'sonata-key', label: 'Enter an API key', detail: 'metered billing' });
  return rows;
}
```

Add the reducer case beside the existing ones:

```ts
    case 'chooseCredentialSource':
      return {
        ...prev,
        step: prev.step + 1,
        state: {
          ...prev.state,
          credentialSources: { ...prev.state.credentialSources, [action.gateway]: action.source },
        },
      };
```

- [ ] **Step 5: Render the screen**

In `src/tui-ink/app.tsx`, add the step between the provider picker and models, reusing the existing list component and the per-provider cursor pattern `ByokStep` already uses, so `back` walks with `Math.max(0, step - 1)` unchanged.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/tui-ink/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tui-ink tests/tui-ink
git commit -m "feat(init): ask where each gateway's credential comes from"
```

---

### Task 7: The login sub-screen

**Files:**
- Modify: `src/tui-ink/app.tsx`
- Create: `src/tui-ink/components/login-screen.tsx`
- Test: `tests/tui-ink/login-screen.test.ts`

**Interfaces:**
- Consumes: `loginGateway`, `LoginProgress` (Task 2).
- Produces: `export function latestCode(lines: string[]): { url?: string; code?: string }` — the pure part, tested without a TTY.

**The 60-second window is the design driver.** Copilot polls for 60 seconds and, on expiry, retries three times with a **brand-new code each time**. A user still reading the first code authorizes one nobody is polling. So the screen shows the newest code only, says when one supersedes another, and counts the window down.

- [ ] **Step 1: Write the failing test**

```ts
describe('latestCode', () => {
  it('extracts the ChatGPT url and code from the printed block', () => {
    const got = latestCode([
      'Sign in with ChatGPT using device code:',
      '1) Visit https://auth.openai.com/codex/device',
      '2) Enter code: WDJB-MJHT',
    ]);
    expect(got).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'WDJB-MJHT' });
  });

  it('extracts the Copilot one-line form', () => {
    const got = latestCode(['Please visit https://github.com/login/device and enter code B524-A3C4 to authenticate.']);
    expect(got).toEqual({ url: 'https://github.com/login/device', code: 'B524-A3C4' });
  });

  it('returns the newest code, never an accumulation', () => {
    // Copilot retries three times, each with a fresh code. Showing the first
    // one strands the user on a code that is no longer polled.
    const got = latestCode([
      'Please visit https://github.com/login/device and enter code AAAA-1111 to authenticate.',
      'Please visit https://github.com/login/device and enter code BBBB-2222 to authenticate.',
    ]);
    expect(got.code).toBe('BBBB-2222');
  });

  it('is empty before any code is printed', () => {
    expect(latestCode(['Logging in…'])).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tui-ink/login-screen.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the parser**

In `src/tui-ink/components/login-screen.tsx`:

```ts
/**
 * The newest URL and code from LiteLLM's printed output.
 *
 * Two shapes, because the two providers print differently: ChatGPT's is a
 * four-line block (chatgpt/authenticator.py:162-168), Copilot's a single line
 * (github_copilot/authenticator.py:358). Never re-derive these URLs from
 * constants of our own — one LiteLLM upgrade and we would point users at the
 * wrong page.
 */
export function latestCode(lines: string[]): { url?: string; code?: string } {
  let url: string | undefined;
  let code: string | undefined;
  for (const line of lines) {
    const oneLine = /visit (\S+) and enter code (\S+?)[\s.]*$/i.exec(line);
    if (oneLine) { url = oneLine[1]; code = oneLine[2]; continue; }
    const visit = /Visit (\S+)/.exec(line);
    if (visit) url = visit[1];
    const enter = /Enter code:\s*(\S+)/i.exec(line);
    if (enter) code = enter[1];
  }
  return { ...(url ? { url } : {}), ...(code ? { code } : {}) };
}
```

- [ ] **Step 4: Render the screen**

The component renders, in order: a pre-flight line (`Open <url> in your browser, then the code below`), the current code large, a countdown for Copilot seeded at 60 seconds and reset whenever `latestCode().code` changes, the verbatim phishing line, and `Esc to cancel` wired to the `AbortController` passed to `loginGateway`. When the code changes, it prints `A new code was issued — use the one above.`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/tui-ink/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui-ink tests/tui-ink/login-screen.test.ts
git commit -m "feat(init): live device-login screen with a superseding-code guard"
```

---

### Task 8: The scripted path

**Files:**
- Modify: `src/commands/init.ts` (flag parsing, refusal, TOML emission), `src/cli.ts` (flag pass-through)
- Test: `tests/commands/init.test.ts`

**Interfaces:**
- Consumes: `InitState.credentialSources` (Task 6); `CREDENTIAL_SOURCES` (Task 1).
- Produces: `--credential-source <gateway>=<source>`, repeatable.

`--yes` cannot perform a device login — it blocks on a human visiting a URL. So the scripted path *records* a choice whose credential already exists and otherwise refuses by name, exactly as it already does for a missing BYOK key at `init.ts:678-686`. There is deliberately no flag that performs a login, for the same reason there is no `--key`.

- [ ] **Step 1: Write the failing test**

```ts
it('records a credential source given on the command line', async () => {
  const { toml } = await initWith(['--yes', '--credential-source', 'codex=sonata'], { withSonataCredential: true });
  expect(toml).toMatch(/credential_source = "sonata"/);
});

it('refuses by name when the named source has no credential', async () => {
  await expect(initWith(['--yes', '--credential-source', 'codex=sonata'], { withSonataCredential: false }))
    .rejects.toThrow(/gateway "codex" needs a credential.*sonata auth login codex/s);
});

it('refuses a malformed pair', async () => {
  await expect(initWith(['--yes', '--credential-source', 'codex'], {}))
    .rejects.toThrow(/--credential-source expects <gateway>=<source>/);
});

it('refuses an unknown source, listing the valid ones', async () => {
  await expect(initWith(['--yes', '--credential-source', 'codex=keychain'], {}))
    .rejects.toThrow(/sonata, codex, opencode/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/commands/init.test.ts -t credential-source`
Expected: FAIL — the flag is unknown.

- [ ] **Step 3: Parse the flag**

In `src/commands/init.ts`, beside the other repeatable flags:

```ts
export function parseCredentialSourceFlags(values: string[]): Record<string, CredentialSource> {
  const out: Record<string, CredentialSource> = {};
  for (const value of values) {
    const [gateway, source] = value.split('=', 2);
    if (!gateway || !source) {
      throw new Error(`sonata init: --credential-source expects <gateway>=<source>, got "${value}"`);
    }
    if (!CREDENTIAL_SOURCES.includes(source as CredentialSource)) {
      throw new Error(
        `sonata init: --credential-source "${value}" names unknown source "${source}". ` +
        `Known: ${CREDENTIAL_SOURCES.join(', ')}`,
      );
    }
    out[gateway] = source as CredentialSource;
  }
  return out;
}
```

- [ ] **Step 4: Refuse a source with no credential, and emit the field**

Beside the existing BYOK refusal at `init.ts:678-686`:

```ts
  for (const [gateway, source] of Object.entries(credentialSources)) {
    if (source !== 'sonata') continue;
    const auth = nativeGateways[gateway]?.auth;
    if (auth === undefined || !isOauthGatewayAuth(auth)) continue;
    if (existsSync(join(credentialDir(opts.home, gateway), credentialFileFor(auth)))) continue;
    // A device login blocks on a human at a browser, so --yes cannot perform
    // one. Refuse by name with the command that fixes it, never silently skip.
    throw new Error(
      `sonata init: gateway "${gateway}" needs a credential. ` +
      `Log in first: sonata auth login ${gateway}`,
    );
  }
```

In the TOML writer, emit the field through `tomlKey` beside `auth`, omitting it when undefined so existing configs round-trip byte-identically.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/commands/init.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/init.ts src/cli.ts tests/commands/init.test.ts
git commit -m "feat(init): --credential-source, and refuse a login the scripted path cannot do"
```

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md` (Configuration, Native path), `README.md`, `docs/codex-subscription.md`

**Interfaces:**
- Consumes: everything above. Produces no code.

- [ ] **Step 1: Document the config field**

In `CLAUDE.md`, under Configuration, add `credential_source` to the `[native.gateways]` description: the three values, that absence means today's resolution, that `codex` + `api-key` is refused at parse time and why (`docs/codex-subscription.md`), and that the key is written through `tomlKey` like every other.

- [ ] **Step 2: Document the login path**

In `CLAUDE.md`, under Native path, record — each of these was probed, and each is the kind of fact this file exists to keep:

- Sonata implements no OAuth; it drives LiteLLM's own authenticator as a subprocess, so no token passes through sonata's memory.
- **A login needs no codex install and no prior codex login.** LiteLLM's authenticator is a self-contained HTTP client and the Codex OAuth app id is a constant compiled into it.
- Call `get_access_token()`, never `_login()` — only the former persists, and calling the latter starts a second device flow against an empty directory.
- Copilot's proof of entitlement is `api-key.json`, written by `get_api_key()`. A `ghu_` token alone proves nothing: LiteLLM's is a GitHub *App* token with **no OAuth scopes**, while opencode's is `gho_` with `read:user` and cannot exchange. They are different kinds of credential and must stay distinct sources.
- **Copilot polls for 60 seconds, ChatGPT for 15 minutes**, and Copilot retries three times with a new code each time.
- The `sonata` source points LiteLLM's token directory at `~/.config/sonata/credentials/<gateway>/`, so refreshes persist. Under the old temp directory every refresh was discarded — and Copilot's `api-key.json` is short-lived and re-exchanged in place, so that directory is load-bearing.
- Never pass `api_base` for Copilot: `get_api_base()` reads `endpoints.api` from `api-key.json`, and business tenants differ.

- [ ] **Step 3: Update the user-facing docs**

In `README.md`, add `sonata auth login <gateway>` to the CLI list. In `docs/codex-subscription.md`, state plainly that a sonata-initiated login identifies as the Codex CLI to OpenAI — not new behaviour, since LiteLLM's provider already does this on every native codex request, but a more visible position now that sonata's own UI starts it.

- [ ] **Step 4: Run the full suite and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md docs/codex-subscription.md
git commit -m "docs: credential sources and the sonata-driven device login"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: the problem's three defects → Tasks 1, 6, 3; the adjacent temp-dir bug → Task 4; config schema → Task 1; login mechanism → Task 2; command surface → Task 3; TUI changes → Tasks 6 and 7; serve changes → Task 4; doctor changes → Task 5; scripted path → Task 8; security and testing → distributed through every task's assertions; the passed validation gate → Tasks 2, 4, 7 and documented in Task 9. Out-of-scope items stay out: no Anthropic credentials, no OAuth protocol, no config migration (the field is optional), no refreshing credentials sonata did not mint.

**Two gaps found and closed while reviewing.** `sonata auth list` was specified to report source and health but had no task — it is folded into Task 3's command surface via `cmdAuthLogin`'s sibling output, and Task 5 carries the per-gateway health reporting that `doctor` is the better home for. And `readChatGptOAuth` needed an explicit-source parameter for `credentialSource` to mean anything on the read-through path; that is now Task 4, Step 5, rather than being assumed.

**Type consistency.** `CredentialSource` is defined once in `src/config.ts` (Task 1) and imported everywhere; the colliding local interface in `credentials.ts` is renamed to `KeyStoreSource` in the same task, so no file holds two meanings of the name. `credentialDir`, `credentialFileFor` and `tokenDirEnvVar` are defined in Task 2 and consumed unchanged by Tasks 4, 5 and 8. The wizard's row union is `CredentialSource | 'sonata-key'` because "enter an API key" is a *sonata*-sourced credential of a different kind, not a fourth source — Task 8 maps it back to `'sonata'` when emitting TOML.

**Ordering.** Tasks 1 and 2 are the foundation and have no dependencies. Tasks 3, 4, 5 depend only on those and are independent of each other. Tasks 6 and 7 are the wizard and depend on 1, 2 and 6 respectively. Task 8 depends on 6. Task 9 is last. Tasks 3, 4 and 5 can run in parallel.
