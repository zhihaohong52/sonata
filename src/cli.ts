#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { cmdRun } from './commands/run.js';
import { cmdDispatch } from './commands/dispatch.js';
import { cmdTail } from './commands/tail.js';
import { cmdWait } from './commands/wait.js';
import { loadConfig } from './config.js';
import { cmdApprove } from './commands/approve.js';
import { cmdSync } from './commands/sync.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdGc } from './commands/gc.js';
import { cmdInit, isCancellation } from './commands/init.js';
import { initLogDir } from './commands/init-log.js';
import { banner, isInteractive, confirm } from './tui.js';
import { pruneAgents } from './detect.js';
import type { HookScope } from './settings.js';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { cmdAuthAdd, cmdAuthList, cmdAuthLogin, cmdAuthRemove } from './commands/auth.js';
import { cmdServe, cmdRestart, startServeDaemon, isSonataRouter } from './commands/serve.js';
import { cmdCode } from './commands/code.js';
import { recentRoutes } from './commands/status.js';
import { summarizeRuns } from './commands/runs.js';
import { cmdRoute, cmdRouteSession, cmdRouteSubagent, type RouteAction } from './commands/route.js';
import { cmdCatalogUpdate } from './commands/catalog.js';
import { AA_ATTRIBUTION, aaCatalogPath, loadAaCatalog } from './catalog.js';
import { AI_PRICING_ATTRIBUTION } from './aipricing.js';
import { cmdUsage, type UsageDimension } from './commands/usage.js';
import { readRows } from './ledger.js';

const USAGE = `sonata — foreign-model subagents for Claude Code

  sonata init      set up sonata in this project (interactive)
  sonata doctor    check tmux, harnesses, auth and versions
  sonata sync      regenerate agent files from sonata.toml
  sonata run       launch a harness run, print its id
  sonata dispatch  run a ranked tier with harness fallback
  sonata tail      poll a run for progress
  sonata wait      resume a RUNNING or approved run and block for its next state
  sonata approve   answer a pending approval (requires --yes or --no)
  sonata gc        kill finished tmux sessions
  sonata log       print a run's whole transcript (tail returns only new lines)
  sonata verify    confirm a dispatch actually happened
  sonata serve     start the native routing proxy (router + litellm)
  sonata restart   kill any router holding the port and start a fresh daemon
  sonata code      launch a claude session routed through sonata serve
  sonata route     on|off|status — route plain claude sessions through sonata serve
                   auto|manual — route each session for its lifetime, keeping Remote Control
  sonata auth      manage gateway credentials (list/add/remove/login)
  sonata catalog   show or refresh the Artificial Analysis model catalog
  sonata usage     report native-path token and cost usage from the ledger
  sonata status    router health and the last hour of routes
  sonata runs      list every run, with state and whether it wrote a report

  init flags (skip the prompts):
    --yes                    accept defaults, no prompts
    --providers opencode/openrouter,pi/opencode-go   providers to draw models from
    --models a,b             models to enable (config keys)
    --roles code,review      roles to generate
    --credential-source gateway=sonata|codex|opencode   record a gateway credential source
    --config-scope project|global   where the config and its agents go
    --scope project|global|skip   where to install the permission hook
    --prune                    delete stale sonata agent files
`;

/** `--wait` wins; otherwise use the configured tail window. */
export function tailWaitSeconds(flag: string | undefined, configured: number): number {
  if (flag === undefined) return configured;
  const parsed = Number.parseInt(flag, 10);
  return Number.isFinite(parsed) ? parsed : configured;
}

/** Repository root, one level above the compiled dist/ or src/ directory. */
function packageRoot(): string {
  return join(fileURLToPath(new URL('.', import.meta.url)), '..');
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  if (command === 'init') {
    const { values } = parseArgs({
      args: rest,
      options: {
        yes: { type: 'boolean', default: false },
        providers: { type: 'string' },
        models: { type: 'string' },
        roles: { type: 'string' },
        'credential-source': { type: 'string', multiple: true },
        'config-scope': { type: 'string' },
        scope: { type: 'string' },
        routing: { type: 'string' },
        // No default: `undefined` means "unanswered", which lets cmdInit fall
        // through to the interactive prompt. `false` would suppress it.
        prune: { type: 'boolean' },
      },
    });

    const scope = values.scope as HookScope | 'skip' | undefined;
    if (scope && !['project', 'global', 'skip'].includes(scope)) {
      throw new Error(`sonata init: --scope must be project, global or skip (got "${scope}")`);
    }

    const routing = values.routing as 'project' | 'global' | 'skip' | undefined;
    if (routing && !['project', 'global', 'skip'].includes(routing)) {
      throw new Error(`sonata init: --routing must be project, global or skip (got "${routing}")`);
    }

    const configScope = values['config-scope'] as 'project' | 'global' | undefined;
    if (configScope && !['project', 'global'].includes(configScope)) {
      throw new Error(
        `sonata init: --config-scope must be project or global (got "${configScope}")`,
      );
    }

    const split = (v: string | undefined): string[] | undefined =>
      v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean);

    try {
      const res = await cmdInit({
        cwd: process.cwd(),
        home: homedir(),
        packageRoot: packageRoot(),
        yes: values.yes,
        providers: split(values.providers),
        models: split(values.models),
        roles: split(values.roles),
        credentialSource: values['credential-source'],
        scope,
        routing,
        configScope,
        prune: values.prune,
      });
      if (res.cancelled) return 1;
      return res.problems.some((p) => p.severity === 'error') ? 1 : 0;
    } catch (err) {
      // The wizard owns the screen, so a failure's own output may already be
      // gone with the alternate buffer. Point at the log that survived it.
      const logDir = initLogDir(homedir());
      if (isCancellation(err)) {
        console.log('\n  Cancelled. Nothing written.');
        console.log(`  Log: ${logDir}`);
        return 130;
      }
      console.error(`\n  sonata init failed. Log: ${logDir}`);
      throw err;
    }
  }

  if (command === 'run') {
    const { values } = parseArgs({
      args: rest,
      options: {
        role: { type: 'string' },
        model: { type: 'string' },
        'task-file': { type: 'string' },
        'roles-dir': { type: 'string' },
        json: { type: 'boolean', default: false },
      },
    });
    if (!values.role || !values.model || !values['task-file']) {
      throw new Error('sonata run requires --role, --model and --task-file');
    }
    const res = await cmdRun({
      cwd: process.cwd(),
      role: values.role,
      model: values.model,
      taskFile: values['task-file'],
      // fileURLToPath, not .pathname — the latter percent-encodes spaces and
      // would break for anyone whose install path contains one.
      rolesDir: values['roles-dir'] ?? join(packageRoot(), 'roles'),
      sessionId: process.env.CLAUDE_CODE_SESSION_ID,
    });
    // The attach command is printed in full, because watching a foreign model
    // work is the one thing sonata cannot stream into a Claude Code
    // conversation — and reconstructing the session name by hand is the step
    // that stops people from looking.
    console.log(values.json
      ? JSON.stringify(res)
      : `run ${res.id} (tmux ${res.session})\n  watch: tmux attach -r -t ${res.session}`);
    return 0;
  }

  if (command === 'dispatch') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        tier: { type: 'string' },
        model: { type: 'string' },
        role: { type: 'string' },
        'task-file': { type: 'string' },
        'task-stdin': { type: 'boolean' },
        'roles-dir': { type: 'string' },
      },
    });
    if ((values.tier === undefined) === (values.model === undefined)) {
      throw new Error('sonata dispatch requires exactly one of --tier or --model');
    }
    if (values.role !== undefined && values.tier !== undefined) {
      throw new Error('sonata dispatch: --role only applies to --model; --tier\'s alias already names a role');
    }
    if (values['task-file'] !== undefined && values['task-stdin']) {
      throw new Error('sonata dispatch: --task-file and --task-stdin are mutually exclusive');
    }
    if ((values['task-file'] !== undefined || values['task-stdin']) && positionals.length > 0) {
      throw new Error('sonata dispatch accepts positional task text only without --task-file/--task-stdin');
    }
    const task = values['task-stdin']
      ? readFileSync(0, 'utf8')
      : values['task-file'] !== undefined
        ? readFileSync(values['task-file'], 'utf8')
        : positionals.join(' ');
    if (!task.trim()) throw new Error('sonata dispatch requires task text, --task-file, or --task-stdin');
    const res = await cmdDispatch({
      cwd: process.cwd(),
      home: homedir(),
      tier: values.tier,
      model: values.model,
      role: values.role,
      task,
      rolesDir: values['roles-dir'] ?? join(packageRoot(), 'roles'),
      sessionId: process.env.CLAUDE_CODE_SESSION_ID,
    });
    console.log(`${res.state} model=${res.modelKey} id=${res.id}`);
    if (res.report) console.log(`\n${res.report}`);
    if (res.prompt) {
      console.log(`\nPROMPT: ${res.prompt}`);
      console.log(`sonata approve ${res.id} --yes   (or --no)`);
    } else if (res.state === 'RUNNING') {
      console.log(`sonata wait ${res.id}`);
    }
    if (res.state === 'FAILED') {
      for (const attempt of res.attempts) {
        console.log(`  ${attempt.modelKey}: ${attempt.state}${attempt.degraded ? ' (degraded)' : ''}${attempt.error ? ` — ${attempt.error}` : ''}`);
      }
      return 1;
    }
    if (res.state === 'STALLED') return 3;
    return 0;
  }

  if (command === 'tail') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { wait: { type: 'string' }, json: { type: 'boolean', default: false } },
    });
    const id = positionals[0];
    if (!id) throw new Error('sonata tail requires a run id');
    const res = await cmdTail({
      cwd: process.cwd(),
      id,
      waitSeconds: tailWaitSeconds(values.wait, loadConfig(process.cwd()).run.tailWindowSeconds),
    });
    if (values.json) {
      console.log(JSON.stringify(res));
    } else {
      console.log(res.state);
      for (const l of res.lines) console.log(`  ${l}`);
      if (res.prompt) console.log(`  PROMPT: ${res.prompt}`);
      if (res.report) console.log(`\n${res.report}`);
    }
    return res.state === 'STALLED' ? 3 : 0;
  }

  if (command === 'wait') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { json: { type: 'boolean', default: false } },
    });
    const id = positionals[0];
    if (!id) throw new Error('sonata wait requires a run id');
    const res = await cmdWait({ cwd: process.cwd(), id });
    if (values.json) {
      console.log(JSON.stringify(res));
    } else {
      console.log(res.state);
      for (const l of res.lines) console.log(`  ${l}`);
      if (res.prompt) {
        console.log(`  PROMPT: ${res.prompt}`);
        console.log(`sonata approve ${id} --yes   (or --no)`);
      } else if (res.state === 'RUNNING') {
        console.log(`sonata wait ${id}`);
      }
      if (res.report) console.log(`\n${res.report}`);
    }
    return res.state === 'STALLED' ? 3 : 0;
  }

  if (command === 'approve') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { yes: { type: 'boolean', default: false }, no: { type: 'boolean', default: false } },
    });
    const id = positionals[0];
    if (!id) throw new Error('sonata approve requires a run id');
    if (values.yes === values.no) throw new Error('sonata approve requires exactly one of --yes or --no');
    await cmdApprove({ cwd: process.cwd(), id, yes: values.yes });
    console.log(`approved=${values.yes} run=${id}`);
    return 0;
  }

  if (command === 'sync') {
    const { values } = parseArgs({
      args: rest,
      options: { prune: { type: 'boolean', default: false } },
    });
    const agentsDir = join(process.cwd(), '.claude', 'agents');
    const sync = cmdSync({
      cwd: process.cwd(),
      home: homedir(),
      agentsDir,
    });
    for (const p of sync.written) console.log(`wrote ${p}`);
    if (sync.skipped.length > 0) {
      for (const f of sync.skipped.slice(0, 5)) console.log(`skipped ${f} (exists, not sonata-owned)`);
      if (sync.skipped.length > 5) console.log(`skipped ... and ${sync.skipped.length - 5} more`);
    }
    if (sync.stale.length > 0) {
      for (const f of sync.stale.slice(0, 5)) console.log(`stale ${f}`);
      if (sync.stale.length > 5) console.log(`stale ... and ${sync.stale.length - 5} more`);
      const remove = values.prune || (isInteractive() && await confirm('Delete them?', true));
      if (remove) {
        const pruned = pruneAgents(agentsDir, sync.stale);
        console.log(`removed ${pruned.length} stale agent file(s)`);
      } else {
        console.log('delete them by hand, or re-run with --prune');
      }
    }
    return 0;
  }

  if (command === 'doctor') {
    // doctor is read, not piped — but only decorate a real terminal, so
    // `sonata doctor > report.txt` stays plain.
    if (isInteractive()) console.log(`\n${banner()}\n`);
    const { ok, checks } = await cmdDoctor({
      cwd: process.cwd(),
      home: homedir(),
      packageRoot: packageRoot(),
    });
    for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    return ok ? 0 : 1;
  }

  if (command === 'catalog') {
    const action = rest[0];
    if (action !== undefined && action !== 'update') {
      throw new Error('sonata catalog requires update or no subcommand');
    }
    if (action === 'update') {
      const result = await cmdCatalogUpdate(homedir());
      if ('error' in result.aa) {
        console.error(`Artificial Analysis catalog not updated: ${result.aa.error.message}`);
      } else {
        console.log(`catalog updated: ${result.aa.models} models`);
        console.log(`  path: ${result.aa.path}`);
        console.log(`  fetched: ${result.aa.fetchedAt}`);
        console.log(AA_ATTRIBUTION);
      }
      if ('error' in result.aiPricing) {
        console.error(`ai-pricing catalog not updated: ${result.aiPricing.error.message}`);
      } else {
        console.log(`ai-pricing catalog updated: ${result.aiPricing.models} models`);
        console.log(`  path: ${result.aiPricing.path}`);
        console.log(`  fetched: ${result.aiPricing.fetchedAt}`);
        console.log(AI_PRICING_ATTRIBUTION);
      }
      return 'error' in result.aa || 'error' in result.aiPricing ? 1 : 0;
    }
    const path = aaCatalogPath(homedir());
    const catalog = loadAaCatalog(homedir());
    if (!catalog || !existsSync(path)) {
      console.log('no catalog — run sonata catalog update');
      return 0;
    }
    const age = Math.max(0, Date.now() - Date.parse(catalog.fetchedAt));
    console.log(`catalog: ${catalog.models ? Object.keys(catalog.models).length : 0} models; age ${Math.floor(age / 1000)}s`);
    console.log(`  path: ${path}`);
    return 0;
  }

  if (command === 'usage') {
    // parseArgs is strict by default: an unrecognized flag throws rather than
    // being silently ignored — for a cost report, quietly falling back to the
    // default window on a misspelled `--since` would be materially misleading.
    const { values } = parseArgs({
      args: rest,
      options: {
        by: { type: 'string' },
        since: { type: 'string' },
        session: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
    });
    const by = (values.by ?? 'model') as UsageDimension;
    if (!['model', 'role', 'tier', 'gateway', 'session', 'project'].includes(by)) {
      throw new Error('sonata usage --by must be one of: model | role | tier | gateway | session | project');
    }
    const report = await cmdUsage({
      home: homedir(),
      since: values.since ?? '7d',
      by,
      session: values.session,
      json: values.json,
    });
    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    // Widen to the longest label rather than a fixed 30: a model key like
    // `openrouter-nemotron-3.5-lightning` overruns that, and every number on
    // its row then shifts out of its column.
    const labelWidth = Math.max(0, ...report.buckets.map((bucket) => bucket.label.length));
    for (const bucket of report.buckets) {
      console.log(`${bucket.label.padEnd(labelWidth)} ${String(bucket.requests).padStart(8)} ${String(bucket.input).padStart(12)} ${String(bucket.output).padStart(10)}  ${bucket.costUsd === 0 && bucket.unpricedRequests === bucket.requests ? '—' : `$${bucket.costUsd.toFixed(4)}`}`);
    }
    console.log(`\npriced total   $${report.pricedTotalUsd.toFixed(4)}`);
    if (report.unpriced.requests > 0) {
      console.log(`unpriced       ${report.unpriced.requests} requests · ${report.unpriced.input} in · ${report.unpriced.output} out`);
    }
    console.log('native path only — `sonata dispatch` runs bypass the router and cannot be measured');
    if (report.priceCacheAgeMs !== undefined) {
      console.log(`prices: ai-pricing.fyi cache ${Math.floor(report.priceCacheAgeMs / 86_400_000)}d old`);
    }
    return 0;
  }

  if (command === 'status') {
    // parseArgs is strict by default: an unknown flag throws rather than being
    // silently ignored — a misspelled `--session` must not silently fall back
    // to the most recent session's rows.
    const { values } = parseArgs({
      args: rest,
      options: {
        session: { type: 'string' },
        all: { type: 'boolean', default: false },
      },
    });
    if (values.session !== undefined && values.all) {
      throw new Error('sonata status: --session and --all are mutually exclusive');
    }
    const home = homedir();
    let port: number | undefined;
    try {
      port = loadConfig(process.cwd(), home).native?.ports.router;
    } catch { /* no config here — ledger rows below still report */ }
    const up = port === undefined ? false : await isSonataRouter(port);
    console.log(up ? `router: up on localhost:${port}` : port === undefined ? 'router: unknown (no sonata.toml here)' : 'router: down');

    // The last hour of routes by default, narrowed to the most recent session
    // — unless --all asks for every session or --session names one specifically.
    let rows = readRows(home, Date.now() - 3_600_000);
    if (values.all) {
      // keep every session's rows
    } else if (values.session !== undefined) {
      rows = rows.filter((row) => row.session === values.session);
    } else {
      // The most recent session is the one whose newest row is newest.
      const sessions = new Map<string, number>();
      for (const row of rows) {
        if (row.session === undefined) continue;
        const ts = Date.parse(row.ts);
        const prev = sessions.get(row.session);
        if (prev === undefined || ts > prev) sessions.set(row.session, ts);
      }
      let newest: { id: string; ts: number } | undefined;
      for (const [id, ts] of sessions) {
        if (newest === undefined || ts > newest.ts) newest = { id, ts };
      }
      rows = newest === undefined ? [] : rows.filter((row) => row.session === newest.id);
    }

    const recent = recentRoutes(rows, 10);
    if (recent.length === 0) {
      console.log('no routes in the last hour');
    } else {
      for (const line of recent) {
        const served = line.served ?? '(none — all candidates failed)';
        console.log(`${line.status}  ${line.alias.padEnd(24)} -> ${served.padEnd(20)} ${line.input} in / ${line.output} out`);
        if (line.attempts.length > 0) {
          for (const a of line.attempts) console.log(`    attempt ${a.key}: ${a.status}`);
        }
      }
    }
    console.log('reach and routing state live in `sonata route status`');
    return 0;
  }

  if (command === 'runs') {
    const { values } = parseArgs({
      args: rest,
      options: { json: { type: 'boolean', default: false } },
    });
    const runs = summarizeRuns(process.cwd());
    if (values.json) {
      console.log(JSON.stringify(runs, null, 2));
      return 0;
    }
    if (runs.length === 0) {
      console.log('no runs — `sonata run` or `sonata dispatch` to launch one');
      return 0;
    }
    for (const r of runs) {
      const flags = `${r.state}${r.degraded ? ' degraded' : ''}${r.report ? ' report' : ''}`;
      console.log(`${r.id.padEnd(8)} ${flags.padEnd(24)} ${(r.role ?? '—').padEnd(8)} ${r.model ?? '—'} ${r.started ?? ''}`);
    }
    return 0;
  }

  if (command === 'auth') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
    const [action, gateway] = positionals;
    let gateways: string[] = [];
    try {
      gateways = Object.keys(loadConfig(process.cwd(), homedir()).native?.gateways ?? {});
    } catch { /* no config yet — add/remove/login do not need one */ }

    if (action === 'list') {
      console.log(cmdAuthList({ home: homedir(), gateways }).text);
      return 0;
    }
    if (action === 'login') {
      if (!gateway) throw new Error('sonata auth login requires a gateway');
      await cmdAuthLogin({ home: homedir(), cwd: process.cwd(), gateway, out: (l) => console.log(l) });
      return 0;
    }
    if (action === 'remove') {
      if (!gateway) throw new Error('sonata auth remove requires a gateway');
      cmdAuthRemove({ home: homedir(), gateway });
      return 0;
    }
    if (action === 'add') {
      if (!gateway) throw new Error('sonata auth add requires a gateway');
      const key = await readAuthKey();
      if (!key) throw new Error('sonata auth add requires a non-empty key');
      cmdAuthAdd({ home: homedir(), gateway, key });
      return 0;
    }
    throw new Error('sonata auth requires list, add <gateway>, remove <gateway> or login <gateway>');
  }

  if (command === 'serve') {
    const { values } = parseArgs({
      args: rest,
      options: { daemon: { type: 'boolean', default: false } },
    });
    if (values.daemon) {
      // Re-exec this same CLI in the foreground, detached. The flag used to be
      // parsed, handed to cmdServe and ignored, so `--daemon` blocked exactly
      // like the foreground command.
      const self = fileURLToPath(import.meta.url);
      const daemon = await startServeDaemon(homedir(), [process.execPath, self, 'serve']);
      console.log(`sonata serve running in the background (pid ${daemon.pid}) on port ${daemon.port}`);
      console.log(`  log:  ${daemon.logPath}`);
      console.log(`  stop: kill ${daemon.pid}`);
      return 0;
    }

    const handle = await cmdServe({ cwd: process.cwd(), home: homedir(), daemon: values.daemon });
    console.log(`router listening on ${handle.routerPort}; litellm listening on ${handle.litellmPort}`);

    // serve runs until it is killed, so the signal handlers ARE its normal exit
    // path — without them `stop()` never runs and the run's temp directory
    // survives. That directory holds the generated master key, and for a
    // codex-oauth gateway the ChatGPT credential too; one was found in the
    // system temp directory after a Ctrl-C.
    let stopping = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      void handle.stop().finally(() => process.kill(process.pid, signal));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.once('SIGHUP', shutdown);

    await new Promise<void>(() => {});
    return 0;
  }

  if (command === 'code') {
    const passthrough = rest[0] === '--' ? rest.slice(1) : rest;
    await cmdCode({ cwd: process.cwd(), home: homedir(), passthrough });
    return 0;
  }

  if (command === 'route') {
    const action = rest[0];
    const global = rest.includes('--global');
    const scope = global ? 'global' as const : 'project' as const;
    const opts = { cwd: process.cwd(), home: homedir(), packageRoot: packageRoot(), scope };

    // The two session-<phase> actions are the body of the auto-mode hooks, not
    // a surface for people: they take the session id the hook read from stdin.
    if (action === 'session-start' || action === 'session-end') {
      const id = rest[rest.indexOf('--id') + 1];
      if (!rest.includes('--id') || !id) throw new Error(`sonata route ${action} requires --id <session-id>`);
      const self = fileURLToPath(import.meta.url);
      const res = await cmdRouteSession(
        action === 'session-start' ? 'start' : 'end',
        id,
        { ...opts, serveArgv: [process.execPath, self, 'serve'] },
      );
      console.log(`routing ${res.routing}; ${res.sessions} session(s) routed`);
      return 0;
    }

    // Also the body of a hook, not a surface for people: routing follows the
    // foreign-model subagents that need it, turned on at SubagentStart and off
    // when the last one stops.
    if (action === 'subagent-start' || action === 'subagent-stop') {
      const id = rest[rest.indexOf('--id') + 1];
      if (!rest.includes('--id') || !id) throw new Error(`sonata route ${action} requires --id <agent-id>`);
      const res = await cmdRouteSubagent(action === 'subagent-start' ? 'start' : 'stop', id, opts);
      console.log(`routing ${res.routing}; ${res.subagents} subagent(s) running`);
      return 0;
    }

    if (!action || !['on', 'off', 'status', 'auto', 'manual'].includes(action)) {
      throw new Error('sonata route requires one of: on | off | status | auto | manual');
    }
    const status = await cmdRoute(action as RouteAction, opts);
    if (status) {
      const scopeLabel = global ? 'globally' : 'in this project';
      console.log(status.on
        ? `claude sessions ${scopeLabel} route through sonata serve`
        : `claude sessions ${scopeLabel} use their default API endpoint`);
      if (status.on) console.log(`  router: http://localhost:${status.port}`);
      if (action === 'status') {
        const active = (['project', 'global'] as const).filter((name) => status.scopes[name].on || status.scopes[name].auto);
        console.log(`  scopes: ${active.length > 0 ? active.join(', ') : 'none'}`);
        console.log('  see `sonata status` for what the router has actually served recently');
      }
      if (status.auto) {
        console.log('  auto:   on — routing turns on only while a foreign-model subagent runs');
        console.log('          (every session keeps Remote Control: none launches into a routed file)');
        if (status.sessions > 0) console.log(`  live:   ${status.sessions} routed session(s)`);
      } else if (action === 'manual') {
        console.log('  auto:   off — routing is whatever `sonata route on|off` last set');
      }
    }
    return 0;
  }

  if (command === 'restart') {
    // Kills whatever sonata router currently holds the configured port (a
    // stale daemon or an in-process native router) using
    // only the pid `cmdServe` recorded for itself, then starts a fresh
    // daemon. Plain `sonata serve --daemon` cannot do this: it just times
    // out against `EADDRINUSE` with "the daemon did not answer", which reads
    // as a startup failure rather than "something else is already there".
    const self = fileURLToPath(import.meta.url);
    const restarted = await cmdRestart(homedir(), [process.execPath, self, 'serve'], { cwd: process.cwd() });
    console.log(`sonata serve restarted (pid ${restarted.pid}) on port ${restarted.port}`);
    console.log(`  log:  ${restarted.logPath}`);
    console.log(`  stop: kill ${restarted.pid}`);
    return 0;
  }

  if (command === 'gc') {
    const killed = await cmdGc({ cwd: process.cwd() });
    console.log(killed.length ? `killed ${killed.join(', ')}` : 'nothing to clean up');
    return 0;
  }

  if (command === 'log') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
    const id = positionals[0];
    if (!id) throw new Error('sonata log requires a run id');
    const { cmdLog } = await import('./commands/log.js');
    const res = cmdLog({ cwd: process.cwd(), id });
    console.log(res.text);
    return res.ok ? 0 : 1;
  }

  if (command === 'verify') {
    const { values, positionals } = parseArgs({
      args: rest, allowPositionals: true, options: { model: { type: 'string' } },
    });
    const id = positionals[0];
    if (!id) throw new Error('sonata verify requires a run id');
    const { cmdVerify } = await import('./commands/verify.js');
    const res = cmdVerify({ cwd: process.cwd(), id, model: values.model });
    console.log(`${res.ok ? 'ok  ' : 'FAIL'} ${res.detail}`);
    return res.ok ? 0 : 1;
  }


  console.error(`sonata: unknown command "${command ?? ''}"`);
  return 2;
}

async function readAuthKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    return readFileSync(0, 'utf8').split(/\r?\n/, 1)[0].trim();
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  stdout.write('Key: ');
  stdin.setRawMode?.(true);
  stdin.resume();
  let value = '';
  try {
    for await (const chunk of stdin.iterator({ destroyOnReturn: false })) {
      const text = String(chunk);
      for (const char of text) {
        if (char === '\n' || char === '\r') return value.trim();
        if (char === '\u0003') throw new Error('sonata auth add cancelled');
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    }
  } finally {
    stdin.setRawMode?.(false);
    stdin.pause();
    stdout.write('\n');
  }
  return value.trim();
}

/**
 * True when this module was executed as the program, rather than imported.
 *
 * Compares REAL paths. `sonata` on PATH is a symlink into node_modules, so
 * node sets argv[1] to the symlink while import.meta.url resolves to the file
 * it points at — a raw string comparison never matches, and every command
 * exits 0 having done nothing. That shipped: the guard exists so a test can
 * import this module without running the CLI, and the first version of it
 * killed the CLI instead. Nothing caught it, because every test imports.
 */
export function invokedAsProgram(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    // One of the paths does not resolve, so this is not the program. Staying
    // silent beats running twice.
    return false;
  }
}

if (invokedAsProgram(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
