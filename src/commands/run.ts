import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { configPath as resolveSonataConfigPath, loadConfig, harnessModelFor, isReadOnlyRole } from '../config.js';
import { worktreeFingerprint } from '../worktree.js';
import { getAdapter } from '../adapters/index.js';
import { createRun, runDir, writeMeta } from '../store.js';
import { loadRole, composeInstructions } from '../roles.js';
import { reportPathFor } from '../report-contract.js';
import { readPermissionMode } from '../mode.js';
import { newSession, runScript } from '../tmux.js';
import { wrapWithTimeout } from '../watchdog.js';
import { isSonataRouter, sonataRouterConfigPath, startServeDaemon } from './serve.js';
import { homedir } from 'node:os';

export interface RunOptions {
  cwd: string;
  role: string;
  model: string;
  taskFile: string;
  rolesDir: string;
  sessionId: string | undefined;
}

export interface RunResult {
  id: string;
  session: string;
  interactive: boolean;
}

export const MAX_REPO_CONTEXT_CHARS = 24_000;

export function repoContext(cwd: string): string {
  const parts: string[] = [];
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;

    const header = `### ${name}\n\n`;
    const content = readFileSync(p, 'utf8').trim();
    const current = parts.join('\n\n');
    const separator = current.length === 0 ? '' : '\n\n';
    const marker = `\n\n[truncated: ${name} exceeded the ${MAX_REPO_CONTEXT_CHARS}-character repository context limit]`;
    const available = MAX_REPO_CONTEXT_CHARS - current.length - separator.length - header.length;

    if (content.length <= available) {
      parts.push(`${header}${content}`);
      continue;
    }

    // Large repository instructions bury the actual task and cause models to miss it.
    parts.push(`${header}${content.slice(0, Math.max(0, available - marker.length))}${marker}`);
    break;
  }
  return parts.join('\n\n');
}

/**
 * Whether the working directory still has a stale sonata MCP registration.
 *
 * Reasonix — and any harness that reads a project `.mcp.json` — loads those
 * servers on top of its own config. A stale registration can therefore expose
 * a removed server to dispatched models and should be cleaned up by the user.
 *
 * There is no per-run way to withhold them: `reasonix run` has no deny flag,
 * and `reasonix mcp disable` writes the user's own config, which is not
 * sonata's to edit. So this is detection feeding an instruction, not
 * enforcement — said plainly here so nobody mistakes it for a guarantee.
 */
export function exposesSonataTools(cwd: string): boolean {
  const path = join(cwd, '.mcp.json');
  if (!existsSync(path)) return false;
  try {
    const servers = JSON.parse(readFileSync(path, 'utf8'))?.mcpServers ?? {};
    return Object.entries(servers).some(([name, def]) =>
      name === 'sonata'
      || JSON.stringify(def ?? '').includes('sonata'));
  } catch {
    // An unreadable .mcp.json is not sonata's to repair, and guessing that it
    // exposes nothing would be the unsafe direction.
    return true;
  }
}

/** Ensure the native proxy is up when dispatching to the claude harness. */
export async function ensureNativeServe(cwd: string): Promise<void> {
  const config = loadConfig(cwd);
  if (!config.native) {
    throw new Error(
      'sonata: the claude harness requires a [native] table in sonata.toml. ' +
      'Run `sonata init` to configure native models.',
    );
  }
  const port = config.native.ports.router;
  const expectedConfigPath = resolveSonataConfigPath(cwd, homedir());
  const running = await isSonataRouter(port);
  if (running) {
    // Two projects can share the same default router port; a router
    // already answering here is not proof it is THIS project's — verify
    // which sonata.toml actually started it before trusting it, the same
    // check cmdRouteSession's auto-mode path already makes. A router that
    // cannot or does not report its own configPath is treated the same as
    // a mismatch, not silently trusted.
    const actualConfigPath = await sonataRouterConfigPath(port);
    if (expectedConfigPath !== null && (actualConfigPath === null || actualConfigPath !== expectedConfigPath)) {
      throw new Error(
        actualConfigPath === null
          ? `sonata: router port ${port} answered but did not report which sonata configuration ` +
            `it is running (too old, or its own config resolution failed) — refusing to trust it. ` +
            `Restart it with \`sonata restart\` once confirmed to be this project's own router.`
          : `sonata: router port ${port} is already serving a different sonata configuration ` +
            `(${actualConfigPath}) than this project resolves to (${expectedConfigPath}). ` +
            `Two projects cannot share one router port — set a different [native.ports].router ` +
            `in one of the two configs.`,
      );
    }
    return;
  }
  await startServeDaemon(homedir(), ['sonata', 'serve', '--daemon'], {}, cwd);
  // A concurrent dispatch in another project could have won the race to
  // bind this same default port with ITS daemon between the probe above
  // and this daemon spawn's poll completing — verify identity again now
  // that something is confirmed to be listening. A router that cannot or
  // does not report its own configPath is treated the same as a mismatch,
  // not silently trusted.
  const startedConfigPath = await sonataRouterConfigPath(port);
  if (expectedConfigPath !== null && (startedConfigPath === null || startedConfigPath !== expectedConfigPath)) {
    throw new Error(
      startedConfigPath === null
        ? `sonata: router port ${port} answered but did not report which sonata configuration ` +
          `it is running (too old, or its own config resolution failed) — refusing to trust it. ` +
          `Restart it with \`sonata restart\` once confirmed to be this project's own router.`
        : `sonata: router port ${port} is already serving a different sonata configuration ` +
          `(${startedConfigPath}) than this project resolves to (${expectedConfigPath}). ` +
          `Two projects cannot share one router port — set a different [native.ports].router ` +
          `in one of the two configs.`,
    );
  }
}

export async function cmdRun(opts: RunOptions): Promise<RunResult> {
  const config = loadConfig(opts.cwd);

  let modelCfg = config.models[opts.model];

  // A native model key dispatches through the claude harness automatically —
  // no separate [models] entry needed. The claude adapter runs `claude -p`
  // with the proxy env, so the native model reaches its gateway.
  if (!modelCfg) {
    const harness = harnessModelFor(config, opts.model);
    if (harness) modelCfg = harness;
  }

  if (!modelCfg && config.native?.models[opts.model]) {
    modelCfg = { harness: 'claude', id: opts.model };
  }

  // A native-only unified [models."x"] entry (gateway + id, no harness)
  // populates config.unifiedModels but NOT the legacy config.native?.models
  // table checked above — a config with no [tiers] table at all can still
  // declare one, and it is fully reachable via sonata serve's LiteLLM
  // config, just not by this lookup until now.
  if (!modelCfg) {
    const unified = config.unifiedModels[opts.model];
    if (unified?.gateway !== undefined && unified.id !== undefined) {
      modelCfg = { harness: 'claude', id: opts.model };
    }
  }

  if (!modelCfg) {
    const all = [
      ...Object.keys(config.models),
      ...Object.keys(config.native?.models ?? {}),
    ];
    throw new Error(
      `sonata: unknown model "${opts.model}". ` +
      `Defined models: ${all.join(', ')}`,
    );
  }

  const adapter = getAdapter(modelCfg.harness);

  if (adapter.name === 'claude') await ensureNativeServe(opts.cwd);

  const mode = readPermissionMode(opts.cwd, opts.sessionId);
  const task = readFileSync(opts.taskFile, 'utf8');

  const meta = createRun(opts.cwd, {
    role: opts.role,
    model: opts.model,
    harness: adapter.name,
    mode,
    interactive: false,
    startedAt: new Date().toISOString(),
  });

  const dir = runDir(opts.cwd, meta.id);
  const instructionsPath = join(dir, 'instructions.md');

  // The plan comes first because it decides whether a report is possible at
  // all, and the instructions must not ask for one that cannot be written.
  // `adapter.plan` only takes the instructions path, never its contents, so
  // nothing here depends on the file existing yet.
  const plan = adapter.plan({
    modelId: modelCfg.id,
    role: opts.role,
    mode,
    cwd: opts.cwd,
    runDir: dir,
    instructionsPath,
  });

  writeFileSync(instructionsPath, composeInstructions({
    role: opts.role,
    roleText: loadRole(opts.role, opts.rolesDir),
    repoContext: repoContext(opts.cwd),
    task,
    reportPath: reportPathFor(dir),
    canWriteReport: plan.canWriteReport ?? true,
    inheritedSonataTools: exposesSonataTools(opts.cwd),
  }));

  const harnessPath = join(dir, 'harness.sh');
  writeFileSync(harnessPath, plan.script, { mode: 0o755 });

  const scriptPath = join(dir, 'cmd.sh');
  writeFileSync(scriptPath, wrapWithTimeout({
    harnessScriptPath: harnessPath,
    runDir: dir,
    timeoutSeconds: config.run.runTimeoutSeconds,
    interactive: plan.interactive,
  }), { mode: 0o755 });

  writeMeta(opts.cwd, {
    ...meta,
    interactive: plan.interactive,
    canWriteReport: plan.canWriteReport ?? true,
    silentUntilExit: plan.silentUntilExit ?? false,
    // Sampled here, not before `createRun`, so that sonata's own scaffolding —
    // the run directory and the three files just written into it — is already
    // on disk in this sample as it will be in the one tail takes at exit. A
    // repository that does not ignore `.sonata/` would otherwise show it
    // appearing between the two samples and every run would look changed,
    // which fails in the useless direction: never flagging anything.
    worktreeAtLaunch: isReadOnlyRole(opts.role) ? undefined : worktreeFingerprint(opts.cwd),
  });

  await newSession({ session: meta.session, cwd: opts.cwd });
  await runScript(meta.session, scriptPath);

  return { id: meta.id, session: meta.session, interactive: plan.interactive };
}
