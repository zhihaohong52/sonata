import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonicalBaseUrlOrUndefined, parseConfig } from '../src/config.js';

/** A config naming one gateway at `url`, written as a TOML basic string so control characters survive. */
const gatewayAt = (url: string): string => `[native.gateways."acme"]\nbase_url = ${JSON.stringify(url)}\n`;
const gatewayBase = (url: string): string | undefined => parseConfig(gatewayAt(url)).native?.gateways.acme?.baseUrl;

describe('gateway base_url — refused shapes', () => {
  it.each([
    ['a backslash before the @', 'https://openrouter.ai\\@evil.example/api/v1'],
    ['a loopback backslash before the @', 'http://localhost:4000\\@evil.example'],
    ['userinfo', 'https://openrouter.ai@evil.example/api/v1'],
    ['userinfo with a password', 'https://user:pw@evil.example/v1'],
    ['a percent-encoded slash before the @', 'https://openrouter.ai%2F@evil.example/api/v1'],
    ['a percent-encoded backslash before the @', 'https://openrouter.ai%5C@evil.example/api/v1'],
    ['a percent-encoded host', 'https://evil%2Eexample/v1'],
    ['a percent-encoded character in the authority', 'https://openrouter%2Eai/v1'],
    ['an inner tab', 'https://openrouter.ai\t/api/v1'],
    ['an inner newline', 'https://openrouter.ai\n/api/v1'],
    ['an inner space', 'https://openrouter.ai /api/v1'],
    ['a fragment that hides the host', 'https://openrouter.ai#@evil.example/v1'],
    ['a query string', 'https://openrouter.ai/api/v1?x=1'],
    ['an empty query', 'https://openrouter.ai/api/v1?'],
    ['no scheme', 'openrouter.ai/api/v1'],
    ['a non-http scheme', 'ftp://openrouter.ai/v1'],
  ])('refuses %s', (_label, url) => {
    expect(() => parseConfig(gatewayAt(url))).toThrow(/base_url must be an absolute http\(s\) URL/);
  });
});

describe('gateway base_url — accepted shapes are stored as their canonical href', () => {
  it.each([
    ['an underscore host (docker-compose name)', 'http://ollama_server:11434/v1', 'http://ollama_server:11434/v1'],
    ['an uppercase scheme', 'HTTPS://api.example/v1', 'https://api.example/v1'],
    ['an uppercase host', 'https://OpenRouter.ai/api/v1', 'https://openrouter.ai/api/v1'],
    ['an IDN host, as its punycode href', 'https://bücher.example/v1', 'https://xn--bcher-kva.example/v1'],
    ['a default port, dropped', 'https://x.example:443/v1', 'https://x.example/v1'],
    ['surrounding whitespace', '  https://a.example/v1  ', 'https://a.example/v1'],
    ['a bracketed IPv6 loopback with a port', 'http://[::1]:8080/v1', 'http://[::1]:8080/v1'],
    ['a percent-encoded path', 'https://api.example/a%20b', 'https://api.example/a%20b'],
    ['a bare origin, without the trailing slash', 'https://api.example', 'https://api.example'],
  ])('accepts %s', (_label, url, href) => {
    expect(gatewayBase(url)).toBe(href);
  });
});

describe('[auto_route] base_url — the same rule', () => {
  const decision = (url: string): string => `[auto_route]\nclassifier = "jev"\nbase_url = ${JSON.stringify(url)}\n`;

  it('refuses the backslash and userinfo forms', () => {
    expect(() => parseConfig(decision('https://api.typesafe.ai\\@evil.example'))).toThrow(/absolute http\(s\) URL/);
    expect(() => parseConfig(decision('https://api.typesafe.ai@evil.example'))).toThrow(/absolute http\(s\) URL/);
  });

  it('does not echo userinfo or a query into the error', () => {
    for (const url of ['https://user:s3cret@evil.example/v1', 'https://u:p/ss@evil.example/v1', 'https://evil.example/v1?key=s3cret', 'user:s3cret@evil.example']) {
      let message = '';
      try { parseConfig(decision(url)); } catch (error) { message = (error as Error).message; }
      expect(message).toMatch(/absolute http\(s\) URL|query string or fragment/);
      expect(message).not.toContain('s3cret');
      expect(message).not.toContain('ss@');
    }
  });

  it('stores a plain URL without its trailing slash', () => {
    expect(parseConfig(decision('https://decide.example/')).autoRoute?.baseUrl).toBe('https://decide.example');
  });
});

describe('the wizard\'s URL check is the parser\'s check', () => {
  it.each([
    'http://ollama_server:11434/v1', 'https://bücher.example/v1', 'HTTPS://Example.COM/v1',
    '  https://a.example/v1  ', 'https://openrouter.ai\\@evil.example/api/v1', 'https://a.example/?q=1',
  ])('answers %j the same as the parser does', (url) => {
    let parsed: string | undefined;
    try {
      parsed = gatewayBase(url);
    } catch {
      parsed = undefined;
    }
    expect(canonicalBaseUrlOrUndefined(url)).toBe(parsed);
  });
});

// The parsers the stored href is sent through, pinned against the real client:
// sonata's own LiteLLM venv. Skipped where the venv is not installed. httpx's
// `.host` is the Unicode display form; `raw_host` is the bytes sent, which is
// what has to agree with Node's href.
const venvPython = join(homedir(), '.config', 'sonata', 'litellm', 'bin', 'python');
describe.skipIf(!existsSync(venvPython))('the parsers a checked URL is sent through', () => {
  const httpxRawHost = (url: string): string => execFileSync(
    venvPython,
    ['-I', '-c', 'import httpx, sys; print(httpx.URL(sys.argv[1]).raw_host.decode())', url],
    { encoding: 'utf8' },
  ).trim();

  it('httpx reads the backslash form as host evil.example, where Node reads openrouter.ai', () => {
    const url = 'https://openrouter.ai\\\\@evil.example/api/v1';
    expect(httpxRawHost(url)).toBe('evil.example');
    expect(new URL(url).host).toBe('openrouter.ai');
  });

  it('httpx sends the underscore host and the punycode host as Node\'s href names them', () => {
    const underscore = gatewayBase('http://ollama_server:11434/v1') ?? '';
    expect(httpxRawHost(underscore)).toBe(new URL(underscore).hostname);
    expect(httpxRawHost(underscore)).toBe('ollama_server');
    const idn = gatewayBase('https://bücher.example/v1') ?? '';
    expect(httpxRawHost(idn)).toBe(new URL(idn).hostname);
    expect(httpxRawHost(idn)).toBe('xn--bcher-kva.example');
  });
});
