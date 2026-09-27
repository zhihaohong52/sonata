#!/usr/bin/env node
// SessionStart hook: makes sure the machine-wide sonata router is up when a
// session is configured (via `sonata route on`) to route through it. Both this
// hook and the router read the port from the machine config.
//
// Unlike `sonata code`, which auto-starts the daemon as part of launching
// claude, a routed session is just `claude` — nothing of sonata runs to start
// the router. Without this hook the first thing such a session does is cache
// the connection error from a router that is not there.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.argv[2]);

if (Number.isInteger(port) && port > 0) {
  const probeHealth = async (timeoutMs) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`http://localhost:${port}/__sonata_health`, { signal: ctrl.signal });
      const body = await res.json();
      return body?.sonata === true ? body : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const rejectPreMultiTenant = () => {
    console.error(`sonata: router on port ${port} predates multi-tenant routing — run \`sonata restart\``);
    process.exit(1);
  };

  const existing = await probeHealth(1000);
  if (existing) {
    if (existing.multiTenant !== true) rejectPreMultiTenant();
    process.exit(0);
  }

  // Shown to the user by Claude Code; plain stdout on SessionStart would
  // become context for Claude instead. The hook still exits 0 — it must never
  // break the session it observes — but a router that never came up used to
  // end here with nothing said, leaving only connection errors later.
  const surface = (text) => {
    process.stdout.write(JSON.stringify({ systemMessage: text }) + '\n');
  };
  const logDir = join(homedir(), '.config', 'sonata', 'logs');

  try {
    // The machine config FILE decides, not its directory: sonata creates
    // ~/.config/sonata for logs and the router token on machines whose only
    // config is a project's, and a daemon started there has no config.
    const machineConfigDir = join(homedir(), '.config', 'sonata');
    let spawnError = null;
    const daemon = spawn('sonata', ['serve', '--daemon'], {
      detached: true,
      stdio: 'ignore',
      ...(existsSync(join(machineConfigDir, 'sonata.toml')) ? { cwd: machineConfigDir } : {}),
    });
    // Unhandled, a spawn failure (no `sonata` on PATH) is an 'error' event
    // that crashes the hook with a stack trace instead of a reason.
    daemon.on('error', (error) => { spawnError = error; });
    daemon.unref();

    const deadline = Date.now() + 10_000;
    let started = null;
    while (Date.now() < deadline && spawnError === null) {
      started = await probeHealth(1000);
      if (started) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (started && started.multiTenant !== true) rejectPreMultiTenant();
    if (spawnError !== null) {
      surface(
        `sonata: could not start \`sonata serve --daemon\` (${spawnError.message}), so this session's ` +
        `requests to port ${port} have no router. Is sonata on PATH?`,
      );
    } else if (!started) {
      surface(
        `sonata: the router did not come up on port ${port} within 10s. It may still be starting; if ` +
        `this session's requests fail, see the newest serve-*.log in ${logDir}, or run ` +
        `\`sonata serve --daemon\` to see why.`,
      );
    }
  } catch {
    // A hook must never break the session it observes.
  }
}
process.exit(0);
