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

function repoContext(cwd: string): string {
  const parts: string[] = [];
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const p = join(cwd, name);
    if (existsSync(p)) parts.push(`### ${name}\n\n${readFileSync(p, 'utf8').trim()}`);
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

  writeFileSync(instructionsPath, composeInstructions({
    role: opts.role,
    roleText: loadRole(opts.role, opts.rolesDir),
    repoContext: repoContext(opts.cwd),
    task,
    reportPath: join(dir, 'report.md'),
  }));

  const plan = adapter.plan({
    modelId: modelCfg.id,
    role: opts.role,
    mode,
    cwd: opts.cwd,
    runDir: dir,
    instructionsPath,
  });

  const harnessPath = join(dir, 'harness.sh');
  writeFileSync(harnessPath, plan.script, { mode: 0o755 });

  const scriptPath = join(dir, 'cmd.sh');
  writeFileSync(scriptPath, wrapWithTimeout({
    harnessScriptPath: harnessPath,
    runDir: dir,
    timeoutSeconds: config.run.runTimeoutSeconds,
  }), { mode: 0o755 });

  writeMeta(opts.cwd, { ...meta, interactive: plan.interactive });

  await newSession({ session: meta.session, cwd: opts.cwd });
  await runScript(meta.session, scriptPath);

  return { id: meta.id, session: meta.session, interactive: plan.interactive };
}
