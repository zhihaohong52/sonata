import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../../src/init/apply.js';
import { assertPlannedConfigParses } from '../../src/init/plan.js';
import type { InitPlan } from '../../src/init/plan.js';
import { keyReport } from '../../src/native/credentials.js';
import { readTrustBindings } from '../../src/native/host-bindings.js';

describe('init refuses a config that will not load, before it writes anything', () => {
  it('names the cause, and the check runs in plan and apply alike', () => {
    expect(() => assertPlannedConfigParses('[native.gateways."acme"]\nbase_url = "https://user@evil.example"\n'))
      .toThrow(/does not load.*Nothing was written/s);
    expect(() => assertPlannedConfigParses('[native.gateways."acme"]\nbase_url = "https://a.example/v1"\n')).not.toThrow();
  });

  it('stores no key and no trust binding when the planned config is refused', async () => {
    const home = mkdtempSync(join(tmpdir(), 'init-refuse-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'init-refuse-cwd-'));
    const bad = {
      configToml: '[native.gateways."acme"]\nbase_url = "https://user@evil.example"\n',
      keysToStore: [{ gateway: 'acme', key: 'sk-never' }],
      hostsToTrust: [{ gateway: 'acme', host: 'evil.example' }],
    } as unknown as InitPlan;
    const io = { out: () => undefined } as unknown as Parameters<typeof apply>[2];
    await expect(apply(bad, { cwd, home, packageRoot: cwd }, io)).rejects.toThrow(/does not load/);
    expect(keyReport(['acme'], home)[0]?.source).toBeNull();
    expect(readTrustBindings(home)).toEqual({});
    expect(existsSync(join(home, '.config', 'sonata', 'trusted-hosts.json'))).toBe(false);
  });
});
