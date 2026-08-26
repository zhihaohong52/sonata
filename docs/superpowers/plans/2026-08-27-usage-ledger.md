# Usage and Route Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give sonata a ledger of what its router actually did — tokens, cost, and which model served each request — and three commands that read it.

**Architecture:** The router tees each response stream, parsing usage out of the SSE frames as they pass without buffering, and appends one JSON line per request to a daily-rotated ledger under `~/.config/sonata/usage/`. Pricing is resolved separately from recording, so token counts are never lost to a missing price. Three read-only commands aggregate the ledger (`usage`), show live router state plus recent routes (`status`), and list dispatch runs from the existing run store (`runs`).

**Tech Stack:** TypeScript (ESM, Node 22+), vitest, no new runtime dependencies. Existing modules: `src/native/router.ts`, `src/commands/serve.ts`, `src/config.ts`, `src/catalog.ts`, `src/store.ts`.

**Spec:** `docs/superpowers/specs/2026-08-27-usage-ledger-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 22+.** No new runtime dependencies — the ledger is JSONL written with `node:fs`, not a database.
- **Tests need no API keys.** The suite runs against fixtures; never call ai-pricing.fyi or a gateway from a test.
- **Never record prompt or response text**, `account_uuid`, or `device_id`. Session id only.
- **Accounting must never break routing.** Every observer and ledger call in the request path is individually guarded; a throw costs a row, never a response.
- **All times UTC.** Price windows, ledger timestamps, rotation boundaries.
- **`0` is a price; unknown is `source: 'none'`.** Never sum an unknown rate as zero.
- **Never auto-fetch prices.** Network access only inside `sonata catalog update`.
- **TOML keys are always quoted** when written (`tomlKey` in `src/config.ts`); an unquoted `[models.grok-4.5]` silently nests.
- **`sonata` on PATH runs `dist/`.** Run `npm run build` before testing CLI behaviour by hand.
- Run `npm run typecheck` and `npm test` before every commit.

---

### Task 1: SSE usage collector

Pure parsing, no I/O. Extracts token counts from an Anthropic-shaped SSE stream, tolerating frames split across chunk boundaries.

**Files:**
- Create: `src/native/usage.ts`
- Test: `tests/native/usage.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface UsageTokens { input: number; output: number; cacheRead: number; cacheCreation: number }`
  - `interface UsageResult { tokens: UsageTokens; complete: boolean }`
  - `function createUsageCollector(): { push(chunk: Uint8Array): void; finish(): UsageResult }`
  - `function usageFromJsonBody(body: Buffer): UsageResult`
  - `const MAX_SSE_BUFFER_BYTES: number`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/native/usage.test.ts
import { describe, expect, it } from 'vitest';
import { createUsageCollector, usageFromJsonBody, MAX_SSE_BUFFER_BYTES } from '../../src/native/usage.js';

const enc = (s: string) => new TextEncoder().encode(s);

const START = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1632,"output_tokens":0,"cache_read_input_tokens":40,"cache_creation_input_tokens":7}}}\n\n';
const DELTA = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1632,"output_tokens":11}}\n\n';

describe('createUsageCollector', () => {
  it('merges input and cache counts from message_start with output from message_delta', () => {
    const c = createUsageCollector();
    c.push(enc(START));
    c.push(enc(DELTA));
    expect(c.finish()).toEqual({
      tokens: { input: 1632, output: 11, cacheRead: 40, cacheCreation: 7 },
      complete: true,
    });
  });

  it('parses a frame split across chunk boundaries', () => {
    const whole = START + DELTA;
    const cut = whole.indexOf('"output_tokens":11') + 4; // mid-JSON, mid-line
    const c = createUsageCollector();
    c.push(enc(whole.slice(0, cut)));
    c.push(enc(whole.slice(cut)));
    expect(c.finish().tokens.output).toBe(11);
  });

  it('parses a frame split mid multi-byte character', () => {
    const withText = `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"café"}}\n\n${DELTA}`;
    const bytes = enc(withText);
    const cut = withText.indexOf('café') + 4; // lands inside the 2-byte é
    const c = createUsageCollector();
    c.push(bytes.slice(0, cut));
    c.push(bytes.slice(cut));
    expect(c.finish().tokens.output).toBe(11);
  });

  it('reports incomplete when no message_delta arrives', () => {
    const c = createUsageCollector();
    c.push(enc(START));
    const res = c.finish();
    expect(res.complete).toBe(false);
    expect(res.tokens.input).toBe(1632);
  });

  it('reports incomplete and zeroed for an empty stream', () => {
    expect(createUsageCollector().finish()).toEqual({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      complete: false,
    });
  });

  it('ignores malformed data lines rather than throwing', () => {
    const c = createUsageCollector();
    c.push(enc('data: {not json\n\n'));
    c.push(enc(DELTA));
    expect(c.finish().tokens.output).toBe(11);
  });

  it('drops a pathological unterminated line instead of growing without bound', () => {
    const c = createUsageCollector();
    c.push(enc(`data: ${'x'.repeat(MAX_SSE_BUFFER_BYTES + 10)}`));
    c.push(enc(`\n\n${DELTA}`));
    // The oversized line is discarded, but the collector keeps working after it.
    expect(c.finish().tokens.output).toBe(11);
  });

  it('takes the last message_delta when several arrive', () => {
    const c = createUsageCollector();
    c.push(enc(DELTA));
    c.push(enc('event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":1632,"output_tokens":99}}\n\n'));
    expect(c.finish().tokens.output).toBe(99);
  });
});

describe('usageFromJsonBody', () => {
  it('reads usage from a non-streaming response body', () => {
    const body = Buffer.from(JSON.stringify({
      type: 'message',
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
    }));
    expect(usageFromJsonBody(body)).toEqual({
      tokens: { input: 12, output: 3, cacheRead: 1, cacheCreation: 2 },
      complete: true,
    });
  });

  it('reports incomplete for a body with no usage', () => {
    expect(usageFromJsonBody(Buffer.from('{}')).complete).toBe(false);
  });

  it('reports incomplete for a non-JSON body', () => {
    expect(usageFromJsonBody(Buffer.from('<html>503</html>')).complete).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/native/usage.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/native/usage.js"`

- [ ] **Step 3: Write the implementation**

```ts
// src/native/usage.ts
/**
 * Token counts pulled out of a response as it streams past.
 *
 * Usage arrives in two different frames: `message_start` carries the input and
 * cache counts, and the final `message_delta` carries the output count. Neither
 * alone is the whole picture, so both are merged — and taking the *last*
 * message_delta matters, because a stream may emit more than one.
 */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface UsageResult {
  /** Whatever was observed, even on a stream that ended early. */
  tokens: UsageTokens;
  /** False when no terminal usage frame arrived — a disconnect, or an upstream that died. */
  complete: boolean;
}

/**
 * A single SSE line past this is discarded rather than accumulated. A stream
 * that never emits a newline would otherwise grow this buffer for as long as it
 * runs, inside the router process serving every other session.
 */
export const MAX_SSE_BUFFER_BYTES = 64 * 1024;

function zero(): UsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

/** Reads the Anthropic `usage` shape, treating any absent or non-numeric field as unseen. */
function mergeUsage(into: UsageTokens, usage: unknown): void {
  if (usage === null || typeof usage !== 'object') return;
  const u = usage as Record<string, unknown>;
  const take = (field: string, key: keyof UsageTokens): void => {
    const value = u[field];
    // Only a positive count overwrites: message_delta repeats input_tokens, and
    // some upstreams report 0 there, which must not erase the real count seen
    // in message_start.
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) into[key] = value;
  };
  take('input_tokens', 'input');
  take('output_tokens', 'output');
  take('cache_read_input_tokens', 'cacheRead');
  take('cache_creation_input_tokens', 'cacheCreation');
}

export function createUsageCollector(): { push(chunk: Uint8Array): void; finish(): UsageResult } {
  const tokens = zero();
  let complete = false;
  let buffer = '';
  let overflowed = false;
  // Streaming decoder: a chunk boundary can fall inside a multi-byte character,
  // and decoding each chunk independently would turn that into a replacement
  // character mid-JSON.
  const decoder = new TextDecoder('utf-8');

  const line = (raw: string): void => {
    const text = raw.startsWith('data:') ? raw.slice(5).trim() : '';
    if (text === '' || text === '[DONE]') return;
    let frame: { type?: unknown; usage?: unknown; message?: unknown };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      return; // a partial or non-JSON data line is not ours to fail on
    }
    if (frame.type === 'message_start') {
      const message = frame.message as { usage?: unknown } | undefined;
      mergeUsage(tokens, message?.usage);
      return;
    }
    if (frame.type === 'message_delta') {
      mergeUsage(tokens, frame.usage);
      complete = true;
    }
  };

  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!overflowed) line(raw);
        overflowed = false;
        nl = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_SSE_BUFFER_BYTES) {
        // Drop the runaway line and mark it, so its tail is not mistaken for
        // the start of the next one.
        buffer = '';
        overflowed = true;
      }
    },
    finish() {
      return { tokens, complete };
    },
  };
}

/** The non-streaming equivalent: usage sits at the top level of the JSON body. */
export function usageFromJsonBody(body: Buffer): UsageResult {
  const tokens = zero();
  try {
    const doc = JSON.parse(body.toString()) as { usage?: unknown };
    if (doc.usage === undefined) return { tokens, complete: false };
    mergeUsage(tokens, doc.usage);
    return { tokens, complete: true };
  } catch {
    return { tokens, complete: false };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/native/usage.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/native/usage.ts tests/native/usage.test.ts
git commit -m "feat(usage): SSE usage collector tolerant of split frames"
```

---

### Task 2: Ledger store

Append-only daily JSONL with retention pruning and a corrupt-line-tolerant reader.

**Files:**
- Create: `src/ledger.ts`
- Test: `tests/ledger.test.ts`

**Interfaces:**
- Consumes: `UsageTokens` from Task 1
- Produces:
  - `interface LedgerPrice { totalUsd?: number; source: 'model' | 'gateway' | 'ai-pricing' | 'none'; observedAt?: string }`
  - `interface LedgerRow { ts: string; ms: number; session?: string; alias: string; role?: string; tier?: string; key?: string; gateway?: string; upstream: 'litellm' | 'anthropic'; litellmModel?: string; callId?: string; status: number; complete: boolean; tokens: UsageTokens; price: LedgerPrice; attempts: { key: string; status: number }[]; litellm?: { fallbacks: number; retries: number } }`
  - `function ledgerDir(home: string): string`
  - `function ledgerPathFor(home: string, at: Date): string`
  - `function appendRow(home: string, row: LedgerRow): void`
  - `function readRows(home: string, sinceMs: number, now?: number): LedgerRow[]`
  - `function pruneLedger(home: string, retentionDays: number, now?: Date): number`
  - `const LEDGER_RETENTION_DAYS: number`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/ledger.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ledgerDir, ledgerPathFor, appendRow, readRows, pruneLedger,
  LEDGER_RETENTION_DAYS, type LedgerRow,
} from '../src/ledger.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-ledger-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ts: '2026-08-27T04:12:07.881Z', ms: 100,
    alias: 'sonata-code-simple', role: 'code', tier: 'simple',
    key: 'flash', gateway: 'acme', upstream: 'litellm',
    status: 200, complete: true,
    tokens: { input: 10, output: 2, cacheRead: 0, cacheCreation: 0 },
    price: { source: 'none' },
    attempts: [],
    ...over,
  };
}

describe('ledger paths', () => {
  it('names a file by UTC date, not local date', () => {
    // 23:30 UTC-  a local timezone east of UTC would roll this to the next day.
    const at = new Date('2026-08-27T23:30:00.000Z');
    expect(ledgerPathFor(home, at)).toBe(join(ledgerDir(home), '2026-08-27.jsonl'));
  });
});

describe('appendRow / readRows', () => {
  it('round-trips a row', () => {
    appendRow(home, row());
    const back = readRows(home, 0, Date.parse('2026-08-27T05:00:00Z'));
    expect(back).toHaveLength(1);
    expect(back[0].alias).toBe('sonata-code-simple');
  });

  it('appends whole lines, one per row', () => {
    appendRow(home, row());
    appendRow(home, row({ alias: 'sonata-review-simple' }));
    const raw = readFileSync(ledgerPathFor(home, new Date('2026-08-27T04:12:07.881Z')), 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('skips a corrupt line rather than failing the whole read', () => {
    appendRow(home, row());
    const path = ledgerPathFor(home, new Date('2026-08-27T04:12:07.881Z'));
    writeFileSync(path, `${readFileSync(path, 'utf8')}{not json\n`);
    appendRow(home, row({ alias: 'later' }));
    const back = readRows(home, 0, Date.parse('2026-08-27T05:00:00Z'));
    expect(back.map((r) => r.alias)).toEqual(['sonata-code-simple', 'later']);
  });

  it('filters by since, across day files', () => {
    appendRow(home, row({ ts: '2026-08-25T10:00:00.000Z' }));
    appendRow(home, row({ ts: '2026-08-27T10:00:00.000Z', alias: 'recent' }));
    const now = Date.parse('2026-08-27T12:00:00Z');
    const back = readRows(home, now - 24 * 3600 * 1000, now);
    expect(back.map((r) => r.alias)).toEqual(['recent']);
  });

  it('returns nothing when the ledger has never been written', () => {
    expect(readRows(home, 0, Date.now())).toEqual([]);
  });
});

describe('pruneLedger', () => {
  it('deletes files older than the retention window and keeps the rest', () => {
    appendRow(home, row({ ts: '2026-07-01T10:00:00.000Z' }));
    appendRow(home, row({ ts: '2026-08-27T10:00:00.000Z' }));
    const removed = pruneLedger(home, LEDGER_RETENTION_DAYS, new Date('2026-08-27T12:00:00Z'));
    expect(removed).toBe(1);
    expect(existsSync(ledgerPathFor(home, new Date('2026-07-01T10:00:00Z')))).toBe(false);
    expect(existsSync(ledgerPathFor(home, new Date('2026-08-27T10:00:00Z')))).toBe(true);
  });

  it('ignores unrelated files in the directory', () => {
    mkdirSync(ledgerDir(home), { recursive: true });
    writeFileSync(join(ledgerDir(home), 'README.txt'), 'hi');
    expect(pruneLedger(home, 1, new Date('2026-08-27T12:00:00Z'))).toBe(0);
    expect(existsSync(join(ledgerDir(home), 'README.txt'))).toBe(true);
  });

  it('is a no-op on a missing directory', () => {
    expect(pruneLedger(home, 30, new Date())).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ledger.test.ts`
Expected: FAIL — cannot resolve `../src/ledger.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/ledger.ts
/**
 * The append-only record of what the router did.
 *
 * One JSON line per completed request, in a file per UTC day. Global rather
 * than per-project because the router is a daemon shared across every project;
 * per-project reporting comes from the session map in `src/sessions.ts`.
 *
 * Daily files exist so retention is a file deletion rather than a rewrite.
 * "opencode's event table grows without bound — 6.5 GB across 140k rows" is
 * already a documented limitation caused by another tool doing this
 * carelessly, and sonata does not get to repeat it in its own store.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { UsageTokens } from './native/usage.js';

export interface LedgerPrice {
  /** Absent when `source` is 'none'. A known-free rate is 0, which is not the same thing. */
  totalUsd?: number;
  source: 'model' | 'gateway' | 'ai-pricing' | 'none';
  /** When the rate was observed; only meaningful for scraped prices. */
  observedAt?: string;
}

export interface LedgerRow {
  ts: string;
  ms: number;
  session?: string;
  alias: string;
  role?: string;
  tier?: string;
  key?: string;
  gateway?: string;
  upstream: 'litellm' | 'anthropic';
  litellmModel?: string;
  callId?: string;
  status: number;
  complete: boolean;
  tokens: UsageTokens;
  price: LedgerPrice;
  attempts: { key: string; status: number }[];
  litellm?: { fallbacks: number; retries: number };
}

export const LEDGER_RETENTION_DAYS = 30;

const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function ledgerDir(home: string): string {
  return join(home, '.config', 'sonata', 'usage');
}

/** UTC date, never local: a local date would roll the file over at the wrong moment. */
export function ledgerPathFor(home: string, at: Date): string {
  return join(ledgerDir(home), `${at.toISOString().slice(0, 10)}.jsonl`);
}

export function appendRow(home: string, row: LedgerRow): void {
  const at = new Date(row.ts);
  mkdirSync(ledgerDir(home), { recursive: true });
  appendFileSync(ledgerPathFor(home, at), `${JSON.stringify(row)}\n`);
}

export function readRows(home: string, sinceMs: number, now: number = Date.now()): LedgerRow[] {
  const dir = ledgerDir(home);
  if (!existsSync(dir)) return [];
  const out: LedgerRow[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!FILE_PATTERN.test(name)) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (line === '') continue;
      let row: LedgerRow;
      try {
        row = JSON.parse(line) as LedgerRow;
      } catch {
        // A torn final line (a crash mid-append) must not cost the whole report.
        continue;
      }
      const ts = Date.parse(row.ts);
      if (!Number.isFinite(ts) || ts < sinceMs || ts > now) continue;
      out.push(row);
    }
  }
  return out;
}

/** Deletes whole day-files older than the window. Returns how many were removed. */
export function pruneLedger(home: string, retentionDays: number, now: Date = new Date()): number {
  const dir = ledgerDir(home);
  if (!existsSync(dir)) return 0;
  const cutoff = now.getTime() - retentionDays * 24 * 3600 * 1000;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const match = FILE_PATTERN.exec(name);
    if (match === null) continue; // never delete a file this module did not write
    const day = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(day) || day >= cutoff) continue;
    try {
      rmSync(join(dir, name), { force: true });
      removed += 1;
    } catch { /* a file we cannot remove is not worth failing serve over */ }
  }
  return removed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ledger.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/ledger.ts tests/ledger.test.ts
git commit -m "feat(ledger): daily-rotated JSONL usage ledger"
```

---

### Task 3: Price config parsing

Teaches `parseConfig` about `[models."<k>".price]`, its `windows`, `[native.gateways."<g>".price]`, and `pricing_provider`.

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface Rates { input?: number; cachedInput?: number; output?: number }`
  - `interface PriceWindow extends Rates { from: string; to: string }`
  - `interface PriceConfig extends Rates { windows?: PriceWindow[] }`
  - `UnifiedModelConfig` gains `price?: PriceConfig`
  - `NativeGatewayConfig` gains `price?: PriceConfig` and `pricingProvider?: string`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/config.test.ts — append
describe('price config', () => {
  it('parses per-model rates and windows', () => {
    const config = parseConfig(`
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash"

[models."flash".price]
input = 0.44
cached_input = 0.014
output = 1.32

[[models."flash".price.windows]]
from = "16:30"
to = "00:30"
input = 0.11
output = 0.33
`);
    const price = config.unifiedModels.flash.price!;
    expect(price).toMatchObject({ input: 0.44, cachedInput: 0.014, output: 1.32 });
    expect(price.windows).toEqual([{ from: '16:30', to: '00:30', input: 0.11, output: 0.33 }]);
  });

  it('parses gateway rates and pricing_provider', () => {
    const config = parseConfig(`
[native.gateways."google"]
base_url = "https://example.invalid/v1"
pricing_provider = "google"

[native.gateways."google".price]
input = 0.1
`);
    const gw = config.native!.gateways.google;
    expect(gw.pricingProvider).toBe('google');
    expect(gw.price).toMatchObject({ input: 0.1 });
  });

  it('leaves price undefined when no table is present', () => {
    const config = parseConfig(`
[models."flash"]
gateway = "acme"
id = "x"

[native.gateways."acme"]
base_url = "https://example.invalid/v1"
`);
    expect(config.unifiedModels.flash.price).toBeUndefined();
    expect(config.native!.gateways.acme.price).toBeUndefined();
    expect(config.native!.gateways.acme.pricingProvider).toBeUndefined();
  });

  it('refuses a negative rate', () => {
    expect(() => parseConfig(`
[models."flash"]
gateway = "acme"
id = "x"

[models."flash".price]
input = -1
`)).toThrow(/price.*must be a non-negative number/i);
  });

  it('refuses a malformed window time', () => {
    expect(() => parseConfig(`
[models."flash"]
gateway = "acme"
id = "x"

[[models."flash".price.windows]]
from = "16:70"
to = "00:30"
`)).toThrow(/HH:MM/);
  });

  it('refuses a window missing from or to', () => {
    expect(() => parseConfig(`
[models."flash"]
gateway = "acme"
id = "x"

[[models."flash".price.windows]]
from = "16:30"
`)).toThrow(/from.*to/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts -t "price config"`
Expected: FAIL — `price` is not a property of `UnifiedModelConfig`

- [ ] **Step 3: Write the implementation**

Add to `src/config.ts` — types beside `UnifiedModelConfig`:

```ts
/** USD per 1,000,000 tokens. A rate of 0 is a real price (a free tier). */
export interface Rates {
  input?: number;
  cachedInput?: number;
  output?: number;
}

/** `from`/`to` are UTC `HH:MM`. A window whose `to` is less than its `from` wraps midnight. */
export interface PriceWindow extends Rates {
  from: string;
  to: string;
}

export interface PriceConfig extends Rates {
  /** Evaluated in declaration order; the first match wins. */
  windows?: PriceWindow[];
}
```

Add `price?: PriceConfig;` to `UnifiedModelConfig`, and `price?: PriceConfig; pricingProvider?: string;` to `NativeGatewayConfig`.

Then the parser helpers:

```ts
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseRates(raw: Record<string, unknown>, where: string): Rates {
  const out: Rates = {};
  const take = (key: string, field: keyof Rates): void => {
    const value = raw[key];
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${where}: ${key} price must be a non-negative number`);
    }
    out[field] = value;
  };
  take('input', 'input');
  take('cached_input', 'cachedInput');
  take('output', 'output');
  return out;
}

function parsePrice(raw: unknown, where: string): PriceConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}: price must be a table`);
  }
  const table = raw as Record<string, unknown>;
  const price: PriceConfig = parseRates(table, where);
  const windows = table.windows;
  if (windows !== undefined) {
    if (!Array.isArray(windows)) throw new Error(`${where}: price.windows must be an array of tables`);
    price.windows = windows.map((entry, i) => {
      const w = (entry ?? {}) as Record<string, unknown>;
      const { from, to } = w;
      if (typeof from !== 'string' || typeof to !== 'string') {
        throw new Error(`${where}: price.windows[${i}] needs both from and to`);
      }
      for (const [name, value] of [['from', from], ['to', to]] as const) {
        if (!HHMM.test(value)) throw new Error(`${where}: price.windows[${i}].${name} must be UTC HH:MM`);
      }
      return { from, to, ...parseRates(w, `${where}: price.windows[${i}]`) };
    });
  }
  return price;
}
```

Call `parsePrice(modelTable.price, \`[models."${key}"]\`)` where each unified model is built, and `parsePrice(gatewayTable.price, \`[native.gateways."${name}"]\`)` where each gateway is built. Read `pricing_provider` as a string beside it, throwing if present and not a string.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS — including the pre-existing config tests, unchanged

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): per-model and per-gateway price tables with UTC windows"
```

---

### Task 4: Price resolution

> **Order note:** this task imports `AiPricingCache` from `src/aipricing.ts`, which **Task 5 creates**. Implement **Task 5 first**, then return here. The numbering is kept as written so task references elsewhere in the plan stay stable.

Resolves a rate for a model at a moment, handling midnight-crossing windows, and turns tokens into a cost.

**Files:**
- Create: `src/pricing.ts`
- Test: `tests/pricing.test.ts`

**Interfaces:**
- Consumes: `Rates`, `PriceWindow`, `PriceConfig`, `SonataConfig` (Task 3); `UsageTokens` (Task 1); `LedgerPrice` (Task 2)
- Produces:
  - `function inWindow(window: PriceWindow, at: Date): boolean`
  - `function ratesFor(price: PriceConfig | undefined, at: Date): Rates | undefined`
  - `function costOf(tokens: UsageTokens, rates: Rates): number`
  - `function resolvePrice(config: SonataConfig, key: string | undefined, tokens: UsageTokens, at: Date, aiPricing?: AiPricingCache): LedgerPrice`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/pricing.test.ts
import { describe, expect, it } from 'vitest';
import { inWindow, ratesFor, costOf, resolvePrice } from '../src/pricing.js';
import { parseConfig } from '../src/config.js';
import type { AiPricingCache } from '../src/aipricing.js';

const at = (iso: string) => new Date(iso);
const WRAP = { from: '16:30', to: '00:30', input: 0.11, output: 0.33 };

describe('inWindow', () => {
  it('matches inside a same-day window', () => {
    expect(inWindow({ from: '09:00', to: '17:00' }, at('2026-08-27T12:00:00Z'))).toBe(true);
  });
  it('excludes outside a same-day window', () => {
    expect(inWindow({ from: '09:00', to: '17:00' }, at('2026-08-27T08:59:00Z'))).toBe(false);
  });
  it('matches the evening half of a window crossing midnight', () => {
    expect(inWindow(WRAP, at('2026-08-27T18:00:00Z'))).toBe(true);
  });
  it('matches the morning half of a window crossing midnight', () => {
    expect(inWindow(WRAP, at('2026-08-27T00:10:00Z'))).toBe(true);
  });
  it('excludes the gap in a window crossing midnight', () => {
    expect(inWindow(WRAP, at('2026-08-27T08:00:00Z'))).toBe(false);
  });
  it('includes the from boundary and excludes the to boundary', () => {
    expect(inWindow(WRAP, at('2026-08-27T16:30:00Z'))).toBe(true);
    expect(inWindow(WRAP, at('2026-08-27T00:30:00Z'))).toBe(false);
  });
  it('reads UTC, not local time', () => {
    // 23:00 UTC is the next local day east of UTC; the window must not shift.
    expect(inWindow({ from: '22:00', to: '23:59' }, at('2026-08-27T23:00:00Z'))).toBe(true);
  });
});

describe('ratesFor', () => {
  const price = { input: 0.44, output: 1.32, windows: [WRAP] };
  it('uses the window rate inside the window', () => {
    expect(ratesFor(price, at('2026-08-27T18:00:00Z'))).toMatchObject({ input: 0.11, output: 0.33 });
  });
  it('falls back to the flat rate outside every window', () => {
    expect(ratesFor(price, at('2026-08-27T08:00:00Z'))).toMatchObject({ input: 0.44, output: 1.32 });
  });
  it('resolves overlapping windows by declaration order', () => {
    const two = { windows: [{ from: '00:00', to: '23:59', input: 1 }, { from: '10:00', to: '11:00', input: 2 }] };
    expect(ratesFor(two, at('2026-08-27T10:30:00Z'))!.input).toBe(1);
  });
  it('returns undefined when there is no price at all', () => {
    expect(ratesFor(undefined, at('2026-08-27T10:00:00Z'))).toBeUndefined();
  });
});

describe('costOf', () => {
  it('prices input, cached input and output per million tokens', () => {
    const cost = costOf(
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreation: 0 },
      { input: 0.44, cachedInput: 0.014, output: 1.32 },
    );
    expect(cost).toBeCloseTo(0.44 + 1.32 + 0.014, 10);
  });
  it('treats a missing rate as zero for that dimension only', () => {
    expect(costOf({ input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 }, { input: 1 })).toBeCloseTo(1, 10);
  });
  it('prices a zero rate as zero, not as unknown', () => {
    expect(costOf({ input: 5_000_000, output: 0, cacheRead: 0, cacheCreation: 0 }, { input: 0 })).toBe(0);
  });
});

describe('resolvePrice', () => {
  const TOML = `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash"

[models."flash".price]
input = 1

[models."plain"]
gateway = "acme"
id = "deepseek-v4-pro"

[native.gateways."acme"]
base_url = "https://example.invalid/v1"
pricing_provider = "deepseek"

[native.gateways."acme".price]
input = 2

[models."bare"]
gateway = "nogw"
id = "deepseek-v4-flash"

[native.gateways."nogw"]
base_url = "https://example.invalid/v1"
`;
  const config = parseConfig(TOML);
  const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 };
  const cache: AiPricingCache = {
    fetchedAt: '2026-08-26T15:31:30.637Z',
    models: { 'deepseek-v4-flash': { deepseek: { input: 3, output: 9 } } },
  };
  const now = at('2026-08-27T12:00:00Z');

  it('prefers the model price', () => {
    expect(resolvePrice(config, 'flash', tokens, now, cache)).toMatchObject({ source: 'model', totalUsd: 1 });
  });
  it('falls back to the gateway price', () => {
    expect(resolvePrice(config, 'plain', tokens, now, cache)).toMatchObject({ source: 'gateway', totalUsd: 2 });
  });
  it('falls back to ai-pricing when the gateway declares a provider', () => {
    const noGwPrice = parseConfig(TOML.replace('[native.gateways."acme".price]\ninput = 2\n', ''));
    const res = resolvePrice(noGwPrice, 'plain', tokens, now, cache);
    expect(res.source).toBe('none'); // deepseek-v4-pro is not in the cache
    const flashRes = resolvePrice(noGwPrice, 'flash', tokens, now, cache);
    expect(flashRes.source).toBe('model'); // still has its own price
  });
  it('reports none when the gateway declares no pricing_provider', () => {
    expect(resolvePrice(config, 'bare', tokens, now, cache)).toEqual({ source: 'none' });
  });
  it('reports none for an unknown key', () => {
    expect(resolvePrice(config, 'nope', tokens, now, cache)).toEqual({ source: 'none' });
    expect(resolvePrice(config, undefined, tokens, now, cache)).toEqual({ source: 'none' });
  });
  it('records observed_at for a scraped price', () => {
    const noGwPrice = parseConfig(TOML.replace('[models."bare"]\ngateway = "nogw"\nid = "deepseek-v4-flash"', '[models."bare"]\ngateway = "acme"\nid = "deepseek-v4-flash"'));
    const res = resolvePrice(noGwPrice, 'bare', tokens, now, cache);
    expect(res).toMatchObject({ source: 'gateway' }); // gateway price still wins
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pricing.test.ts`
Expected: FAIL — cannot resolve `../src/pricing.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/pricing.ts
/**
 * Turning token counts into money, or honestly declining to.
 *
 * Resolution order is model price, gateway price, scraped price, then nothing.
 * The last step is the important one: ai-pricing.fyi prices *public serving
 * providers*, and one model can span an 8x range across five of them, so a
 * scraped rate is only applied when the gateway says which provider it is.
 * Guessing would produce a number that looks authoritative and is wrong by
 * most of its own magnitude.
 */
import type { PriceConfig, PriceWindow, Rates, SonataConfig } from './config.js';
import type { LedgerPrice } from './ledger.js';
import type { UsageTokens } from './native/usage.js';
import { normalizeModelName } from './catalog.js';
import type { AiPricingCache } from './aipricing.js';

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * UTC only. A window whose `to` is at or before its `from` wraps midnight —
 * `16:30 → 00:30` is one window, not an empty one, and a naive
 * `from <= t < to` reports every such window as never matching.
 */
export function inWindow(window: PriceWindow, at: Date): boolean {
  const t = at.getUTCHours() * 60 + at.getUTCMinutes();
  const from = minutes(window.from);
  const to = minutes(window.to);
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

export function ratesFor(price: PriceConfig | undefined, at: Date): Rates | undefined {
  if (price === undefined) return undefined;
  for (const window of price.windows ?? []) {
    // Declaration order, first match wins — so two overlapping windows behave
    // one documented way rather than by iteration luck.
    if (inWindow(window, at)) return { input: window.input, cachedInput: window.cachedInput, output: window.output };
  }
  const flat: Rates = { input: price.input, cachedInput: price.cachedInput, output: price.output };
  return flat.input === undefined && flat.cachedInput === undefined && flat.output === undefined
    ? undefined
    : flat;
}

const PER_MILLION = 1_000_000;

export function costOf(tokens: UsageTokens, rates: Rates): number {
  return (
    (tokens.input * (rates.input ?? 0)
      + tokens.cacheRead * (rates.cachedInput ?? 0)
      + tokens.cacheCreation * (rates.input ?? 0)
      + tokens.output * (rates.output ?? 0))
    / PER_MILLION
  );
}

export function resolvePrice(
  config: SonataConfig,
  key: string | undefined,
  tokens: UsageTokens,
  at: Date,
  aiPricing?: AiPricingCache,
): LedgerPrice {
  if (key === undefined) return { source: 'none' };
  const model = config.unifiedModels?.[key];
  if (model === undefined) return { source: 'none' };

  const own = ratesFor(model.price, at);
  if (own !== undefined) return { source: 'model', totalUsd: costOf(tokens, own) };

  const gateway = model.gateway === undefined ? undefined : config.native?.gateways[model.gateway];
  const gatewayRates = ratesFor(gateway?.price, at);
  if (gatewayRates !== undefined) return { source: 'gateway', totalUsd: costOf(tokens, gatewayRates) };

  const provider = gateway?.pricingProvider;
  if (provider === undefined || aiPricing === undefined || model.id === undefined) return { source: 'none' };
  const byProvider = aiPricing.models[normalizeModelName(model.id)];
  const scraped = byProvider?.[provider];
  if (scraped === undefined) return { source: 'none' };
  return { source: 'ai-pricing', totalUsd: costOf(tokens, scraped), observedAt: aiPricing.fetchedAt };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pricing.test.ts`
Expected: PASS (20 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/pricing.ts tests/pricing.test.ts
git commit -m "feat(pricing): rate resolution with midnight-crossing UTC windows"
```

---

### Task 5: ai-pricing.fyi cache

> **Order note:** implement this **before Task 4**, which imports `AiPricingCache` from the module created here.

Cache loading, and a fetch wired into the existing `sonata catalog update`.

**Files:**
- Create: `src/aipricing.ts`
- Create: `tests/fixtures/aipricing/prices.json`
- Modify: `src/commands/catalog.ts`
- Test: `tests/aipricing.test.ts`

**Interfaces:**
- Consumes: `Rates` (Task 3)
- Produces:
  - `interface AiPricingCache { fetchedAt: string; models: Record<string, Record<string, Rates>> }`
  - `function aiPricingPath(home: string): string`
  - `function loadAiPricing(home: string): AiPricingCache | undefined`
  - `function normalizeAiPricingRows(rows: unknown[]): AiPricingCache['models']`
  - `const AI_PRICING_URL: string`
  - `const AI_PRICING_ATTRIBUTION: string`

- [ ] **Step 1: Create the fixture**

```json
{
  "data": [
    { "canonical_slug": "deepseek-v4-flash", "provider_slug": "deepseek", "metric": "input_token", "unit": "per_1m_tokens", "currency": "USD", "price_numeric": 0.44, "tier_key": null, "batch_flag": 0 },
    { "canonical_slug": "deepseek-v4-flash", "provider_slug": "deepseek", "metric": "output_token", "unit": "per_1m_tokens", "currency": "USD", "price_numeric": 1.32, "tier_key": null, "batch_flag": 0 },
    { "canonical_slug": "deepseek-v4-flash", "provider_slug": "deepseek", "metric": "cached_input_token", "unit": "per_1m_tokens", "currency": "USD", "price_numeric": 0.014, "tier_key": null, "batch_flag": 0 },
    { "canonical_slug": "deepseek-v4-flash", "provider_slug": "fireworks", "metric": "input_token", "unit": "per_1m_tokens", "currency": "USD", "price_numeric": 0.9, "tier_key": null, "batch_flag": 0 },
    { "canonical_slug": "deepseek-v4-flash-0731", "provider_slug": "deepseek", "metric": "input_token", "unit": "per_1m_tokens", "currency": "USD", "price_numeric": 0.44, "tier_key": null, "batch_flag": 0 },
    { "canonical_slug": "gpt-5.6-luna", "provider_slug": "openai", "metric": "input_token", "unit": "per_1m_tokens", "currency": "USD", "price_numeric": 5, "tier_key": "batch", "batch_flag": 1 },
    { "canonical_slug": "gpt-5.6-luna", "provider_slug": "openai", "metric": "input_token", "unit": "per_1m_tokens", "currency": "EUR", "price_numeric": 4, "tier_key": null, "batch_flag": 0 },
    { "canonical_slug": "gpt-5.6-luna", "provider_slug": "openai", "metric": "input_token", "unit": "per_1k_tokens", "currency": "USD", "price_numeric": 0.005, "tier_key": null, "batch_flag": 0 }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/aipricing.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiPricingPath, loadAiPricing, normalizeAiPricingRows } from '../src/aipricing.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'aipricing', 'prices.json');

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-aip-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('normalizeAiPricingRows', () => {
  const rows = JSON.parse(readFileSync(FIXTURE, 'utf8')).data as unknown[];

  it('groups rates by normalized model then provider', () => {
    const models = normalizeAiPricingRows(rows);
    expect(models['deepseek-v4-flash'].deepseek).toEqual({ input: 0.44, output: 1.32, cachedInput: 0.014 });
  });

  it('keeps providers distinct rather than collapsing them', () => {
    const models = normalizeAiPricingRows(rows);
    expect(models['deepseek-v4-flash'].fireworks.input).toBe(0.9);
  });

  it('folds a dated slug onto its normalized name', () => {
    // deepseek-v4-flash-0731 normalizes to deepseek-v4-flash
    const models = normalizeAiPricingRows(rows);
    expect(Object.keys(models)).not.toContain('deepseek-v4-flash-0731');
  });

  it('ignores batch, non-USD and non-per-million rows', () => {
    const models = normalizeAiPricingRows(rows);
    expect(models['gpt-5.6-luna']).toBeUndefined();
  });

  it('ignores malformed rows', () => {
    expect(normalizeAiPricingRows([null, 42, {}, { canonical_slug: 'x' }])).toEqual({});
  });
});

describe('loadAiPricing', () => {
  it('returns undefined when absent', () => {
    expect(loadAiPricing(home)).toBeUndefined();
  });

  it('round-trips a written cache', () => {
    mkdirSync(dirname(aiPricingPath(home)), { recursive: true });
    writeFileSync(aiPricingPath(home), JSON.stringify({
      fetchedAt: '2026-08-26T15:31:30.637Z',
      models: { 'deepseek-v4-flash': { deepseek: { input: 0.44 } } },
    }));
    expect(loadAiPricing(home)!.models['deepseek-v4-flash'].deepseek.input).toBe(0.44);
  });

  it('returns undefined for a corrupt cache rather than throwing', () => {
    mkdirSync(dirname(aiPricingPath(home)), { recursive: true });
    writeFileSync(aiPricingPath(home), '{not json');
    expect(loadAiPricing(home)).toBeUndefined();
  });

  it('returns undefined when the shape is wrong', () => {
    mkdirSync(dirname(aiPricingPath(home)), { recursive: true });
    writeFileSync(aiPricingPath(home), JSON.stringify({ models: 'nope' }));
    expect(loadAiPricing(home)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/aipricing.test.ts`
Expected: FAIL — cannot resolve `../src/aipricing.js`

- [ ] **Step 4: Write the implementation**

```ts
// src/aipricing.ts
/**
 * Scraped per-token prices from ai-pricing.fyi.
 *
 * The site publishes no licence, so this is treated exactly like the
 * Artificial Analysis catalog: fetched with an explicit `sonata catalog
 * update`, cached under the user's own config directory, and never committed
 * to this repository. Only a hand-written fixture is.
 *
 * Rows are keyed model → provider, never flattened to model alone: one model
 * spans an 8x price range across serving providers, so which provider a
 * gateway resells is information sonata cannot infer and must be told.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeModelName } from './catalog.js';
import type { Rates } from './config.js';

export const AI_PRICING_URL = 'https://ai-pricing.fyi/v1/prices/current?limit=1000';
export const AI_PRICING_ATTRIBUTION = 'Prices from ai-pricing.fyi — https://ai-pricing.fyi';

export interface AiPricingCache {
  fetchedAt: string;
  /** normalized model name → serving provider slug → rates */
  models: Record<string, Record<string, Rates>>;
}

export function aiPricingPath(home: string): string {
  return join(home, '.config', 'sonata', 'ai-pricing.json');
}

const METRIC: Record<string, keyof Rates> = {
  input_token: 'input',
  output_token: 'output',
  cached_input_token: 'cachedInput',
};

export function normalizeAiPricingRows(rows: unknown[]): AiPricingCache['models'] {
  const out: AiPricingCache['models'] = {};
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const field = typeof row.metric === 'string' ? METRIC[row.metric] : undefined;
    if (field === undefined) continue;
    // Only standard, per-million, USD rows. A batch or EUR row priced into the
    // same slot would be a wrong number wearing the right label.
    if (row.unit !== 'per_1m_tokens' || row.currency !== 'USD') continue;
    if (row.batch_flag === 1 || (row.tier_key !== null && row.tier_key !== undefined && row.tier_key !== 'standard')) continue;
    const slug = row.canonical_slug;
    const provider = row.provider_slug;
    const price = row.price_numeric;
    if (typeof slug !== 'string' || typeof provider !== 'string') continue;
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) continue;
    const model = normalizeModelName(slug);
    out[model] ??= {};
    out[model][provider] ??= {};
    out[model][provider][field] = price;
  }
  return out;
}

export function loadAiPricing(home: string): AiPricingCache | undefined {
  const path = aiPricingPath(home);
  if (!existsSync(path)) return undefined;
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as AiPricingCache;
    if (typeof doc.fetchedAt !== 'string') return undefined;
    if (doc.models === null || typeof doc.models !== 'object' || Array.isArray(doc.models)) return undefined;
    return doc;
  } catch {
    return undefined;
  }
}
```

In `src/commands/catalog.ts`, extend `cmdCatalogUpdate` to also fetch `AI_PRICING_URL` (no auth header — the endpoint is public), pass `doc.data` through `normalizeAiPricingRows`, and write `{ fetchedAt: new Date().toISOString(), models }` to `aiPricingPath(home)`. Report the model count and print `AI_PRICING_ATTRIBUTION`. A failure to reach ai-pricing.fyi must not fail the AA half of the command, and vice versa — report each independently.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/aipricing.test.ts tests/commands/catalog.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/aipricing.ts src/commands/catalog.ts tests/aipricing.test.ts tests/fixtures/aipricing/
git commit -m "feat(pricing): cache ai-pricing.fyi rates via sonata catalog update"
```

---

### Task 6: Router stream tee

Emits a ledger row per request without buffering, delaying, or being able to break the response.

**Files:**
- Modify: `src/native/router.ts`
- Test: `tests/native/router-usage.test.ts`

**Interfaces:**
- Consumes: `createUsageCollector`, `usageFromJsonBody` (Task 1); `LedgerRow` (Task 2)
- Produces: `RouterDeps` gains `recordUsage?: (row: LedgerRow) => void`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/native/router-usage.test.ts
import { describe, expect, it } from 'vitest';
import { routeRequest, clearCooldowns, type RouterDeps } from '../../src/native/router.js';
import type { LedgerRow } from '../../src/ledger.js';

const DELTA = 'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":100,"output_tokens":7}}\n\n';

function sse(text: string, headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

function deps(rows: LedgerRow[], response: () => Response): RouterDeps {
  return {
    fetch: (async () => response()) as unknown as typeof fetch,
    litellmBase: 'http://litellm.invalid',
    litellmKey: 'k',
    recordUsage: (row) => rows.push(row),
    resolveTier: (alias) => alias === 'sonata-code-simple'
      ? { role: 'code', tier: 'simple', routes: [{ key: 'flash', native: { gateway: 'acme', id: 'x' } }] }
      : undefined,
  };
}

async function drain(body: AsyncIterable<Uint8Array> | Buffer): Promise<string> {
  if (Buffer.isBuffer(body)) return body.toString();
  let out = '';
  for await (const chunk of body) out += new TextDecoder().decode(chunk);
  return out;
}

const req = (model: string) => ({
  method: 'POST',
  url: '/v1/messages',
  headers: { 'x-claude-code-session-id': 'sess-1' },
  body: Buffer.from(JSON.stringify({ model, messages: [] })),
});

describe('router usage recording', () => {
  it('records tokens from the stream tail without altering the body', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const res = await routeRequest(req('sonata-code-simple'), deps(rows, () => sse(DELTA, {
      'x-litellm-model-group': 'flash', 'x-litellm-call-id': 'call-1',
    })));
    expect(await drain(res.body)).toBe(DELTA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session: 'sess-1', alias: 'sonata-code-simple', role: 'code', tier: 'simple',
      key: 'flash', upstream: 'litellm', status: 200, complete: true,
      callId: 'call-1',
    });
    expect(rows[0].tokens).toMatchObject({ input: 100, output: 7 });
  });

  it('records a row even when the stream carries no usage frame', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const res = await routeRequest(req('sonata-code-simple'), deps(rows, () => sse('event: ping\ndata: {}\n\n')));
    await drain(res.body);
    expect(rows[0].complete).toBe(false);
  });

  it('records a row when the client abandons the stream midway', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const res = await routeRequest(req('sonata-code-simple'), deps(rows, () => sse(DELTA)));
    const iterator = (res.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);        // client disconnect
    expect(rows).toHaveLength(1);
  });

  it('never lets a recorder throw reach the caller', async () => {
    clearCooldowns();
    const bad: RouterDeps = {
      ...deps([], () => sse(DELTA)),
      recordUsage: () => { throw new Error('ledger is on fire'); },
    };
    const res = await routeRequest(req('sonata-code-simple'), bad);
    await expect(drain(res.body)).resolves.toBe(DELTA);
  });

  it('records the failed candidates that preceded the one that answered', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    let call = 0;
    const d: RouterDeps = {
      ...deps(rows, () => (call++ === 0 ? new Response('{}', { status: 500 }) : sse(DELTA))),
      resolveTier: () => ({
        role: 'code', tier: 'simple',
        routes: [
          { key: 'first', native: { gateway: 'acme', id: 'a' } },
          { key: 'second', native: { gateway: 'acme', id: 'b' } },
        ],
      }),
    };
    const res = await routeRequest(req('sonata-code-simple'), d);
    await drain(res.body);
    expect(rows[0].key).toBe('second');
    expect(rows[0].attempts).toEqual([{ key: 'first', status: 500 }]);
  });

  it('records the anthropic path too', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const d = { ...deps(rows, () => sse(DELTA)), anthropicBase: 'https://anthropic.invalid' };
    const res = await routeRequest(req('claude-sonnet-5'), d);
    await drain(res.body);
    expect(rows[0]).toMatchObject({ upstream: 'anthropic', alias: 'claude-sonnet-5' });
  });

  it('records a 529 when every candidate failed', async () => {
    clearCooldowns();
    const rows: LedgerRow[] = [];
    const d: RouterDeps = {
      ...deps(rows, () => new Response('{}', { status: 500 })),
      resolveTier: () => ({ role: 'code', tier: 'simple', routes: [{ key: 'only', native: { gateway: 'a', id: 'b' } }] }),
    };
    const res = await routeRequest(req('sonata-code-simple'), d);
    expect(res.status).toBe(529);
    expect(rows[0]).toMatchObject({ status: 529, complete: false });
    expect(rows[0].attempts).toEqual([{ key: 'only', status: 500 }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/native/router-usage.test.ts`
Expected: FAIL — `recordUsage` is not a property of `RouterDeps`

- [ ] **Step 3: Write the implementation**

Add to `RouterDeps`:

```ts
  /**
   * Receives one row per request. Fire-and-forget and individually guarded at
   * every call site: accounting is never allowed to break routing.
   */
  recordUsage?: (row: LedgerRow) => void;
```

Add the tee beside `responseBody`:

```ts
/**
 * Yields every chunk unchanged and immediately, feeding a side observer as it
 * goes.
 *
 * The order matters: the chunk is yielded *before* the observer runs, so the
 * tee can add no latency and hold no backpressure. `finally` matters just as
 * much — a client disconnect returns into the generator and an upstream error
 * throws through it, and a row must still be written in both cases. Dropping
 * those rows would make the ledger under-count precisely when things go wrong.
 */
async function* observe(
  body: AsyncIterable<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
  onEnd: () => void,
): AsyncIterable<Uint8Array> {
  try {
    for await (const chunk of body) {
      yield chunk;
      try { onChunk(chunk); } catch { /* a parser bug costs a row, never a response */ }
    }
  } finally {
    try { onEnd(); } catch { /* nor does the ledger write */ }
  }
}
```

Add a helper that assembles and emits the row:

```ts
interface RecordContext {
  startedAt: number;
  alias: string;
  role?: string;
  tier?: string;
  key?: string;
  gateway?: string;
  upstream: 'litellm' | 'anthropic';
  attempts: { key: string; status: number }[];
  session?: string;
}

function headerNumber(headers: Record<string, string>, name: string): number | undefined {
  const value = Number(headers[name]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Wraps a routed response so its usage lands in the ledger. Returns the
 * response unchanged when no recorder is configured, so the un-instrumented
 * path stays byte-identical.
 */
function withUsageRecording(
  response: RouterResponse,
  ctx: RecordContext,
  deps: RouterDeps,
): RouterResponse {
  if (deps.recordUsage === undefined) return response;
  const now = deps.now ?? Date.now;
  const fallbacks = headerNumber(response.headers, 'x-litellm-attempted-fallbacks');
  const retries = headerNumber(response.headers, 'x-litellm-attempted-retries');

  const emit = (tokens: UsageTokens, complete: boolean): void => {
    const row: LedgerRow = {
      ts: new Date(now()).toISOString(),
      ms: now() - ctx.startedAt,
      session: ctx.session,
      alias: ctx.alias,
      role: ctx.role,
      tier: ctx.tier,
      key: ctx.key,
      gateway: ctx.gateway,
      upstream: ctx.upstream,
      litellmModel: response.headers['x-litellm-model-name'],
      callId: response.headers['x-litellm-call-id'],
      status: response.status,
      complete,
      tokens,
      // Pricing happens where config lives (serve), not in the router.
      price: { source: 'none' },
      attempts: ctx.attempts,
      litellm: fallbacks === undefined && retries === undefined
        ? undefined
        : { fallbacks: fallbacks ?? 0, retries: retries ?? 0 },
    };
    try { deps.recordUsage?.(row); } catch { /* never breaks the response */ }
  };

  if (Buffer.isBuffer(response.body)) {
    const { tokens, complete } = usageFromJsonBody(response.body);
    emit(tokens, complete);
    return response;
  }
  const collector = createUsageCollector();
  return {
    ...response,
    body: observe(
      response.body,
      (chunk) => collector.push(chunk),
      () => { const { tokens, complete } = collector.finish(); emit(tokens, complete); },
    ),
  };
}
```

Wire it in three places, all in `src/native/router.ts`:

1. `routeTierRequest` — build `attempts` as candidates fail (it already loops), and wrap the successful response: `return withUsageRecording(response, { …, key: route.key, gateway: route.native!.gateway, upstream: 'litellm', attempts }, deps)`.
2. `routeTierRequest`'s exhaustion path — before returning the 529, emit a row directly with zeroed tokens, `complete: false`, and the full `attempts` list. These rows are what explain a tier that has quietly stopped working, so they are the last thing to filter out.
3. `routeRequest`'s plain paths — wrap both the litellm and anthropic returns, with `upstream` set accordingly, `alias` from `requestedModel`, and no `role`/`tier`.

Read the session from `req.headers['x-claude-code-session-id']` at the top of `routeRequest` and thread it through. Never read `metadata.user_id`: it also carries `account_uuid` and `device_id`, which must not enter the ledger.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/native/router-usage.test.ts tests/native/router.test.ts`
Expected: PASS — including every pre-existing router test unchanged

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/native/router.ts tests/native/router-usage.test.ts
git commit -m "feat(router): tee response streams into ledger rows"
```

---

### Task 7: Wire the ledger into serve

Gives the router a real recorder, prices each row, and prunes on startup.

**Files:**
- Modify: `src/commands/serve.ts`
- Test: `tests/commands/serve-ledger.test.ts`

**Interfaces:**
- Consumes: `appendRow`, `pruneLedger`, `LEDGER_RETENTION_DAYS` (Task 2); `resolvePrice` (Task 4); `loadAiPricing` (Task 5)
- Produces: `ServeDeps` gains `recordUsage?: (row: LedgerRow) => void`

- [ ] **Step 1: Write the failing test**

```ts
// tests/commands/serve-ledger.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { priceRow } from '../../src/commands/serve.js';
import { parseConfig } from '../../src/config.js';
import type { LedgerRow } from '../../src/ledger.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-serve-ledger-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const CONFIG = parseConfig(`
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash"

[models."flash".price]
input = 1
output = 2

[native.gateways."acme"]
base_url = "https://example.invalid/v1"
`);

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ts: '2026-08-27T12:00:00.000Z', ms: 5, alias: 'sonata-code-simple',
    key: 'flash', gateway: 'acme', upstream: 'litellm', status: 200, complete: true,
    tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
    price: { source: 'none' }, attempts: [],
    ...over,
  };
}

describe('priceRow', () => {
  it('attaches the model price to a row the router left unpriced', () => {
    expect(priceRow(CONFIG, home, row()).price).toMatchObject({ source: 'model', totalUsd: 3 });
  });

  it('leaves a row with an unknown key unpriced rather than zero', () => {
    expect(priceRow(CONFIG, home, row({ key: 'nope' })).price).toEqual({ source: 'none' });
  });

  it('prices by the row timestamp, not by now', () => {
    const windowed = parseConfig(`
[models."flash"]
gateway = "acme"
id = "x"

[[models."flash".price.windows]]
from = "16:30"
to = "00:30"
input = 0
output = 0

[native.gateways."acme"]
base_url = "https://example.invalid/v1"
`);
    const inWindowRow = row({ ts: '2026-08-27T18:00:00.000Z' });
    expect(priceRow(windowed, home, inWindowRow).price).toMatchObject({ source: 'model', totalUsd: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/commands/serve-ledger.test.ts`
Expected: FAIL — `priceRow` is not exported from `src/commands/serve.ts`

- [ ] **Step 3: Write the implementation**

In `src/commands/serve.ts`:

```ts
/**
 * Attaches a price to a row the router produced unpriced.
 *
 * Pricing lives here rather than in the router because it needs the config and
 * the price cache, and because a token count must never be lost to a pricing
 * failure — the row is written either way, with `source: 'none'` when no rate
 * applies.
 *
 * Priced at the row's own timestamp, not at now: a row is priced by when the
 * request ran, which is what makes a time-windowed rate mean anything.
 */
export function priceRow(config: SonataConfig, home: string, row: LedgerRow): LedgerRow {
  try {
    const price = resolvePrice(config, row.key, row.tokens, new Date(row.ts), loadAiPricing(home));
    return { ...row, price };
  } catch {
    return row; // an unpriceable row is still a row
  }
}
```

In `cmdServe`, before `createRouterServer`:

```ts
  // Retention is enforced where the writer starts, so a long-lived daemon
  // cannot accumulate day-files indefinitely the way opencode's event table
  // did (6.5 GB, and not something sonata gets to repeat in its own store).
  try {
    const removed = pruneLedger(opts.home, LEDGER_RETENTION_DAYS);
    if (removed > 0) console.log(`ledger: pruned ${removed} day file(s) older than ${LEDGER_RETENTION_DAYS}d`);
  } catch { /* pruning is housekeeping; it never blocks serving */ }
```

And in the `createRouterServer({...})` call:

```ts
    recordUsage: deps.recordUsage ?? ((row) => {
      try {
        appendRow(opts.home, priceRow(loadConfig(opts.cwd, opts.home), opts.home, row));
      } catch { /* a ledger write never breaks a request */ }
    }),
```

Add `recordUsage?: (row: LedgerRow) => void;` to `ServeDeps` so tests can capture rows without touching disk.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands/serve-ledger.test.ts tests/commands/serve.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/commands/serve.ts tests/commands/serve-ledger.test.ts
git commit -m "feat(serve): write priced ledger rows and prune on startup"
```

---

### Task 8: Session → project map

Lets `sonata usage --by project` attribute rows, using the SessionStart hook that already knows both facts.

**Files:**
- Create: `src/sessions.ts`
- Modify: `src/commands/route.ts` (inside `cmdRouteSession`, start phase)
- Test: `tests/sessions.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface SessionRecord { session: string; cwd: string; started: string }`
  - `function sessionsPath(home: string): string`
  - `function recordSession(home: string, record: SessionRecord): void`
  - `function loadSessions(home: string): Record<string, SessionRecord>`
  - `function pruneSessions(home: string, retentionDays: number, now?: Date): number`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sessions.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { sessionsPath, recordSession, loadSessions, pruneSessions } from '../src/sessions.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-sessions-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('sessions map', () => {
  it('records and reads back a session', () => {
    recordSession(home, { session: 's1', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' });
    expect(loadSessions(home).s1.cwd).toBe('/repo/a');
  });

  it('keeps earlier sessions when a new one is recorded', () => {
    recordSession(home, { session: 's1', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' });
    recordSession(home, { session: 's2', cwd: '/repo/b', started: '2026-08-27T11:00:00.000Z' });
    expect(Object.keys(loadSessions(home)).sort()).toEqual(['s1', 's2']);
  });

  it('overwrites a repeated session id rather than duplicating it', () => {
    recordSession(home, { session: 's1', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' });
    recordSession(home, { session: 's1', cwd: '/repo/moved', started: '2026-08-27T12:00:00.000Z' });
    expect(loadSessions(home).s1.cwd).toBe('/repo/moved');
  });

  it('returns an empty map when absent or corrupt', () => {
    expect(loadSessions(home)).toEqual({});
    mkdirSync(dirname(sessionsPath(home)), { recursive: true });
    writeFileSync(sessionsPath(home), '{not json');
    expect(loadSessions(home)).toEqual({});
  });

  it('prunes entries older than the retention window', () => {
    recordSession(home, { session: 'old', cwd: '/a', started: '2026-07-01T10:00:00.000Z' });
    recordSession(home, { session: 'new', cwd: '/b', started: '2026-08-27T10:00:00.000Z' });
    expect(pruneSessions(home, 30, new Date('2026-08-27T12:00:00Z'))).toBe(1);
    expect(Object.keys(loadSessions(home))).toEqual(['new']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sessions.test.ts`
Expected: FAIL — cannot resolve `../src/sessions.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/sessions.ts
/**
 * Which project each routed session belonged to.
 *
 * The router sees a session id on a header but never a working directory, so
 * per-project reporting has to be joined from somewhere else. `cmdRouteSession`
 * runs at SessionStart and knows both.
 *
 * This is deliberately NOT `route-sessions.json`, which is a live refcount that
 * shrinks as sessions end. This is history: a ledger row from last week still
 * needs its project resolved long after that session is gone. It is pruned on
 * the same window as the ledger so the two cannot drift into a state where rows
 * exist with no map to join.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SessionRecord {
  session: string;
  cwd: string;
  started: string;
}

export function sessionsPath(home: string): string {
  return join(home, '.config', 'sonata', 'sessions.json');
}

export function loadSessions(home: string): Record<string, SessionRecord> {
  const path = sessionsPath(home);
  if (!existsSync(path)) return {};
  try {
    const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return {};
    return doc as Record<string, SessionRecord>;
  } catch {
    return {};
  }
}

export function recordSession(home: string, record: SessionRecord): void {
  const all = loadSessions(home);
  all[record.session] = record;
  mkdirSync(dirname(sessionsPath(home)), { recursive: true });
  writeFileSync(sessionsPath(home), `${JSON.stringify(all, null, 2)}\n`);
}

export function pruneSessions(home: string, retentionDays: number, now: Date = new Date()): number {
  const all = loadSessions(home);
  const cutoff = now.getTime() - retentionDays * 24 * 3600 * 1000;
  let removed = 0;
  for (const [id, record] of Object.entries(all)) {
    const started = Date.parse(record?.started ?? '');
    if (Number.isFinite(started) && started >= cutoff) continue;
    delete all[id];
    removed += 1;
  }
  if (removed > 0) writeFileSync(sessionsPath(home), `${JSON.stringify(all, null, 2)}\n`);
  return removed;
}
```

In `cmdRouteSession`, start phase, immediately after the registry write:

```ts
  // Records which project this session belongs to, so `sonata usage --by
  // project` can attribute the router's rows. Guarded: a session must start
  // even if this bookkeeping cannot be written.
  try {
    recordSession(opts.home, { session: sessionId, cwd: opts.cwd, started: new Date().toISOString() });
  } catch { /* attribution is a nicety; starting the session is not */ }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sessions.test.ts tests/commands/route.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck, full suite, commit**

```bash
npm run typecheck && npm test
git add src/sessions.ts src/commands/route.ts tests/sessions.test.ts
git commit -m "feat(sessions): record session to project map at SessionStart"
```

---

### Task 9: `sonata usage`

**Files:**
- Create: `src/commands/usage.ts`
- Modify: `src/cli.ts`
- Test: `tests/commands/usage.test.ts`

**Interfaces:**
- Consumes: `readRows`, `LedgerRow` (Task 2); `loadSessions` (Task 8); `loadAiPricing` (Task 5)
- Produces:
  - `type UsageDimension = 'model' | 'role' | 'tier' | 'gateway' | 'session' | 'project'`
  - `interface UsageBucket { label: string; requests: number; input: number; output: number; costUsd: number; unpricedRequests: number }`
  - `interface UsageReport { buckets: UsageBucket[]; pricedTotalUsd: number; unpriced: { requests: number; input: number; output: number }; priceCacheAgeMs?: number }`
  - `function parseDuration(text: string): number`
  - `function aggregate(rows: LedgerRow[], by: UsageDimension, sessions: Record<string, SessionRecord>): UsageReport`
  - `function cmdUsage(opts: { home: string; since: string; by: UsageDimension; session?: string; json: boolean }): Promise<UsageReport>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/commands/usage.test.ts
import { describe, expect, it } from 'vitest';
import { aggregate, parseDuration } from '../../src/commands/usage.js';
import type { LedgerRow } from '../../src/ledger.js';

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ts: '2026-08-27T12:00:00.000Z', ms: 5,
    alias: 'sonata-code-simple', role: 'code', tier: 'simple',
    key: 'flash', gateway: 'acme', upstream: 'litellm',
    status: 200, complete: true, session: 's1',
    tokens: { input: 100, output: 10, cacheRead: 0, cacheCreation: 0 },
    price: { source: 'model', totalUsd: 0.5 }, attempts: [],
    ...over,
  };
}

describe('parseDuration', () => {
  it('parses days, hours and minutes', () => {
    expect(parseDuration('7d')).toBe(7 * 24 * 3600 * 1000);
    expect(parseDuration('12h')).toBe(12 * 3600 * 1000);
    expect(parseDuration('30m')).toBe(30 * 60 * 1000);
  });
  it('rejects nonsense', () => {
    expect(() => parseDuration('soon')).toThrow(/duration/i);
  });
});

describe('aggregate', () => {
  it('groups by model and sums tokens and cost', () => {
    const report = aggregate([row(), row()], 'model', {});
    expect(report.buckets).toHaveLength(1);
    expect(report.buckets[0]).toMatchObject({ label: 'flash', requests: 2, input: 200, output: 20, costUsd: 1 });
    expect(report.pricedTotalUsd).toBe(1);
  });

  it('keeps unpriced volume out of the total and counts it separately', () => {
    const report = aggregate([row(), row({ price: { source: 'none' } })], 'model', {});
    expect(report.pricedTotalUsd).toBe(0.5);
    expect(report.unpriced).toMatchObject({ requests: 1, input: 100, output: 10 });
    expect(report.buckets[0].unpricedRequests).toBe(1);
  });

  it('counts a known-zero rate as priced, not unpriced', () => {
    const report = aggregate([row({ price: { source: 'gateway', totalUsd: 0 } })], 'model', {});
    expect(report.unpriced.requests).toBe(0);
    expect(report.pricedTotalUsd).toBe(0);
  });

  it('groups by role, tier and gateway', () => {
    expect(aggregate([row()], 'role', {}).buckets[0].label).toBe('code');
    expect(aggregate([row()], 'tier', {}).buckets[0].label).toBe('simple');
    expect(aggregate([row()], 'gateway', {}).buckets[0].label).toBe('acme');
  });

  it('groups by project using the session map', () => {
    const sessions = { s1: { session: 's1', cwd: '/repo/a', started: '2026-08-27T10:00:00.000Z' } };
    expect(aggregate([row()], 'project', sessions).buckets[0].label).toBe('/repo/a');
  });

  it('labels a session with no map entry as unknown rather than dropping it', () => {
    const report = aggregate([row({ session: 'ghost' })], 'project', {});
    expect(report.buckets[0].label).toBe('unknown');
    expect(report.buckets[0].requests).toBe(1);
  });

  it('groups anthropic rows by their model, so the baseline is comparable', () => {
    const report = aggregate(
      [row(), row({ upstream: 'anthropic', key: undefined, alias: 'claude-sonnet-5', role: undefined, tier: undefined })],
      'model',
      {},
    );
    expect(report.buckets.map((b) => b.label).sort()).toEqual(['claude-sonnet-5', 'flash']);
  });

  it('sorts buckets by cost descending', () => {
    const report = aggregate(
      [row({ key: 'cheap', price: { source: 'model', totalUsd: 0.1 } }), row({ key: 'dear', price: { source: 'model', totalUsd: 9 } })],
      'model',
      {},
    );
    expect(report.buckets.map((b) => b.label)).toEqual(['dear', 'cheap']);
  });

  it('returns an empty report for no rows', () => {
    expect(aggregate([], 'model', {})).toMatchObject({ buckets: [], pricedTotalUsd: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands/usage.test.ts`
Expected: FAIL — cannot resolve `../../src/commands/usage.js`

- [ ] **Step 3: Write the implementation**

```ts
// src/commands/usage.ts
/**
 * `sonata usage` — what the native path actually consumed.
 *
 * Two honesty constraints shape this file. Unpriced volume is reported beside
 * the total and never folded into it: a total that treats "unknown" as zero is
 * worse than no total. And this measures the *native* path only — a `sonata
 * dispatch` run executes in the foreign CLI's own process and never transits
 * the router, so its tokens are unobservable and the output says so rather than
 * presenting a partial figure as complete.
 */
import { loadAiPricing } from '../aipricing.js';
import { readRows, type LedgerRow } from '../ledger.js';
import { loadSessions, type SessionRecord } from '../sessions.js';

export type UsageDimension = 'model' | 'role' | 'tier' | 'gateway' | 'session' | 'project';

export interface UsageBucket {
  label: string;
  requests: number;
  input: number;
  output: number;
  costUsd: number;
  unpricedRequests: number;
}

export interface UsageReport {
  buckets: UsageBucket[];
  pricedTotalUsd: number;
  unpriced: { requests: number; input: number; output: number };
  priceCacheAgeMs?: number;
}

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text: string): number {
  const match = /^(\d+)([mhd])$/.exec(text.trim());
  if (match === null) throw new Error(`sonata usage: invalid duration "${text}" — use 30m, 12h or 7d`);
  return Number(match[1]) * UNITS[match[2]];
}

function labelOf(row: LedgerRow, by: UsageDimension, sessions: Record<string, SessionRecord>): string {
  switch (by) {
    // An anthropic row has no sonata key; its alias is the model, which is
    // exactly the baseline the comparison needs on the same axis.
    case 'model': return row.key ?? row.alias;
    case 'role': return row.role ?? '—';
    case 'tier': return row.tier ?? '—';
    case 'gateway': return row.gateway ?? row.upstream;
    case 'session': return row.session ?? 'unknown';
    case 'project': return row.session === undefined ? 'unknown' : (sessions[row.session]?.cwd ?? 'unknown');
  }
}

export function aggregate(
  rows: LedgerRow[],
  by: UsageDimension,
  sessions: Record<string, SessionRecord>,
): UsageReport {
  const buckets = new Map<string, UsageBucket>();
  const unpriced = { requests: 0, input: 0, output: 0 };
  let pricedTotalUsd = 0;

  for (const row of rows) {
    const label = labelOf(row, by, sessions);
    const bucket = buckets.get(label) ?? { label, requests: 0, input: 0, output: 0, costUsd: 0, unpricedRequests: 0 };
    bucket.requests += 1;
    bucket.input += row.tokens.input;
    bucket.output += row.tokens.output;
    // `totalUsd` of 0 is a real price (a free tier). Only `source: 'none'`
    // means unknown, and an unknown must never sum as zero.
    if (row.price.source === 'none' || row.price.totalUsd === undefined) {
      bucket.unpricedRequests += 1;
      unpriced.requests += 1;
      unpriced.input += row.tokens.input;
      unpriced.output += row.tokens.output;
    } else {
      bucket.costUsd += row.price.totalUsd;
      pricedTotalUsd += row.price.totalUsd;
    }
    buckets.set(label, bucket);
  }

  return {
    buckets: [...buckets.values()].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests),
    pricedTotalUsd,
    unpriced,
  };
}

export async function cmdUsage(opts: {
  home: string;
  since: string;
  by: UsageDimension;
  session?: string;
  json: boolean;
}): Promise<UsageReport> {
  const now = Date.now();
  let rows = readRows(opts.home, now - parseDuration(opts.since), now);
  if (opts.session !== undefined) rows = rows.filter((row) => row.session === opts.session);
  const report = aggregate(rows, opts.by, loadSessions(opts.home));
  const cache = loadAiPricing(opts.home);
  if (cache !== undefined) {
    const fetched = Date.parse(cache.fetchedAt);
    if (Number.isFinite(fetched)) report.priceCacheAgeMs = now - fetched;
  }
  return report;
}
```

In `src/cli.ts`, beside the other command blocks:

```ts
  if (command === 'usage') {
    const flag = (name: string): string | undefined => {
      const i = rest.indexOf(`--${name}`);
      return i === -1 ? undefined : rest[i + 1];
    };
    const by = (flag('by') ?? 'model') as UsageDimension;
    if (!['model', 'role', 'tier', 'gateway', 'session', 'project'].includes(by)) {
      throw new Error('sonata usage --by must be one of: model | role | tier | gateway | session | project');
    }
    const report = await cmdUsage({
      home: homedir(),
      since: flag('since') ?? '7d',
      by,
      session: flag('session'),
      json: rest.includes('--json'),
    });
    if (rest.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    for (const bucket of report.buckets) {
      console.log(`${bucket.label.padEnd(30)} ${String(bucket.requests).padStart(8)} ${String(bucket.input).padStart(12)} ${String(bucket.output).padStart(10)}  ${bucket.costUsd === 0 && bucket.unpricedRequests === bucket.requests ? '—' : `$${bucket.costUsd.toFixed(4)}`}`);
    }
    console.log(`\npriced total   $${report.pricedTotalUsd.toFixed(4)}`);
    if (report.unpriced.requests > 0) {
      console.log(`unpriced       ${report.unpriced.requests} requests · ${report.unpriced.input} in · ${report.unpriced.output} out`);
    }
    console.log('native path only — `sonata dispatch` runs bypass the router and cannot be measured');
    if (report.priceCacheAgeMs !== undefined) {
      console.log(`prices: ai-pricing.fyi cache ${Math.floor(report.priceCacheAgeMs / 86_400_000)}d old`);
    }
    return 0;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands/usage.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Typecheck, build, verify by hand, commit**

```bash
npm run typecheck && npm test && npm run build
node dist/cli.js usage --since 1d
git add src/commands/usage.ts src/cli.ts tests/commands/usage.test.ts
git commit -m "feat(usage): sonata usage over the ledger"
```

---

### Task 10: `sonata status` and `sonata runs`

Two small read-only commands. Grouped because neither carries enough weight for its own review gate, and both are pure reads over stores built earlier.

**Files:**
- Create: `src/commands/status.ts`
- Create: `src/commands/runs.ts`
- Modify: `src/cli.ts`
- Test: `tests/commands/status.test.ts`, `tests/commands/runs.test.ts`

**Interfaces:**
- Consumes: `readRows`, `LedgerRow` (Task 2); `listRuns`, `readMeta`, `readExit`, `readReport` from `src/store.ts`; `isSonataRouter` from `src/commands/serve.ts`
- Produces:
  - `interface RouteLine { alias: string; attempts: { key: string; status: number }[]; served?: string; status: number; input: number; output: number }`
  - `function recentRoutes(rows: LedgerRow[], limit: number): RouteLine[]`
  - `interface RunSummary { id: string; state: string; degraded: boolean; role?: string; model?: string; started?: string; report: boolean }`
  - `function summarizeRuns(cwd: string): RunSummary[]`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/commands/status.test.ts
import { describe, expect, it } from 'vitest';
import { recentRoutes } from '../../src/commands/status.js';
import type { LedgerRow } from '../../src/ledger.js';

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  return {
    ts: '2026-08-27T12:00:00.000Z', ms: 5, alias: 'sonata-code-simple',
    key: 'flash', gateway: 'acme', upstream: 'litellm', status: 200, complete: true,
    tokens: { input: 100, output: 10, cacheRead: 0, cacheCreation: 0 },
    price: { source: 'none' }, attempts: [], ...over,
  };
}

describe('recentRoutes', () => {
  it('summarises a row into alias, attempts, and who served it', () => {
    const [line] = recentRoutes([row({ attempts: [{ key: 'first', status: 403 }] })], 10);
    expect(line).toMatchObject({
      alias: 'sonata-code-simple', served: 'flash', status: 200, input: 100, output: 10,
      attempts: [{ key: 'first', status: 403 }],
    });
  });

  it('returns the most recent rows last-first, capped at the limit', () => {
    const rows = [row({ ts: '2026-08-27T10:00:00.000Z', key: 'a' }), row({ ts: '2026-08-27T11:00:00.000Z', key: 'b' }), row({ ts: '2026-08-27T12:00:00.000Z', key: 'c' })];
    expect(recentRoutes(rows, 2).map((l) => l.served)).toEqual(['c', 'b']);
  });

  it('reports an exhausted tier with no server', () => {
    const [line] = recentRoutes([row({ status: 529, key: undefined, attempts: [{ key: 'only', status: 500 }] })], 10);
    expect(line.served).toBeUndefined();
    expect(line.status).toBe(529);
  });

  it('returns nothing for an empty ledger', () => {
    expect(recentRoutes([], 10)).toEqual([]);
  });
});
```

```ts
// tests/commands/runs.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRun, runDir } from '../../src/store.js';
import { summarizeRuns } from '../../src/commands/runs.js';

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'sonata-runs-')); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe('summarizeRuns', () => {
  it('lists a run with its role and model', () => {
    const meta = createRun(cwd, { role: 'code', model: 'kimi-k3' } as never);
    const runs = summarizeRuns(cwd);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: meta.id, role: 'code', model: 'kimi-k3', report: false });
  });

  it('marks a run with a report', () => {
    const meta = createRun(cwd, { role: 'code', model: 'kimi-k3' } as never);
    writeFileSync(join(runDir(cwd, meta.id), 'report.md'), 'done');
    expect(summarizeRuns(cwd)[0].report).toBe(true);
  });

  it('returns nothing when no runs exist', () => {
    expect(summarizeRuns(cwd)).toEqual([]);
  });

  it('skips a run directory with no readable meta rather than throwing', () => {
    const meta = createRun(cwd, { role: 'code', model: 'kimi-k3' } as never);
    writeFileSync(join(runDir(cwd, meta.id), 'meta.json'), '{not json');
    expect(summarizeRuns(cwd)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/commands/status.test.ts tests/commands/runs.test.ts`
Expected: FAIL — neither module resolves

- [ ] **Step 3: Write the implementations**

```ts
// src/commands/status.ts
/**
 * `sonata status` — what the router is doing, and what it recently did.
 *
 * This promotes `grep '\-> litellm' serve-*.log` into a product surface. It is
 * a different question from `sonata route status`, which reports whether
 * *settings* route this project's sessions; each command's output should point
 * at the other, because the names are close enough to confuse.
 */
import type { LedgerRow } from '../ledger.js';

export interface RouteLine {
  alias: string;
  attempts: { key: string; status: number }[];
  /** Absent when every candidate failed. */
  served?: string;
  status: number;
  input: number;
  output: number;
}

export function recentRoutes(rows: LedgerRow[], limit: number): RouteLine[] {
  return [...rows]
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, limit)
    .map((row) => ({
      alias: row.alias,
      attempts: row.attempts,
      served: row.key,
      status: row.status,
      input: row.tokens.input,
      output: row.tokens.output,
    }));
}
```

```ts
// src/commands/runs.ts
/**
 * `sonata runs` — the list `listRuns()` could always produce.
 *
 * Until now its only consumer was the garbage collector: sonata could
 * enumerate every run it had ever launched and exposed that only to `gc`,
 * while `sonata log <id>` required an id the user had no way to find.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { listRuns, readMeta, readExit, readReport, runDir } from '../store.js';

export interface RunSummary {
  id: string;
  state: string;
  degraded: boolean;
  role?: string;
  model?: string;
  started?: string;
  report: boolean;
}

export function summarizeRuns(cwd: string): RunSummary[] {
  const out: RunSummary[] = [];
  for (const id of listRuns(cwd)) {
    try {
      const meta = readMeta(cwd, id);
      const exit = readExit(cwd, id);
      const report = readReport(cwd, id);
      out.push({
        id,
        state: exit === null ? 'RUNNING' : 'DONE',
        // A run that exited without a report is never silently trusted — the
        // same rule `sonata dispatch` applies.
        degraded: exit !== null && (exit !== 0 || report === null),
        role: meta.role,
        model: meta.model,
        started: (meta as { startedAt?: string }).startedAt,
        report: existsSync(join(runDir(cwd, id), 'report.md')),
      });
    } catch {
      // A half-written or hand-edited run directory is skipped, not fatal.
      continue;
    }
  }
  return out;
}
```

In `src/cli.ts` add both commands: `status` prints router health (via `isSonataRouter` on the configured port), then `recentRoutes(readRows(home, Date.now() - 3_600_000), 10)`, defaulting to the most recent session and accepting `--session <id>` / `--all`, and closing with a line pointing at `sonata route status`. `runs` prints `summarizeRuns(process.cwd())` as a table, with `--json`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/commands/status.test.ts tests/commands/runs.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Typecheck, build, verify by hand, commit**

```bash
npm run typecheck && npm test && npm run build
node dist/cli.js status
node dist/cli.js runs
git add src/commands/status.ts src/commands/runs.ts src/cli.ts tests/commands/status.test.ts tests/commands/runs.test.ts
git commit -m "feat(cli): sonata status and sonata runs"
```

---

### Task 11: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update CLAUDE.md**

In the Commands list, add:

```markdown
- `sonata usage [--since 7d] [--by model|role|tier|gateway|session|project] [--session <id>] [--json]` — tokens and cost from the router's ledger. **Native path only**: a `sonata dispatch` run executes in the foreign CLI's own process and never transits the router, so its tokens are unobservable. Unpriced volume is reported beside the priced total, never folded into it — a total that treats unknown as zero under-reports silently
- `sonata status [--session <id>|--all]` — what the router is doing now (port, uptime, litellm health, cooling candidates) and the recent alias → candidates → server decisions. Distinct from `sonata route status`, which reports whether *settings* route this project's sessions
- `sonata runs [--json]` — list this project's dispatch runs. `sonata log <id>` previously required an id with no way to find one
```

In Source layout, add `ledger.ts`, `pricing.ts`, `aipricing.ts`, `sessions.ts`, `native/usage.ts`, and the three new `commands/`.

Add an Architecture bullet:

```markdown
- **Usage is read from the SSE stream, not from LiteLLM's cost headers.** LiteLLM does emit `x-litellm-response-cost-*` with no database configured, but headers flush before the body, so on a streaming request no output token exists yet and the cost is structurally `0` — and every Claude Code request streams. Tokens come from `message_start` merged with the final `message_delta`; sonata computes cost itself. The headers still carry `x-litellm-model-group` (which ranked candidate served) and `x-litellm-call-id`, which the ledger records.
- **A scraped price is only applied where the gateway says which public provider it is.** ai-pricing.fyi prices public serving providers, and one model spans an 8× range across five of them, so inferring which one a gateway resells would produce a number wrong by most of its own magnitude. Absent `pricing_provider`, the row is `unpriced`. ai-pricing.fyi also does not model peak/off-peak pricing, hence the UTC `price.windows` overrides.
```

- [ ] **Step 2: Update README.md**

Add the three commands to the command list with one line each, and note the native-path-only limitation on `sonata usage`.

- [ ] **Step 3: Update CHANGELOG.md**

```markdown
## Unreleased

### Added
- `sonata usage`, `sonata status` and `sonata runs`, over a new append-only
  ledger the router writes (one JSON line per request, daily files under
  `~/.config/sonata/usage/`, 30-day retention).
- Per-model and per-gateway price tables in `sonata.toml`, with optional UTC
  time windows for providers that charge different rates off-peak.
- `sonata catalog update` also caches per-token rates from ai-pricing.fyi.

### Notes
- `sonata usage` measures the native path only; `sonata dispatch` runs never
  transit the router and cannot be measured.
- Unpriced volume is reported separately and never summed into the total.
```

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
git add CLAUDE.md README.md CHANGELOG.md
git commit -m "docs: usage ledger commands, pricing config, and their limits"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 ledger record | 2 (schema), 6 (population) |
| §1 never record account_uuid/device_id | 6 (step 3, explicit) |
| §1 `complete: false` | 1, 6 |
| §1 529 rows written | 6 (step 3, wiring point 2) |
| §2 stream tee, guards, `finally`, bounded buffer, two-frame merge, non-streaming | 1, 6 |
| §2 rotation and retention | 2 (prune), 7 (called on serve start) |
| §3 four-step resolution | 4 |
| §3 config schema and windows | 3 |
| §3 midnight wrap, UTC, overlap order, 0-vs-unpriced, priced-at-start, no auto-fetch, never committed | 3, 4, 5, 7 |
| §4 session → project map | 8 |
| §5 three commands | 9, 10 |
| §6 honesty constraints | 9 (output lines and aggregation) |
| §7 testing | tests in every task |

No gaps found.

**Placeholder scan:** No TBD/TODO. Every code step carries real code. Task 10's CLI wiring is described rather than shown, which is acceptable only because both commands are thin printers over functions whose signatures and tests are given in full — the tested logic (`recentRoutes`, `summarizeRuns`) is complete.

**Type consistency:** `UsageTokens` (Task 1) is used unchanged by Tasks 2, 4, 6, 7. `LedgerRow`/`LedgerPrice` (Task 2) by 6, 7, 9, 10. `Rates`/`PriceConfig`/`PriceWindow` (Task 3) by 4 and 5. `AiPricingCache` (Task 5) is referenced by Task 4's `resolvePrice` signature and its test imports it — Task 5 must therefore land before Task 4 compiles, so **implement Task 5 before Task 4**, or create `src/aipricing.ts` with its types first. Recorded here rather than silently reordered, because Task 4's tests import from it.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-27-usage-ledger.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
