import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatedAgents, generatedNativeAgents, expectedAgentNames, isReadOnlyRole, loadConfig, TIER_NAMES } from '../config.js';
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

**You may not answer anything yourself, however easy it looks.** If the task is
"say the word done", you dispatch it — you do not say it. A wrapper once
answered a trivial question in under two seconds with no dispatch at all, and
nothing downstream could tell that from a real run except the missing
provenance line. Answering from your own head is not a shortcut, it is a
fabricated result: everything downstream believes a foreign model ran.

Before sending your final message, check it contains a line beginning
\`— sonata \`. If it does not, you did not dispatch — say so instead of
answering.

## Procedure

1. Call the \`dispatch\` tool exactly once with role: ${spec.role} and
    model: ${spec.model}. Include the caller's current working directory as
    \`cwd\`. For the task itself:

    - If the caller gave you a **file path** holding the task, pass it as
      \`task_file\` and do not open the file. A path cannot be paraphrased.
    - Otherwise pass it as \`task\`, **verbatim, byte for byte**: never
      summarise, shorten, or rewrite it. A 3,000-word spec once reached the
      model as a single sentence, so it never saw the instructions it was
      meant to follow.
    - If the caller asked to *see* the run — its conversation, its transcript,
      what the model did turn by turn — also pass \`transcript: true\`. The
      transcript comes back in the tool result, where the caller can read it;
      your final message stays the report, so do not paste it in.
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

export function nativeAgentMarkdown(spec: { role: string; model: string }): string {
  const blurb = ROLE_BLURB[spec.role] ?? spec.role;
  const tools = isReadOnlyRole(spec.role) ? 'tools: Read, Grep, Glob\n' : '';

  return `---
name: native-${spec.role}-${spec.model}
description: Runs ${blurb} natively on ${spec.model} inside Claude Code's own loop. Requires a routed session (sonata code, or sonata route on).
model: ${spec.model}
${tools}---

This agent only works in a routed session (sonata code, or sonata route on).

Focus on ${blurb}.
`;
}

export function tierAgentMarkdown(spec: { role: string; tier?: 'simple' | 'complex' }): string {
  const blurb = ROLE_BLURB[spec.role] ?? spec.role;
  const tier = spec.tier;
  const name = tier === undefined ? spec.role : `${spec.role}-${tier}`;
  const model = tier === undefined ? `sonata-${spec.role}` : `sonata-${spec.role}-${tier}`;
  const tools = isReadOnlyRole(spec.role) ? 'tools: Read, Grep, Glob\n' : '';
  const description = tier === undefined
    ? `Runs ${blurb} on a ranked list of foreign models, natively inside Claude Code's loop. Requires a routed session (sonata code, or sonata route on/auto).`
    : `Runs ${blurb} on a ranked list of foreign models (${tier} tier), natively inside Claude Code's loop. Simple = mechanical, well-specified, contained work (single file, clear spec, bulk edits). Complex = cross-cutting, ambiguous, design-sensitive, or needs sustained reasoning. When unsure, use -complex. Requires a routed session (sonata code, or sonata route on/auto).`;

  return `---
name: ${name}
description: ${description}
model: ${model}
${tools}---

This agent only works in a routed session (sonata code, or sonata route on/auto).

Focus on ${blurb}.
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

  if (config.tiers !== undefined) {
    const written: string[] = [];
    for (const [role, lists] of Object.entries(config.tiers)) {
      const collapsed = lists.simple.length === lists.complex.length &&
        lists.simple.every((model, index) => model === lists.complex[index]);
      const tiers: ('simple' | 'complex' | undefined)[] = collapsed ? [undefined] : [...TIER_NAMES];
      for (const tier of tiers) {
        const path = join(opts.agentsDir, `${role}${tier === undefined ? '' : `-${tier}`}.md`);
        writeFileSync(path, tierAgentMarkdown({ role, tier }));
        written.push(path);
      }
    }
    return {
      written,
      stale: staleAgents(opts.agentsDir, expectedAgentNames(config)),
    };
  }

  const wanted = generatedAgents(config);
  const written: string[] = [];
  for (const { role, model } of wanted) {
    const harness = config.models[model].harness;
    const path = join(opts.agentsDir, `${role}-${model}.md`);
    writeFileSync(path, agentMarkdown({ role, model, harness }));
    written.push(path);
  }

  // Native models get both a native agent (for sonata code sessions) and a
  // wrapper agent (for MCP dispatch from normal sessions via the claude harness).
  const nativeWanted = generatedNativeAgents(config);
  for (const { role, model } of nativeWanted) {
    const nativePath = join(opts.agentsDir, `native-${role}-${model}.md`);
    writeFileSync(nativePath, nativeAgentMarkdown({ role, model }));
    written.push(nativePath);

    // Skip the wrapper if a harness-based one already covers this role+model
    const wrapperName = `${role}-${model}`;
    if (!wanted.some((a) => `${a.role}-${a.model}` === wrapperName)) {
      const wrapperPath = join(opts.agentsDir, `${wrapperName}.md`);
      writeFileSync(wrapperPath, agentMarkdown({ role, model, harness: 'claude' }));
      written.push(wrapperPath);
    }
  }

  return {
    written,
    stale: staleAgents(opts.agentsDir, expectedAgentNames(config)),
  };
}
