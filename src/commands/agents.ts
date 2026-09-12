/**
 * `sonata agents` — see what each generated agent actually runs on, and
 * re-rank it without going back through the whole `sonata init` wizard.
 *
 * A tier is a *ranked fallback list*, and until now the only way to see or
 * change one was to read `sonata.toml` or re-run the wizard from the provider
 * screen — nine screens to reorder two models. Worse, the thing that actually
 * matters about a ranking is invisible in the file: whether every candidate
 * has a 1M window (and so whether the agent's alias carries `[1m]`), what each
 * key resolves to, and whether a key still names a model at all.
 *
 * This is a second writer of `sonata.toml`, which is the risk it is designed
 * around. It writes through `replaceTiersBlock`, which edits only the
 * `[tiers]` tables and leaves every other byte in place — see that function
 * for why a round trip through `nativeTomlFor` was rejected.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENDED_CONTEXT_SUFFIX, tierQualifiesForExtendedContext } from '../extended-context.js';
import { configPath, loadConfig, parseConfig, TIER_NAMES, tiersCollapse, type SonataConfig } from '../config.js';
import { replaceTiersBlock } from '../init/toml.js';
import { cmdSync } from './sync.js';
import { pruneAgents } from '../detect.js';

export type Tier = 'simple' | 'complex';

export interface AgentModelRow {
  key: string;
  /** How the router can reach it. `missing` means the key names no model. */
  route: 'native' | 'harness' | 'both' | 'missing';
  gateway?: string;
  id?: string;
  contextWindow?: number;
}

export interface AgentRow {
  /** The generated agent's filename and subagent type, e.g. `code-simple`. */
  agent: string;
  role: string;
  /** Absent when the role's two lists are identical and collapse to one agent. */
  tier?: Tier;
  models: AgentModelRow[];
  /** Whether the generated alias carries `[1m]`. */
  extendedContext: boolean;
}

function modelRow(config: SonataConfig, key: string): AgentModelRow {
  const model = config.unifiedModels[key];
  if (model === undefined) return { key, route: 'missing' };
  const native = model.gateway !== undefined;
  const harness = model.harness !== undefined;
  return {
    key,
    route: native && harness ? 'both' : native ? 'native' : harness ? 'harness' : 'missing',
    gateway: model.gateway ?? model.harness,
    id: model.id ?? model.harnessId,
    contextWindow: model.contextWindow,
  };
}

/**
 * One row per generated agent, in the order `sync` writes them.
 *
 * Derived with the same predicates `sync` uses — `tiersCollapse` for whether a
 * role is one agent or two, `tierQualifiesForExtendedContext` for the `[1m]`
 * suffix — rather than re-deriving either. A view that disagrees with the
 * files on disk about what exists is worse than no view.
 */
export function agentRows(config: SonataConfig): AgentRow[] {
  const rows: AgentRow[] = [];
  for (const [role, lists] of Object.entries(config.tiers ?? {})) {
    if (tiersCollapse(lists)) {
      rows.push({
        agent: role,
        role,
        models: lists.simple.map((key) => modelRow(config, key)),
        // A collapsed alias serves both lists, so it may claim only the window
        // both can honour — the same rule `sync` applies.
        extendedContext: tierQualifiesForExtendedContext(config, lists.simple)
          && tierQualifiesForExtendedContext(config, lists.complex),
      });
      continue;
    }
    for (const tier of TIER_NAMES) {
      rows.push({
        agent: `${role}-${tier}`,
        role,
        tier,
        models: lists[tier].map((key) => modelRow(config, key)),
        extendedContext: tierQualifiesForExtendedContext(config, lists[tier]),
      });
    }
  }
  return rows;
}

function windowLabel(window: number | undefined): string {
  if (window === undefined) return 'window unknown';
  return window >= 1_000_000
    ? `${Math.round(window / 1_000_000)}M`
    : `${Math.round(window / 1000)}K`;
}

/** The rows as printable lines. */
export function renderAgents(rows: AgentRow[]): string[] {
  if (rows.length === 0) {
    return ['no tier agents — this config has no [tiers]. Run `sonata init`.'];
  }
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(`${row.agent}${row.extendedContext ? `  ${EXTENDED_CONTEXT_SUFFIX}` : ''}`);
    if (row.models.length === 0) {
      // An empty tier is not cosmetic: the alias resolves to nothing and every
      // dispatch to it exhausts immediately with the 529 fallback message.
      lines.push('    (no models — every dispatch to this agent falls through to `sonata dispatch`)');
      continue;
    }
    row.models.forEach((model, index) => {
      const detail = model.route === 'missing'
        ? '! names no model in [models] — this candidate is skipped'
        : `${model.gateway}/${model.id}  ${windowLabel(model.contextWindow)}${model.route === 'harness' ? '  harness only' : ''}`;
      lines.push(`    ${index + 1}. ${model.key.padEnd(28)} ${detail}`);
    });
  }
  return lines;
}

export interface AgentsOptions {
  cwd: string;
  home: string;
}

/**
 * Persist a new set of tier rankings and regenerate the agent files.
 *
 * Read-modify-write against the file `loadConfig` resolved, so the config a
 * worktree borrows from its main checkout is the one edited — the same file
 * every other command in that directory reads. The result is parsed back
 * before it is written: a rewrite that would not load is a rewrite that leaves
 * the user with no working config at all, and the failure would surface later,
 * from an unrelated command.
 */
export function writeTiers(
  opts: AgentsOptions,
  tiers: Record<string, { simple: string[]; complex: string[] }>,
  /**
   * The `[tiers]` the editor opened on.
   *
   * The editor holds a whole-config snapshot and returns all of it, so the
   * write replaces *every* tier table — including ones this session never
   * opened. If something else edited the file meanwhile (another `sonata
   * init`, a hand edit, a second terminal), those tables would be silently
   * reverted to a snapshot taken before the change. Compared here rather than
   * merged: merging means choosing between two rankings without being able to
   * ask, and a ranking is exactly the kind of deliberate ordering that must
   * not be guessed at.
   */
  expect?: Record<string, { simple: string[]; complex: string[] }>,
): { path: string; agentsWritten: string[]; pruned: string[]; skipped: string[] } {
  const path = configPath(opts.cwd, opts.home);
  if (path === undefined || path === null) throw new Error('no sonata.toml found — run `sonata init`');
  const text = readFileSync(path, 'utf8');

  if (expect !== undefined) {
    const current = parseConfig(text).tiers ?? {};
    if (JSON.stringify(current) !== JSON.stringify(expect)) {
      throw new Error(
        `${path} changed while the editor was open — nothing written. `
        + 'Re-run `sonata agents` to re-rank against the current config.',
      );
    }
  }

  const next = replaceTiersBlock(text, tiers);
  parseConfig(next);
  writeFileSync(path, next);

  // A ranking change can move a role between one collapsed agent and two tier
  // agents, and the files for the shape it left are sonata's own, now stale:
  // Claude Code goes on offering `code-simple` as a subagent type whose alias
  // no longer resolves, so a dispatch to it fails rather than falling back.
  // `sync` reports them and deliberately does not delete them; here the
  // command that just caused them removes them and says which.
  const agentsDir = agentsDirOf(opts);
  const sync = cmdSync({ cwd: opts.cwd, home: opts.home, agentsDir });
  const pruned = sync.stale.length > 0 ? pruneAgents(agentsDir, sync.stale) : [];
  // A file sonata does not own sitting on a target path is left untouched by
  // `sync` — correctly, it is not sonata's to overwrite. But reporting the new
  // ranking without saying so would claim an agent that still holds unrelated
  // content, which is the one way this command can lie about what it did.
  return { path, agentsWritten: sync.written, pruned, skipped: sync.skipped };
}

/** Where this project's agents live. Mirrors what `sonata sync` uses. */
function agentsDirOf(opts: AgentsOptions): string {
  return join(opts.cwd, '.claude', 'agents');
}

/** Every model key this config could rank, native routes first. */
export function rankableKeys(config: SonataConfig): string[] {
  const keys = Object.keys(config.unifiedModels);
  return [
    ...keys.filter((k) => config.unifiedModels[k].gateway !== undefined),
    ...keys.filter((k) => config.unifiedModels[k].gateway === undefined),
  ];
}

export function loadAgentsView(opts: AgentsOptions): { config: SonataConfig; rows: AgentRow[] } {
  const config = loadConfig(opts.cwd, opts.home);
  return { config, rows: agentRows(config) };
}

export interface AgentsIo {
  out: (line: string) => void;
  /** `undefined` when the session has no TTY, so the view stays read-only. */
  edit?: (input: {
    config: SonataConfig;
    initialTiers: Record<string, { simple: string[]; complex: string[] }>;
    items: Array<{ value: string; label: string }>;
  }) => Promise<Record<string, { simple: string[]; complex: string[] }> | undefined>;
}

/** A ranking row's label: the key, what it resolves to, and its window. */
export function itemLabel(config: SonataConfig, key: string): string {
  const row = modelRow(config, key);
  return row.route === 'missing'
    ? `${key}  (names no model)`
    : `${key.padEnd(28)} ${row.gateway}/${row.id}  ${windowLabel(row.contextWindow)}`;
}

export async function cmdAgents(
  opts: AgentsOptions & { json?: boolean; list?: boolean },
  io: AgentsIo,
): Promise<number> {
  const { config, rows } = loadAgentsView(opts);

  if (opts.json === true) {
    io.out(JSON.stringify(rows, null, 2));
    return 0;
  }

  if (opts.list === true || io.edit === undefined || config.tiers === undefined) {
    for (const line of renderAgents(rows)) io.out(line);
    // A read-only view that does not say why it is read-only reads as a
    // missing feature rather than a missing terminal.
    if (io.edit === undefined && config.tiers !== undefined) {
      io.out('');
      io.out('  ❯ run this in a terminal to re-rank a tier');
    }
    return 0;
  }

  const next = await io.edit({
    config,
    initialTiers: config.tiers,
    items: rankableKeys(config).map((key) => ({ value: key, label: itemLabel(config, key) })),
  });
  if (next === undefined) {
    for (const line of renderAgents(rows)) io.out(line);
    io.out('');
    io.out('  · no changes written');
    return 0;
  }

  const written = writeTiers(opts, next, config.tiers);
  io.out(`  ✓ wrote ${written.path}`);
  io.out(`  ✓ regenerated ${written.agentsWritten.length} agents`);
  for (const file of written.pruned) io.out(`  ✓ removed ${file} — its tier no longer generates that agent`);
  if (written.skipped.length > 0) {
    io.out(`  ! ${written.skipped.length} agent file(s) were NOT written — they exist and are not sonata-generated:`);
    for (const file of written.skipped) io.out(`      ${file}`);
    io.out('      ❯ the ranking below is what the config now says; those agents still hold their own content');
  }
  for (const line of renderAgents(agentRows(loadConfig(opts.cwd, opts.home)))) io.out(line);
  return 0;
}
