import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';

/** A config naming one gateway at `url`, written as a TOML basic string so control characters survive. */
const gatewayAt = (url: string): string => `[native.gateways."acme"]\nbase_url = ${JSON.stringify(url)}\n`;

describe('gateway base_url — refused forms', () => {
  it.each([
    ['a backslash before the @', 'https://openrouter.ai\\@evil.example/api/v1'],
    ['a loopback backslash before the @', 'http://localhost:4000\\@evil.example'],
    ['userinfo', 'https://openrouter.ai@evil.example/api/v1'],
    ['userinfo with a password', 'https://user:pw@evil.example/v1'],
    ['a percent-encoded slash before the @', 'https://openrouter.ai%2F@evil.example/api/v1'],
    ['a percent-encoded backslash before the @', 'https://openrouter.ai%5C@evil.example/api/v1'],
    ['a percent-encoded host', 'https://evil%2Eexample/v1'],
    ['a tab inside the host', 'https://openrouter.ai\t/api/v1'],
    ['a newline inside the host', 'https://openrouter.ai\n/api/v1'],
    ['a space', 'https://openrouter.ai /api/v1'],
    ['a fragment that hides the host', 'https://openrouter.ai#@evil.example/v1'],
    ['a query string', 'https://openrouter.ai/api/v1?x=1'],
    ['no scheme', 'openrouter.ai/api/v1'],
    ['a non-http scheme', 'ftp://openrouter.ai/v1'],
  ])('refuses %s', (_label, url) => {
    expect(() => parseConfig(gatewayAt(url))).toThrow(/base_url must be an absolute http\(s\) URL/);
  });
});

describe('gateway base_url — accepted forms are stored as their URL href', () => {
  it('stores the normalised href, so every consumer gets the string that was checked', () => {
    expect(parseConfig(gatewayAt('https://OpenRouter.ai/api/v1')).native?.gateways.acme?.baseUrl)
      .toBe('https://openrouter.ai/api/v1');
  });

  it('accepts a bracketed IPv6 loopback and a port', () => {
    expect(parseConfig(gatewayAt('http://[::1]:8080/v1')).native?.gateways.acme?.baseUrl).toBe('http://[::1]:8080/v1');
    expect(parseConfig(gatewayAt('http://localhost:4000/v1')).native?.gateways.acme?.baseUrl).toBe('http://localhost:4000/v1');
  });
});

describe('[auto_route] base_url — the same rule', () => {
  const decision = (url: string): string => `[auto_route]\nclassifier = "jev"\nbase_url = ${JSON.stringify(url)}\n`;

  it('refuses the backslash and userinfo forms', () => {
    expect(() => parseConfig(decision('https://api.typesafe.ai\\@evil.example'))).toThrow(/absolute http\(s\) URL/);
    expect(() => parseConfig(decision('https://api.typesafe.ai@evil.example'))).toThrow(/absolute http\(s\) URL/);
  });

  it('stores a plain URL without its trailing slash', () => {
    expect(parseConfig(decision('https://decide.example/')).autoRoute?.baseUrl).toBe('https://decide.example');
  });
});

// The parser disagreement the plain-form rule answers, pinned against the real
// client: sonata's own LiteLLM venv. Skipped where the venv is not installed.
const venvPython = join(homedir(), '.config', 'sonata', 'litellm', 'bin', 'python');
describe.skipIf(!existsSync(venvPython))('the parsers a checked URL is sent through', () => {
  it('httpx reads the backslash form as host evil.example, where Node reads openrouter.ai', () => {
    const url = 'https://openrouter.ai\\@evil.example/api/v1';
    const httpxHost = execFileSync(
      venvPython,
      ['-I', '-c', 'import httpx, sys; print(httpx.URL(sys.argv[1]).host)', url],
      { encoding: 'utf8' },
    ).trim();
    expect(httpxHost).toBe('evil.example');
    expect(new URL(url).host).toBe('openrouter.ai');
  });
});
