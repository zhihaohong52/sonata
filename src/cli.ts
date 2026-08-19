#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { cmdRun } from './commands/run.js';
import { cmdTail } from './commands/tail.js';
import { loadConfig } from './config.js';
import { cmdApprove } from './commands/approve.js';
import { cmdSync } from './commands/sync.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdGc } from './commands/gc.js';
import { cmdInit, isCancellation } from './commands/init.js';
import { banner, isInteractive, confirm } from './tui.js';
import { pruneAgents } from './detect.js';
import type { HookScope } from './settings.js';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';
import { cmdAuthAdd, cmdAuthList, cmdAuthRemove } from './commands/auth.js';

const USAGE = `sonata — foreign-model subagents for Claude Code

  sonata init      set up sonata in this project (interactive)
  sonata doctor    check tmux, harnesses, auth and versions
  sonata sync      regenerate agent files from sonata.toml
  sonata run       launch a harness run, print its id
  sonata tail      poll a run for progress
  sonata approve   answer a pending approval
  sonata gc        kill finished tmux sessions
  sonata log       print a run's whole transcript (tail returns only new lines)
  sonata verify    confirm a dispatch actually happened
  sonata auth      add, list or remove native gateway keys
  sonata mcp       start the stdio JSON-RPC server (started by Claude Code; not run by hand)

  init flags (skip the prompts):
    --yes                    accept defaults, no prompts
    --providers opencode/openrouter,pi/opencode-go   providers to draw models from
    --models a,b             models to enable (config keys)
    --roles code,review      roles to generate
    --native-models a,b      native model keys to enable (opt-in; default none)
    --native-roles code,review   roles to generate native agents for
    --config-scope project|global   where the config and its agents go
    --scope project|global|skip   where to install the permission hook
    --prune                    delete stale sonata agent files
`;

/** `--wait` wins; otherwise use the configured tail window. */
export function tailWaitSeconds(flag: string | undefined, configured: number): number {
  if (flag === undefined) return configured;
  const parsed = Number.parseInt(flag, 10);
  return Number.isFinite(parsed) ? parsed : configured;
}

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
        'native-models': { type: 'string' },
        'native-roles': { type: 'string' },
        'config-scope': { type: 'string' },
        scope: { type: 'string' },
        // No default: `undefined` means "unanswered", which lets cmdInit fall
        // through to the interactive prompt. `false` would suppress it.
        prune: { type: 'boolean' },
      },
    });

    const scope = values.scope as HookScope | 'skip' | undefined;
    if (scope && !['project', 'global', 'skip'].includes(scope)) {
      throw new Error(`sonata init: --scope must be project, global or skip (got "${scope}")`);
    }

    const configScope = values['config-scope'] as 'project' | 'global' | undefined;
    if (configScope && !['project', 'global'].includes(configScope)) {
      throw new Error(
        `sonata init: --config-scope must be project or global (got "${configScope}")`,
      );
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
        nativeModels: split(values['native-models']),
        nativeRoles: split(values['native-roles']),
        scope,
        configScope,
        prune: values.prune,
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
    // The attach command is printed in full, because watching a foreign model
    // work is the one thing sonata cannot stream into a Claude Code
    // conversation — and reconstructing the session name by hand is the step
    // that stops people from looking.
    console.log(values.json
      ? JSON.stringify(res)
      : `run ${res.id} (tmux ${res.session})\n  watch: tmux attach -r -t ${res.session}`);
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
      waitSeconds: tailWaitSeconds(values.wait, loadConfig(process.cwd()).run.tailWindowSeconds),
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
    const { values } = parseArgs({
      args: rest,
      options: { prune: { type: 'boolean', default: false } },
    });
    const agentsDir = join(process.cwd(), '.claude', 'agents');
    const sync = cmdSync({
      cwd: process.cwd(),
      home: homedir(),
      agentsDir,
    });
    for (const p of sync.written) console.log(`wrote ${p}`);
    if (sync.stale.length > 0) {
      for (const f of sync.stale.slice(0, 5)) console.log(`stale ${f}`);
      if (sync.stale.length > 5) console.log(`stale ... and ${sync.stale.length - 5} more`);
      const remove = values.prune || (isInteractive() && await confirm('Delete them?', true));
      if (remove) {
        const pruned = pruneAgents(agentsDir, sync.stale);
        console.log(`removed ${pruned.length} stale agent file(s)`);
      } else {
        console.log('delete them by hand, or re-run with --prune');
      }
    }
    return 0;
  }

  if (command === 'doctor') {
    // doctor is read, not piped — but only decorate a real terminal, so
    // `sonata doctor > report.txt` stays plain.
    if (isInteractive()) console.log(`\n${banner()}\n`);
    const { ok, checks } = await cmdDoctor({
      cwd: process.cwd(),
      home: homedir(),
      packageRoot: packageRoot(),
    });
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    return ok ? 0 : 1;
  }

  if (command === 'auth') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
    const [action, gateway] = positionals;
    const config = loadConfig(process.cwd(), homedir());
    const gateways = Object.keys(config.native?.gateways ?? {});

    if (action === 'list') {
      console.log(cmdAuthList({ home: homedir(), gateways }).text);
      return 0;
    }
    if (action === 'remove') {
      if (!gateway) throw new Error('sonata auth remove requires a gateway');
      cmdAuthRemove({ home: homedir(), gateway });
      return 0;
    }
    if (action === 'add') {
      if (!gateway) throw new Error('sonata auth add requires a gateway');
      const key = await readAuthKey();
      if (!key) throw new Error('sonata auth add requires a non-empty key');
      cmdAuthAdd({ home: homedir(), gateway, key });
      return 0;
    }
    throw new Error('sonata auth requires list, add <gateway> or remove <gateway>');
  }

  if (command === 'gc') {
    const killed = await cmdGc({ cwd: process.cwd() });
    console.log(killed.length ? `killed ${killed.join(', ')}` : 'nothing to clean up');
    return 0;
  }

  if (command === 'log') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
    const id = positionals[0];
    if (!id) throw new Error('sonata log requires a run id');
    const { cmdLog } = await import('./commands/log.js');
    const res = cmdLog({ cwd: process.cwd(), id });
    console.log(res.text);
    return res.ok ? 0 : 1;
  }

  if (command === 'verify') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true, options: { model: { type: 'string' } },
    });
    const id = positionals[0];
    if (!id) throw new Error('sonata verify requires a run id');
    const { cmdVerify } = await import('./commands/verify.js');
    const res = cmdVerify({ cwd: process.cwd(), id, model: values.model });
    console.log(`${res.ok ? 'ok  ' : 'FAIL'} ${res.detail}`);
    return res.ok ? 0 : 1;
  }

  if (command === 'mcp') {
    const { runMcpStdio } = await import('./mcp/server.js');
    await runMcpStdio({
      cwd: process.cwd(),
      home: homedir(),
      rolesDir: join(packageRoot(), 'roles'),
      sessionId: process.env.CLAUDE_CODE_SESSION_ID,
    });
    return 0;
  }

  console.error(`sonata: unknown command "${command ?? ''}"`);
  return 2;
}

async function readAuthKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    return readFileSync(0, 'utf8').split(/\r?\n/, 1)[0].trim();
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  stdout.write('Key: ');
  stdin.setRawMode?.(true);
  stdin.resume();
  let value = '';
  try {
    for await (const chunk of stdin.iterator({ destroyOnReturn: false })) {
      const text = String(chunk);
      for (const char of text) {
        if (char === '\n' || char === '\r') return value.trim();
        if (char === '\u0003') throw new Error('sonata auth add cancelled');
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    }
  } finally {
    stdin.setRawMode?.(false);
    stdin.pause();
    stdout.write('\n');
  }
  return value.trim();
}

/**
 * True when this module was executed as the program, rather than imported.
 *
 * Compares REAL paths. `sonata` on PATH is a symlink into node_modules, so
 * node sets argv[1] to the symlink while import.meta.url resolves to the file
 * it points at — a raw string comparison never matches, and every command
 * exits 0 having done nothing. That shipped: the guard exists so a test can
 * import this module without running the CLI, and the first version of it
 * killed the CLI instead. Nothing caught it, because every test imports.
 */
export function invokedAsProgram(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    // One of the paths does not resolve, so this is not the program. Staying
    // silent beats running twice.
    return false;
  }
}

if (invokedAsProgram(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
