/**
 * `sonata init` — first-run onboarding and repair.
 *
 * Interactive by default; every choice also has a flag so the command works in
 * CI and scripts. Nothing is written until the user confirms the summary.
 *
 * The wizard writes the unified `[models]` registry plus `[tiers.<role>]`
 * ranked lists — discovered native candidates keep `gateway`/`id`, and
 * harness-discovered ones keep `harness`/`harness_id` (both, for a model
 * reachable either way). A config still written in the older
 * `[generate.roles]`/`[generate.native]` shape is migrated on load
 * (`migrateLegacyConfig`, `src/normalize.ts`) rather than left behind or
 * silently dropped.
 *
 * Pure helpers used by the `src/init/*` pipeline live in
 * `../init/helpers.js`; this file keeps the `cmdInit` orchestration and
 * re-exports them for `cli.ts` and the test files that import them from
 * `./commands/init.js`.
 */
import { join } from 'node:path';
import {
  type Problem,
} from '../detect.js';
import { confirm, isInteractive, banner, CancelledError } from '../tui.js';
import { openInitLog, type InitLog } from './init-log.js';
import { nativeTomlFor } from '../init/toml.js';
import { discover, type InitEnvironment } from '../init/discover.js';
import { interactiveState } from '../init/interactive-state.js';
import { scriptedState } from '../init/scripted-state.js';
import { plan, fsCredentialProbe } from '../init/plan.js';
import { apply } from '../init/apply.js';
import { validate } from '../init/validate.js';

export { nativeTomlFor } from '../init/toml.js';
import type { InitState } from '../tui-ink/types.js';

import {
  configPathFor,
  type Detection, type Detector, type ConfigScope, type InitOptions, type InitResult, type NativeCandidate,
} from '../init/helpers.js';
export {
  OPENCODE_RANGE, defaultDetector, dedupeOauthProviders, credentialAvailabilityFor,
  configPathFor, agentsDirFor, parseCredentialSourceFlags, nativeCandidatesFrom,
  oauthProvidersFor, avoidedKeysOf, gatewayNamesOf, nativeLabel,
  reconcilePerRoleModels, reconcileTierList, deriveInitState, configNativeCandidates,
  preTickedNative, previousAskedStep, duplicateKeys,
} from '../init/helpers.js';
export type {
  Detection, Detector, ConfigScope, InitOptions, InitResult, NativeCandidate,
} from '../init/helpers.js';

function renderProblem(p: Problem): string {
  const icon = p.severity === 'error' ? '✗' : p.severity === 'warn' ? '!' : 'ℹ';
  const fix = p.fix ? `\n      ❯ ${p.fix}` : '';
  return `  ${icon} ${p.message}${fix}`;
}

export async function cmdInit(opts: InitOptions): Promise<InitResult> {
  const log = opts.log ?? openInitLog(opts.home);
  const print = opts.write ?? ((l: string) => console.log(l));
  // Everything the command says is teed to the log. The wizard owns the screen
  // — Ink repaints and the list prompts use the alternate buffer — so what is
  // on the terminal after a failed run is not what the run said.
  const out = (line: string): void => { print(line); log.line(line); };
  const interactive = !opts.yes && isInteractive();
  log.line(`cwd=${opts.cwd} home=${opts.home} interactive=${interactive} yes=${opts.yes ?? false}`);
  try {
    return await runInit(opts, out, log, interactive);
  } catch (error) {
    log.fail(error);
    throw error;
  }
}

async function runInit(
  opts: InitOptions,
  out: (line: string) => void,
  log: InitLog,
  interactive: boolean,
): Promise<InitResult> {
  out('');
  out(interactive ? banner() : '  sonata init');
  out('');

  // ---- discover ---------------------------------------------------------
  const env: InitEnvironment = await discover({
    cwd: opts.cwd,
    home: opts.home,
    packageRoot: opts.packageRoot,
    detect: opts.detect,
  }, out);

  if (env.problems.some((p) => p.severity === 'error')) {
    for (const p of env.problems) out(renderProblem(p));
    out('');
    out('  Fix the errors above, then run `sonata init` again.');
    return blockedResult(env.problems, opts);
  }
  for (const p of env.problems) out(renderProblem(p));

  // ---- choose -----------------------------------------------------------
  // The two front ends (`interactiveState`, `scriptedState`) live in
  // `src/init/`. Each one returns the same `InitState` shape plus a
  // candidate map covering BYOK and live additions the front end made — the
  // post-frontend `validate` step needs those additions to recognise the
  // user-selected models. The wizard additionally reports whether the user
  // cancelled.
  const chosen = interactive
    ? await interactiveState(env, opts, log)
    : { ...scriptedState(env, opts), cancelled: false };
  if (chosen.cancelled) {
    out('  Nothing written.');
    return cancelledResult(env.problems, chosen.state, opts);
  }

  // ---- validate ---------------------------------------------------------
  // Validation precedes planning: a plan built from an invalid state is a
  // plan nobody should see, and `validate` resolves its own candidates so it
  // has no dependency on `plan` having run. The front end's `nativeByKey`
  // is passed so BYOK and live-refresh candidates are visible to the
  // unknown-model check — they were added in the front end's own scope and
  // are not in `env.allNativeCandidates`.
  const problems = validate(env, chosen.state, { nativeByKey: chosen.nativeByKey });
  if (problems.length > 0) {
    if (!interactive) throw new Error(problems[0].message);
    for (const p of problems) out(renderProblem(p));
    return cancelledResult(env.problems, chosen.state, opts);
  }

  // ---- plan -------------------------------------------------------------
  const credentials = fsCredentialProbe(opts.home, env.copilotUsable);
  const initPlan = plan(env, chosen.state, credentials, opts);

  for (const line of initPlan.notices) out(line);
  out('');
  for (const line of initPlan.summary) out(line);
  out('');

  log.line(`hook scope resolved: ${initPlan.hook.scope}`);
  if (interactive) log.line('prompting for write confirmation');
  if (interactive && !(await confirm('Write these changes?', true))) {
    out('  Nothing written.');
    return cancelledResult(env.problems, chosen.state, opts);
  }

  // ---- apply ------------------------------------------------------------
  const applied = await apply(initPlan, opts, {
    out,
    prune: opts.prune ?? (interactive ? async () => confirm('Delete them?', true) : false),
  });

  out('');
  out('  Done. Run /reload-plugins to pick up the new agents.');
  out('  Native sessions: run `sonata code`, or `sonata route on` to route plain claude sessions.');
  out('');

  return {
    problems: env.problems, models: initPlan.nativeKeys, roles: initPlan.roles,
    scope: initPlan.hook.scope, routing: initPlan.routing,
    hookChanged: applied.hookChanged, agentsWritten: applied.agentsWritten,
    configPath: initPlan.configPath, pruned: applied.pruned,
  };
}

function blockedResult(problems: Problem[], opts: InitOptions): InitResult {
  return {
    problems, models: [], roles: [], scope: 'skip', routing: 'skip', hookChanged: false,
    agentsWritten: [], configPath: join(opts.cwd, 'sonata.toml'),
    pruned: [],
  };
}

function cancelledResult(problems: Problem[], state: InitState, opts: InitOptions): InitResult {
  return {
    problems, models: [], roles: [], scope: 'skip', routing: 'skip', hookChanged: false,
    agentsWritten: [], configPath: configPathFor(
      state.configScope ?? 'project', opts.cwd, opts.home),
    pruned: [], cancelled: true,
  };
}

export function isCancellation(err: unknown): boolean {
  return err instanceof CancelledError;
}
