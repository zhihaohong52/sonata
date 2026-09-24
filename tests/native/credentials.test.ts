import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  keyReport,
  resolveKeyFromSource,
  resolveKeys,
  sonataKeyStorePath,
  writeSonataKey,
} from '../../src/native/credentials.js';

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
