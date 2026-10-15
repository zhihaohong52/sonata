import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jevClassifier } from '../../src/native/auto-route.js';
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
    expect(decisionHostBinding('http://decide.example', home)).toEqual({ bound: false, host: 'decide.example' });
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
