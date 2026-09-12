import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, loadConfig } from '../../src/config.js';
import { agentRows, cmdAgents, itemLabel, rankableKeys, renderAgents, writeTiers } from '../../src/commands/agents.js';
import { tierRows } from '../../src/tui-ink/agents-app.js';

const toml = [
  'schema_version = 1',
  '',
  '[native.gateways."acme"]',
  'base_url = "https://acme.example/v1"',
  'pricing_provider = ["openrouter"]',
  '',
  '[models."acme-big"]',
  'gateway = "acme"',
  'id = "big"',
  'context_window = 1000000',
  '',
  '[models."acme-small"]',
  'gateway = "acme"',
  'id = "small"',
  'context_window = 128000',
  '',
  '[models."kimi"]',
  'harness = "opencode"',
  'id = "openrouter/kimi"',
  '',
  '[tiers.code]',
  'simple = ["acme-small", "acme-big"]',
  'complex = ["acme-big"]',
  '',
  '[tiers.review]',
  'simple = ["acme-big"]',
  'complex = ["acme-big"]',
  '',
].join('\n');

let cwd: string;
let home: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-agents-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'sonata-agents-home-'));
  writeFileSync(join(cwd, 'sonata.toml'), toml);
});

describe('agentRows', () => {
  it('is agent-shaped: a role whose lists match collapses to one row', () => {
    const rows = agentRows(parseConfig(toml));
    expect(rows.map((r) => r.agent)).toEqual(['code-simple', 'code-complex', 'review']);
  });

  it('marks the [1m] suffix exactly where sync would write it', () => {
    const rows = agentRows(parseConfig(toml));
    // code-simple falls back to a 128K model, so the alias may not claim 1M —
    // the claim has to hold for whichever candidate actually answers.
    expect(rows.find((r) => r.agent === 'code-simple')?.extendedContext).toBe(false);
    expect(rows.find((r) => r.agent === 'code-complex')?.extendedContext).toBe(true);
    expect(rows.find((r) => r.agent === 'review')?.extendedContext).toBe(true);
  });

  it('resolves each key to its gateway, id and window, in rank order', () => {
    const row = agentRows(parseConfig(toml)).find((r) => r.agent === 'code-simple');
    expect(row?.models.map((m) => m.key)).toEqual(['acme-small', 'acme-big']);
    expect(row?.models[0]).toMatchObject({ route: 'native', gateway: 'acme', id: 'small', contextWindow: 128000 });
  });

  // `parseConfig` refuses both of the next two shapes, so neither can reach
  // here from a file that loads. They are reachable from a config object built
  // in memory, and a view that silently drew a blank row for either would be
  // the worst possible answer to "why does this agent never run".
  it('reports a key that names no model rather than hiding it', () => {
    const config = { ...parseConfig(toml), tiers: { review: { simple: ['gone'], complex: ['gone'] } } };
    const row = agentRows(config).find((r) => r.agent === 'review');
    expect(row?.models[0].route).toBe('missing');
    expect(renderAgents(agentRows(config)).join('\n')).toContain('names no model');
  });

  it('says so when a tier is empty, because every dispatch to it exhausts', () => {
    const config = { ...parseConfig(toml), tiers: { review: { simple: [], complex: [] } } };
    expect(renderAgents(agentRows(config)).join('\n')).toContain('no models');
  });
});

describe('tierRows', () => {
  // The editor lists each list separately — a collapsed pair has to be
  // openable on its own or the tiers could never be made to differ again.
  it('is list-shaped, and names the agent file each row lands in', () => {
    const config = parseConfig(toml);
    const rows = tierRows(config, config.tiers!);
    expect(rows.map((r) => `${r.role}-${r.tier}`)).toEqual(['code-simple', 'code-complex', 'review-simple', 'review-complex']);
    expect(rows.find((r) => r.role === 'review' && r.tier === 'simple')?.agent).toBe('review');
    expect(rows.find((r) => r.role === 'code' && r.tier === 'simple')?.agent).toBe('code-simple');
  });
});

describe('writeTiers', () => {
  it('writes the new ranking and regenerates the agent files', () => {
    const res = writeTiers({ cwd, home }, {
      code: { simple: ['acme-big'], complex: ['acme-big'] },
      review: { simple: ['acme-big'], complex: ['acme-big'] },
    });
    expect(loadConfig(cwd, home).tiers?.code.simple).toEqual(['acme-big']);
    // Both roles now collapse, so sync writes one file each.
    expect(res.agentsWritten.map((p) => p.split('/').pop()).sort()).toEqual(['code.md', 'review.md']);
  });

  // The reason this edits text instead of round-tripping through
  // `nativeTomlFor`: a second writer that rebuilds the file can only preserve
  // what its reconstruction recovers, which is how `pricing_provider` was lost.
  it('preserves everything outside [tiers]', () => {
    writeTiers({ cwd, home }, { code: { simple: ['acme-big'], complex: ['acme-big'] } });
    const after = loadConfig(cwd, home);
    expect(after.native?.gateways?.acme.pricingProvider).toEqual(['openrouter']);
    expect(Object.keys(after.unifiedModels).sort()).toEqual(['acme-big', 'acme-small', 'kimi']);
  });

  // A rewrite that will not load leaves the user with no working config at
  // all, and the failure would surface later from an unrelated command. So the
  // result is parsed before it is written, and the file is left alone.
  it('refuses to write a config that would not load back, leaving the file untouched', () => {
    const before = readFileSync(join(cwd, 'sonata.toml'), 'utf8');
    expect(() => writeTiers({ cwd, home }, { code: { simple: ['no-such-model'], complex: ['acme-big'] } }))
      .toThrow(/unknown model/i);
    expect(readFileSync(join(cwd, 'sonata.toml'), 'utf8')).toBe(before);
  });
});

describe('cmdAgents', () => {
  const capture = (): { out: (l: string) => void; lines: string[] } => {
    const lines: string[] = [];
    return { out: (l) => lines.push(l), lines };
  };

  it('prints the view and points at a terminal when it cannot edit', async () => {
    const io = capture();
    expect(await cmdAgents({ cwd, home }, { out: io.out })).toBe(0);
    expect(io.lines.join('\n')).toContain('code-simple');
    expect(io.lines.join('\n')).toContain('run this in a terminal');
  });

  it('emits machine-readable rows with --json', async () => {
    const io = capture();
    await cmdAgents({ cwd, home, json: true }, { out: io.out });
    const parsed = JSON.parse(io.lines.join('\n')) as Array<{ agent: string }>;
    expect(parsed.map((r) => r.agent)).toEqual(['code-simple', 'code-complex', 'review']);
  });

  it('writes what the editor returns, and nothing when it is cancelled', async () => {
    const io = capture();
    await cmdAgents({ cwd, home }, { out: io.out, edit: async () => undefined });
    expect(io.lines.join('\n')).toContain('no changes written');
    expect(loadConfig(cwd, home).tiers?.code.simple).toEqual(['acme-small', 'acme-big']);

    await cmdAgents({ cwd, home }, {
      out: io.out,
      edit: async () => ({
        code: { simple: ['acme-big'], complex: ['acme-big'] },
        review: { simple: ['acme-big'], complex: ['acme-big'] },
      }),
    });
    expect(loadConfig(cwd, home).tiers?.code.simple).toEqual(['acme-big']);
  });

  it('offers every model as a ranking candidate, native routes first', () => {
    const config = parseConfig(toml);
    expect(rankableKeys(config)).toEqual(['acme-big', 'acme-small', 'kimi']);
    expect(itemLabel(config, 'acme-big')).toContain('acme/big');
    expect(itemLabel(config, 'acme-big')).toContain('1M');
  });
});
