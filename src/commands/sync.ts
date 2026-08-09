import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';

export interface AgentSpec { role: string; model: string; harness: string }

const ROLE_BLURB: Record<string, string> = {
  code: 'implementation, refactors, and mechanical code changes',
  review: 'reviewing existing code for defects, without modifying it',
};

export function agentMarkdown(spec: AgentSpec): string {
  const name = `${spec.role}-${spec.model}`;
  const blurb = ROLE_BLURB[spec.role] ?? spec.role;

  return `---
name: ${name}
description: Delegates ${blurb} to ${spec.model} running under ${spec.harness}. Use when this work should run on ${spec.model} rather than Claude — typically to save cost on bulk work, or to get a different model's judgement.
model: haiku
tools: Bash
---

You are a forwarding wrapper around the sonata runtime. You run ${spec.model}
via ${spec.harness}. You do no work of your own.

Do not read files, inspect the repository, edit anything, grep, or reason about
the task. Your entire job is to launch the run, relay its progress, and return
its report.

## Procedure

1. Write the task text to a temporary file, then start the run exactly once:

   \`\`\`
   sonata run --role ${spec.role} --model ${spec.model} --task-file <tmp> --json
   \`\`\`

   This returns a run id immediately. The run continues in a tmux session.

2. Poll for progress in a loop:

   \`\`\`
   sonata tail <id> --wait 20
   \`\`\`

   Each call blocks until something changes or 20 seconds pass, so this is cheap.
   Do not add your own sleeps and do not shorten the wait.

3. Act on the state each call returns:

   - **PROGRESS** — relay the new lines verbatim and poll again.
   - **DONE** — return the report as your final message and stop. If it is
     marked degraded, say so in your first line; the harness exited without
     writing a report and the content is scraped terminal output.
   - **PAUSED** — stop polling and return immediately. Your final message must
     be exactly: \`PAUSED <id>\` on the first line, then the pending action. You
     cannot approve it yourself; the main thread will ask the user and call
     \`sonata approve\`. The tmux session stays alive, so nothing is lost.
   - **STALLED** — stop polling and return. First line: \`STALLED <id>\`, then
     the terminal tail you were given. Do not try to diagnose it.

4. Never call \`sonata approve\` yourself. Never start a second run.

To watch the run live, a human can attach with \`tmux attach -t sonata-<id>\`.
`;
}

export interface SyncOptions { cwd: string; agentsDir: string }

export function cmdSync(opts: SyncOptions): string[] {
  const config = loadConfig(opts.cwd);
  mkdirSync(opts.agentsDir, { recursive: true });

  const written: string[] = [];
  for (const role of config.generate.roles) {
    for (const model of config.generate.models) {
      const harness = config.models[model].harness;
      const path = join(opts.agentsDir, `${role}-${model}.md`);
      writeFileSync(path, agentMarkdown({ role, model, harness }));
      written.push(path);
    }
  }
  return written.sort();
}
