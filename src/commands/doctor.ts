import { extendedContextAdvice } from '../extended-context.js';
import { splitCandidate } from '../effort.js';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  loadConfig,
  configPath,
  GLOBAL_CONFIG_RELATIVE,
  expectedAgentNames,
  isOauthGatewayAuth,
} from '../config.js';
import type { NativeGatewayAuth } from '../config.js';
import { outdatedAgents, plannedAgents } from './sync.js';
import { staleAgents, disabledOpencodeAgents, enableOpencodeAgent,
} from '../detect.js';
import { getAdapter } from '../adapters/index.js';
import { tmuxVersion } from '../tmux.js';
import {
  modeHookPresent,
  readSettings,
  settingsPath,
  missingAllowEntries,
} from '../settings.js';
import type { Settings } from '../settings.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findLitellm } from '../native/litellm.js';
import { litellmRequired } from '../native/providers.js';
import { litellmStatus, type InstallerDeps } from '../native/litellm-venv.js';
import { defaultInstallerDeps, describeStatus, statusIsHealthy } from './litellm.js';
import { AA_CATALOG_MAX_AGE_DAYS, aaCatalogAgeDays, catalogCoverage, hasTaskCost, loadAaCatalog, proposeTiers } from '../catalog.js';
import { loadModelsDev } from '../modelsdev.js';
import { configUpstreamFor, proposePricingProvider } from '../pricing.js';
import { CURRENT_SCHEMA_VERSION } from '../migrations.js';
import { mainWorktreeDir } from '../git-worktree.js';
import { keyReport, resolveKeyFromSource } from '../native/credentials.js';

/**
 * How long `doctor` waits for LiteLLM's liveliness endpoint before calling it
 * down. Short on purpose: a healthy local answer is immediate, and the point
 * of the check is to notice a LiteLLM that is not serving — including one
 * accepting connections without answering.
 */
const LITELLM_HEALTH_TIMEOUT_MS = 3000;
import { codexAuthReport, readChatGptOAuth } from '../native/codex-auth.js';
import { copilotAuthReport, copilotTokenCanExchange, readCopilotToken } from '../native/copilot-auth.js';
import { credentialDir, credentialFileFor } from '../native/oauth-login.js';
import { serveHealthUrl, healthReportsUi } from './serve.js';
import { routerPorts } from './ports.js';
import { nativeSessionEnv } from './code.js';
import { routeEnv, routeSettingsFile, autoInstalled, readSessions, routeSessionsFile, diagnoseRouteAuto, isLocalhostUrl } from './route.js';

const run = promisify(execFile);

async function hasCredentialFrom(source: 'codex' | 'opencode', auth: NativeGatewayAuth, home: string): Promise<boolean> {
  if (auth === 'copilot-oauth') {
    // A stored GitHub token is not the same as a usable one — see the
    // matching check on the legacy (unsourced) copilot-oauth path below.
    const token = readCopilotToken(home);
    return token !== null && await copilotTokenCanExchange(token);
  }
  return readChatGptOAuth(home, source) !== null;
}

function triple(v: string): [number, number, number] {
  const m = v.replace(/^v/, '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Supports ranges of the form ">=X.Y.Z <A.B.C". */
/**
 * Versions of the `claude` binary known to be broken, and why.
 *
 * A blocklist rather than a `supportedVersions` bound, because the shape of
 * the fact is "this one build is broken", not "everything below X". A range
 * cannot say it: `<2.1.275` would reject 2.1.276, which carries the fix.
 * Naming the reason is the point — the range check can only report "outside
 * tested range", which tells a reader nothing about what will happen.
 *
 * 2.1.275 answered **every** request with a 400 naming
 * `Input tag 'advisor_20260301'` whenever `ANTHROPIC_BASE_URL` pointed at a
 * proxy or gateway. Sonata's entire native path works by pointing that
 * variable at its own router, so on that build every routed request dies, and
 * the 400 names neither the cause nor the fix — the same failure shape as the
 * Codex `System messages are not allowed` and Azure `is not a 'regex'` 400s
 * documented in CLAUDE.md, each of which read as a sonata or model fault.
 */
const CLAUDE_KNOWN_BAD: Record<string, string> = {
  '2.1.275': "every request through a proxy fails with 400 `Input tag 'advisor_20260301'`"
    + ' — sonata routes through its own proxy, so nothing works. Upgrade to 2.1.276',
};

/**
 * Why this `claude` version is unusable with sonata, or `undefined`.
 *
 * The argument may carry the noise `claude --version` prints
 * ("2.1.276 (Claude Code)"), so the triple is matched rather than compared.
 */
export function knownBadVersion(version: string): string | undefined {
  const triple = /^\s*(\d+\.\d+\.\d+)/.exec(version)?.[1];
  return triple === undefined ? undefined : CLAUDE_KNOWN_BAD[triple];
}

/**
 * Whether `actual` satisfies a range of ANDed `>=` and `<` bounds.
 *
 * Deliberately tiny — sonata compares harness versions and nothing more, so a
 * semver dependency would be a supply-chain surface bought for one comparison.
 *
 * It has no alternation, which is why a *known-bad* build cannot be expressed
 * here: excluding one version needs `>=a <bad || >bad <c`, and there is no
 * `||`. `CLAUDE_KNOWN_BAD` carries those instead, and can say why.
 */
export function checkVersion(actual: string, range: string): boolean {
  const a = triple(actual);
  for (const part of range.trim().split(/\s+/)) {
    const m = part.match(/^(>=|<)(.+)$/);
    if (!m) continue;
    const bound = triple(m[2]);
    if (m[1] === '>=' && cmp(a, bound) < 0) return false;
    if (m[1] === '<' && cmp(a, bound) >= 0) return false;
  }
  return true;
}

export interface Check { name: string; ok: boolean; detail: string }

/**
 * Saved `simple` candidates the current proposal would cap out of that tier.
 *
 * `simple` is `normal` filtered by a cost ceiling anchored on the config's own
 * best-value model, so a candidate the proposal still ranks in `normal` but no
 * longer puts in `simple` is one the ceiling now excludes. Asking the proposal
 * rather than recomputing the ceiling is deliberate: two implementations of
 * that arithmetic would eventually disagree, and the one in `proposeTiers` is
 * the one that decides what gets written.
 *
 * Why this needs reporting at all: a saved tier list is sticky, so a `simple`
 * written before the catalog changed can never be re-ranked. Measured
 * 2026-09-18 on a real config, `simple` led with a candidate 4.5x dearer per
 * task than `normal`'s leader and reached one 34x dearer by rank 4 — the tier
 * split inverted, with the cheap tier the expensive one. Nothing surfaced it,
 * because a wrong ranking produces no error; it just quietly costs more.
 *
 * Membership only, never order: which candidates a tier holds is the cap's
 * business, while the order among them is the user's to tune by hand. A key
 * the proposal does not rank at all — hand-added, or unscored by the catalog —
 * is ignored, since reporting it would assert a cost nothing knows.
 */
export function overCeilingSimple(
  savedSimple: readonly string[],
  proposed: { simple: readonly string[]; normal: readonly string[] },
): string[] {
  return savedSimple.filter((key) => !proposed.simple.includes(key) && proposed.normal.includes(key));
}

export function staleMcpRegistration(cwd: string, home: string): string | undefined {
  for (const path of [join(cwd, '.mcp.json'), join(home, '.claude.json')]) {
    if (!existsSync(path)) continue;
    try {
      const doc = JSON.parse(readFileSync(path, 'utf8')) as {
        mcpServers?: Record<string, unknown>;
      };
      if (doc.mcpServers !== null && typeof doc.mcpServers === 'object'
        && Object.hasOwn(doc.mcpServers, 'sonata')) {
        return `${path} still registers the removed sonata server — run \`claude mcp remove sonata\``;
      }
    } catch {
      // A malformed user file is not evidence of a stale registration.
    }
  }
  return undefined;
}

/**
 * Why this project's sessions are not routed, in the user's terms.
 *
 * Five distinct states used to print one sentence — "tier agents need a routed
 * session — run `sonata route auto`". That is the correct instruction for the
 * first one only. For the rest the command is still what repairs them, but
 * saying nothing else leaves a user who has *just run it* with no next step:
 * the hooks are installed, `route auto` reports success, and doctor keeps
 * failing. Each branch below names the state the command is about to fix.
 *
 * Exported so the message is testable without standing up a doctor run.
 */
/**
 * The main checkout `cwd` is borrowing a `sonata.toml` from, or undefined when
 * it is not a worktree, has its own config, or the borrow found nothing.
 *
 * Only the *borrowed* case is worth reporting: a worktree carrying its own
 * `sonata.toml` is configured like any other project, and one falling through
 * to the machine config is in the case doctor already describes.
 */
export function borrowedWorktreeConfigDir(cwd: string, home: string): string | undefined {
  if (existsSync(join(cwd, 'sonata.toml'))) return undefined;
  const main = mainWorktreeDir(cwd);
  if (main === null) return undefined;
  return configPath(cwd, home) === join(main, 'sonata.toml') ? main : undefined;
}

export function routingFailureDetail(input: {
  cwd: string;
  packageRoot?: string;
  projectSettings: Settings;
  globalSettings: Settings;
  configuredRouterUrl?: string;
  projectResolvesToMachineConfig: boolean;
  /**
   * Set when `cwd` is a linked git worktree borrowing this main checkout's
   * `sonata.toml`. Routing settings and hooks are untracked, so they are the
   * one thing a worktree cannot borrow — Claude Code reads them relative to
   * its own cwd — and `route auto` in the main checkout does not reach here.
   */
  borrowedFrom?: string;
}): string {
  const need = 'tier agents need a routed session';
  const fix = 'run `sonata route auto`';

  const current = routeEnv(input.projectSettings).ANTHROPIC_BASE_URL;

  // Sonata owns only `http://localhost:<port>`; `route on` refuses to clobber
  // anything else and `route off` refuses to remove it. So a corporate proxy
  // here is not a sonata misconfiguration, and `route auto` is not the repair
  // — it calls `planRouteOff`, which throws on exactly this URL. Recommending
  // it would hand the user a command that fails.
  if (current !== undefined && !isLocalhostUrl(current)) {
    return `${need} — ANTHROPIC_BASE_URL is set to ${current}, which sonata did not write; ` +
      'remove or update it yourself if sonata should route this project';
  }

  // A base URL sonata does own, but naming a port this config no longer uses.
  // It reads as routed to anything checking presence, and 502s on every native
  // request — so it has to be told apart from having no routing at all.
  if (current !== undefined && input.configuredRouterUrl !== undefined && current !== input.configuredRouterUrl) {
    return `${need} — settings route to ${current}, but this config's router is ${input.configuredRouterUrl}; ${fix}`;
  }

  // Checked before every hook diagnosis below, because in a fresh worktree all
  // of them say the same thing — nothing is installed — and none of them says
  // *why*, which is the only part the user cannot work out from the directory
  // they are standing in.
  if (input.borrowedFrom !== undefined) {
    return `${need} — this is a git worktree of ${input.borrowedFrom}, whose config it borrows, but ` +
      `routing settings and hooks are untracked and live per checkout; ${fix} here, in the worktree`;
  }

  if (input.packageRoot === undefined) return `${need} — ${fix}`;
  const project = diagnoseRouteAuto(input.projectSettings, input.packageRoot, 'project');
  const global = diagnoseRouteAuto(input.globalSettings, input.packageRoot, 'global');

  // Routing is installed globally and healthy — it just cannot serve *this*
  // project, because a project with its own sonata.toml resolves a different
  // configuration than the machine one a global hook would load.
  if (global.kind === 'installed' && !input.projectResolvesToMachineConfig) {
    return `${need} — routing is installed globally, but this project has its own sonata.toml, ` +
      `so a global hook would resolve a different config; ${fix} here, without \`--global\``;
  }

  // Checked before `partial`: a foreign install is also missing every command
  // this one expects, so reporting it as incomplete would be true and useless.
  for (const diagnosis of [project, global]) {
    if (diagnosis.kind === 'other-install') {
      return `${need} — the installed hooks run a different sonata (${diagnosis.roots.join(', ')}), ` +
        `not the one you are running (${input.packageRoot}); ${fix} to repoint them`;
    }
  }

  for (const diagnosis of [project, global]) {
    if (diagnosis.kind === 'partial') {
      const subagent = diagnosis.missing.some((event) => event.startsWith('Subagent'));
      return `${need} — the install is missing ${diagnosis.missing.join(' and ')}` +
        `${subagent ? ', which are the hooks that actually route' : ''}; ${fix}`;
    }
  }

  return `${need} — ${fix}`;
}


/** The running Claude Code version, or `undefined` when there is no `claude`. */
async function defaultClaudeVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await run('claude', ['--version'], { env: { ...process.env } });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function cmdDoctor(
  opts: {
    cwd: string; home?: string; packageRoot?: string; now?: () => Date;
    /** Test seam: what to probe the machine with for the litellm check. */
    installerDeps?: InstallerDeps;
    /**
     * Test seam: the running Claude Code version, for the known-bad check.
     *
     * Injectable because the default spawns `claude --version`, which costs
     * ~0.7s — paid on every `sonata doctor`, and 36 times over in this
     * command's own tests, where it added ~3s for a value none of them are
     * about. A test that does not care passes `() => undefined` and spawns
     * nothing.
     */
    claudeVersion?: () => Promise<string | undefined>;
  },
): Promise<{ ok: boolean; checks: Check[] }> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? (() => new Date());
  const checks: Check[] = [];

  try {
    checks.push({ name: 'tmux', ok: true, detail: await tmuxVersion() });
  } catch {
    checks.push({ name: 'tmux', ok: false, detail: 'not installed — `brew install tmux`' });
  }

  let config;
  const resolved = configPath(opts.cwd, home);
  try {
    config = loadConfig(opts.cwd, home);
    checks.push({
      name: 'sonata.toml',
      ok: true,
      detail: `${resolved} · ${Object.keys(config.models).length} harness + ${Object.keys(config.native?.models ?? {}).length} native models`,
    });
    if (config.tiers === undefined && (Object.keys(config.generate.roles).length > 0 || Object.keys(config.native?.generate ?? {}).length > 0)) {
      checks.push({
        name: 'legacy config',
        ok: true,
        detail: 'config predates [tiers] — run `sonata init` to migrate',
      });
    }
    // Advisory, never blocking: migration runs in memory on every load, so a
    // file behind the current schema already works. What it does not have is
    // the stamp — and `sonata init` is the only command that writes the config
    // file; `sonata sync` regenerates agents and never touches sonata.toml.
    if ((config.schemaVersion ?? 0) < CURRENT_SCHEMA_VERSION) {
      checks.push({
        name: 'config schema',
        ok: true,
        detail: `config is schema v${config.schemaVersion ?? 0}, current is v${CURRENT_SCHEMA_VERSION} — ` +
          'it loads as-is; run `sonata init` to rewrite it stamped',
      });
    }
    if (config.tiers !== undefined && Object.values(config.tiers).every((lists) => lists.normal === undefined)) {
      checks.push({
        name: 'normal tier',
        ok: true,
        detail: 'no normal tier configured — it is optional; run `sonata init` to add it',
      });
    }
  } catch (err) {
    checks.push({ name: 'sonata.toml', ok: false, detail: (err as Error).message });
    return { ok: false, checks };
  }

  // Tier agents call the native router first. Report a blocking warning when
  // neither persistent routing nor route-auto hooks are configured.
  if (config.tiers !== undefined) {
    // Rankings only matter where tiers do. Advisory, not blocking: a stale or
    // missing catalog still produces tiers, just from superseded scores or the
    // built-in table — the failure is silently-wrong ordering, which is
    // exactly the kind that goes unnoticed without being named here.
    const catalog = loadAaCatalog(home);
    if (catalog === undefined) {
      checks.push({
        name: 'model rankings',
        ok: true,
        detail: 'no catalog — tiers ranked from built-in defaults, and effort levels cannot be checked; run `sonata catalog update`',
      });
    } else {
      const age = aaCatalogAgeDays(catalog.fetchedAt, now());
      const count = Object.keys(catalog.models).length;
      // Coverage is checked before age because it is the direct measure of the
      // thing age approximates. A catalog well inside the age limit still
      // misses a model released since it was fetched, and that model then
      // ranks from the capable-not-cheap default — a silently wrong ordering,
      // which is the failure this check exists to name. Reporting "312 models
      // · fetched <recent date>" beside a tier ranked on a guess is the
      // reassuring half of the truth.
      const tiered = [...new Set(Object.values(config.tiers)
        .flatMap((byTier) => [...byTier.simple, ...(byTier.normal ?? []), ...byTier.complex]))];
      // Score the *upstream* id, not the config key. A `[models]` key is
      // whatever the user named it — `flash` is a perfectly ordinary key for
      // `deepseek-v4-flash-0731` — and AA files scores under the model's own
      // name, so looking up the key would report every hand-named model as
      // unscored while ranking it perfectly well. `proposeTiers` never hits
      // this because it runs over init's candidate keys, which embed the id.
      // Both maps, because a unified `[models]` entry is projected into
      // `native.models` when it carries a gateway and into `models` when it
      // carries a harness — and a key routed only one of those ways is absent
      // from the other map entirely.
      const upstream = (key: string): string =>
        config.native?.models?.[key]?.id ?? config.models?.[key]?.id ?? key;
      // Gateway names are what `normalizeModelName` strips to recover the
      // upstream id, so passing them is what makes a key like
      // `<gateway>-<model>` resolvable at all. The resolver is the one
      // `loadConfig` scores by, so a vendor's versionless alias that scores
      // there through its models.dev name is not reported unscored here.
      const gateways = Object.keys(config.native?.gateways ?? {});
      // Coverage is by bare key: a pinned level on a model the catalog does
      // not score by level is a choice, not a model the catalog lacks.
      const resolver = configUpstreamFor(config, loadModelsDev(home));
      const bareKeys = [...new Set(tiered.map((candidate) => splitCandidate(candidate).key))];
      const { unscored: unscoredKeys } = catalogCoverage(bareKeys, catalog, gateways, resolver);
      const unscored = unscoredKeys.map(upstream);
      const uncosted = bareKeys
        .filter((key) => !unscoredKeys.includes(key) && !hasTaskCost(key, catalog, gateways, resolver))
        .map(upstream);
      checks.push(uncosted.length > 0
        ? {
            name: 'model rankings',
            ok: true,
            detail: `${uncosted.length} of ${bareKeys.length} configured models have no AA cost-per-task `
              + `(${uncosted.slice(0, 3).join(', ')}${uncosted.length > 3 ? ', …' : ''}) — `
              + 'not offered by `sonata init`; add by hand to sonata.toml if intentional',
          }
        : unscored.length > 0
        ? {
            name: 'model rankings',
            ok: true,
            detail: `${unscored.length} of ${bareKeys.length} tiered models unscored `
              + `(${unscored.slice(0, 3).join(', ')}${unscored.length > 3 ? ', …' : ''}) — `
              + 'ranked from built-in defaults; run `sonata catalog update`',
          }
        : age !== undefined && age > AA_CATALOG_MAX_AGE_DAYS
        ? {
            name: 'model rankings',
            ok: true,
            detail: `catalog is ${age}d old (${catalog.fetchedAt}) — run \`sonata catalog update\``,
          }
        : {
            name: 'model rankings',
            ok: true,
            detail: `${count} models · all ${bareKeys.length} tiered models scored · fetched ${catalog.fetchedAt}`,
          });

      // A saved tier list is sticky — `reconcileTierList` merges only newly
      // selected models into it — so a `simple` written before the catalog
      // changed can never be re-ranked, and nothing else would ever say so.
      // Advisory rather than a failure: the config routes fine, it just routes
      // the cheap tier to dear models, which is a wrong ordering rather than
      // an error. That is exactly the failure mode the freshness check above
      // exists for, and it is invisible for the same reason.
      {
        const stale = Object.entries(config.tiers ?? {})
          .map(([role, lists]) => {
            const proposal = proposeTiers(
              [...new Set(Object.keys(config.unifiedModels ?? {}))],
              catalog, gateways, new Set(config.avoidGateways ?? []), resolver,
            );
            return [role, overCeilingSimple(lists.simple, proposal)] as const;
          })
          .filter(([, over]) => over.length > 0);
        if (stale.length > 0) {
          // Roles usually share one ranking, so naming each separately
          // repeats the same list four times in a line meant to be read.
          const sets = new Map<string, string[]>();
          for (const [role, over] of stale) {
            const key = over.join(',');
            sets.set(key, [...(sets.get(key) ?? []), role]);
          }
          const named = [...sets].map(([over, roles]) => {
            const list = over.split(',');
            return `${roles.join(', ')}: ${list.slice(0, 2).join(', ')}${list.length > 2 ? ', …' : ''}`;
          });
          checks.push({
            name: 'tier freshness',
            ok: true,
            detail: `simple holds candidates the cost cap would now exclude — ${named.join('; ')}. `
              + 'The saved ranking predates the current catalog and is never re-proposed; '
              + 're-rank with `sonata init --repropose-tiers`',
          });
        }
      }
      // A catalog written before effort levels existed has no `family` on any
      // row, so the refusal cannot fire and nothing here could show it: a
      // config with an unpinned candidate loads for months and then stops
      // loading the day someone runs `sonata catalog update`. Silent both ways
      // — which is why this is said outright rather than left to be inferred
      // from a healthy-looking rankings line.
      if (Object.values(catalog.models).every((entry) => entry.family === undefined)) {
        checks.push({
          name: 'effort levels',
          ok: true,
          detail: 'catalog has no effort levels — run `sonata catalog update` to enable the check',
        });
      }
    }

    const projectSettings = readSettings(routeSettingsFile(opts.cwd, 'project', home));
    const globalSettings = readSettings(routeSettingsFile(opts.cwd, 'global', home));
    // Global routing resolves the *machine* config (bd72ec4/dd9ee9b), not
    // necessarily `config` above — that's project-first with the machine
    // config only as a fallback, so a project with its own sonata.toml whose
    // [native.ports].router differs from the machine's would otherwise be
    // checked against the wrong port for the global case.
    let globalConfig = config;
    try {
      const globalPath = configPath(home, home);
      // Load the machine config directly by its own resolved path, not by
      // treating `home` as a project cwd — `configPath(home, home)` can
      // still resolve to a stray `~/sonata.toml` rather than
      // `~/.config/sonata/sonata.toml` if one happens to exist, and that
      // is not the file the global router actually runs.
      if (globalPath === join(home, GLOBAL_CONFIG_RELATIVE)) {
        globalConfig = loadConfig(home, home);
      }
    } catch { /* no machine config; fall through below finds nothing routed */ }

    // Presence alone isn't enough: a base URL left over from a since-changed
    // [native.ports].router points a session at a port nothing is listening
    // on, which reads as routed here and 502s on every native request.
    const routedAt = (settings: typeof projectSettings, cfg: typeof config, scope: 'project' | 'global'): boolean => {
      const routerUrl = cfg.native !== undefined ? `http://localhost:${routerPorts(home).router}` : undefined;
      return (routerUrl !== undefined && routeEnv(settings).ANTHROPIC_BASE_URL === routerUrl) ||
        (opts.packageRoot !== undefined && autoInstalled(settings, opts.packageRoot, scope));
    };
    // Global routing only actually serves this project if the project's own
    // config resolution already IS the machine config (no project-scoped
    // sonata.toml exists) — otherwise a project with its own config needs
    // project-scoped routing specifically; global routing there silently
    // resolves a different, unrelated configuration.
    const projectResolvesToMachineConfig = configPath(opts.cwd, home) === join(home, GLOBAL_CONFIG_RELATIVE);
    const routed = routedAt(projectSettings, config, 'project') ||
      (projectResolvesToMachineConfig && routedAt(globalSettings, globalConfig, 'global'));
    if (!routed) {
      checks.push({
        name: 'tier routing',
        ok: false,
        detail: routingFailureDetail({
          cwd: opts.cwd,
          packageRoot: opts.packageRoot,
          projectSettings,
          globalSettings,
          configuredRouterUrl: config.native !== undefined
            ? `http://localhost:${routerPorts(home).router}`
            : undefined,
          projectResolvesToMachineConfig,
          borrowedFrom: borrowedWorktreeConfigDir(opts.cwd, home),
        }),
      });
    } else {
      // Routing is working — and it quietly costs the *main* session its
      // window. Advisory, not blocking: the session runs fine at 200K, it is
      // simply 80% smaller than the model can do, with nothing on screen to
      // say sonata caused it. Sonata does not apply the fix: on Pro, Opus at
      // 1M draws usage credits, and behind a gateway Claude Code skips the
      // credit check and lets the upstream decide.
      const advice = extendedContextAdvice({
        routed: true,
        // Deliberately unvalidated here: `extendedContextAdvice` owns the
        // check, so every caller gets it rather than only this one.
        model: projectSettings.model ?? globalSettings.model,
      });
      if (advice !== undefined) checks.push({ name: 'extended context', ok: true, detail: advice });
    }
  }

  // A gateway with no `pricing_provider` reports every request unpriced:
  // `resolvePrice` returns `source: 'none'` at its `provider === undefined`
  // guard, before models.dev is consulted at all. Two consequences that are
  // not visible from the outside, which is why this is said outright rather
  // than left to be noticed — `[budget] daily_usd` bounds priced spend, so it
  // caps $0 forever and its only symptom is a refusal that never comes; and an
  // OAuth gateway never reaches `relabelCovered`, so subscription work reads
  // `unpriced` instead of `covered`.
  //
  // `ok: true` because an unpriced gateway routes perfectly well. This costs
  // observability and a budget cap, not the ability to run.
  const gatewayEntries = Object.entries(config.native?.gateways ?? {});
  // `pricing_provider` is the THIRD thing `resolvePrice` consults, not the
  // first: a model `[price]`, then a gateway `[price]`, then the provider. So
  // a gateway priced by hand needs no provider at all, and reporting it as
  // pricing nothing would be a false statement about the user's own config —
  // worse than saying nothing, since the message goes on to claim the budget
  // does not bound it.
  //
  // A legacy `[native.models]` entry carries no `price` of its own, so it is
  // always "not hand-priced" — which is the honest answer, not an oversight.
  const handPricedOn = (gateway: string): boolean[] => [
    ...Object.values(config.unifiedModels)
      .filter((model) => model.gateway === gateway)
      .map((model) => model.price !== undefined),
    ...Object.values(config.native?.models ?? {})
      .filter((model) => model.gateway === gateway)
      .map(() => false),
  ];
  const unpricedGateways = gatewayEntries.filter(([name, gw]) => {
    if (gw.pricingProvider !== undefined && gw.pricingProvider.length > 0) return false;
    if (gw.price !== undefined) return false;
    const priced = handPricedOn(name);
    // A gateway serving nothing cannot generate spend, so naming it is noise.
    // Otherwise it is unpriced only if some model on it is not hand-priced.
    return priced.length > 0 && priced.some((isPriced) => !isPriced);
  });
  if (unpricedGateways.length > 0) {
    const named = unpricedGateways.slice(0, 3).map(([name, gw]) => {
      const proposal = proposePricingProvider(name, gw.auth);
      // Naming the exact line is the point: a user told only that a gateway is
      // unpriced has to go and find what the key is called and what it takes.
      return proposal === undefined ? name : `${name} (pricing_provider = ["${proposal[0]}"])`;
    });
    checks.push({
      name: 'gateway pricing',
      ok: true,
      detail: `${unpricedGateways.length} of ${gatewayEntries.length} gateway(s) price nothing — `
        + `${named.join(', ')}${unpricedGateways.length > 3 ? ', …' : ''}`
        + '; `sonata usage` reports their volume unpriced and `[budget] daily_usd` does not bound it',
    });
  }

  // An id naming no models.dev provider is the silent half of the setting
  // above: the gateway *looks* configured, every model on it still resolves
  // to `source: 'none'`, and the unpriced warning has already been silenced
  // by the key's presence. Measured on a real config — `"tencent"` is not a
  // models.dev id (it files `tencent-tokenhub`), so that gateway's Tencent
  // models were unpriced despite being asked for.
  //
  // Checked here rather than in `parseConfig`, for the same reason effort
  // pinning is: the parser is pure text-in/config-out and has no cache to
  // compare against. With no cache there is nothing to check, and a guess
  // would be worse than silence — so the check is skipped, not failed.
  const modelsDevForProviders = loadModelsDev(home);
  if (modelsDevForProviders !== undefined) {
    const known = new Set(Object.keys(modelsDevForProviders.providers));
    const unmatched = gatewayEntries.flatMap(([name, gw]) => {
      const missing = (gw.pricingProvider ?? []).filter((provider) => !known.has(provider));
      return missing.length === 0 ? [] : [`${name}: ${missing.map((m) => `"${m}"`).join(', ')}`];
    });
    if (unmatched.length > 0) {
      checks.push({
        name: 'pricing providers',
        ok: true,
        detail: `${unmatched.join('; ')} — named in pricing_provider but not published by models.dev, `
          + 'so they price nothing; check the spelling or run `sonata catalog update`',
      });
    }
  }

  // `sonata init` run in $HOME used to write here, and nothing reads it. It
  // looks exactly like configuration, which is worse than not existing.
  const stray = join(home, 'sonata.toml');
  if (existsSync(stray) && resolved !== stray) {
    checks.push({
      name: 'stray config',
      ok: false,
      detail: `${stray} is not read by sonata — mv it to ${join(home, GLOBAL_CONFIG_RELATIVE)}`,
    });
  }

  // One router per machine, on the machine config's ports. A project
  // [native.ports] parses (an existing file keeps loading) but does nothing,
  // and a table that does nothing while looking load-bearing is worth a line.
  if (resolved !== null && resolved !== join(home, GLOBAL_CONFIG_RELATIVE) && /^[ \t]*\[\s*native\.ports\s*\]/m.test(readFileSync(resolved, 'utf8'))) {
    checks.push({
      name: 'project ports',
      ok: true,
      detail: `${resolved} sets [native.ports], which is ignored — one router serves every project on the machine ports; delete the table`,
    });
  }

  const agentsDir = join(opts.cwd, '.claude', 'agents');
  // Shared with `sync`, which writes these files. Computing the set separately
  // made sync write a native model's wrapper that doctor then called stale.
  const expected = expectedAgentNames(config);
  const stale = staleAgents(agentsDir, expected);
  checks.push(stale.length === 0
    ? { name: 'agents', ok: true, detail: `${expected.length} generated, none stale` }
    : {
        name: 'agents',
        ok: false,
        detail: `${stale.length} stale agent file(s) name models the config does not ` +
          `define — run \`sonata sync\` to remove them: ${stale.slice(0, 3).join(', ')}` +
          (stale.length > 3 ? ', …' : ''),
       });

  // A *stale* agent names a model the config dropped; an **outdated** one keeps
  // its name and its old instructions. `staleAgents` compares filenames and so
  // cannot see the second, which is how a fix to a generated prompt never
  // reaches a project: the files are only rewritten by `sonata sync` run there.
  //
  // Measured 2026-09-18. PR #50 bounded tier-agent fan-out after one
  // `review-complex` spawned eight children and exhausted a $200 budget; a
  // project whose agents had been generated two hours earlier went on running
  // the unbounded agent, and nothing said so.
  {
    // `outdatedAgents` deliberately propagates anything that is not ENOENT or
    // ENOTDIR, so an unreadable file is never silently treated as "not ours".
    // That is right for the function and wrong to leave unhandled here: doctor
    // is the command you run *when* the filesystem is in an odd state, so it
    // must report the problem rather than die of it. Measured: a mode-000
    // agent file made `sonata doctor` reject outright, losing the other twenty
    // checks along with it.
    let outdated: string[] = [];
    try {
      outdated = outdatedAgents(agentsDir, plannedAgents(config));
    } catch (error: unknown) {
      checks.push({
        name: 'agent freshness',
        ok: false,
        detail: `an agent file could not be read, so sonata cannot tell whether it is current — `
          + `${error instanceof Error ? error.message : String(error)}`,
      });
      outdated = [];
    }
    if (outdated.length > 0) {
      checks.push({
        name: 'agent freshness',
        ok: false,
        detail: `${outdated.length} agent file(s) were generated by an older sonata and still carry its `
          + `instructions — run \`sonata sync\` to regenerate them: ${outdated.slice(0, 3).join(', ')}`
          + (outdated.length > 3 ? ', …' : ''),
      });
    }
  }

  if (config.native) {
    // Six states, six repairs. "not found — pip install" was one sentence for
    // all of them, and it was wrong for the case that matters most: a config
    // no gateway routes through litellm needs none, and reporting that as a
    // fault sends the user to install something they will never use.
    // Seamed: `no-python` depends on what is on PATH, so hardcoding the real
    // probe would make this check's answer differ between two machines with
    // the same config — and the test asserting it pass only on one of them.
    const status = litellmStatus(home, litellmRequired(config), opts.installerDeps ?? defaultInstallerDeps);
    checks.push({ name: 'litellm', ok: statusIsHealthy(status), detail: describeStatus(status) });

    // A PATH litellm is information, not what sonata runs: `which litellm`
    // resolving says a script exists, not that an importable LiteLLM does.
    const onPath = findLitellm();
    if (onPath !== null && status.state !== 'not-required') {
      checks.push({
        name: 'litellm (PATH)',
        ok: true,
        detail: `${onPath} — not used; sonata runs its own pinned venv`,
      });
    }

    try {
      const response = await fetch(serveHealthUrl(routerPorts(home).router));
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      const identified = body !== null && typeof body === 'object' && (body as Record<string, unknown>).sonata === true;
      if (!identified) {
        checks.push({ name: 'serve health', ok: true, detail: 'not running — start with `sonata serve`' });
      } else if (response.status !== 200 || (body as { ready?: unknown }).ready === false || (body as { status?: unknown }).status === 'starting') {
        checks.push({ name: 'serve health', ok: true, detail: 'starting — LiteLLM is not ready yet' });
      } else if ((body as { multiTenant?: unknown }).multiTenant !== true) {
        checks.push({ name: 'serve health', ok: false, detail: `up, but predates multi-tenant routing — sessions here will refuse it; run \`sonata restart\`` });
      } else {
        const rawTenants = (body as { tenants?: unknown }).tenants;
        const tenantsValid = Array.isArray(rawTenants)
          && rawTenants.every((tenant) => tenant !== null && typeof tenant === 'object'
            && ('configPath' in tenant)
            && (typeof (tenant as { configPath?: unknown }).configPath === 'string'
              || (tenant as { configPath?: unknown }).configPath === null));
        if (!tenantsValid) {
          checks.push({
            name: 'serve health',
            ok: false,
            detail: 'up, but its health payload could not be read — sessions here may refuse to route; run `sonata restart`',
          });
        } else {
          const tenants = (rawTenants as { configPath: string | null }[]).map((t) => t.configPath ?? '?');
          checks.push({ name: 'serve health', ok: true, detail: `up · ${tenants.length} project(s)${tenants.length > 0 ? `: ${tenants.join(', ')}` : ''}` });
          // The router answering says nothing about the LiteLLM it proxies to.
          // Measured 2026-09-21 on two machines: the router reported healthy
          // and `doctor` printed `ok  serve health: up · 4 project(s)` while
          // NOTHING was listening on the litellm port — several orphaned
          // litellm processes existed, none of them bound. Every dispatch 502d
          // and every candidate on all three gateways failed at once, which is
          // the tell that the fault is local; but doctor said ok, so ~20
          // minutes went into upstream capacity and model rankings instead of
          // into `lsof`. A check that passes while every request fails is
          // worse than no check, so this asks the litellm port directly.
          if (litellmRequired(config)) {
            const litellmPort = routerPorts(home).litellm;
            let alive = false;
            try {
              // Bounded, because the failure this check exists to catch has a
              // variant that ACCEPTS the connection and then never answers: a
              // litellm wedged mid-request, or stopped (SIGSTOP), still has
              // the kernel completing its TCP handshake from the listen
              // backlog. An unbounded fetch there hangs `sonata doctor`
              // itself — found by simulating exactly this while testing the
              // check. A diagnostic that hangs on the fault it diagnoses is
              // the one failure mode it must not have, so a non-answer inside
              // the window is reported as down, which for every caller's
              // purposes it is.
              alive = (await fetch(`http://localhost:${litellmPort}/health/liveliness`, {
                signal: AbortSignal.timeout(LITELLM_HEALTH_TIMEOUT_MS),
              })).ok;
            } catch { alive = false; }
            checks.push(alive
              ? { name: 'litellm health', ok: true, detail: `up on port ${litellmPort}` }
              : {
                name: 'litellm health',
                ok: false,
                detail: `this config routes through LiteLLM but nothing is answering on port ${litellmPort} — `
                  + `every native request will fail 502 (or hang) while the router still reports healthy. `
                  + 'Run `sonata restart`; if it keeps happening, check the newest log in '
                  + '~/.config/sonata/logs/ for an expired OAuth credential blocking startup on an '
                  + 'interactive sign-in.',
              });
          }
          // Same gate as `sonata status`: a router without the `ui` capability
          // is one built before the UI existed, and its URL would 404.
          if (healthReportsUi(body)) {
            checks.push({ name: 'sonata UI', ok: true, detail: `http://localhost:${routerPorts(home).router}/` });
          }
        }
      }
    } catch {
      // `serve` is user-started, so an unavailable endpoint is advisory.
      checks.push({ name: 'serve health', ok: true, detail: 'not running — start with `sonata serve`' });
    }

    // A project can route every plain `claude` session through the router via
    // `.claude/settings.local.json` (`sonata route on`). The env must match
    // `nativeSessionEnv` exactly or the session silently uses a different
    // port than the router this config names; the hook keeps the router up the
    // way `sonata code` does.
    {
      const settings = readSettings(routeSettingsFile(opts.cwd));
      const target = nativeSessionEnv(config, routerPorts(home).router, opts.cwd);
      const expectedBase = target.ANTHROPIC_BASE_URL;
      const actualBase = routeEnv(settings).ANTHROPIC_BASE_URL;
      if (actualBase !== undefined && actualBase !== expectedBase) {
        checks.push({
          name: 'routed sessions',
          ok: false,
          detail: `.claude/settings.local.json routes claude to ${actualBase} but ` +
            `this config's router is ${expectedBase} — run \`sonata route on\``,
        });
      } else if (actualBase !== undefined) {
        checks.push({
          name: 'routed sessions',
          ok: true,
          detail: `claude sessions route through ${actualBase} (sonata route on)`,
        });
      }

      // Auto mode is reported separately because it explains an otherwise
      // confusing pair of observations: a settings file with no routing env in
      // it, and sessions that route anyway. It also explains the reverse — a
      // file left routed by a session that died before its SessionEnd hook.
      if (opts.packageRoot !== undefined && autoInstalled(settings, opts.packageRoot)) {
        const live = readSessions(routeSessionsFile(opts.cwd)).length;
        checks.push({
          name: 'route auto',
          ok: true,
          detail: live === 0
            ? 'routing follows foreign-model subagents; no sessions live now'
            : `${live} session(s) live; routing turns on only while a subagent runs`,
        });
      }
    }

    // An OAuth gateway holds no key at all — its credential is a harness login
    // that LiteLLM reads and refreshes. Reporting it through keyReport would
    // tell the user to `sonata auth add` a key that would be ignored, and claim
    // no usable credential exists when one does.
    const gatewayNames = Object.keys(config.native.gateways);
    // A gateway with a recorded source gets exactly one check, right here — the
    // legacy automatic-sniffing checks below are skipped for it. Running both
    // meant a valid `credential_source = "sonata"` could pass its own check and
    // then fail the legacy codex/opencode sniff, making `doctor` exit 1 for a
    // correctly configured gateway.
    const sourcedGateways = new Set(
      gatewayNames.filter((name) => config.native!.gateways[name].credentialSource !== undefined),
    );

    for (const [name, gateway] of Object.entries(config.native.gateways)) {
      const source = gateway.credentialSource;
      if (source === undefined) {
        // Distinct name from the `key source: <gateway>` checks below — this is
        // informational only, and the automatic-resolution checks further down
        // still own verifying that gateway's credential.
        checks.push({
          name: `credential source: ${name}`,
          ok: true,
          detail: `${name}: credential resolved automatically (no credential_source recorded)`,
        });
        continue;
      }
      const present = gateway.auth === 'api-key'
        ? (source === 'sonata' || source === 'opencode') && resolveKeyFromSource(name, home, source) !== undefined
        : source === 'sonata'
          ? existsSync(join(credentialDir(home, name), credentialFileFor(gateway.auth)))
          : await hasCredentialFrom(source, gateway.auth, home);
      // The fix differs by what the source actually stores: a device-login
      // credential is repaired with `sonata auth login`, but a bearer key is
      // repaired with `sonata auth add` — or, for an opencode-sourced key,
      // by logging into opencode itself, which sonata does not manage.
      const repairHint = gateway.auth === 'api-key'
        ? source === 'sonata'
          ? `run \`sonata auth add ${name}\``
          : `log into opencode itself — sonata does not manage opencode credentials`
        : source === 'sonata'
          ? `run \`sonata auth login ${name}\``
          : source === 'codex'
            ? 'log in with `codex login`'
            : gateway.auth === 'copilot-oauth'
              ? 'log into opencode with a GitHub Copilot account'
              : 'log into opencode with a ChatGPT account';
      checks.push({
        name: `key source: ${name}`,
        ok: present,
        detail: present
          ? `${name}: credential from ${source}`
          : `${name}: credential from ${source}\n  ! ${name}: no credential from ${source} — ${repairHint}`,
      });
    }

    const oauthGateways = gatewayNames.filter(
      (name) => isOauthGatewayAuth(config.native!.gateways[name].auth) && !sourcedGateways.has(name));

    for (const gateway of oauthGateways) {
      if (config.native.gateways[gateway].auth === 'copilot-oauth') {
        const report = copilotAuthReport(home);
        if (report.problem !== undefined) {
          checks.push({ name: `key source: ${gateway}`, ok: false, detail: report.problem });
          continue;
        }
        // Having a token is not the same as being able to use it: opencode
        // requests only `read:user`, and GitHub then refuses the Copilot
        // exchange with a 403 that LiteLLM turns into "no healthy deployments".
        const token = readCopilotToken(home);
        const usable = token !== null && await copilotTokenCanExchange(token);
        checks.push(usable
          ? { name: `key source: ${gateway}`, ok: true, detail: 'GitHub Copilot login from opencode' }
          : {
              name: `key source: ${gateway}`,
              ok: false,
              detail: 'the stored GitHub token cannot mint a Copilot key — it needs the ' +
                '`copilot` scope (opencode requests only read:user)',
            });
        continue;
      }
      const report = codexAuthReport(home);
      checks.push({
        name: `key source: ${gateway}`,
        ok: report.problem === undefined,
        detail: report.problem
          ?? `ChatGPT subscription from ${report.source ?? 'codex'}` +
             (report.expired ? ' (expired, refreshes on use)' : ''),
      });
    }

    const keyGateways = gatewayNames.filter(
      (name) => !oauthGateways.includes(name) && !sourcedGateways.has(name));
    for (const report of keyReport(keyGateways, home)) {
      checks.push(report.source
        ? { name: `key source: ${report.gateway}`, ok: true, detail: `from ${report.source}` }
        : {
            name: `key source: ${report.gateway}`,
            ok: false,
            detail: `no key — \`sonata auth add ${report.gateway}\``,
          });
    }
  }

  // Read once per file, and never throw. This read was unguarded, so a single
  // unreadable agent file — mode 000, a broken symlink, a directory sonata
  // cannot traverse — made `sonata doctor` reject outright and take its other
  // twenty checks with it. Doctor is the command you run *when* the filesystem
  // is in an odd state, so it has to report what it cannot read rather than
  // die of it. The same file was also being read three times over.
  const unreadable: string[] = [];
  const agentText = new Map<string, string>();
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir).filter((name) => name.endsWith('.md'))) {
      try {
        agentText.set(f, readFileSync(join(agentsDir, f), 'utf8'));
      } catch {
        unreadable.push(f);
      }
    }
  }
  if (unreadable.length > 0) {
    checks.push({
      name: 'agent files',
      ok: false,
      detail: `${unreadable.length} agent file(s) could not be read, so sonata cannot check them: `
        + `${unreadable.slice(0, 3).join(', ')}${unreadable.length > 3 ? ', …' : ''}`,
    });
  }
  const wrappers = [...agentText.keys()].filter((f) =>
    agentText.get(f)!.includes('forwarding wrapper around the sonata runtime'));
  const withBash = wrappers.filter((f) => /^tools:\s*Bash\s*$/m.test(agentText.get(f)!));
  // Catches both generations of removed MCP tool names: run/tail (pre-dispatch
  // rename) and dispatch/wait/approve (the MCP server itself, removed when the
  // Bash CLI replaced it) — an upgrade from either still has wrappers naming
  // tools that no longer exist.
  const stalePolling = wrappers.filter((f) =>
    /mcp__[^_\s]+__(run|tail|dispatch|wait|approve)\b/.test(agentText.get(f)!));
  checks.push(stalePolling.length === 0
    ? { name: 'agent tools', ok: withBash.length === 0, detail: withBash.length === 0
        ? 'no wrapper grants Bash'
        : `${withBash.length} wrapper(s) still grant Bash and can do the work ` +
          'themselves — run `sonata sync`' }
    : {
        name: 'agent tools',
        ok: false,
        detail: `${stalePolling.length} wrapper(s) still call removed MCP ` +
          'tools and will fail mid-dispatch — run `sonata sync`',
      });

  // Agents sonata dispatches to. A disabled one is not an error opencode
  // reports: `--agent explore` falls back to the write-capable `build` with a
  // warning in the pane that nothing parses, so a read-only role silently
  // stops being read-only. Corrected rather than reported, because the
  // failure is invisible and the fix is one field.
  const NEEDED_OPENCODE_AGENTS = ['explore', 'plan', 'build'];
  const disabled = disabledOpencodeAgents(home).filter((a) => NEEDED_OPENCODE_AGENTS.includes(a));
  if (disabled.length === 0) {
    checks.push({ name: 'opencode agents', ok: true, detail: 'none sonata needs are disabled' });
  } else {
    const fixed = disabled.filter((a) => enableOpencodeAgent(home, a));
    checks.push({
      name: 'opencode agents',
      ok: fixed.length === disabled.length,
      detail: fixed.length > 0
        ? `re-enabled ${fixed.join(', ')} in opencode.json — disabled, a read-only role ` +
          'silently runs under the write-capable `build`'
        : `${disabled.join(', ')} disabled in opencode.json and could not be re-enabled`,
    });
  }

  const staleMcp = staleMcpRegistration(opts.cwd, home);
  if (staleMcp !== undefined) {
    checks.push({ name: 'stale MCP registration', ok: false, detail: staleMcp });
  }

  const harnesses = new Set(Object.values(config.models).map((m) => m.harness));

  // Without the hook sonata cannot read the session's permission mode and
  // assumes `default` — which a harness that cannot ask for approval refuses
  // outright, so every dispatch to it fails. Say that here rather than letting
  // it surface as a confusing failure on first use.
  const cannotAsk = [...harnesses].filter((h) => !getAdapter(h).canPromptForApproval);
  if (cannotAsk.length > 0) {
    const installed = (['project', 'global'] as const).some((scope) =>
      modeHookPresent(readSettings(settingsPath(scope, opts.cwd, homedir()))),
    );
    checks.push({
      name: 'permission hook',
      ok: installed,
      detail: installed
        ? 'installed — the session permission mode is visible to sonata'
        : `not installed, so sonata assumes \`default\`, which ${cannotAsk.join(' and ')} ` +
          'cannot honour — those dispatches will refuse. Run `sonata init`',
    });
  }
  // The wrapper's three tools must be allow-listed. Left to `auto` mode they
  // are judged per call and the decisions are not stable: a wrapper on
  // 2026-08-12 had `tail` allowed twice then denied twice mid-run, so the run
  // kept going with nothing able to read it back. `run` executes code, and it
  // is the one the classifier tends to permit — so the failure is silent by
  // construction, and worth naming before it happens rather than after.
  {
    const scopes = ['project', 'global'] as const;
    const missing = scopes
      .map((scope) => missingAllowEntries(readSettings(settingsPath(scope, opts.cwd, homedir()))))
      .reduce((a, b) => (a.length <= b.length ? a : b));
    checks.push({
      name: 'tool permissions',
      ok: missing.length === 0,
      detail: missing.length === 0
        ? 'the sonata tools are allow-listed, so no dispatch depends on the classifier'
        : `${missing.join(', ')} not allow-listed — in \`auto\` mode these are judged per call, ` +
          'and a denied `wait` leaves a paused dispatch unobservable. Run `sonata init`',
    });
  }

  // The *client*, checked separately from the harnesses. The loop below covers
  // `claude` only when the config names it as a harness, while every native
  // dispatch runs inside whatever Claude Code the user is already running — so
  // a broken client breaks the primary lane and nothing above would say so.
  // Reported only when the build is known bad: sonata does not otherwise have
  // a tested range for the client, and inventing one would fail every future
  // release.
  try {
    const version = await (opts.claudeVersion ?? defaultClaudeVersion)();
    const broken = version === undefined ? undefined : knownBadVersion(version);
    if (version !== undefined && broken !== undefined) {
      checks.push({ name: 'claude code (client)', ok: false, detail: `${version} — ${broken}` });
    }
  } catch {
    // No `claude` on PATH is not a sonata problem: `sonata dispatch` works
    // without it, and a session that has one is running it already.
  }

  for (const name of harnesses) {
    const adapter = getAdapter(name);
    try {
      const env = { ...process.env, PATH: `${process.env.HOME}/.opencode/bin:${process.env.PATH}` };
      const { stdout } = await run(adapter.versionCommand[0], adapter.versionCommand.slice(1), { env });
      const version = stdout.trim();
      // A known-bad build fails even when it sits inside the tested range:
      // `supportedVersions` says which versions were exercised, which is a
      // different question from whether this one is broken.
      const broken = name === 'claude' ? knownBadVersion(version) : undefined;
      const ok = broken === undefined && checkVersion(version, adapter.supportedVersions);
      checks.push({
        name,
        ok,
        detail: broken !== undefined
          ? `${version} — ${broken}`
          : ok ? version : `${version} outside tested range ${adapter.supportedVersions}`,
      });

      // Version alone does not mean usable: a harness can be installed, current
      // and still unable to reach a model.
      if (adapter.health) {
        for (const p of await adapter.health({ home: homedir(), cwd: opts.cwd })) {
          checks.push({
            name: `${name} health`,
            ok: p.severity !== 'error',
            detail: p.fix ? `${p.message} — ${p.fix}` : p.message,
          });
        }
      }
    } catch {
      checks.push({ name, ok: false, detail: 'not found on PATH' });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
