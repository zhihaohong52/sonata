import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { parseOpenCodeProviderBaseUrls } from '../../src/detect.js';
import { validateCustomProviderName, validateProviderUrl } from '../../src/tui-ink/app-state.js';
import { canonicalBaseUrlOrUndefined } from '../../src/native/base-url.js';

const URLS = [
  'http://ollama_server:11434/v1', 'https://bücher.example/v1', 'HTTPS://Example.COM/v1',
  '  https://a.example/v1  ', 'https://openrouter.ai\\@evil.example/api/v1', 'https://user@evil.example',
  'https://evil%2Eexample/v1', 'https://a.example/?q=1', 'https://a.example/#x', 'ftp://a.example',
  'https://a.example/v1', 'http://localhost:4000', 'https://a.example\tb',
];

describe('the wizard URL check is the parser\'s check', () => {
  it.each(URLS)('answers %j the same as the parser does', (url) => {
    let parsed: string | undefined;
    try {
      parsed = parseConfig(`[native.gateways."acme"]\nbase_url = ${JSON.stringify(url)}\n`).native?.gateways.acme?.baseUrl;
    } catch {
      parsed = undefined;
    }
    expect(canonicalBaseUrlOrUndefined(url)).toBe(parsed);
    expect(validateProviderUrl(url) === undefined).toBe(parsed !== undefined);
  });

  it('gives a reason for a refused URL', () => {
    expect(validateProviderUrl('https://user@evil.example')).toMatch(/refused: a backslash or @ is not allowed/);
    expect(validateProviderUrl('https://a.example/?q=1')).toMatch(/query string or fragment/);
  });
});

describe('the wizard name check is the parser\'s name check', () => {
  it.each(['constructor', 'seeded', '__proto__'])('refuses %s, as the parser does', (name) => {
    expect(validateCustomProviderName(name, [])).toBeDefined();
    expect(() => parseConfig(`[native.gateways."${name}"]\nbase_url = "https://a.example/v1"\n`)).toThrow(/is not allowed/);
  });

  it('accepts a name with a space, as the parser does', () => {
    expect(validateCustomProviderName('bad name', [])).toBeUndefined();
    expect(parseConfig('[native.gateways."bad name"]\nbase_url = "https://a.example/v1"\n').native?.gateways['bad name']).toBeDefined();
  });
});

describe('opencode.json providers the parser would refuse', () => {
  it('skips them and names each one', () => {
    const refused: string[] = [];
    const text = JSON.stringify({
      provider: {
        constructor: { options: { baseURL: 'https://a.example/v1' } },
        evil: { options: { baseURL: 'https://evil%2E.example/v1' } },
        ok: { options: { baseURL: 'https://ok.example/v1' } },
      },
    });
    const urls = parseOpenCodeProviderBaseUrls(text, refused);
    expect(urls.ok).toBe('https://ok.example/v1');
    expect(Object.prototype.hasOwnProperty.call(urls, 'constructor')).toBe(false);
    expect(urls.evil).toBeUndefined();
    expect(refused).toHaveLength(2);
    expect(refused.join('\n')).toMatch(/"constructor" is skipped/);
    expect(refused.join('\n')).toMatch(/"evil" is skipped/);
  });
});
