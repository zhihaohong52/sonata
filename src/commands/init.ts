/**
 * `sonata init` — first-run onboarding and repair.
 *
 * Interactive by default; every choice also has a flag so the command works in
 * CI and scripts. Nothing is written until the user confirms the summary.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KNOWN_ROLES, configPath, GLOBAL_CONFIG_RELATIVE, parseConfig } from '../config.js';
import type { ModelRef } from '../types.js';
import {
  detectTmux, detectHarnesses, offerableProviders,
  type Problem, type HarnessStatus, type DetectEnv,
} from '../detect.js';
import {
  settingsPath, readSettings, writeSettings, installHook, allowSonataTools,
  hookInstalled, hookCommand, registerMcp, type HookScope, type Runner,
} from '../settings.js';
import { pruneAgents } from '../detect.js';
import { cmdSync } from './sync.js';
import { multiselect, select, confirm, isInteractive, banner, CancelledError, BackError } from '../tui.js';
import { keyReport } from '../native/credentials.js';

const OPENCODE_RANGE = '>=1.18.0 <2.0.0';

export interface Detection {
  tmux: { installed: boolean; version?: string; problems: Problem[] };
  harnesses: HarnessStatus[];
}

export type Detector = (env: DetectEnv) => Promise<Detection>;

/** Real environment probe. Tests inject a substitute so they stay hermetic. */
export const defaultDetector: Detector = async (env) => ({
  tmux: await detectTmux(),
  harnesses: await detectHarnesses(env),
});

export type ConfigScope = 'project' | 'global';

/**
 * Where a config is written for a scope. The read-side counterpart is
 * `configPath`, which resolves a precedence chain; this picks one location.
 */
export function configPathFor(scope: ConfigScope, cwd: string, home: string): string {
  return scope === 'global'
    ? join(home, GLOBAL_CONFIG_RELATIVE)
    : join(cwd, 'sonata.toml');
}

/**
 * Agents follow the config's scope. Keeping them together is the whole point:
 * `init` in $HOME used to write agents globally and config where only $HOME
 * could read it, producing agents that were offered everywhere and worked
 * nowhere.
 */
export function agentsDirFor(scope: ConfigScope, cwd: string, home: string): string {
  return scope === 'global'
    ? join(home, '.claude', 'agents')
    : join(cwd, '.claude', 'agents');
}

export interface InitOptions {
  cwd: string;
  home: string;
  packageRoot: string;
  /** Non-interactive overrides. When `yes` is set, no prompts are shown. */
  yes?: boolean;
  /** Picker keys, `harness/provider`. Non-interactive override. */
  providers?: string[];
  models?: string[];
  roles?: string[];
  /** Native model keys (see `nativeCandidatesFrom`). Empty/omitted means no native table. */
  nativeModels?: string[];
  /** Roles to generate native agents for. Only meaningful when `nativeModels` is non-empty. */
  nativeRoles?: string[];
  scope?: HookScope | 'skip';
  /** Where the config and its agents are written. Defaults to `project`. */
  configScope?: ConfigScope;
  /** Injected in tests so registration never shells out to the real binary. */
  mcpRunner?: Runner;
  prune?: boolean;
  write?: (line: string) => void;
  detect?: Detector;
}

export interface InitResult {
  problems: Problem[];
  models: string[];
  roles: string[];
  scope: HookScope | 'skip';
  hookChanged: boolean;
  agentsWritten: string[];
  configPath: string;
  mcpChanged: boolean;
  pruned: string[];
  cancelled?: boolean;
}

function renderProblem(p: Problem): string {
  const icon = p.severity === 'error' ? '✗' : p.severity === 'warn' ? '!' : 'ℹ';
  const fix = p.fix ? `\n      ❯ ${p.fix}` : '';
  return `  ${icon} ${p.message}${fix}`;
}

export interface ConfigEntry { harness: string; id: string }

/**
 * Entries the wizard does not manage, and so must not delete.
 *
 * `init` overwrites sonata.toml wholesale. Codex models are added by hand —
 * the README says so — which makes the wizard the only thing that can destroy
 * them.
 */
export function carriedEntries(
  configText: string,
  managed: string[],
): Record<string, ConfigEntry> {
  let models: Record<string, ConfigEntry>;
  try {
    models = parseConfig(configText).models;
  } catch {
    return {};
  }

  const kept: Record<string, ConfigEntry> = {};
  for (const [key, entry] of Object.entries(models)) {
    if (!managed.includes(entry.harness)) kept[key] = entry;
  }
  return kept;
}

const TOML_ESCAPES: Record<string, string> = {
  '\\': '\\\\', '"': '\\"', '\b': '\\b', '\t': '\\t',
  '\n': '\\n', '\f': '\\f', '\r': '\\r',
};

/**
 * A TOML basic string, used for every key and value this file writes.
 *
 * An unquoted dotted key nests and corrupts the table, and a raw control
 * character makes the document unreadable. Both matter because carried
 * entries are user-authored: a hand-written id containing a newline once
 * produced a config that no longer parsed, destroying the very entry
 * carrying-forward exists to preserve.
 */
function tomlKey(key: string): string {
  // eslint-disable-next-line no-control-regex
  const escaped = key.replace(/[\\"\u0000-\u001f\u007f]/g, (ch) =>
    TOML_ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `"${escaped}"`;
}

/**
 * A native model candidate offered on the native-models screen.
 *
 * Unlike a harness `ModelRef`, a native model needs no harness — it is served
 * through the router/LiteLLM to Claude Code's own loop — but it does need a
 * gateway endpoint and a declared context window, neither of which a harness
 * ref carries.
 */
export interface NativeCandidate {
  key: string;
  gateway: string;
  id: string;
  contextWindow: number;
  baseUrl: string;
}

/**
 * Native candidates come from the same detected refs as the harness screens,
 * filtered to opencode providers whose base URL is known — that is the whole
 * requirement, because opencode is the only harness `sonata init` currently
 * discovers gateway endpoints from. A ref that clears the filter becomes one
 * candidate; `contextWindow` defaults to 128000 and is editable later by hand.
 */
export function nativeCandidatesFrom(
  refs: ModelRef[],
  providerBaseUrls: Record<string, string>,
): NativeCandidate[] {
  return refs
    .filter((r) => r.harness === 'opencode' && providerBaseUrls[r.provider] !== undefined)
    .map((r) => ({
      key: r.ref.replace(/\//g, '-'),
      gateway: r.provider,
      id: r.id ?? r.ref,
      contextWindow: 128000,
      baseUrl: providerBaseUrls[r.provider],
    }));
}

export function nativeLabel(c: NativeCandidate): string {
  return `native/${c.gateway}/${c.id}`;
}

/**
 * `roleModels` maps a role to the refs that role should generate agents for.
 * A model used by several roles is still defined once in [models].
 *
 * `nativeRoleModels`, when given, does the same for `[native.models]`,
 * `[native.gateways]` and `[generate.native]`. Nothing native is written when
 * it is absent or empty — native stays opt-in the way it was chosen.
 */
export function tomlFor(
  roleModels: Record<string, ModelRef[]>,
  carried: Record<string, ConfigEntry>,
  nativeRoleModels?: Record<string, NativeCandidate[]>,
): string {
  const defined = new Map<string, ConfigEntry>();
  for (const refs of Object.values(roleModels)) {
    for (const r of refs) defined.set(configKeyFor(r), { harness: r.harness, id: r.ref });
  }
  for (const [k, e] of Object.entries(carried)) defined.set(k, e);

  const clashes = duplicateKeys([...defined.keys()]);
  if (clashes.length > 0) {
    throw new Error(
      `sonata: ${clashes.join(', ')} would name two different models. ` +
      'Rename the hand-written entry, or enable only one of the colliding refs.',
    );
  }

  const lines: string[] = [];
  for (const [key, entry] of defined) {
    lines.push(
      `[models.${tomlKey(key)}]`,
      `harness = ${tomlKey(entry.harness)}`,
      `id = ${tomlKey(entry.id)}`,
      '',
    );
  }

  lines.push('[generate.roles]');
  for (const [role, refs] of Object.entries(roleModels)) {
    lines.push(`${tomlKey(role)} = [${refs.map((r) => tomlKey(configKeyFor(r))).join(', ')}]`);
  }
  lines.push('');

  const nativeModels = new Map<string, NativeCandidate>();
  for (const cands of Object.values(nativeRoleModels ?? {})) {
    for (const c of cands) nativeModels.set(c.key, c);
  }

  if (nativeModels.size > 0) {
    const nativeClashes = duplicateKeys([...nativeModels.keys()]);
    if (nativeClashes.length > 0) {
      throw new Error(
        `sonata: native model(s) ${nativeClashes.join(', ')} would name two different models.`,
      );
    }

    const gateways = new Map<string, string>();
    for (const c of nativeModels.values()) gateways.set(c.gateway, c.baseUrl);

    for (const [gateway, baseUrl] of gateways) {
      lines.push(`[native.gateways.${tomlKey(gateway)}]`, `base_url = ${tomlKey(baseUrl)}`, '');
    }

    for (const [key, c] of nativeModels) {
      lines.push(
        `[native.models.${tomlKey(key)}]`,
        `gateway = ${tomlKey(c.gateway)}`,
        `id = ${tomlKey(c.id)}`,
        `context_window = ${c.contextWindow}`,
        '',
      );
    }

    lines.push('[generate.native]');
    for (const [role, cands] of Object.entries(nativeRoleModels ?? {})) {
      lines.push(`${tomlKey(role)} = [${cands.map((c) => tomlKey(c.key)).join(', ')}]`);
    }
    lines.push('');
  }

  lines.push(
    '[run]',
    'tail_window_seconds = 20',
    'stall_timeout_seconds = 120',
    'run_timeout_seconds = 1800',
    '',
  );
  return lines.join('\n');
}

/**
 * Refs already enabled, for pre-ticking.
 *
 * Matching is on `(harness, id)` rather than on the config key: a key is a
 * name the user or an older sonata chose, while the ref states what was
 * actually meant. This is what lets a hand-written pi entry pre-tick despite
 * a key the wizard would never generate.
 *
 * An unparseable config pre-ticks nothing rather than throwing — `init` must
 * be able to repair a broken file, which is half its purpose.
 */
export function preTickedRefs(configText: string, refs: ModelRef[]): Set<string> {
  let models: Record<string, { harness: string; id: string }>;
  try {
    models = parseConfig(configText).models;
  } catch {
    return new Set();
  }

  const enabled = new Set<string>();
  for (const entry of Object.values(models)) {
    for (const ref of refs) {
      // Keyed by config key, not by `ref`. Two harnesses can serve the
      // identical provider/model, so a set keyed on `ref` pre-ticked both
      // when only one was configured.
      if (ref.harness === entry.harness && ref.ref === entry.id) enabled.add(configKeyFor(ref));
    }
  }
  return enabled;
}

/**
 * The config key is also the agent filename (`code-<key>.md`), so it cannot
 * contain `/`. The harness segment is load-bearing rather than decorative: pi
 * and opencode can serve the identical ref, and without it those two
 * selections would overwrite each other.
 */
/**
 * What a model is called on screen: `<harness>/<provider>/<model>`.
 *
 * pi and opencode can serve the identical `provider/model`, so labelling rows
 * by `ref` alone printed two identical lines and gave no way to tell which
 * harness a row would dispatch to. Codex has no provider dimension, so its
 * rows read `codex/gpt-5.6-sol`.
 */
/**
 * The nearest earlier screen the user could actually return to.
 *
 * A step answered by a flag (`--providers`, `--roles`) is never shown, so Left
 * must skip past it rather than appearing to do nothing. Returning `from`
 * itself means there is no earlier screen, and Left is inert.
 */
export function previousAskedStep(asked: boolean[], from: number): number {
  for (let k = from - 1; k >= 0; k--) if (asked[k]) return k;
  return from;
}

export function refLabel(ref: ModelRef): string {
  return `${ref.harness}/${ref.ref}`;
}

export function configKeyFor(ref: ModelRef): string {
  return `${ref.harness}-${ref.ref}`.replace(/\//g, '-');
}

/**
 * Keys claimed more than once.
 *
 * Flattening is not injective, because provider names contain dashes too:
 * `opencode/go-x` and `opencode-go/x` both yield `opencode-go-x`. No pair in
 * the current catalogue collides, but it is served rather than static, so it
 * cannot be assumed away.
 */
export function duplicateKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) dupes.add(k);
    seen.add(k);
  }
  return [...dupes].sort();
}

export async function cmdInit(opts: InitOptions): Promise<InitResult> {
  const out = opts.write ?? ((l: string) => console.log(l));
  const interactive = !opts.yes && isInteractive();

  out('');
  // Decoration is for a person watching. Under --yes the output is being
  // scripted or logged, so it stays plain.
  out(interactive ? banner() : '  sonata init');
  out('');

  // ---- detect -----------------------------------------------------------
  const detect = opts.detect ?? defaultDetector;
  const { tmux, harnesses } = await detect({ home: opts.home, supportedVersions: OPENCODE_RANGE });
  const problems: Problem[] = [...tmux.problems, ...harnesses.flatMap((h) => h.problems)];

  out(tmux.installed ? `  ✓ tmux ${tmux.version}` : '  ✗ tmux not found');
  for (const h of harnesses) {
    out(h.installed
      ? `  ✓ ${h.name} ${h.version} · ${h.refs.length} models`
      : `  · ${h.name} not installed`);
  }
  out('');

  const allRefs = harnesses.flatMap((h) => h.refs);
  const authed = harnesses.flatMap((h) => h.authedProviders);
  const offered = offerableProviders(allRefs, authed);

  // Native candidates do not depend on the harness/role screens below — they
  // come straight from detection — so they are computed once, up front.
  const providerBaseUrls = harnesses.find((h) => h.name === 'opencode')?.providerBaseUrls ?? {};
  const nativeCandidates = nativeCandidatesFrom(allRefs, providerBaseUrls);
  const nativeByKey = new Map(nativeCandidates.map((c) => [c.key, c]));

  if (offered.length === 0) {
    problems.push({
      severity: 'error',
      message: 'no harness reported a usable model provider',
      fix: 'opencode auth login',
    });
  }

  const blocking = problems.filter((p) => p.severity === 'error');
  if (blocking.length > 0) {
    for (const p of problems) out(renderProblem(p));
    out('');
    out('  Fix the errors above, then run `sonata init` again.');
    return {
      problems, models: [], roles: [], scope: 'skip', hookChanged: false,
      agentsWritten: [], configPath: join(opts.cwd, 'sonata.toml'),
      mcpChanged: false, pruned: [],
    };
  }
  for (const p of problems) out(renderProblem(p));

  // ---- the question sequence -------------------------------------------
  //
  // Asked as a step machine rather than a straight run of awaits, so Left can
  // go back a screen. Each step re-derives everything that depends on the
  // answers before it: going back to the providers screen and choosing
  // differently must re-ask the model list against the new providers, not
  // against a stale one. A step whose answer came from a flag is skipped, and
  // is never a target to go back to.
  let configScope!: ConfigScope;
  let configPathResolved!: string;
  let configText!: string;
  let enabled!: Set<string>;
  let providerKeys!: string[];
  let inScope!: ModelRef[];
  let keys!: string[];
  let byKey!: Map<string, ModelRef>;
  let chosen!: ModelRef[];
  let roles!: string[];
  let roleModels!: Record<string, ModelRef[]>;
  let nativeKeys!: string[];
  let chosenNative!: NativeCandidate[];
  let nativeRoles!: string[];
  let nativeRoleModels: Record<string, NativeCandidate[]> = {};

  const asked = [
    opts.configScope === undefined && interactive,
    !opts.providers && interactive,
    !opts.models && interactive,
    !opts.roles && interactive,
    interactive,
    !opts.nativeModels && interactive,
    !opts.nativeRoles && interactive,
  ];
  const previousAsked = (from: number): number => previousAskedStep(asked, from);
  const canGoBack = (step: number): boolean => previousAsked(step) !== step;

  for (let step = 0; step < 7;) {
    try {
      switch (step) {
        case 0: {
          if (opts.configScope) {
            configScope = opts.configScope;
          } else if (interactive) {
            out('');
            configScope = await select<ConfigScope>('Where should this config apply', [
              { value: 'project', label: 'This project only', hint: './sonata.toml + ./.claude/agents/' },
              { value: 'global', label: 'All projects', hint: '~/.config/sonata/ + ~/.claude/agents/' },
            ], canGoBack(0));
          } else {
            configScope = 'project';
          }

          // Read the file that is about to be overwritten, not whichever one
          // merely resolves. Choosing `global` in a repo that has its own
          // sonata.toml would otherwise carry that repo's hand-written entries
          // into the machine config and pre-tick from a file the user is not
          // editing — which is why the scope is asked before anything is read.
          configPathResolved = configPathFor(configScope, opts.cwd, opts.home);
          configText = existsSync(configPathResolved)
            ? readFileSync(configPathResolved, 'utf8')
            : '';
          enabled = preTickedRefs(configText, allRefs);
          break;
        }

        case 1: {
          if (opts.providers) {
            providerKeys = opts.providers;
          } else if (interactive) {
            providerKeys = await multiselect(
              'Providers',
              offered.map((p) => ({
                value: p.key,
                label: `${p.harness} · ${p.provider}`,
                hint: `${p.count} models`,
                checked: allRefs.some((r) => `${r.harness}/${r.provider}` === p.key && enabled.has(configKeyFor(r))),
              })),
              canGoBack(1),
            );
          } else {
            providerKeys = offered
              .filter((p) => allRefs.some((r) => `${r.harness}/${r.provider}` === p.key && enabled.has(configKeyFor(r))))
              .map((p) => p.key);
          }

          const unknownProviders = providerKeys.filter((k) => !offered.some((p) => p.key === k));
          if (unknownProviders.length > 0) {
            throw new Error(
              `sonata init: no harness offers ${unknownProviders.join(', ')}. ` +
              `Available: ${offered.map((p) => p.key).join(', ')}`,
            );
          }

          inScope = allRefs.filter((r) => providerKeys.includes(`${r.harness}/${r.provider}`));
          break;
        }

        case 2: {
          if (opts.models) {
            keys = opts.models;
          } else if (interactive) {
            keys = await multiselect(
              'Models to enable',
              inScope.map((r) => ({
                value: configKeyFor(r),
                label: refLabel(r),
                hint: r.name,
                checked: enabled.has(configKeyFor(r)),
              })),
              canGoBack(2),
            );
          } else {
            keys = inScope.filter((r) => enabled.has(configKeyFor(r))).map(configKeyFor);
          }

          byKey = new Map(inScope.map((r) => [configKeyFor(r), r]));
          const unknown = keys.filter((k) => !byKey.has(k));
          if (unknown.length > 0) {
            throw new Error(
              `sonata init: the selected providers do not offer ${unknown.join(', ')}. ` +
              `Available: ${[...byKey.keys()].join(', ')}`,
            );
          }
          if (keys.length === 0) {
            throw new Error('sonata init: no models selected — nothing to generate.');
          }

          chosen = keys.map((k) => byKey.get(k)!);
          break;
        }

        case 3: {
          if (opts.roles) {
            roles = opts.roles;
          } else if (interactive) {
            roles = await multiselect(
              'Roles to generate',
              KNOWN_ROLES.map((r) => ({ value: r as string, label: r, checked: true })),
              canGoBack(3),
            );
          } else {
            roles = [...KNOWN_ROLES];
          }

          const badRoles = roles.filter((r) => !KNOWN_ROLES.includes(r as never));
          if (badRoles.length > 0) {
            throw new Error(`sonata init: unknown role(s) ${badRoles.join(', ')}`);
          }
          if (roles.length === 0) {
            throw new Error('sonata init: no roles selected — nothing to generate.');
          }
          break;
        }

        case 4: {
          // The common case is one keystroke; only a user who wants different
          // models per role pays for the extra screens.
          const sameForAll = !interactive || await confirm(
            `Use the same models for every role?  (${roles.length} roles × ${chosen.length} models = ` +
            `${roles.length * chosen.length} agents)`,
            true,
            canGoBack(4),
          );

          if (sameForAll) {
            roleModels = Object.fromEntries(roles.map((r) => [r, chosen]));
            break;
          }

          // Each role is its own screen, so Left walks back through the roles
          // one at a time and only leaves this step from the first of them.
          const picks: Record<string, ModelRef[]> = {};
          for (let r = 0; r < roles.length;) {
            const role = roles[r];
            try {
              const picked = await multiselect(
                `Models for: ${role}`,
                chosen.map((m) => ({
                  value: configKeyFor(m), label: refLabel(m), hint: m.name, checked: true,
                })),
                true,
              );
              picks[role] = chosen.filter((m) => picked.includes(configKeyFor(m)));
              r++;
            } catch (err) {
              // Back from the first role leaves the step entirely, returning
              // to the same-models question.
              if (err instanceof BackError && r > 0) { r--; continue; }
              throw err;
            }
          }
          roleModels = picks;
          break;
        }

        case 5: {
          // Native is opt-in and skippable: an empty selection here writes no
          // [native] table at all and step 6 has nothing to ask.
          if (opts.nativeModels) {
            nativeKeys = opts.nativeModels;
          } else if (interactive) {
            nativeKeys = await multiselect(
              'Native models (optional — run these as native Claude Code subagents)',
              nativeCandidates.map((c) => ({
                value: c.key, label: nativeLabel(c), hint: `context ${c.contextWindow}`, checked: false,
              })),
              canGoBack(5),
            );
          } else {
            nativeKeys = [];
          }

          const unknownNative = nativeKeys.filter((k) => !nativeByKey.has(k));
          if (unknownNative.length > 0) {
            throw new Error(
              `sonata init: no native gateway offers ${unknownNative.join(', ')}. ` +
              `Available: ${[...nativeByKey.keys()].join(', ')}`,
            );
          }

          chosenNative = nativeKeys.map((k) => nativeByKey.get(k)!);
          break;
        }

        case 6: {
          // Nothing was chosen on the previous screen, so this screen has
          // nothing to ask — mirroring how an unmet dependency is handled
          // elsewhere in this file rather than adding a third step-count.
          if (chosenNative.length === 0) {
            nativeRoles = [];
            break;
          }

          if (opts.nativeRoles) {
            nativeRoles = opts.nativeRoles;
          } else if (interactive) {
            nativeRoles = await multiselect(
              'Roles to generate native agents for',
              KNOWN_ROLES.map((r) => ({ value: r as string, label: r, checked: true })),
              canGoBack(6),
            );
          } else {
            nativeRoles = [...KNOWN_ROLES];
          }

          const badNativeRoles = nativeRoles.filter((r) => !KNOWN_ROLES.includes(r as never));
          if (badNativeRoles.length > 0) {
            throw new Error(`sonata init: unknown role(s) ${badNativeRoles.join(', ')}`);
          }
          break;
        }
      }
      step++;
    } catch (err) {
      if (err instanceof BackError) {
        step = previousAsked(step);
        continue;
      }
      throw err;
    }
  }

  // ---- config scope -----------------------------------------------------

  if (chosenNative.length > 0 && nativeRoles.length > 0) {
    nativeRoleModels = Object.fromEntries(nativeRoles.map((r) => [r, chosenNative]));
  }

  // ---- native key check ---------------------------------------------------
  //
  // Informational only — it does not block init. A gateway with no
  // discovered key still gets written to the config; `sonata serve` is what
  // actually needs the credential, and by then the user has had this warning
  // plus the `sonata auth add` pointer.
  if (chosenNative.length > 0) {
    out('');
    const gateways = [...new Set(chosenNative.map((c) => c.gateway))];
    for (const report of keyReport(gateways, opts.home)) {
      out(report.source
        ? `  ✓ ${report.gateway}: key from ${report.source}`
        : `  ! ${report.gateway}: no key — run \`sonata auth add ${report.gateway}\``);
    }
  }

  // ---- hook scope -------------------------------------------------------
  const command = hookCommand(opts.packageRoot);
  const alreadyGlobal = hookInstalled(readSettings(settingsPath('global', opts.cwd, opts.home)), command);
  const alreadyProject = hookInstalled(readSettings(settingsPath('project', opts.cwd, opts.home)), command);

  let scope: HookScope | 'skip';
  if (opts.scope) {
    scope = opts.scope;
  } else if (alreadyGlobal || alreadyProject) {
    out('');
    out(`  ✓ permission hook already installed (${alreadyGlobal ? 'global' : 'project'})`);
    scope = 'skip';
  } else if (interactive) {
    out('');
    scope = await select<HookScope | 'skip'>('Install the permission hook', [
      { value: 'project', label: 'This project only', hint: 'no effect on your other repos' },
      { value: 'global', label: 'All projects', hint: 'adds ~40ms per Bash call everywhere' },
      { value: 'skip', label: 'Skip', hint: 'sonata assumes default mode' },
    ]);
  } else {
    scope = 'project';
  }

  // ---- confirm ----------------------------------------------------------
  out('');
  out('  Summary');
  out(`    models  ${chosen.map(refLabel).join(', ')}`);
  out(`    roles   ${roles.join(', ')}`);
  out(`    agents  ${Object.values(roleModels).reduce((n, m) => n + m.length, 0)} files in .claude/agents/`);
  if (chosenNative.length > 0) {
    out(`    native  ${chosenNative.map(nativeLabel).join(', ')}`);
    out(`    native roles  ${nativeRoles.join(', ')}`);
  }
  out(`    hook    ${scope === 'skip' ? 'not installed' : `${scope} settings.json`}`);
  out(`    config  ${configPathResolved}`);
  out('');

  if (interactive && !(await confirm('Write these changes?', true))) {
    out('  Nothing written.');
    return {
      problems, models: keys, roles, scope, hookChanged: false,
      agentsWritten: [], configPath: configPathResolved, cancelled: true,
      mcpChanged: false, pruned: [],
    };
  }

  // ---- write ------------------------------------------------------------
  const carried = carriedEntries(configText, ['opencode', 'pi', 'reasonix']);
  const clashes = duplicateKeys([...keys, ...Object.keys(carried)]);
  if (clashes.length > 0) {
    throw new Error(
      `sonata init: ${clashes.join(', ')} would name two different models. ` +
      'Rename the hand-written entry, or enable only one of the colliding refs.',
    );
  }
  mkdirSync(dirname(configPathResolved), { recursive: true });
  writeFileSync(configPathResolved, tomlFor(roleModels, carried, nativeRoleModels));
  out(`  ✓ wrote ${configPathResolved}`);

  let hookChanged = false;
  if (scope !== 'skip') {
    const path = settingsPath(scope, opts.cwd, opts.home);
    const withHook = installHook(readSettings(path), command);
    // Allow-list the three wrapper tools in the same file, in the same pass.
    // Left to `auto` mode's classifier they are judged per call, and a wrapper
    // whose `tail` is denied mid-run leaves a foreign model writing to the
    // repository unobserved.
    const withAllow = allowSonataTools(withHook.settings);
    if (withHook.changed || withAllow.changed) writeSettings(path, withAllow.settings);
    hookChanged = withHook.changed;
    out(withHook.changed ? `  ✓ installed hook in ${path}` : `  · hook already present in ${path}`);
    out(withAllow.changed
      ? `  ✓ allow-listed the sonata tools in ${path}`
      : `  · sonata tools already allow-listed in ${path}`);
  }

  const agentsDir = agentsDirFor(configScope, opts.cwd, opts.home);
  const sync = cmdSync({ cwd: opts.cwd, home: opts.home, agentsDir });
  const agentsWritten = sync.written;
  out(`  ✓ generated ${agentsWritten.length} agents in ${agentsDir}`);

  // Claude Code owns where these live, so it does the writing. A machine-scoped
  // config pairs with the user scope; a project one with ./.mcp.json.
  const mcpScope = configScope === 'global' ? 'user' : 'project';
  const mcp = registerMcp(mcpScope, opts.cwd, opts.packageRoot, opts.mcpRunner);
  if (mcp.changed) {
    out(`  ✓ registered the sonata MCP server (${mcpScope} scope)`);
  } else if (mcp.ok) {
    out('  · MCP server already registered');
  } else {
    // Without it the generated wrappers hold no tools at all and do nothing.
    out('  ! could not register the MCP server — run this by hand:');
    out(`      ${mcp.command}`);
  }

  const stale = sync.stale;
  let pruned: string[] = [];
  if (stale.length > 0) {
    out('');
    out(`  ! ${stale.length} stale agent file(s) no longer in your config:`);
    for (const f of stale.slice(0, 5)) out(`      ${f}`);
    if (stale.length > 5) out(`      … and ${stale.length - 5} more`);
    const remove = opts.prune ?? (interactive && await confirm('Delete them?', true));
    if (remove) {
      pruned = pruneAgents(agentsDir, stale);
      out(`  ✓ removed ${pruned.length} stale agent file(s)`);
    } else {
      out('      ❯ delete them by hand, or re-run with --prune');
    }
  }

  out('');
  out('  Done. Restart Claude Code so it picks up the agents and the MCP server.');
  out('');

  return {
    problems, models: keys, roles, scope, hookChanged, agentsWritten,
    configPath: configPathResolved, mcpChanged: mcp.changed, pruned,
  };
}

export function isCancellation(err: unknown): boolean {
  return err instanceof CancelledError;
}
