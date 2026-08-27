// tests/commands/serve-ledger.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdServe, priceRow, serveHealthUrl } from '../../src/commands/serve.js';
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

  it('prices a row shaped like a direct --model request that carries key/gateway', () => {
    // A direct `--model <key>` request never passes through tier resolution, so
    // its row carries no role/tier — only the key and gateway that commit 41a9227
    // made the router record. This is the end-to-end proof: the router's raw row
    // (key/gateway set) resolves via priceRow against real price config.
    const directRow = { ...row(), alias: 'flash', role: undefined, tier: undefined };
    expect(priceRow(CONFIG, home, directRow).price).toMatchObject({ source: 'model', totalUsd: 3 });
  });

  it('leaves a row with an unknown key unpriced rather than zero', () => {
    expect(priceRow(CONFIG, home, row({ key: 'nope' })).price).toEqual({ source: 'none' });
  });

  it('prices by the row timestamp, not by now', () => {
    // Clock pinned to a moment clearly outside the 16:30–00:30 window so the
    // assertion cannot pass coincidentally: a priceRow that wrongly priced by
    // `new Date()` would see no matching rate and return { source: 'none' }.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    try {
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
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cmdServe — ledger wiring', () => {
  let cwd: string;
  let handles: { stop(): Promise<void> }[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'sonata-serve-ledger-cwd-'));
    handles = [];
  });
  afterEach(async () => {
    await Promise.all(handles.map((handle) => handle.stop()));
    rmSync(cwd, { force: true, recursive: true });
  });

  const tempDir = () => join(cwd, 'litellm');

  async function start(recordUsage?: (row: LedgerRow) => void) {
    const handle = await cmdServe({
      cwd, home, tempDir: tempDir(),
      waitForLitellm: async () => {},
      spawnLitellm: () => ({ pid: 1, kill() {} }),
      recordUsage,
    });
    handles.push(handle);
    return handle;
  }

  const writeConfig = (litellmPort = 43123) => writeFileSync(join(cwd, 'sonata.toml'), `
[models."flash"]
gateway = "acme"
id = "deepseek-v4-flash"

[tiers.code]
simple = ["flash"]
complex = ["flash"]

[native.gateways."acme"]
base_url = "https://gateway.example/v1"

[native.ports]
router = 0
litellm = ${litellmPort}
`);

  it('the router calls the injected recordUsage seam, with an unpriced row', async () => {
    writeConfig();
    const rows: LedgerRow[] = [];
    const handle = await start((rec) => rows.push(rec));

    // Nothing listens on the litellm port, so the one candidate fails (502)
    // and the tier is exhausted (529) — plenty to force a usage observation.
    const res = await fetch(`http://localhost:${handle.routerPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonata-code-simple', messages: [] }),
    });
    expect(res.status).toBe(529);
    expect(rows).toHaveLength(1);
    // The seam receives the raw router row: priced only ever by the default
    // closure, never here — so price must be the router's `{ source: 'none' }`.
    expect(rows[0]).toMatchObject({
      alias: 'sonata-code-simple', role: 'code', tier: 'simple',
      upstream: 'litellm', status: 529, complete: false,
      price: { source: 'none' },
      attempts: [{ key: 'flash', status: 502 }],
    });
  });

  it('prunes old ledger day-files on startup', async () => {
    writeConfig();
    const usageDir = join(home, '.config', 'sonata', 'usage');
    mkdirSync(usageDir, { recursive: true });
    const oldFile = join(usageDir, '2020-01-01.jsonl');
    writeFileSync(oldFile, `${JSON.stringify(row())}\n`);

    await start();
    expect(existsSync(oldFile)).toBe(false);
  });

  it('prunes old session records on startup alongside the ledger', async () => {
    writeConfig();
    const sessionsFile = join(home, '.config', 'sonata', 'sessions.json');
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(sessionsFile, JSON.stringify({
      old: { session: 'old', cwd: '/repo/a', started: '2020-01-01T10:00:00.000Z' },
      fresh: { session: 'fresh', cwd: '/repo/b', started: new Date().toISOString() },
    }, null, 2));

    await start();
    const remaining = JSON.parse(readFileSync(sessionsFile, 'utf8'));
    expect(remaining).not.toHaveProperty('old');
    expect(remaining).toHaveProperty('fresh');
  });

  it('serves even when pruning throws', async () => {
    writeConfig();
    // A regular file where the day-file directory belongs makes pruneLedger's
    // readdirSync throw (ENOTDIR). Startup must still succeed and answer.
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'usage'), 'not a directory');

    const handle = await start();
    const health = await fetch(serveHealthUrl(handle.routerPort));
    expect(health.status).toBe(200);
  });
});
