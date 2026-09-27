import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig, harnessModelFor, isReadOnlyRole } from '../config.js';
import type { Effort } from '../effort.js';
import { worktreeFingerprint } from '../worktree.js';
import { getAdapter } from '../adapters/index.js';
import { createRun, runDir, writeMeta } from '../store.js';
import { loadRole, composeInstructions } from '../roles.js';
import { reportPathFor } from '../report-contract.js';
import { readPermissionMode } from '../mode.js';
import { killSession, newSession, runScript, tryCapturePane } from '../tmux.js';
import { cleanPane } from '../normalize.js';
import type { RunMeta } from '../types.js';
import { wrapWithTimeout } from '../watchdog.js';
import { isSonataRouter, preMultiTenantMessage, sonataRouterMultiTenant, startServeDaemon } from './serve.js';
import { homedir } from 'node:os';
import { routerPorts } from './ports.js';

export interface RunOptions {
  cwd: string;
  role: string;
  model: string;
  taskFile: string;
  rolesDir: string;
  sessionId: string | undefined;
  /**
   * The level the tier candidate pinned (`<key>@<effort>`). It travels beside
   * the model key, never inside it: `harnessModelFor` resolves the bare key,
   * and each adapter decides how — or whether — to express the level.
   */
  effort?: Effort;
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

/**
 * The pane once the shell has drawn its prompt: non-empty and unchanged across
 * two captures. A fresh session's shell is still loading its rc files when
 * `new-session` returns, so one immediate capture is usually blank. Bounded,
 * and an empty answer only means tail keeps its older filters.
 */
export async function settledPane(session: string, timeoutMs = 3_000, pollMs = 50): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] | null = null;
  for (;;) {
    const raw = await tryCapturePane(session);
    const lines = raw === null ? [] : cleanPane(raw);
    if (lines.length > 0 && last !== null && lines.join('\n') === last.join('\n')) return lines;
    last = lines;
    if (Date.now() >= deadline) return lines;
    await new Promise((r) => setTimeout(r, pollMs));
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
  const home = homedir();
  const port = routerPorts(home).router;
  if (await isSonataRouter(port)) {
    if (await sonataRouterMultiTenant(port) !== true) throw new Error(preMultiTenantMessage(port));
    return;
  }
  // foreground: startServeDaemon detaches it; `--daemon` would re-daemonise under a new instance id and the readiness probe would never match
  await startServeDaemon(home, ['sonata', 'serve'], {}, cwd);
  if (await sonataRouterMultiTenant(port) !== true) throw new Error(preMultiTenantMessage(port));
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
  // Everything from here to the launch can refuse — the adapter's plan above
  // all, which is how opencode and pi decline a mode they cannot honour. The
  // run directory already exists by then, and one left behind has a meta.json
  // and no exit sentinel: `sonata runs` would list it as RUNNING forever, one
  // more for every refused candidate a dispatch tried. Nothing has launched
  // yet, so removing it loses nothing.
  let sessionStarted = false;
  let interactive: boolean;
  try {
    const instructionsPath = join(dir, 'instructions.md');

    // The plan comes first because it decides whether a report is possible at
    // all, and the instructions must not ask for one that cannot be written.
    // `adapter.plan` only takes the instructions path, never its contents, so
    // nothing here depends on the file existing yet.
    // Chosen here rather than by the harness, so the run's usage can later be
    // found by id — see `UsageQuery.sessionId`.
    const harnessSessionId = randomUUID();
    const plan = adapter.plan({
      sessionId: harnessSessionId,
      modelId: modelCfg.id,
      role: opts.role,
      mode,
      cwd: opts.cwd,
      runDir: dir,
      instructionsPath,
      effort: opts.effort,
    });

    writeFileSync(instructionsPath, composeInstructions({
      role: opts.role,
      roleText: loadRole(opts.role, opts.rolesDir),
      repoContext: repoContext(opts.cwd),
      task,
      reportPath: reportPathFor(dir),
      canWriteReport: plan.canWriteReport ?? true,
      inheritedSonataTools: exposesSonataTools(opts.cwd),
      runDir: dir,
    }));

    const harnessPath = join(dir, 'harness.sh');
    writeFileSync(harnessPath, plan.script, { mode: 0o755 });

    const scriptPath = join(dir, 'cmd.sh');
    writeFileSync(scriptPath, wrapWithTimeout({
      harnessScriptPath: harnessPath,
      runDir: dir,
      timeoutSeconds: config.run.runTimeoutSeconds,
      interactive: plan.interactive,
      // Same condition as `worktreeAtLaunch` below: a role with no launch sample
      // has nothing to compare a closing one against.
      worktreeCwd: isReadOnlyRole(opts.role) ? undefined : opts.cwd,
    }), { mode: 0o755 });

    const launched: RunMeta = {
      ...meta,
      interactive: plan.interactive,
      canWriteReport: plan.canWriteReport ?? true,
      silentUntilExit: plan.silentUntilExit ?? false,
      // Recorded whatever the plan answered, so `sonata tail` can say the run
      // did not run as ranked. Read together with `effort`: a harness with no
      // control is unremarkable until a level was actually asked for.
      ...(opts.effort === undefined ? {} : { effort: opts.effort }),
      effortHonoured: plan.effortHonoured,
      harnessModelId: modelCfg.id,
      harnessSessionId,
      // Sampled here, not before `createRun`, so that sonata's own scaffolding —
      // the run directory and the three files just written into it — is already
      // on disk in this sample as it will be in the one tail takes at exit. A
      // repository that does not ignore `.sonata/` would otherwise show it
      // appearing between the two samples and every run would look changed,
      // which fails in the useless direction: never flagging anything.
      worktreeAtLaunch: isReadOnlyRole(opts.role) ? undefined : worktreeFingerprint(opts.cwd),
    };
    writeMeta(opts.cwd, launched);

    await newSession({ session: meta.session, cwd: opts.cwd });
    sessionStarted = true;
    // Before anything is typed: the shell's prompt, which it prints again when
    // the wrapper exits, so tail can tell it from harness output.
    const preLaunchPane = await settledPane(meta.session);
    if (preLaunchPane.length > 0) writeMeta(opts.cwd, { ...launched, preLaunchPane });
    interactive = plan.interactive;
  } catch (err) {
    if (sessionStarted) await killSession(meta.session);
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  // Outside the cleanup on purpose: once the launch line may have been typed,
  // a harness may be running in this directory, and deleting it is worse
  // than a stale record.
  await runScript(meta.session, join(dir, 'cmd.sh'));
  return { id: meta.id, session: meta.session, interactive };
}
