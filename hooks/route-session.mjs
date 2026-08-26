#!/usr/bin/env node
// SessionStart / SessionEnd hook for `sonata route auto`: turns routing on for
// the life of a session and off again when the last one ends, so a session
// launches with a clean settings file (keeping Remote Control) and is routed
// anyway from its first request onward.
//
// All of the work is `sonata route session-<phase>` in the CLI, where it is
// ordinary tested code. This script only finds the session id and stays quiet:
// a hook that throws is a hook that breaks the session it was meant to serve,
// so it always exits 0.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const phase = process.argv[2] === 'end' ? 'end' : 'start';
const global = process.argv[3] === '--global';
const cli = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist', 'cli.js');

/** Claude Code sends the hook a JSON payload on stdin; `session_id` is in it. */
async function readSessionId() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof doc.session_id === 'string' ? doc.session_id : '';
  } catch {
    return '';
  }
}

const sessionId = await readSessionId();
if (sessionId === '') process.exit(0);

await new Promise((resolve) => {
  try {
    const args = [cli, 'route', `session-${phase}`, '--id', sessionId];
    if (global) args.push('--global');
    const child = spawn(process.execPath, args, {
      stdio: 'ignore',
    });
    child.on('exit', resolve);
    child.on('error', resolve);
  } catch {
    resolve();
  }
});
process.exit(0);
