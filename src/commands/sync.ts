import { EXTENDED_CONTEXT_SUFFIX, tierQualifiesForExtendedContext } from '../extended-context.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatedAgents, generatedNativeAgents, expectedAgentNames, isReadOnlyRole, loadConfig, TIER_NAMES, tiersCollapse, type SonataConfig, type TierLists } from '../config.js';

/** One of the tiers a role can define. */
type Tier = (typeof TIER_NAMES)[number];
import { isSonataAgentText, staleAgents } from '../detect.js';
import { TIER_AGENT_MARKER } from '../agent-markers.js';
import { ROLE_BLURB } from '../roles.js';

export { TIER_AGENT_MARKER } from '../agent-markers.js';

export interface AgentSpec { role: string; model: string; harness: string }

/**
 * Tools that let a generated agent spawn further agents.
 *
 * `Task` is the pre-rename alias for `Agent`; both are listed because sonata
 * generates files for whatever Claude Code version the user has, and a stale
 * name in an allow-list matches nothing while a missing one silently drops the
 * capability.
 */
const FANOUT_TOOLS = 'Agent, Task, Workflow';

/**
 * Why every generated agent says this.
 *
 * The routed model is pinned in frontmatter, and the Agent tool's own `model`
 * parameter takes precedence over frontmatter — so a caller that passes one
 * runs sonata's prompt and tools on a Claude model that never reaches the
 * router. Nothing errors and nothing warns: reported 2026-09-15 after ~15
 * dispatches had already run that way, noticed only when someone asked which
 * models were in use. Every "foreign-model review" in that session was Claude
 * reviewing Claude, which is precisely the independence the lane exists to
 * provide.
 *
 * It sits in the `description` as well as the body because the description is
 * what the *dispatching* model reads while choosing an agent — by the time the
 * body is in context the override has already happened. Generic multi-agent
 * advice ("always specify the model explicitly") is what produces this, so the
 * instruction has to be visible at the point that advice is applied.
 */
const NO_MODEL_ARG = 'Dispatch with no `model` argument — it overrides this agent\'s routed model and silently disables sonata routing.';

const TIER_CRITERION: Record<'simple' | 'normal' | 'complex', string> = {
  simple: 'Use it when the task is specified closely enough that the diff could be written without asking a question — typically one or two files, no interface change.',
  normal: 'This is the default tier. Use it when you know what to change but not exactly how, so it needs reading the surrounding code to fit in; it may touch several files, but what "done" means is not in question.',
  complex: 'Use it when the task needs a design decision affecting other components, or is ambiguous about what "done" means, so the first job is deciding what to build.',
};

/**
 * How to choose a tier, naming only the tiers this role actually has.
 *
 * Availability is not decoration. `cmdSync` generates no `-normal` agent for a
 * role whose config has no `normal` list, and `resolveTierAlias` returns
 * `undefined` for that alias — so a fixed prompt naming `-normal` as the
 * default would send every dispatch from an unmigrated config at an agent that
 * does not exist. Since `normal` is optional precisely so existing configs
 * need no migration, that is the common case, not the edge one.
 */
function tierChoice(available: readonly Tier[]): string {
  if (available.length < 2) return '';
  const criterion: Record<Tier, string> = {
    simple: '`-simple` — writable without asking a question.',
    normal: '`-normal` — the default. You know what to change, not exactly how.',
    complex: '`-complex` — needs a design decision, or "done" is still ambiguous.',
  };
  const bullets = available.map((tier) => `- ${criterion[tier]}`).join('\n');
  // Without a middle rung there is no default to name, and naming one anyway
  // is what sent 74% of dispatches to `complex`.
  const pick = available.includes('normal')
    ? 'Start at the tier the task actually needs rather than a rung higher. A task\nthat fails review is re-run one tier up, so starting low is cheap to correct\nand starting high is not cheap at all.'
    : 'Prefer `-simple` whenever the task is specified closely enough to write\nwithout asking a question; a task that fails review is re-run at `-complex`,\nso starting low is cheap to correct and starting high is not cheap at all.';
  return `## Choosing a tier

Size is not difficulty. A large mechanical change is \`simple\`; a three-line
change that decides an interface is \`complex\`.

${bullets}

${pick}`;
}

const DELEGATING = `## Delegating

You may spawn subagents. Delegate only to read-only agent types — \`review-*\`,
\`explore-*\`, \`plan-*\`. This run is read-only, and delegating to a \`code-*\` agent
writes to the repository through it. Nothing enforces this but you.
`;

/**
 * What a reviewer does with a request larger than a review.
 *
 * The 2026-09-17 incident was not only a fan-out failure — it started as a
 * scoping one. The reviewer was handed nine numbered deep-trace areas across a
 * 14-commit change (freeze coverage on every dispatch path, crash-recovery
 * states, interactions with send rollback, soft-delete, retry_stage,
 * concurrency) and treated that as a work breakdown. The dispatcher afterwards
 * answered three of the nine itself with `grep`, in about a minute: a third of
 * what was delegated never needed a model at all.
 *
 * So the instruction is to *narrow and say so*, not to cover everything asked.
 * A reviewer silently expanding to fill its brief is what turns a review into
 * a research assignment, and a partial review that names what it did not cover
 * is worth more than a broad one that ran out of budget — the failure mode
 * here is a review that spends heavily and reports nothing, which is precisely
 * what happened.
 */
const REVIEW_SCOPE = `## Scoping the review

Review what you were given; do not grow to fill the request. If it names more
areas than you can examine properly, **pick the ones that genuinely need
judgement, review those, and state plainly which you did not cover** — a
partial review that names its gaps is useful, and a broad one that runs out of
room is not.

Anything a \`grep\` answers is not a review question. Answer it yourself
directly rather than delegating it: a dispatcher who sent nine such areas out
later answered three of them by hand in about a minute.

Report findings. Do not fix, and do not open a plan for fixing.
`;

/**
 * How many subagents one generated agent may spawn across its whole run.
 *
 * The descent bounds depth; this bounds width, and the incident needed both.
 * The `review-complex` measured on 2026-09-17 made 12 Agent calls from a
 * single node — 8 same-tier reviewers and 4 to `claude` — so a depth rule
 * alone would still have allowed 12 siblings, each re-reading the same diff,
 * spec and plan from scratch.
 *
 * Three is chosen to be countable rather than optimal. A model cannot track a
 * token budget it never sees, but it can count to three, and the rule has to
 * survive being read by the same loss-averse reader that resolved "keep
 * fan-out proportionate" as licence to split a nine-item list. Combined with
 * the descent it bounds a `complex` run at 3 `normal` children and 9 `simple`
 * grandchildren, with exactly one node ever running at the dearest tier.
 */
const FANOUT_LIMIT = 3;

/**
 * The tiers a tier agent may delegate to: strictly cheaper ones, in rank order.
 *
 * This is the only thing bounding fan-out depth, and it exists because nothing
 * else did. Measured 2026-09-17 from another repository: one dispatched
 * `review-complex` made 8 further `review-complex` calls and 4 to `claude`,
 * and its children spawned again — a tree whose leaves hit a $200 gateway cap,
 * initially misread as three retries of one review. Every node independently
 * re-read the same diff, spec and plan, each paying that repository's very
 * large `CLAUDE.md` on the way in.
 *
 * A strict descent terminates by construction: `complex` reaches `normal` and
 * `simple`, `normal` reaches `simple`, `simple` reaches nothing, so no chain
 * runs deeper than two hops and every hop is cheaper than the one above it.
 * The rule it replaces — "keep fan-out proportionate" — asked for a judgement
 * call, and a model holding a nine-item list judged that splitting it was
 * proportionate. This asks for a lookup instead, which is the difference
 * between a guard a model can follow and one it can rationalise past.
 *
 * `available` is the role's own configured tiers, and intersecting with it is
 * not optional. `cmdSync` writes an agent only for a tier the config defines,
 * and `normal` is optional precisely so existing configs need no migration —
 * so a role holding `simple` and `complex` alone (this repository's own config
 * among them) would otherwise have its `complex` agent told to delegate to
 * `*-normal`, an alias `resolveTierAlias` refuses and `cmdSync` never wrote.
 * That is the same silent failure `tierChoice` already guards against, and it
 * fails in the worst direction: nothing errors at generation time, and the
 * delegation dies at dispatch.
 *
 * Narrowing can only ever under-name. The `*-` wildcard spans roles, so a
 * tier this role lacks might still exist on another, and intersecting with
 * this role's tiers can withhold a delegation that would have worked. That is
 * the safe side: under-naming costs one rung of precision, while over-naming
 * points at an agent that does not exist.
 *
 * A collapsed agent (no tier in its name) is generated only when every one of
 * the role's present lists is element-wise identical, so each tier resolves to
 * the same ranked candidates. "Down" does not exist for it: delegating would
 * buy the same models for the price of another subagent. Returning no tiers
 * makes it a leaf, which is also what makes it safe for a *higher* agent to
 * call — a leaf cannot extend the chain.
 */
function tiersBelow(own: Tier | undefined, available: readonly Tier[]): readonly Tier[] {
  if (own === undefined) return [];
  return TIER_NAMES.slice(0, TIER_NAMES.indexOf(own)).filter((tier) => available.includes(tier));
}

/** `a`, `a` or `b`, `a`, `b` or `c` — an Oxford-free list for prose. */
function orList(items: readonly string[]): string {
  return items.join(items.length === 2 ? ' or ' : ', ').replace(/, ([^,]*)$/, ' or $1');
}

/**
 * The fan-out rule, on every generated agent rather than read-only ones.
 *
 * A tier agent that delegates to `Plan`, `Explore` or `general-purpose` hands
 * the work back to Claude, which ends the foreign-model lane silently — the
 * subagent runs, reports, and looks exactly like a routed one. Observed
 * 2026-09-16: a `code-complex` agent called `Plan` (Opus). The old guard said
 * nothing about this and sat only on read-only roles, so the agent most able
 * to fan out was the one told least.
 *
 * It is prompt text because nothing stronger exists: Claude Code's `tools:`
 * frontmatter grants tools, not permitted argument values, so it can withhold
 * `Agent` entirely but cannot constrain which `subagent_type` is passed to it.
 * Withholding it outright was considered and rejected — `explore-*` fanning
 * out to scoped sub-explorers is the pattern that makes a broad search
 * affordable, and removing the capability to bound it would cost that.
 */
function fanOut(planTiers: readonly Tier[], ownTier: Tier | undefined, available: readonly Tier[]): string {
  const below = tiersBelow(ownTier, available);

  const leaf = below.length === 0;
  const descent = leaf
    ? `**Do not spawn another sonata tier agent.**
${ownTier === undefined
      ? 'Every tier of this role resolves to the same ranked models, so delegating\nwould buy nothing and cost a whole subagent.'
      : 'You are the cheapest tier; there is nothing below you to delegate to.'}
Whatever is left, do yourself.`
    : `**Delegate downward only.** You may spawn ${orList(below.map((tier) => `\`*-${tier}\``))} agents.
Never your own tier (\`*-${ownTier}\`), and never one above it — a \`${ownTier}\` agent
spawning \`${ownTier}\` agents has no stopping point, and each one re-reads from
scratch everything you have already read.`;

  // Named from the `plan` role's own config, not this role's: their
  // availability is independent, and naming an agent sonata did not generate
  // sends the delegation nowhere. A collapsed `plan` (no tiers) is reachable
  // from any tier because it is a leaf — it cannot extend the chain.
  const reachablePlans = planTiers.length === 0
    ? ['`plan`']
    : planTiers.filter((tier) => below.includes(tier)).map((tier) => `\`plan-${tier}\``);
  const plan = reachablePlans.length === 0
    ? `Need a plan? ${leaf ? 'Work it out yourself — nothing sits below you.' : 'No plan agent sits below your tier — work it out yourself.'}`
    : `Need a plan? That is ${orList(reachablePlans)}, not \`Plan\`.`;

  return `## Fanning out

${descent}

${leaf ? 'Should you delegate anyway' : 'When you do delegate'}, delegate to a **sonata tier agent** — the \`code-*\`,
\`review-*\`, \`explore-*\` and \`plan-*\` agents this config generates. Do not call
Claude's own \`Plan\`, \`Explore\`, \`Task\` or \`general-purpose\` agents: they run on
Claude, which silently ends the foreign-model lane this run exists to provide.
${plan}

${NO_MODEL_ARG}

**Spawn at most ${FANOUT_LIMIT} subagents in your entire run**, and count them as you go.
Every one spends tokens your caller pays for and inherits this repository's
\`CLAUDE.md\` before it reads a word of its own task, so all of them re-read
everything you already have. Scope each to files you name. A numbered list of
independent questions is a prompt to answer yourself, not a work breakdown to
split: if it does not fit in ${FANOUT_LIMIT} agents, it does not fit, and saying so is
the correct result.
`;
}

/**
 * A read-only role's frontmatter tool list. Fan-out is granted to read-only
 * roles explicitly because their `tools:` line is an allow-list — omitting the
 * agent tools there is what would remove the capability, whereas a
 * write-capable role has no `tools:` line at all and already inherits them.
 */
function toolsForRole(role: string): string {
  if (!isReadOnlyRole(role)) {
    // Write-capable agents already inherit the full tool set, including fan-out.
    return '';
  }
  return `tools: Read, Grep, Glob, ${FANOUT_TOOLS}\n`;
}

/**
 * The fan-out guidance for a role: the lane rule for everyone, plus the
 * read-only-delegation rule for the roles that need it.
 */
function delegatingForRole(role: string, planTiers: readonly Tier[], ownTier: Tier | undefined, available: readonly Tier[]): string {
  const readOnly = isReadOnlyRole(role) ? `\n\n${DELEGATING}` : '';
  const scoping = role === 'review' ? `\n\n${REVIEW_SCOPE}` : '';
  return `\n\n${fanOut(planTiers, ownTier, available)}${scoping}${readOnly}`;
}

/**
 * The agent file for one legacy per-model harness route.
 *
 * Generated only for a config with no `[tiers]`: a tiered config skips this
 * path entirely. The agent is a forwarding wrapper, not a worker — it runs on
 * `haiku`, holds only the three `sonata dispatch` Bash permissions, and its
 * whole job is to launch the run and return the report. The body is mostly
 * shell-quoting procedure because the task must reach the model as a file or
 * on stdin: a task carrying backticks or `$(...)` spliced into a command line
 * would be corrupted or would hijack it, and the wrapper has no tool to escape
 * it safely.
 */
export function agentMarkdown(spec: AgentSpec): string {
  const name = `${spec.role}-${spec.model}`;
  const blurb = ROLE_BLURB[spec.role] ?? spec.role;

  return `---
name: ${name}
description: Delegates ${blurb} to ${spec.model} running under ${spec.harness}. Use when this work should run on ${spec.model} rather than Claude — typically to save cost on bulk work, or to get a different model's judgement.
model: haiku
tools: Bash(sonata dispatch:*), Bash(sonata wait:*), Bash(sonata approve:*)
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

1. Run this Bash command exactly once, from the caller's own working directory:

       sonata dispatch --model ${spec.model} --role ${spec.role} --task-file <path>

   The task must reach the model as a **file or via stdin**, never spliced
   into the shell command line as text: a task containing backticks,
   \`$(...)\`, quotes, or \`$HOME\`-style expansions would corrupt or hijack
   the command if embedded directly into a shell string, and you have no
   tool to escape it safely.

    - If the caller gave you a **file path** holding the task, pass it with
      \`--task-file <path>\` and do not open the file yourself. A path cannot
      be paraphrased, and forwarding it **verbatim, byte for byte** — never
      summarised, shortened, or rewritten — is the whole job: a 3,000-word
      spec once reached the model as a single sentence, so it never saw the
      instructions it was meant to follow.
    - If the caller instead gave you the task as inline text, pass it via
      stdin using Bash single-quoting — the ONE mechanically complete way to
      make arbitrary text (backticks, \`$(...)\`, \`$HOME\`, quotes, anything)
      safe in a shell command, with no judgment call and no possibility of
      collision (unlike picking a delimiter string, which depends on hoping
      the text doesn't contain it):

      1. In the task text, replace every single-quote character (\`'\`) with
         the four characters \`'\\''\` (a closing quote, a backslash-escaped
         quote, and a reopening quote). Leave every other character
         untouched — nothing else needs escaping inside single quotes.
      2. Wrap the ENTIRE result (start to finish) in a pair of single quotes.
      3. Feed it to \`sonata dispatch\` via a Bash here-string and
         \`--task-stdin\` — NOT a pipe: your only allowed command is
         \`sonata dispatch\`, and a pipe would start the line with a
         different command (\`printf\`) that isn't covered by that
         permission. A here-string keeps the whole line starting with
         \`sonata dispatch\`:

             sonata dispatch --model ${spec.model} --role ${spec.role} --task-stdin <<< '<escaped task text>'

      Worked example: if the task text is \`it's done\`, step 1 turns the
      single quote into \`it'\\''s done\`, and step 2 wraps it as
      \`'it'\\''s done'\` — giving:

             sonata dispatch --model ${spec.model} --role ${spec.role} --task-stdin <<< 'it'\\''s done'

      Apply this to the WHOLE task text exactly once, including any
      backticks, dollar signs, or newlines it contains — do not additionally
      escape those; single-quoting already neutralizes them. Never rewrite,
      summarise, or add anything to the task text itself before escaping it.

   The command blocks until the run is worth reporting, so one call is
   usually the whole job. Do not add your own waiting.

2. Its first line of output is \`<STATE> model=<key> id=<id>\`. Act on \`<STATE>\`:

   - **DONE** — the report follows on subsequent lines. Return it as your
     final message and stop. Include its closing \`— sonata <id>: …\`
     provenance line exactly as given: it is the evidence the run really
     happened. If the report is marked degraded, say so in your first line;
     the harness exited without writing a report and the content is scraped
     terminal output.
   - **PAUSED** — the output includes \`PROMPT: <text>\` and a
     \`sonata approve <id>\` line. Stop and return immediately. Your final
     message must be exactly: \`PAUSED <id>\` on the first line, then the
     pending action. You cannot approve it yourself; the main thread will ask
     the user and run \`sonata approve <id> --yes\`/\`--no\` itself. The tmux
     session stays alive, so nothing is lost.
   - **RUNNING** — the output includes a \`sonata wait <id>\` line. Run that
     exact command, then act on what it returns (its own first line is a bare
     \`<STATE>\`, not \`<STATE> model=... id=...\`). This is the only case
     where you make a second call.
   - **FAILED** — the output lists every candidate tried, one per line, with
     its state and reason. Stop and return: first line \`FAILED <id>\`, then
     that list. Do not retry it yourself.
   - **STALLED** — no report and no further output. Stop and return: first
     line \`STALLED <id>\`. Do not try to diagnose it.

3. Never run \`sonata approve\` yourself. Never start a second run. The main
   thread runs \`sonata approve <id>\` itself if it answers a paused run.

4. If the command itself is refused — a permission denial rather than any of
   the states above — stop and say so as your first line:
   \`BLOCKED <tool> denied\`. Do not retry it, work around it, or summarise the
   task from nothing. The run may still be executing in tmux and is now
   unobserved, which is the one outcome worse than a failed dispatch: the
   human needs to know a model is writing to their repository with nothing
   watching it.

To watch the run live, a human can attach with \`tmux attach -r -t sonata-<id>\`
(\`-r\` is read-only; drop it to steer a cheap model mid-run). Sonata cannot
stream the harness conversation into Claude Code — a subagent receives text
only as tool results — so attaching is the way to see it as it happens.

Your final message must end with a line naming the run:

    run: <id>  model: ${spec.model}
`;
}


/**
 * The agent file for one legacy per-model *native* route.
 *
 * The native counterpart of `agentMarkdown`: the model runs inside Claude
 * Code's own loop through the router rather than in a harness, so the file
 * pins the model in frontmatter and carries no dispatch commands. Like
 * `agentMarkdown` it is generated only for an untiered config, and it names
 * its routing precondition because an unrouted session fails with
 * `model_not_found` at `api.anthropic.com`, which reads as a broken agent.
 */
export function nativeAgentMarkdown(spec: { role: string; model: string }): string {
  const blurb = ROLE_BLURB[spec.role] ?? spec.role;
  const tools = toolsForRole(spec.role);
  const delegating = delegatingForRole(spec.role, TIER_NAMES, undefined, TIER_NAMES);

  return `---
name: native-${spec.role}-${spec.model}
description: Runs ${blurb} natively on ${spec.model} inside Claude Code's own loop. ${NO_MODEL_ARG} Requires a routed session (sonata code, or sonata route on).
model: ${spec.model}
${tools}---

This agent only works in a routed session (sonata code, or sonata route on).

${NO_MODEL_ARG}

Focus on ${blurb}.${delegating}
`;
}

/**
 * The agent file for one role x tier — or for a role whose tiers collapse.
 *
 * The `description` matters more than the body: it is what the dispatching
 * model reads while *choosing* an agent, so both the tier criterion and the
 * no-`model`-argument warning live there as well as below the frontmatter. By
 * the time the body is in context, the choice has already been made.
 *
 * `availableTiers` and `planTiers` are what keep the generated prompt honest.
 * Naming a tier the config does not define points a dispatch at an agent
 * `cmdSync` never wrote and `resolveTierAlias` refuses — silent, since nothing
 * on that path fails loudly.
 */
export function tierAgentMarkdown(spec: {
  role: string;
  tier?: 'simple' | 'normal' | 'complex';
  /**
   * Declare a 1M window for this tier's alias. Claude Code reads the `[1m]`
   * suffix as "assume 1M" and strips it before forwarding, so the router still
   * resolves the bare alias — see `src/extended-context.ts`.
   */
  extendedContext?: boolean;
  /**
   * The tiers this role's config actually defines. Defaults to all of them,
   * which is right for a caller that has not been taught availability yet and
   * wrong only in the direction the old code was already wrong.
   */
  availableTiers?: readonly Tier[];
  /** The tiers the `plan` role defines — independent of this role's. */
  planTiers?: readonly Tier[];
}): string {
  const blurb = ROLE_BLURB[spec.role] ?? spec.role;
  const tier = spec.tier;
  const name = tier === undefined ? spec.role : `${spec.role}-${tier}`;
  const alias = tier === undefined ? `sonata-${spec.role}` : `sonata-${spec.role}-${tier}`;
  const model = spec.extendedContext === true ? `${alias}${EXTENDED_CONTEXT_SUFFIX}` : alias;
  const tools = toolsForRole(spec.role);
  const available = spec.availableTiers ?? TIER_NAMES;
  const delegating = delegatingForRole(spec.role, spec.planTiers ?? TIER_NAMES, tier, available);
  const description = tier === undefined
    ? `Runs ${blurb} on a ranked list of foreign models, natively inside Claude Code's loop. ${NO_MODEL_ARG} Requires a routed session (sonata code, or sonata route on/auto).`
    : `Runs ${blurb} on a ranked list of foreign models (${tier} tier), natively inside Claude Code's loop. ${TIER_CRITERION[tier]} Size is not difficulty — a large mechanical change is simple, a three-line change that decides an interface is complex. ${NO_MODEL_ARG} Requires a routed session (sonata code, or sonata route on/auto).`;

  return `---
name: ${name}
description: ${description}
model: ${model}
${tools}---

This agent only works in a routed session (sonata code, or sonata route on/auto).

${NO_MODEL_ARG}
${tierChoice(available)}

The tier is the model choice: pick ${available.map((t) => `-${t}`).join(' or ')}, and let
the frontmatter select the model.

${TIER_AGENT_MARKER} — edits here are overwritten on the next sync.

Focus on ${blurb}.${delegating}
`;
}

export interface SyncOptions { cwd: string; agentsDir: string; home?: string }

export interface SyncResult {
  /** Paths written. */
  written: string[];
  /**
   * The subset of `written` whose content actually changed, new files
   * included. Every run rewrites every agent, so `written` alone cannot say
   * whether Claude Code has anything new to load — and a ranking change never
   * touches an agent file, since each names only its routed alias and the
   * router reads the ranked list from `sonata.toml` per request.
   */
  changed?: string[];
  /** Filenames sonata wrote that the config no longer covers. Not deleted. */
  stale: string[];
  /** Paths sonata declined to overwrite because they already exist and are not sonata-owned. */
  skipped: string[];
}

/**
 * The legacy per-model agents, for a config with no `[tiers]`.
 *
 * Mirrors `cmdSync`'s legacy branch exactly, including its wrapper rule: a
 * native model gets a `native-<role>-<model>` agent plus a `<role>-<model>`
 * wrapper, and the wrapper is skipped when a harness-based agent already
 * claims that name. Getting that skip wrong here would make `doctor` report a
 * file `sync` never writes.
 */
function legacyPlannedAgents(config: SonataConfig): PlannedAgent[] {
  const out: PlannedAgent[] = [];
  const wanted = generatedAgents(config);
  for (const { role, model } of wanted) {
    out.push({
      name: `${role}-${model}`,
      content: agentMarkdown({ role, model, harness: config.models[model].harness }),
    });
  }
  for (const { role, model } of generatedNativeAgents(config)) {
    out.push({ name: `native-${role}-${model}`, content: nativeAgentMarkdown({ role, model }) });
    const wrapperName = `${role}-${model}`;
    if (!wanted.some((a) => `${a.role}-${a.model}` === wrapperName)) {
      out.push({ name: wrapperName, content: agentMarkdown({ role, model, harness: 'claude' }) });
    }
  }
  return out;
}

/** One agent `sync` would write: its bare name and the exact bytes. */
export interface PlannedAgent { name: string; content: string }

/**
 * Every tier agent this config implies, with the content sonata would write.
 *
 * Extracted so `cmdSync` and `sonata doctor` read one definition: doctor
 * compares these bytes against what is on disk, and a second copy of the
 * generation rules would drift from the writer exactly as `tiersCollapse` did
 * across its three call sites.
 *
 * Returns nothing for an untiered config, where `sync` takes the legacy
 * per-model path instead.
 */
export function plannedAgents(config: SonataConfig): PlannedAgent[] {
  // An untiered config takes `cmdSync`'s legacy branch, which still writes
  // per-model agents — so returning nothing here gave the freshness check a
  // silent blind spot on exactly the configs least likely to have been synced
  // recently. Found by the final review gate.
  if (config.tiers === undefined) return legacyPlannedAgents(config);
  const tiersOf = (role: string): readonly Tier[] => {
    const lists = config.tiers?.[role];
    if (lists === undefined || tiersCollapse(lists)) return [];
    return TIER_NAMES.filter((tier) => lists[tier] !== undefined);
  };
  const planTiers = tiersOf('plan');
  const out: PlannedAgent[] = [];
  for (const [role, lists] of Object.entries(config.tiers) as Array<[string, TierLists]>) {
    const tiers: ('simple' | 'normal' | 'complex' | undefined)[] = tiersCollapse(lists)
      ? [undefined]
      : [...TIER_NAMES.filter((tier) => lists[tier] !== undefined)];
    for (const tier of tiers) {
      const extendedContext = tier === undefined
        ? tierQualifiesForExtendedContext(config, lists.simple)
          && tierQualifiesForExtendedContext(config, lists.complex)
        : (() => {
          const keys = lists[tier];
          return keys !== undefined && tierQualifiesForExtendedContext(config, keys);
        })();
      out.push({
        name: `${role}${tier === undefined ? '' : `-${tier}`}`,
        content: tierAgentMarkdown({
          role,
          tier,
          // The collapsed alias serves both lists, so it may only claim the
          // window both of them can honour.
          extendedContext,
          availableTiers: tiersOf(role),
          planTiers,
        }),
      });
    }
  }
  return out;
}

/**
 * Sonata-owned agent files whose body is not what sonata would write now.
 *
 * `staleAgents` compares *filenames* and so cannot see this: an agent
 * generated by an older sonata keeps its name and quietly keeps its old
 * instructions. Measured 2026-09-18 — PR #50 bounded tier-agent fan-out, and a
 * project whose agents were generated two hours earlier went on running the
 * unbounded `review-complex` that had spawned eight children and exhausted a
 * $200 budget. Nothing reported it, because a generated prompt only reaches a
 * project when `sonata sync` runs *in that project*.
 *
 * A file sonata does not own is skipped: `sync` deliberately refuses to
 * overwrite one, so naming it would send the user to a command that will not
 * fix it. An absent file is skipped too — `sync` will simply write it, which
 * is a different report from a stale body.
 */
export function outdatedAgents(agentsDir: string, planned: readonly PlannedAgent[]): string[] {
  if (!existsSync(agentsDir)) return [];
  return planned
    .filter(({ name, content }) => {
      const path = join(agentsDir, `${name}.md`);
      let existing: string;
      try {
        existing = readFileSync(path, 'utf8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return false;
        throw error;
      }
      if (!isSonataAgentText(existing)) return false;
      return existing !== content;
    })
    .map(({ name }) => name);
}

/**
 * Regenerate the `.claude/agents` files from `sonata.toml`.
 *
 * The sole writer of the agent files, and a reader — never a writer — of the
 * config: `sonata init` and `sonata agents` own that file, so a regeneration
 * can never cost a setting. When `[tiers]` is present it generates only tier
 * agents, one per role x present tier, or a single unsuffixed agent for a role
 * whose present lists are element-wise identical; legacy per-model generation
 * is skipped entirely rather than merged, so the two shapes cannot both appear.
 *
 * `--prune` removes sonata-marked files the current config no longer names.
 * Only marked files are ever removed: an agent someone wrote by hand survives.
 */
export function cmdSync(opts: SyncOptions): SyncResult {
  const config = loadConfig(opts.cwd, opts.home);
  mkdirSync(opts.agentsDir, { recursive: true });

  if (config.tiers !== undefined) {
    const written: string[] = [];
    const changed: string[] = [];
    const skipped: string[] = [];
    // Read once, from the config: what the generated prompts may name. A role
    // that collapses generates one unsuffixed agent, so it offers no tier
    // choice at all; `plan`'s availability is independent of the role being
    // written, because that is the role a fan-out delegates to.
    const tiersOf = (role: string): readonly Tier[] => {
      const lists = config.tiers?.[role];
      if (lists === undefined || tiersCollapse(lists)) return [];
      return TIER_NAMES.filter((tier) => lists[tier] !== undefined);
    };
    // One generator, shared with `sonata doctor`'s outdated-agent check: two
    // copies of these rules would disagree about what sonata writes, which is
    // precisely the drift `tiersCollapse` demonstrated.
    for (const { name, content } of plannedAgents(config)) {
      const path = join(opts.agentsDir, `${name}.md`);
      if (existsSync(path) && !isSonataAgentText(readFileSync(path, 'utf8'))) {
        skipped.push(path);
        continue;
      }
      if (!existsSync(path) || readFileSync(path, 'utf8') !== content) changed.push(path);
      writeFileSync(path, content);
      written.push(path);
    }
    return {
      written,
      changed,
      stale: staleAgents(opts.agentsDir, expectedAgentNames(config)),
      skipped,
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
  // wrapper agent (for dispatch from normal sessions via the claude harness).
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
    skipped: [],
  };
}
