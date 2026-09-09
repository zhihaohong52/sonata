import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routerPorts } from '../../src/commands/ports.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-ports-')); });

const machine = (toml: string) => {
  mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
  writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), toml);
};

describe('routerPorts', () => {
  it('defaults with no machine config at all', () => {
    expect(routerPorts(home)).toEqual({ router: 4100, litellm: 4000 });
  });
  it('reads the machine config [native.ports]', () => {
    machine('[native.ports]\nrouter = 4300\nlitellm = 4301\n');
    expect(routerPorts(home)).toEqual({ router: 4300, litellm: 4301 });
  });
  it('defaults when the machine config has no [native] table', () => {
    machine('schema_version = 1\n');
    expect(routerPorts(home)).toEqual({ router: 4100, litellm: 4000 });
  });
  it('throws on a machine config that will not parse — a broken machine config is a real error', () => {
    machine('[native.ports\n');
    expect(() => routerPorts(home)).toThrow();
  });
});
