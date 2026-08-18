import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { getAdapter } from '../adapters/index.js';
import { createRun, runDir, writeMeta } from '../store.js';
import { loadRole, composeInstructions } from '../roles.js';
import { readPermissionMode } from '../mode.js';
import { newSession, runScript } from '../tmux.js';
import { wrapWithTimeout } from '../watchdog.js';

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

export async function cmdRun(opts: RunOptions): Promise<RunResult> {
  const config = loadConfig(opts.cwd);

  const modelCfg = config.models[opts.model];
  if (!modelCfg) {
    throw new Error(
      `sonata: unknown model "${opts.model}". ` +
      `Defined models: ${Object.keys(config.models).join(', ')}`,
    );
  }

  const adapter = getAdapter(modelCfg.harness);
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
    reportPath: join(dir, 'report.md'),
    canWriteReport: plan.canWriteReport ?? true,
  }));

  const harnessPath = join(dir, 'harness.sh');
  writeFileSync(harnessPath, plan.script, { mode: 0o755 });

  const scriptPath = join(dir, 'cmd.sh');
  writeFileSync(scriptPath, wrapWithTimeout({
    harnessScriptPath: harnessPath,
    runDir: dir,
    timeoutSeconds: config.run.runTimeoutSeconds,
  }), { mode: 0o755 });

  writeMeta(opts.cwd, {
    ...meta,
    interactive: plan.interactive,
    canWriteReport: plan.canWriteReport ?? true,
  });

  await newSession({ session: meta.session, cwd: opts.cwd });
  await runScript(meta.session, scriptPath);

  return { id: meta.id, session: meta.session, interactive: plan.interactive };
}
