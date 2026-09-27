import { describe, it, expect, beforeEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SONATA_TOKEN_HEADER, routerTokenPath, ensureRouterToken, readRouterToken, projectHintAuthorised,
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
  it('repairs an existing token file that is readable by others', () => {
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(routerTokenPath(home), `${'a'.repeat(64)}\n`);
    chmodSync(routerTokenPath(home), 0o644);
    expect(ensureRouterToken(home)).toBe('a'.repeat(64));
    expect(statSync(routerTokenPath(home)).mode & 0o777).toBe(0o600);
  });

  it('authorises only the exact token, whatever the lengths', () => {
    const token = 'b'.repeat(64);
    expect(projectHintAuthorised(token, token)).toBe(true);
    expect(projectHintAuthorised(`${token}x`, token)).toBe(false);
    expect(projectHintAuthorised(token.slice(1), token)).toBe(false);
    expect(projectHintAuthorised('c'.repeat(64), token)).toBe(false);
    expect(projectHintAuthorised(undefined, token)).toBe(false);
    expect(projectHintAuthorised('', '')).toBe(false);
    expect(projectHintAuthorised('é', 'e')).toBe(false);
  });
});
