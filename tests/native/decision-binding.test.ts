import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionGatewayFor, jevClassifier } from '../../src/native/auto-route.js';
import { decisionHostBinding, decisionKeyBinding, decisionUnboundMessage } from '../../src/native/decision-binding.js';
import { addTrustBinding } from '../../src/native/host-bindings.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'decision-binding-'));

describe('decisionHostBinding', () => {
  it('binds TypeSafe and OpenRouter, their own well-known hosts, over https', () => {
    expect(decisionHostBinding('https://api.typesafe.ai', tmp())).toEqual({ bound: true });
    expect(decisionHostBinding('https://openrouter.ai/api/v1', tmp())).toEqual({ bound: true });
  });

  it('refuses TypeSafe and OpenRouter over plain http', () => {
    expect(decisionHostBinding('http://api.typesafe.ai', tmp()).bound).toBe(false);
  });

  it('refuses a custom decision host until the user trusts it as auto-route', () => {
    const home = tmp();
    expect(decisionHostBinding('https://decide.example', home)).toEqual({ bound: false, host: 'decide.example' });
    addTrustBinding(home, 'auto-route', 'decide.example');
    expect(decisionHostBinding('https://decide.example', home)).toEqual({ bound: true });
  });

  it('does not let a trust for another gateway name bind the decision host', () => {
    const home = tmp();
    addTrustBinding(home, 'acme', 'decide.example');
    expect(decisionHostBinding('https://decide.example', home).bound).toBe(false);
  });
});

describe('a configured gateway as the decision provider', () => {
  const tenant = { acme: { baseUrl: 'https://gw.acme.example/v1', auth: 'api-key' as const } };

  it('binds its host exactly as the gateway itself is bound — by its own trust entry', () => {
    const home = tmp();
    expect(decisionHostBinding('https://gw.acme.example', home, undefined, { tenant })).toEqual({ bound: false, host: 'gw.acme.example' });
    // An auto-route trust does not lend the gateway's key to its host.
    addTrustBinding(home, 'auto-route', 'gw.acme.example');
    expect(decisionHostBinding('https://gw.acme.example', home, undefined, { tenant }).bound).toBe(false);
    addTrustBinding(home, 'acme', 'gw.acme.example');
    expect(decisionHostBinding('https://gw.acme.example', home, undefined, { tenant })).toEqual({ bound: true });
  });

  it('binds a machine config gateway by definition', () => {
    expect(decisionHostBinding('https://gw.acme.example', tmp(), undefined, { tenant, machine: tenant })).toEqual({ bound: true });
  });

  it('refuses plain http to the gateway host even when the gateway is https', () => {
    expect(decisionHostBinding('http://gw.acme.example', tmp(), undefined, { tenant, machine: tenant })).toMatchObject({ bound: false, insecure: true });
  });

  it('names the gateway in the trust command it suggests', () => {
    expect(decisionUnboundMessage('https://gw.acme.example', 'gw.acme.example', 'sonata.toml', { gateway: 'acme' }))
      .toContain('sonata auth trust acme gw.acme.example');
  });
});

describe('the well-known decision hosts compare the port too', () => {
  it('does not treat TypeSafe or OpenRouter on another port as the well-known host', () => {
    const home = tmp();
    expect(decisionGatewayFor('https://api.typesafe.ai:8443')).toBe('auto-route');
    expect(decisionHostBinding('https://api.typesafe.ai:8443', home).bound).toBe(false);
    expect(decisionHostBinding('https://openrouter.ai:8443/api', home).bound).toBe(false);
  });

  it('keeps the well-known host on its default port', () => {
    expect(decisionGatewayFor('https://api.typesafe.ai:443')).toBe('typesafe');
    expect(decisionHostBinding('https://api.typesafe.ai', tmp())).toEqual({ bound: true });
  });

  it('binds another port of a decision host only by its own trust entry', () => {
    const home = tmp();
    addTrustBinding(home, 'auto-route', 'api.typesafe.ai:8443');
    expect(decisionHostBinding('https://api.typesafe.ai:8443', home)).toEqual({ bound: true });
  });
});

describe('decisionKeyBinding', () => {
  it('needs no binding when no key would be sent, even to an unbound host', () => {
    expect(decisionKeyBinding('http://localhost:8000', undefined, tmp())).toBeUndefined();
    expect(decisionKeyBinding('https://decide.example', undefined, tmp())).toBeUndefined();
  });

  it('requires the host binding when a key would be sent', () => {
    expect(decisionKeyBinding('https://decide.example', 'k', tmp())).toEqual({ bound: false, host: 'decide.example' });
  });
});

describe('plain http decision URLs', () => {
  it('bind a loopback host only by explicit trust', () => {
    const home = tmp();
    expect(decisionHostBinding('http://localhost:8000', home).bound).toBe(false);
    addTrustBinding(home, 'auto-route', 'localhost:8000');
    expect(decisionHostBinding('http://localhost:8000', home)).toEqual({ bound: true });
  });

  it('bind the machine config’s own loopback [auto_route] URL without trust', () => {
    // Trusted by definition, like a machine gateway: a keyed local decision
    // server in the machine config keeps working across the upgrade.
    const home = tmp();
    expect(decisionKeyBinding('http://localhost:8000', 'k', home, 'http://localhost:8000')).toEqual({ bound: true });
    expect(decisionKeyBinding('http://localhost:8001', 'k', home, 'http://localhost:8000')?.bound).toBe(false);
  });

  it('never bind a non-loopback plain-http host, even when trusted', () => {
    const home = tmp();
    addTrustBinding(home, 'auto-route', 'decide.example');
    expect(decisionHostBinding('http://decide.example', home)).toEqual({ bound: false, host: 'decide.example', insecure: true });
  });
});

describe('decisionUnboundMessage', () => {
  it('names the config and says the fallback tier is used and what to trust', () => {
    const message = decisionUnboundMessage('https://decide.example', 'decide.example', '/work/sonata.toml');
    expect(message).toContain('/work/sonata.toml');
    expect(message).toContain('fallback tier');
    expect(message).toContain('do not trust it');
    expect(message).toContain('sonata auth trust auto-route decide.example');
  });
});

describe('decisionUnboundMessage over plain http', () => {
  it('asks for https and suggests no trust, for a LAN decision server and for a well-known host over http', () => {
    const lan = decisionHostBinding('http://192.168.1.5:9000', tmp());
    expect(lan).toMatchObject({ bound: false, insecure: true });
    const message = decisionUnboundMessage('http://192.168.1.5:9000', '192.168.1.5:9000', '/work/sonata.toml', { insecure: true });
    expect(message).toContain('https');
    expect(message).not.toContain('auth trust');
    expect(decisionHostBinding('http://decide.example', tmp())).toMatchObject({ insecure: true });
  });

  it('can omit the command for the text that leaves the process', () => {
    const message = decisionUnboundMessage('https://decide.example', 'decide.example', '/work/sonata.toml', { command: false });
    expect(message).not.toContain('auth trust');
    expect(message).toContain('sonata doctor');
  });
});

describe('jevClassifier', () => {
  it('sends its request with redirects refused, so a redirect cannot carry the key onward', async () => {
    let init: RequestInit | undefined;
    const classifier = jevClassifier({
      fetch: (async (_url: string, options: RequestInit) => {
        init = options;
        throw new Error('stop after capturing');
      }) as typeof fetch,
      key: () => 'k',
      attemptMs: 1000,
      retries: 0,
      model: 'm',
    });
    await expect(classifier.classify({ role: 'code', task: 'x', tiers: ['simple'] }, new AbortController().signal)).rejects.toThrow();
    expect(init?.redirect).toBe('error');
  });
});

describe('the decision host that requires a key compares the port too', () => {
  it('requires a key for openrouter.ai, and not for openrouter.ai on another port', async () => {
    const { decisionClassifier } = await import('../../src/native/auto-route.js');
    const make = (baseUrl: string) => decisionClassifier({ baseUrl }, {
      fetch: (async () => { throw new Error('unreachable in this test'); }) as typeof fetch,
      key: () => undefined,
      keyHint: 'sonata auth add openrouter',
      model: async () => 'm',
    });
    const controller = new AbortController();
    await expect(make('https://openrouter.ai').classify({ role: 'code', task: 'x', tiers: ['simple'] }, controller.signal))
      .rejects.toThrow(/no classifier key/);
    await expect(make('https://openrouter.ai:8443').classify({ role: 'code', task: 'x', tiers: ['simple'] }, controller.signal))
      .rejects.not.toThrow(/no classifier key/);
  });
});
