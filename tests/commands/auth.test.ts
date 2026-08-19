import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdAuthAdd, cmdAuthList, cmdAuthRemove } from '../../src/commands/auth.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-auth-'));
});

afterEach(() => {
  home = '';
});

describe('native auth commands', () => {
  it('adds a key and lists only its source', () => {
    const key = 'secret-key-value';
    cmdAuthAdd({ home, gateway: 'anexto', key });

    const result = cmdAuthList({ home, gateways: ['anexto'] });
    expect(result.text).toBe('anexto: key from sonata');
    expect(result.text.includes(key)).toBe(false);
  });

  it('removes a key and lists no key', () => {
    cmdAuthAdd({ home, gateway: 'anexto', key: 'secret-key-value' });
    cmdAuthRemove({ home, gateway: 'anexto' });

    expect(cmdAuthList({ home, gateways: ['anexto'] }).text).toBe('anexto: no key');
  });

  it('never includes stored key values in list output', () => {
    const key = 'do-not-print-me';
    cmdAuthAdd({ home, gateway: 'gateway-a', key });

    const result = cmdAuthList({ home, gateways: ['gateway-a', 'gateway-b'] });
    expect(result.text.includes(key)).toBe(false);
    expect(result.text).toContain('gateway-a: key from sonata');
    expect(result.text).toContain('gateway-b: no key');
  });
});
