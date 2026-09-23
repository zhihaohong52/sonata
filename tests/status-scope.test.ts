import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectTenant, scopeRows } from '../src/commands/status.js';
import { canonicalConfigPath, tenantId } from '../src/native/tenants.js';
import type { LedgerRow } from '../src/ledger.js';

const row = (tenant: string | undefined, key: string): LedgerRow => ({
  ts: '2026-09-23T00:00:00.000Z', ms: 1, alias: 'sonata-code-simple', key,
  upstream: 'litellm', status: 200, complete: true,
  tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
  price: { source: 'none' }, attempts: [], tenant,
});

/** A home with no machine config, so only a project's own config can resolve. */
const emptyHome = (): string => mkdtempSync(join(tmpdir(), 'scope-home-'));

describe('projectTenant', () => {
  it('matches the id the router writes for the same config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scope-proj-'));
    writeFileSync(join(dir, 'sonata.toml'), 'schema_version = 1\n');
    expect(projectTenant(dir, emptyHome())).toBe(tenantId(canonicalConfigPath(join(dir, 'sonata.toml'))));
  });

  it('is the same project under a symlinked spelling', () => {
    // The reason this resolves through the router's identity rather than a
    // cwd string: two spellings of one repository are one tenant.
    const dir = mkdtempSync(join(tmpdir(), 'scope-real-'));
    writeFileSync(join(dir, 'sonata.toml'), 'schema_version = 1\n');
    const link = join(mkdtempSync(join(tmpdir(), 'scope-link-')), 'alias');
    symlinkSync(dir, link);
    const home = emptyHome();
    expect(projectTenant(link, home)).toBe(projectTenant(dir, home));
  });

  it('is undefined when no config resolves at all', () => {
    // Nothing can be attributed to "this project" — the router answers such
    // a request with a 400 and writes no row.
    expect(projectTenant(mkdtempSync(join(tmpdir(), 'scope-none-')), emptyHome())).toBeUndefined();
  });

  it('falls back to the machine config, as the router does', () => {
    const home = emptyHome();
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), 'schema_version = 1\n');
    const bare = mkdtempSync(join(tmpdir(), 'scope-bare-'));
    expect(projectTenant(bare, home))
      .toBe(tenantId(canonicalConfigPath(join(home, '.config', 'sonata', 'sonata.toml'))));
  });
});

describe('scopeRows', () => {
  const rows = [row('mine', 'a'), row('theirs', 'b'), row(undefined, 'c')];

  it('keeps only the named tenant', () => {
    expect(scopeRows(rows, { global: false, tenant: 'mine' }).map((r) => r.key)).toEqual(['a']);
  });

  it('never counts an unattributed row as this project', () => {
    expect(scopeRows(rows, { global: false, tenant: 'mine' }).some((r) => r.key === 'c')).toBe(false);
  });

  it('keeps everything when global', () => {
    expect(scopeRows(rows, { global: true }).map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('shows nothing when no tenant resolved', () => {
    expect(scopeRows(rows, { global: false, tenant: undefined })).toEqual([]);
  });
});
