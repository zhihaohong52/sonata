import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jsonStoreRead, opencodeDbRead } from '../../src/native/credential-reads.js';
import { codexAuthPath, readCodexOAuth } from '../../src/native/codex-auth.js';
import { opencodeDbPath, readOpencodeCredentials } from '../../src/native/opencode-store.js';
import { withReadSnapshot } from '../../src/native/read-snapshot.js';
import { sqliteAvailable, writeOpencodeCredDb } from '../opencode-db-fixture.js';

// The classifier and the parser of one store must see the same content within
// one build: a torn parse beside a clean classification read as a logout.
describe('withReadSnapshot', () => {
  const codex = JSON.stringify({ tokens: { access_token: 'h.e30.s', refresh_token: 'R' } });

  it('answers every read of a file inside one scope with the first read\'s bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'read-snapshot-'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(codexAuthPath(home), codex.slice(0, 10));
    const { classified, parsed } = withReadSnapshot(() => {
      const classified = jsonStoreRead(codexAuthPath(home));
      writeFileSync(codexAuthPath(home), codex); // the write completes mid-build
      return { classified, parsed: readCodexOAuth(home) };
    });
    expect(classified.state).toBe('unreadable');
    expect(parsed).toBeNull();
    // Outside a scope, the file is read afresh.
    expect(jsonStoreRead(codexAuthPath(home)).state).toBe('ok');
    expect(readCodexOAuth(home)?.refresh_token).toBe('R');
  });

  it('repeats a read error rather than retrying it inside one scope', () => {
    const home = mkdtempSync(join(tmpdir(), 'read-snapshot-'));
    mkdirSync(join(home, '.codex'));
    const { first, parsed } = withReadSnapshot(() => {
      const first = jsonStoreRead(codexAuthPath(home));
      writeFileSync(codexAuthPath(home), codex);
      return { first, parsed: readCodexOAuth(home) };
    });
    expect(first.state).toBe('absent');
    expect(parsed).toBeNull();
  });

  it.skipIf(!sqliteAvailable())('answers opencode.db\'s classification and its parse from one query', () => {
    const home = mkdtempSync(join(tmpdir(), 'read-snapshot-'));
    const env = { ...process.env, XDG_DATA_HOME: join(home, '.local', 'share') };
    const path = opencodeDbPath(home, env);
    writeOpencodeCredDb(path, [{ id: '1', integration: 'acme', value: JSON.stringify({ type: 'key', key: 'sk-1' }), timeCreated: 1 }]);
    const { classified, parsed } = withReadSnapshot(() => {
      const classified = opencodeDbRead(home, {}, env);
      rmSync(path); // the row disappears between the two
      writeOpencodeCredDb(path, []);
      return { classified, parsed: readOpencodeCredentials(home, env) };
    });
    expect(classified.state).toBe('ok');
    expect(parsed.acme?.key).toBe('sk-1');
  });
});
