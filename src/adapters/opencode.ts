import type { HarnessAdapter, LaunchPlan, PlanInput, UsageQuery, UsageRecord, UsageResult } from './types.js';
import { opencodeDbPath } from '../native/opencode-store.js';
import { openReadOnlySync } from '../sqlite.js';
import { ambiguous, asRecord, canonicalPath, count, epochMs, inWindow, money, narrowByMarker, WINDOW_SLACK_MS } from './usage-files.js';
import { isReadOnlyRole } from '../config.js';
import { wireEffort } from '../effort.js';

/**
 * Empty, and that is the finding rather than an omission.
 *
 * `opencode run` has no approval UI. Probed against opencode 1.18 with
 * `--interactive` and `permission = { bash = "ask" }`, a tool call that needs
 * approval is not offered to the user at all — it is refused outright:
 *
 *     ! permission requested: bash (rm file.txt); auto-rejecting
 *     ✗ rm file.txt failed
 *
 * See tests/fixtures/panes/opencode-auto-reject.txt. So a `run` invocation is
 * never PAUSED: it either proceeds unasked or fails. The earlier patterns here
 * were invented rather than observed and matched none of this.
 */
const PROMPT_PATTERNS: RegExp[] = [];

/**
 * `opencode run --agent` accepts PRIMARY agents only — `build` and `plan`.
 *
 * `explore` exists but is a subagent, so asking for it does not fail: opencode
 * substitutes the default agent, which is the write-capable `build`, and says
 * so only in a pane warning nothing parses. The explore role therefore stopped
 * being read-only without anything reporting it. Enabling `explore` in
 * opencode.json does not help — it is still not primary.
 *
 * So every read-only role maps to `plan`, which is primary and genuinely
 * read-only. A role sonata calls read-only must never resolve to `build`.
 */
function agentFor(input: PlanInput): string {
  if (input.mode === 'plan') return 'plan';
  if (isReadOnlyRole(input.role)) return 'plan';
  return 'build';
}

function buildScript(input: PlanInput): LaunchPlan {
  const readOnly = isReadOnlyRole(input.role);

  // `default` means "ask before doing anything irreversible". OpenCode cannot
  // ask — it either proceeds unprompted or auto-rejects — so honouring the mode
  // is impossible. Running anyway would make a sonata subagent more permissive
  // than the session that dispatched it, silently. Refuse instead, and say why.
  //
  // Read-only roles are exempt: there is nothing for them to ask about.
  if (input.mode === 'default' && !readOnly) {
    throw new Error(
      'sonata: opencode cannot ask for approval, so it cannot honour `default` ' +
      'permission mode. Re-dispatch in acceptEdits or bypassPermissions to run ' +
      'it ungated, or use a codex model, whose TUI does prompt.',
    );
  }

  const auto = !readOnly && (input.mode === 'acceptEdits' || input.mode === 'bypassPermissions');
  const agent = agentFor(input);

  // `--interactive` selects opencode's split-footer renderer, which streams the
  // run into the pane. It does NOT make the run answerable: opencode auto-
  // rejects permission requests in `run` mode either way, so the plan reports
  // interactive: false and sonata never waits for an approval that cannot come.
  //
  // `modelId` is a full `provider/model` ref, passed through untouched. It used
  // to be prefixed with a hardcoded `opencode/`, which sent every run to the
  // free tier whatever the user selected — and that tier serves almost none of
  // the models people configure, so the run died before the model saw the task.
  const flags = ['run', `--agent ${agent}`, `-m ${input.modelId}`, '--interactive'];
  if (auto) flags.push('--auto');
  // Probed 2026-09-14 against opencode 1.18.29: `--variant <level>` is applied
  // on the `run` path — reasoning tokens moved with it on an identical prompt
  // (low → 132, xhigh → 230) and the stored message records the variant.
  //
  // The level is passed through UNMAPPED. models.dev publishes the legal set
  // per model (`reasoning_options[].values`; gpt-5.6-luna has no `minimal`),
  // and `opencode run` accepts an unknown variant silently rather than
  // erroring — so a level a model does not publish is dropped and sonata
  // cannot see that it was. Substituting a nearby level instead would run at a
  // setting the user never chose while still reporting it honoured, which is
  // worse than the unknown: same class as the router's own `drop_params`
  // limit, reported as what sonata can see and no more.
  //
  // Safe to place before the positional message: `opencode run --help` on
  // 1.18.29 declares `--variant` as `[string]`, unlike `-f`, which is `[array]`
  // and greedily eats the next positional — the bug the note below exists for.
  // `default` passes no `--variant`, so opencode uses the model's own default.
  const variant = wireEffort(input.effort);
  if (variant !== undefined) flags.push(`--variant ${variant}`);

  // `-f` is declared as an array option, so it greedily consumes any following
  // positional. The message MUST come before `-f` or opencode treats the prompt
  // text as a second filename and exits with "File not found".
  const script = [
    '#!/bin/bash',
    'set -o pipefail',
    'export PATH="$HOME/.opencode/bin:$PATH"',
    `cd '${input.cwd}' || exit 97`,
    `opencode ${flags.join(' ')} 'Follow the attached instructions.' -f '${input.instructionsPath}' 2>&1 | tee -a '${input.runDir}/harness.log'`,
    `echo $? > '${input.runDir}/exit'`,
    '',
  ].join('\n');

  // A run under opencode's `plan` agent cannot produce report.md, so such a
  // run is not degraded merely for lacking one; its output is the report.
  //
  // The enforcement is policy, not tool removal: the plan agent is instructed
  // that any modification is a violation superseding all other instructions,
  // and it declines. Probed directly — a run asked only to write one file
  // wrote nothing and reported "blocked by policy, not by error" — and
  // observed on two unrelated review runs that could not write their reports.
  // Weaker than pi, whose allowlist removes the write tool outright, but the
  // outcome for sonata is the same: no report arrives.
  //
  // Keyed off the agent actually chosen rather than the role, because the two
  // can differ: `plan` mode sends a write-capable role to the plan agent too.
  return { script, interactive: false, canWriteReport: agent !== 'plan', effortHonoured: true };
}

/**
 * A finished run's usage, from opencode's database.
 *
 * `opencode run` makes one root session in the launch directory, plus a child
 * session per subagent it spawns (`parent_id`); both are the run's spend.
 * Usage is read per assistant message, and only from messages that finished
 * (`time.completed`), since an unfinished one carries partial counts.
 * opencode reports reasoning apart from output, so the two are added — the
 * ledger's output is everything billed as output.
 *
 * opencode's own `cost` is trusted only when positive: it writes 0 for a model
 * it has no price for, which is indistinguishable from a free one, and a
 * guessed zero is exactly what the ledger refuses to record.
 */
export function openCodeUsage(query: UsageQuery): UsageResult {
  const db = openReadOnlySync(opencodeDbPath(query.home));
  if (db === undefined) return { kind: 'unobservable', reason: 'opencode\'s database could not be opened read-only' };
  try {
    const sessions = db.all(
      'SELECT id, parent_id, directory, time_created FROM session WHERE time_created >= ? AND time_created <= ?',
      query.startMs - WINDOW_SLACK_MS, query.endMs + WINDOW_SLACK_MS,
    );
    const found = sessions.filter((row) => row.parent_id === null
      && typeof row.directory === 'string' && canonicalPath(row.directory) === query.cwd
      && inWindow(epochMs(row.time_created), query.startMs, query.endMs));
    // Concurrent dispatches in one directory are told apart by the prompt,
    // which opencode keeps in `part` and whose last line names this run's
    // directory. `instr`, not LIKE: a path's `_` is a LIKE wildcard.
    const roots = narrowByMarker(found, (row) => db.all(
      'SELECT 1 FROM part WHERE session_id = ? AND instr(data, ?) > 0 LIMIT 1', String(row.id), query.runDir,
    ).length > 0);
    if (roots.length === 0) return { kind: 'unobservable', reason: 'no opencode session was recorded for this run' };
    if (roots.length > 1) return { kind: 'unobservable', reason: ambiguous('opencode', roots.length) };
    const root = String(roots[0]!.id);
    const ids = [root, ...sessions.filter((row) => row.parent_id === root).map((row) => String(row.id))];

    const records: UsageRecord[] = [];
    for (const id of ids) {
      for (const row of db.all('SELECT data FROM message WHERE session_id = ?', id)) {
        let data: Record<string, unknown> | undefined;
        try {
          data = asRecord(JSON.parse(String(row.data)));
        } catch {
          continue;
        }
        if (data?.role !== 'assistant') continue;
        const time = asRecord(data.time);
        if (epochMs(time?.completed) === undefined) continue;
        const tokens = asRecord(data.tokens);
        if (tokens === undefined) continue;
        const cache = asRecord(tokens.cache);
        const cost = money(data.cost);
        records.push({
          ts: new Date(epochMs(time?.created) ?? query.endMs).toISOString(),
          model: typeof data.modelID === 'string' ? data.modelID : undefined,
          tokens: {
            input: count(tokens.input),
            output: count(tokens.output) + count(tokens.reasoning),
            cacheRead: count(cache?.read),
            cacheCreation: count(cache?.write),
          },
          ...(cost !== undefined && cost > 0 ? { costUsd: cost } : {}),
        });
      }
    }
    return { kind: 'observed', session: root, records };
  } catch {
    return { kind: 'unobservable', reason: 'opencode\'s database did not have the expected shape' };
  } finally {
    db.close();
  }
}

export const openCodeAdapter: HarnessAdapter = {
  name: 'opencode',
  versionCommand: ['opencode', '--version'],
  supportedVersions: '>=1.18.0 <2.0.0',
  pathPrepend: ['$HOME/.opencode/bin'],
  plan: buildScript,
  canPromptForApproval: false,
  promptPatterns: PROMPT_PATTERNS,
  describePrompt(): string | null {
    return null;
  },
  /** Nothing to send: `opencode run` never waits for an answer. */
  approveKeys: { yes: [], no: [] },
  usage: openCodeUsage,
};
