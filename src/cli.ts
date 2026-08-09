#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { cmdRun } from './commands/run.js';
import { cmdTail } from './commands/tail.js';
import { cmdApprove } from './commands/approve.js';
import { cmdSync } from './commands/sync.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdGc } from './commands/gc.js';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

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
      rolesDir: values['roles-dir'] ?? new URL('../roles', import.meta.url).pathname,
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
