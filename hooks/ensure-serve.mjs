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
      if (!res.ok) return null;
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

  try {
    const machineConfigDir = join(homedir(), '.config', 'sonata');
    const daemon = spawn('sonata', ['serve', '--daemon'], {
      detached: true,
      stdio: 'ignore',
      ...(existsSync(machineConfigDir) ? { cwd: machineConfigDir } : {}),
    });
    daemon.unref();

    const deadline = Date.now() + 10_000;
    let started = null;
    while (Date.now() < deadline) {
      started = await probeHealth(1000);
      if (started) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (started && started.multiTenant !== true) rejectPreMultiTenant();
  } catch {
    // A hook must never break the session it observes.
  }
}
process.exit(0);
