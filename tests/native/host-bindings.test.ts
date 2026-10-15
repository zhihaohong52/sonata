import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  addTrustBinding,
  gatewayHostBound,
  hostBoundToGateway,
  normalizeTrustHost,
  readTrustBindings,
  removeTrustBinding,
  trustedHostsPath,
  unboundKeyHosts,
  unboundMessage,
} from '../../src/native/host-bindings.js';
import type { NativeConfig } from '../../src/config.js';

/** A fresh temporary home directory. */
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sonata-trust-'));
}

const gw = (baseUrl: string, auth: 'api-key' = 'api-key'): NativeConfig['gateways'][string] => ({ baseUrl, auth });

describe('normalizeTrustHost', () => {
  it('accepts a bare host and lowercases it', () => {
    expect(normalizeTrustHost('Proxy.Example.COM')).toBe('proxy.example.com');
  });

  it('accepts a full URL and keeps only its host', () => {
    expect(normalizeTrustHost('https://proxy.example:8443/v1')).toBe('proxy.example');
  });

  it('refuses non-https input', () => {
    expect(() => normalizeTrustHost('http://proxy.example/v1')).toThrow(/only https/);
  });

  it('refuses credentials in the URL', () => {
    expect(() => normalizeTrustHost('https://user:pass@proxy.example/')).toThrow(/without credentials/);
  });

  it('refuses empty input', () => {
    expect(() => normalizeTrustHost('   ')).toThrow(/empty/);
  });
});

describe('hostBoundToGateway', () => {
  it('binds the well-known host by gateway name', () => {
    expect(hostBoundToGateway('openrouter', 'openrouter.ai', {})).toBe(true);
  });

  it('does not bind the well-known host of another gateway', () => {
    expect(hostBoundToGateway('acme', 'openrouter.ai', {})).toBe(false);
  });

  it('binds a user-confirmed host, case-insensitively', () => {
    expect(hostBoundToGateway('acme', 'proxy.example', { trusted: ['proxy.example'] })).toBe(true);
  });

  it('never suffix-matches', () => {
    // proxy.example is bound; notproxy.example and proxy.example.evil.com are not.
    expect(hostBoundToGateway('acme', 'notproxy.example', { trusted: ['proxy.example'] })).toBe(false);
    expect(hostBoundToGateway('acme', 'proxy.example.evil.com', { trusted: ['proxy.example'] })).toBe(false);
    expect(hostBoundToGateway('acme', 'sub.proxy.example', { trusted: ['proxy.example'] })).toBe(false);
  });

  it('binds the machine config host for the same gateway name', () => {
    expect(hostBoundToGateway('acme', 'proxy.example', {
      machineGateways: { acme: { baseUrl: 'https://proxy.example/v1' } },
    })).toBe(true);
  });

  it('does not borrow the machine host of another gateway name', () => {
    expect(hostBoundToGateway('other', 'proxy.example', {
      machineGateways: { acme: { baseUrl: 'https://proxy.example/v1' } },
    })).toBe(false);
  });
});

describe('gatewayHostBound', () => {
  it('refuses a non-https base_url, naming it', () => {
    const binding = gatewayHostBound('acme', 'http://proxy.example/v1', {});
    expect(binding).toEqual({ bound: false, host: 'proxy.example' });
  });

  it('refuses a base_url that is not a URL at all', () => {
    const binding = gatewayHostBound('acme', 'not a url', {});
    expect(binding).toEqual({ bound: false, host: 'not a url' });
  });
});

describe('trust bindings file', () => {
  it('persists bindings 0600 and reads them back', () => {
    const home = tmp();
    addTrustBinding(home, 'acme', 'proxy.example');
    expect(statSync(trustedHostsPath(home)).mode & 0o777).toBe(0o600);
    expect(readTrustBindings(home)).toEqual({ acme: ['proxy.example'] });
  });

  it('adding twice is idempotent, and names stay sorted per gateway', () => {
    const home = tmp();
    addTrustBinding(home, 'acme', 'proxy.example');
    addTrustBinding(home, 'acme', 'proxy.example');
    expect(readTrustBindings(home)).toEqual({ acme: ['proxy.example'] });
  });

  it('removes a binding, and the last one removes the gateway', () => {
    const home = tmp();
    addTrustBinding(home, 'acme', 'a.example');
    addTrustBinding(home, 'acme', 'b.example');
    removeTrustBinding(home, 'acme', 'a.example');
    expect(readTrustBindings(home)).toEqual({ acme: ['b.example'] });
    removeTrustBinding(home, 'acme', 'b.example');
    expect(readTrustBindings(home)).toEqual({});
  });

  it('refuses to remove a binding that is not there', () => {
    expect(() => removeTrustBinding(tmp(), 'acme', 'proxy.example')).toThrow(/no trusted host/);
  });

  it('reads an absent or corrupt file as no bindings, never throws', () => {
    const home = tmp();
    expect(readTrustBindings(home)).toEqual({});
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(trustedHostsPath(home), '{torn');
    expect(readTrustBindings(home)).toEqual({});
    writeFileSync(trustedHostsPath(home), '["not", "an", "object"]');
    expect(readTrustBindings(home)).toEqual({});
  });

  it('ignores non-string and empty entries', () => {
    const home = tmp();
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(trustedHostsPath(home), JSON.stringify({ acme: ['proxy.example', 42, '', null, 'PROXY.EXAMPLE'] }));
    expect(readTrustBindings(home)).toEqual({ acme: ['proxy.example'] });
  });
});

describe('unboundKeyHosts', () => {
  it('names a gateway whose merged host is bound to nothing', () => {
    const message = unboundKeyHosts(
      { acme: gw('https://attacker.example/v1') }, {}, new Set(['acme']), tmp(),
    ).get('acme');
    expect(message).toContain('attacker.example');
    expect(message).toContain('sonata auth trust acme attacker.example');
  });

  it('says nothing for a well-known host', () => {
    expect(unboundKeyHosts(
      { openrouter: gw('https://openrouter.ai/api/v1') }, {}, new Set(['openrouter']), tmp(),
    ).size).toBe(0);
  });

  it('says nothing for a user-trusted host', () => {
    const home = tmp();
    addTrustBinding(home, 'acme', 'proxy.example');
    expect(unboundKeyHosts(
      { acme: gw('https://proxy.example/v1') }, {}, new Set(['acme']), home,
    ).size).toBe(0);
  });

  it('says nothing for the machine config host under the same name', () => {
    expect(unboundKeyHosts(
      { acme: gw('https://proxy.example/v1') },
      { acme: gw('https://proxy.example/v1') },
      new Set(['acme']),
      tmp(),
    ).size).toBe(0);
  });

  it('says nothing when no key is stored for the name', () => {
    expect(unboundKeyHosts(
      { acme: gw('https://attacker.example/v1') }, {}, new Set(), tmp(),
    ).size).toBe(0);
  });

  it('ignores session and OAuth gateways', () => {
    const merged: NativeConfig['gateways'] = {
      claude: { baseUrl: 'https://api.anthropic.com/v1', auth: 'session' },
      codex: { baseUrl: 'https://chatgpt.com/backend-api/codex', auth: 'codex-oauth' },
    };
    expect(unboundKeyHosts(merged, {}, new Set(['claude', 'codex']), tmp()).size).toBe(0);
  });
});

describe('unboundMessage', () => {
  it('names the exact trust command for one host', () => {
    expect(unboundMessage('acme', ['proxy.example'])).toBe(
      'gateway "acme": its key is not served to "proxy.example" — that host is not bound to this gateway; ' +
      'run `sonata auth trust acme proxy.example` to allow it',
    );
  });
});
