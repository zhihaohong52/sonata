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