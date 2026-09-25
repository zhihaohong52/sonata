import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WELL_KNOWN_PROVIDER_URLS, detectOpenCode } from '../src/detect.js';
import { opencodeDbPath } from '../src/native/opencode-store.js';
import { sqliteAvailable, writeOpencodeCredDb } from './opencode-db-fixture.js';

describe('detectOpenCode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports an absent opencode without a blocking problem', async () => {
    // An empty PATH plus a home holding no `.opencode/bin` is the zero-harness
    // machine. Reporting that as an error was the one blocking problem in
    // `sonata init`'s preflight there, so the BYOK path it exists for could
    // never be reached — asserting on the severity rather than the message
    // keeps this about "does init proceed", which is the actual contract.
    vi.stubEnv('PATH', '');
    const home = mkdtempSync(join(tmpdir(), 'sonata-detect-'));

    const status = await detectOpenCode({ home, supportedVersions: '>=1.0.0' });

    expect(status.installed).toBe(false);
    expect(status.problems).toEqual([]);
  });

  it.skipIf(!sqliteAvailable())('lists providers authenticated in either store, table included', async () => {
    // v2 keeps logins in the `credential` table of opencode.db; auth.json is
    // the v1 store and the fallback. A provider holding a live login only in
    // the table was invisible here, so init never offered importing it.
    const home = mkdtempSync(join(tmpdir(), 'sonata-detect-'));
    const bin = mkdtempSync(join(tmpdir(), 'sonata-detect-bin-'));
    writeFileSync(join(bin, 'opencode'), [
      '#!/bin/sh',
      'case "$1" in',
      '--version) echo 1.18.16 ;;',
      'models) echo openrouter/fake-model ;;',
      'esac',
    ].join('\n'));
    chmodSync(join(bin, 'opencode'), 0o755);
    vi.stubEnv('PATH', bin);

    mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(
      join(home, '.local', 'share', 'opencode', 'auth.json'),
      JSON.stringify({ acme: { type: 'api', key: 'sk-fake' } }),
    );
    writeOpencodeCredDb(opencodeDbPath(home, {}), [
      {
        id: 'r1', integration: 'openrouter',
        value: JSON.stringify({ type: 'key', key: 'sk-fake' }), timeCreated: 100,
      },
    ]);

    const status = await detectOpenCode({ home, supportedVersions: '>=1.0.0 <2.0.0' });

    expect(status.installed).toBe(true);
    expect(status.authedProviders.sort()).toEqual(['acme', 'openrouter']);
  });
});

describe('OpenCode gateway URLs', () => {
  it('points Zen at opencode.ai/zen, beside Go', () => {
    // api.opencode.ai answers /models with a 200 "Not Found" text body, so a
    // Zen gateway added by hand fetched no models while Go's listed fine.
    expect(WELL_KNOWN_PROVIDER_URLS['opencode']).toBe('https://opencode.ai/zen/v1');
    expect(WELL_KNOWN_PROVIDER_URLS['opencode-go']).toBe('https://opencode.ai/zen/go/v1');
  });
});
