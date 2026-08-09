#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { cmdRun } from './commands/run.js';

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

  console.error(`sonata: unknown command "${command ?? ''}"`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
