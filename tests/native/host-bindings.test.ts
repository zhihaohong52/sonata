import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  isLoopbackHostname,
  refreshHostReasons,
  unboundKeyHosts,
  unboundMessage,
  unboundMessageForModel,
  trustCommand,
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

  it('accepts a full URL and keeps its host, with a non-default port', () => {
    expect(normalizeTrustHost('https://proxy.example:8443/v1')).toBe('proxy.example:8443');
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
    expect(binding).toEqual({ bound: false, host: 'proxy.example', insecure: true });
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
  const CFG = '/work/project/sonata.toml';

  it('names a gateway whose host is bound to nothing, and the config that sets it', () => {
    const message = unboundKeyHosts(
      { acme: gw('https://attacker.example/v1') }, {}, new Set(['acme']), tmp(), CFG,
    ).get('acme');
    expect(message).toContain('attacker.example');
    expect(message).toContain(CFG);
    expect(message).toContain('sonata auth trust acme attacker.example');
  });

  it('says nothing for a well-known host', () => {
    expect(unboundKeyHosts(
      { openrouter: gw('https://openrouter.ai/api/v1') }, {}, new Set(['openrouter']), tmp(), CFG,
    ).size).toBe(0);
  });

  it('says nothing for a user-trusted host', () => {
    const home = tmp();
    addTrustBinding(home, 'acme', 'proxy.example');
    expect(unboundKeyHosts(
      { acme: gw('https://proxy.example/v1') }, {}, new Set(['acme']), home, CFG,
    ).size).toBe(0);
  });

  it('says nothing for the machine config host under the same name', () => {
    expect(unboundKeyHosts(
      { acme: gw('https://proxy.example/v1') },
      { acme: gw('https://proxy.example/v1') },
      new Set(['acme']),
      tmp(),
      CFG,
    ).size).toBe(0);
  });

  it('says nothing when no key is stored for the name', () => {
    expect(unboundKeyHosts(
      { acme: gw('https://attacker.example/v1') }, {}, new Set(), tmp(), CFG,
    ).size).toBe(0);
  });

  it('ignores session and OAuth gateways', () => {
    const merged: NativeConfig['gateways'] = {
      claude: { baseUrl: 'https://api.anthropic.com/v1', auth: 'session' },
      codex: { baseUrl: 'https://chatgpt.com/backend-api/codex', auth: 'codex-oauth' },
    };
    expect(unboundKeyHosts(merged, {}, new Set(['claude', 'codex']), tmp(), CFG).size).toBe(0);
  });
});

describe('unboundMessage', () => {
  const CFG = '/work/project/sonata.toml';

  it('leads with the remove instruction, names the config, then gives the trust command', () => {
    expect(unboundMessage('acme', 'proxy.example', CFG)).toBe(
      'gateway "acme": if you did not choose this URL (set in /work/project/sonata.toml, for host "proxy.example"), ' +
      'remove it from /work/project/sonata.toml — do not trust it. If you did, run `sonata auth trust acme proxy.example` ' +
      'in a terminal to allow its key there; until then the key is not served to "proxy.example".',
    );
  });

  it('puts the remove instruction before the trust command', () => {
    const message = unboundMessage('acme', 'proxy.example', CFG);
    expect(message.indexOf('if you did not choose this URL')).toBe(message.indexOf('gateway "acme": ') + 'gateway "acme": '.length);
    expect(message.indexOf('remove it from')).toBeLessThan(message.indexOf('sonata auth trust'));
  });
});

describe('the model-facing and quoted forms', () => {
  const CFG = '/work/project/sonata.toml';

  it('the model message carries no trust command, names the file and sonata doctor, and leads with remove', () => {
    const message = unboundMessageForModel('acme', 'proxy.example', CFG);
    expect(message).not.toContain('auth trust');
    expect(message).toContain(CFG);
    expect(message).toContain('sonata doctor');
    expect(message.indexOf('remove it from')).toBeGreaterThan(-1);
  });

  it('unboundKeyHosts answers the model audience without the command, the user audience with it', () => {
    const args = [{ acme: gw('https://attacker.example/v1') }, {}, new Set(['acme']), tmp(), CFG] as const;
    expect(unboundKeyHosts(...args, 'model').get('acme')).not.toContain('auth trust');
    expect(unboundKeyHosts(...args).get('acme')).toContain('sonata auth trust acme attacker.example');
  });

  it('quotes a gateway and host so they cannot form another command', () => {
    expect(trustCommand('acme', 'proxy.example:8443')).toBe('sonata auth trust acme proxy.example:8443');
    const hostile = trustCommand('a b; rm -rf ~', "$(x)'`y`");
    expect(hostile).toBe(`sonata auth trust 'a b; rm -rf ~' '$(x)'\\''\`y\`'`.replace('\\`', '`').replace('\\`', '`'));
    expect(unboundMessage('a;b', 'h.example', CFG)).toContain("sonata auth trust 'a;b' h.example");
  });
});

describe('plain http off loopback', () => {
  const CFG = '/work/project/sonata.toml';

  it.each(['http://192.168.1.5:8000/v1', 'http://ollama_server:11434/v1'])('%s is insecure, never bindable, and no trust is suggested', (url) => {
    const binding = gatewayHostBound('lan', url, { trusted: [new URL(url).host] });
    expect(binding).toMatchObject({ bound: false, insecure: true });
    if (binding.bound) throw new Error('unreachable');
    const message = unboundMessage('lan', binding.host, CFG, binding.insecure);
    expect(message).toContain('https');
    expect(message).not.toContain('auth trust');
    expect(unboundMessageForModel('lan', binding.host, CFG, true)).not.toContain('auth trust');
    expect(message.indexOf('remove it from')).toBeGreaterThan(-1);
  });

  it('unboundKeyHosts gives the https message for a keyed LAN http gateway', () => {
    const message = unboundKeyHosts({ lan: gw('http://192.168.1.5:8000/v1') }, {}, new Set(['lan']), tmp(), CFG).get('lan');
    expect(message).toContain('needs https');
    expect(message).not.toContain('auth trust');
  });

  it('a loopback http host is not insecure: it can be trusted', () => {
    expect(gatewayHostBound('local', 'http://localhost:4000/v1', { trusted: [] })).toEqual({ bound: false, host: 'localhost:4000' });
  });
});

describe('refreshHostReasons', () => {
  const CFG = '/work/sonata.toml';
  const input = (overrides: Partial<Parameters<typeof refreshHostReasons>[0]> = {}) => ({
    gatewayUrls: { acme: 'https://attacker.example/v1' },
    keys: { acme: 'sk-acme' },
    typed: new Set<string>(),
    trusted: {},
    machineGateways: {},
    configFile: CFG,
    ...overrides,
  });

  it('gives the reason for a stored key whose URL host is unbound, naming the config', () => {
    const reasons = refreshHostReasons(input());
    expect(reasons.acme).toContain('attacker.example');
    expect(reasons.acme).toContain(CFG);
  });

  it('skips a gateway with no stored key, since nothing would be sent', () => {
    expect(refreshHostReasons(input({ keys: {} }))).toEqual({});
  });

  it('treats a URL typed in this run as bound', () => {
    expect(refreshHostReasons(input({ typed: new Set(['acme']) }))).toEqual({});
  });

  it('treats a user-trusted host as bound', () => {
    expect(refreshHostReasons(input({ trusted: { acme: ['attacker.example'] } }))).toEqual({});
  });

  it('treats the machine config’s own URL under the same name as bound', () => {
    expect(refreshHostReasons(input({ machineGateways: { acme: { baseUrl: 'https://attacker.example/v1' } } }))).toEqual({});
  });
});

describe('trust-file writers', () => {
  it('refuse a corrupt trust file, naming it, and leave its bytes alone', () => {
    const home = tmp();
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(trustedHostsPath(home), '{torn');
    expect(() => addTrustBinding(home, 'acme', 'proxy.example')).toThrow(/trusted-hosts\.json is not valid JSON/);
    expect(() => removeTrustBinding(home, 'acme', 'proxy.example')).toThrow(/not valid JSON/);
    expect(readFileSync(trustedHostsPath(home), 'utf8')).toBe('{torn');
  });

  it('refuse a trust file that holds no object', () => {
    const home = tmp();
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(trustedHostsPath(home), '["not", "an", "object"]');
    expect(() => addTrustBinding(home, 'acme', 'proxy.example')).toThrow(/does not hold a JSON object/);
  });

  it('keeps every binding through a write, with its marker-free shape intact', () => {
    const home = tmp();
    addTrustBinding(home, 'acme', 'a.example');
    addTrustBinding(home, 'other', 'b.example');
    addTrustBinding(home, 'acme', 'c.example');
    expect(readTrustBindings(home)).toEqual({ acme: ['a.example', 'c.example'], other: ['b.example'] });
  });

  it('waits on the lock, and refuses rather than writing over a holder that never lets go', () => {
    const home = tmp();
    const lock = `${trustedHostsPath(home)}.lock`;
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner'), 'someone-else');
    expect(() => addTrustBinding(home, 'acme', 'proxy.example')).toThrow(/timed out waiting for lock/);
    expect(existsSync(trustedHostsPath(home))).toBe(false);
  }, 10_000);
});

describe('host comparison includes a non-default port', () => {
  it('binds a trusted host with its port only on that port', () => {
    const home = tmp();
    addTrustBinding(home, 'auto-route', 'localhost:8443');
    expect(gatewayHostBound('auto-route', 'https://localhost:8443/v1', { trusted: readTrustBindings(home)['auto-route'] })).toEqual({ bound: true });
    expect(gatewayHostBound('auto-route', 'https://localhost:9443/v1', { trusted: readTrustBindings(home)['auto-route'] }).bound).toBe(false);
  });

  it('treats the scheme default port as no port', () => {
    expect(gatewayHostBound('acme', 'https://proxy.example:443/v1', { trusted: ['proxy.example'] })).toEqual({ bound: true });
    expect(normalizeTrustHost('https://PROXY.example:443')).toBe('proxy.example');
    expect(normalizeTrustHost('proxy.example:8443')).toBe('proxy.example:8443');
  });
});

describe('plain-http loopback hosts', () => {
  it('recognises localhost, 127.0.0.0/8 and ::1, and nothing else', () => {
    for (const host of ['localhost', '127.0.0.1', '127.8.9.10', '[::1]', '::1']) expect(isLoopbackHostname(host)).toBe(true);
    for (const host of ['localhost.example', '128.0.0.1', 'example.com', '10.0.0.1']) expect(isLoopbackHostname(host)).toBe(false);
  });

  it('is bound only by an explicit trust, port-aware', () => {
    const home = tmp();
    expect(gatewayHostBound('acme', 'http://localhost:8000/v1', { trusted: readTrustBindings(home).acme ?? [] }).bound).toBe(false);
    addTrustBinding(home, 'acme', 'localhost:8000');
    expect(gatewayHostBound('acme', 'http://localhost:8000/v1', { trusted: readTrustBindings(home).acme })).toEqual({ bound: true });
    expect(gatewayHostBound('acme', 'http://localhost:9000/v1', { trusted: readTrustBindings(home).acme }).bound).toBe(false);
  });

  it('is bound implicitly by the machine config, port-aware, and is not by the well-known table', () => {
    // The machine config is trusted by definition, so its own loopback URL
    // needs no trust step; the same URL on another port is a different host.
    const machine = { acme: gw('http://127.0.0.1:8000/v1') };
    expect(gatewayHostBound('acme', 'http://127.0.0.1:8000/v1', { machineGateways: machine })).toEqual({ bound: true });
    expect(gatewayHostBound('acme', 'http://127.0.0.1:9000/v1', { machineGateways: machine }).bound).toBe(false);
    // A loopback name in another gateway's machine entry binds nothing for this one.
    expect(gatewayHostBound('other', 'http://127.0.0.1:8000/v1', { machineGateways: machine }).bound).toBe(false);
  });

  it('a non-loopback plain-http machine URL still binds nothing', () => {
    const machine = { acme: gw('http://proxy.example/v1') };
    expect(gatewayHostBound('acme', 'http://proxy.example/v1', { machineGateways: machine }).bound).toBe(false);
  });

  it('trusts an IPv6 loopback with its brackets', () => {
    expect(normalizeTrustHost('http://[::1]:8080')).toBe('[::1]:8080');
    expect(gatewayHostBound('acme', 'http://[::1]:8080/v1', { trusted: ['[::1]:8080'] })).toEqual({ bound: true });
  });

  it('accepts a loopback http URL to trust, and refuses any other plain http', () => {
    expect(normalizeTrustHost('http://localhost:8000')).toBe('localhost:8000');
    expect(() => normalizeTrustHost('http://decide.example')).toThrow(/only https/);
    expect(() => normalizeTrustHost('http://10.0.0.5:8000')).toThrow(/only https/);
  });

  it('never binds a non-loopback plain-http URL, even when its host is trusted', () => {
    expect(gatewayHostBound('acme', 'http://proxy.example/v1', { trusted: ['proxy.example'] }).bound).toBe(false);
  });
});
