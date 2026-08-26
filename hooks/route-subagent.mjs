#!/usr/bin/env node
// SubagentStart / SubagentStop hook for `sonata route auto`.
//
// Routing is off at rest, so every session launches from a settings file with
// no ANTHROPIC_BASE_URL in it and keeps Remote Control. It is turned on only
// while a foreign-model subagent is actually running, and off again when the
// last one finishes.
//
// This replaced turning routing on for the whole life of a session. Two things
// were measured to get here: adding the env is picked up by a running session
// within seconds — which is why a subagent's very first request is already
// routed — while removing it is only observed eventually, which is why routing
// must stay on for as long as the subagent runs rather than being cleaned up
// on a timer.
//
// All of the work is `sonata route subagent-<phase>` in the CLI, where it is
// ordinary tested code. This script only finds the agent id and stays quiet: a
// hook that throws is a hook that breaks the subagent it was meant to serve,
// so it always exits 0.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const phase = process.argv[2] === 'stop' ? 'stop' : 'start';
const global = process.argv[3] === '--global';
const cli = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist', 'cli.js');

/** Claude Code sends the hook a JSON payload on stdin; `agent_id` is in it. */
async function readAgentId() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof doc.agent_id === 'string' ? doc.agent_id : '';
  } catch {
    return '';
  }
}

const agentId = await readAgentId();
if (agentId === '') process.exit(0);

await new Promise((resolve) => {
  try {
    const args = [cli, 'route', `subagent-${phase}`, '--id', agentId];
    if (global) args.push('--global');
    const child = spawn(process.execPath, args, { stdio: 'ignore' });
    child.on('exit', resolve);
    child.on('error', resolve);
  } catch {
    resolve();
  }
});
process.exit(0);
