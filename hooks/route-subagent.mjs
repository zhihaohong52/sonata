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

/**
 * A non-zero exit is shown to the user as a `systemMessage`, which Claude Code
 * honours on this event. The CLI refused for a reason worth reading — most
 * often "router port N is already serving a different sonata configuration",
 * which used to be swallowed here: this script exited 0 with stdio ignored,
 * the session stayed unrouted, and the first visible symptom was a native
 * dispatch dying with `model_not_found` at api.anthropic.com. The CLI itself
 * exits 0 for the one expected failure (no config in this directory), so a
 * global hook stays silent where it has nothing to do.
 */
function surface(code, stderr) {
  const text = stderr.trim();
  if (code === 0 || text === '') return;
  process.stdout.write(JSON.stringify({
    systemMessage: `sonata route subagent-${phase} failed, so this subagent is not routed:\n${text.slice(0, 2000)}`,
  }) + '\n');
}

const agentId = await readAgentId();
if (agentId === '') process.exit(0);

await new Promise((resolve) => {
  try {
    const args = [cli, 'route', `subagent-${phase}`, '--id', agentId];
    if (global) args.push('--global');
    // stdout ignored: on SessionStart, plain stdout becomes context for
    // Claude, and the CLI's "routing off; 1 session(s) routed" is not an
    // instruction. stderr is kept for the one case worth showing.
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('exit', (code) => { surface(code, Buffer.concat(stderr).toString('utf8')); resolve(); });
    child.on('error', resolve);
  } catch {
    resolve();
  }
});
process.exit(0);
