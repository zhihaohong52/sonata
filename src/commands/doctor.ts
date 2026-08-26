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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findLitellm } from '../native/litellm.js';
import { keyReport, resolveKeyFromSource } from '../native/credentials.js';
import { codexAuthReport, readChatGptOAuth } from '../native/codex-auth.js';
import { copilotAuthReport, copilotTokenCanExchange, readCopilotToken } from '../native/copilot-auth.js';
import { credentialDir, credentialFileFor } from '../native/oauth-login.js';
import { serveHealthUrl } from './serve.js';
import { nativeSessionEnv } from './code.js';
import { routeEnv, routeSettingsFile, autoInstalled, readSessions, routeSessionsFile } from './route.js';

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


export async function cmdDoctor(
  opts: { cwd: string; home?: string; packageRoot?: string },
): Promise<{ ok: boolean; checks: Check[] }> {
  const home = opts.home ?? homedir();
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
  } catch (err) {
    checks.push({ name: 'sonata.toml', ok: false, detail: (err as Error).message });
    return { ok: false, checks };
  }

  // Tier agents call the native router first. Report a blocking warning when
  // neither persistent routing nor route-auto hooks are configured.
  if (config.tiers !== undefined) {
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
      const routerUrl = cfg.native !== undefined ? `http://localhost:${cfg.native.ports.router}` : undefined;
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
        detail: 'tier agents need a routed session — run `sonata route auto`',
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

  if (config.native) {
    const litellm = findLitellm();
    checks.push(litellm
      ? { name: 'litellm', ok: true, detail: litellm }
      : { name: 'litellm', ok: false, detail: "not found — pip install 'litellm[proxy]'" });

    try {
      const response = await fetch(serveHealthUrl(config.native.ports.router));
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      const healthy = response.status === 200
        && body !== null
        && typeof body === 'object'
        && (body as Record<string, unknown>).sonata === true;
      checks.push(healthy
        ? { name: 'serve health', ok: true, detail: 'up' }
        : { name: 'serve health', ok: true, detail: 'not running — start with `sonata serve`' });
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
      const target = nativeSessionEnv(config);
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

  const wrappers = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((f) => f.endsWith('.md')).filter((f) =>
        readFileSync(join(agentsDir, f), 'utf8')
          .includes('forwarding wrapper around the sonata runtime'))
    : [];
  const withBash = wrappers.filter((f) =>
    /^tools:\s*Bash\s*$/m.test(readFileSync(join(agentsDir, f), 'utf8')));
  // Catches both generations of removed MCP tool names: run/tail (pre-dispatch
  // rename) and dispatch/wait/approve (the MCP server itself, removed when the
  // Bash CLI replaced it) — an upgrade from either still has wrappers naming
  // tools that no longer exist.
  const stalePolling = wrappers.filter((f) =>
    /mcp__[^_\s]+__(run|tail|dispatch|wait|approve)\b/.test(readFileSync(join(agentsDir, f), 'utf8')));
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

  for (const name of harnesses) {
    const adapter = getAdapter(name);
    try {
      const env = { ...process.env, PATH: `${process.env.HOME}/.opencode/bin:${process.env.PATH}` };
      const { stdout } = await run(adapter.versionCommand[0], adapter.versionCommand.slice(1), { env });
      const version = stdout.trim();
      const ok = checkVersion(version, adapter.supportedVersions);
      checks.push({
        name,
        ok,
        detail: ok ? version : `${version} outside tested range ${adapter.supportedVersions}`,
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
