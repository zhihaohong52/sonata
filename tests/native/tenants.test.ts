import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it, expect } from 'vitest';
import { tenantId, SONATA_PROJECT_HEADER, TenantError, TenantRegistry, canonicalConfigPath, MAX_NOTED_PROJECTS } from '../../src/native/tenants.js';
import { recordSession } from '../../src/sessions.js';

describe('tenantId', () => {
  it('is 12 lowercase hex chars, stable for the same path', () => {
    const id = tenantId('/home/u/proj/sonata.toml');
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(tenantId('/home/u/proj/sonata.toml')).toBe(id);
  });
  it('differs for a different path', () => {
    expect(tenantId('/a/sonata.toml')).not.toBe(tenantId('/b/sonata.toml'));
  });
  it('names the header and exports a typed error', () => {
    expect(SONATA_PROJECT_HEADER).toBe('x-sonata-project');
    expect(new TenantError('x')).toBeInstanceOf(Error);
    expect(new TenantError('x').name).toBe('TenantError');
  });
});


const NATIVE = (id: string) => `
[models."flash"]
gateway = "acme"
id = "${id}"
[tiers.code]
simple = ["flash"]
complex = ["flash"]
[native.gateways."acme"]
base_url = "https://gateway.example/v1"
`;

describe('TenantRegistry', () => {
  let home: string;
  let a: string;
  let b: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tenants-home-'));
    a = mkdtempSync(join(tmpdir(), 'tenants-a-'));
    b = mkdtempSync(join(tmpdir(), 'tenants-b-'));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), NATIVE('machine-model'));
    writeFileSync(join(a, 'sonata.toml'), NATIVE('a-model'));
    writeFileSync(join(b, 'sonata.toml'), NATIVE('b-model'));
  });

  it('resolves the header first, then the session, then the machine config', async () => {
    const reg = new TenantRegistry(home);
    await recordSession(home, { session: 's-b', cwd: b, started: new Date().toISOString() });
    expect(reg.resolve({ project: a, session: 's-b' }).config?.unifiedModels.flash.id).toBe('a-model');
    expect(reg.resolve({ session: 's-b' }).config?.unifiedModels.flash.id).toBe('b-model');
    expect(reg.resolve({}).config?.unifiedModels.flash.id).toBe('machine-model');
    expect(reg.resolve({ project: a }).project).toBe(a);
    // Identity is the canonical path: `tmpdir()` is itself symlinked on macOS.
    expect(reg.resolve({ project: a }).id).toBe(tenantId(realpathSync(join(a, 'sonata.toml'))));
  });

  it('a project without its own file resolves to the machine config, keeping its cwd as the project', () => {
    const plain = mkdtempSync(join(tmpdir(), 'tenants-plain-'));
    const t = new TenantRegistry(home).resolve({ project: plain });
    expect(t.configPath).toBe(realpathSync(join(home, '.config', 'sonata', 'sonata.toml')));
    expect(t.project).toBe(plain);
  });

  it('throws TenantError naming both paths when nothing resolves', () => {
    const empty = mkdtempSync(join(tmpdir(), 'tenants-empty-home-'));
    const plain = mkdtempSync(join(tmpdir(), 'tenants-plain-'));
    expect(() => new TenantRegistry(empty).resolve({ project: plain })).toThrow(TenantError);
    expect(() => new TenantRegistry(empty).resolve({ project: plain })).toThrow(new RegExp(plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('throws TenantError naming the file and the parse error for a broken config', () => {
    writeFileSync(join(a, 'sonata.toml'), '[native.gateways\n');
    expect(() => new TenantRegistry(home).resolve({ project: a })).toThrow(/sonata\.toml/);
  });

  it('known() is machine + registered sessions + noted projects, deduplicated, and skips a broken one with one log line', async () => {
    const lines: string[] = [];
    const reg = new TenantRegistry(home, { log: (l) => lines.push(l) });
    await recordSession(home, { session: 's-a', cwd: a, started: new Date().toISOString() });
    reg.noteProject(b);
    reg.noteProject(b);
    expect(reg.known().map((t) => t.configPath).sort()).toEqual([
      realpathSync(join(a, 'sonata.toml')), realpathSync(join(b, 'sonata.toml')),
      realpathSync(join(home, '.config', 'sonata', 'sonata.toml')),
    ].sort());
    writeFileSync(join(b, 'sonata.toml'), '[native.gateways\n');
    expect(reg.loadable().map((t) => t.configPath)).not.toContain(realpathSync(join(b, 'sonata.toml')));
    reg.known(); reg.known();
    expect(lines.filter((l) => l.includes(join(b, 'sonata.toml')))).toHaveLength(1);
  });

  it('unionSnapshot changes when any tenant\'s registry changes, and not otherwise', () => {
    const reg = new TenantRegistry(home);
    reg.noteProject(a);
    const before = reg.unionSnapshot();
    expect(reg.unionSnapshot()).toBe(before);
    writeFileSync(join(a, 'sonata.toml'), NATIVE('a-model-2'));
    expect(reg.unionSnapshot()).not.toBe(before);
  });

  it('summary() lists ids and paths for health', () => {
    const reg = new TenantRegistry(home);
    const machine = realpathSync(join(home, '.config', 'sonata', 'sonata.toml'));
    expect(reg.summary()).toEqual([{ id: tenantId(machine), configPath: machine }]);
  });
});

// Found by the live two-project run on 2026-09-09: the SAME machine config was
// registered as two tenants — `/private/var/.../sonata.toml` and
// `/var/.../sonata.toml` — because macOS symlinks /var to /private/var and the
// path string became the identity. One project then had duplicate litellm
// entries, an extra restart, and split cooldowns and budget attribution.
describe('TenantRegistry — one project, whatever spelling its path has', () => {
  let home: string;
  let real: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tenants-canon-home-'));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), NATIVE('machine-model'));
    real = mkdtempSync(join(tmpdir(), 'tenants-canon-real-'));
    writeFileSync(join(real, 'sonata.toml'), NATIVE('a-model'));
  });

  it('gives one id to a project reached through a symlinked parent, and lists it once', () => {
    const linkParent = mkdtempSync(join(tmpdir(), 'tenants-canon-link-'));
    const linked = join(linkParent, 'project');
    symlinkSync(real, linked);

    const reg = new TenantRegistry(home);
    const viaReal = reg.resolve({ project: real });
    const viaLink = reg.resolve({ project: linked });
    expect(viaLink.id).toBe(viaReal.id);
    expect(viaLink.configPath).toBe(viaReal.configPath);

    // Both spellings noted; the project must still appear exactly once.
    const projectEntries = reg.known().filter((t) => t.configPath === viaReal.configPath);
    expect(projectEntries).toHaveLength(1);
    expect(new Set(reg.summary().map((t) => t.id)).size).toBe(reg.summary().length);
    expect(new Set(reg.loadable().map((t) => t.id)).size).toBe(reg.loadable().length);
  });

  it('leaves an ordinary non-symlinked path resolving exactly as before', () => {
    const reg = new TenantRegistry(home);
    const t = reg.resolve({ project: real });
    expect(t.configPath).toBe(realpathSync(join(real, 'sonata.toml')));
    expect(t.config?.unifiedModels.flash.id).toBe('a-model');
    expect(t.project).toBe(real);
  });

  it('does not throw when a noted project\'s config disappears before it can be canonicalized', () => {
    const gone = mkdtempSync(join(tmpdir(), 'tenants-canon-gone-'));
    writeFileSync(join(gone, 'sonata.toml'), NATIVE('doomed'));
    const reg = new TenantRegistry(home);
    reg.resolve({ project: gone });
    rmSync(gone, { recursive: true, force: true });
    expect(() => reg.known()).not.toThrow();
    expect(() => reg.unionSnapshot()).not.toThrow();
  });
});

describe('canonicalConfigPath', () => {
  it('falls back to the given path when it cannot be resolved', () => {
    // The registry's own tests reach this only through `configPath`, which
    // falls back to the machine config when a project's file is gone — so the
    // missing-path branch needs asserting directly.
    const missing = join(tmpdir(), 'sonata-canon-does-not-exist', 'sonata.toml');
    expect(canonicalConfigPath(missing)).toBe(missing);
  });

  it('resolves a path that does exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sonata-canon-real-'));
    writeFileSync(join(dir, 'sonata.toml'), '');
    expect(canonicalConfigPath(join(dir, 'sonata.toml'))).toBe(realpathSync(join(dir, 'sonata.toml')));
  });
});

describe('TenantRegistry — the noted set is fed by a request header', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tenants-noted-home-'));
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(join(home, '.config', 'sonata', 'sonata.toml'), NATIVE('machine-model'));
  });

  it('does not note a project whose config does not resolve', () => {
    // `x-sonata-project` is client-supplied, and `known()` does filesystem work
    // per noted path on the request path. A directory that resolves to nothing
    // must not enlarge that set.
    const reg = new TenantRegistry(home);
    const nowhere = mkdtempSync(join(tmpdir(), 'tenants-noted-nowhere-'));
    const before = reg.known().length;
    // Resolves to the machine config (no project file), so nothing new is known.
    reg.resolve({ project: nowhere });
    expect(reg.known().length).toBe(before);
  });

  it('bounds the noted set rather than growing with every distinct header value', () => {
    const reg = new TenantRegistry(home);
    const made: string[] = [];
    for (let i = 0; i < MAX_NOTED_PROJECTS + 5; i += 1) {
      const dir = mkdtempSync(join(tmpdir(), `tenants-noted-${i}-`));
      writeFileSync(join(dir, 'sonata.toml'), NATIVE(`m-${i}`));
      made.push(dir);
      reg.resolve({ project: dir });
    }
    // Machine config plus at most the cap, never one per header value seen.
    expect(reg.known().length).toBeLessThanOrEqual(MAX_NOTED_PROJECTS + 1);
    // The most recent project is still served.
    expect(reg.resolve({ project: made[made.length - 1] }).config?.unifiedModels.flash.id)
      .toBe(`m-${MAX_NOTED_PROJECTS + 4}`);
  });
});
