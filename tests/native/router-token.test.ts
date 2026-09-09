import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SONATA_TOKEN_HEADER, routerTokenPath, ensureRouterToken, readRouterToken,
} from '../../src/native/router-token.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-token-')); });

describe('router token', () => {
  it('names the header it travels in', () => {
    expect(SONATA_TOKEN_HEADER).toBe('x-sonata-token');
  });

  it('creates a token owner-only, and returns the same one on a second call', () => {
    const first = ensureRouterToken(home);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // 0600: the whole defence is that a process which cannot read this file
    // cannot select a project — a different local user, or a sandbox.
    expect(statSync(routerTokenPath(home)).mode & 0o777).toBe(0o600);
    expect(ensureRouterToken(home)).toBe(first);
    expect(readRouterToken(home)).toBe(first);
  });

  it('survives across processes, so settings written once keep working', () => {
    const token = ensureRouterToken(home);
    expect(readFileSync(routerTokenPath(home), 'utf8').trim()).toBe(token);
  });

  it('reads undefined when no token has been written', () => {
    expect(readRouterToken(home)).toBeUndefined();
  });

  it('replaces a blank or truncated token rather than trusting it', () => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(routerTokenPath(home), '   \n');
    expect(ensureRouterToken(home)).toMatch(/^[0-9a-f]{64}$/);
  });
});
