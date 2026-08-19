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
    writeSonataKey(home, 'anexto', 'sonata-key');
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
    writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ anexto: { key: 'oc-key' } }));

    expect(resolveKeys(['anexto'], home)).toMatchObject([
      { gateway: 'anexto', source: 'sonata', key: 'sonata-key' },
    ]);
  });

  it('falls back to opencode when sonata has no key', () => {
    const home = tmp();
    mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
    writeFileSync(join(home, '.local/share/opencode/auth.json'), JSON.stringify({ anexto: { key: 'oc-key' } }));

    expect(resolveKeys(['anexto'], home)).toMatchObject([
      { gateway: 'anexto', source: 'opencode', key: 'oc-key' },
    ]);
  });

  it('keyReport never includes the key value', () => {
    const home = tmp();
    writeSonataKey(home, 'anexto', 'secret');

    const report = keyReport(['anexto'], home);
    expect(report).toEqual([{ gateway: 'anexto', source: 'sonata' }]);
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('reports source null for a gateway with no key anywhere', () => {
    expect(keyReport(['ghost'], tmp())).toEqual([{ gateway: 'ghost', source: null }]);
  });

  it('writeSonataKey creates a 0600 file', () => {
    const home = tmp();
    writeSonataKey(home, 'anexto', 'k');

    expect(statSync(sonataKeyStorePath(home)).mode & 0o777).toBe(0o600);
  });
});
