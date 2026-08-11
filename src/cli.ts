#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { cmdRun } from './commands/run.js';
import { cmdTail } from './commands/tail.js';
import { cmdApprove } from './commands/approve.js';
import { cmdSync } from './commands/sync.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdGc } from './commands/gc.js';
import { cmdInit, isCancellation } from './commands/init.js';
import type { HookScope } from './settings.js';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const USAGE = `sonata — foreign-model subagents for Claude Code

  sonata init      set up sonata in this project (interactive)
  sonata doctor    check tmux, harnesses, auth and versions
  sonata sync      regenerate agent files from sonata.toml
  sonata run       launch a harness run, print its id
  sonata tail      poll a run for progress
  sonata approve   answer a pending approval
  sonata gc        kill finished tmux sessions

  init flags (skip the prompts):
    --yes                    accept defaults, no prompts
    --providers opencode/openrouter,pi/opencode-go   providers to draw models from
    --models a,b             models to enable (config keys)
    --roles code,review      roles to generate
    --scope project|global|skip   where to install the permission hook
`;

/** Repository root, one level above the compiled dist/ or src/ directory. */
function packageRoot(): string {
  return join(fileURLToPath(new URL('.', import.meta.url)), '..');
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  if (command === 'init') {
    const { values } = parseArgs({
      args: rest,
      options: {
        yes: { type: 'boolean', default: false },
        providers: { type: 'string' },
        models: { type: 'string' },
        roles: { type: 'string' },
        scope: { type: 'string' },
      },
    });

    const scope = values.scope as HookScope | 'skip' | undefined;
    if (scope && !['project', 'global', 'skip'].includes(scope)) {
      throw new Error(`sonata init: --scope must be project, global or skip (got "${scope}")`);
    }

    const split = (v: string | undefined): string[] | undefined =>
      v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean);

    try {
      const res = await cmdInit({
        cwd: process.cwd(),
        home: homedir(),
        packageRoot: packageRoot(),
        yes: values.yes,
        providers: split(values.providers),
        models: split(values.models),
        roles: split(values.roles),
        scope,
      });
      if (res.cancelled) return 1;
      return res.problems.some((p) => p.severity === 'error') ? 1 : 0;
    } catch (err) {
      if (isCancellation(err)) {
        console.log('\n  Cancelled. Nothing written.');
        return 130;
      }
      throw err;
    }
  }

  if (command === 'run') {
    const { values } = parseArgs({
      args: rest,
      options: {
        role: { type: 'string' },
        model: { type: 'string' },
        'task-file': { type: 'string' },
        'roles-dir': { type: 'string' },
        json: { type: 'boolean', default: false },
      },
    });
    if (!values.role || !values.model || !values['task-file']) {
      throw new Error('sonata run requires --role, --model and --task-file');
    }
    const res = await cmdRun({
      cwd: process.cwd(),
      role: values.role,
      model: values.model,
      taskFile: values['task-file'],
      // fileURLToPath, not .pathname — the latter percent-encodes spaces and
      // would break for anyone whose install path contains one.
      rolesDir: values['roles-dir'] ?? join(packageRoot(), 'roles'),
      sessionId: process.env.CLAUDE_CODE_SESSION_ID,
    });
    console.log(values.json ? JSON.stringify(res) : `run ${res.id} (tmux ${res.session})`);
    return 0;
  }

  if (command === 'tail') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { wait: { type: 'string' }, json: { type: 'boolean', default: false } },
    });
    const id = positionals[0];
    if (!id) throw new Error('sonata tail requires a run id');
    const res = await cmdTail({
      cwd: process.cwd(),
      id,
      waitSeconds: Number.parseInt(values.wait ?? '20', 10),
    });
    if (values.json) {
      console.log(JSON.stringify(res));
    } else {
      console.log(res.state);
      for (const l of res.lines) console.log(`  ${l}`);
      if (res.prompt) console.log(`  PROMPT: ${res.prompt}`);
      if (res.report) console.log(`\n${res.report}`);
    }
    return res.state === 'STALLED' ? 3 : 0;
  }

  if (command === 'approve') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { yes: { type: 'boolean', default: false }, no: { type: 'boolean', default: false } },
    });
    const id = positionals[0];
    if (!id) throw new Error('sonata approve requires a run id');
    if (values.yes === values.no) throw new Error('sonata approve requires exactly one of --yes or --no');
    await cmdApprove({ cwd: process.cwd(), id, yes: values.yes });
    console.log(`approved=${values.yes} run=${id}`);
    return 0;
  }

  if (command === 'sync') {
    const written = cmdSync({
      cwd: process.cwd(),
      agentsDir: join(process.cwd(), '.claude', 'agents'),
    });
    for (const p of written) console.log(`wrote ${p}`);
    return 0;
  }

  if (command === 'doctor') {
    const { ok, checks } = await cmdDoctor({ cwd: process.cwd() });
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    return ok ? 0 : 1;
  }

  if (command === 'gc') {
    const killed = await cmdGc({ cwd: process.cwd() });
    console.log(killed.length ? `killed ${killed.join(', ')}` : 'nothing to clean up');
    return 0;
  }

  console.error(`sonata: unknown command "${command ?? ''}"`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
