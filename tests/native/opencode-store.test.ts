import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  opencodeCredentialOrigin,
  opencodeDataDir,
  opencodeDbPath,
  readOpencodeCredentials,
} from '../../src/native/opencode-store.js';
import { sqliteAvailable, writeOpencodeCredDb as writeDb } from '../opencode-db-fixture.js';

const skip = !sqliteAvailable();

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'opencode-store-'));
});

function writeAuthJson(entries: Record<string, unknown>): void {
  mkdirSync(opencodeDataDir(home), { recursive: true });
  writeFileSync(join(opencodeDataDir(home), 'auth.json'), JSON.stringify(entries));
}

describe('opencodeDbPath', () => {
  it('defaults to <data dir>/opencode.db', () => {
    expect(opencodeDbPath(home, {})).toBe(join(opencodeDataDir(home), 'opencode.db'));
  });

  it('honours an absolute OPENCODE_DB', () => {
    expect(opencodeDbPath(home, { OPENCODE_DB: '/elsewhere/oc.db' })).toBe('/elsewhere/oc.db');
  });

  it('resolves a relative OPENCODE_DB under the data dir', () => {
    expect(opencodeDbPath(home, { OPENCODE_DB: 'other.db' })).toBe(join(opencodeDataDir(home), 'other.db'));
  });
});

describe('readOpencodeCredentials', () => {
  it.skipIf(skip)('reads a key stored only in the table', () => {
    writeDb(opencodeDbPath(home, {}), [
      {
        id: 'r1', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'db-key' }), timeCreated: 100,
      },
    ]);

    expect(readOpencodeCredentials(home, {})).toEqual({
      acme: { type: 'api', key: 'db-key', origin: 'opencode.db' },
    });
  });

  it('reads a key stored only in auth.json', () => {
    writeAuthJson({ acme: { type: 'api', key: 'json-key' } });

    expect(readOpencodeCredentials(home, {})).toEqual({
      acme: { type: 'api', key: 'json-key', origin: 'auth.json' },
    });
  });

  it.skipIf(skip)('lets the table win over auth.json for the same integration', () => {
    // v1 and v2 coexist with no migration; the table row is the live one.
    writeAuthJson({ acme: { type: 'api', key: 'json-key' } });
    writeDb(opencodeDbPath(home, {}), [
      {
        id: 'r1', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'db-key' }), timeCreated: 100,
      },
    ]);

    expect(readOpencodeCredentials(home, {})).toEqual({
      acme: { type: 'api', key: 'db-key', origin: 'opencode.db' },
    });
  });

  it.skipIf(skip)('keeps the newest row when one integration has several', () => {
    writeDb(opencodeDbPath(home, {}), [
      {
        id: 'old', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'old-key' }), timeCreated: 100,
      },
      {
        id: 'new', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'new-key' }), timeCreated: 200,
      },
    ]);

    expect(readOpencodeCredentials(home, {}).acme).toEqual({
      type: 'api', key: 'new-key', origin: 'opencode.db',
    });
  });

  it.skipIf(skip)('skips malformed rows instead of throwing', () => {
    writeAuthJson({ keep: { type: 'api', key: 'json-key' } });
    writeDb(opencodeDbPath(home, {}), [
      { id: 'r1', integration: 'acme', value: 'not json', timeCreated: 100 },
      { id: 'r2', integration: 'acme', value: '[]', timeCreated: 101 },
      { id: 'r3', integration: 'acme', value: JSON.stringify({ type: 'key' }), timeCreated: 102 },
      { id: 'r4', integration: 'acme', value: JSON.stringify({ type: 'oauth' }), timeCreated: 103 },
      { id: 'r5', integration: null, value: JSON.stringify({ type: 'key', key: 'x' }), timeCreated: 104 },
    ]);

    expect(readOpencodeCredentials(home, {})).toEqual({
      keep: { type: 'api', key: 'json-key', origin: 'auth.json' },
    });
  });

  it.skipIf(skip)('normalizes an oauth row, with expires in epoch milliseconds', () => {
    writeDb(opencodeDbPath(home, {}), [
      {
        id: 'r1', integration: 'openai',
        value: JSON.stringify({
          type: 'oauth', methodID: 'chatgpt-browser',
          refresh: 'rt-fake', access: 'at-fake', expires: 1787806005000,
          metadata: { any: 'thing' },
        }),
        timeCreated: 100,
      },
    ]);

    expect(readOpencodeCredentials(home, {})).toEqual({
      openai: {
        type: 'oauth', access: 'at-fake', refresh: 'rt-fake',
        expires: 1787806005000, origin: 'opencode.db',
      },
    });
  });

  it.skipIf(skip)('carries a flat accountId through, as auth.json records it', () => {
    writeDb(opencodeDbPath(home, {}), [
      {
        id: 'r1', integration: 'openai',
        value: JSON.stringify({
          type: 'oauth', access: 'at-fake', refresh: 'rt-fake',
          expires: 1787806005000, accountId: 'acct-fake',
        }),
        timeCreated: 100,
      },
    ]);

    expect(readOpencodeCredentials(home, {}).openai).toMatchObject({ accountId: 'acct-fake' });
  });

  it.skipIf(skip)('maps the table key row onto the api-key shape, not auth.json\'s type string', () => {
    // The table calls it `type: "key"`; auth.json calls it `type: "api"`.
    writeDb(opencodeDbPath(home, {}), [
      {
        id: 'r1', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'db-key', metadata: { a: 1 } }), timeCreated: 100,
      },
    ]);

    expect(readOpencodeCredentials(home, {}).acme).toMatchObject({ type: 'api', key: 'db-key' });
  });

  it('behaves unchanged when the db is missing', () => {
    writeAuthJson({ acme: { key: 'json-key' }, other: { apiKey: 'json-other' } });

    expect(readOpencodeCredentials(home, {})).toEqual({
      acme: { type: 'api', key: 'json-key', origin: 'auth.json' },
      other: { type: 'api', key: 'json-other', origin: 'auth.json' },
    });
  });

  it.skipIf(skip)('honours the OPENCODE_DB override', () => {
    const override = join(home, 'elsewhere', 'oc.db');
    mkdirSync(join(home, 'elsewhere'), { recursive: true });
    writeDb(override, [
      {
        id: 'r1', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'db-key' }), timeCreated: 100,
      },
    ]);

    expect(readOpencodeCredentials(home, { OPENCODE_DB: override }).acme).toEqual({
      type: 'api', key: 'db-key', origin: 'opencode.db',
    });
    // The default path was never written, so it stays empty.
    expect(readOpencodeCredentials(home, {})).toEqual({});
  });

  it('never throws on a file that is not a database', () => {
    mkdirSync(opencodeDataDir(home), { recursive: true });
    writeFileSync(opencodeDbPath(home, {}), 'not a database');
    expect(readOpencodeCredentials(home, {})).toEqual({});
  });

  it.skipIf(skip)('reports which store won one integration', () => {
    writeDb(opencodeDbPath(home, {}), [
      {
        id: 'r1', integration: 'acme',
        value: JSON.stringify({ type: 'key', key: 'db-key' }), timeCreated: 100,
      },
    ]);
    writeAuthJson({ other: { key: 'json-key' } });

    expect(opencodeCredentialOrigin(home, 'acme', {})).toBe('opencode.db');
    expect(opencodeCredentialOrigin(home, 'other', {})).toBe('auth.json');
    expect(opencodeCredentialOrigin(home, 'ghost', {})).toBeUndefined();
  });
});
