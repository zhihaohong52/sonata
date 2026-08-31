import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  installHook, allowSonataTools, hookCommand, readSettings, settingsPath, writeSettings,
} from '../settings.js';
import { pruneAgents } from '../detect.js';
import { cmdSync } from '../commands/sync.js';
import { cmdRoute } from '../commands/route.js';
import { writeSonataKey } from '../native/credentials.js';
import type { InitPlan } from './plan.js';
import type { InitOptions } from './helpers.js';

export interface ApplyIo {
  out: (line: string) => void;
  /** Stale agents are only known after cmdSync runs, so prune cannot be pre-planned. */
  prune: boolean | ((stale: string[]) => Promise<boolean>);
}

export async function apply(
  plan: InitPlan,
  opts: Pick<InitOptions, 'cwd' | 'home' | 'packageRoot'>,
  io: ApplyIo,
): Promise<{
  agentsWritten: string[];
  pruned: string[];
  hookChanged: boolean;
}> {
  const { cwd, home, packageRoot } = opts;

  // ---- credentials (first, so a partially-failed run still leaves keys behind) ----
  // Keys typed in the wizard are stored here and nowhere earlier: a cancelled
  // run must leave no credential behind. The gateway is printed, never the key.
  for (const { gateway, key } of plan.keysToStore) {
    writeSonataKey(home, gateway, key);
    io.out(`  ✓ stored the key for ${gateway}`);
  }

  // ---- config ----
  mkdirSync(dirname(plan.configPath), { recursive: true });
  writeFileSync(plan.configPath, plan.configToml);
  io.out(`  ✓ wrote ${plan.configPath}`);

  // ---- settings (hook + allow-list) ----
  let hookChanged = false;
  // `runInit` resolves `allowListScope` against `env.existingHookScope`
  // (an upgrade from the MCP-based release otherwise keeps its old
  // mcp__sonata__* entries forever, since "hook already installed" used to
  // mean skipping this whole block) and writes the result onto the plan.
  if (plan.hook.allowListScope !== undefined && plan.hook.allowListScope !== 'skip') {
    const allowListScope = plan.hook.allowListScope;
    const path = settingsPath(allowListScope, cwd, home);
    const cmd = hookCommand(packageRoot);
    const withHook = plan.hook.scope !== 'skip'
      ? installHook(readSettings(path), cmd)
      : { settings: readSettings(path), changed: false };
    const withAllow = allowSonataTools(withHook.settings);
    if (withHook.changed || withAllow.changed) writeSettings(path, withAllow.settings);
    hookChanged = withHook.changed;
    if (plan.hook.scope !== 'skip') {
      io.out(withHook.changed ? `  ✓ installed hook in ${path}` : `  · hook already present in ${path}`);
    }
    io.out(withAllow.changed
      ? `  ✓ allow-listed the sonata tools in ${path}`
      : `  · sonata tools already allow-listed in ${path}`);
  }

  // ---- skill ----
  mkdirSync(dirname(plan.skillPath), { recursive: true });
  const packageSkill = join(packageRoot, 'skills', 'loop', 'SKILL.md');
  const skillSource = existsSync(packageSkill)
    ? packageSkill
    : join(process.cwd(), 'skills', 'loop', 'SKILL.md');
  writeFileSync(plan.skillPath, readFileSync(skillSource));
  io.out(`  ✓ installed loop skill in ${plan.skillPath}`);

  // ---- routing ----
  if (plan.routing !== 'skip') {
    await cmdRoute('auto', {
      cwd,
      home,
      packageRoot,
      scope: plan.routing,
    });
    io.out(`  ✓ configured sonata route auto${plan.routing === 'global' ? ' --global' : ''}`);
  }

  // ---- sync (generates agent files) ----
  const sync = cmdSync({ cwd: plan.syncCwd, home, agentsDir: plan.agentsDir });
  const agentsWritten = sync.written;
  io.out(`  ✓ generated ${agentsWritten.length} agents in ${plan.agentsDir}`);

  if (sync.skipped.length > 0) {
    io.out('');
    io.out(`  ! ${sync.skipped.length} existing agent file(s) were NOT overwritten (not sonata-generated):`);
    for (const f of sync.skipped.slice(0, 5)) io.out(`      ${f}`);
    if (sync.skipped.length > 5) io.out(`      … and ${sync.skipped.length - 5} more`);
  }

  // ---- prune (after sync, since stale files are only known now) ----
  const stale = sync.stale;
  let pruned: string[] = [];
  if (stale.length > 0) {
    io.out('');
    io.out(`  ! ${stale.length} stale agent file(s) no longer in your config:`);
    for (const f of stale.slice(0, 5)) io.out(`      ${f}`);
    if (stale.length > 5) io.out(`      … and ${stale.length - 5} more`);
    const remove = typeof io.prune === 'function' ? await io.prune(stale) : io.prune;
    if (remove) {
      pruned = pruneAgents(plan.agentsDir, stale);
      io.out(`  ✓ removed ${pruned.length} stale agent file(s)`);
    } else {
      io.out('      ❯ delete them by hand, or re-run with --prune');
    }
  }

  return { agentsWritten, pruned, hookChanged };
}
