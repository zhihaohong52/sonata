import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  keyReport,
  resolveKeys,
  sonataKeyStorePath,
  writeSonataKey,
} from '../../src/native/credentials.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sonata-credentials-'));
}

describe('credential resolution', () => {
  it('prefers the sonata store over a discovered opencode key', () => {
    const home = tmp();
    writeSonataKey(home, 'vendorx', 'sonata-key');
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
    writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ vendorx: { key: 'oc-key' } }));

    expect(resolveKeys(['vendorx'], home)).toMatchObject([
      { gateway: 'vendorx', source: 'sonata', key: 'sonata-key' },
    ]);
  });

  it('falls back to opencode when sonata has no key', () => {
    const home = tmp();
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
    writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ vendorx: { key: 'oc-key' } }));

    expect(resolveKeys(['vendorx'], home)).toMatchObject([
      { gateway: 'vendorx', source: 'opencode', key: 'oc-key' },
    ]);
  });

  it('keyReport never includes the key value', () => {
    const home = tmp();
    writeSonataKey(home, 'vendorx', 'secret');

    const report = keyReport(['vendorx'], home);
    expect(report).toEqual([{ gateway: 'vendorx', source: 'sonata' }]);
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('reports source null for a gateway with no key anywhere', () => {
    expect(keyReport(['ghost'], tmp())).toEqual([{ gateway: 'ghost', source: null }]);
  });

  it('writeSonataKey creates a 0600 file', () => {
    const home = tmp();
    writeSonataKey(home, 'vendorx', 'k');

    expect(statSync(sonataKeyStorePath(home)).mode & 0o777).toBe(0o600);
  });
});
