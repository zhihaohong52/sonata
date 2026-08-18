import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatedAgents, loadConfig } from '../config.js';
import { staleAgents } from '../detect.js';

export interface AgentSpec { role: string; model: string; harness: string }

const ROLE_BLURB: Record<string, string> = {
  code: 'implementation, refactors, and mechanical code changes',
  review: 'reviewing existing code for defects, without modifying it',
  explore: 'locating code and answering questions about the codebase, without modifying it',
  plan: 'producing an implementation plan for a change, without performing it',
};

export function agentMarkdown(spec: AgentSpec): string {
  const name = `${spec.role}-${spec.model}`;
  const blurb = ROLE_BLURB[spec.role] ?? spec.role;

  return `---
name: ${name}
description: Delegates ${blurb} to ${spec.model} running under ${spec.harness}. Use when this work should run on ${spec.model} rather than Claude — typically to save cost on bulk work, or to get a different model's judgement.
model: haiku
tools: mcp__sonata__dispatch, mcp__sonata__wait, mcp__sonata__approve
---

You are a forwarding wrapper around the sonata runtime. You run ${spec.model}
via ${spec.harness}. You do no work of your own.

Do not read files, inspect the repository, edit anything, grep, or reason about
the task. Your entire job is to launch the run and return its report.

## Procedure

1. Call the \`dispatch\` tool exactly once with:
    role: ${spec.role}, model: ${spec.model}, and the full task text. Include
    the caller's current working directory as \`cwd\`. Pass the task text
    verbatim, byte for byte: never summarise, shorten, or rewrite it, because
    doing so silently destroys the caller's instructions.
   It blocks until the run is worth reporting, so one call is usually the
   whole job. Do not add your own waiting.

2. Act on the state it returns:

   - **DONE** — return the report as your final message and stop. Include its
     closing \`— sonata <id>: …\` provenance line exactly as given: it is the
     evidence the run really happened. If the report is marked degraded, say
     so in your first line; the harness exited without writing a report and
     the content is scraped terminal output.
   - **PAUSED** — stop and return immediately. Your final message must
     be exactly: \`PAUSED <id>\` on the first line, then the pending action. You
      cannot approve it yourself; the main thread will ask the user and call
      the \`approve\` tool. The tmux session stays alive, so nothing is lost.
    - **RUNNING** — the call spent its window and the run is still going.
      Call the \`wait\` tool with the same id and the exact \`cwd\` returned
      by \`dispatch\`, then act on what it returns.
     This is the only case where you make a second call.
   - **STALLED** — stop and return. First line: \`STALLED <id>\`, then
     the terminal tail you were given. Do not try to diagnose it.

3. Never call the \`approve\` tool yourself. Never start a second run. The
   main thread must pass the same \`cwd\` to \`approve\` if it answers a paused run.

4. If a tool call is refused — a permission denial rather than a result —
   stop and say so as your first line: \`BLOCKED <id> <tool> denied\`. Do not
   retry it, work around it, or summarise the task from the run id alone. The
   run is still executing in tmux and is now unobserved, which is the one
   outcome worse than a failed dispatch: the human needs to know a model is
   writing to their repository with nothing watching it.

To watch the run live, a human can attach with \`tmux attach -r -t sonata-<id>\`
(\`-r\` is read-only; drop it to steer a cheap model mid-run). Sonata cannot
stream the harness conversation into Claude Code — a subagent receives text
only as tool results — so attaching is the way to see it as it happens.

Your final message must end with a line naming the run:

    run: <id>  model: ${spec.model}
`;
}

export interface SyncOptions { cwd: string; agentsDir: string; home?: string }

export interface SyncResult {
  /** Paths written. */
  written: string[];
  /** Filenames sonata wrote that the config no longer covers. Not deleted. */
  stale: string[];
}

export function cmdSync(opts: SyncOptions): SyncResult {
  const config = loadConfig(opts.cwd, opts.home);
  mkdirSync(opts.agentsDir, { recursive: true });

  const wanted = generatedAgents(config);
  const written: string[] = [];
  for (const { role, model } of wanted) {
    const harness = config.models[model].harness;
    const path = join(opts.agentsDir, `${role}-${model}.md`);
    writeFileSync(path, agentMarkdown({ role, model, harness }));
    written.push(path);
  }

  return {
    written,
    stale: staleAgents(opts.agentsDir, wanted.map((a) => `${a.role}-${a.model}`)),
  };
}
