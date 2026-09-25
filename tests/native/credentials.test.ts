import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  keyReport,
  resolveKeyDetail,
  resolveKeyFromSource,
  resolveKeys,
  sonataKeyStorePath,
  writeSonataKey,
} from '../../src/native/credentials.js';
import { opencodeDbPath } from '../../src/native/opencode-store.js';
import { sqliteAvailable, writeOpencodeCredDb } from '../opencode-db-fixture.js';

/** A fresh temporary home directory. */
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sonata-credentials-'));
}

describe('credential resolution', () => {
  it('prefers the sonata store over a discovered opencode key', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'sonata-key');
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
    writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ acme: { key: 'oc-key' } }));

    expect(resolveKeys(['acme'], home)).toMatchObject([
      { gateway: 'acme', source: 'sonata', key: 'sonata-key' },
    ]);
  });

  it('falls back to opencode when sonata has no key', () => {
    const home = tmp();
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
    writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ acme: { key: 'oc-key' } }));

    expect(resolveKeys(['acme'], home)).toMatchObject([
      { gateway: 'acme', source: 'opencode', key: 'oc-key' },
    ]);
  });

  it('keyReport never includes the key value', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'secret');

    const report = keyReport(['acme'], home);
    expect(report).toEqual([{ gateway: 'acme', source: 'sonata' }]);
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('reports source null for a gateway with no key anywhere', () => {
    expect(keyReport(['ghost'], tmp())).toEqual([{ gateway: 'ghost', source: null }]);
  });

  it('writeSonataKey creates a 0600 file', () => {
    const home = tmp();
    writeSonataKey(home, 'acme', 'k');

    expect(statSync(sonataKeyStorePath(home)).mode & 0o777).toBe(0o600);
  });

  it('writing a key keeps the keys already stored, readable', () => {
    // Round-trip, not just shape: a write that serializes anything other than
    // plain gateway → key strings corrupts every entry beside the new one,
    // and the next read silently finds nothing.
    const home = tmp();
    writeSonataKey(home, 'acme', 'acme-key');
    writeSonataKey(home, 'other', 'other-key');

    expect(resolveKeys(['acme', 'other'], home)).toMatchObject([
      { gateway: 'acme', source: 'sonata', key: 'acme-key' },
      { gateway: 'other', source: 'sonata', key: 'other-key' },
    ]);
  });
});

describe('gateways that share one key', () => {
  /** Writes an opencode `auth.json` holding `entries` under `home`. */
  function opencodeAuth(home: string, entries: Record<string, unknown>): void {
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
    writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify(entries));
  }

  it('resolves OpenCode Zen with the OpenCode Go key, and the reverse', () => {
    // One opencode.ai key serves both endpoints (measured: a Go key gets a
    // 200 from Zen's chat/completions), but opencode files it under whichever
    // one you logged in to. Looked up by name alone, the other gateway had no
    // key, so Zen was never offered for import and never asked for models.
    const home = tmp();
    opencodeAuth(home, { 'opencode-go': { type: 'api', key: 'oc-key' } });
    expect(resolveKeys(['opencode'], home)).toMatchObject([{ gateway: 'opencode', source: 'opencode', key: 'oc-key' }]);
    expect(resolveKeyFromSource('opencode', home, 'opencode')).toBe('oc-key');

    const other = tmp();
    writeSonataKey(other, 'opencode', 'typed-key');
    expect(resolveKeys(['opencode-go'], other)).toMatchObject([{ gateway: 'opencode-go', source: 'sonata', key: 'typed-key' }]);
  });

  it('prefers a key filed under the gateway itself, from any source, over a shared one', () => {
    const home = tmp();
    writeSonataKey(home, 'opencode-go', 'go-key');
    opencodeAuth(home, { opencode: { type: 'api', key: 'zen-key' } });
    expect(resolveKeys(['opencode'], home)).toMatchObject([{ gateway: 'opencode', source: 'opencode', key: 'zen-key' }]);
  });

  it('never copies a shared key into the sonata store', () => {
    const home = tmp();
    writeSonataKey(home, 'opencode-go', 'go-key');
    writeSonataKey(home, 'acme', 'acme-key');
    const stored = JSON.parse(readFileSync(sonataKeyStorePath(home), 'utf8'));
    expect(Object.keys(stored).sort()).toEqual(['acme', 'opencode-go']);
  });
});

describe('the opencode v2 credential table', () => {
  const skip = !sqliteAvailable();

  /** The real path sonata reads opencode's data dir at. */
  function dbPath(home: string): string {
    return opencodeDbPath(home, {});
  }

  it.skipIf(skip)('resolves a key stored only in opencode.db, naming its source', () => {
    const home = tmp();
    writeOpencodeCredDb(dbPath(home), [
      {
        id: 'r1', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'db-key' }), timeCreated: 100,
      },
    ]);

    expect(resolveKeys(['acme'], home)).toMatchObject([
      { gateway: 'acme', source: 'opencode.db', key: 'db-key' },
    ]);
  });

  it.skipIf(skip)('lets the table row win over auth.json for the same gateway', () => {
    // v1 and v2 coexist with no migration; the table row is the live one.
    const home = tmp();
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
    writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ acme: { key: 'json-key' } }));
    writeOpencodeCredDb(dbPath(home), [
      {
        id: 'r1', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'db-key' }), timeCreated: 100,
      },
    ]);

    expect(resolveKeys(['acme'], home)).toMatchObject([
      { gateway: 'acme', source: 'opencode.db', key: 'db-key' },
    ]);
  });

  it.skipIf(skip)('resolves an opencode-pinned gateway against the table', () => {
    const home = tmp();
    writeOpencodeCredDb(dbPath(home), [
      {
        id: 'r1', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'db-key' }), timeCreated: 100,
      },
    ]);

    expect(resolveKeyFromSource('acme', home, 'opencode')).toBe('db-key');
    expect(resolveKeyDetail('acme', home, 'opencode')).toEqual({ key: 'db-key', source: 'opencode.db' });
    // The sonata pin must not see the opencode store at all.
    expect(resolveKeyFromSource('acme', home, 'sonata')).toBeUndefined();
  });

  it.skipIf(skip)('keyReport names opencode.db when the table supplied the key', () => {
    const home = tmp();
    writeOpencodeCredDb(dbPath(home), [
      {
        id: 'r1', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'db-key' }), timeCreated: 100,
      },
    ]);

    expect(keyReport(['acme'], home)).toEqual([{ gateway: 'acme', source: 'opencode.db' }]);
  });
});
